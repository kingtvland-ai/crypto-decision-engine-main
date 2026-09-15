// Shared engine core for the paper-trading simulation — used by BOTH the
// server's 24/7 engine (server/simEngine.ts) and the browser's intraday hook
// (src/hooks/useSimulationBot.ts), which share the same decision algorithm
// (evaluateSymbolFromSnapshot / intradayBridge.ts). The legacy engine
// (useLegacySimulationBot.ts) runs a genuinely different decision algorithm
// (routeTradeType / tradeEngine.ts's Layer 1/2/3) and is intentionally NOT
// folded in here — only its small numeric helpers (reanchorLevel etc. below)
// are shared with it.
//
// These two engines used to each carry their own ~500-line copy of the
// evaluation/order-generation/fill logic — which is exactly how the SL/TP
// re-anchoring bug and the held/queued dedup bug each shipped fixed in one
// copy and left broken in the other earlier in this project. No framework-
// specific dependency (works in the browser and in the Node worker bundle):
// each engine still owns ITS OWN state (React state+refs vs plain closure
// variables) and calls these as pure functions, passing its state in and
// applying the returned deltas however fits its own state mechanism.

import { CryptoData } from '../types/crypto';
import { calculateTradingFee, simulateSlippage, Candle } from './tradeEngine';
import {
  evaluateSymbolFromSnapshot,
  buildPortfolioRiskStats,
  evaluatePositionExit,
  MultiTimeframeSnapshot,
  SignalEvaluation
} from './intradayBridge';
import { DEFAULT_INTRADAY_PARAMS, IntradayParams, SetupType, POSITION_TARGET_PCT, PER_ASSET_EXPOSURE_CAP_PERCENT, MAX_TOTAL_EXPOSURE_PERCENT, CAPITAL_FLOOR_PCT, resolveSizingBase, isBelowCapitalFloor } from './intradayParams';
import { validateExposureModel } from './simDefaults';
import { TP1_EXIT_FRACTION, MAX_LOSS_PERCENT } from './exitPolicy';
import {
  evaluateCorrelationGate,
  blocksOnAbstention,
  abstentionBlockReason,
  toPositionDirection,
  CorrelatedHolding,
  DEFAULT_CORRELATION_LOOKBACK,
  DEFAULT_CORRELATION_THRESHOLD,
  DEFAULT_MAX_CORRELATED
} from './correlation';
import {
  isInStreakCooldown,
  streakCooldownReason,
  streakCooldownFromHistory,
  portfolioStreakCooldownUntil,
  adaptiveRiskPercentFromHistory,
  ClosedTradeRecord
} from './adaptiveRisk';
import { detectSellPressureFromH1 } from './derivativesRegime';
import type { DerivativesSnapshot } from './derivativesRegime';
import { evaluateFundingGate } from './fundingRate';
import type { FundingSnapshot } from './fundingRate';

// Re-exported so the existing call sites (hooks, server engines) keep a
// single import surface; the implementation now lives in adaptiveRisk.ts
// where all three engines can reach it.
export {
  computeAdaptiveRiskPercent,
  adaptiveRiskPercentFromHistory,
  sizingMultiplierFromHistory,
  streakCooldownFromHistory,
  portfolioStreakCooldownUntil,
  summarizeRecentPerformance,
  isInStreakCooldown
} from './adaptiveRisk';
export type { AdaptiveRiskInput, ClosedTradeRecord, PerformanceWindow } from './adaptiveRisk';

// Simulation-only tuning — NOT applied to the real bot: tradingWorker.ts's
// scan() calls evaluateIntradayDecision directly with no params override, so
// it always gets DEFAULT_INTRADAY_PARAMS unmodified. Both knobs are being
// evaluated against real simulation results before being considered for the
// live bot. See each flag's own doc comment in intradayParams.ts.
export const SIM_INTRADAY_PARAMS_OVERRIDE: Partial<IntradayParams> = {
  allowShortDuringHighVolatility: true,
  // MEAN_REVERSION stop floor (buildRiskPlan): widen the 5M-swing stop that
  // otherwise floors at minStopPercent (0.12%), tighter than the round trip.
  meanReversionMinStopAtrMult: 1.6,
  meanReversionMinStopPercent: 0.25,
  // RISK_VS_COST floor 2.0 → 2.5 (2026-09-10). Now that the cost gate prices
  // the real MARKET fill (entryIsLimit wired through), a 2.0× multiple still
  // let ~0.6-0.9% stops through — tight enough that ordinary 5M noise wicks
  // them out on trades that would otherwise have worked. 2.5× ≈ a ~0.9%
  // effective floor against a ~0.35% real round trip. Live bot keeps 2.0.
  minStopCostMultiple: 2.5,
  // TP2 2.5R → 2.2R (2026-09-10). With the trail now capped at 1R of the stop
  // the 50% runner can actually reach the 2nd target instead of trailing out
  // near +0.4R; a 2.2R target that prints beats a 2.5R target that does not.
  tp2RewardRisk: 2.2,
  // Fixed scalp ladder (2026-09-11, operator decision): ALWAYS trade a fixed
  // SL 2.3% / TP1 1.8% / TP2 3.5% ladder instead of the dynamic one, so small
  // moves get taken instead of chased. The ONE exception is a buying surge
  // (M5 relVolume >= 2 + green bar), which widens the stop back to the dynamic
  // value clamped to [2.3%, 4.2%]. See calmRegime.ts.
  // Sim only — DEFAULT_INTRADAY_PARAMS leaves this unset.
  calmRegimeScalp: true,
  // Noise-floor stop (2026-09-14): the SECOND condition that widens the flat
  // 2.3%. A stop must clear 1.6 × one 5M bar's ATR — the same multiple Pro
  // already derives its own stop from — or an ordinary candle takes out a
  // thesis that never failed. Observed: a 94%-confidence micro-cap entry
  // stopped out 9 minutes later, two bars, having never moved against the
  // thesis by more than one bar's normal range. When even the 4.2% ceiling
  // sits inside that noise the symbol is refused instead of traded. See
  // calmRegime.ts.
  noiseFloorStop: true,
  // Profit ratchet (2026-09-14, operator decision): every profit exit is the
  // rung ladder — 1.8/3/4/5%… marked on the way up, 30% sold on the way back
  // down to a rung, full close at the 1.8% floor. TP1/TP2 and the trailing stop
  // are bypassed. Sim only — DEFAULT_INTRADAY_PARAMS leaves this unset, so the
  // LIVE bot keeps its existing ladder untouched. See profitRatchet.ts.
  profitRatchet: true,
  // Operator floor: no sim position opens below $100. Per the 10% target model,
  // a budget below MIN_SIM_ENTRY_USD is SKIPPED — never bumped up.
  // This override makes buildRiskPlan enforce the same floor.
  minOrderUsd: 100,
  // Operator decision (2026-09-07): the SIM intraday bot may hold up to 7
  // concurrent positions of 10% each (≤ 80% invested). The live bot stays at
  // its DEFAULT_INTRADAY_PARAMS values (2 / 20%) — this override is sim-only.
  maxOpenPositions: 7,
  maxLeveragedExposurePercent: MAX_TOTAL_EXPOSURE_PERCENT,
  // Operator decision (2026-09-07): the stagnation time stop must give a trade
  // at least an hour, not ~20 minutes. The observed run closed all 7 positions
  // at once on "Time Stop: אחרי 20.3 דק'" — MEAN_REVERSION's 45 min max hold ×
  // timeStopFraction 0.45 = 20.25 min, i.e. the cut fired before a 5M-timed
  // mean-reversion entry had time to resolve at all.
  //
  // TWO knobs, because raising only one cannot produce the requested window:
  // timeStopMs = maxHoldMs × timeStopFraction, and MAX_DURATION closes the
  // position at maxHoldMs regardless — so a time stop can never sit later than
  // the max hold that contains it. With fraction 0.7 the checkpoints become
  // TREND_PULLBACK 84 min, BREAKOUT_RETEST 63 min, MEAN_REVERSION 63 min, each
  // comfortably past the requested hour, with the hard budget still ahead of it.
  // timeStopMinProgressR (0.3R) is deliberately UNCHANGED — the complaint was
  // the clock, not the bar.
  //
  // SIM-ONLY. The live bot keeps DEFAULT_INTRADAY_PARAMS (45/60/120 × 0.45).
  // Note the values are stamped onto a position at entry (buildRiskPlan writes
  // pos.maxHoldMs/pos.timeStopMs), so positions opened before this change keep
  // their old, shorter clocks until they close.
  maxHoldMinutes: { TREND_PULLBACK: 120, BREAKOUT_RETEST: 90, MEAN_REVERSION: 90 },
  timeStopFraction: 0.7,
  // Operator decision (2026-09-08): size against STARTING capital, not live
  // equity. A $1,000 bot opens $100 positions for as long as it has capital;
  // losses reduce how many fit, never how big each one is. Entries stop below
  // CAPITAL_FLOOR_PCT (30%) of the starting capital. LIVE bot: unset.
  useFixedSizingBase: true
};

/**
 * Smallest position any simulation bot will open, in USD.
 *
 * Applies to every sim bot (intraday / pro / path / bybit) at
 * order-generation time. Larger than the ~$5 exchange-dust floor the fill core
 * keeps as a last-resort guard.
 *
 * MIN_ORDER IS A CONSTRAINT, NOT A SIZING INPUT. If the 10% target notional
 * computes below this floor, the trade is SKIPPED with reason
 * MIN_ORDER_EXCEEDS_POSITION_TARGET — it is never bumped above the target.
 */
export const MIN_SIM_ENTRY_USD = 100;

/** Reason code shared by all four bots: the 10% target itself is under the
 *  order floor, so there is nothing to open. Never resolved by sizing UP. */
export const MIN_ORDER_EXCEEDS_POSITION_TARGET = 'MIN_ORDER_EXCEEDS_POSITION_TARGET';

/**
 * Records an execution-layer refusal ON the evaluation — the same surface the
 * strategy gates use, for all four bots.
 *
 * Entry rejections in the order generators were bare `continue`s, so a panel
 * could show a green "SIGNAL SPOT LONG · ביטחון 93%" for a signal the execution
 * layer had already thrown away, with no trace anywhere. That is exactly how
 * the Bybit bot sat at zero positions for a full run while the other three
 * traded: a gate the operator cannot see is a gate that gets debugged by
 * guessing. Path still had two such silent skips after the Bybit fix, which is
 * why this lives here now instead of in one bot's file.
 *
 * `strategyDecision` keeps the strategy's own YES (§16) while `willExecute`
 * becomes the final answer — the split those two fields were defined for.
 * `status` is what the badge renders; `factors` is the decision-layers panel.
 *
 * Mutating the evaluation is load-bearing and safe: simEngineFactory holds the
 * same array reference (`lastEvaluations = evaluations`) and builds the
 * snapshot AFTER generateOrders runs, and both `status` and `factors` are in
 * the snapshot projection.
 */
export function blockEntry(
  ev: SignalEvaluation,
  code: string,
  message: string,
  logPrefix = '[sim]'
): void {
  console.warn(`${logPrefix} ${ev.symbol}: entry blocked [${code}] — ${message}`);
  ev.strategyDecision = ev.strategyDecision ?? ev.willExecute;
  ev.willExecute = false;
  ev.status = `BLOCKED [${code}]`;
  ev.factors = [
    ...(ev.factors ?? []),
    { label: 'חסימת ביצוע', value: code, impact: 'negative', note: message }
  ];
}

// ── Shared data shapes ───────────────────────────────────────────────────────

export interface SimPosition {
  id: string;
  symbol: string;
  type: 'SPOT' | 'FUTURES';
  side: 'BUY' | 'SELL' | 'LONG' | 'SHORT';
  quantity: number;
  entryPrice: number;
  avgPrice: number;
  currentPrice: number;
  leverage: number;
  marginUsd: number;
  notionalUsd: number;
  stopLoss: number;
  takeProfit1?: number;
  takeProfit2?: number;
  takeProfit?: number;
  trailingStopActive?: boolean;
  trailingStopPrice?: number;
  tp1Hit: boolean;
  /** Profit-ratchet rungs already paid out for this position (profitRatchet.ts).
   *  Persisted so a rung fires once and only once across ticks — without it a
   *  price oscillating around a rung would sell 30% on every tick. Positions
   *  restored from state written before the ratchet existed have none. */
  ratchetConsumed?: number[];
  highestPriceSinceTP1?: number;
  lowestPriceSinceTP1?: number;
  highestPrice?: number;
  lowestPrice?: number;
  openedAt: string;
  openTimestamp: number;
  reason: string;
  confidence: number;
  entryFee: number;
  /** Capital at risk at ENTRY: |entryPrice - stopLoss| × quantity, in the same
   *  units as the pnl computed at close (quantity already carries leverage for
   *  Futures, since it is derived from the leveraged notional).
   *
   *  Snapshotted here and never recomputed: stopLoss moves under trailing stops
   *  and TP1 reanchoring, so a close-time derivation gives the wrong risk. This
   *  is the denominator that turns Kelly's payoff ratio into R-multiples —
   *  see kellyPayoffRatio() in adaptiveRisk.ts. Optional because positions
   *  restored from state persisted before this field existed will not have it. */
  initialRiskUsd?: number;
  /** Per-setup-type hold budget from the entry-time RiskPlan (intradayRisk.ts).
   *  Without these, the exit engine falls back to a single hardcoded default
   *  (TREND_PULLBACK's 90min) for every position regardless of its actual
   *  setup type — e.g. a MEAN_REVERSION position (meant to time-stop at 45min)
   *  would incorrectly get held up to twice as long. */
  maxHoldMs?: number;
  timeStopMs?: number;
  /** Frozen at entry from the RiskPlan (RiskPlan.naturalStopPct — see its own
   *  doc comment). The time stop's stagnation check reads this instead of the
   *  executed stop distance when present, so a calm symbol's flat-but-wide
   *  ladder stop doesn't make "has this moved at all" an unreasonably high
   *  bar. Undefined = old behavior (compare against the executed stop). */
  naturalStopPct?: number;
   /** Per-setup exit tuning at exit-check time: the maxHold / timeStop / trailing
    *  activation tables in intradayExit.ts are all keyed by setup type. */
   setupType?: SetupType;
   /** Gross R:R computed from the ACTUAL fill price, not the signal price (§10/§11).
    *  The evaluation-time actualRR in Prev4hRange/RiskPlan plans is computed from
    *  `entryRef = currentPrice` (the signal price) — but the order fills at a
    *  potentially different price, and SL/TP are re-anchored at fill time. This
    *  field stores the post-fill R:R derived from the re-anchored levels. */
   fillRR?: number;
}

export interface SimTrade {
  id: string;
  symbol: string;
  type: 'SPOT' | 'FUTURES';
  side: 'buy' | 'sell' | 'long' | 'short' | 'close_long' | 'close_short' | 'partial_tp1';
  price: number;
  requestedPrice: number;
  slippagePercent: number;
  fee: number;
  delayMs: number;
  quantity: number;
  usdValue: number;
  leverage: number;
  timestamp: string;
  at: number;
  reason: string;
  confidence: number;
  pnl?: number;
  pnlPercent?: number;
  /** Risk-at-entry of the position this trade closed, carried from
   *  SimPosition.initialRiskUsd. Present on exit trades only — entries have no
   *  pnl and are filtered out before the Kelly history is built. */
  riskUsd?: number;
}

export interface SimPoint {
  timestamp: string;
  at: number;
  portfolio: number;
}

export interface PendingOrder {
  id: string;
  symbol: string;
  type: 'SPOT' | 'FUTURES';
  side: 'buy' | 'sell' | 'long' | 'short' | 'close_long' | 'close_short' | 'partial_tp1';
  /** Fraction of the position this partial closes. Defaults to
   *  TP1_EXIT_FRACTION when absent, so orders written before the profit
   *  ratchet still mean "half". Ignored on full closes and entries. */
  exitFraction?: number;
  /** Ratchet state to write onto the REMAINDER when this partial fills. */
  ratchetConsumed?: number[];
  signalPrice: number;
  quantity: number;
  budgetUsd?: number;
  /** How this ENTRY fills once its execution delay elapses. 'limit' (the
   *  default, and what every engine except Pro uses) waits for the live price
   *  to cross the order's own signalPrice and fills at limit-or-better with a
   *  maker fee. 'market' (alg.md §6, Pro) fires at executeAt at the market
   *  price of that moment — adverse slippage and a Taker fee, always against
   *  the bot. EXIT orders are market-style regardless of this flag. */
  fill?: 'market' | 'limit';
  leverage?: number;
  stopLoss?: number;
  takeProfit1?: number;
  takeProfit2?: number;
  takeProfit?: number;
  reason: string;
  confidence: number;
  executeAt: number;
  createdAt: number;
  /** Absolute ms at which an unfilled resting LIMIT entry is cancelled.
   *  Omitted → `createdAt + LIMIT_ORDER_TTL_MS` (the flat 2h default).
   *
   *  A flat TTL is wrong whenever it outlives the thesis that produced the
   *  order. Intraday's max hold is 45-120 minutes, so a 2h resting order could
   *  wait LONGER than the trade it was trying to open would have lasted, and
   *  fill on a 5-minute entry confirmation two hours stale. Prev-4H Range is
   *  the mirror case: its position is time-stopped at the end of the same 4H
   *  bar it was armed in, so an order filling at 3h50m opens a trade with ten
   *  minutes to live. Each engine that knows its own horizon sets this; Pro,
   *  which has no time stop, keeps the default. */
  expiresAt?: number;
  /** EXIT orders only: the id of the SimPosition this order closes.
   *  Exit orders used to be matched back to a position by SYMBOL alone, which
   *  is only unambiguous while one position per symbol exists — and nothing
   *  enforced that. With two lots of the same asset open, the close filled
   *  against whichever lot sat first in the array rather than the one whose
   *  stop actually triggered, so P&L, riskUsd and the R-multiple were booked
   *  against the wrong entry price. Optional: orders persisted before this
   *  field existed fall back to the symbol match. */
  positionId?: string;
  /** Carried from the entry-time RiskPlan through to the resulting SimPosition — see SimPosition.maxHoldMs. */
  maxHoldMs?: number;
  timeStopMs?: number;
  /** Carried from the entry-time RiskPlan through to the resulting SimPosition — see SimPosition.naturalStopPct. */
  naturalStopPct?: number;
  setupType?: SetupType;
}

export interface SimBotConfig {
  riskLevel: 'low' | 'medium' | 'high';
  initialAmount: number;
  // No stopLoss/takeProfit here, deliberately. Both existed as configured
  // percentages (4.2 and 3) that survived the move to ATR-sized stops without
  // being deleted, so six config objects and a settings panel carried numbers
  // no engine has read since. Stops come from calculateRiskParameters /
  // intradayRisk (ATR-normalised, clamped to [1.5%, 6%]) and the target is
  // derived from the stop at a fixed 1.67 reward:risk, so a flat percentage
  // here has nothing to attach to — reinstating one would mean choosing to
  // override the volatility-scaled stop with a constant.
  maxPositions: number;
  maxFuturesPositions?: number;
  feePercent: number;
  slippagePercent: number;
  executionDelaySec: number;
  minConfidenceOverride?: number;
  /** All 4 sim bots: when true, entries rest as LIMIT orders at the strategy's
   *  entry-reference price (intraday: a maker discount; path/bybit: the signal
   *  price → a pullback/retest fill) instead of firing as delayed MARKET fills.
   *  Fill is Maker, no slippage. When false/absent → MARKET at the live price. */
  proLimitEntries?: boolean;
  positionPercent?: number;
  /** Opt-in (default off). When the Fear & Greed index sits in the
   *  "afraid, not capitulating" band [FEAR_BAND_LOW, FEAR_BAND_HIGH] and the
   *  engine has ALREADY approved a MEAN_REVERSION buy, a recent losing streak is
   *  not allowed to shrink that entry — the sizing multiplier is floored at
   *  FEAR_BAND_SIZING_FLOOR so it sizes back toward the full 10% target. Never
   *  raises size above the 10% invariant (the floor is < 1). Intraday only —
   *  Pro/Path/Bybit do not carry a streak throttle for this to lift. */
  fearGreedSizeBoost?: boolean;
}

/** "Afraid but not in free-fall" — the contrarian band. Below LOW is
 *  capitulation (still falling, knife-catch territory); above HIGH is neutral. */
export const FEAR_BAND_LOW = 20;
export const FEAR_BAND_HIGH = 35;
/** Floor the sizing multiplier is lifted to inside the fear band. < 1 on
 *  purpose: it undoes most of a streak throttle without ever pushing past the
 *  10%-of-equity target. */
export const FEAR_BAND_SIZING_FLOOR = 0.9;

const uid = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/**
 * SL/TP were computed relative to the SIGNAL price at evaluation time, which
 * can be stale by the time the order actually fills (execution delay + live
 * price drift). Re-anchor by preserving the SIGNED offset from the signal
 * price — not just its distance — so SL stays below / TP stays above entry
 * for a LONG (opposite for SHORT) regardless of which way the price drifted.
 * Forcing a single sign here (an earlier version of this fix did) silently
 * flips TP1/TP2 to the wrong side of the fill price.
 */
export function reanchorLevel(fillPrice: number, signalPrice: number, level: number | undefined): number | undefined {
  return level === undefined ? undefined : fillPrice + (level - signalPrice);
}

/** Percentage of free cash committed to one SPOT entry when the caller supplies
 *  no positionPercent. */
export const DEFAULT_POSITION_PERCENT = POSITION_TARGET_PCT * 100; // 10 — unified with the 10% per-asset target (§1/§12)

/** FUTURES commits a third of what SPOT does, because leverage multiplies
 *  whatever margin is posted. Kept as a ratio so a configured positionPercent
 *  moves both markets together instead of only one. */
export const FUTURES_POSITION_RATIO = 1 / 3;

/** Entry position sizing: FUTURES risk is capped in absolute $ terms (not just %) since leverage already amplifies exposure; SPOT is capped higher since there's no leverage multiplier.
 *
 *  `positionPercent` is SimBotConfig.positionPercent — the control that appears
 *  in the bot panel and in BOT_POSITION_PERCENT. It used to reach
 *  calculateRiskParameters as `_configuredPositionPercent` and stop there,
 *  which is to say the setting did nothing to any simulated trade. */
export function computeEntryBudget(
  cash: number,
  tradeType: 'SPOT' | 'FUTURES',
  positionPercent: number = DEFAULT_POSITION_PERCENT
): number {
  const percent = Number.isFinite(positionPercent) && positionPercent > 0
    ? positionPercent
    : DEFAULT_POSITION_PERCENT;
  return tradeType === 'FUTURES'
    ? Math.min(cash * (percent * FUTURES_POSITION_RATIO) / 100, 500)
    : Math.min(cash * percent / 100, 1000);
}

export interface EntryBudgetInput {
  /** RiskPlan.betSizeUsd for this signal, when the engine produced one — itself
   *  10% of equity. Can only bring the size DOWN from target, never up. */
  kellyBetSizeUsd?: number;
  /** Portfolio equity. Used only when no starting capital is supplied. */
  equity: number;
  /** The bot's STARTING capital. When present the 10% target is a fraction of
   *  THIS and stays constant as equity moves — the single source of truth
   *  (§1/§12), same as Pro / Path / TrendBreakout. See resolveSizingBase. */
  initialAmount?: number;
  /** Free cash at this point in the batch — a hard upper LIMIT only, never the
   *  target. As cash depletes across a batch the target stays 10% of equity;
   *  the trade is simply skipped once cash can no longer cover it. */
  cash: number;
  /** Performance-adaptive multiplier from the decision (clamped to [0,1]). */
  sizingMultiplier?: number;
}

/**
 * The size an entry order is actually sent with.
 *
 * = 10% of EQUITY, clamped by (a) the risk layer's Kelly bet (also 10% of
 * equity, so a no-op unless it de-risked) × the performance multiplier
 * (∈ [0,1], only de-risks), and (b) available cash as a hard limit.
 *
 * NOT inputs, deliberately: `positionPercent` (was the operator ceiling inside
 * computeEntryBudget — a $1000/$500 absolute cap that contradicted "10% of
 * equity, always"), `riskLevel`, `tradeType`-specific ratios. Those all
 * reshaped the target, which §12 forbids.
 */
export function resolveEntryBudget(input: EntryBudgetInput): number {
  const target = resolveSizingBase(input.initialAmount, input.equity) * POSITION_TARGET_PCT;

  const perfMult = typeof input.sizingMultiplier === 'number' && Number.isFinite(input.sizingMultiplier)
    ? Math.max(0, Math.min(1, input.sizingMultiplier))
    : 1;

  const kelly = input.kellyBetSizeUsd;
  const sized = (typeof kelly === 'number' && Number.isFinite(kelly) && kelly > 0
    ? Math.min(kelly, target)
    : target) * perfMult;

  // Cash is the only hard limit — it never reshapes the 10% target.
  return Math.min(sized, input.cash);
}

/** Multiplier applied to the entry budget for SimBotConfig.riskLevel.
 *  The selector had never been read by any engine, so this is the behaviour it
 *  is being given rather than one being restored: it scales conviction size,
 *  and deliberately leaves trade FREQUENCY (the confidence threshold) alone —
 *  one knob, one effect. */
export function riskLevelSizingMultiplier(riskLevel?: 'low' | 'medium' | 'high'): number {
  if (riskLevel === 'low') return 0.6;
  if (riskLevel === 'high') return 1.5;
  return 1;
}

/** Safety net against rapid re-entry churn. History (see git / [[entry-cooldown]]
 *  memory): raised 2 → 30 → 60 minutes for LOSSES (2026-09-14); briefly widened
 *  to fire on every exit win-or-loss the same day after B3 on Pro closed
 *  +$12.23, was re-bought 11 minutes later, and stopped out −$20.59 20 minutes
 *  after that — then reverted to losses-only on operator request, since a
 *  winning exit means the setup worked and re-entering fresh isn't "chasing"
 *  the way re-entering right after a stop-out is.
 *
 *  Reopened 2026-09-16: a WINNING ratchet exit on FLOCK (+1.8%) was followed
 *  76 seconds later by a fresh entry on the SAME symbol, which then stopped
 *  out — the zero-cooldown-on-win case above was exactly this shape, just
 *  with the loss landing on the re-entry instead of the original trade. Every
 *  full exit — win or loss — now gets AT LEAST SMART_COOLDOWN_FLOOR_MS before
 *  a fresh entry is allowed, and `resolveReentryRecovery` (below) governs how
 *  much longer than the floor, RECOMPUTED against the live price on every
 *  check rather than a duration frozen once at exit time — a stale timer is
 *  not a re-verified decision. */
export const ENTRY_COOLDOWN_MS = 60 * 60 * 1000;

/** Hard minimum: no re-entry on a symbol within this window of ANY full exit,
 *  win or loss, no matter how strong an apparent recovery/continuation looks.
 *  `resolveReentryRecovery` can extend this up to ENTRY_COOLDOWN_MS but never
 *  shorten it. */
export const SMART_COOLDOWN_FLOOR_MS = 5 * 60 * 1000;

/** What a full exit leaves behind for the entry-cooldown check to recompute
 *  against on every later tick — not a frozen duration, the inputs to
 *  re-derive one from the CURRENT price each time. */
export interface ReentryCooldownState {
  /** Exit fill timestamp (Date.now() at the close). */
  at: number;
  /** The price this position closed at. */
  exitPrice: number;
  /** Position direction at exit — recovery is measured in this direction
   *  (price continuing above exitPrice for a closed LONG, below for a closed
   *  SHORT), matching pos.side === 'LONG' || pos.side === 'BUY'. */
  isLong: boolean;
}

/**
 * Recovery-based re-entry gate, recomputed fresh on every check against the
 * CURRENT price rather than a duration decided once at exit time — "has the
 * market proven the trade would work NOW" rather than "a timer expired."
 * Applies uniformly after a WIN or a LOSS (2026-09-16; previously loss-only
 * and floored at 0 — see ENTRY_COOLDOWN_MS's doc comment for why both changed).
 *
 * Recovery thresholds (in the direction of the closed position):
 * - ≥0.5% beyond exit → strong continuation/reversal proven → floor only (5 min)
 * - 0.2%-0.5% beyond exit → weak signal → 15 min
 * - below 0.2% → unproven → full 60 min (ENTRY_COOLDOWN_MS)
 */
export function resolveReentryRecovery(opts: {
  exitPrice: number;
  currentPrice: number;
  isLong: boolean;
  timeSinceExit: number; // milliseconds
}): { allowed: boolean; reason: string; effectiveCooldown: number } {
  const { exitPrice, currentPrice, isLong, timeSinceExit } = opts;

  if (!Number.isFinite(exitPrice) || !Number.isFinite(currentPrice) || exitPrice <= 0) {
    return { allowed: false, reason: 'Invalid prices', effectiveCooldown: ENTRY_COOLDOWN_MS };
  }

  const recoveryPercent = isLong
    ? ((currentPrice - exitPrice) / exitPrice) * 100
    : ((exitPrice - currentPrice) / exitPrice) * 100;

  if (recoveryPercent >= 0.5) {
    return {
      allowed: timeSinceExit >= SMART_COOLDOWN_FLOOR_MS,
      reason: `Recovery ${recoveryPercent.toFixed(2)}% > 0.5% threshold (floor ${(SMART_COOLDOWN_FLOOR_MS / 60000).toFixed(0)}min)`,
      effectiveCooldown: SMART_COOLDOWN_FLOOR_MS
    };
  }

  if (recoveryPercent >= 0.2) {
    const reducedCooldown = 15 * 60 * 1000;
    return {
      allowed: timeSinceExit >= reducedCooldown,
      reason: `Weak recovery ${recoveryPercent.toFixed(2)}%, ${Math.max(0, (reducedCooldown - timeSinceExit) / 60000).toFixed(0)}min left`,
      effectiveCooldown: reducedCooldown
    };
  }

  return {
    allowed: timeSinceExit >= ENTRY_COOLDOWN_MS,
    reason: `Below exit (${recoveryPercent.toFixed(2)}%), full cooldown`,
    effectiveCooldown: ENTRY_COOLDOWN_MS
  };
}

/**
 * True when a symbol is still in its post-exit cooldown. Recomputes recovery
 * against `currentPrice` every call — not a value cached at exit — so a
 * cooldown that looked justified at close can lift (or hold) as price action
 * actually plays out. Falls back to the hard floor only when no live price is
 * available to recompute against (never allows a bypass on missing data).
 */
export function isInEntryCooldown(
  cooldown: ReentryCooldownState | number | undefined,
  currentPrice?: number,
  now: number = Date.now()
): boolean {
  if (cooldown === undefined) return false;
  // Legacy shape (bare timestamp) — no exit price/direction to recompute
  // recovery from, so fall back to the flat floor. Kept only so any stale
  // in-memory state from before this change (a bot that hasn't ticked since
  // the deploy) degrades safely instead of throwing.
  if (typeof cooldown === 'number') {
    return now - cooldown < SMART_COOLDOWN_FLOOR_MS;
  }
  const timeSinceExit = now - cooldown.at;
  if (typeof currentPrice !== 'number' || !Number.isFinite(currentPrice)) {
    return timeSinceExit < SMART_COOLDOWN_FLOOR_MS;
  }
  const { allowed } = resolveReentryRecovery({ exitPrice: cooldown.exitPrice, currentPrice, isLong: cooldown.isLong, timeSinceExit });
  return !allowed;
}

/**
 * Sell-pressure override, shared by Pro/Path/Bybit (2026-09-16) — mirrors
 * Intraday's own GATE 6 (intradayEngine.ts) exactly via the same
 * detectSellPressureFromH1 (derivativesRegime.ts): same relvol/price-drop
 * computation, same detectSellPressure call, same direction-agnostic block
 * (an asset under confirmed sell pressure should not be traded AT ALL right
 * now, long or short). Applied here at the evaluation layer instead of
 * inside prev4hRange.ts / proSetup / trendBreakout.ts, so this REPLACES an
 * evaluation that already decided to trade without touching any of those
 * strategies' own gates, thresholds, or gate order.
 *
 * No-op (returns the evaluation unchanged) when it was already a hold, or
 * when H1/derivatives data is missing — same abstain-on-missing-data
 * contract as detectSellPressure itself.
 */
export function applySellPressureOverride(
  evaluation: SignalEvaluation,
  h1: Candle[],
  derivativesSnapshot: DerivativesSnapshot | undefined,
  now: number = Date.now()
): SignalEvaluation {
  if (evaluation.action === 'hold' || !evaluation.willExecute) return evaluation;
  const sellPressure = detectSellPressureFromH1(h1, derivativesSnapshot, now);
  if (!sellPressure.blocked) return evaluation;
  return {
    ...evaluation,
    action: 'hold',
    willExecute: false,
    status: 'NO_SIGNAL [MACRO]',
    reasoning: `${sellPressure.reason}\n${evaluation.reasoning}`
  };
}

/**
 * Funding-crowding veto for the bots that open PERPETUAL positions but never
 * consulted the funding gate (2026-09-16).
 * ----------------------------------------------------------------------------
 * `evaluateFundingGate` (fundingRate.ts) was reachable from exactly one
 * engine, intradayEngine.ts. Path and TrendBreakout both open their SHORT side
 * as 1x FUTURES (`tradeType: isLong ? 'SPOT' : 'FUTURES'`), and the shared
 * tick genuinely bills them for it — `applyFundingAccrual` in
 * server/simEngineFactory.ts charges funding on every open FUTURES position of
 * every sim bot. So those two bots PAID funding while nothing ever refused a
 * position for it. That asymmetry is what this closes.
 *
 * Scope, deliberately narrow:
 *
 *   · FUTURES only. Funding is a perpetual-swap cost; a SPOT position never
 *     pays or receives it, so a spot LONG is returned untouched. This is why
 *     the check keys off `tradeType`, not off direction — Pro is spot-only and
 *     is therefore a no-op here by construction even if it is ever wired in.
 *   · VETO only, no trim. The gate's middle band returns a `sizeMultiplier`,
 *     which intradayEngine folds into its own sizing chain. Path and
 *     TrendBreakout size from `sizingBase × positionTargetPct` inside their own
 *     order generators and carry no sizing-multiplier field on the evaluation,
 *     so honouring a trim would mean changing how those two bots size — a
 *     strategy change, not a missing guard. The veto is the risk half and is
 *     what is added here; a trim would be a separate, deliberate decision.
 *   · Abstains on missing or stale data, because the gate itself does.
 */
export function applyFundingOverride(
  evaluation: SignalEvaluation,
  fundingSnapshot: FundingSnapshot | undefined,
  now: number = Date.now()
): SignalEvaluation {
  if (evaluation.action === 'hold' || !evaluation.willExecute) return evaluation;
  if (evaluation.tradeType !== 'FUTURES') return evaluation;
  const direction = evaluation.tradeSide === 'SHORT' || evaluation.tradeSide === 'SELL' ? 'SHORT' : 'LONG';
  const verdict = evaluateFundingGate(fundingSnapshot, direction, now);
  if (verdict.kind !== 'veto') return evaluation;
  return {
    ...evaluation,
    action: 'hold',
    willExecute: false,
    status: 'NO_SIGNAL [FUNDING]',
    reasoning: `${verdict.reason}\n${evaluation.reasoning}`
  };
}

/**
 * Slippage monitoring (2026-09-14): detect when execution slippage is abnormally
 * high, indicating market stress (flash crashes, liquidation cascades, etc).
 * When detected, reduce max open positions as a risk circuit-breaker.
 *
 * Normal slippage: 0.1-0.3% on SPOT (Bybit VIP 0 base), up to 0.30% on FUTURES.
 * Abnormal: > 0.50% indicates market distress.
 */
export function detectMarketStress(opts: {
  recentTrades: Array<{ slippagePercent: number }>;
  windowSize?: number; // last N trades to check
}): { isStressed: boolean; avgSlippage: number; recommendation: string } {
  const { recentTrades, windowSize = 5 } = opts;

  if (recentTrades.length === 0) {
    return { isStressed: false, avgSlippage: 0, recommendation: 'No trades' };
  }

  const recent = recentTrades.slice(-windowSize);
  const avgSlippage = recent.reduce((sum, t) => sum + t.slippagePercent, 0) / recent.length;

  if (avgSlippage > 0.50) {
    return {
      isStressed: true,
      avgSlippage,
      recommendation: `Reduce max positions to 50% (avg slippage ${avgSlippage.toFixed(2)}% > 0.5%)`
    };
  }

  if (avgSlippage > 0.30) {
    return {
      isStressed: true,
      avgSlippage,
      recommendation: `Reduce max positions to 75% (elevated slippage ${avgSlippage.toFixed(2)}%)`
    };
  }

  return {
    isStressed: false,
    avgSlippage,
    recommendation: 'Normal market conditions'
  };
}

// ── Perpetual funding accrual (shared by all four sim bots) ───────────────────
// The fill core already models fee + slippage; this is the third recurring
// futures cost (spec §17). Applied uniformly in the engine factory's tick so
// the four bots keep an identical cost model — a difference in their results
// stays a difference in DECISIONS. In practice only the bots that hold FUTURES
// positions (Intraday, and the Bybit bot's shorts) ever see a funding leg;
// Pro and Path are spot-only.

/** Perpetual funding settles every 8h on Binance/Bybit. */
export const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;

export interface FundingRateReading {
  /** Funding rate for ONE 8h period, as a fraction. 0.0001 = 0.01%/8h. */
  lastFundingRate: number;
  at: number;
}

export interface FundingAccrualResult {
  cash: number;
  /** Funding moved this call, in USD. Positive = the bots PAID (a cost). */
  fundingPaid: number;
  lastAppliedAt: number;
}

/**
 * Time-prorated funding on open FUTURES positions between `lastAppliedAt` and
 * `now` — a deterministic approximation of the 8h funding cycle, the same way
 * the sim already prorates hold / time-stop budgets.
 *
 * LONG pays when the rate is positive (and receives when negative); SHORT is
 * the mirror. SPOT positions have no funding leg. An empty / stale rate map is
 * a no-op — a funding-feed outage must never disturb the simulation. The
 * accrual window is capped at one funding interval so a long worker outage
 * cannot bill a lump sum on restart.
 */
export function applyFundingAccrual(
  positions: SimPosition[],
  cash: number,
  fundingBySymbol: Map<string, FundingRateReading> | undefined,
  lastAppliedAt: number,
  now: number = Date.now()
): FundingAccrualResult {
  if (!lastAppliedAt || lastAppliedAt >= now) return { cash, fundingPaid: 0, lastAppliedAt: now };
  const elapsed = Math.min(now - lastAppliedAt, FUNDING_INTERVAL_MS);
  const fraction = elapsed / FUNDING_INTERVAL_MS;
  if (!(fraction > 0) || !fundingBySymbol || fundingBySymbol.size === 0) {
    return { cash, fundingPaid: 0, lastAppliedAt: now };
  }

  let paid = 0;
  for (const pos of positions) {
    if (pos.type !== 'FUTURES') continue;
    const key = pos.symbol.toUpperCase();
    const reading = fundingBySymbol.get(key) ?? fundingBySymbol.get(`${key}USDT`);
    if (!reading || !Number.isFinite(reading.lastFundingRate)) continue;
    const live = pos.currentPrice || pos.entryPrice;
    const notional = pos.quantity * live;
    const isLong = pos.side === 'LONG' || pos.side === 'BUY';
    paid += notional * reading.lastFundingRate * fraction * (isLong ? 1 : -1);
  }

  return { cash: cash - paid, fundingPaid: paid, lastAppliedAt: now };
}

// ── 2. Order generation ──────────────────────────────────────────────────────
// Checks every open position for an exit (SL/TP/trailing/reversal/time-stop
// via evaluatePositionExit), then queues new entry orders for evaluations
// that passed every gate above.

export interface OrderGenContext {
  positions: SimPosition[];
  pending: PendingOrder[];
  evaluations: SignalEvaluation[];
  executionDelaySec: number;
  dailyDrawdownPercent: number;
  weeklyDrawdownPercent: number;
  cash: number;
  /** Portfolio equity — the denominator for the losing-streak cooldown's
   *  "was this loss big enough to be a different regime" test. */
  equity: number;
  /** The bot's STARTING capital: what position size is pinned to, and what the
   *  CAPITAL_FLOOR entry stop is measured against. Absent → size against
   *  equity (previous behaviour). */
  initialAmount?: number;
  /** SimBotConfig.positionPercent / .riskLevel — carried for telemetry only.
   *  Sizing is 10% of equity (§12); neither field reshapes it. */
  positionPercent?: number;
  riskLevel?: 'low' | 'medium' | 'high';
  /** SimBotConfig.proLimitEntries. When true, entries rest as LIMIT orders at
   *  the strategy's own entry-reference price (a maker-discount for intraday);
   *  when false/absent they fire as delayed MARKET fills with adverse slippage.
   *  Same semantics the Pro bot's `limitEntries` already has. */
  limitEntries?: boolean;
  /** Current Fear & Greed index (0-100). Read only when `fearGreedSizeBoost` is
   *  on; absent → the boost never engages. */
  fearGreedIndex?: number;
  /** SimBotConfig.fearGreedSizeBoost — see that field. */
  fearGreedSizeBoost?: boolean;
  /** Symbol (as stored on the position/order) → last-exit cooldown state. Read-only here. */
  exitCooldown: Record<string, ReentryCooldownState>;
  priceFor: (symbol: string) => number | undefined;
  buildCandlesForSymbol: (symbol: string) => Candle[];
  computeAtr5: (candles: Candle[]) => number;
  /** Position-count caps — several symbols can all carry willExecute=true
   *  simultaneously. Without re-checking a running total as THIS batch is
   *  built, a tick where N symbols qualify at once queues all N regardless
   *  of the cap — observed live: 10 MEAN_REVERSION signals fired in the
   *  same tick and opened 10 positions against a configured max of 5. */
  maxPositions: number;
  maxFuturesPositions: number;
  /** Closed-trade history driving the post-losing-streak entry cooldown.
   *  This is the authoritative stop: evaluations are memoized per tick while
   *  order generation runs on every heartbeat. */
  closedTrades?: ClosedTradeRecord[];
  /** H1 candles per BASE asset for the WITHIN-BATCH correlation check.
   *  Every evaluation in a tick is judged against the same starting book —
   *  so a tick in which a whole correlated cluster fires at once passes
   *  that gate N times over. Omit to skip the batch check. */
  correlationCandles?: Record<string, Candle[] | undefined>;
  /** Must match how correlationCandles is keyed. Defaults to identity. */
  toBase?: (symbol: string) => string;
  correlationThreshold?: number;
  maxCorrelatedPositions?: number;
  correlationLookback?: number;
}

const ENTRY_ORDER_SIDES = new Set(['buy', 'sell', 'long', 'short']);

/** A fresh candidate must beat the weakest resting entry's confidence by at
 *  least this margin before it may evict it — a churn guard, so two signals of
 *  near-equal strength do not take turns cancelling each other tick by tick. */
export const SLOT_PREEMPT_MARGIN = 5;

/**
 * Slot preemption. When `positions + pending` has filled every slot, a strong
 * new entry candidate may still enter by bumping the WEAKEST resting (unfilled)
 * entry order out of its slot — a resting limit order is a reservation, not a
 * position, and the strongest signals should own the reservations.
 *
 * Rules:
 *  - Only PENDING ENTRY orders are preemptible. A filled position is never
 *    touched here.
 *  - The candidate must beat the weakest incumbent's confidence by
 *    SLOT_PREEMPT_MARGIN.
 *  - `claimed` carries ids already spoken for earlier in the same batch, so two
 *    candidates in one tick cannot both free the same slot.
 *
 * Returns the id of the order to cancel, or null to leave the candidate blocked.
 */
export function pickPreemptibleEntryOrder(
  candidateConfidence: number,
  pending: PendingOrder[],
  claimed: Set<string>
): string | null {
  let weakest: PendingOrder | undefined;
  for (const o of pending) {
    if (!ENTRY_ORDER_SIDES.has(o.side) || claimed.has(o.id)) continue;
    if (!weakest || o.confidence < weakest.confidence) weakest = o;
  }
  if (!weakest) return null;
  return candidateConfidence >= weakest.confidence + SLOT_PREEMPT_MARGIN ? weakest.id : null;
}

/**
 * Applies the cancellations that `pickPreemptibleEntryOrder` decided during the
 * gate / order-gen pass: every evaluation that carries `preemptsOrderId` AND
 * actually produced an order this tick (its symbol is in `placedSymbols`) has
 * its incumbent removed from `pending`. Shared by the server tick loop and both
 * browser fallback hooks so the rule is identical in every runtime.
 */
export function applySlotPreemptions(
  pending: PendingOrder[],
  evaluations: { symbol: string; preemptsOrderId?: string }[],
  placedSymbols: Set<string>
): { pending: PendingOrder[]; cancelledIds: string[] } {
  const cancel = new Set<string>();
  for (const ev of evaluations) {
    if (ev.preemptsOrderId && placedSymbols.has(ev.symbol)) cancel.add(ev.preemptsOrderId);
  }
  if (cancel.size === 0) return { pending, cancelledIds: [] };
  return { pending: pending.filter((o) => !cancel.has(o.id)), cancelledIds: [...cancel] };
}

export function generateNewOrders(ctx: OrderGenContext): PendingOrder[] {
  const {
    positions, pending, evaluations, executionDelaySec, dailyDrawdownPercent, weeklyDrawdownPercent,
    exitCooldown, priceFor, buildCandlesForSymbol, computeAtr5, maxPositions, maxFuturesPositions,
    closedTrades, correlationCandles, toBase = (x: string) => x,
    correlationThreshold = DEFAULT_CORRELATION_THRESHOLD,
    maxCorrelatedPositions = DEFAULT_MAX_CORRELATED,
    correlationLookback = DEFAULT_CORRELATION_LOOKBACK
  } = ctx;
  const delayMs = Math.max(0, executionDelaySec) * 1000;
  const newOrders: PendingOrder[] = [];

  // Exits for open positions.
  // The skip is per POSITION, not per symbol: keying it on the symbol meant
  // that while one lot's close sat pending, every other lot of the same asset
  // went unchecked for its own stop — so a book holding the same asset N times
  // released its stops one per tick and the rest kept bleeding in between.
  // Orders with no positionId (persisted before that field existed, and every
  // entry order) still match by symbol, so their old behaviour is unchanged.
  for (const pos of positions) {
    const claimed = (o: PendingOrder) => (o.positionId ? o.positionId === pos.id : o.symbol === pos.symbol);
    if (pending.some(claimed) || newOrders.some(claimed)) continue;

    const livePrice = priceFor(pos.symbol) ?? pos.currentPrice;
    const candles5 = buildCandlesForSymbol(pos.symbol);
    const atr5 = computeAtr5(candles5);

    const currentEval = evaluations.find((e) => e.symbol === pos.symbol);
    const decision = currentEval?.decision;
    const reversal = decision && decision.outcome === 'SIGNAL'
      ? { direction: decision.direction, setupScore: decision.metrics.setupScore, entryConfirmed: !!decision.entry?.confirmed }
      : undefined;

    const exitCheck = evaluatePositionExit(
      {
        symbol: pos.symbol,
        type: pos.type,
        side: pos.side,
        entryPrice: pos.entryPrice,
        quantity: pos.quantity,
        stopLoss: pos.stopLoss,
        takeProfit1: pos.takeProfit1,
        takeProfit2: pos.takeProfit2,
        tp1Hit: pos.tp1Hit,
        openTimestamp: pos.openTimestamp,
        plannedStopDistance: Math.abs(pos.entryPrice - pos.stopLoss),
        highestPrice: pos.highestPrice,
        lowestPrice: pos.lowestPrice,
        highestPriceSinceTP1: pos.highestPriceSinceTP1,
        lowestPriceSinceTP1: pos.lowestPriceSinceTP1,
        maxHoldMs: pos.maxHoldMs,
        timeStopMs: pos.timeStopMs,
        naturalStopPct: pos.naturalStopPct,
        setupType: pos.setupType,
        ratchetConsumed: pos.ratchetConsumed
      },
      livePrice,
      atr5,
      { dailyDrawdownPercent, weeklyDrawdownPercent },
      reversal,
      { ...DEFAULT_INTRADAY_PARAMS, ...SIM_INTRADAY_PARAMS_OVERRIDE }
    );

    if (!exitCheck.shouldExit) continue;

    if (exitCheck.exitType === 'PARTIAL_RATCHET') {
      newOrders.push({
        id: uid(`${pos.symbol}-ratchet`),
        symbol: pos.symbol,
        positionId: pos.id,
        type: pos.type,
        side: 'partial_tp1',
        exitFraction: exitCheck.ratchetFraction,
        ratchetConsumed: exitCheck.ratchetConsumed,
        signalPrice: livePrice,
        quantity: pos.quantity * (exitCheck.ratchetFraction ?? 0),
        reason: exitCheck.reason,
        confidence: pos.confidence,
        executeAt: Date.now() + delayMs,
        createdAt: Date.now()
      });
    } else if (exitCheck.exitType === 'PARTIAL_50') {
      newOrders.push({
        id: uid(`${pos.symbol}-tp1-50`),
        symbol: pos.symbol,
        positionId: pos.id,
        type: pos.type,
        side: 'partial_tp1',
        signalPrice: livePrice,
        quantity: pos.quantity * 0.5,
        reason: exitCheck.reason,
        confidence: pos.confidence,
        executeAt: Date.now() + delayMs,
        createdAt: Date.now()
      });
    } else {
      newOrders.push({
        id: uid(`${pos.symbol}-exit`),
        symbol: pos.symbol,
        positionId: pos.id,
        type: pos.type,
        side: pos.side === 'LONG' || pos.side === 'BUY' ? 'close_long' : 'close_short',
        signalPrice: livePrice,
        quantity: pos.quantity,
        reason: exitCheck.reason,
        confidence: pos.confidence,
        executeAt: Date.now() + delayMs,
        createdAt: Date.now()
      });
    }
  }

  // New entries from evaluations that passed every gate. Running counts,
  // seeded from open positions PLUS already-pending entries (not yet
  // filled) and incremented as this batch adds more — the per-symbol
  // evaluations were all gated against the position count as it stood at
  // the START of this tick, so a batch cap here is the only thing standing
  // between "N symbols qualified simultaneously" and "N new positions
  // regardless of maxPositions".
  // The per-symbol losing-streak cooldown is applied in the entry loop below.
  // It is deliberately per-symbol — a losing streak on one asset should not
  // block entries on unrelated ones.

  // Cash consumed by this batch. computeEntryBudget is a percentage of the
  // free balance, so reading ctx.cash for every order in the same tick sized
  // N simultaneous entries as if each one were the only entry of the tick.
  let workingCash = ctx.cash;

  let totalPositionCount = positions.length + pending.filter((o) => ENTRY_ORDER_SIDES.has(o.side)).length;
  let futuresPositionCount = positions.filter((p) => p.type === 'FUTURES').length +
    pending.filter((o) => o.type === 'FUTURES' && ENTRY_ORDER_SIDES.has(o.side)).length;
  // Resting entry orders this batch has already agreed to evict for a stronger
  // candidate — so a second candidate cannot free the same slot twice.
  const preemptClaimed = new Set<string>();

  // Running correlation book: open positions + already-pending entries, grown
  // as this batch accepts more.
  const correlationBook: CorrelatedHolding[] = correlationCandles
    ? [
        ...positions.map((p) => ({ symbol: toBase(p.symbol), direction: toPositionDirection(p.side) })),
        ...pending
          .filter((o) => ENTRY_ORDER_SIDES.has(o.side))
          .map((o) => ({ symbol: toBase(o.symbol), direction: toPositionDirection(o.side) }))
      ]
    : [];

  // Capital floor (operator decision 2026-09-08): position size is pinned to
  // the STARTING capital, so a losing bot keeps opening full-size positions
  // until this floor. Below it, entries stop entirely — exits and position
  // management continue as normal.
  const belowFloor = isBelowCapitalFloor(ctx.initialAmount, ctx.equity);

  for (const ev of evaluations) {
    if (!ev.willExecute || !ev.price || ev.tradeType === 'HOLD') continue;
    if (belowFloor) {
      blockEntry(
        ev,
        'CAPITAL_FLOOR',
        `הון $${ctx.equity.toFixed(2)} מתחת ל-${(CAPITAL_FLOOR_PCT * 100).toFixed(0)}% מההון ההתחלתי $${(ctx.initialAmount ?? 0).toFixed(2)} — כניסות חדשות מושהות`
      );
      continue;
    }
    // One position per symbol. Without this, the queue check below is not a
    // dedup at all: once an entry fills, its symbol leaves `pending`, and the
    // very same signal — unchanged, because it is read off a candle that moves
    // far slower than this loop runs — queues the asset again, and again,
    // stacking lots of one asset until the position cap is spent. Nothing
    // downstream merges them: fillDueOrders always pushes a NEW position, each
    // with its own stop, and they then all stop out together. Scaling into a
    // winner is not a feature this engine has.
    if (positions.some((p) => p.symbol === ev.symbol)) continue;
    if (newOrders.some((o) => o.symbol === ev.symbol) || pending.some((o) => o.symbol === ev.symbol)) continue;

    // Smart re-entry: recovery recomputed against ev.price (the fresh signal's
    // own current price) on every check — see ReentryCooldownState's doc.
    if (isInEntryCooldown(exitCooldown[ev.symbol], ev.price)) continue;
    // Post-losing-streak pause — per-symbol, and a book-level backstop for a
    // run of losses spread across different symbols (regime, not symbol).
    if (isInStreakCooldown(streakCooldownFromHistory(closedTrades ?? [], ctx.equity, ev.symbol))) continue;
    if (isInStreakCooldown(portfolioStreakCooldownUntil(closedTrades ?? [], ctx.equity))) continue;
    if (totalPositionCount >= maxPositions) {
      // Slots are full — but a resting (unfilled) entry order is only a
      // reservation. If this candidate clearly outranks the weakest one, evict
      // it and take the slot; the tick loop cancels the incumbent once this
      // order is actually placed.
      const victimId = pickPreemptibleEntryOrder(ev.confidence, pending, preemptClaimed);
      if (!victimId) continue;
      preemptClaimed.add(victimId);
      ev.preemptsOrderId = victimId;
    }
    if (ev.tradeType === 'FUTURES' && futuresPositionCount >= maxFuturesPositions) continue;

    // SPOT is long-only here (short-selling spot is unsupported). A SPOT
    // evaluation whose tradeSide is not 'BUY' is a converter bug, and the old
    // `: 'sell'` fallback turned it into an order fillDueOrders silently
    // no-ops — it treats only buy/long/short as entries — so the signal
    // vanished instead of failing. Refuse it loudly instead of inventing a
    // spot short. See resolveTradeSide in intradayBridge.ts.
    if (ev.tradeType === 'SPOT' && ev.tradeSide !== 'BUY') {
      blockEntry(ev, 'BAD_TRADE_SIDE', `SPOT עם tradeSide="${ev.tradeSide}" במקום "BUY"`);
      continue;
    }
    const orderSide: PendingOrder['side'] = ev.tradeType === 'FUTURES'
      ? (ev.tradeSide === 'LONG' ? 'long' : 'short')
      : 'buy';

    // Adaptive sizing (DecisionEngine path): the decision's risk plan carries
    // the multiplier computed from recent closed-trade performance (clamped to
    // [0,1] — it only ever de-risks). Evaluations built outside the engine
    // (tests / legacy paths) carry no multiplier → 1.
    const rawRisk = (ev.decision as { risk?: { sizingMultiplier?: number } | null } | null | undefined)?.risk;
    const streakMult = typeof rawRisk?.sizingMultiplier === 'number' && Number.isFinite(rawRisk.sizingMultiplier)
      ? Math.max(0, Math.min(1, rawRisk.sizingMultiplier))
      : 1;

    // Fear-band conviction (opt-in). The index is "afraid, not capitulating",
    // the engine already approved this as a MEAN_REVERSION buy, and a losing
    // streak had throttled the size — lift the multiplier back toward full so
    // the confirmed dip is taken at conviction size. Floor is < 1, so this
    // never breaches the 10%-of-equity target; it only undoes de-risking.
    const inFearBand =
      ctx.fearGreedSizeBoost === true &&
      typeof ctx.fearGreedIndex === 'number' &&
      ctx.fearGreedIndex >= FEAR_BAND_LOW &&
      ctx.fearGreedIndex <= FEAR_BAND_HIGH &&
      orderSide === 'buy' &&
      ev.decision?.setupType === 'MEAN_REVERSION';
    const riskMult = inFearBand ? Math.max(streakMult, FEAR_BAND_SIZING_FLOOR) : streakMult;
    if (inFearBand && riskMult > streakMult) {
      console.info(`[sim] ${ev.symbol}: F&G ${ctx.fearGreedIndex} בטווח פחד + MEAN_REVERSION BUY — רצפת גודל ${FEAR_BAND_SIZING_FLOOR} (streak היה ${streakMult.toFixed(2)})`);
    }

    const rawBudget = resolveEntryBudget({
      kellyBetSizeUsd: ev.betSizeUsd,
      equity: ctx.equity,
      initialAmount: ctx.initialAmount,
      cash: workingCash,
      sizingMultiplier: riskMult
    });
    // MIN_ORDER is a constraint, not a sizing input. Skip when target < floor.
    if (rawBudget < MIN_SIM_ENTRY_USD) {
      blockEntry(
        ev,
        MIN_ORDER_EXCEEDS_POSITION_TARGET,
        `תקציב הכניסה $${rawBudget.toFixed(2)} < מינימום הזמנה $${MIN_SIM_ENTRY_USD} (הון $${ctx.equity.toFixed(2)}, מזומן פנוי $${workingCash.toFixed(2)})`
      );
      continue;
    }

    const evDirection = toPositionDirection(ev.tradeSide as string);
    if (correlationCandles) {
      // The intraday regime module is the only one of the four engines that
      // computes a true ATR PERCENTILE (a 0-100 rank against its own recent
      // history). Legacy and Pro carry atrPercent — ATR as a share of price —
      // which is a different quantity on a different scale, so they leave this
      // undefined rather than feed a 3%-of-price reading in as "the 3rd
      // percentile". See resolveCorrelationLookback.
      const evAtrPercentile = (ev.decision as unknown as { regime?: { atrPercentile?: number } } | undefined)?.regime?.atrPercentile;
      const gate = evaluateCorrelationGate({
        symbol: toBase(ev.symbol),
        direction: evDirection,
        held: correlationBook,
        candlesBySymbol: correlationCandles,
        threshold: correlationThreshold,
        maxCorrelated: maxCorrelatedPositions,
        lookback: correlationLookback,
        atrPercentile: evAtrPercentile
      });
      if (!gate.allowed) {
        blockEntry(ev, 'CORRELATION', gate.reason ?? 'קורלציה גבוהה מדי מול פוזיציה פתוחה');
        continue;
      }
      // An abstained gate is "I could not measure this", not "these are
      // independent" — and it abstains hardest at cold start, when the book
      // fills fastest. See blocksOnAbstention.
      if (blocksOnAbstention(gate, correlationBook.length, maxCorrelatedPositions)) {
        blockEntry(ev, 'CORRELATION', abstentionBlockReason(correlationBook.length, maxCorrelatedPositions));
        continue;
      }
    }

    totalPositionCount++;
    workingCash -= rawBudget;
    if (ev.tradeType === 'FUTURES') futuresPositionCount++;
    if (correlationCandles) correlationBook.push({ symbol: toBase(ev.symbol), direction: evDirection });

    // LIMIT mode (proLimitEntries on): rest at entry.entryPrice's maker discount
    // (optimalEntryPrice) — fillDueOrders only crosses it once price reaches
    // that level or better, exactly what the real bot places on the exchange
    // (tradingWorker.ts: `orderType:'Limit'`). MARKET mode (off): fire at the
    // live price with adverse slippage. Sizing is off whichever price the order
    // actually rests / fills at, so quantity matches the fill.
    const entryPrice = ctx.limitEntries ? (ev.optimalEntryPrice ?? ev.price) : ev.price;
    newOrders.push({
      id: uid(`${ev.symbol}-${orderSide}`),
      symbol: ev.symbol,
      type: ev.tradeType as 'SPOT' | 'FUTURES',
      side: orderSide,
      signalPrice: entryPrice,
      fill: ctx.limitEntries ? 'limit' : 'market',
      quantity: (rawBudget * (ev.leverage || 1)) / entryPrice,
      budgetUsd: rawBudget,
      leverage: ev.leverage || 1,
      stopLoss: ev.stopLoss,
      takeProfit1: ev.takeProfit1,
      takeProfit2: ev.takeProfit2,
      takeProfit: ev.takeProfit,
      reason: ev.reasoning,
      confidence: ev.confidence,
      executeAt: Date.now() + delayMs,
      createdAt: Date.now(),
      // A resting entry may not outlive the trade it is trying to open. The 5M
      // entry confirmation behind this order decays on the same clock as the
      // hold budget, so half of that budget is the longest a stale confirmation
      // is worth acting on. Falls back to the flat TTL when the plan carried no
      // hold budget.
      expiresAt: typeof ev.decision?.risk?.maxHoldMs === 'number'
        ? Date.now() + ev.decision.risk.maxHoldMs * ENTRY_TTL_HOLD_FRACTION
        : undefined,
      // Carry the setup-type-correct hold budget from the entry-time RiskPlan
      // (see the SimPosition.maxHoldMs doc comment) — without this, every
      // position falls back to a single hardcoded default at exit-check time.
      maxHoldMs: ev.decision?.risk?.maxHoldMs,
      timeStopMs: ev.decision?.risk?.timeStopMs,
      naturalStopPct: ev.decision?.risk?.naturalStopPct,
      setupType: ev.decision?.setupType
    });
  }

  return newOrders;
}

// ── 3. Order fill / execution ────────────────────────────────────────────────
// Fills every due pending order: opens a new position (buy/long/short),
// partially or fully closes an existing one, applying slippage/fees and the
// SL/TP reanchor. Pure — callers own applying the returned state and sending
// any notifications from `events`.

const EXIT_ORDER_SIDES = new Set(['close_long', 'close_short', 'partial_tp1']);

/** Deliberately SHORTER than the real bot's own LIMIT_ORDER_TTL_MS (4h in
 *  tradingWorker.ts): a 2h TTL makes the simulation's entries more
 *  stale-signal-resistant than the live bot's. Note the consequence when
 *  reading sim results as a forecast — an entry the simulation cancelled at
 *  2h is one the live bot may still fill at 3h. */
export const LIMIT_ORDER_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

/** When an unfilled resting entry is cancelled: the engine's own horizon when
 *  it set one (`PendingOrder.expiresAt`), else the flat 2h default. */
export function orderExpiryAt(o: Pick<PendingOrder, 'createdAt' | 'expiresAt'>): number {
  return typeof o.expiresAt === 'number' && Number.isFinite(o.expiresAt)
    ? o.expiresAt
    : o.createdAt + LIMIT_ORDER_TTL_MS;
}

/** Fraction of a setup's max-hold budget an unfilled entry may consume before
 *  it is cancelled. At 0.5 an intraday BREAKOUT_RETEST (60 min) rests 30
 *  minutes and a TREND_PULLBACK (120 min) rests 60 — always less than the
 *  trade's own life, never the flat 2h that outlived it. */
export const ENTRY_TTL_HOLD_FRACTION = 0.5;

export interface FillableOrdersResult {
  due: PendingOrder[];
  expired: PendingOrder[];
}

/**
 * Splits pending orders into those ready to fill now and those that expired
 * unfilled. EXIT orders (SL/TP/trailing/time-stop closes) behave like real
 * market/stop orders: once the execution delay elapses they fire
 * immediately, no price condition — matching how the real bot's SL/TP
 * brackets fire on the exchange side. ENTRY orders behave like a real
 * resting LIMIT order: the delay only marks the earliest check time: they
 * only actually become due once the live price has crossed to the order's
 * own limit (signalPrice) or better — a BUY/LONG limit only at or below its
 * price, a SELL/SHORT limit only at or above. If price never crosses within
 * LIMIT_ORDER_TTL_MS the order expires unfilled (mirrors the real bot's own
 * TTL-cancel in tradingWorker.ts) instead of being force-filled at whatever
 * the live price happens to be — which previously turned every "Limit"
 * order in this simulation into a delayed MARKET order and let entries fill
 * on the wrong side of their own stated limit (observed live: "Limit BUY @
 * $1.3680" filled at $1.3756).
 */
export function selectFillableOrders(pending: PendingOrder[], now: number, priceFor: (symbol: string) => number | undefined): FillableOrdersResult {
  const due: PendingOrder[] = [];
  const expired: PendingOrder[] = [];
  for (const o of pending) {
    if (now < o.executeAt) continue;
    // EXIT orders — and §6's delayed MARKET entries (Pro) — fire the moment
    // their execution delay elapses, no price condition. Everything else is a
    // resting LIMIT entry (see below).
    if (EXIT_ORDER_SIDES.has(o.side) || o.fill === 'market') {
      due.push(o);
      continue;
    }
    const live = priceFor(o.symbol) ?? o.signalPrice;
    const isLongSide = o.side === 'buy' || o.side === 'long';
    const crossed = isLongSide ? live <= o.signalPrice : live >= o.signalPrice;
    if (crossed) {
      // Do not let a resting entry-limit fill into a move that has already
      // blown through the position's own stop level: the price that crossed
      // the limit here was reached on the WRONG side of the signal, and an
      // entry at this price would open underwater with the stop no longer
      // protecting the original risk plan. Cancel the order instead of
      // stacking a losing entry precisely where the entry was supposed to be
      // defended (adverse-selection guard).
      if (
        (isLongSide && typeof o.stopLoss === 'number' && live < o.stopLoss) ||
        (!isLongSide && typeof o.stopLoss === 'number' && live > o.stopLoss)
      ) {
        expired.push(o);
        continue;
      }
      due.push(o);
    } else if (now >= orderExpiryAt(o)) {
      expired.push(o);
    }
  }
  return { due, expired };
}

export interface FillEvent {
  kind: 'entry' | 'partial_exit' | 'exit';
  symbol: string;
  text: string;
}

export interface FillResult {
  cash: number;
  positions: SimPosition[];
  newTrades: SimTrade[];
  feesAdded: number;
  slipAdded: number;
  /** Symbols that fully closed this batch (win or loss) — merge into the
   *  caller's cooldown map for isInEntryCooldown's recovery recomputation. */
  newCooldowns: Record<string, ReentryCooldownState>;
  events: FillEvent[];
}

/** Simulation cost model overrides, from SimBotConfig. Omit either field to use
 *  the exchange's real fee schedule / the default slippage band. */
export interface SimCostOverrides {
  feePercent?: number;
  slippagePercent?: number;
  /** Portfolio equity at the time of fill — used for the fill-time exposure recheck (§11/N5).
   *  Optional: when absent the exposure recheck is skipped (backward-compatible). */
  equity?: number;
  /** The bot's STARTING capital. The fill-time caps are percentages of the same
   *  base the order was SIZED against — reading live equity here would re-impose
   *  the shrinking cap the fixed base exists to avoid, and reject at fill time
   *  an order that passed at generation time. */
  initialAmount?: number;
}

export function fillDueOrders(due: PendingOrder[], cash: number, positions: SimPosition[], priceFor: (symbol: string) => number | undefined, formatPrice: (n: number) => string, costs: SimCostOverrides = {}): FillResult {
  const equity = costs.equity;
  // Explicit timeZone: this runs both in the browser (whatever local TZ) and
  // on the server (Render defaults to UTC) — without it, a trade's displayed
  // "last: HH:MM:SS" silently used the server's UTC clock instead of Israel
  // time, making a trade from moments ago look ~3 hours stale in the UI.
  const now = new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' });
  let workingCash = cash;
  let workingPositions = [...positions];
  const newTrades: SimTrade[] = [];
  const newCooldowns: Record<string, ReentryCooldownState> = {};
  const events: FillEvent[] = [];
  let feesAdded = 0;
  let slipAdded = 0;

  for (const order of due) {
    const market = priceFor(order.symbol) ?? order.signalPrice;
    const isEntryOrder = order.side === 'buy' || order.side === 'long' || order.side === 'short';
    // ENTRY orders default to real resting LIMIT orders (see
    // selectFillableOrders — they only reach `due` once price has actually
    // crossed the limit), so they fill at their own limit price or BETTER,
    // exactly like a real exchange limit fill — never at "live price + adverse
    // slippage", which previously let a "Limit BUY @ $1.3680" fill at $1.3756.
    // EXIT orders (SL/TP/trailing/time-stop) and §6's delayed MARKET entries
    // (Pro) stay market-style: they fill at the live price with slippage —
    // alg.md §6: "המילוי מחושב לפי מחיר השוק באותו רגע... תמיד לרעת הבוט".
    const entryIsLimit = isEntryOrder && order.fill !== 'market';
    const sideForSlippage = order.side === 'buy' || order.side === 'long' ? 'BUY' : 'SELL';
    const isLongSide = order.side === 'buy' || order.side === 'long';
    const { fillPrice, slippagePercent } = entryIsLimit
      ? { fillPrice: isLongSide ? Math.min(market, order.signalPrice) : Math.max(market, order.signalPrice), slippagePercent: 0 }
      : simulateSlippage(market, sideForSlippage, costs.slippagePercent);
    const delayMs = Date.now() - order.createdAt;

    if (isEntryOrder) {
      // Free cash is a CONSTRAINT at fill time, never a sizing input.
      //
      // This used to read `Math.min(order.budgetUsd ?? 0, workingCash)`, whose
      // own comment promised to "drop the order rather than open it
      // undersized" — but the clamp only dropped below the $100 floor. A
      // $1,000 budget meeting $950 of free cash opened a $950 position: the
      // last place in the codebase where a downstream mechanism silently
      // resized the 10%-of-equity target. Three explicit refusals now, each
      // naming itself, instead of one silent shrink.
      const requested = order.budgetUsd ?? 0;

      if (!(requested > 0)) {
        // Persisted before PendingOrder carried budgetUsd. `?? 0` used to send
        // it straight under the floor and out — indistinguishable in the log
        // from a legitimately-too-small order.
        console.warn(
          `[sim] ${order.symbol}: entry order has no budgetUsd (queued before the field existed) — dropped rather than filled at an invented size.`
        );
        continue;
      }
      if (requested < MIN_SIM_ENTRY_USD) {
        console.warn(
          `[sim] ${order.symbol}: entry budget $${requested.toFixed(2)} < minimum $${MIN_SIM_ENTRY_USD} — skipped, never bumped up.`
        );
        continue;
      }
      if (requested > workingCash) {
        console.warn(
          `[sim] ${order.symbol}: entry needs $${requested.toFixed(2)} but only $${workingCash.toFixed(2)} is free — skipped, never downsized.`
        );
        continue;
      }

      const budget = requested;

      const isFutures = order.type === 'FUTURES';
      const leverage = order.leverage || 1;
      const notional = budget * leverage;

        // §11 / N5: recheck exposure at fill time. Between queue and fill,
        // other positions in this batch may have consumed the per-asset or
        // total exposure cap. The budget was pre-trimmed at generation time,
        // but the fill-time equity picture can be different. Uses costs.equity
        // passed through from the caller; absent → recheck skipped (backward-compatible).
        if (equity !== undefined) {
          const perAssetExposure = positions
            .filter((p) => p.symbol === order.symbol)
            .reduce((sum, p) => sum + p.notionalUsd, 0);
          // Total leverage cap (§12): the 80% ceiling applies to SPOT + FUTURES
          // combined, not type-by-type. A mix of 70% SPOT + 15% FUTURES + 10%
          // FUTURES order must be rejected (95% > 80%), not accepted (15% + 10% < 80%).
          const totalExposure = positions.reduce((sum, p) => sum + p.notionalUsd, 0);
          const capBase = resolveSizingBase(costs.initialAmount, equity);
          const perAssetCap = capBase * (PER_ASSET_EXPOSURE_CAP_PERCENT / 100);
          const totalCap = capBase * (MAX_TOTAL_EXPOSURE_PERCENT / 100);
          if (perAssetExposure + notional > perAssetCap) continue;
          if (totalExposure + notional > totalCap) continue;
        }
      // Limit-entry fills are Maker-type (the order only fills at or better
      // than its own limit price — see selectFillableOrders): charging Taker
      // here inflated entry costs 2.75-5x and contradicted evaluateCostEdge,
      // which already models Maker entry cost (§25). §6's MARKET entries
      // (Pro) cross the book by construction — Taker, "עמלת Taker בכל צד".
      const fee = calculateTradingFee(notional, order.type, !entryIsLimit, costs.feePercent);
      const totalCost = budget + fee;
      if (totalCost > workingCash) continue;
      const quantity = notional / fillPrice;

      workingCash -= totalCost;
      feesAdded += fee;
      slipAdded += Math.abs(fillPrice - market) * quantity;

      const reanchor = (level: number | undefined) => reanchorLevel(fillPrice, order.signalPrice, level);

      const newPos: SimPosition = {
        id: uid(order.symbol),
        symbol: order.symbol,
        type: order.type,
        side: order.side === 'long' ? 'LONG' : order.side === 'short' ? 'SHORT' : 'BUY',
        quantity,
        entryPrice: fillPrice,
        avgPrice: fillPrice,
        currentPrice: fillPrice,
        leverage,
        marginUsd: budget,
        notionalUsd: notional,
        stopLoss: reanchor(order.stopLoss) ?? (isLongSide ? fillPrice * 0.95 : fillPrice * 1.05),
        takeProfit1: reanchor(order.takeProfit1),
        takeProfit2: reanchor(order.takeProfit2),
        takeProfit: reanchor(order.takeProfit) ?? (isLongSide ? fillPrice * 1.05 : fillPrice * 0.95),
        tp1Hit: false,
        highestPrice: fillPrice,
        lowestPrice: fillPrice,
        openedAt: now,
        openTimestamp: Date.now(),
        reason: order.reason,
        confidence: order.confidence,
        entryFee: fee,
        maxHoldMs: order.maxHoldMs,
        timeStopMs: order.timeStopMs,
        naturalStopPct: order.naturalStopPct,
        setupType: order.setupType
      };
      // Snapshot risk-at-entry AFTER newPos is built: it needs the reanchored
      // stopLoss actually stored on the position, not order.stopLoss, which was
      // computed against the signal price rather than the fill price.
      newPos.initialRiskUsd = Math.abs(fillPrice - newPos.stopLoss) * quantity;

      // §10/§11: post-fill R:R computed from the re-anchored levels + actual fill price.
      // The evaluation-time actualRR (in prev4hRange/trendBreakout plans) used
      // entryRef = signal price; here we recompute using fillPrice.
      if (newPos.takeProfit1 && newPos.takeProfit1 !== fillPrice) {
        const riskAtFill = Math.abs(fillPrice - newPos.stopLoss);
        const rewardAtFill = Math.abs(newPos.takeProfit1 - fillPrice);
        newPos.fillRR = riskAtFill > 0 ? Number((rewardAtFill / riskAtFill).toFixed(4)) : 0;
      }

      workingPositions.push(newPos);
      newTrades.push({
        id: order.id, symbol: order.symbol, type: order.type, side: order.side,
        price: fillPrice, requestedPrice: order.signalPrice, slippagePercent, fee, delayMs,
        quantity, usdValue: notional, leverage, timestamp: now, at: Date.now(),
        reason: order.reason, confidence: order.confidence
      });

      events.push({
        kind: 'entry',
        symbol: order.symbol,
        text: `🟢 סימולציה — כניסה\n\n` +
          `סמל: ${order.symbol}\n` +
          `כיוון: ${newPos.side}${isFutures ? ` (${leverage}x)` : ''}\n` +
          `מחיר כניסה: $${formatPrice(fillPrice)}\n` +
          `SL: $${formatPrice(newPos.stopLoss)}\n` +
          (newPos.takeProfit1 ? `TP1: $${formatPrice(newPos.takeProfit1)}\n` : '') +
          (newPos.takeProfit2 ? `TP2: $${formatPrice(newPos.takeProfit2)}\n` : '') +
          `סיבה: ${order.reason || '-'}\n` +
          `זמן: ${now}`
      });
    } else if (order.side === 'partial_tp1') {
      // Type-aware since 2026-09-08. This lookup used to require
      // `p.type === 'FUTURES'`, so a partial TP1 on a SPOT position matched
      // nothing and the order was silently dropped — intraday has emitted
      // PARTIAL_50 orders for spot longs all along and none of them ever
      // executed. Spot longs are the majority of what these bots open.
      const posIdx = workingPositions.findIndex((p) => (order.positionId ? p.id === order.positionId : p.symbol === order.symbol));
      if (posIdx >= 0) {
        const pos = workingPositions[posIdx];
        const isSpot = pos.type === 'SPOT';
        // The profit ratchet closes 30%, the legacy TP1 closed half. Clamped so
        // a malformed order can never close more than the position or nothing.
        const exitFraction = Math.min(1, Math.max(0, order.exitFraction ?? TP1_EXIT_FRACTION));
        const closeQty = pos.quantity * exitFraction;
        const remainingFraction = 1 - exitFraction;
        const notional = closeQty * fillPrice;
        const fee = calculateTradingFee(notional, pos.type, true, costs.feePercent);

        // Spot sells coins for cash; futures releases the matching share of
        // margin and settles the pnl. Same shapes the full-close branch uses.
        let pnl: number;
        if (isSpot) {
          const netProceeds = notional - fee;
          const costBasis = closeQty * pos.avgPrice;
          pnl = netProceeds - costBasis - pos.entryFee * exitFraction;
          workingCash += netProceeds;
        } else {
          pnl = pos.side === 'LONG'
            ? (fillPrice - pos.entryPrice) * closeQty
            : (pos.entryPrice - fillPrice) * closeQty;
          workingCash += pos.marginUsd * exitFraction + pnl - fee;
        }

        feesAdded += fee;
        slipAdded += Math.abs(fillPrice - market) * closeQty;

        workingPositions[posIdx] = {
          ...pos,
          quantity: pos.quantity - closeQty,
          marginUsd: pos.marginUsd * remainingFraction,
          notionalUsd: (pos.quantity - closeQty) * fillPrice,
          // The entry fee of the part just sold has been charged against this
          // partial's pnl; leaving it whole would charge it a second time when
          // the remainder closes.
          entryFee: pos.entryFee * remainingFraction,
          tp1Hit: true,
          ratchetConsumed: order.ratchetConsumed ?? pos.ratchetConsumed,
          highestPriceSinceTP1: fillPrice,
          lowestPriceSinceTP1: fillPrice,
          // The remainder was opened against a proportional share of the
          // original risk. Without scaling here, the eventual full close would
          // divide the remainder's pnl by the whole position's risk and
          // understate its R.
          initialRiskUsd: pos.initialRiskUsd !== undefined ? pos.initialRiskUsd * remainingFraction : undefined
        };

        const partialBasis = isSpot ? closeQty * pos.avgPrice : pos.marginUsd * exitFraction;
        const partialPnlPercent = partialBasis > 0 ? (pnl / partialBasis) * 100 : 0;
        newTrades.push({
          id: order.id, symbol: order.symbol, type: pos.type, side: 'partial_tp1',
          price: fillPrice, requestedPrice: order.signalPrice, slippagePercent, fee, delayMs,
          quantity: closeQty, usdValue: notional, leverage: pos.leverage, timestamp: now, at: Date.now(),
          reason: order.reason, confidence: order.confidence, pnl, pnlPercent: partialPnlPercent,
          riskUsd: pos.initialRiskUsd !== undefined ? pos.initialRiskUsd * exitFraction : undefined
        });

        events.push({
          kind: 'partial_exit',
          symbol: order.symbol,
          text: `${pnl >= 0 ? '✅' : '🔴'} סימולציה — יציאה חלקית (TP1, 50%)\n\n` +
            `סמל: ${order.symbol}\n` +
            `כיוון: ${pos.side}\n` +
            `מחיר כניסה: $${formatPrice(pos.entryPrice)}\n` +
            `מחיר יציאה: $${formatPrice(fillPrice)}\n` +
            `רווח/הפסד (חלקי): ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${partialPnlPercent >= 0 ? '+' : ''}${partialPnlPercent.toFixed(2)}%)\n` +
            `זמן: ${now}`
        });
      }
    } else {
      const pos = workingPositions.find((p) => (order.positionId ? p.id === order.positionId : p.symbol === order.symbol));
      if (pos) {
        // Hard loss cap (operator rule, 2026-09-08): a position may never
        // REALISE a loss worse than MAX_LOSS_PERCENT of entry — no matter how
        // far price gapped past the stop during the execution delay, how wide
        // an old position's stored stop is, or how much adverse slippage the
        // fill drew. In the adverse case the sim fills the exit exactly at the
        // 4.2% level. For any profitable or sub-cap exit this is a no-op
        // (fillPrice is already the better price).
        const posIsLong = pos.side === 'LONG' || pos.side === 'BUY';
        const lossCapPrice = posIsLong
          ? pos.entryPrice * (1 - MAX_LOSS_PERCENT / 100)
          : pos.entryPrice * (1 + MAX_LOSS_PERCENT / 100);
        const exitPrice = posIsLong
          ? Math.max(fillPrice, lossCapPrice)
          : Math.min(fillPrice, lossCapPrice);

        const notional = pos.quantity * exitPrice;
        const fee = calculateTradingFee(notional, pos.type, true, costs.feePercent);
        let pnl = 0;
        if (pos.type === 'SPOT') {
          const netProceeds = notional - fee;
          const costBasis = pos.quantity * pos.avgPrice;
          pnl = netProceeds - costBasis - pos.entryFee;
          workingCash += netProceeds;
        } else {
          pnl = pos.side === 'LONG'
            ? (exitPrice - pos.entryPrice) * pos.quantity
            : (pos.entryPrice - exitPrice) * pos.quantity;
          workingCash += pos.marginUsd + pnl - fee;
        }

        feesAdded += fee;
        slipAdded += Math.abs(market - exitPrice) * pos.quantity;
        workingPositions = workingPositions.filter((p) => p.id !== pos.id);
        // Every full exit — win or loss — now leaves cooldown state; see
        // ENTRY_COOLDOWN_MS's doc comment for why the win-exempt version was
        // reverted (2026-09-16, FLOCK). isInEntryCooldown recomputes recovery
        // against the live price on each check rather than trusting a fixed
        // duration decided here.
        newCooldowns[order.symbol] = { at: Date.now(), exitPrice, isLong: posIsLong };

        const pnlPercent = pos.type === 'SPOT'
          ? (pnl / (pos.quantity * pos.avgPrice)) * 100
          : (pnl / pos.marginUsd) * 100;
        newTrades.push({
          id: order.id, symbol: order.symbol, type: pos.type, side: order.side,
          price: exitPrice, requestedPrice: order.signalPrice, slippagePercent, fee, delayMs,
          quantity: pos.quantity, usdValue: notional, leverage: pos.leverage, timestamp: now, at: Date.now(),
          reason: order.reason, confidence: order.confidence, pnl, pnlPercent,
          riskUsd: pos.initialRiskUsd
        });

        events.push({
          kind: 'exit',
          symbol: order.symbol,
          text: `${pnl >= 0 ? '✅' : '🔴'} סימולציה — יציאה\n\n` +
            `סמל: ${order.symbol}\n` +
            `כיוון: ${pos.side}\n` +
            `מחיר כניסה: $${formatPrice(pos.entryPrice)}\n` +
            `מחיר יציאה: $${formatPrice(exitPrice)}\n` +
            `רווח/הפסד: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)\n` +
            `סיבה: ${order.reason || '-'}\n` +
            `זמן: ${now}`
        });
      }
    }
  }

  return { cash: workingCash, positions: workingPositions, newTrades, feesAdded, slipAdded, newCooldowns, events };
}

// Re-exported for the server factory (simEngineFactory.ts) that imports from
// @cde/engine/execution. This avoids a circular import: simEngineFactory.ts also
// imports execute-only helpers from simExecution.ts, so simDefaults.ts (which
// defines validateExposureModel) is not directly reachable through the barrel.
export { validateExposureModel } from './simDefaults';
