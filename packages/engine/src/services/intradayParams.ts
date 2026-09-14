/**
 * IntradayParams — Types & tunable parameters for the Intraday MTF engine
 * ============================================================================
 * Every threshold lives here so the backtest / walk-forward harness can sweep
 * them without touching decision logic (§20, §24, §47, §49).
 *
 *      1H  → MARKET REGIME
 *      15M → SETUP DETECTION
 *      5M  → ENTRY CONFIRMATION
 */

export type Regime1HType = 'BULL_TREND' | 'BEAR_TREND' | 'TRANSITIONAL' | 'RANGING' | 'SOFT_TREND';
export type SetupType = 'TREND_PULLBACK' | 'BREAKOUT_RETEST' | 'MEAN_REVERSION' | 'NONE';
export type Direction = 'LONG' | 'SHORT' | 'NONE';
export type EntryTrigger = 'PULLBACK_HOLD' | 'BREAKOUT_RETEST' | 'REVERSAL_RECOVERY' | 'NONE';

/** Ordered gates — the first failing gate is reported as the block reason (§55) */
export type DecisionGate =
  | 'NO_DATA'
  | 'CIRCUIT_BREAKER'
  | 'EXPOSURE'
  | 'NO_REGIME'
  | 'VOLATILITY'
  | 'LIQUIDITY'
  | 'SPREAD'
  | 'NO_SETUP'
  | 'NO_ENTRY'
  | 'RISK'
  | 'COST'
  // The stop is too tight to survive its own round-trip cost: every exit,
  // winning or losing, gives back more than the stop distance. Distinct from
  // 'COST' (which compares REWARD to cost) because netRewardRisk divides BY the
  // risk, so a shrinking stop makes that score better rather than worse — the
  // one failure mode the reward-side gate is structurally blind to.
  | 'RISK_VS_COST'
  // The cost analysis and the risk plan disagree about entry / SL / TP1 beyond
  // 1e-8 — a "shadow levels" bug. No SIGNAL is emitted; both level sets are
  // logged. This must never fire in normal operation (the cost gate is fed the
  // risk plan's own levels); it is a guard against a future regression.
  | 'DATA_MISMATCH';

export interface IntradayParams {
  // ── Layer A — 1H regime ────────────────────────────────────────────────────
  adxTrendMin: number;
  adxRangeMax: number;
  atrPercentileLookback: number;
  atrPercentileLow: number;
  atrPercentileHigh: number;
  atrPercentileExtreme: number;

  // ── Layer B — 15M setup ───────────────────────────────────────────────────
  setupScoreMin: number;
  setupScoreStrong: number;
  /** Min confirmations (VWAP/Structure/Momentum/Volume/EMA) for a setup to pass (§20) */
  setupConfirmationsMin: number;
  /** Weights must sum to 1 (§20) */
  setupWeights: {
    trend: number;
    momentum: number;
    location: number;
    participation: number;
    structure: number;
  };
  /** Max distance from the 15M EMA20, in 15M ATR units, to still be a pullback */
  pullbackMaxAtrFromEma: number;
  /** Bollinger bandwidth percentile that qualifies as compression */
  compressionPercentileMax: number;
  /** Relative volume required to confirm a breakout candle */
  breakoutVolumeMin: number;
  /** VWAP deviation (in ATR) that qualifies as "significantly away from value" */
  meanReversionVwapAtr: number;
  meanReversionRsiMax: number;
  meanReversionRsiMin: number;

  // ── Layer C — 5M entry ────────────────────────────────────────────────────
  entryScoreMin: number;
  entryScoreStrong: number;
  /** Min entry confirmations (per setup type) for the 5M trigger to confirm (§24) */
  entryConfirmationsMin: number;
  /** Distance beyond the trigger level (in 5M ATR) that counts as chasing */
  maxChaseAtr: number;
  entryLimitOffsetAtr: number;
  /** Minimum relative volume on the 5M trigger candle */
  minEntryRelativeVolume: number;
  /** Minimum relative volume for MEAN_REVERSION entries (lower than trend/breakout
   *  since reversals can print on thinner tape, but still needs some participation) */
  minMeanReversionRelativeVolume: number;

  // ── Cost / Edge (§25) ─────────────────────────────────────────────────────
  costSafetyMultiplier: number;
  /** Spread may not exceed this share of the expected move */
  maxSpreadShareOfMove: number;
  /** Absolute spread ceiling in percent */
  maxSpreadPercent: number;
  /** Minimum 24h quote turnover (USDT) for the asset to be tradable */
  minQuoteVolume24h: number;
  /** Base slippage assumption in percent, before spread/volatility adjustment */
  baseSlippagePercent: number;
  minRewardRisk: number;
  /** Opt-in (default off — see `SIM_INTRADAY_PARAMS_OVERRIDE`, sim only).
   *  Replaces the dynamic ladder with a FIXED SL 2.3% / TP1 1.8% / TP2 3.5%
   *  one, always. Only on a buying surge (M5 relVolume >= 2 and a green bar)
   *  does the stop widen back to this bot's own dynamic value, clamped to
   *  [2.3%, 4.2%]. See `calmRegime.ts` for the full rationale. */
  calmRegimeScalp?: boolean;
  /** Opt-in (default off — see `SIM_INTRADAY_PARAMS_OVERRIDE`, sim only).
   *  Only meaningful together with `calmRegimeScalp`. Adds a SECOND condition
   *  that widens the flat 2.3% stop: the stop must clear 1.6 × one 5M bar's
   *  ATR, so an ordinary candle on a volatile symbol cannot take out a thesis
   *  that never failed. When even the 4.2% ceiling sits inside that noise the
   *  trade is refused outright. See `calmRegime.ts`. */
  noiseFloorStop?: boolean;
  /** Opt-in (default off — see `SIM_INTRADAY_PARAMS_OVERRIDE`, sim only).
   *  Hands every profit exit to the profit ratchet: rungs at 1.8/3/4/5%… are
   *  marked on the way up and sell nothing, coming back down to one sells 30%,
   *  and the 1.8% floor closes the position. TP1/TP2 and the trailing stop are
   *  bypassed while it is on. See `profitRatchet.ts`. */
  profitRatchet?: boolean;
  /** The stop distance must be at least this multiple of the modelled
   *  round-trip cost, or the trade is rejected (DecisionGate 'RISK_VS_COST').
   *  minRewardRisk guards the REWARD side; this guards the RISK side, which
   *  netRewardRisk cannot because it divides by the risk. A MEAN_REVERSION
   *  stop that floors at minStopPercent (0.12%) against a ~0.4% round trip is
   *  the case this catches. SUGGESTED STARTING VALUE — validate via
   *  scripts/abBacktest.ts before relying on it. */
  minStopCostMultiple: number;

  // ── Risk (§30-§35) ────────────────────────────────────────────────────────
  /** Deprecated: position sizing now uses positionTargetPct (10% of equity).
   *  Kept for API stability during the transition — do not use for sizing. */
  riskPerTradePercent: number;
  /** Deprecated: position sizing now uses positionTargetPct (10% of equity).
   *  Kept for API stability during the transition — do not use for sizing. */
  maxRiskPerTradePercent: number;
  /** Target notional as a fraction of equity (e.g. 0.10 = 10%).
   *  Single source of truth for position sizing. Stop-loss distance does NOT
   *  affect notional — it only determines the resulting dollar risk.
   *  In engines that support scale-in (e.g. TrendBreakout), the scaleFractions
   *  array defines FRACTIONS OF THIS TARGET, not fractions of remaining
   *  allocation — so Scale 1 + Scale 2 + Scale 3 = positionTargetPct exactly. */
  positionTargetPct: number;
  minStopAtrMult: number;
  maxStopAtrMult: number;
  minStopPercent: number;
  maxStopPercent: number;
  stopStructureBufferAtr: number;
  tp1RewardRisk: number;
  tp2RewardRisk: number;
  maxLeverage: number;
  /** Margin budget per futures trade, as a share of equity */
  maxMarginPerTradePercent: number;
  maxSpotNotionalPercent: number;
  maxLeveragedExposurePercent: number;
  maxOpenPositions: number;
  maxOpenFutures: number;
  minOrderUsd: number;
  /** Real-money default is false: FUTURES (and therefore SHORT) is normally
   *  blocked outright whenever ATR volatility is HIGH or EXTREME (§10/§34),
   *  which means the bot's only tool for profiting from a sharp down-move is
   *  switched off exactly when the down-move is sharpest. When true, a SHORT
   *  setup gets a carve-out to still trade FUTURES during HIGH volatility
   *  (not EXTREME — that stays blocked for both directions regardless of this
    *  flag). LONG stays blocked in HIGH volatility either way. Simulation-only
    *  for now while this is being
   *  evaluated against real results before enabling it on the live bot.
   */
  allowShortDuringHighVolatility: boolean;
  // MEAN_REVERSION's stopReference is the swing low/high over just the last 6
  // 5M candles (30 min) — and MEAN_REVERSION only fires in a RANGING regime,
  // where ATR5 is naturally small too — so its computed stop distance is
  // structurally tighter than trend/breakout setups, making it prone to
  // whipsaw: a brief wick stops the trade out, and moments later the SAME
  // setup (still-valid oversold/extreme reading) fires again, sometimes at a
  // worse price than the original entry (MEAN_REVERSION also has no
  // chase-penalty protection against that — see intradayEntry.ts). Both knobs
  // below default to unset (no effect — same behavior as before) and are
  // simulation-only for now (see SIM_INTRADAY_PARAMS_OVERRIDE in
  // simExecution.ts), evaluated against real results before considering them
  // for the live bot.
  /** Overrides minStopAtrMult specifically for MEAN_REVERSION positions. */
  meanReversionMinStopAtrMult?: number;
  /** Overrides minStopPercent specifically for MEAN_REVERSION positions. */
  meanReversionMinStopPercent?: number;
  /** SIM-ONLY opt-in (2026-09-08). When true, position sizing and the per-asset
   *  cap are computed against the bot's STARTING capital instead of its live
   *  equity, and entries stop below CAPITAL_FLOOR_PCT of that capital. The LIVE
   *  bot leaves this unset and keeps equity-based sizing — see resolveSizingBase
   *  for why the simulations needed the change. */
  useFixedSizingBase?: boolean;

  // ── Duration / time stops (§28/§29) ───────────────────────────────────────
  maxHoldMinutes: Record<Exclude<SetupType, 'NONE'>, number>;
  /** Share of max hold after which a stagnant trade is cut */
  timeStopFraction: number;
  /** Favourable progress (in R) required at the time-stop checkpoint */
  timeStopMinProgressR: number;
  /** Max favourable excursion (in R) below which a trade counts as stagnant at
   *  the early time-stop checkpoint. A trade that once ran this far is "working,
   *  just slowly" and keeps the full maxHold budget instead of being cut early
   *  at a small loss (MAX_DURATION still ends it on time). */
  timeStopStagnantMfeR: number;
  /** Loss (in R, negative) at or below which a CONFIRMED opposite setup may
   *  close the position on reversal. Between this and +tp1RewardRisk the
   *  position is left to its own SL/TP/time — a reversal there is just churn. */
  reversalMaxLossR: number;
  /** Multiplier applied to a setup's max hold when the trade is ALREADY
   *  working at the max-hold checkpoint (>= maxHoldExtensionMinProgressR).
   *  1 = no extension. A fixed clock cut is the wrong tool for a position
   *  that is demonstrably progressing — but the extension is re-tested on
   *  every subsequent evaluation, so a trade that stalls after earning it
   *  is cut at the next check rather than riding the longer budget out. */
  maxHoldExtensionFactor: Record<Exclude<SetupType, 'NONE'>, number>;
  /** Favourable progress (in R) required to earn the max-hold extension. */
  maxHoldExtensionMinProgressR: number;

  // ── Trailing (§32) ────────────────────────────────────────────────────────
  /** MFE (in R) required before trailing may activate — per-setup override */
  trailingActivationRBySetup: Record<Exclude<SetupType, 'NONE'>, number>;
  /** Fallback when setupType is unknown or not in the record */
  trailingActivationR: number;
  trailingAtrMult: number;
  /** Hard cap on the trailing-stop width as a multiple of the stop distance
   *  (R). On a structural sub-ATR stop, `trailingAtrMult × atr5` can exceed the
   *  whole original stop, so the runner trailed out near break-even and never
   *  reached TP2. The trail width is `min(trailingAtrMult × atr5,
   *  trailingMaxRMult × stopDistance)` — this only ever TIGHTENS it. */
  trailingMaxRMult: number;

  // ── Execution realism (§39/§40) ───────────────────────────────────────────
  limitOrderTtlMinutes: number;
  /** Probability a limit order fills when price only touches the level */
  touchFillProbability: number;
  partialFillRatio: number;

  // ── Circuit breakers (§38) ────────────────────────────────────────────────
  /** Caps the liquidity slippage term at this many percentage points, so a
   *  near-zero relativeVolume reading cannot blow up the cost model.
   *  SUGGESTED STARTING VALUE, not a measured one — validate via
   *  scripts/abBacktest.ts before relying on it live, the same standard every
   *  other tuned constant in this repo is held to. */
  liquidityTermCap: number;
  /** Scales how much a volume shortfall (1/relativeVolume - 1) turns into extra
   *  slippage. SUGGESTED STARTING VALUE — same validation requirement as
   *  liquidityTermCap. */
  liquidityTermWeight: number;
  dailyDrawdownBlockPercent: number;
  weeklyDrawdownLockPercent: number;
  weeklyDrawdownFlattenPercent: number;
}

/** Portfolio circuit-breaker thresholds, in percent of equity.
 *
 *  Single definition on purpose: these two numbers were written out by hand in
 *  the Legacy adapter, the Pro adapter, tradeEngine's exit check and the
 *  intraday defaults. Four copies that happened to agree is not the same thing
 *  as one threshold — the next edit only has to miss one of them.
 */
export const DAILY_DRAWDOWN_BLOCK_PERCENT = 8;
export const WEEKLY_DRAWDOWN_LOCK_PERCENT = 15;

/**
 * Target position size as a fraction of equity.
 *
 * This is the SINGLE SOURCE OF TRUTH for position sizing across all engines.
 * Every new position targets this notional, regardless of stop-loss distance.
 *
 * Previous behavior: riskPerTrade (0.5% of equity) divided by SL distance →
 * position size varied with stop width. That made wide stops produce oversized
 * positions and tight stops produce dust. The new model fixes notional first,
 * then measures the resulting stop-risk as a DERIVED figure.
 */
export const POSITION_TARGET_PCT = 0.10;

/**
 * Max exposure to a single asset, in percent of equity.
 *
 * MUST be >= POSITION_TARGET_PCT. A cap below the target silently forces
 * every position below its intended size — exactly the contradiction this
 * audit fixes. Startup validation enforces this invariant.
 */
export const PER_ASSET_EXPOSURE_CAP_PERCENT = 10;

/**
 * Total portfolio exposure ceiling for the SIMULATION bots, in percent of
 * equity. (The live bot uses `maxLeveragedExposurePercent` = 20 instead — this
 * constant is read only by the sim execution files + simEngineFactory.)
 *
 * Operator decision (2026-09-07): 80. With POSITION_TARGET_PCT = 10% that is
 * room for up to 7 concurrent full positions (7 × 10% = 70%) plus a ~20% cash
 * buffer. `validateExposureModel` enforces `maxPositions × 10% ≤ this`.
 */
export const MAX_TOTAL_EXPOSURE_PERCENT = 80;

/**
 * Fraction of the bot's STARTING capital below which it stops opening new
 * positions. Exits and management keep running — this gates entries only.
 *
 * Operator decision (2026-09-08): 0.30, i.e. the bot keeps trading at its
 * original position size until it has lost 70% of the capital it started with.
 */
export const CAPITAL_FLOOR_PCT = 0.30;

/**
 * The capital a position is sized against.
 *
 * Operator decision (2026-09-08): **the bot's STARTING capital, not its current
 * equity.** A $1,000 bot opens $100 positions forever; a $10,000 bot opens
 * $1,000 positions forever. Losses reduce how MANY positions fit (free cash is
 * still a hard constraint) — they do not shrink the size of each one.
 *
 * The reason is concrete, not stylistic. With sizing pinned to live equity, the
 * $100 order floor equalled exactly 10% of the $1,000 starting capital, so the
 * first cent of drawdown put the target under the floor and every entry was
 * refused — and the bot could not trade its way back, because it could not
 * trade. Measured 2026-09-08 with three of the four bots frozen that way:
 * intraday $995.18, pro $986.78, bybit $995.12 — only path, up 1.2%, still
 * traded.
 *
 * Returns `equity` when no starting capital is known, which is the previous
 * behaviour: callers that do not opt in are unchanged (the LIVE bot included).
 */
export function resolveSizingBase(initialAmount: number | undefined, equity: number): number {
  return typeof initialAmount === 'number' && initialAmount > 0 ? initialAmount : equity;
}

/** True once equity has fallen below CAPITAL_FLOOR_PCT of starting capital —
 *  the point at which fixed-size entries stop. Unknown starting capital never
 *  trips it. */
export function isBelowCapitalFloor(initialAmount: number | undefined, equity: number): boolean {
  if (!(typeof initialAmount === 'number' && initialAmount > 0)) return false;
  return equity < initialAmount * CAPITAL_FLOOR_PCT;
}

export const DEFAULT_INTRADAY_PARAMS: IntradayParams = {
  adxTrendMin: 22,
  adxRangeMax: 18,
  atrPercentileLookback: 200,
  atrPercentileLow: 30,
  atrPercentileHigh: 80,
  atrPercentileExtreme: 95,

  setupScoreMin: 46,
  setupScoreStrong: 64,
  setupConfirmationsMin: 2,
  setupWeights: { trend: 0.25, momentum: 0.2, location: 0.2, participation: 0.15, structure: 0.2 },
  pullbackMaxAtrFromEma: 2.0,
  compressionPercentileMax: 40,
  breakoutVolumeMin: 1.3,
  meanReversionVwapAtr: 1.0,
  meanReversionRsiMax: 35,
  meanReversionRsiMin: 65,

  entryScoreMin: 50,
  entryScoreStrong: 68,
  /** Min entry confirmations (per setup type) for the 5M trigger to confirm (§24) */
  entryConfirmationsMin: 1,
  maxChaseAtr: 1.2,
  entryLimitOffsetAtr: 0.15,
  minEntryRelativeVolume: 0.7,
  minMeanReversionRelativeVolume: 0.5,

  costSafetyMultiplier: 2.0,
  maxSpreadShareOfMove: 0.2,
  maxSpreadPercent: 0.12,
  // Gates a SINGLE Bybit venue's (spot or linear) own 24h turnover for the
  // symbol about to trade (intradayEngine.ts §26). This was 20_000_000 —
  // copied from symbolUniverse.ts's LIQUID_THRESHOLD, which sums turnover
  // ACROSS spot+linear+usdc+inverse to curate the universe. Checked against
  // one venue's volume alone, 20M blocked nearly every symbol (observed live:
  // real Bybit spot volumes of $0.9M-$7M on coins the universe already
  // curated as liquid, all rejected). Lowered to a per-venue execution-safety
  // floor — well above the universe's own MIN_SPOT_VOLUME_FOR_INCLUSION
  // (200k) sanity check, low enough that curated-liquid coins can actually
  // trade.
  minQuoteVolume24h: 1_000_000,
  baseSlippagePercent: 0.02,
  minRewardRisk: 1.2,
  minStopCostMultiple: 2.0,

  // Deprecated for SIZING (that is positionTargetPct now), but still read:
  // intradayEngine passes it to buildRiskPlan as the risk-%% telemetry base,
  // and the walk-forward harness sweeps it. Kept rather than rewire both.
  riskPerTradePercent: 0.5,
  maxRiskPerTradePercent: 0.75,
  positionTargetPct: POSITION_TARGET_PCT,
  minStopAtrMult: 0.8,
  maxStopAtrMult: 2.5,
  minStopPercent: 0.12,
  maxStopPercent: 1.5,
  stopStructureBufferAtr: 0.15,
  tp1RewardRisk: 1.5,
  tp2RewardRisk: 2.5,
  maxLeverage: 5,
  maxMarginPerTradePercent: 4,
  maxSpotNotionalPercent: 10, // 10% per-asset cap for SPOT — unified with FUTURES per-asset cap
  // Matches the legacy engine's hard-coded 20% cap (tradeEngine.ts) and the
  // 20% the risk-meter UI actually displays — was 40 here, silently allowing
  // double the exposure the UI showed as the limit (observed live: 62%
  // exposure against a displayed "20% max", flagged as "limit exceeded").
  maxLeveragedExposurePercent: 20,
  maxOpenPositions: 2, // 2 × 10% = 20% = totalExposureCap — validated invariant
  maxOpenFutures: 2,
  minOrderUsd: 5,
  allowShortDuringHighVolatility: true,

  maxHoldMinutes: { TREND_PULLBACK: 120, BREAKOUT_RETEST: 60, MEAN_REVERSION: 45 },
  timeStopFraction: 0.45,
  timeStopMinProgressR: 0.3,
  timeStopStagnantMfeR: 0.7,
  reversalMaxLossR: -0.7,
  // MEAN_REVERSION is deliberately excluded (1 = no extension): its edge is
  // the snap back to the mean and it decays with time held — extending it is
  // not patience, it is holding a thesis after its window closed.
  maxHoldExtensionFactor: { TREND_PULLBACK: 1.5, BREAKOUT_RETEST: 1.5, MEAN_REVERSION: 1 },
  maxHoldExtensionMinProgressR: 0.5,

  trailingActivationRBySetup: { TREND_PULLBACK: 0.8, BREAKOUT_RETEST: 1.0, MEAN_REVERSION: 1.5 },
  trailingActivationR: 1.0,
  // 1.2 → 1.8: the post-TP1 runner was trailing out near break-even before TP2
  // could print. A wider trail gives it room to actually reach the 2nd target.
  trailingAtrMult: 1.8,
  // ...but never wider than 1R of the (possibly sub-ATR structural) stop, or
  // the runner trails out below TP1 on symbols where atr5 > stopDistance.
  trailingMaxRMult: 1.0,

  limitOrderTtlMinutes: 10,
  touchFillProbability: 0.5,
  partialFillRatio: 0.5,

  liquidityTermCap: 0.05,
  liquidityTermWeight: 0,
  dailyDrawdownBlockPercent: DAILY_DRAWDOWN_BLOCK_PERCENT,
  weeklyDrawdownLockPercent: WEEKLY_DRAWDOWN_LOCK_PERCENT,
  weeklyDrawdownFlattenPercent: WEEKLY_DRAWDOWN_LOCK_PERCENT
};

/** Risk-per-trade variants compared during backtest (§33) */
export const RISK_VARIANTS = [0.25, 0.5, 0.75] as const;

export function withParams(overrides: Partial<IntradayParams> = {}): IntradayParams {
  return {
    ...DEFAULT_INTRADAY_PARAMS,
    ...overrides,
    setupWeights: { ...DEFAULT_INTRADAY_PARAMS.setupWeights, ...(overrides.setupWeights || {}) },
    maxHoldMinutes: { ...DEFAULT_INTRADAY_PARAMS.maxHoldMinutes, ...(overrides.maxHoldMinutes || {}) },
    maxHoldExtensionFactor: { ...DEFAULT_INTRADAY_PARAMS.maxHoldExtensionFactor, ...(overrides.maxHoldExtensionFactor || {}) },
    trailingActivationRBySetup: { ...DEFAULT_INTRADAY_PARAMS.trailingActivationRBySetup, ...(overrides.trailingActivationRBySetup || {}) }
  };
}
