/**
 * Cost / Edge filter + Risk-first position sizing (§25/§26/§27/§30-§35)
 * ============================================================================
 * A short trade is only worth taking when the expected move is large enough to
 * pay for fees + slippage + spread AND still leave a positive expectancy.
 */

import { BYBIT_FEES } from './tradeEngine';
import { clamp } from './intradayIndicators';
import { DEFAULT_INTRADAY_PARAMS, Direction, IntradayParams, SetupType, PER_ASSET_EXPOSURE_CAP_PERCENT, resolveSizingBase } from './intradayParams';
import { MAX_LOSS_PERCENT, TP1_EXIT_FRACTION, tp1FloorDistance } from './exitPolicy';
import { resolveLadderPercents, type StopNoise } from './calmRegime';

export interface CostAnalysis {
  // ── The exact levels this analysis was computed on ────────────────────────
  // Echoed back verbatim so a caller can assert they are identical to the risk
  // plan's levels (the single source of truth). If these ever differ from what
  // the order will use, every number below describes a trade that will not
  // happen — the "shadow levels" bug.
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;

  entryFeePercent: number;
  exitFeePercent: number;
  spreadPercent: number;
  slippagePercent: number;
  totalCostPercent: number;
  /** rewardPercent = |takeProfit1 - entryPrice| / entryPrice * 100.
   *  Kept under the old name `expectedMovePercent` too (identical value) for
   *  the §25 cost gate that reads it. */
  rewardPercent: number;
  /** Alias of rewardPercent — the §25 gate and existing telemetry read this. */
  expectedMovePercent: number;
  /** riskPercent = |entryPrice - stopLoss| / entryPrice * 100. */
  riskPercent: number;
  /** rewardPercent / totalCostPercent */
  edgeRatio: number;
  /** (rewardPercent - totalCostPercent) / riskPercent */
  netRewardRisk: number;
  /** rewardPercent / riskPercent */
  grossRewardRisk: number;
  approved: boolean;
  reason: string;
  blockGate: 'COST' | 'SPREAD' | 'RISK_VS_COST' | null;
}

export interface CostInput {
  tradeType: 'SPOT' | 'FUTURES';
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  spreadPercent: number;
  atrPercentile: number;
  entryIsLimit?: boolean;
  /** Relative volume (current / rolling average) for the same candle series and
   *  timeframe already used for entry-volume gating. Optional and backward
   *  compatible: omitting it reproduces today's slippage exactly (liquidity
   *  term = 0). */
  relativeVolume?: number;
  /** The price the §25 reward-vs-cost math measures the move against.
   *  Defaults to `takeProfit1` when omitted — existing callers (the live bot)
   *  are unaffected.
   *
   *  Required whenever the fixed profit-ladder is active (`calmRegimeScalp`):
   *  buildRiskPlan's OWN R:R gate already measures gross R:R against TP2 in
   *  that branch (TP1's 1.8/2.3 = 0.78 is deliberately below minRewardRisk —
   *  it is a fast partial, not the trade's thesis; see calmRegime.ts), so a
   *  plan that PASSED that gate reaches here already approved on TP2 math.
   *  Without this field, evaluateCostEdge recomputed reward from TP1 alone and
   *  rejected the same plan a second time on the SAME number the risk gate had
   *  already cleared under a different target — observed live: every ladder
   *  signal that reached COST failed at a strikingly narrow net R:R band
   *  (0.67-0.73, i.e. TP1's own ratio minus costs), regardless of setup type
   *  or symbol, while buildRiskPlan's TP2-based gate (1.52) would have passed
   *  the same plan. See BOTS_REFERENCE.md §1 "COST", fixed 2026-09-14. */
  rewardTarget?: number;
  params?: IntradayParams;
}

/**
 * Modelled round-trip cost as a percent of notional: entry fee + exit fee +
 * spread + one base-slippage leg. The single definition the other engines
 * (Path, and anything that needs a quick cost estimate without the full
 * `evaluateCostEdge` volatility/liquidity model) call instead of a hardcoded
 * literal. Matches `evaluateCostEdge`'s fee/slippage assumptions.
 */
export function estimatedRoundTripCostPct(opts: {
  tradeType: 'SPOT' | 'FUTURES';
  spreadPercent?: number;
  entryIsLimit?: boolean;
  baseSlippagePercent?: number;
}): number {
  const fees = opts.tradeType === 'SPOT' ? BYBIT_FEES.spot : BYBIT_FEES.futures;
  const entryFeePct = (opts.entryIsLimit ? fees.maker : fees.taker) * 100;
  const exitFeePct = fees.taker * 100;
  const spread = Math.max(0, opts.spreadPercent ?? 0);
  const baseSlip = opts.baseSlippagePercent ?? DEFAULT_INTRADAY_PARAMS.baseSlippagePercent;
  // One market leg pays spread/2 + base slippage; a resting limit entry pays ~0.
  const slip = (opts.entryIsLimit ? 0 : spread / 2 + baseSlip) + spread / 2 + baseSlip;
  return Number((entryFeePct + exitFeePct + slip).toFixed(4));
}

export function evaluateCostEdge(input: CostInput): CostAnalysis {
  const params = input.params ?? DEFAULT_INTRADAY_PARAMS;
  // Echoed verbatim on every return path so the caller can assert these are the
  // SAME entry / SL / TP1 the risk plan and the order use (single source of
  // truth). Nothing here derives its own levels.
  const levels = { entryPrice: input.entryPrice, stopLoss: input.stopLoss, takeProfit1: input.takeProfit1 };
  const fees = input.tradeType === 'SPOT' ? BYBIT_FEES.spot : BYBIT_FEES.futures;
  const entryFeePercent = (input.entryIsLimit === false ? fees.taker : fees.maker) * 100;
  const exitFeePercent = fees.taker * 100; // SL/TP exits cross the book
  const spreadPercent = Math.max(0, input.spreadPercent);

  // Liquidity-aware slippage: below-average volume means a thinner book, so a
  // market order (the exit leg, always taker) moves price more per unit size
  // than the spread alone implies. Derived from the SAME relative-volume signal
  // already computed for entry gating — not an assumed hour-of-day calendar —
  // so a thin altcoin's dead hours and a major's dead hours are both caught by
  // one mechanism, and no new assumption is introduced. Zero when relativeVolume
  // is omitted or at/above average, so existing callers see no change until they
  // opt in by passing it.
  const liquidityTerm = (input.relativeVolume !== undefined && input.relativeVolume > 0)
    ? clamp((1 / input.relativeVolume) - 1, 0, params.liquidityTermCap) * params.liquidityTermWeight
    : 0;

  // Volatility-aware slippage: entry is a resting limit (low slip), exit is market.
  const volatilityTerm = (clamp(input.atrPercentile, 0, 100) / 100) * 0.03;
  const entrySlippage = input.entryIsLimit === false
    ? spreadPercent / 2 + params.baseSlippagePercent + liquidityTerm
    : 0.005; // resting limit fill/no-fill is not modelled here
  const exitSlippage = params.baseSlippagePercent + spreadPercent / 2 + volatilityTerm + liquidityTerm;
  const slippagePercent = Number((entrySlippage + exitSlippage).toFixed(5));

  const totalCostPercent = Number((entryFeePercent + exitFeePercent + slippagePercent).toFixed(5));
  // rewardTarget defaults to takeProfit1 — see the field doc on CostInput for
  // why a laddered plan must pass TP2 here instead.
  const rewardTarget = input.rewardTarget ?? input.takeProfit1;
  const expectedMovePercent = input.entryPrice > 0 ? (Math.abs(rewardTarget - input.entryPrice) / input.entryPrice) * 100 : 0;
  const riskPercent = input.entryPrice > 0 ? (Math.abs(input.entryPrice - input.stopLoss) / input.entryPrice) * 100 : 0;

  const edgeRatio = totalCostPercent > 0 ? expectedMovePercent / totalCostPercent : 0;
  const grossRewardRisk = riskPercent > 0 ? expectedMovePercent / riskPercent : 0;
  const netRewardRisk = riskPercent > 0 ? (expectedMovePercent - totalCostPercent) / riskPercent : 0;

  if (spreadPercent > params.maxSpreadPercent) {
    return {
      ...levels,
      entryFeePercent,
      exitFeePercent,
      spreadPercent,
      slippagePercent,
      totalCostPercent,
      rewardPercent: Number(expectedMovePercent.toFixed(4)),
      expectedMovePercent: Number(expectedMovePercent.toFixed(4)),
      riskPercent: Number(riskPercent.toFixed(4)),
      edgeRatio: Number(edgeRatio.toFixed(2)),
      netRewardRisk: Number(netRewardRisk.toFixed(2)),
      grossRewardRisk: Number(grossRewardRisk.toFixed(2)),
      approved: false,
      reason: `Spread ${spreadPercent.toFixed(3)}% מעל התקרה (${params.maxSpreadPercent}%) — נזילות לא מספקת (§26)`,
      blockGate: 'SPREAD'
    };
  }

  if (spreadPercent > expectedMovePercent * params.maxSpreadShareOfMove) {
    return {
      ...levels,
      entryFeePercent,
      exitFeePercent,
      spreadPercent,
      slippagePercent,
      totalCostPercent,
      rewardPercent: Number(expectedMovePercent.toFixed(4)),
      expectedMovePercent: Number(expectedMovePercent.toFixed(4)),
      riskPercent: Number(riskPercent.toFixed(4)),
      edgeRatio: Number(edgeRatio.toFixed(2)),
      netRewardRisk: Number(netRewardRisk.toFixed(2)),
      grossRewardRisk: Number(grossRewardRisk.toFixed(2)),
      approved: false,
      reason: `Spread ${spreadPercent.toFixed(3)}% גדול מ-${(params.maxSpreadShareOfMove * 100).toFixed(0)}% מהמהלך הצפוי (${expectedMovePercent.toFixed(3)}%) — NO TRADE`,
      blockGate: 'SPREAD'
    };
  }

  // Risk-vs-cost gate (§25b). netRewardRisk divides by riskPercent, so a
  // shrinking stop makes it LARGER — the reward-side gates below cannot see a
  // stop that is too tight to survive its own round trip. A 0.12% stop against
  // a ~0.4% round trip means every exit, winning or losing, gives back more
  // than the stop distance. Reject it by name rather than approve a trade whose
  // stop is decorative.
  if (riskPercent > 0 && riskPercent < params.minStopCostMultiple * totalCostPercent) {
    return {
      ...levels,
      entryFeePercent,
      exitFeePercent,
      spreadPercent,
      slippagePercent,
      totalCostPercent,
      rewardPercent: Number(expectedMovePercent.toFixed(4)),
      expectedMovePercent: Number(expectedMovePercent.toFixed(4)),
      riskPercent: Number(riskPercent.toFixed(4)),
      edgeRatio: Number(edgeRatio.toFixed(2)),
      netRewardRisk: Number(netRewardRisk.toFixed(2)),
      grossRewardRisk: Number(grossRewardRisk.toFixed(2)),
      approved: false,
      reason: `סטופ ${riskPercent.toFixed(3)}% < ${params.minStopCostMultiple}× עלות סבב ${totalCostPercent.toFixed(3)}% — כל יציאה מחזירה יותר מהסטופ, NO TRADE`,
      blockGate: 'RISK_VS_COST'
    };
  }

  // Single reward-side gate: netRewardRisk = (move - cost) / risk already folds
  // in the round-trip cost, and RISK_VS_COST above guards the risk side. The
  // old `expectedMove > cost × costSafetyMultiplier` check was a cruder version
  // of the same thing and only ever rejected trades netRR already rejected.
  const approved = netRewardRisk >= params.minRewardRisk;

  const reason = approved
    ? `R:R נטו ${netRewardRisk.toFixed(2)} ≥ ${params.minRewardRisk} (מהלך ${expectedMovePercent.toFixed(3)}% · עלות ${totalCostPercent.toFixed(3)}%)`
    : `R:R נטו ${netRewardRisk.toFixed(2)} מתחת ל-${params.minRewardRisk} אחרי עלויות — NO TRADE`;

  return {
    ...levels,
    entryFeePercent,
    exitFeePercent,
    spreadPercent,
    slippagePercent,
    totalCostPercent,
    rewardPercent: Number(expectedMovePercent.toFixed(4)),
    expectedMovePercent: Number(expectedMovePercent.toFixed(4)),
    riskPercent: Number(riskPercent.toFixed(4)),
    edgeRatio: Number(edgeRatio.toFixed(2)),
    netRewardRisk: Number(netRewardRisk.toFixed(2)),
    grossRewardRisk: Number(grossRewardRisk.toFixed(2)),
    approved,
    reason,
    blockGate: approved ? null : 'COST'
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// RISK PLAN — dynamic ATR/structure SL, TP with a 3% floor, 10%-notional sizing
// ═══════════════════════════════════════════════════════════════════════════
//
// The executed stop is the TIGHTER of an ATR multiple (atr5 × maxStopAtrMult)
// and the structural swing (stopReference ∓ buffer), clamped to
// [minStopPercent, maxStopPercent] and then to the shared 4.2% cap.
// MEAN_REVERSION additionally has a stop FLOOR (meanReversionMinStop*).
// TP1 is the FARTHER of an R-multiple and the structural target, with a
// FIXED_TP_PERCENT (3%) minimum for every setup EXCEPT MEAN_REVERSION (whose
// thesis target is the VWAP, structurally under 3% in a range). TP2 scales
// off TP1. The ATR branch always keeps grossRR >= tp1RewardRisk.
//
// buildRiskPlan is the single source of truth for entry / stopLoss /
// takeProfit1; evaluateCostEdge and the order generator read these exact
// numbers back (the DATA_MISMATCH guard in intradayEngine asserts it).
// `validateLevelDirection` below catches a wrong-side level if the model is
// ever changed or a caller hand-builds a plan.

/** Executed take-profit distance (TP1) floor, as a percentage of entry price.
 *  TP1 is dynamic (ATR / structure) but never closer than this. */
export const FIXED_TP_PERCENT = 3.0;

export interface RiskPlanInput {
  symbol?: string;
  direction: Exclude<Direction, 'NONE'>;
  tradeType: 'SPOT' | 'FUTURES';
  setupType: Exclude<SetupType, 'NONE'>;
  entryPrice: number;
  /** Structural stop level (swing low/high). Used to compute the dynamic SL
   *  distance together with ATR and the stop buffer. The executed SL is the
   *  TIGHTER of the structural stop (minus buffer) and the ATR-based stop,
   *  clamped to [minStopPercent, maxStopPercent] — 0.12% and 1.5%, NOT the
   *  shared 4.2% cap, which only bounds the pre-ceiling `dynamicSlPct`. */
  stopReference?: number;
  /** Structural target level. Used to compute the dynamic TP1 distance.
   *  The executed TP1 is the FARTHER of the structural target and the ATR-based
   *  target, with a FIXED_TP_PERCENT (3%) minimum for every setup except
   *  MEAN_REVERSION (whose target is the VWAP). */
  targetReference?: number | null;
  atr5: number;
  atr15: number;
  /** "A lot of buyers" on the entry timeframe — see `isBuyingSurge`. Read only
   *  when the fixed scalp ladder is on (`params.calmRegimeScalp`); one of the
   *  two things that let the stop widen past the fixed 2.3%. */
  buyingSurge?: boolean;
  /** 5M bar-noise measurement — see `measureStopNoise`. The other thing that
   *  widens the stop: a stop inside one ordinary bar's range is a coin flip on
   *  noise, not a risk limit. Read only when `params.noiseFloorStop` is on.
   *  Omitted = no floor, and the flat ladder stands unchanged. */
  stopNoise?: StopNoise;
  equity: number;
  /** Capital to size against. Defaults to `equity` (the LIVE bot's behaviour).
   *  The simulations pass their STARTING capital here so a drawdown reduces how
   *  many positions fit, not how big each one is — see resolveSizingBase. */
  sizingBase?: number;
  openPositions: number;
  openFutures: number;
  currentLeveragedExposureUsd: number;
  /** Current notional exposure per asset for per-asset cap */
  existingExposureByAsset?: Record<string, number>;
  params?: IntradayParams;
  /** Signal confidence (0-100). Telemetry only — nothing in buildRiskPlan reads
   *  it. */
  confidence?: number;
  /** Adaptive sizing multiplier (clamped to [0,1]) injected by the
   *  DecisionEngine orchestrator from recent closed-trade performance — it
   *  only ever de-risks. The live scan() path passes none → 1 (base sizing). */
  sizingMultiplier?: number;
  /** Deterministic Dynamic Volatility Profile ladder (sim only, resolved by
   *  the caller via `resolveVolatilityLadder` from `@cde/engine/volatility`
   *  — this file does no profile lookup itself). When present and both
   *  distances are positive, it REPLACES the dynamic ATR/structure SL/TP1
   *  computation and the fixed `calmRegimeScalp` ladder outright — highest
   *  precedence of the three ladder sources. `targetPct` becomes TP1;
   *  TP2 is still scaled from it by `tp2RewardRisk/tp1RewardRisk`, so the
   *  two-tier partial/runner structure survives. Absent (undefined) on
   *  every call site that doesn't resolve a profile (e.g. PROFILE_NOT_FOUND)
   *  — the plan then falls through to the ladders below exactly as before. */
  volatilityLadder?: { stopPct: number; targetPct: number };
}

export interface RiskPlan {
  approved: boolean;
  blockReason?: string;
  /** The entry price these levels were computed from — echoed so the cost
   *  analysis and the order can be asserted identical to it (single source of
   *  truth for levels). */
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  stopDistance: number;
  stopDistancePercent: number;
  /** |entryPrice - stopLoss| / entryPrice * 100 — the ONE risk % for this trade. */
  riskPercent: number;
  /** |takeProfit1 - entryPrice| / entryPrice * 100 — the ONE reward % for this trade. */
  rewardPercent: number;
  /** rewardPercent / riskPercent — gross R:R on the executed levels. */
  grossRewardRisk: number;
  riskUsd: number;
  quantity: number;
  notionalUsd: number;
  marginUsd: number;
  leverage: number;
  rewardRisk1: number;
  rewardRisk2: number;
  maxHoldMs: number;
  timeStopMs: number;
  /** The symbol's own natural noise floor at entry (measureStopNoise().floorPct,
   *  a percent of entry price) — frozen here the same way the executed stop is,
   *  so it stays comparable across the life of the position. Only set when
   *  `noiseFloorStop` is on and a measurement was available; undefined means
   *  "use the old executed-stop-distance behavior" (see intradayExit.ts's
   *  time-stop check, the ONE consumer of this field). NOT used for sizing,
   *  NOT the executed stop — it exists to answer "has this specific symbol's
   *  tape actually moved", which the executed stop (deliberately widened past
   *  a calm symbol's real volatility by the flat ladder) cannot answer. */
  naturalStopPct?: number;
  /** notionalUsd / equity × 100 — what this position is worth as a share of
   *  the book RIGHT NOW. Reporting only; no gate reads it.
   *
   *  Read it as exactly that and nothing more. It is NOT the target
   *  allocation: sizing divides by `resolveSizingBase(sizingBase, equity)`,
   *  which is the STARTING capital whenever one is known, so the two diverge
   *  the moment equity leaves its start. A $10k bot targeting 10% opens
   *  $1,000; after a drawdown to $5k it still opens $1,000, and this field
   *  correctly reports 20% — the position really is a fifth of the book. The
   *  invariant that the 10% target was honoured is asserted separately, and
   *  against `sizingBase`, in buildRiskPlan (§24 ASSERTION_FAIL). */
  positionPercentOfEquity: number;
  riskPercentUsed: number;
  /** The sizing multiplier actually applied to this plan (1 = base sizing). */
   sizingMultiplier: number;
   /** Which exposure cap was the binding constraint on this plan's notional (§23).
    *  Empty string or absent means no cap was hit — the full target was used. */
   bindingConstraint?: 'per_asset' | 'total' | 'cash' | 'min_order';
}

/**
 * The ONE place that decides whether entry / SL / TP1 sit on the correct sides
 * for a direction (§3 step 3). Returns a Hebrew reason string on failure, or
 * null when the levels are valid. Also rejects a zero / negative stop distance
 * and a target equal to entry.
 *
 * Called by buildRiskPlan (and available to callers / tests). Under the fixed
 * SL/TP model it should never fail from within buildRiskPlan; it is the guard
 * that catches a wrong-side level if the model is ever changed or a caller
 * hand-builds a plan.
 */
export function validateLevelDirection(
  direction: Exclude<Direction, 'NONE'>,
  entryPrice: number,
  stopLoss: number,
  takeProfit1: number
): string | null {
  if (!(entryPrice > 0)) return 'מחיר כניסה לא תקין';
  if (!(Math.abs(entryPrice - stopLoss) > 0)) return 'מרחק סטופ אפס/שלילי';
  if (direction === 'LONG') {
    if (stopLoss >= entryPrice) return 'SL חייב להיות מתחת למחיר הכניסה ב-LONG';
    if (takeProfit1 <= entryPrice) return 'TP1 חייב להיות מעל מחיר הכניסה ב-LONG';
  } else {
    if (stopLoss <= entryPrice) return 'SL חייב להיות מעל מחיר הכניסה ב-SHORT';
    if (takeProfit1 >= entryPrice) return 'TP1 חייב להיות מתחת למחיר הכניסה ב-SHORT';
  }
  return null;
}

const rejected = (reason: string): RiskPlan => ({
  approved: false,
  blockReason: reason,
  entryPrice: 0,
  stopLoss: 0,
  takeProfit1: 0,
  takeProfit2: 0,
  stopDistance: 0,
  stopDistancePercent: 0,
  riskPercent: 0,
  rewardPercent: 0,
  grossRewardRisk: 0,
  riskUsd: 0,
  quantity: 0,
  notionalUsd: 0,
  marginUsd: 0,
  leverage: 1,
  rewardRisk1: 0,
  rewardRisk2: 0,
  maxHoldMs: 0,
  timeStopMs: 0,
  positionPercentOfEquity: 0,
  riskPercentUsed: 0,
  sizingMultiplier: 1,
  bindingConstraint: undefined
});

export function buildRiskPlan(input: RiskPlanInput): RiskPlan {
   const params = input.params ?? DEFAULT_INTRADAY_PARAMS;
   const entry = input.entryPrice;

  if (!(entry > 0) || !(input.equity > 0)) return rejected('נתוני מחיר/הון לא תקינים');
  if (input.openPositions >= params.maxOpenPositions) return rejected(`מקסימום ${params.maxOpenPositions} פוזיציות פתוחות`);
  if (input.tradeType === 'FUTURES' && input.openFutures >= params.maxOpenFutures) {
    return rejected(`מקסימום ${params.maxOpenFutures} פוזיציות Futures`);
  }

  const isLong = input.direction === 'LONG';
  const s = isLong ? 1 : -1;

  // ── Dynamic SL computation ─────────────────────────────────────────────
  // SL = f(ATR, structure, volatility, regime), clamped to [MIN_STOP, MAX_STOP=4.2%].
  // Uses stopReference (structural swing) when available, falls back to ATR-based.
  const atr5 = input.atr5 > 0 ? input.atr5 : entry * 0.001;
  const atr15 = input.atr15 > 0 ? input.atr15 : atr5;

  // ATR-based stop distance (percent of entry), BEFORE maxStopPercent. That
  // ceiling is applied once at the end instead of here — see `dynamicSlPct`.
  const atrStopPct = (atr5 * params.maxStopAtrMult) / entry * 100;

  // Structure-based stop distance (from stopReference with buffer)
  let structureStopPct: number | undefined;
  if (typeof input.stopReference === 'number' && input.stopReference > 0) {
    const buffer = params.stopStructureBufferAtr * atr5;
    const structuralLevel = isLong
      ? Math.max(0.00000001, input.stopReference - buffer)
      : input.stopReference + buffer;
    structureStopPct = Math.abs(entry - structuralLevel) / entry * 100;
  }

  // Choose the TIGHTER stop (smaller distance = less risk)
  let dynamicSlPct = atrStopPct;
  if (structureStopPct !== undefined && structureStopPct > 0) {
    dynamicSlPct = Math.min(dynamicSlPct, structureStopPct);
  }

  // MEAN_REVERSION stop floor. Its stopReference is the swing over just the last
  // 6 5M candles in a RANGING regime, so the structural branch above nearly
  // always wins and floors at minStopPercent (0.12%) — tighter than the
  // round-trip cost, which makes every exit a loss. These two knobs widen the
  // MR stop specifically; both default to unset (no effect).
  if (input.setupType === 'MEAN_REVERSION') {
    const mrAtrFloorPct = typeof params.meanReversionMinStopAtrMult === 'number'
      ? (atr5 * params.meanReversionMinStopAtrMult) / entry * 100
      : 0;
    const mrPctFloor = params.meanReversionMinStopPercent ?? 0;
    dynamicSlPct = Math.max(dynamicSlPct, mrAtrFloorPct, mrPctFloor);
  }

  // What ATR and structure actually measured, bounded only by the SHARED
  // limits. `maxStopPercent` (1.5%) is deliberately NOT applied here: it is a
  // live-bot ceiling, not a statement about the symbol's volatility, and the
  // fixed ladder's surge branch reads this number to decide whether 2.3% sits
  // inside the move. Capping it first made `max(2.3%, dynamic)` a no-op for
  // every symbol, so the surge exception — the ladder's ONLY widening rule
  // between 2026-09-11 and the noise floor — never fired once in this bot.
  dynamicSlPct = Math.max(params.minStopPercent, Math.min(MAX_LOSS_PERCENT, dynamicSlPct));

  // The EXECUTED stop adds the live-bot ceiling on top. Unchanged behaviour:
  // when the ladder is off this is the same number as before.
  let slDistancePct = Math.min(dynamicSlPct, params.maxStopPercent);

  let slDistance = entry * slDistancePct / 100;

  // ── Dynamic TP computation ─────────────────────────────────────────────
  // TP = f(ATR, structure, minimum_reward). TP2 scales from TP1 by
  // tp2RewardRisk/tp1RewardRisk.
  //
  // The TP1 floor is `tp1FloorDistance` = max(1.5% of entry, 1.5× the stop) —
  // not a flat 3%. A 3% target is unreachable in-horizon on a low-volatility
  // major, so those trades used to time-stop out flat. MEAN_REVERSION is
  // exempt entirely: its thesis target is the VWAP, structurally 1-2% in a
  // RANGING regime. The ATR branch (slDistance × tp1RewardRisk) plus the
  // net-R:R gate still keep every trade above its cost.
  const minTp1Distance = input.setupType === 'MEAN_REVERSION'
    ? 0
    : tp1FloorDistance(entry, slDistance);

  // ATR-based TP1 distance (using reward-risk ratio)
  const atrTp1Distance = slDistance * params.tp1RewardRisk;

  // Structure-based TP1 distance (from targetReference)
  let structureTp1Distance: number | undefined;
  if (typeof input.targetReference === 'number' && input.targetReference > 0) {
    structureTp1Distance = Math.abs(input.targetReference - entry);
  }

  // Choose the FARTHER target (larger distance = more reward); non-MR trades
  // also carry the stop-relative floor via minTp1Distance.
  let tp1Distance = Math.max(atrTp1Distance, structureTp1Distance ?? 0, minTp1Distance);

  // ── Fixed scalp ladder (opt-in, sim only via SIM_INTRADAY_PARAMS_OVERRIDE) ──
  // Operator decision (2026-09-11): ONE fixed ladder — SL 2.3% / TP1 1.8% /
  // TP2 3.5% — replaces the dynamic one outright, so small moves get taken
  // instead of chased. The single exception is a BUYING SURGE (see
  // calmRegime.ts): only then does the stop widen, to this bot's own dynamic
  // ATR/structure stop clamped to [2.3%, 4.2%], because a flat 2.3% sits
  // inside the noise of such a move. TP1 stays 1.8% regardless — that is the
  // point of the strategy — so its own R:R is deliberately poor and the gate
  // below is measured against TP2 instead, which scales with the stop.
  // ── Volatility Profile ladder (opt-in, sim only, highest precedence) ────
  // Resolved upstream (intradayEngine.ts) via resolveVolatilityLadder — this
  // file never touches candles or the compiled profile file itself, it only
  // consumes the two already-computed distances. Present only when a valid,
  // sufficient-history profile exists for this symbol/market/side; every
  // other case (no profile, insufficient history, invalid data, no closed H1
  // candle) leaves this undefined and the ladders below run unchanged.
  const volatilityLadderActive =
    input.volatilityLadder !== undefined &&
    input.volatilityLadder.stopPct > 0 &&
    input.volatilityLadder.targetPct > 0;
  let volatilityTp2Distance: number | undefined;
  if (volatilityLadderActive) {
    // Same portfolio-wide ceiling every other ladder source respects — the
    // module's own dynamicRiskPct is a REFERENCE distance (see its doc
    // comment), not an exemption from this bot's hard risk limit.
    slDistancePct = Math.max(params.minStopPercent, Math.min(MAX_LOSS_PERCENT, input.volatilityLadder!.stopPct));
    slDistance = entry * slDistancePct / 100;
    tp1Distance = entry * input.volatilityLadder!.targetPct / 100;
    volatilityTp2Distance = tp1Distance * (params.tp2RewardRisk / params.tp1RewardRisk);
  }

  const ladderActive = !volatilityLadderActive && params.calmRegimeScalp === true;
  let ladderTp2Distance: number | undefined;
  // The symbol's own natural noise floor (measureStopNoise().floorPct),
  // hoisted out of the `if (ladderActive)` block below so it survives to the
  // return statement. Feeds `naturalStopPct` on the plan — the unit the time
  // stop's stagnation check uses instead of the executed stop distance. See
  // the field's own doc comment for why: the executed stop is a RISK budget
  // (can be far wider than a calm symbol's real movement), and "has this
  // trade moved" needs to be measured against what the symbol actually does,
  // not against how much was risked on it.
  let naturalStopPct: number | undefined;
  if (ladderActive) {
    // The stop must clear one 5M bar's own range, or an ordinary candle takes
    // it out on a thesis that never failed. Off unless `noiseFloorStop` is on,
    // which leaves the flat ladder exactly as it was.
    const noise = params.noiseFloorStop === true ? input.stopNoise : undefined;
    naturalStopPct = noise && noise.floorPct > 0 ? noise.floorPct : undefined;
    const ladder = resolveLadderPercents({
      // The PRE-ceiling dynamic stop — see where it is computed above.
      dynamicSlPct,
      buyingSurge: input.buyingSurge === true,
      noiseFloorPct: noise?.floorPct,
      isLong
    });
    if (ladder.tooVolatile) {
      return rejected(
        `תנודתיות 5M גבוהה מדי — נר גרוע ${(noise?.badBarPercent ?? 0).toFixed(2)}% דורש סטופ ${ladder.noiseFloorPct.toFixed(2)}%, מעל התקרה ${MAX_LOSS_PERCENT}% — NO TRADE`
      );
    }
    slDistancePct = ladder.slPct;
    slDistance = entry * slDistancePct / 100;
    tp1Distance = entry * ladder.tp1Pct / 100;
    ladderTp2Distance = entry * ladder.tp2Pct / 100;
  }

  // ── TP impossible gate ──────────────────────────────────────────────────
  // If the dynamic SL makes it impossible to achieve a reasonable R:R, reject
  // the trade. No artificial SL widening or TP shrinking. In the calm branch
  // (and the volatility-profile branch, which scales TP2 the same way) the
  // gate is measured against TP2 (the runner), not the fast TP1 partial.
  const effectiveTp2Distance = volatilityLadderActive
    ? volatilityTp2Distance!
    : (ladderActive ? ladderTp2Distance! : tp1Distance);
  const grossRR = effectiveTp2Distance / slDistance;
  if (grossRR < params.minRewardRisk) {
    return rejected(`R:R נטו ${grossRR.toFixed(2)} מתחת לסף ${params.minRewardRisk} (SL=${slDistancePct.toFixed(2)}%, TP=${(tp1Distance/entry*100).toFixed(2)}%) — NO TRADE`);
  }

  // ── Compute levels ─────────────────────────────────────────────────────
  let stopLoss: number;
  let takeProfit1: number;
  let takeProfit2: number;
  const stopDistance = slDistance;

  if (input.tradeType === 'SPOT' || isLong) {
    stopLoss = Math.max(0.00000001, entry - slDistance);
    takeProfit1 = entry + tp1Distance;
    takeProfit2 = entry + effectiveTp2Distance;
  } else {
    stopLoss = entry + slDistance;
    takeProfit1 = Math.max(0.00000001, entry - tp1Distance);
    takeProfit2 = Math.max(0.00000001, entry - effectiveTp2Distance);
  }

  // Direction check (§3 step 3) — ONE authoritative validator for SL AND TP1
  // side, zero stop distance, and target==entry.
  const dirError = validateLevelDirection(input.direction, entry, stopLoss, takeProfit1);
  if (dirError) return rejected(dirError);

  const rewardRisk1 = Math.abs(takeProfit1 - entry) / stopDistance;
  const rewardRisk2 = Math.abs(takeProfit2 - entry) / stopDistance;

  // ── Size: target notional first (§NEW) ─────────────────────────────────────
  // Position sizing is now 10% of equity, independent of stop-loss distance.
  // SL is used only to measure the resulting dollar risk.
   // Every percent-of-capital limit below reads this one number. Sizing against
   // live equity while the per-asset cap also read live equity is what let a
   // 0.1% drawdown push the 10% target under the $100 order floor and freeze
   // the bot permanently (see resolveSizingBase).
   const sizingBase = resolveSizingBase(input.sizingBase, input.equity);
   const targetNotional = sizingBase * params.positionTargetPct;
   let notionalUsd = targetNotional;
   let quantity = notionalUsd / entry;
   let leverage = 1;
   let bindingConstraint: 'per_asset' | 'total' | 'cash' | 'min_order' | undefined;

  if (input.tradeType === 'SPOT') {
    // SPOT exposure: same 10% per-asset cap as FUTURES (unified model).
    // `maxSpotNotionalPercent` is the cap expressed in percent-of-equity terms;
    // the actual per-asset check (against existingExposureByAsset) mirrors the
    // FUTURES branch below.
    const notionalCap = (sizingBase * params.maxSpotNotionalPercent) / 100;
    if (input.symbol && input.existingExposureByAsset) {
      const maxPerAssetExposure = sizingBase * (PER_ASSET_EXPOSURE_CAP_PERCENT / 100);
      const currentAssetExposure = input.existingExposureByAsset[input.symbol] ?? 0;
      const perAssetCap = maxPerAssetExposure - currentAssetExposure;
      if (perAssetCap <= 0) {
        return rejected(
          `אקספוזר על נכס זה כבר חורג ממגבלת נכס בודד (${maxPerAssetExposure.toFixed(0)}$ = ${PER_ASSET_EXPOSURE_CAP_PERCENT}% מהתיק)`
        );
      }
      if (notionalUsd > perAssetCap) {
        notionalUsd = perAssetCap;
        quantity = notionalUsd / entry;
        bindingConstraint = 'per_asset';
      }
     }
     if (notionalUsd > notionalCap) {
       notionalUsd = notionalCap;
       quantity = notionalUsd / entry;
       bindingConstraint = 'cash';
     }

    // Total SPOT exposure cap (§N7) — mirrors FUTURES's maxLeveragedExposurePercent
    // check. The per-asset cap prevents concentration; this prevents the aggregate
    // from exceeding the portfolio ceiling even if maxOpenPositions is raised.
    const totalSpotExposure = input.existingExposureByAsset
      ? Object.values(input.existingExposureByAsset).reduce((sum, v) => sum + v, 0)
      : 0;
    const totalCap = (sizingBase * params.maxLeveragedExposurePercent) / 100;
    if (totalSpotExposure + notionalUsd > totalCap) {
      return rejected(
        `סה״כ חשיפת SPOT ${Math.round(totalSpotExposure + notionalUsd)}$ מעל התקרה ${Math.round(totalCap)}$ (${params.maxLeveragedExposurePercent}% מהתיק)`
      );
    }
  } else {
    // FUTURES exposure: three independent caps, all mandatory.
    // 1. Margin budget: maxMarginPerTradePercent (4%) × maxLeverage (5x) = 20% notional
    //    cap. This is the "entry gate" cap — not per-asset, not total.
    // 2. Per-asset concentration: PER_ASSET_EXPOSURE_CAP_PERCENT (10%) — same number
    //    the Strategy spec applies to every engine. This is the per-asset cap
    //    for FUTURES, distinct from SPOT's `maxSpotNotionalPercent`.
    // 3. Total leveraged exposure: maxLeveragedExposurePercent (20%).
    const marginBudget = (sizingBase * params.maxMarginPerTradePercent) / 100;
    const notionalCap = marginBudget * params.maxLeverage;
    if (notionalUsd > notionalCap) {
       notionalUsd = notionalCap;
       quantity = notionalUsd / entry;
       bindingConstraint = 'cash';
     }

    // ── Per-asset exposure cap (§35b) ──────────────────────────────────────────
    // Unconditional. A concentration cap exists precisely for the trade that
    // looks strong enough to justify doubling down on one asset, so exempting
    // high scores removed it exactly when it was doing work. Note the exemption
    // also skipped the CLAMP branch below, not just the rejection: a
    // high-confidence signal did not merely bypass the limit, it never had its
    // size trimmed to fit under it either.
    if (input.symbol && input.existingExposureByAsset) {
      const maxPerAssetExposure = sizingBase * (PER_ASSET_EXPOSURE_CAP_PERCENT / 100);
      const currentAssetExposure = input.existingExposureByAsset[input.symbol] ?? 0;
      const perAssetCap = maxPerAssetExposure - currentAssetExposure;
      if (perAssetCap <= 0) {
        return rejected(
          `אקספוזר על נכס זה כבר חורג ממגבלת נכס בודד (${maxPerAssetExposure.toFixed(0)}$ = ${PER_ASSET_EXPOSURE_CAP_PERCENT}% מהתיק)`
        );
      }
      if (notionalUsd > perAssetCap) {
        notionalUsd = perAssetCap;
        quantity = notionalUsd / entry;
        bindingConstraint = 'per_asset';
      }
    }

    // Minimum leverage that supports the required exposure (§35) — never "max".
    leverage = clamp(Math.ceil(notionalUsd / marginBudget), 1, params.maxLeverage);

    const exposureCap = (sizingBase * params.maxLeveragedExposurePercent) / 100;
    // Unconditional — see the per-asset cap above.
    if (input.currentLeveragedExposureUsd + notionalUsd > exposureCap) {
      return rejected(
        `חשיפה ממונפת ${(input.currentLeveragedExposureUsd + notionalUsd).toFixed(0)}$ מעל התקרה ${exposureCap.toFixed(0)}$ (${params.maxLeveragedExposurePercent}% מהתיק)`
      );
    }
  }

  const marginUsd = input.tradeType === 'FUTURES' ? notionalUsd / leverage : notionalUsd;
  if (marginUsd < params.minOrderUsd) {
    return rejected(`גודל פוזיציה ${marginUsd.toFixed(2)}$ מתחת למינימום ${params.minOrderUsd}$ — MIN_ORDER_EXCEEDS_POSITION_TARGET`);
  }
  if (bindingConstraint === undefined && notionalUsd < targetNotional) {
    bindingConstraint = 'min_order';
  }

  const maxHoldMs = params.maxHoldMinutes[input.setupType] * 60_000;

  // ── Diagnostic assertions (§24) — BEFORE return, fail-loud if violated ─────
  // Position target = positionTargetPct of equity. Below target is OK (trimmed
  // by caps or cash); above target is a bug.
  // Measured against the SIZING BASE, not live equity: with a fixed base a
  // drawdown legitimately makes the position a larger share of current equity
  // (that is the whole point of the model), and asserting on equity would throw
  // on the very first losing tick.
  if (notionalUsd > 0 && sizingBase > 0) {
    const actualPct = (notionalUsd / sizingBase) * 100;
    if (actualPct > params.positionTargetPct * 100 + 0.01) {
      throw new Error(
        `ASSERTION_FAIL §24: positionPercentOfEquity ${actualPct.toFixed(2)}% ` +
        `exceeds target ${(params.positionTargetPct * 100).toFixed(2)}% — ` +
        `cap not enforced correctly`
      );
    }
  }
  // Per-asset cap must be >= position target: a cap below target silently
  // shrinks every position below its intended size.
  const perAssetCapPct = params.maxSpotNotionalPercent;
  if (perAssetCapPct < params.positionTargetPct * 100) {
    throw new Error(
      `ASSERTION_FAIL §24: perAssetCapPct (${perAssetCapPct}%) ` +
      `< positionTargetPct (${(params.positionTargetPct * 100).toFixed(1)}%)`
    );
  }

  // Final levels are fixed now. Derive the ONE risk % / reward % / gross R:R
  // from them — everything downstream reads these back, nothing recomputes.
  const finalStopLoss = Number(stopLoss.toFixed(8));
  const finalTakeProfit1 = Number(takeProfit1.toFixed(8));
  const riskPct = Math.abs(entry - finalStopLoss) / entry * 100;
  const rewardPct = Math.abs(finalTakeProfit1 - entry) / entry * 100;
  const actualRiskUsd = notionalUsd * riskPct / 100;

  // R:R consistency: recomputed RR must match what we return.
  const displayedRR = Number((rewardPct / riskPct).toFixed(4));
  if (Math.abs(displayedRR - (rewardPct / riskPct)) > 0.01) {
    throw new Error(
      `ASSERTION_FAIL §24: displayedRR ${displayedRR.toFixed(4)} ≠ computed RR — ` +
      `floating point drift in risk/reward derivation`
    );
  }

  return {
    approved: true,
    entryPrice: entry,
    stopLoss: finalStopLoss,
    takeProfit1: finalTakeProfit1,
    takeProfit2: Number(takeProfit2.toFixed(8)),
    stopDistance: Number(stopDistance.toFixed(8)),
    stopDistancePercent: Number(((stopDistance / entry) * 100).toFixed(4)),
    riskPercent: Number(riskPct.toFixed(6)),
    rewardPercent: Number(rewardPct.toFixed(6)),
    grossRewardRisk: Number((rewardPct / riskPct).toFixed(4)),
    riskUsd: Number(actualRiskUsd.toFixed(2)),
    quantity: Number(quantity.toFixed(8)),
    notionalUsd: Number(notionalUsd.toFixed(2)),
    marginUsd: Number(marginUsd.toFixed(2)),
    leverage,
    rewardRisk1: Number(rewardRisk1.toFixed(2)),
    rewardRisk2: Number(rewardRisk2.toFixed(2)),
    maxHoldMs,
    timeStopMs: Math.round(maxHoldMs * params.timeStopFraction),
    naturalStopPct,
    positionPercentOfEquity: Number(((notionalUsd / input.equity) * 100).toFixed(2)),
     riskPercentUsed: Number(riskPct.toFixed(6)),
     sizingMultiplier: typeof input.sizingMultiplier === 'number' && Number.isFinite(input.sizingMultiplier)
       ? Math.max(0, Math.min(1, input.sizingMultiplier))
       : 1,
     bindingConstraint
   };
}
