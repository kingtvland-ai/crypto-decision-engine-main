/**
 * "Bot Pro" — a literal implementation of the algorithm in `alg.md`
 * (weighted-indicator confidence engine, dominance/margin/coverage scoring,
 * fixed-percentage TP/SL, risk-level-driven threshold + allocation).
 * ============================================================================
 *
 * This REPLACES the earlier version of this file, which implemented a
 * different, unrelated spec (`ASSETS/alg.md` — ADX/Supertrend regime, seven
 * ATR-scaled indicators, Kelly sizing, Spot+Futures routing). That spec and
 * this one share a filename by coincidence, not by lineage; nothing here is
 * inherited from it.
 *
 * WHAT ALG.MD SPECIFIES EXACTLY, and is followed literally:
 *   - The 8-indicator weight table (§2): RSI 15, MA 15, MACD 18, BB 12,
 *     Stochastic 8, Volume Profile 15, Volume Trend 10, 24h-change 12.
 *   - The scoring formula (§2): weighted = weight × (confidence/100), summed
 *     into buyScore / sellScore / holdScore per indicator's vote; totalWeight
 *     accumulates every indicator that was evaluated.
 *   - The confidence formula (§2):
 *       dominance = maxScore / totalWeight
 *       margin    = (maxScore - secondScore) / maxScore
 *       coverage  = min(1, totalWeight / 88)
 *       confidence = 50 + (dominance×45 + margin×25) × coverage − (1−coverage)×10
 *   - The risk-level table (§3): minConfidence / allocation% per low/medium/high,
 *     with `minConfidenceOverride > 0` replacing the table value entirely.
 *   - The fixed exit percentages (§5): stop-loss 4.2%, take-profit 3%.
 *   - Spot only. §4 is explicit that a SELL signal never opens a short.
 *
 * WHAT ALG.MD NAMES BUT DOES NOT DEFINE, and where this file necessarily makes
 * a choice — each is flagged at its definition below, not silently invented:
 *   - Per-indicator BUY/SELL/HOLD bands (RSI 25/35/65/75, Stochastic 25/75,
 *     Bollinger position, volume-trend confirmation, momentum ±3%/±8%). These
 *     are NOT re-derived here: they are the exact bands already used by this
 *     repo's `utils/smartRecommendationEngine.ts`, which independently
 *     implements the identical dominance/margin/coverage formula against a
 *     nearly-identical indicator set. Reusing a band that already exists in
 *     the codebase is a smaller assumption than inventing a new one.
 *   - "MA" (§2 names it without a band): §2's table has no Support/Resistance
 *     entry, unlike smartRecommendationEngine.ts, so this indicator has no
 *     precedent to copy. Implemented as price vs. MA20, using the same
 *     two-tier confidence convention (strong / mild deviation) the RSI and
 *     Bollinger analyzers already use in this file. The deviation bands (±2%
 *     for the strong tier) are a SUGGESTED STARTING VALUE, not a measured one.
 *   - "Volume Profile" (§2, weight 15): implemented with the codebase's actual
 *     Volume Profile primitive (`calculateVolumeProfile` — POC/value-area),
 *     not the "volume vs. its 20-bar average" heuristic the old Legacy engine
 *     called by the same English name. They are different techniques; this
 *     one matches what §2 literally names.
 *   - Volume Trend direction (§2's weight-10 indicator, named in §1's
 *     indicator list): computed with the codebase's own primitive
 *     (`analyzeVolumeTrend`) and voted with smartRecommendationEngine.ts's
 *     analyzeVolume bands — that function is this repo's only precedent for
 *     turning a volume trend into a directional vote. Where it emits nothing,
 *     this file votes HOLD: §2 requires every indicator to cast a vote
 *     (totalWeight accumulates every evaluated indicator), the same
 *     always-vote convention every other vote in this file follows.
 *   - On a HOLD-outcome tie between BUY and SELL, and on a tie between HOLD
 *     and a directional bucket, this file resolves to the SAFER outcome
 *     (HOLD wins draws). §2 does not name a tie-break.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT HAVE, because §1-§6 do not have it:
 *   No market-regime classifier (no ADX/Supertrend/TRENDING-RANGING). No
 *   Kelly sizing. No ATR-scaled stop. No Futures routing, no leverage. No
 *   ATR-based trailing stop. No confidence penalty mechanism (Legacy's
 *   volume-neutral ×0.6 / ranging ×0.7 has no counterpart in §2 at all).
 */

import type { Candle } from './tradeEngine';
import { evaluateRatchet, ratchetReason } from './profitRatchet';
import { formatDynamicPrice, roundToPriceScale, calculateEMA, BYBIT_FEES } from './tradeEngine';
import {
  analyzeVolumeTrend,
  calculateRSI,
  calculateMovingAverage,
  calculateBollingerBands,
  calculateVolumeProfile,
  calculateTechnicalScore
} from '../utils/technicalAnalysis';
import { calculateMACD, calculateStochastic } from '../utils/advancedTechnicalAnalysis';
import type { HistoricalPrice, TechnicalIndicators } from '../types/crypto';
import { positionPnlPercent, reachedStop, reachedTarget, TP2_PERCENT, TP1_EXIT_FRACTION, capStopLoss } from './exitPolicy';
import { resolveLadderPercents, type StopNoise } from './calmRegime';

// ── §2 — indicator votes ─────────────────────────────────────────────────────

export interface ProIndicatorSignal {
  name: string;
  weight: number;
  signal: 'BUY' | 'SELL' | 'HOLD';
  /** This indicator's own confidence in the vote it just cast, 0-100 — the
   *  "signalConfidence" in §2's `weighted = weight × (signalConfidence/100)`. */
  confidence: number;
  reason: string;
}

/** §2's weight table, literally. */
export const PRO_INDICATOR_WEIGHTS = {
  RSI: 15,
  MA: 15,
  MACD: 18,
  BOLLINGER: 12,
  STOCHASTIC: 8,
  VOLUME_PROFILE: 15,
  VOLUME_TREND: 10,
  MOMENTUM_24H: 12
} as const;

/**
 * §2's coverage denominator — the sum of the eight weights above (105).
 *
 * alg.md's §2 text gives 88 here without reconciling it against its own
 * weight table (which sums to 105); this was left at the doc's literal 88
 * for a while (see BOTS_REFERENCE.md/ALGO_MATH.md "known, not fixed"). Fixed
 * 2026-09-16: with 88, coverage clamped to 1 as soon as totalWeight passed
 * 88 — i.e. before every indicator had voted — so the warm-up window
 * reported "fully covered" while up to 17 points of weight were still
 * missing. 105 makes coverage mean what it says: 1 only once every
 * indicator has enough history to cast a vote.
 */
export const PRO_COVERAGE_FULL_WEIGHT = 105;

/**
 * The four §2 indicators that all read ONE thing — how far price is stretched
 * from its recent mean — and therefore cast the same directional vote together
 * on any dip or spike: RSI(14), price-vs-MA(20), Bollinger %B, Stochastic %K.
 *
 * §2's dominance/margin formula was built to reward INDEPENDENT agreement, so
 * four echoes of a single reading inflate it: a lone crowded-oscillator signal
 * clears the 70 bar, and in mid-range four HOLD echoes bury a real MACD/volume
 * lean. Rather than add a gate, `computeProSignal` scales this cluster's
 * combined contribution to whichever bucket it feeds by 1/sqrt(n) — n agreeing
 * members count as ~sqrt(n) effective votes, not n. MACD, Volume Profile,
 * Volume Trend and 24h-momentum stay independent (full weight).
 *
 * Names MUST match what the vote* functions push (asserted by a test).
 */
export const PRO_CORRELATED_CLUSTER: ReadonlySet<string> = new Set([
  'RSI(14)', 'MA(20)', 'Bollinger(20,2)', 'Stochastic(14,3)'
]);

/**
 * Hard directional veto for Pro's SHORT capability (operator decision
 * 2026-09-17, "RiskEngine" gate). A SELL never becomes an executable SHORT
 * when the last closed H1 candle returned more than this, in percent — i.e.
 * never short into a green hour. See computeProSignal's veto block.
 */
export const PRO_SHORT_TREND_VETO_1H_RETURN_PCT = 0.2;

/** Checkpoint for Pro's own Time Stop (operator decision 2026-09-17) —
 *  replaces the profit ratchet for Pro. See evaluateProExit. */
export const PRO_TIME_STOP_MINUTES = 240;

/** Once past PRO_TIME_STOP_MINUTES in profit, the position runs free of
 *  TP1/TP2 and only this — a fixed percent off the peak PRICE, not a fraction
 *  of the peak PROFIT like profitRatchet's giveback — closes it. */
export const PRO_TIME_STOP_TRAIL_PCT = 0.6;

/** Flip hysteresis margin (operator decision 2026-09-18) — used two ways in
 *  evaluateProExit's flip check: (1) FLIP_THRESHOLD = entry minConfidence +
 *  this margin (82 at today's 78 entry floor — computed off the live
 *  minConfidence, not a second hardcoded absolute, so it tracks if the entry
 *  floor is ever retuned); (2) the opposing raw bucket score must beat the
 *  position's own direction's raw score by at least this many points. Both
 *  conditions are required — a bare confidence-threshold flip let a score
 *  wobbling near the entry floor flip a position back and forth
 *  (BUY→SELL→BUY) on noise alone. */
export const PRO_FLIP_THRESHOLD_MARGIN = 4;

function pushVote(
  signals: ProIndicatorSignal[],
  name: string,
  weight: number,
  signal: 'BUY' | 'SELL' | 'HOLD',
  confidence: number,
  reason: string
): void {
  signals.push({ name, weight, signal, confidence, reason });
}

// RSI(14) — bands are smartRecommendationEngine.ts's, not re-derived here.
function voteRsi(rsi: number, signals: ProIndicatorSignal[]): void {
  const w = PRO_INDICATOR_WEIGHTS.RSI;
  if (rsi <= 25) pushVote(signals, 'RSI(14)', w, 'BUY', 90, `RSI קיצוני נמוך (${rsi.toFixed(1)}) — oversold חזק`);
  else if (rsi <= 35) pushVote(signals, 'RSI(14)', w, 'BUY', 75, `RSI נמוך (${rsi.toFixed(1)}) — oversold`);
  else if (rsi >= 75) pushVote(signals, 'RSI(14)', w, 'SELL', 90, `RSI קיצוני גבוה (${rsi.toFixed(1)}) — overbought חזק`);
  else if (rsi >= 65) pushVote(signals, 'RSI(14)', w, 'SELL', 70, `RSI גבוה (${rsi.toFixed(1)}) — overbought`);
  else pushVote(signals, 'RSI(14)', w, 'HOLD', 70, `RSI ניטרלי (${rsi.toFixed(1)})`);
}

// MA(20) — price vs. MA as mean-reversion: far above = overbought (SELL),
// far below = oversold (BUY). The ±2% band and the two-tier confidence are a
// SUGGESTED STARTING VALUE mirroring the RSI/Bollinger convention already used
// below, not a measured threshold.
function voteMa(currentPrice: number, ma20: number, signals: ProIndicatorSignal[]): void {
  const w = PRO_INDICATOR_WEIGHTS.MA;
  if (!(ma20 > 0)) { pushVote(signals, 'MA(20)', w, 'HOLD', 50, 'אין מספיק היסטוריה לממוצע נע 20'); return; }
  const distPct = ((currentPrice - ma20) / ma20) * 100;
  if (distPct < -2) pushVote(signals, 'MA(20)', w, 'BUY', 80, `מחיר ${Math.abs(distPct).toFixed(1)}% מתחת ל-MA20 ($${formatDynamicPrice(ma20)}) — oversold`);
  else if (distPct < -0.1) pushVote(signals, 'MA(20)', w, 'BUY', 60, `מחיר מתחת ל-MA20 (${Math.abs(distPct).toFixed(1)}%) — קל oversold`);
  else if (distPct > 2) pushVote(signals, 'MA(20)', w, 'SELL', 80, `מחיר ${distPct.toFixed(1)}% מעל MA20 ($${formatDynamicPrice(ma20)}) — overbought`);
  else if (distPct > 0.1) pushVote(signals, 'MA(20)', w, 'SELL', 60, `מחיר מעל MA20 (${distPct.toFixed(1)}%) — קל overbought`);
  else pushVote(signals, 'MA(20)', w, 'HOLD', 70, 'מחיר צמוד ל-MA20');
}

// MACD(12,26,9) — same trend+histogram reading as smartRecommendationEngine.ts.
function voteMacd(macd: ReturnType<typeof calculateMACD>, signals: ProIndicatorSignal[]): void {
  const w = PRO_INDICATOR_WEIGHTS.MACD;
  if (macd.trend === 'bullish' && macd.histogram > 0) {
    pushVote(signals, 'MACD(12,26,9)', w, 'BUY', Math.min(95, 70 + Math.abs(macd.histogram) * 10),
      `MACD חיובי — מגמה עולה (${macd.macd.toFixed(4)} > ${macd.signal.toFixed(4)})`);
  } else if (macd.trend === 'bearish' && macd.histogram < 0) {
    pushVote(signals, 'MACD(12,26,9)', w, 'SELL', Math.min(95, 70 + Math.abs(macd.histogram) * 10),
      `MACD שלילי — מגמה יורדת (${macd.macd.toFixed(4)} < ${macd.signal.toFixed(4)})`);
  } else {
    pushVote(signals, 'MACD(12,26,9)', w, 'HOLD', 60, 'MACD ללא מגמה מובהקת');
  }
}

// Bollinger Bands(20,2) — same position reading as smartRecommendationEngine.ts.
function voteBollinger(bb: ReturnType<typeof calculateBollingerBands>, currentPrice: number, signals: ProIndicatorSignal[]): void {
  const w = PRO_INDICATOR_WEIGHTS.BOLLINGER;
  const ratio = bb.upper > bb.lower ? (currentPrice - bb.lower) / (bb.upper - bb.lower) : 0.5;
  if (bb.position === 'below') pushVote(signals, 'Bollinger(20,2)', w, 'BUY', 85, `מחיר מתחת לרצועה תחתונה ($${formatDynamicPrice(bb.lower)})`);
  else if (bb.position === 'above') pushVote(signals, 'Bollinger(20,2)', w, 'SELL', 85, `מחיר מעל לרצועה עליונה ($${formatDynamicPrice(bb.upper)})`);
  else if (ratio < 0.2) pushVote(signals, 'Bollinger(20,2)', w, 'BUY', 65, 'מחיר קרוב לרצועה תחתונה');
  else if (ratio > 0.8) pushVote(signals, 'Bollinger(20,2)', w, 'SELL', 65, 'מחיר קרוב לרצועה עליונה');
  else pushVote(signals, 'Bollinger(20,2)', w, 'HOLD', 70, 'מחיר בתוך הרצועות');
}

// Stochastic(14,3) — same 25/75 bands as smartRecommendationEngine.ts.
function voteStochastic(stoch: ReturnType<typeof calculateStochastic>, signals: ProIndicatorSignal[]): void {
  const w = PRO_INDICATOR_WEIGHTS.STOCHASTIC;
  if (stoch.signal === 'oversold' && stoch.k < 25) pushVote(signals, 'Stochastic(14,3)', w, 'BUY', 75, `סטוכסטיק oversold (K ${stoch.k.toFixed(1)} / D ${stoch.d.toFixed(1)})`);
  else if (stoch.signal === 'overbought' && stoch.k > 75) pushVote(signals, 'Stochastic(14,3)', w, 'SELL', 75, `סטוכסטיק overbought (K ${stoch.k.toFixed(1)} / D ${stoch.d.toFixed(1)})`);
  else pushVote(signals, 'Stochastic(14,3)', w, 'HOLD', 60, `סטוכסטיק בטווח אמצע (K ${stoch.k.toFixed(1)})`);
}

// Volume Profile (POC / value area) — §2 names THIS technique, not a
// volume-vs-average heuristic; calculateVolumeProfile is the codebase's real
// implementation of it.
function voteVolumeProfile(vp: ReturnType<typeof calculateVolumeProfile>, signals: ProIndicatorSignal[]): void {
  const w = PRO_INDICATOR_WEIGHTS.VOLUME_PROFILE;
  if (vp.position === 'below_val') pushVote(signals, 'Volume Profile', w, 'BUY', 75, `מחיר מתחת לאזור הערך (VAL $${formatDynamicPrice(vp.valueAreaLow)})`);
  else if (vp.position === 'above_vah') pushVote(signals, 'Volume Profile', w, 'SELL', 75, `מחיר מעל לאזור הערך (VAH $${formatDynamicPrice(vp.valueAreaHigh)})`);
  else pushVote(signals, 'Volume Profile', w, 'HOLD', 65, `מחיר בתוך אזור הערך (POC $${formatDynamicPrice(vp.poc)})`);
}

// Volume Trend (מגמת נפח) — §2's weight-10 indicator, named in §1's list.
// Direction comes from the codebase's own primitive (analyzeVolumeTrend:
// recent vs. prior volume averages); the vote bands are
// smartRecommendationEngine.ts's analyzeVolume, this repo's only precedent
// for turning a volume trend into a directional vote. That function emits
// NOTHING outside its three bands; §2 requires every indicator to vote
// (totalWeight accumulates every evaluated indicator), so the uncovered
// cases vote HOLD — the same always-vote convention every other vote in
// this file follows.
function voteVolumeTrend(
  volumeTrend: 'increasing' | 'decreasing' | 'stable',
  priceChange24h: number,
  signals: ProIndicatorSignal[]
): void {
  const w = PRO_INDICATOR_WEIGHTS.VOLUME_TREND;
  if (volumeTrend === 'increasing' && priceChange24h > 0) {
    pushVote(signals, 'מגמת נפח', w, 'BUY', 75, 'נפח עולה עם מחירים עולים — אישור מגמה');
  } else if (volumeTrend === 'increasing' && priceChange24h < -2) {
    pushVote(signals, 'מגמת נפח', w, 'SELL', 70, 'נפח עולה עם מחירים יורדים — לחץ מכירות');
  } else if (volumeTrend === 'decreasing' && Math.abs(priceChange24h) > 3) {
    pushVote(signals, 'מגמת נפח', w, 'HOLD', 60, 'נפח נמוך — מגמה לא מאושרת');
  } else {
    pushVote(signals, 'מגמת נפח', w, 'HOLD', 55,
      volumeTrend === 'increasing'
        ? 'נפח עולה ללא כיוון מחיר ברור'
        : volumeTrend === 'decreasing'
          ? 'נפח יורד — ללא אישוש כיווני'
          : 'מגמת נפח יציבה — ללא אישוש כיווני');
  }
}

// 24h price change (momentum) — same ±3%/±8% bands as
// smartRecommendationEngine.ts's analyzePriceMomentum.
function voteMomentum24h(priceChange24h: number, signals: ProIndicatorSignal[]): void {
  const w = PRO_INDICATOR_WEIGHTS.MOMENTUM_24H;
  if (priceChange24h > 8) pushVote(signals, 'שינוי 24ש׳', w, 'SELL', 70, `עלייה חדה (+${priceChange24h.toFixed(1)}%) — שקול מימוש`);
  else if (priceChange24h < -8) pushVote(signals, 'שינוי 24ש׳', w, 'BUY', 70, `ירידה חדה (${priceChange24h.toFixed(1)}%) — הזדמנות`);
  else if (priceChange24h > 3) pushVote(signals, 'שינוי 24ש׳', w, 'BUY', 60, `מומנטום חיובי (+${priceChange24h.toFixed(1)}%)`);
  else if (priceChange24h < -3) pushVote(signals, 'שינוי 24ש׳', w, 'SELL', 60, `מומנטום שלילי (${priceChange24h.toFixed(1)}%)`);
  else pushVote(signals, 'שינוי 24ש׳', w, 'HOLD', 65, `שינוי 24ש׳ מתון (${priceChange24h.toFixed(1)}%)`);
}

/**
 * §2's scoring — `weighted = weight × (confidence/100)`, routed to the bucket
 * the indicator voted for — WITH a correlation penalty on the oscillator
 * cluster.
 *
 * The four PRO_CORRELATED_CLUSTER indicators all read one thing (displacement
 * from the recent mean), so their votes are echoes, not independent
 * confirmations. §2's dominance/margin was built for independent agreement, so
 * four echoes of one reading inflate it. Fix: each bucket's cluster
 * contribution is divided by √n where n is how many cluster members voted that
 * way — 4 agreeing oscillators count as 2 effective votes, not 4; 2 count as
 * ~1.4. `totalWeight` is the RAW sum of every indicator's weight, unchanged, so
 * `coverage` (totalWeight / 88) is unaffected — the information is still there,
 * it is just not counted four times.
 *
 * Pure: no candle math, so it is unit-testable with hand-built signal arrays.
 */
export function aggregateProBuckets(signals: ProIndicatorSignal[]): {
  buyScore: number; sellScore: number; holdScore: number; totalWeight: number;
} {
  const bucketScore: Record<'BUY' | 'SELL' | 'HOLD', number> = { BUY: 0, SELL: 0, HOLD: 0 };
  const clusterWeighted: Record<'BUY' | 'SELL' | 'HOLD', number> = { BUY: 0, SELL: 0, HOLD: 0 };
  const clusterCount: Record<'BUY' | 'SELL' | 'HOLD', number> = { BUY: 0, SELL: 0, HOLD: 0 };
  let totalWeight = 0;
  for (const s of signals) {
    const weighted = s.weight * (s.confidence / 100);
    totalWeight += s.weight;
    if (PRO_CORRELATED_CLUSTER.has(s.name)) {
      clusterWeighted[s.signal] += weighted;
      clusterCount[s.signal] += 1;
    } else {
      bucketScore[s.signal] += weighted;
    }
  }
  for (const dir of ['BUY', 'SELL', 'HOLD'] as const) {
    if (clusterCount[dir] > 0) bucketScore[dir] += clusterWeighted[dir] / Math.sqrt(clusterCount[dir]);
  }
  return {
    buyScore: Number(bucketScore.BUY.toFixed(2)),
    sellScore: Number(bucketScore.SELL.toFixed(2)),
    holdScore: Number(bucketScore.HOLD.toFixed(2)),
    totalWeight
  };
}

// ── §2 — the aggregate result ────────────────────────────────────────────────

export interface ProSignalResult {
  action: 'BUY' | 'SELL' | 'HOLD';
  /** The bucket vote's own action, BEFORE the regime filter/modifier below
   *  ever touches it (operator decision 2026-09-18: regime must never
   *  rewrite a signal into a different direction — only boost an agreeing
   *  one or block a disagreeing one back to HOLD). `action` above is what
   *  actually governs the trade; `rawSignal` is kept for transparency/
   *  debugging so "why did this become HOLD" is answerable from the record.
   *  Optional only so a hand-built test/stub ProSignalResult need not supply
   *  it — computeProSignal itself always sets it. */
  rawSignal?: 'BUY' | 'SELL' | 'HOLD';
  /** EMA50/EMA200 + "not extended" structure, independent of the bucket
   *  vote — see rawSignal's note. 'NONE' when neither trendLaneUp nor
   *  trendLaneDown holds (flat or extended). Optional for the same reason
   *  as rawSignal. */
  marketRegime?: 'UP' | 'DOWN' | 'NONE';
  buyScore: number;
  sellScore: number;
  holdScore: number;
  totalWeight: number;
  /** §2's formula, verbatim. 0-100. */
  confidence: number;
  /** ATR(14) as a percent of price — the scale for the ATR-scaled stop. */
  atrPercent: number;
  signals: ProIndicatorSignal[];
  /** Full per-indicator breakdown, for the technical-score line in the UI. */
  indicators: TechnicalIndicators & {
    isDowntrend?: boolean;
    ema50?: number;
    ema200?: number;
    /** Last closed H1 candle's own return, percent — what the SHORT veto
     *  reads (PRO_SHORT_TREND_VETO_1H_RETURN_PCT). */
    oneHourReturnPct?: number;
    /** ema50 > ema200 — the same test the SHORT veto and trendLaneUp use. */
    trendUp?: boolean;
  };
}

/**
 * §2, computed from raw OHLCV history — the same aggregation formula as
 * `utils/smartRecommendationEngine.ts`, re-implemented against §2's own
 * 8-indicator weight table rather than that file's.
 *
 * `candles` must be closed H1 bars, oldest → newest.
 */
export function computeProSignal(
  candles: Candle[],
  priceChange24h: number
): ProSignalResult {
  const prices = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const historical: HistoricalPrice[] = candles.map((c) => ({ timestamp: c.timestamp, price: c.close, volume: c.volume }));
  const currentPrice = prices[prices.length - 1];

  const rsi = calculateRSI(prices);
  const ma20 = calculateMovingAverage(prices, 20);
  const bb = calculateBollingerBands(prices);
  const vp = calculateVolumeProfile(historical, volumes);
  const macd = calculateMACD(prices);
  const stochastic = calculateStochastic(
    candles.map((c) => c.high),
    candles.map((c) => c.low),
    prices
  );
  const volumeTrend = analyzeVolumeTrend(volumes);

  const ema50Series = calculateEMA(prices, 50);
  const ema200Series = calculateEMA(prices, 200);
  const ema50 = ema50Series[ema50Series.length - 1] ?? currentPrice;
  const ema200 = ema200Series[ema200Series.length - 1] ?? currentPrice;

  const isDowntrend = ema50 < ema200 && currentPrice < ema50;

  // ATR% over the last 14 bars — the scale for "is price near its trend mean".
  const atrPercent = (() => {
    const n = Math.min(14, candles.length - 1);
    if (n <= 0 || !(currentPrice > 0)) return 0;
    let sum = 0;
    for (let i = candles.length - n; i < candles.length; i++) {
      const c = candles[i];
      const prev = candles[i - 1];
      sum += Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
    }
    return (sum / n) / currentPrice * 100;
  })();

  const signals: ProIndicatorSignal[] = [];
  voteRsi(rsi, signals);
  voteMa(currentPrice, ma20, signals);
  voteMacd(macd, signals);
  voteBollinger(bb, currentPrice, signals);
  voteStochastic(stochastic, signals);
  voteVolumeProfile(vp, signals);
  voteVolumeTrend(volumeTrend, priceChange24h, signals);
  voteMomentum24h(priceChange24h, signals);

  const { buyScore, sellScore, holdScore, totalWeight } = aggregateProBuckets(signals);

  const maxScore = Math.max(buyScore, sellScore, holdScore);
  // BUY wins a draw with HOLD so a signal that ties the neutral bucket is
  // allowed through — a HOLD tie is not "safer", it is an unexpressed BUY.
  let action: 'BUY' | 'SELL' | 'HOLD' =
    maxScore === buyScore ? 'BUY' : maxScore === sellScore ? 'SELL' : 'HOLD';

  const secondScore = [buyScore, sellScore, holdScore].sort((a, b) => b - a)[1] ?? 0;
  const dominance = totalWeight > 0 ? maxScore / totalWeight : 0;
  const margin = maxScore > 0 ? (maxScore - secondScore) / maxScore : 0;
  const coverage = Math.min(1, totalWeight / PRO_COVERAGE_FULL_WEIGHT);

  const rawConfidence = 50 + (dominance * 45 + margin * 25) * coverage - (1 - coverage) * 10;
  // §2 does not state a clamp; confidence is reported as a percentage
  // everywhere downstream, so it is bounded to [0,100] rather than left to
  // exceed that range on an edge case.
  //
  // Alignment fix: the formula above rewards dominance of ANY bucket, including
  // HOLD — so a dominant HOLD vote can push confidence past 70% even though
  // there is no directional signal to act on. That makes the displayed number
  // lie: the user sees "72% confidence" and expects an entry, but the action is
  // HOLD and nothing happens. Cap HOLD at the formula's neutral baseline (50)
  // so high confidence ONLY ever accompanies a directional vote —
  // "confidence ≥ 70% ⟹ BUY or SELL is firing" holds true, and the number the
  // user sees matches the entry decision.
  //
  // 2026-09-17: SELL used to be capped here too, back when Pro was spot-only
  // and a SELL could never open anything (only close an existing LONG, itself
  // gated on a SEPARATE, lower threshold in evaluateProExit). Now that a SELL
  // is a real SHORT candidate (proSimExecution.ts), it earns the same
  // uncapped, dominance/margin-based confidence a BUY gets — otherwise a
  // genuine bearish reading could never clear the entry threshold at all.
  let confidence = Number(Math.max(0, Math.min(100, action === 'HOLD' ? Math.min(rawConfidence, 50) : rawConfidence)).toFixed(1));

  // rawSignal is frozen HERE, before the regime filter/modifier below can
  // touch `action` — operator decision 2026-09-18: regime must never REWRITE
  // a signal into a different direction (the old lane turned HOLD into BUY,
  // or HOLD into SELL — a fabricated direction the bucket vote never cast).
  // From here on, regime may only BOOST an agreeing action or BLOCK a
  // disagreeing one back to HOLD.
  const rawSignal = action;

  // ── Market regime — filter/modifier only, never a signal rewrite ─────────
  // The eight bucket votes are 7/8 mean-reversion, so `action` is HOLD through
  // almost every trending bar. Regime used to manufacture a BUY/SELL out of
  // that HOLD; now it only ever (a) boosts confidence when the raw vote
  // already agrees with the trend, or (b) blocks a raw vote that fights the
  // trend back to HOLD. A raw HOLD stays HOLD in every regime — trading WITH
  // a trend the bucket vote itself never called is no longer something this
  // function does.
  const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
  // "not extended" — price is within 3×ATR of the EMA50, i.e. riding the trend
  // line or pulling back to it, not chasing a parabolic move away from it.
  const distFromEma50Pct = ema50 > 0 ? Math.abs(currentPrice - ema50) / ema50 * 100 : Infinity;
  const notExtended = atrPercent > 0 && distFromEma50Pct <= 3 * atrPercent;
  // EMA structure only — no MACD gate. A pullback deep enough to bring price
  // back to the EMA50 almost always turns the MACD histogram mildly negative
  // on this timeframe; requiring MACD-bullish would leave this regime unable
  // to confirm a pullback-in-trend at all. `price > ema50 > ema200` +
  // notExtended is a sufficient "established uptrend, not chasing" read.
  const trendLaneUp = ema50 > ema200 && currentPrice > ema50 && notExtended;
  const trendLaneDown = ema50 < ema200 && currentPrice < ema50 && notExtended;
  const marketRegime: 'UP' | 'DOWN' | 'NONE' = trendLaneUp ? 'UP' : trendLaneDown ? 'DOWN' : 'NONE';

  const trendBoost = () => {
    const trendStrength = clamp01(Math.abs(ema50 - ema200) / (ema200 * 0.02)); // 2% EMA spread → full
    const pullbackQuality = clamp01(1 - distFromEma50Pct / (3 * atrPercent));
    confidence = Math.max(confidence, Number((58 + trendStrength * 22 + pullbackQuality * 20).toFixed(1)));
  };

  if (marketRegime === 'UP') {
    if (action === 'BUY') {
      trendBoost();
    } else if (action === 'SELL') {
      // Block, don't rewrite: a raw SELL fighting an established uptrend is
      // refused back to HOLD — it never becomes a BUY the bucket vote never
      // cast. (The hard veto below covers the broader case — an EXTENDED
      // uptrend, or a merely-green last candle — independently of this
      // "clean, not-extended" regime read.)
      action = 'HOLD';
      confidence = Math.min(confidence, 50);
    }
    // action === 'HOLD' stays HOLD — no promotion.
  } else if (marketRegime === 'DOWN') {
    if (action === 'SELL') {
      trendBoost();
    } else if (action === 'BUY') {
      action = 'HOLD';
      confidence = Math.min(confidence, 50);
    }
  }

  // ── Hard directional veto — never SHORT into a positive 1H candle or an
  // established uptrend (operator decision 2026-09-17) ─────────────────────
  // Absolute veto, independent of everything above: even a SELL that reached
  // here through the raw bucket vote alone is refused if the last closed H1
  // candle itself was green past PRO_SHORT_TREND_VETO_1H_RETURN_PCT, or if
  // the EMA structure already reads as an uptrend (ema50 > ema200 — the same
  // test trendLaneUp uses, without requiring "not extended" this time: an
  // extended uptrend is not a green light to short it either). Demoted to
  // HOLD, not silently zeroed, so the reasoning string still shows the raw
  // vote.
  const lastCandle = candles[candles.length - 1];
  const oneHourReturnPct = lastCandle && lastCandle.open > 0
    ? ((lastCandle.close - lastCandle.open) / lastCandle.open) * 100
    : 0;
  const trendUp = ema50 > ema200;
  const shortVetoed = action === 'SELL' &&
    (oneHourReturnPct > PRO_SHORT_TREND_VETO_1H_RETURN_PCT || trendUp);
  if (shortVetoed) {
    action = 'HOLD';
    confidence = Math.min(confidence, 50);
  }

  // Final clamp (operator decision 2026-09-18): every branch above only ever
  // moves confidence via Math.max/Math.min against already-bounded values, so
  // this is a no-op in practice today — kept explicit so a future change to
  // any branch above cannot silently push confidence outside [0,100] again.
  confidence = Number(Math.max(0, Math.min(100, confidence)).toFixed(1));

  return {
    action,
    rawSignal,
    marketRegime,
    buyScore,
    sellScore,
    holdScore,
    totalWeight,
    confidence,
    atrPercent,
    signals,
    indicators: { rsi, ma20, volumeTrend, bollingerBands: bb, volumeProfile: vp, macd, stochastic, isDowntrend, ema50, ema200, oneHourReturnPct, trendUp }
  };
}

/** For the reasoning line — reuses the existing composite technical score. */
export function proTechnicalScore(result: ProSignalResult): number {
  return calculateTechnicalScore(result.indicators);
}

/**
 * §6 — compute an optimal entry price from indicator support levels.
 *
 * Instead of buying at the current market price, this calculates a better entry
 * at technical support: Bollinger lower band, MA20, and Volume Profile value
 * area low / POC. The result is typically LOWER than current price — the bot
 * waits for a dip to enter.
 *
 * Weights (sum to 1.0):
 *   - Bollinger lower band: 30% (strong volatility support)
 *   - MA20: 25% (trend support)
 *   - Volume Profile VAL: 25% (high-volume support)
 *   - Volume Profile POC: 10% (point of control)
 *   - Current price with 1% discount: 10% (slight pullback)
 */
/**
 * Hard ceiling on how far below market a Pro LIMIT entry may rest, in percent.
 *
 * The support-weighted price below answers "where is the nearest strong
 * support?" — a question with no connection to the trade's own risk budget. The
 * old floor was `currentPrice × 0.90`, i.e. up to 10% below market. Observed
 * live on NEAR: market $2.4540, planned entry $2.2902 — **-6.67%** — on a bot
 * whose ladder targets TP1 1.8% / SL 2.3%. Waiting for a 6.67% drop to open a
 * trade that intends to capture 1.8% is asking for a bigger move BEFORE the
 * trade than the trade itself wants; in practice the order just expires at the
 * 2h TTL and the bot never trades.
 */
export const PRO_MAX_ENTRY_DISCOUNT_PCT = 1.0;
/**
 * ...and the discount also may not exceed this fraction of the trade's OWN stop
 * distance, so it scales with the ladder instead of being a magic number:
 * a calm-regime 2.3% stop allows 0.69%, a wide 4.2% stop allows 1.26% → clamped
 * by PRO_MAX_ENTRY_DISCOUNT_PCT to 1.0%. An entry discount comparable to the
 * stop is not a better fill, it is a different trade.
 */
export const PRO_ENTRY_DISCOUNT_STOP_FRACTION = 0.30;

/** The discount ceiling for a given stop distance — the two rules above, combined. */
export function proMaxEntryDiscountPercent(stopPercent: number | undefined): number {
  const byStop = typeof stopPercent === 'number' && Number.isFinite(stopPercent) && stopPercent > 0
    ? stopPercent * PRO_ENTRY_DISCOUNT_STOP_FRACTION
    : PRO_MAX_ENTRY_DISCOUNT_PCT;
  return Math.min(PRO_MAX_ENTRY_DISCOUNT_PCT, byStop);
}

export function calculateOptimalEntryPrice(
  signal: ProSignalResult,
  currentPrice: number,
  /** Ceiling on the distance from market, in percent. Defaults to the absolute
   *  cap; the sim passes the stop-derived value from `proMaxEntryDiscountPercent`. */
  opts: { maxDiscountPercent?: number } = {}
): number {
  const { bollingerBands, volumeProfile, ma20 } = signal.indicators;

  const supportLevels: { price: number; weight: number }[] = [];

  // Bollinger lower band (strong support)
  if (bollingerBands.lower > 0) {
    supportLevels.push({ price: bollingerBands.lower, weight: 0.30 });
  }

  // MA20 (trend support)
  if (ma20 > 0) {
    supportLevels.push({ price: ma20, weight: 0.25 });
  }

  // Volume Profile Value Area Low (high-volume support)
  if (volumeProfile.valueAreaLow > 0) {
    supportLevels.push({ price: volumeProfile.valueAreaLow, weight: 0.25 });
  }

  // Volume Profile POC (point of control)
  if (volumeProfile.poc > 0) {
    supportLevels.push({ price: volumeProfile.poc, weight: 0.10 });
  }

  // Current price with 1% discount (slight pullback)
  supportLevels.push({ price: currentPrice * 0.99, weight: 0.10 });

  // Weighted average
  const totalWeight = supportLevels.reduce((sum, s) => sum + s.weight, 0);
  if (totalWeight === 0) return currentPrice;

  const weightedPrice = supportLevels.reduce((sum, s) => sum + s.price * s.weight, 0) / totalWeight;

  // Cap at current price (we don't want to buy above market on entry) and floor
  // at the DISCOUNT CEILING — see PRO_MAX_ENTRY_DISCOUNT_PCT. This used to be a
  // flat `currentPrice × 0.90` (up to 10% away), which let the support-weighted
  // price park the order far outside anything the 2h TTL could fill.
  // Rounded to the asset's own price scale (roundToPriceScale), not a flat 2
  // decimals — see its doc comment for the SKR case that flat rounding broke:
  // a $0.02 coin has no meaningful "cents", so .toFixed(2) collapsed the
  // support-weighted level to whichever of {0.01, 0.02, 0.03} it landed
  // nearest, on the wrong side of the market often enough that the resting
  // LIMIT order never crossed.
  const maxDiscount = Math.max(0, opts.maxDiscountPercent ?? PRO_MAX_ENTRY_DISCOUNT_PCT) / 100;
  const floorPrice = currentPrice * (1 - maxDiscount);
  const ceilPrice = currentPrice * (1 + maxDiscount);
  const capped = signal.action === 'BUY'
    ? Math.min(currentPrice, Math.max(floorPrice, weightedPrice))
    : Math.max(currentPrice, Math.min(ceilPrice, weightedPrice));
  // LIMIT orders for LONG must sit BELOW current price — otherwise they fill
  // immediately as market orders, defeating the purpose of resting.
  const limitPrice = signal.action === 'BUY'
    ? Math.min(capped, currentPrice * 0.999)
    : Math.max(capped, currentPrice * 1.001);
  return roundToPriceScale(limitPrice);
}

// ── §3 — risk-level thresholds ───────────────────────────────────────────────

export type ProRiskLevel = 'low' | 'medium' | 'high';

/** §3's table, literally: minConfidence per risk level. Exported as the
 *  reference only — see PRO_DEFAULT_ENTRY_CONFIDENCE for what actually runs. */
export const PRO_CONFIDENCE_BY_RISK: Record<ProRiskLevel, number> = { low: 55, medium: 40, high: 25 };

/**
 * The flat default entry threshold for the Pro bot.
 *
 * §3's table (PRO_CONFIDENCE_BY_RISK) remains exported as the reference, but
 * the operator-set behaviour is a single flat bar: the bot enters a BUY the
 * moment its overall confidence crosses this number, whichever risk level is
 * configured. An explicit `minConfidenceOverride > 0` (panel / env) replaces
 * it. This is what "כשהביטחון הכולל עובר 70% — כניסה" means here.
 */
export const PRO_DEFAULT_ENTRY_CONFIDENCE = 70;

/** §3: `minConfidenceOverride > 0 ? minConfidenceOverride : PRO_CONFIDENCE_BY_RISK[riskLevel]`. */
export function proMinConfidence(riskLevel: ProRiskLevel, override?: number): number {
  if (typeof override === 'number' && override > 0) return override;
  return PRO_CONFIDENCE_BY_RISK[riskLevel] ?? PRO_DEFAULT_ENTRY_CONFIDENCE;
}

/**
 * Entry allocation, as a percent of spendable cash.
 *
 * §3 also specifies a risk-level allocation table (15/25/40%) — that table
 * used to live here as PRO_ALLOCATION_BY_RISK / proAllocationPercent(), fully
 * wired to nothing: applyProEntryGates (proSimExecution.ts) has always sized
 * entries off confidence, never off riskLevel, so the risk table was dead code
 * that the panel imported and displayed as if it were live. Confidence-based
 * sizing is the one actually running four bots' worth of history, so it is
 * now the only definition — a bucket, not a formula, because the buckets
 * (10%/15%) don't interpolate: they were never meant to.
 */
/**
 * Entry size as a fraction of spendable capital. ONE number: confidence has not
 * scaled Pro's size since the 10%/15% split was removed (both buckets were
 * already 0.10). Mirrors `POSITION_TARGET_PCT` — Pro's gate sizes off that; this
 * is the display constant so the UI and the engine cannot drift apart again.
 */
export const PRO_ENTRY_ALLOCATION_PERCENT = 0.10;

// ── §5 — exit levels ─────────────────────────────────────────────────────────

// TP2 and the partial fraction come from the shared exit policy so all four
// bots ladder out the same way.
/** Fallback percentages for a position opened before ATR-scaled levels, and
 *  the hard ceiling on the stop. §5 named a flat 3% / 4.2%; the stop is now
 *  ATR-scaled (proStopTpLevels) with 4.2% only as the cap — a flat 4.2% stop
 *  against a 3% target is a 0.7 reward:risk on every trade. */
export const PRO_TAKE_PROFIT_PERCENT = 3;
export const PRO_STOP_LOSS_PERCENT = 4.2;
/** ATR multiple for the stop, and the floor it may not go below. */
export const PRO_STOP_ATR_MULT = 1.6;
export const PRO_STOP_MIN_PERCENT = 1.8;

/**
 * ATR-scaled stop + a stop-relative TP ladder, as absolute prices.
 * stop distance = clamp(atrPercent × 1.6, 1.8%, 4.2%); TP1 = max(1.5%, 1.5×
 * stop); TP2 = 1.5 × TP1. Mirrors `tp1FloorDistance` — reward:risk floors at
 * 1.5 instead of the old inverted 0.7.
 */
export function proStopTpLevels(
  entryPrice: number,
  atrPercent: number,
  isLong: boolean,
  /** Opt-in (default off — sim only, see proSimExecution.ts). `calmRegimeScalp`
   *  replaces the ATR ladder with a FIXED SL 2.3% / TP1 1.8% / TP2 3.5% one,
   *  always; `buyingSurge` (relVolume >= 2 + green bar) is the ONE exception,
   *  widening the stop back to the ATR value clamped to [2.3%, 4.2%].
   *  See calmRegime.ts. */
  opts: {
    calmRegimeScalp?: boolean;
    buyingSurge?: boolean;
    /** Opt-in (default off). Requires `calmRegimeScalp`. Adds the noise floor:
     *  the stop must clear one ordinary bar's range, measured by
     *  `measureStopNoise` on the caller's own candle series. */
    noiseFloorStop?: boolean;
    stopNoise?: StopNoise;
    /** Deterministic Dynamic Volatility Profile ladder (sim only, see
     *  proSimExecution.ts / resolveVolatilityLadder). Highest precedence of
     *  the three ladder sources — when present it replaces BOTH the ATR
     *  ladder and `calmRegimeScalp`'s fixed one, still capped at
     *  PRO_STOP_LOSS_PERCENT. Absent (no profile for the symbol) leaves the
     *  ladders below running exactly as before. */
    volatilityLadder?: { stopPct: number; targetPct: number };
  } = {}
): { stopLoss: number; takeProfit1: number; takeProfit2: number; tooVolatile: boolean; noiseFloorPct: number } {
  const stopPct = Math.min(PRO_STOP_LOSS_PERCENT, Math.max(PRO_STOP_MIN_PERCENT, atrPercent * PRO_STOP_ATR_MULT));
  let tp1Pct = Math.max(1.5, stopPct * 1.5);
  let tp2Pct = tp1Pct * 1.5;
  let finalStopPct = stopPct;
  let tooVolatile = false;
  let noiseFloorPct = 0;
  const volatilityLadderActive =
    opts.volatilityLadder !== undefined &&
    opts.volatilityLadder.stopPct > 0 &&
    opts.volatilityLadder.targetPct > 0;
  if (volatilityLadderActive) {
    // Same ceiling every other ladder respects — a REFERENCE distance from
    // the module, not an exemption from this bot's hard risk limit.
    finalStopPct = Math.min(PRO_STOP_LOSS_PERCENT, opts.volatilityLadder!.stopPct);
    tp1Pct = opts.volatilityLadder!.targetPct;
    tp2Pct = tp1Pct * 1.5;
  }
  // The fixed scalp ladder replaces the ATR ladder outright. Two things widen
  // the stop back off the flat 2.3%: a BUYING SURGE, and the noise floor —
  // `atrPercent × PRO_STOP_ATR_MULT` is the stop this function computes one
  // line above and the ladder used to discard wholesale, which is exactly the
  // number a stop has to clear to survive an ordinary bar. TP1's own R:R is
  // deliberately poor — it is a fast 50% partial, not the whole thesis. Pro
  // carries no R:R reject gate, so there is nothing to reconcile here (unlike
  // Intraday/Path/Bybit, whose gates are re-pointed at TP2).
  if (!volatilityLadderActive && opts.calmRegimeScalp === true) {
    const ladder = resolveLadderPercents({
      dynamicSlPct: stopPct,
      buyingSurge: opts.buyingSurge,
      noiseFloorPct: opts.noiseFloorStop === true ? opts.stopNoise?.floorPct : undefined,
      isLong
    });
    finalStopPct = ladder.slPct;
    tp1Pct = ladder.tp1Pct;
    tp2Pct = ladder.tp2Pct;
    tooVolatile = ladder.tooVolatile;
    noiseFloorPct = ladder.noiseFloorPct;
  }
  const s = isLong ? 1 : -1;
  return {
    stopLoss: Math.max(entryPrice * (1 - s * finalStopPct / 100), 1e-8),
    takeProfit1: Math.max(entryPrice * (1 + s * tp1Pct / 100), 1e-8),
    takeProfit2: Math.max(entryPrice * (1 + s * tp2Pct / 100), 1e-8),
    tooVolatile,
    noiseFloorPct
  };
}

// ── Warm-up floor ─────────────────────────────────────────────────────────────

/** Candles needed before every indicator above can compute — including
 *  EMA200, the long pole (operator decision 2026-09-18, was 40). `calculateEMA`
 *  seeds its first point from a SMA of whatever it's given (`Math.min(period,
 *  values.length)`), so an "EMA200" computed on 40 candles was never a real
 *  200-period EMA — it was an SMA(40) mislabeled as one, and every trend-lane/
 *  veto decision reading `ema200` before this floor was raised was reading a
 *  number that had never actually converged. 250 gives EMA200 a genuine 50
 *  bars of convergence past its own period, comfortably inside the H1 fetch's
 *  own `targetCandles` (260, see TIMEFRAME_SPECS in marketDataService.ts) —
 *  raising this does not require fetching more data than the pipeline
 *  already retrieves. MACD's 35-bar warmup is covered trivially at this size. */
export const MIN_PRO_CANDLES = 250;

// ── §4/§5 — position-level exit ──────────────────────────────────────────────

export interface ProPositionView {
  entryPrice: number;
  /** LONG for every position this bot opens today (spot cannot short), but
   *  passed explicitly so the pnl below is never the long-only formula by
   *  accident — see positionPnlPercent. */
  isLong?: boolean;
  /** Set once TP1 has taken its half; the remainder then runs to TP2. */
  tp1Hit?: boolean;
  /** ATR-scaled levels as absolute prices (proStopTpLevels), reanchored to the
   *  fill by fillDueOrders. Absent → fall back to the flat §5 percentages. */
  stopLoss?: number;
  takeProfit1?: number;
  takeProfit2?: number;
  /** Best price seen since entry (highest for a long, lowest for a short).
   *  Required by the profit ratchet; absent it falls back to the live price. */
  peakPrice?: number;
  /** Peak profit % as of the last ratchet partial — the "new high required"
   *  re-arm state. See profitRatchet.ts. */
  ratchetPeakPct?: number;
  /** Remaining quantity / quantity at entry, for the ratchet's "free the
   *  slot" rule (RATCHET_MIN_REMAINING_FRACTION). */
  remainingQuantityFraction?: number;
  /** Fill time — required by the Pro Time Stop (opts.timeStopPeakTrail).
   *  Absent → that mechanism is skipped entirely (treated as "not yet due"). */
  openTimestamp?: number;
  /** SPOT or FUTURES — which BYBIT_FEES schedule the net break-even below
   *  reads. Absent → assumed SPOT (the historically-only case). */
  type?: 'SPOT' | 'FUTURES';
  /** Remaining quantity — with `entryFee`, lets net break-even use the fee
   *  ACTUALLY paid at entry instead of an assumed rate. Absent → falls back
   *  to the taker-rate assumption (see netBreakEvenPrice's own comment). */
  quantity?: number;
  /** Dollar fee actually paid at entry (SimPosition.entryFee), prorated to
   *  `quantity` if a partial has already fired. */
  entryFee?: number;
}

export interface ProExitDecision {
  shouldExit: boolean;
  /** PARTIAL_50 closes TP1_EXIT_FRACTION of the position and leaves the rest
   *  running; PARTIAL_RATCHET closes `ratchetFraction` of it; FULL closes
   *  what is left. */
  exitType?: 'FULL' | 'PARTIAL_50' | 'PARTIAL_RATCHET';
  reason: string;
  ratchetFraction?: number;
  /** Peak-at-last-partial to persist onto the remainder (the re-arm rule). */
  ratchetPeakPct?: number;
}

/**
 * §5's fixed-percentage exit, plus §4's "holding + a fresh SELL signal that
 * clears the confidence bar" exit. Both apply regardless of trend or ATR —
 * §5 gives no exception for either.
 */
export function evaluateProExit(
  pos: ProPositionView,
  currentPrice: number,
  currentSignal: ProSignalResult,
  minConfidence: number,
  /** Opt-in (default off — sim only, see proSimExecution.ts). At most one of
   *  the two should be on at once — see each flag's own note. */
  opts: {
    /** Hands every profit exit to the rung ladder and bypasses TP1/TP2 and
     *  the break-even runner stop. See profitRatchet.ts. */
    profitRatchet?: boolean;
    /** Operator decision 2026-09-17 — REPLACES profitRatchet for Pro. Past
     *  PRO_TIME_STOP_MINUTES: not in profit → close now; in profit → bypass
     *  TP1/TP2/break-even-runner and run free until a PRO_TIME_STOP_TRAIL_PCT
     *  pullback off the peak PRICE closes it. See the block below.
     *
     *  Confirmed side effect (2026-09-18, NOT a bug — checked when Pro's
     *  behavior visibly changed after this shipped): `profitRatchet: true`
     *  made `ratchet` a defined object on EVERY call, even while
     *  `action: 'HOLD'` (not yet armed) — so `!ratchet` was `false` always,
     *  and TP1/TP2/break-even-runner below (guarded by `!ratchet`) had been
     *  dead code for Pro since 2026-09-14, arming state notwithstanding.
     *  `timeStopPeakTrail` does not set `ratchet` at all, so `!ratchet` is
     *  now `true` before the checkpoint — TP1/TP2/break-even-runner are
     *  ACTIVE AGAIN for the first hours of a Pro position, for the first
     *  time in months. Confirmed as the intended behavior: before the
     *  checkpoint the ordinary gate governs; only past it does freeRunning
     *  take over. If a future change wants "hold with SL only until the
     *  checkpoint" instead, that needs its own explicit gate here — it is
     *  NOT what an absent `profitRatchet` alone gives you. */
    timeStopPeakTrail?: boolean;
  } = {},
  /** The engine's clock. Defaults to `Date.now()` so every existing caller
   *  (and every test not exercising timeStopPeakTrail) is unchanged. */
  now: number = Date.now()
): ProExitDecision {
  const isLong = pos.isLong ?? true;
  const changePercent = positionPnlPercent(pos.entryPrice, currentPrice, isLong);

  // Price-based, symmetric under isLong. A position that carries ATR-scaled
  // levels uses them; one opened before this change falls back to the flat §5
  // percentages so its behaviour is unchanged.
  const s = isLong ? 1 : -1;
  const structuralStopLoss = pos.stopLoss ?? pos.entryPrice * (1 - s * PRO_STOP_LOSS_PERCENT / 100);
  // Hard 4.2% loss cap, re-applied on every evaluation (2026-09-16) — the same
  // backstop Intraday/Path/Bybit all re-apply per tick, previously missing
  // here. Normally a no-op: proStopTpLevels already clamps the entry-time
  // stop to MAX_LOSS_PERCENT via resolveLadderPercents. This is the net for a
  // position carrying a wider stop than that path can currently produce (a
  // stale/migrated position, or a future change to proStopTpLevels) — pulled
  // in here, never loosened.
  const stopLoss = capStopLoss(pos.entryPrice, structuralStopLoss, isLong);
  const takeProfit1 = pos.takeProfit1 ?? pos.entryPrice * (1 + s * PRO_TAKE_PROFIT_PERCENT / 100);
  const takeProfit2 = pos.takeProfit2 ?? pos.entryPrice * (1 + s * TP2_PERCENT / 100);

  // Net break-even (operator decision 2026-09-18) — entryPrice adjusted for
  // the REAL round-trip cost, not the raw fill price. A runner parked at
  // "break-even" priced off raw entryPrice still hands back the entry fee
  // (and pays the exit fee on top) the moment it fills — a small but genuine
  // loss on a trade the operator meant to floor at zero. Entry fee uses what
  // was ACTUALLY paid (pos.entryFee, prorated by quantity) when available;
  // exit fee assumes taker, because every exit here crosses the book (SL/TP/
  // time-stop are never resting limit orders). NOT included: funding —
  // SimPosition/ProPositionView carry no PER-POSITION accumulated funding
  // anywhere in this codebase (funding is applied once, straight to account
  // equity, in simExecution.ts's applyFundingAccrual) — attributing it to one
  // position needs that plumbing built first. This is fees-only.
  const feeSchedule = pos.type === 'FUTURES' ? BYBIT_FEES.futures : BYBIT_FEES.spot;
  const entryNotional = typeof pos.quantity === 'number' && pos.quantity > 0
    ? pos.quantity * pos.entryPrice
    : undefined;
  const entryFeePct = entryNotional && typeof pos.entryFee === 'number'
    ? (pos.entryFee / entryNotional) * 100
    : feeSchedule.taker * 100;
  const exitFeePct = feeSchedule.taker * 100;
  const netBreakEvenPrice = pos.entryPrice * (1 + s * (entryFeePct + exitFeePct) / 100);

  // After TP1 has taken its half, the runner never gives back a loss: the stop
  // ratchets to NET break-even (not raw entryPrice — see above). It used to be
  // closed on the FIRST tick back below TP1 — a hair-trigger that booked the
  // runner out before TP2 could ever print (the same defect that was removed
  // from the Prev-4H bot). Now it rides to TP2, a real stop, or the
  // confidence-gated flip.
  const runnerStop = pos.tp1Hit
    ? (isLong ? Math.max(stopLoss, netBreakEvenPrice) : Math.min(stopLoss, netBreakEvenPrice))
    : stopLoss;

  // Profit ratchet (2026-09-14, operator decision, sim only). When on it owns
  // every profit exit: once the peak clears +1.8% it sells 30% of what is left
  // each time profit gives back 15% OF THE PEAK, re-arms only on a new high,
  // and closes the position entirely at break-even. TP1/TP2 and the break-even
  // runner stop below are bypassed — the stop loss and the SELL-signal flip
  // still apply. See profitRatchet.ts.
  const ratchet = opts.profitRatchet === true
    ? evaluateRatchet({
        entryPrice: pos.entryPrice,
        peakPrice: pos.peakPrice ?? currentPrice,
        livePrice: currentPrice,
        isLong,
        peakPctAtLastPartial: pos.ratchetPeakPct,
        remainingQuantityFraction: pos.remainingQuantityFraction
      })
    : undefined;

  if (ratchet && ratchet.action !== 'HOLD') {
    return {
      shouldExit: true,
      exitType: ratchet.action === 'FULL' ? 'FULL' : 'PARTIAL_RATCHET',
      reason: ratchetReason(ratchet),
      ratchetFraction: ratchet.fraction,
      ratchetPeakPct: ratchet.peakPctAtLastPartial
    };
  }

  // Pro Time Stop (2026-09-17, operator decision) — REPLACES the ratchet for
  // Pro (opts.timeStopPeakTrail instead of opts.profitRatchet at the
  // proSimExecution.ts call site). Past PRO_TIME_STOP_MINUTES held:
  //   · not in profit  → close now. The position has had its window; nothing
  //     downstream (TP1/TP2/runner stop) needs to run for a loser.
  //   · in profit      → freeRunning: TP1/TP2/the break-even runner stop are
  //     bypassed exactly like the ratchet bypasses them (below), and the
  //     ONLY thing that can close it from here is a PRO_TIME_STOP_TRAIL_PCT
  //     pullback off the peak PRICE (not a fraction of the peak PROFIT — a
  //     plain trailing stop, simpler than the ratchet's giveback formula,
  //     because "let it run" is the whole point past this checkpoint). The
  //     underlying stop loss still governs underneath this — see the
  //     `freeRunning ? stopLoss : runnerStop` below, same pattern `ratchet`
  //     already uses.
  let freeRunning = false;
  if (opts.timeStopPeakTrail === true && typeof pos.openTimestamp === 'number') {
    const heldMs = Math.max(0, now - pos.openTimestamp);
    if (heldMs >= PRO_TIME_STOP_MINUTES * 60_000) {
      const peak = pos.peakPrice ?? currentPrice;
      // "In profit" is NET profit (operator decision 2026-09-18) — past the
      // real round-trip cost, not just past the raw fill price. Read off the
      // PEAK, not currentPrice: this must be a STICKY, one-way classification
      // — a position that reached net profit at any point is free-running
      // from then on, protected by the floor below. Checking currentPrice
      // here instead would let a price that later dips back to (or through)
      // net break-even hit THIS "not profitable, close" branch again on a
      // later tick, even though the floored trail below exists precisely to
      // protect that exact case — the two branches would fight over the same
      // boundary and this one, being checked first, would always win,
      // silently making the floor below unreachable.
      const everNetProfitable = isLong ? peak > netBreakEvenPrice : peak < netBreakEvenPrice;
      if (!everNetProfitable) {
        return {
          shouldExit: true,
          exitType: 'FULL',
          reason: `Time Stop (${PRO_TIME_STOP_MINUTES} דק') — לא ברווח נטו (שינוי ${changePercent.toFixed(2)}%) — סגירה`
        };
      }
      freeRunning = true;
      const trailPrice = peak * (1 - s * PRO_TIME_STOP_TRAIL_PCT / 100);
      // The 0.6% trail may never turn a position that WAS in profit into a
      // loss (operator decision 2026-09-18): floor it (LONG) / ceiling it
      // (SHORT) at net break-even, taking whichever of the two is MORE
      // protective. `max`/`min` picks the higher/lower price respectively —
      // exactly the "runnerStop = max(netBE, peak×0.994)" / "min(netBE,
      // peak×1.006)" spec.
      const runnerFloorOrCeil = isLong
        ? Math.max(netBreakEvenPrice, trailPrice)
        : Math.min(netBreakEvenPrice, trailPrice);
      const trailHit = isLong ? currentPrice <= runnerFloorOrCeil : currentPrice >= runnerFloorOrCeil;
      if (trailHit) {
        const atNetBreakEven = Math.abs(runnerFloorOrCeil - netBreakEvenPrice) <= Math.abs(pos.entryPrice) * 1e-9;
        return {
          shouldExit: true,
          exitType: 'FULL',
          reason: atNetBreakEven
            ? `Time Stop (${PRO_TIME_STOP_MINUTES} דק') — נעילה ב-Net Break-Even $${runnerFloorOrCeil.toFixed(6)} (שינוי ${changePercent.toFixed(2)}%)`
            : `Time Stop (${PRO_TIME_STOP_MINUTES} דק') — נעילת רווח: ירידה של ${PRO_TIME_STOP_TRAIL_PCT}% משיא $${peak.toFixed(6)} (שינוי ${changePercent.toFixed(2)}%)`
        };
      }
    }
  }

  if (reachedStop(currentPrice, (ratchet || freeRunning) ? stopLoss : runnerStop, isLong)) {
    const atBreakEven = pos.tp1Hit && Math.abs(runnerStop - netBreakEvenPrice) <= Math.abs(pos.entryPrice) * 1e-9;
    return {
      shouldExit: true,
      exitType: 'FULL',
      reason: atBreakEven
        ? `Break-even stop אחרי TP1 ב-${runnerStop.toFixed(6)} (שינוי ${changePercent.toFixed(2)}%)`
        : `Stop Loss ב-${runnerStop.toFixed(6)} (שינוי ${changePercent.toFixed(2)}%)`
    };
  }
  // TP2 first: past it, there is nothing left to leave running.
  if (!ratchet && !freeRunning && reachedTarget(currentPrice, takeProfit2, isLong)) {
    return { shouldExit: true, exitType: 'FULL', reason: `TP2 ב-${takeProfit2.toFixed(6)} (שינוי ${changePercent.toFixed(2)}%)` };
  }
  if (!ratchet && !freeRunning && !pos.tp1Hit && reachedTarget(currentPrice, takeProfit1, isLong)) {
    return {
      shouldExit: true,
      exitType: 'PARTIAL_50',
      reason: `TP1 ב-${takeProfit1.toFixed(6)} (שינוי ${changePercent.toFixed(2)}%) — סגירת ${(TP1_EXIT_FRACTION * 100).toFixed(0)}%`
    };
  }
  // Confidence-gated flip: SELL closes a LONG, BUY closes a SHORT (2026-09-17
  // — symmetric now that Pro can hold either side; used to be SELL-only back
  // when every position was a LONG).
  //
  // Flip hysteresis (operator decision 2026-09-18): using the SAME threshold
  // for opening and flipping let a score wobbling around 78 flip a position
  // back and forth (BUY→SELL→BUY) on noise alone. Two independent conditions
  // now, both required:
  //   1. The flip signal's own confidence clears ENTRY threshold +
  //      PRO_FLIP_THRESHOLD_MARGIN (82 at today's 78 entry floor) — a higher
  //      bar than opening a fresh position needed.
  //   2. The opposing raw bucket score beats the position's OWN direction's
  //      raw score by at least PRO_FLIP_THRESHOLD_MARGIN points — not just
  //      "SELL is dominant", but "SELL is dominant BY A MARGIN" over what
  //      the position itself represents. Uses buyScore/sellScore (the raw,
  //      pre-confidence bucket totals) rather than `confidence`, which is
  //      already a blended single number and cannot answer "how much did
  //      the opposite side outscore this one".
  const flipThreshold = minConfidence + PRO_FLIP_THRESHOLD_MARGIN;
  const flipAction = isLong ? 'SELL' : 'BUY';
  const ownDirectionScore = isLong ? currentSignal.buyScore : currentSignal.sellScore;
  const opposingScore = isLong ? currentSignal.sellScore : currentSignal.buyScore;
  const scoreMargin = opposingScore - ownDirectionScore;
  if (
    currentSignal.action === flipAction &&
    currentSignal.confidence >= flipThreshold &&
    scoreMargin >= PRO_FLIP_THRESHOLD_MARGIN
  ) {
    return {
      shouldExit: true,
      exitType: 'FULL',
      reason: `היפוך אות (Flip Hysteresis): ${flipAction} בביטחון ${currentSignal.confidence.toFixed(1)} >= ${flipThreshold}, פער ניקוד ${scoreMargin.toFixed(1)} >= ${PRO_FLIP_THRESHOLD_MARGIN}`
    };
  }
  return { shouldExit: false, reason: '' };
}
