// TrendBreakout — an independent multi-timeframe trend-following breakout
// strategy. It is NOT a consensus of Intraday / Pro / Path and shares none of
// their signal logic; it only shares this project's market-data layer,
// indicator primitives, execution cost model and simulation plumbing.
//
// Simulation only. Nothing here sends a real order.
//
// Flow (see TRENDBREAKOUT_SPEC.md — the user's spec — §1-§13):
//   H1 defines the trend (Supertrend + EMA50/EMA200).
//   M15 defines the breakout (Donchian(20) + volume confirmation).
//   M5 times the entry (EMA9/EMA21 alignment + price still near the breakout).
// Every decision is taken on CLOSED candles only — the caller passes candle
// series that already exclude the forming bar, and nothing here reads a future
// bar, high, low, volume or indicator value.

import {
  Candle,
  calculateATR,
  calculateEMA,
  calculateSupertrend,
  breakoutLimitPrice
} from './tradeEngine';
import type { SignalEvaluation, DecisionFactor } from './intradayBridge';
import { POSITION_TARGET_PCT } from './intradayParams';
import { capStopLoss, stopWasCapped, tp1FloorDistance, MAX_LOSS_PERCENT } from './exitPolicy';
import { resolveLadderPercents, isBuyingSurge, measureStopNoise } from './calmRegime';
import type { MarketRegimeResult } from '../types/crypto';
import { resolveVolatilityLadder } from './volatilityProfile';
import type { VolatilityMarket, VolatilityProfile, VolatilitySide } from '../types/volatilityProfile';

// ── Parameters (spec §23 — every knob configurable, no auto-optimisation) ────

export interface TrendBreakoutParams {
  /** H1 Supertrend. */
  supertrendAtrPeriod: number;
  supertrendMultiplier: number;
  /** Donchian channel period (M15 breakout, H1 context). */
  donchianPeriod: number;
  /** ATR period on every timeframe. */
  atrPeriod: number;
  /** M15 breakout volume must be >= volumeSMA20 * this. */
  volumeMultiplier: number;
  /** Confidence score (0-100) required to open. A SCORE, not a probability. */
  minConfidence: number;
  /** SL distance = ATR(M15) * this. */
  slAtrMultiplier: number;
  /** TP distance = R * this (R = |entry - SL|). */
  tpRMultiplier: number;
  /** Minimum gross reward:risk on the FINAL levels (|TP1-entry| / |entry-SL|).
   *  A backstop, not the driver: the TP formula (max(R×tpRMultiplier, 3%))
   *  already keeps this >= tpRMultiplier. If a future edit inverts the levels
   *  the SIGNAL is refused with RR_TOO_LOW instead of opening. Matches the
   *  minRewardRisk gate the other three sim bots carry. */
  minRewardRisk: number;
  /** Opt-in (default off — sim only, see server/bybitSimEngine.ts). Replaces the
   *  ATR-derived ladder with a FIXED SL 2.3% / TP1 1.8% / TP2 3.5% one, always.
   *  Only on a buying surge (M15 relVolume >= 2 and a green bar) does the stop
   *  widen back to the ATR-derived value, clamped to [2.3%, 4.2%].
   *  See calmRegime.ts. */
  calmRegimeScalp?: boolean;
  /** Opt-in (default off — sim only). Only meaningful with `calmRegimeScalp`.
   *  A SECOND condition that widens the flat 2.3%: the stop must clear 1.6 ×
   *  one M15 bar's ATR, so an ordinary candle cannot take out a thesis that
   *  never failed. Refuses the trade outright when even the ceiling sits inside
   *  that noise (VOLATILITY_TOO_HIGH). See calmRegime.ts. */
  noiseFloorStop?: boolean;
  /** Target notional as a fraction of equity (e.g. 0.10 = 10%).
   *  Single source of truth for position sizing. Stop-loss distance does NOT
   *  affect notional — it only determines the resulting dollar risk. */
  positionTargetPct: number;
  /** Move stop to break-even once the trade is this many R in profit. */
  breakEvenR: number;
  /** Begin ATR trailing once the trade is this many R in profit. */
  trailingStartR: number;
  /** Trailing distance = ATR(M15) * this. */
  trailingAtrMultiplier: number;
  /** Time stop: close after this many H1 bars. */
  maxHoldHours: number;
  /** Scale-in lot fractions of the full position (spec §11). */
  scaleFractions: number[];
  /** Resting-limit discount from market, in ATR(M5) units — the same knob shape
   *  as the intraday bot's entryLimitOffsetAtr (0.15). Only read when the
   *  operator has limit entries on. */
  entryLimitOffsetAtrMult: number;
  /** SCALE_2 allowed only at >= this many R. */
  scale2MinR: number;
  /** SCALE_3 allowed only at >= this many R. */
  scale3MinR: number;
  /** EMA periods. */
  h1EmaFast: number;
  h1EmaSlow: number;
  m15EmaFast: number;
  m15EmaSlow: number;
  m5EmaFast: number;
  m5EmaSlow: number;
  /** Minimum closed candles per timeframe. */
  minH1: number;
  minM15: number;
  minM5: number;
  /** Confidence sub-score shaping (see computeConfidence). */
  emaTrendFullSpread: number;
  breakoutFullAtr: number;
  volumeFullMultiplier: number;
  m5MaxAtrDistance: number;
}

export const DEFAULT_TREND_BREAKOUT_PARAMS: TrendBreakoutParams = {
  supertrendAtrPeriod: 10,
  supertrendMultiplier: 3.0,
  donchianPeriod: 20,
  atrPeriod: 14,
  volumeMultiplier: 1.2,
  minConfidence: 70,
  // Widened 1.5 → 2.8 (operator decision 2026-09-08): the stop now stretches
  // TOWARD the shared 4.2% cap in normal volatility instead of sitting at ~1%,
  // and stop exits confirm on the M15 close (see trendBreakoutExecution.ts).
  slAtrMultiplier: 2.8,
  tpRMultiplier: 2.0,
  // Same floor the other three sim bots use (intraday buildRiskPlan,
  // prev4hRange). With tpRMultiplier 2.0 the real R:R never drops here — this
  // only bites if the TP formula is later changed to invert the levels.
  minRewardRisk: 1.2,
  positionTargetPct: POSITION_TARGET_PCT,
  breakEvenR: 1.0,
  trailingStartR: 1.5,
  // 1.0 → 1.5: keep the runner in the trade long enough to reach TP2 instead
  // of trailing out on the first pullback after TP1.
  trailingAtrMultiplier: 1.5,
  maxHoldHours: 24,
  scaleFractions: [0.5, 0.3, 0.2],
  // Spec §11 has these at +0.5R / +1.0R. Moved to +1.0R / +1.5R (= breakEvenR /
  // trailingStartR) 2026-09-09: adding 60% more size at +0.5R — before the stop
  // has even reached break-even — meant a normal breakout retest turned a small
  // winner into a loss larger than a clean −1R stop-out. Now a scale-in only
  // lands once the trade has locked break-even (SCALE_2) or armed the trail
  // (SCALE_3), and effectiveStop pulls the shared stop up so no lot risks >1R.
  scale2MinR: 1.0,
  scale3MinR: 1.5,
  h1EmaFast: 50,
  h1EmaSlow: 200,
  m15EmaFast: 20,
  m15EmaSlow: 50,
  m5EmaFast: 9,
  m5EmaSlow: 21,
  entryLimitOffsetAtrMult: 0.15,
  minH1: 200,
  minM15: 300,
  minM5: 30,
  emaTrendFullSpread: 0.02,
  breakoutFullAtr: 1.0,
  volumeFullMultiplier: 1.5,
  // Was 1.0 — the sharpest breakouts (price already >1 ATR(M5) past the level
  // by the time the M5 confirms) were dropped as ENTRY_TOO_EXTENDED, which is
  // often the best part of the move. 1.5 keeps them; the confidence M5
  // component still scales down with distance.
  m5MaxAtrDistance: 1.5
};

// ── State machine (spec §6) ─────────────────────────────────────────────────

export type TrendBreakoutState =
  | 'NO_DATA'
  | 'NO_SIGNAL'
  | 'TREND_DETECTED'
  | 'SETUP'
  | 'ENTRY_CONFIRMATION'
  | 'SIGNAL';

/** Every no-trade path names itself (spec §22). */
export type TrendBreakoutReason =
  | 'OK'
  | 'NO_DATA'
  | 'H1_TREND_NEUTRAL'
  | 'BREAKOUT_NOT_CONFIRMED'
  | 'VOLUME_TOO_LOW'
  | 'M5_CONFIRMATION_FAILED'
  | 'ENTRY_TOO_EXTENDED'
  | 'RR_TOO_LOW'
  /** One M15 bar is wider than the widest stop this ladder allows — any stop
   *  would be a coin flip on noise alone. See calmRegime's noise floor. */
  | 'VOLATILITY_TOO_HIGH'
  | 'CONFIDENCE_BELOW_MIN';

export type TrendDirection = 'LONG' | 'SHORT' | 'NEUTRAL';

/** The exact levels the execution layer trades on. Stashed on
 *  SignalEvaluation.decision (cast) the same way the Path bot stashes its
 *  bucket — no shared type change. */
export interface TrendBreakoutPlan {
  direction: 'LONG' | 'SHORT';
  state: TrendBreakoutState;
  reasonCode: TrendBreakoutReason;
  breakoutPrice: number;
  entryRef: number;
  atrH1: number;
  atrM15: number;
  atrM5: number;
  supertrendH1: 'BULL' | 'BEAR';
  supertrendValueH1: number;
  ema50H1: number;
  ema200H1: number;
  donchianHighM15: number;
  donchianLowM15: number;
  volumeRatioM15: number;
  ema9M5: number;
  ema21M5: number;
  stopLoss: number;
  takeProfit: number;
  /** R in price units: |entryRef - stopLoss|. */
  riskPerUnit: number;
  /** TP1 — the shared 3% level; half the position closes here. */
  takeProfit1: number;
  /** TP2 — the shared 4.5% level the remaining half runs to. */
  takeProfit2: number;
  /** True when slAtrMultiplier×ATR would have risked more than MAX_LOSS_PERCENT
   *  and the shared cap pulled the stop in. Telemetry for the panel. */
  stopCapped: boolean;
  /** Where a LIMIT entry rests when the operator has limit entries on. A
   *  discount below market (above, for a short), floored just past the broken
   *  Donchian level. Equals entryRef only when the breakout is too fresh to
   *  leave room. Market-mode entries ignore it. */
  limitEntryPrice: number;
  confidence: number;
  components: { supertrend: number; emaTrend: number; breakout: number; volume: number; m5: number };
}

// ── Small pure indicator helpers (no existing equivalent) ───────────────────

/** Highest high / lowest low over the last `period` candles. */
export function donchian(candles: Candle[], period: number): { upper: number; lower: number } {
  const slice = candles.slice(-period);
  let upper = -Infinity;
  let lower = Infinity;
  for (const c of slice) {
    if (c.high > upper) upper = c.high;
    if (c.low < lower) lower = c.low;
  }
  return { upper, lower };
}

/** Mean volume over the last `period` candles. */
export function volumeSMA(candles: Candle[], period: number): number {
  const slice = candles.slice(-period);
  if (!slice.length) return 0;
  return slice.reduce((s, c) => s + (c.volume || 0), 0) / slice.length;
}

function emaLast(closes: number[], period: number): number {
  const series = calculateEMA(closes, period);
  return series.length ? series[series.length - 1] : (closes.length ? closes[closes.length - 1] : 0);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Every evaluation left `regime` unset (the SIGNAL path even set it to
 * `undefined` explicitly), so the UI's regime-distribution panel counted
 * every TrendBreakout evaluation as "no data" and always showed 0/0/0/0 —
 * cosmetic only, `willExecute`/trading decisions never read this field.
 * This strategy has no separate RANGING detector (unlike tradeEngine's
 * detectMarketRegime), so NEUTRAL — H1 Supertrend/EMA50/EMA200 disagree —
 * maps to TRANSITIONAL rather than a fabricated RANGING classification.
 */
function toMarketRegimeResult(
  direction: TrendDirection,
  st: { value: number; direction: 'BULL' | 'BEAR' },
  atrH1: number,
  currentPrice: number
): MarketRegimeResult {
  return {
    regime: direction === 'NEUTRAL' ? 'TRANSITIONAL' : 'TRENDING',
    direction: direction === 'LONG' ? 'BULL' : direction === 'SHORT' ? 'BEAR' : 'NEUTRAL',
    volatility: 'NORMAL',
    adx: 0,
    atr: atrH1,
    atrPercent: currentPrice > 0 ? (atrH1 / currentPrice) * 100 : 0,
    supertrend: st
  };
}

// ── Evaluation ─────────────────────────────────────────────────────────────

export interface TrendBreakoutInput {
  symbol: string;
  h1: Candle[];
  m15: Candle[];
  m5: Candle[];
  currentPrice: number;
  priceChange24h?: number;
  params?: Partial<TrendBreakoutParams>;
  /** Deterministic Dynamic Volatility Profile store (sim only, see
   *  server/volatilityProfileStore.ts). This bot trades FUTURES only
   *  (perpetuals, 1x) — market is always 'linear'. Absent = the ladders
   *  below run unchanged. */
  volatilityProfiles?: Map<string, VolatilityProfile>;
}

/**
 * One symbol → one SignalEvaluation. `willExecute` is true only in the SIGNAL
 * state (every §3-§7 condition met and confidence >= minConfidence).
 */
export function evaluateTrendBreakout(input: TrendBreakoutInput): SignalEvaluation {
  const p: TrendBreakoutParams = { ...DEFAULT_TREND_BREAKOUT_PARAMS, ...(input.params ?? {}) };
  const { symbol, h1, m15, m5, currentPrice } = input;
  const priceChange24h = input.priceChange24h ?? 0;

  const base = (state: TrendBreakoutState, reason: TrendBreakoutReason, extra: Partial<SignalEvaluation> = {}, factors: DecisionFactor[] = []): SignalEvaluation => ({
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

  // ── §1 data sufficiency ──────────────────────────────────────────────────
  if (h1.length < p.minH1 || m15.length < p.minM15 || m5.length < p.minM5) {
    return base('NO_DATA', 'NO_DATA', {}, [{
      label: 'נתונים',
      value: `H1 ${h1.length}/${p.minH1} · M15 ${m15.length}/${p.minM15} · M5 ${m5.length}/${p.minM5}`,
      impact: 'neutral',
      note: 'אין מספיק נרות סגורים לחישוב'
    }]);
  }

  // ── §2 indicators (closed candles only) ─────────────────────────────────
  const h1Closes = h1.map((c) => c.close);
  const atrH1 = calculateATR(h1, p.atrPeriod).atr;
  const st = calculateSupertrend(h1, p.supertrendAtrPeriod, p.supertrendMultiplier);
  const ema50 = emaLast(h1Closes, p.h1EmaFast);
  const ema200 = emaLast(h1Closes, p.h1EmaSlow);
  const h1Close = h1Closes[h1Closes.length - 1];

  const m15Closes = m15.map((c) => c.close);
  const atrM15 = calculateATR(m15, p.atrPeriod).atr;
  // "previous" Donchian (spec §4) — exclude the breakout candle itself.
  const donch = donchian(m15.slice(0, -1), p.donchianPeriod);
  const volSma = volumeSMA(m15.slice(0, -1), p.donchianPeriod);
  const m15Last = m15[m15.length - 1];
  const volRatio = volSma > 0 ? (m15Last.volume || 0) / volSma : 0;
  const ema20M15 = emaLast(m15Closes, p.m15EmaFast);
  const ema50M15 = emaLast(m15Closes, p.m15EmaSlow);

  const m5Closes = m5.map((c) => c.close);
  const atrM5 = calculateATR(m5, p.atrPeriod).atr;
  const ema9 = emaLast(m5Closes, p.m5EmaFast);
  const ema21 = emaLast(m5Closes, p.m5EmaSlow);
  const m5Close = m5Closes[m5Closes.length - 1];

  const debugFactors: DecisionFactor[] = [
    { label: 'H1 Supertrend', value: `${st.direction} @ ${st.value}`, impact: 'neutral', note: `ATR(H1)=${atrH1.toFixed(6)}` },
    { label: 'H1 EMA', value: `EMA50=${ema50.toFixed(6)} EMA200=${ema200.toFixed(6)} close=${h1Close.toFixed(6)}`, impact: 'neutral', note: '' },
    { label: 'M15 Donchian', value: `high=${donch.upper.toFixed(6)} low=${donch.lower.toFixed(6)}`, impact: 'neutral', note: `M15 close=${m15Last.close.toFixed(6)}` },
    { label: 'M15 volume', value: `x${volRatio.toFixed(2)} (סף x${p.volumeMultiplier})`, impact: 'neutral', note: `SMA20=${volSma.toFixed(2)}` },
    { label: 'M15 EMA', value: `EMA20=${ema20M15.toFixed(6)} EMA50=${ema50M15.toFixed(6)}`, impact: 'neutral', note: 'הקשר בלבד' },
    { label: 'M5 EMA', value: `EMA9=${ema9.toFixed(6)} EMA21=${ema21.toFixed(6)} close=${m5Close.toFixed(6)}`, impact: 'neutral', note: `ATR(M5)=${atrM5.toFixed(6)}` }
  ];

  // ── §3 trend ───────────────────────────────────────────────────────────
  let direction: TrendDirection = 'NEUTRAL';
  if (st.direction === 'BULL' && ema50 > ema200 && h1Close > ema50) direction = 'LONG';
  else if (st.direction === 'BEAR' && ema50 < ema200 && h1Close < ema50) direction = 'SHORT';

  const regimeResult = toMarketRegimeResult(direction, st, atrH1, currentPrice);

  if (direction === 'NEUTRAL') {
    return base('NO_SIGNAL', 'H1_TREND_NEUTRAL', { regime: regimeResult }, debugFactors);
  }

  const isLong = direction === 'LONG';

  // ── §4 breakout ────────────────────────────────────────────────────────
  const brokeLevel = isLong ? donch.upper : donch.lower;
  const priceBroke = isLong ? m15Last.close > donch.upper : m15Last.close < donch.lower;
  const volumeOk = volRatio >= p.volumeMultiplier;

  if (!priceBroke) {
    return base('TREND_DETECTED', 'BREAKOUT_NOT_CONFIRMED', { regime: regimeResult }, debugFactors);
  }
  if (!volumeOk) {
    return base('TREND_DETECTED', 'VOLUME_TOO_LOW', { regime: regimeResult }, debugFactors);
  }

  const breakoutPrice = m15Last.close;

  // ── §5 M5 entry confirmation ───────────────────────────────────────────
  const m5Aligned = isLong
    ? ema9 > ema21 && m5Close > ema9
    : ema9 < ema21 && m5Close < ema9;
  if (!m5Aligned) {
    return base('SETUP', 'M5_CONFIRMATION_FAILED', { regime: regimeResult }, debugFactors);
  }
  const distanceFromBreakout = Math.abs(currentPrice - breakoutPrice);
  if (distanceFromBreakout > p.m5MaxAtrDistance * atrM5) {
    // Price already ran away — do not chase.
    return base('SETUP', 'ENTRY_TOO_EXTENDED', { regime: regimeResult }, debugFactors);
  }

  // ── §9/§10 levels ──────────────────────────────────────────────────────
  const entryRef = currentPrice;
  const limitEntryPrice = breakoutLimitPrice(
    entryRef, isLong, p.entryLimitOffsetAtrMult * atrM5, brokeLevel, 0.02 * atrM5
  );
  // The ATR stop is this strategy's own and stays the stop whenever it risks
  // 4.2% or less. A wide-ATR symbol whose slAtrMultiplier×ATR(M15) would have
  // risked more gets pulled in by the shared cap (operator decision
  // 2026-09-08); the cap only ever REDUCES risk, so a tight-ATR stop is
  // untouched.
  const rUnit = p.slAtrMultiplier * atrM15;
  const structuralStop = isLong ? entryRef - rUnit : entryRef + rUnit;
  let stopLoss = capStopLoss(entryRef, structuralStop, isLong);
  const stopCapped = stopWasCapped(entryRef, structuralStop, isLong);
  // TP1 = max(2R target, the shared floor). The floor is tp1FloorDistance =
  // max(1.5% of entry, 1.5× the capped stop) — not a flat 3%, which is
  // unreachable in-horizon on a low-ATR(M15) symbol. TP2 scales from TP1 by
  // 1.5x. Trailing still measures progress in R off the (capped) stop.
  //
  // "R" here is the ACTUAL (capped) stop distance, NOT the raw
  // slAtrMultiplier×ATR — so the "2R" target means the same R that break-even,
  // trailing and the scale-in triggers measure. On a capped-stop symbol the old
  // `rUnit × tpRMultiplier` put TP1 at ~2.4× the capped R: unreachable in the
  // 24-bar horizon while BE and the scale-ins had already fired in capped-R.
  const cappedR = Math.abs(entryRef - stopLoss);
  const minTp1Distance = tp1FloorDistance(entryRef, cappedR);
  const atrTp1Distance = cappedR * p.tpRMultiplier;
  let tp1Distance = Math.max(atrTp1Distance, minTp1Distance);
  let takeProfit2Distance = tp1Distance * 1.5;

  // Fixed scalp ladder (opt-in, sim only — operator decision 2026-09-11):
  // SL 2.3% / TP1 1.8% / TP2 3.5% replaces the ATR ladder outright. The ONE
  // exception is a BUYING SURGE, where the stop widens to this bot's own
  // ATR(M15)-derived stop clamped to [2.3%, 4.2%]. Measured on M15 — the frame
  // the breakout itself is confirmed on. TP1 stays 1.8% regardless, so its own
  // R:R is deliberately poor and the gate below is measured against TP2, which
  // scales with the stop so it stays satisfiable.
  const dynSlPct = (cappedR / entryRef) * 100;

  // Deterministic Dynamic Volatility Profile ladder (2026-09-16, sim only,
  // highest precedence of the three). FUTURES-only bot — market is always
  // 'linear'. Resolved and applied ONCE here, at signal time — the position
  // this opens into snapshots the resulting stop/TP distances, so the
  // trailing-stop math later in the trade's life reuses this frozen ladder
  // instead of recomputing a possibly-different one mid-trade.
  const volatilityMarket: VolatilityMarket = 'linear';
  const lastClosedH1 = h1.length ? h1[h1.length - 1] : undefined;
  const volatilityLadder = input.volatilityProfiles
    ? resolveVolatilityLadder({
        profiles: input.volatilityProfiles,
        market: volatilityMarket,
        symbol,
        side: direction as VolatilitySide,
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
    // Second widening condition alongside the surge: the stop must clear one
    // M15 bar's own range — the frame the breakout is confirmed on — or an
    // ordinary candle stops out a thesis that never failed. An expanding tape
    // overrides the lagging ATR, since the fresh bars are the ones ahead.
    const noise = p.noiseFloorStop === true ? measureStopNoise(m15, p.atrPeriod) : undefined;
    const ladder = resolveLadderPercents({
      dynamicSlPct: dynSlPct,
      buyingSurge: isBuyingSurge(m15),
      noiseFloorPct: noise?.floorPct
    });
    if (ladder.tooVolatile) {
      return base('SETUP', 'VOLATILITY_TOO_HIGH', { regime: regimeResult }, [
        ...debugFactors,
        {
          label: 'תנודתיות',
          value: `נר גרוע M15 ${(noise?.badBarPercent ?? 0).toFixed(2)}% (ATR ${(noise?.atrPercent ?? 0).toFixed(2)}%)`,
          impact: 'negative',
          note: `סטופ מינימלי ${ladder.noiseFloorPct.toFixed(2)}% חורג מהתקרה — נר רגיל היה מוציא את הפוזיציה`
        }
      ]);
    }
    const slDistance = entryRef * ladder.slPct / 100;
    stopLoss = isLong ? entryRef - slDistance : entryRef + slDistance;
    tp1Distance = entryRef * ladder.tp1Pct / 100;
    takeProfit2Distance = entryRef * ladder.tp2Pct / 100;
  }

  const takeProfit1 = isLong ? entryRef + tp1Distance : entryRef - tp1Distance;
  const takeProfit2 = isLong ? entryRef + takeProfit2Distance : entryRef - takeProfit2Distance;
  const takeProfit = takeProfit1;

  // R:R backstop (spec §10) — refuse an inverted trade before it can open, the
  // same gate intraday's buildRiskPlan and prev4hRange already enforce. The TP
  // formula above keeps grossRR >= tpRMultiplier, so this only fires if a
  // future edit breaks that; a named refusal beats a silent bad entry. In the
  // calm branch the gate is measured against TP2 (the runner), not TP1.
  const riskDistance = Math.abs(entryRef - stopLoss);
  const grossRewardRisk = riskDistance > 0
    ? Math.abs(((calmActive || volatilityLadder) ? takeProfit2 : takeProfit1) - entryRef) / riskDistance
    : 0;
  if (grossRewardRisk < p.minRewardRisk) {
    return base('SETUP', 'RR_TOO_LOW', { regime: regimeResult }, [
      ...debugFactors,
      {
        label: 'R:R',
        value: `${grossRewardRisk.toFixed(2)} (סף ${p.minRewardRisk})`,
        impact: 'negative',
        note: `SL ${stopLoss.toFixed(6)} · TP1 ${takeProfit1.toFixed(6)} — יעד קרוב מהסטופ`
      }
    ]);
  }

  // ── §7 confidence score (0-100, weights sum to 100) ────────────────────
  const c = computeConfidence(direction, {
    st, ema50, ema200, atrM15, breakoutPrice, brokeLevel,
    volRatio, distanceFromBreakout, atrM5, params: p
  });
  const confidence = Math.round(c.total);

  const plan: TrendBreakoutPlan = {
    direction,
    state: confidence >= p.minConfidence ? 'SIGNAL' : 'ENTRY_CONFIRMATION',
    reasonCode: confidence >= p.minConfidence ? 'OK' : 'CONFIDENCE_BELOW_MIN',
    breakoutPrice,
    entryRef,
    limitEntryPrice,
    atrH1,
    atrM15,
    atrM5,
    supertrendH1: st.direction,
    supertrendValueH1: st.value,
    ema50H1: ema50,
    ema200H1: ema200,
    donchianHighM15: donch.upper,
    donchianLowM15: donch.lower,
    volumeRatioM15: volRatio,
    ema9M5: ema9,
    ema21M5: ema21,
    stopLoss,
    stopCapped,
    takeProfit,
    takeProfit1,
    takeProfit2,
    riskPerUnit: Math.abs(entryRef - stopLoss),
    confidence,
    components: c.components
  };

  const evalFactors: DecisionFactor[] = [
    ...debugFactors,
    {
      label: 'ציון ביטחון',
      value: `${confidence}/100 (סף ${p.minConfidence})`,
      impact: confidence >= p.minConfidence ? 'positive' : 'neutral',
      note: `ST ${c.components.supertrend.toFixed(0)} · EMA ${c.components.emaTrend.toFixed(0)} · פריצה ${c.components.breakout.toFixed(0)} · ווליום ${c.components.volume.toFixed(0)} · M5 ${c.components.m5.toFixed(0)}`
    }
  ];

  if (confidence < p.minConfidence) {
    const ev = base('ENTRY_CONFIRMATION', 'CONFIDENCE_BELOW_MIN', { confidence, regime: regimeResult }, evalFactors);
    (ev as { trendBreakout?: TrendBreakoutPlan }).trendBreakout = plan;
    ev.decision = plan as unknown as SignalEvaluation['decision'];
    return ev;
  }

  const ev: SignalEvaluation = {
    symbol,
    action: isLong ? 'buy' : 'sell',
    // SHORT can only be simulated as a 1x FUTURES position (spot cannot short).
    tradeType: isLong ? 'SPOT' : 'FUTURES',
    tradeSide: direction,
    confidence,
    price: currentPrice,
    priceChange24h,
    reasoning: `[SIGNAL] TrendBreakout ${direction} · פריצת Donchian(${p.donchianPeriod}) ב-M15 עם אישור ווליום x${volRatio.toFixed(2)} ואישור M5 · SL ${stopLoss.toFixed(6)} TP ${takeProfit.toFixed(6)} (R=${plan.riskPerUnit.toFixed(6)})`,
    status: `SIGNAL ${isLong ? 'SPOT LONG' : 'FUTURES SHORT'}`,
    willExecute: true,
    factors: evalFactors,
    confidenceGap: confidence - p.minConfidence,
    leverage: isLong ? 1 : 1,
    stopLoss,
    takeProfit,
    takeProfit1,
    takeProfit2,
    regime: regimeResult
  };
  (ev as { trendBreakout?: TrendBreakoutPlan }).trendBreakout = plan;
  ev.decision = plan as unknown as SignalEvaluation['decision'];
  return ev;
}

/** Reads the plan the strategy stashed on an evaluation, if present. */
export function readTrendBreakoutPlan(ev: SignalEvaluation | undefined): TrendBreakoutPlan | undefined {
  if (!ev) return undefined;
  const tagged = (ev as { trendBreakout?: TrendBreakoutPlan }).trendBreakout;
  if (tagged) return tagged;
  const viaDecision = ev.decision as unknown as TrendBreakoutPlan | undefined;
  return viaDecision && typeof viaDecision === 'object' && 'direction' in viaDecision && 'riskPerUnit' in viaDecision
    ? viaDecision
    : undefined;
}

interface ConfidenceInput {
  st: { value: number; direction: 'BULL' | 'BEAR' };
  ema50: number;
  ema200: number;
  atrM15: number;
  breakoutPrice: number;
  brokeLevel: number;
  volRatio: number;
  distanceFromBreakout: number;
  atrM5: number;
  params: TrendBreakoutParams;
}

export function computeConfidence(direction: 'LONG' | 'SHORT', i: ConfidenceInput): {
  total: number;
  components: { supertrend: number; emaTrend: number; breakout: number; volume: number; m5: number };
} {
  const isLong = direction === 'LONG';
  const p = i.params;

  // H1 Supertrend (25): aligned or not.
  const stAligned = isLong ? i.st.direction === 'BULL' : i.st.direction === 'BEAR';
  const supertrend = (stAligned ? 1 : 0) * 25;

  // H1 EMA trend (20): aligned, scaled by the EMA50/EMA200 spread.
  const emaAligned = isLong ? i.ema50 > i.ema200 : i.ema50 < i.ema200;
  const spread = i.ema200 > 0 ? Math.abs(i.ema50 - i.ema200) / i.ema200 : 0;
  const emaTrend = (emaAligned ? 1 : 0) * clamp01(spread / p.emaTrendFullSpread) * 20;

  // M15 Donchian breakout (25): scaled by how far past the channel it closed.
  const breakoutDist = Math.abs(i.breakoutPrice - i.brokeLevel);
  const breakout = clamp01(breakoutDist / (p.breakoutFullAtr * (i.atrM15 || 1))) * 25;

  // Volume confirmation (15): scaled toward volumeFullMultiplier * threshold.
  const volume = clamp01(i.volRatio / (p.volumeMultiplier * p.volumeFullMultiplier)) * 15;

  // M5 entry confirmation (15): closer to the breakout price = higher.
  const m5 = clamp01(1 - i.distanceFromBreakout / (p.m5MaxAtrDistance * (i.atrM5 || 1))) * 15;

  return {
    total: supertrend + emaTrend + breakout + volume + m5,
    components: { supertrend, emaTrend, breakout, volume, m5 }
  };
}
