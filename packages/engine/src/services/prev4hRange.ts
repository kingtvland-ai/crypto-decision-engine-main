// Prev-4H Range — a simple 4-hour breakout strategy: read the last CLOSED 4H
// candle's high/low, then during the next 4H window trade a breakout of those
// levels IN THE DIRECTION OF THE 4H EMA(20) TREND.
//
// This replaces the empirical-bucket "Path" engine, whose own offline backtest
// (ASSETS/path-slot-study33) showed no bucket with positive expectancy after
// costs. Prev-4H Range is deliberately simple — no lookup table, no Wilson
// bound, four plain conditions:
//
//   1. previous 4H bar fully closed  →  H, L, mid, range
//   2. we are inside the very next 4H window
//   3. 4H EMA(20) trend agrees with the breakout direction
//   4. the previous bar's range is neither dead-tight nor already blown out
//
// SIMULATION ONLY. Decisions use CLOSED candles only — aggregateToH4 emits a
// bar only once all four of its H1 candles have closed, so `prev` is never the
// forming bar and nothing here reads a future value.

import { Candle, calculateEMA, breakoutLimitPrice } from './tradeEngine';
import { aggregateToH4 } from './pathEngine';
import { barOpenFor, BAR_MS } from './pathStudy';
import type { SignalEvaluation, DecisionFactor } from './intradayBridge';
import { POSITION_TARGET_PCT } from './intradayParams';
import { capStopLoss, stopWasCapped, tp1FloorDistance, MAX_LOSS_PERCENT, TP1_PERCENT } from './exitPolicy';
import { estimatedRoundTripCostPct } from './intradayRisk';
import { resolveLadderPercents, isBuyingSurge, measureStopNoise } from './calmRegime';
import { resolveVolatilityLadder } from './volatilityProfile';
import type { VolatilityMarket, VolatilityProfile } from '../types/volatilityProfile';

// ── Parameters (all configurable — no auto-optimisation) ────────────────────

export interface Prev4hRangeParams {
  /** 4H EMA period for the trend filter. */
  emaPeriod: number;
  /** Previous-bar range as a fraction of price must be >= this (else too tight
   *  — a compressed bar breaks out on noise). */
  minRangePct: number;
  /** ...and <= this (else the move is already made; a late breakout is a bad
   *  entry). */
  maxRangePct: number;
  /** TP distance from entry = range * this. Actual R:R depends on breakout
    *  distance: at d=0 RR=2.0, at d=0.5*range RR=0.5. The old comment claiming
    *  "~2:1" was only true for a perfect touch of H/L. */
  tpRangeMult: number;
  /** The stop distance must be at least this multiple of the modelled
   *  round-trip cost, or the breakout is refused (`RISK_VS_COST`). Mirrors the
   *  intraday engine's `minStopCostMultiple`. */
  costSafetyMultiplier: number;
  /** Target notional as a fraction of equity (e.g. 0.10 = 10%).
   *  Single source of truth for position sizing. */
  positionTargetPct: number;
  /** Confidence SCORE (0-100) required to open. Not a probability. */
  minConfidence: number;
  /** Minimum fully-closed 4H bars before the bot will evaluate a symbol. */
  minH4Bars: number;
  /** Don't chase: the break must be at most `range × this` past H/L. Beyond
    *  that the move is already made and the stop (at `mid`) is too far to size
    *  a sane position — the bot abstains (`ENTRY_TOO_EXTENDED`).
    *
    *  This is an OPERATOR cap layered on top of the geometric one. At the
    *  default 0.5 it never binds: minRR rejects everything past 0.1818·range
    *  first (see maxAdmissibleExtensionMult). Lower it to chase less; raising
    *  it does nothing until minRR is lowered too. */
  maxExtensionRangeMult: number;
  /** Minimum gross risk:reward ratio required to enter. */
  minRR: number;
  /** Opt-in (default off — sim only, see server/pathSimEngine.ts). Replaces the
   *  range-derived ladder with a FIXED SL 2.3% / TP1 1.8% / TP2 3.5% one,
   *  always. Only on a buying surge (H1 relVolume >= 2 and a green bar) does
   *  the stop widen back to the `mid`-derived value, clamped to [2.3%, 4.2%].
   *  See calmRegime.ts. */
  calmRegimeScalp?: boolean;
  /** Opt-in (default off — sim only). Only meaningful with `calmRegimeScalp`.
   *  A SECOND condition that widens the flat 2.3%: the stop must clear 1.6 ×
   *  one H1 bar's ATR — this bot holds across hours, so an hourly bar is the
   *  noise it has to sit outside of. Refuses the trade outright when even the
   *  ceiling sits inside that noise (VOLATILITY_TOO_HIGH). See calmRegime.ts. */
  noiseFloorStop?: boolean;
  /** Resting-limit discount from market, in units of the reference bar's RANGE.
   *  This bot computes no ATR — `range` IS its volatility scale (every level it
   *  uses is a multiple of it), and a 5-minute ATR would be the wrong scale for
   *  a 4-hour strategy. Same role as the intraday bot's entryLimitOffsetAtr. */
  entryLimitOffsetRangeMult: number;
}

/**
 * The furthest past H/L an entry can be and still clear `minRR`, as a fraction
 * of the reference range. Derived, never hardcoded.
 *
 *   entry = H + d,  SL = mid,  TP = H + range·tpRangeMult
 *   reward = range·tpRangeMult − d      risk = range/2 + d
 *   reward/risk >= minRR  ⟺  d <= range · (tpRangeMult − minRR/2) / (1 + minRR)
 *
 * At the defaults (tpRangeMult 1.0, minRR 1.2) that is **0.1818 · range**.
 *
 * This exists because the R:R gate and the confidence score used to disagree
 * about which breakouts are good ones. The `breakout` component scaled to
 * `range × 0.5` and only reached full marks at d = 0.5·range — a distance the
 * R:R gate always rejected — so within the admissible band it could award at
 * most 10.9 of its 30 points, and it rewarded moving TOWARDS rejection. Both
 * now read the same number, so they cannot drift apart again.
 */
export function maxAdmissibleExtensionMult(p: Prev4hRangeParams): number {
  const geometric = (p.tpRangeMult - p.minRR / 2) / (1 + p.minRR);
  return Math.max(0, Math.min(geometric, p.maxExtensionRangeMult));
}

export const DEFAULT_PREV4H_RANGE_PARAMS: Prev4hRangeParams = {
  emaPeriod: 20,
  minRangePct: 0.010,
  maxRangePct: 0.08,
  tpRangeMult: 1.0,
  costSafetyMultiplier: 2.0,
  positionTargetPct: POSITION_TARGET_PCT,
  minConfidence: 55,
  minH4Bars: 24,
  maxExtensionRangeMult: 0.5,
  minRR: 1.2,
  entryLimitOffsetRangeMult: 0.10
};

/** 4H bars needed (params default) → H1 candles needed to build them. */
export const PREV4H_MIN_H4_BARS = 24;
export const PREV4H_MIN_H1_CANDLES = PREV4H_MIN_H4_BARS * 4;

// ── State / reasons ────────────────────────────────────────────────────────

export type Prev4hRangeState =
  | 'NO_DATA'
  | 'NO_SIGNAL'
  | 'ARMED'      // reference bar + trend valid, waiting for a breakout
  | 'SIGNAL';

export type Prev4hRangeReason =
  | 'OK'
  | 'NO_DATA'
  | 'STALE_BAR'         // last closed 4H bar is not the immediately-previous window
  | 'AGAINST_TREND'     // EMA(20) trend is flat / against both breakout sides
  | 'RANGE_TOO_TIGHT'
  | 'RANGE_TOO_WIDE'
  | 'NO_BREAKOUT'        // price still inside [L, H]
  | 'ENTRY_TOO_EXTENDED' // broke out but price already ran too far past H/L
  | 'RISK_VS_COST'       // stop distance too small relative to round-trip cost
  | 'CONFIDENCE_BELOW_MIN'
  | 'VOLATILITY_TOO_HIGH' // one H1 bar is wider than the widest stop allowed
  | 'RR_BELOW_MIN';      // actual R:R below threshold

export interface Prev4hRangePlan {
  direction: 'LONG' | 'SHORT';
  state: Prev4hRangeState;
  reasonCode: Prev4hRangeReason;
  /** Start of the 4H window we are trading in. Dedupe key with the symbol. */
  windowStart: number;
  /** End of that window — the time stop. */
  windowEnd: number;
  prevHigh: number;
  prevLow: number;
  mid: number;
  range: number;
  rangePct: number;
  ema: number;
  emaPrev: number;
  entryRef: number;
  stopLoss: number;
  takeProfit: number;
  riskPerUnit: number;
  /** TP1 — the shared 3% level; half the position closes here. Same value as
   *  `takeProfit`, kept under both names because the order generator and the
   *  exit loop each read the one that matches their own vocabulary. */
  takeProfit1: number;
  /** TP2 — the shared 4.5% level the half left after TP1 runs to. */
  takeProfit2: number;
  /** True when the range midpoint would have risked more than MAX_LOSS_PERCENT
   *  and the shared cap pulled the stop in. Telemetry for the panel. */
  stopCapped: boolean;
  /** Where a LIMIT entry rests when the operator has limit entries on. A
   *  discount below market (above, for a short), floored just past the broken
   *  prev-4H level. Equals entryRef only when the breakout is too fresh to
   *  leave room. Market-mode entries ignore it. */
  limitEntryPrice: number;
  actualRR: number;
  confidence: number;
  components: { breakout: number; trend: number; range: number };
}

// ── Evaluation ─────────────────────────────────────────────────────────────

export interface Prev4hRangeInput {
  symbol: string;
  h1: Candle[];
  currentPrice: number;
  priceChange24h?: number;
  now?: number;
  params?: Partial<Prev4hRangeParams>;
  /** Deterministic Dynamic Volatility Profile store (sim only, see
   *  server/volatilityProfileStore.ts). Market is derived from direction —
   *  this bot routes LONG to SPOT, SHORT to FUTURES(1x), same as its order
   *  generator. Absent = the ladders below run unchanged. */
  volatilityProfiles?: Map<string, VolatilityProfile>;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function evaluatePrev4hRange(input: Prev4hRangeInput): SignalEvaluation {
  const p: Prev4hRangeParams = { ...DEFAULT_PREV4H_RANGE_PARAMS, ...(input.params ?? {}) };
  const { symbol, h1, currentPrice } = input;
  const now = input.now ?? Date.now();
  const priceChange24h = input.priceChange24h ?? 0;

  const base = (
    state: Prev4hRangeState,
    reason: Prev4hRangeReason,
    factors: DecisionFactor[] = [],
    extra: Partial<SignalEvaluation> = {}
  ): SignalEvaluation => ({
    symbol,
    action: 'hold',
    tradeType: 'HOLD',
    tradeSide: 'NONE',
    confidence: 0,
    price: currentPrice,
    priceChange24h,
    reasoning: `[${state}] ${reason}`,
    status: state === 'SIGNAL' ? 'SIGNAL' : `NO_SIGNAL [${reason}]`,
    willExecute: false,
    factors,
    confidenceGap: 0,
    ...extra
  });

  if (!h1 || h1.length < 4) {
    return base('NO_DATA', 'NO_DATA', [{
      label: 'נתונים', value: `H1 ${h1?.length ?? 0}/4`, impact: 'neutral', note: 'אין מינימום של 4 נרות H1'
    }]);
  }

  const h4 = aggregateToH4(h1);
  const minH4Required = Math.min(p.minH4Bars, Math.max(1, Math.floor(h1.length / 4)));
  // Fallback: if h1 is short (e.g. 16 candles after restart), use 1 H4 bar.
  // Confidence will be lower due to limited history, but prevents multi-day freeze.
  if (h4.length < minH4Required) {
    return base('NO_DATA', 'NO_DATA', [{
      label: 'נתונים', value: `H4 ${h4.length}/${minH4Required}`, impact: 'neutral', note: 'אין מספיק נרות 4H'
    }]);
  }

  const prev = h4[h4.length - 1]; // last FULLY-CLOSED 4H bar
  const windowStart = prev.timestamp + BAR_MS;
  const windowEnd = windowStart + BAR_MS;

  // We must be inside the window that immediately follows `prev`.
  if (barOpenFor(now) !== windowStart) {
    return base('NO_SIGNAL', 'STALE_BAR', [{
      label: 'חלון', value: `נר קודם נסגר ${new Date(prev.timestamp).toISOString()}`, impact: 'neutral',
      note: 'נתוני H1 לא עדכניים לחלון הנוכחי'
    }]);
  }

  const H = prev.high;
  const L = prev.low;
  const mid = (H + L) / 2;
  const range = H - L;
  const rangePct = prev.close > 0 ? range / prev.close : 0;
  const bandPos = (rangePct - p.minRangePct) / Math.max(1e-9, p.maxRangePct - p.minRangePct);

  const emaSeries = calculateEMA(h4.map((c) => c.close), p.emaPeriod);
  const ema = emaSeries[emaSeries.length - 1] ?? prev.close;
  const emaPrev = emaSeries[emaSeries.length - 2] ?? ema;
  const trendUp = ema > emaPrev && prev.close > ema;
  const trendDown = ema < emaPrev && prev.close < ema;

  const debug: DecisionFactor[] = [
    { label: 'נר 4H קודם', value: `H ${H} · L ${L} · טווח ${range.toFixed(6)} (${(rangePct * 100).toFixed(2)}%)`, impact: 'neutral', note: '' },
    { label: 'מגמת EMA20 (4H)', value: trendUp ? 'עולה' : trendDown ? 'יורדת' : 'שטוחה', impact: 'neutral', note: `EMA ${ema.toFixed(6)} (קודם ${emaPrev.toFixed(6)})` },
    { label: 'מחיר', value: `${currentPrice}`, impact: 'neutral', note: currentPrice > H ? 'מעל הגבוה' : currentPrice < L ? 'מתחת לנמוך' : 'בתוך הטווח' }
  ];

  if (!trendUp && !trendDown) {
    return base('NO_SIGNAL', 'AGAINST_TREND', debug);
  }
  if (rangePct < p.minRangePct) return base('NO_SIGNAL', 'RANGE_TOO_TIGHT', debug);
  if (rangePct > p.maxRangePct) return base('NO_SIGNAL', 'RANGE_TOO_WIDE', debug);

  let direction: 'LONG' | 'SHORT' | null = null;
  if (trendUp && currentPrice > H) direction = 'LONG';
  else if (trendDown && currentPrice < L) direction = 'SHORT';

  if (!direction) {
    return base('ARMED', 'NO_BREAKOUT', debug);
  }

  const isLong = direction === 'LONG';
  const structuralStop = mid;

  const breakoutDist = isLong ? currentPrice - H : L - currentPrice;
  // One admissible band, shared with the confidence score below. Previously
  // this used maxExtensionRangeMult (0.5) directly and the RR check further
  // down rejected everything past 0.1818 anyway — so ENTRY_TOO_EXTENDED could
  // only fire where RR_BELOW_MIN would have fired too, and the operator saw
  // whichever reason happened to come first in the file.
  const maxExtension = maxAdmissibleExtensionMult(p);
  if (breakoutDist > range * maxExtension) {
    return base('ARMED', 'ENTRY_TOO_EXTENDED', debug);
  }

  const entryRef = currentPrice;
  // Floored just past the level that was broken (H for a long, L for a short):
  // resting below H would be buying back INSIDE the range, which is no longer
  // the breakout this bot decided to take.
  const limitEntryPrice = breakoutLimitPrice(
    entryRef, isLong, p.entryLimitOffsetRangeMult * range, isLong ? H : L, 0.02 * range
  );
  // The range midpoint is this strategy's own stop and stays the stop whenever
  // it risks 4.2% or less. When the entry sits far enough above H that half the
  // range is a bigger loss than that, the shared cap pulls it in (operator
  // decision 2026-09-08) — the cap only ever REDUCES risk.
  let stopLoss = capStopLoss(entryRef, structuralStop, isLong);
  const stopCapped = stopWasCapped(entryRef, structuralStop, isLong);
  // TP1 = max(range-midpoint target, the shared floor). The floor is
  // tp1FloorDistance = max(1.5% of entry, 1.5× the stop) — not a flat 3%,
  // which a narrow prev-4H range can never reach in one 4H window. The `minRR`
  // gate below is still the hard reward:risk backstop.
  const rUnit = Math.abs(entryRef - stopLoss);
  const minTp1Distance = tp1FloorDistance(entryRef, rUnit);
  const dynamicTp1Distance = rUnit * p.tpRangeMult;
  let tp1Distance = Math.max(dynamicTp1Distance, minTp1Distance);
  let takeProfit2Distance = tp1Distance * 1.5;

  // Fixed scalp ladder (opt-in, sim only — operator decision 2026-09-11):
  // SL 2.3% / TP1 1.8% / TP2 3.5% replaces the range-derived ladder outright.
  // The ONE exception is a BUYING SURGE, where the stop widens to this bot's
  // own `mid`-derived stop clamped to [2.3%, 4.2%]. TP1 stays 1.8% regardless,
  // so its own R:R is deliberately poor and the `minRR` gate below is measured
  // against TP2 — which scales with the stop so the gate stays satisfiable.
  const dynSlPct = (rUnit / entryRef) * 100;

  // Deterministic Dynamic Volatility Profile ladder (2026-09-16, sim only,
  // highest precedence of the three). LONG routes SPOT, SHORT routes
  // FUTURES(1x) — same routing this bot's order generator already uses.
  const volatilityMarket: VolatilityMarket = isLong ? 'spot' : 'linear';
  const lastClosedH1 = h1.length ? h1[h1.length - 1] : undefined;
  const volatilityLadder = input.volatilityProfiles
    ? resolveVolatilityLadder({
        profiles: input.volatilityProfiles,
        market: volatilityMarket,
        symbol,
        side: direction,
        lastClosedH1
      })
    : null;
  if (volatilityLadder) {
    // Same MAX_LOSS_PERCENT ceiling every other ladder respects.
    const stopPct = Math.min(MAX_LOSS_PERCENT, volatilityLadder.stopPct);
    const slDistance = entryRef * stopPct / 100;
    stopLoss = isLong ? entryRef - slDistance : entryRef + slDistance;
    tp1Distance = entryRef * volatilityLadder.targetPct / 100;
    takeProfit2Distance = tp1Distance * 1.5;
  }

  const calmActive = !volatilityLadder && p.calmRegimeScalp === true;
  if (calmActive) {
    // Second widening condition alongside the surge: the stop must clear one H1
    // bar's own range — this bot holds across hours, so an hourly bar is the
    // noise it has to sit outside of. An expanding tape overrides the average.
    const noise = p.noiseFloorStop === true ? measureStopNoise(h1) : undefined;
    const ladder = resolveLadderPercents({
      dynamicSlPct: dynSlPct,
      buyingSurge: isBuyingSurge(h1),
      noiseFloorPct: noise?.floorPct
    });
    if (ladder.tooVolatile) {
      return base('ARMED', 'VOLATILITY_TOO_HIGH', [
        ...debug,
        {
          label: 'תנודתיות',
          value: `נר גרוע H1 ${(noise?.badBarPercent ?? 0).toFixed(2)}% (ATR ${(noise?.atrPercent ?? 0).toFixed(2)}%)`,
          impact: 'negative',
          note: `סטופ מינימלי ${ladder.noiseFloorPct.toFixed(2)}% חורג מהתקרה — נר רגיל היה מוציא את הפוזיציה`
        }
      ], { confidence: 0 });
    }
    const slDistance = entryRef * ladder.slPct / 100;
    stopLoss = isLong ? entryRef - slDistance : entryRef + slDistance;
    tp1Distance = entryRef * ladder.tp1Pct / 100;
    takeProfit2Distance = entryRef * ladder.tp2Pct / 100;
  }

  const riskPerUnit = Math.abs(entryRef - stopLoss);

  // RISK_VS_COST gate — the stop actually being traded must clear the
  // modelled round trip by costSafetyMultiplier. Cost comes from the shared
  // model, not a local literal; baseSlippagePercent 0.1 = the sim's actual
  // per-leg market-fill slippage (this bot fills market) — kept equal to
  // DEFAULT_SLIPPAGE_PERCENT/SIM_BASE_DEFAULTS.slippagePercent (Bybit Spot
  // VIP 0, updated 2026-09-16) so the gate rejects on the SAME cost the sim
  // will actually charge, not a stale assumption about it.
  //
  // Moved here 2026-09-14 (was evaluated on `structuralStop`/`mid`, BEFORE the
  // ladder above could override it): the fixed ladder's floor is 2.3%
  // (FIXED_SL_PCT, never tighter — see calmRegime.ts), comfortably above any
  // realistic round-trip cost, but a narrow prev-4H range's own structural
  // stop can be a fraction of a percent. Checking the OLD number rejected
  // exactly the tight-range setups this bot's own confidence score treats as
  // BEST ("מגע נקי + טווח צר = ביטחון גבוה") on a stop that would never
  // actually be traded once the ladder replaced it — the same "gate checks a
  // number the ladder already overrode" shape as the Intraday COST bug fixed
  // the same day (see BOTS_REFERENCE.md §1 "COST").
  const stopDistancePct = (riskPerUnit / entryRef) * 100;
  const estimatedRoundTripCost = estimatedRoundTripCostPct({
    tradeType: isLong ? 'SPOT' : 'FUTURES', entryIsLimit: false, baseSlippagePercent: 0.1
  });
  if (stopDistancePct < p.costSafetyMultiplier * estimatedRoundTripCost) {
    return base('ARMED', 'RISK_VS_COST', debug, { confidence: 0 });
  }

  const takeProfit1 = isLong ? entryRef + tp1Distance : entryRef - tp1Distance;
  const takeProfit2 = isLong ? entryRef + takeProfit2Distance : entryRef - takeProfit2Distance;
  const takeProfit = takeProfit1;
  const tpCapped = false;

  // Reward:risk backstop — a wide range (mid-stop far from entry) can make even
  // the 3% TP floor a sub-1.2 R:R. Kept as the one hard reward-side gate; the
  // frequency work elsewhere never touches this number. In the calm branch the
  // gate is measured against TP2 (the runner), not the fast TP1 partial.
  const actualRR = riskPerUnit > 0
    ? Math.abs(((calmActive || volatilityLadder) ? takeProfit2 : takeProfit1) - entryRef) / riskPerUnit
    : 0;
  if (actualRR < p.minRR) {
    return base('ARMED', 'RR_BELOW_MIN', debug, { confidence: 0 });
  }

  // rangeScore: prefer a TIGHT reference range (down to the minRangePct floor).
  // A tight 4H range → a tight `mid` stop → a TP1 that is actually reachable
  // inside the one 4H window this bot trades. The old peak at bandPos 0.4 (~3.9%
  // range → ~1.9% stop → ~2.9% TP1) rewarded the setups whose target never
  // prints in-window. minRangePct already hard-rejects genuine noise below it.
  const rangeScore = clamp01(1 - bandPos) * 10;
  // breakout: reward a CLEAN touch of H/L, not an extended entry. A larger
  // breakoutDist means (a) a wider `mid` stop — more dollar risk, (b) the move
  // is mostly made — less follow-through, (c) more likely to mean-revert. The
  // old formula scored a clean touch 0 and a stretched entry 30, so — since
  // order priority is confidence-descending under limited slots/cash, and 40 +
  // this can sit right at the 55 floor — the bot filled its WORST admissible
  // setups first and could reject the clean ones outright. ENTRY_TOO_EXTENDED
  // (breakoutDist > range·maxExtension) stays the hard cap.
  const breakout = clamp01(1 - breakoutDist / (range * maxExtension)) * 30;
  const trendStrength = clamp01(Math.abs(ema - emaPrev) / (emaPrev * 0.01)) * 20;
  const confidence = Math.round(40 + breakout + trendStrength + Math.max(0, rangeScore));

  const plan: Prev4hRangePlan = {
    direction,
    state: confidence >= p.minConfidence ? 'SIGNAL' : 'ARMED',
    reasonCode: confidence >= p.minConfidence ? 'OK' : 'CONFIDENCE_BELOW_MIN',
    windowStart,
    windowEnd,
    prevHigh: H,
    prevLow: L,
    mid,
    range,
    rangePct,
    ema,
    emaPrev,
    entryRef,
    stopLoss,
    takeProfit,
    riskPerUnit,
    takeProfit1,
    takeProfit2,
    stopCapped,
    limitEntryPrice,
    confidence,
    actualRR,
    components: { breakout, trend: trendStrength, range: Math.max(0, rangeScore) }
  };

  const factors: DecisionFactor[] = [
    ...debug,
    { label: 'ציון ביטחון', value: `${confidence}/100 (סף ${p.minConfidence})`, impact: confidence >= p.minConfidence ? 'positive' : 'neutral',
      note: `פריצה ${plan.components.breakout.toFixed(0)} · מגמה ${plan.components.trend.toFixed(0)} · טווח ${plan.components.range.toFixed(0)} · RR ${actualRR.toFixed(2)} (סף ${p.minRR})` }
  ];

  if (confidence < p.minConfidence) {
    const ev = base('ARMED', 'CONFIDENCE_BELOW_MIN', factors, { confidence });
    (ev as { prev4hRange?: Prev4hRangePlan }).prev4hRange = plan;
    ev.decision = plan as unknown as SignalEvaluation['decision'];
    return ev;
  }

  const ev: SignalEvaluation = {
    symbol,
    action: isLong ? 'buy' : 'sell',
    tradeType: isLong ? 'SPOT' : 'FUTURES', // SHORT can only be simulated as 1x futures
    tradeSide: direction,
    confidence,
    price: currentPrice,
    priceChange24h,
    reasoning: `[SIGNAL] פריצת ${isLong ? 'הגבוה' : 'הנמוך'} של נר ה-4H הקודם (${isLong ? H : L}) בכיוון מגמת EMA20 · SL ${stopLoss.toFixed(6)} (${stopCapped ? `תקרת ${MAX_LOSS_PERCENT}%` : 'אמצע הטווח'}) · TP1 ${takeProfit1.toFixed(6)} (50%${tpCapped ? `, תקרת ${TP1_PERCENT}%` : ''}) · TP2 ${takeProfit2.toFixed(6)} · יציאה בסוף הנר`,
    status: `SIGNAL ${isLong ? 'SPOT LONG' : 'FUTURES SHORT'}`,
    willExecute: true,
    factors,
    confidenceGap: confidence - p.minConfidence,
    leverage: 1,
    stopLoss,
    takeProfit,
    takeProfit1,
    takeProfit2
  };
  (ev as { prev4hRange?: Prev4hRangePlan }).prev4hRange = plan;
  ev.decision = plan as unknown as SignalEvaluation['decision'];
  return ev;
}

export function readPrev4hRangePlan(ev: SignalEvaluation | undefined): Prev4hRangePlan | undefined {
  if (!ev) return undefined;
  const tagged = (ev as { prev4hRange?: Prev4hRangePlan }).prev4hRange;
  if (tagged) return tagged;
  const viaDecision = ev.decision as unknown as Prev4hRangePlan | undefined;
  return viaDecision && typeof viaDecision === 'object' && 'direction' in viaDecision && 'windowStart' in viaDecision
    ? viaDecision
    : undefined;
}
