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
 *     Stochastic 8, Volume Profile 15, Sentiment 10, 24h-change 12.
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
 *     Bollinger position, sentiment 20/35/70/80, momentum ±3%/±8%). These are
 *     NOT re-derived here: they are the exact bands already used by this
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
 *   - Sentiment direction: implemented as the conventional contrarian reading
 *     (extreme fear → buy pressure, extreme greed → sell pressure). §2 lists
 *     Sentiment as an input weighted 10 without stating a direction; the
 *     contrarian convention is the standard reading of a Fear & Greed index
 *     and is what smartRecommendationEngine.ts already does.
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
import { formatDynamicPrice } from './tradeEngine';
import {
  calculateRSI,
  calculateMovingAverage,
  calculateBollingerBands,
  calculateVolumeProfile,
  calculateTechnicalScore
} from '../utils/technicalAnalysis';
import { calculateMACD, calculateStochastic } from '../utils/advancedTechnicalAnalysis';
import type { HistoricalPrice, TechnicalIndicators } from '../types/crypto';

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
  SENTIMENT: 10,
  MOMENTUM_24H: 12
} as const;

/**
 * §2's coverage denominator, literally — 88.
 *
 * The eight weights above sum to 105, not 88; alg.md gives 88 as the coverage
 * denominator without reconciling that gap, and this file does not resolve it
 * on the doc's behalf. The practical effect: once every indicator has enough
 * history to vote, totalWeight (105) exceeds 88 and coverage clamps to its
 * ceiling of 1 — so the discrepancy only matters during the indicator warm-up
 * window, where it makes coverage reach 1 slightly sooner than a
 * weights-sum-to-88 world would.
 */
export const PRO_COVERAGE_FULL_WEIGHT = 88;

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

// MA(20) — no precedent in this codebase for a bare price-vs-MA signal; the
// ±2% band and the two-tier confidence are a SUGGESTED STARTING VALUE mirroring
// the RSI/Bollinger convention already used below, not a measured threshold.
function voteMa(currentPrice: number, ma20: number, signals: ProIndicatorSignal[]): void {
  const w = PRO_INDICATOR_WEIGHTS.MA;
  if (!(ma20 > 0)) { pushVote(signals, 'MA(20)', w, 'HOLD', 50, 'אין מספיק היסטוריה לממוצע נע 20'); return; }
  const distPct = ((currentPrice - ma20) / ma20) * 100;
  if (distPct > 2) pushVote(signals, 'MA(20)', w, 'BUY', 80, `מחיר ${distPct.toFixed(1)}% מעל MA20 ($${formatDynamicPrice(ma20)})`);
  else if (distPct > 0.1) pushVote(signals, 'MA(20)', w, 'BUY', 60, `מחיר מעל MA20 (${distPct.toFixed(1)}%)`);
  else if (distPct < -2) pushVote(signals, 'MA(20)', w, 'SELL', 80, `מחיר ${Math.abs(distPct).toFixed(1)}% מתחת ל-MA20 ($${formatDynamicPrice(ma20)})`);
  else if (distPct < -0.1) pushVote(signals, 'MA(20)', w, 'SELL', 60, `מחיר מתחת ל-MA20 (${Math.abs(distPct).toFixed(1)}%)`);
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

// Sentiment (Fear & Greed 0-100) — contrarian reading; same bands as
// smartRecommendationEngine.ts's analyzeMarketSentiment.
function voteSentiment(fearGreedIndex: number, signals: ProIndicatorSignal[]): void {
  const w = PRO_INDICATOR_WEIGHTS.SENTIMENT;
  if (fearGreedIndex <= 20) pushVote(signals, 'Sentiment (F&G)', w, 'BUY', 85, `פחד קיצוני בשוק (${fearGreedIndex}) — הזדמנות קנייה`);
  else if (fearGreedIndex <= 35) pushVote(signals, 'Sentiment (F&G)', w, 'BUY', 70, `פחד בשוק (${fearGreedIndex})`);
  else if (fearGreedIndex >= 80) pushVote(signals, 'Sentiment (F&G)', w, 'SELL', 80, `חמדנות קיצונית (${fearGreedIndex})`);
  else if (fearGreedIndex >= 70) pushVote(signals, 'Sentiment (F&G)', w, 'SELL', 65, `חמדנות בשוק (${fearGreedIndex})`);
  else pushVote(signals, 'Sentiment (F&G)', w, 'HOLD', 60, `סנטימנט ניטרלי (${fearGreedIndex})`);
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

// ── §2 — the aggregate result ────────────────────────────────────────────────

export interface ProSignalResult {
  action: 'BUY' | 'SELL' | 'HOLD';
  buyScore: number;
  sellScore: number;
  holdScore: number;
  totalWeight: number;
  /** §2's formula, verbatim. 0-100. */
  confidence: number;
  signals: ProIndicatorSignal[];
  /** Full per-indicator breakdown, for the technical-score line in the UI. */
  indicators: TechnicalIndicators;
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
  priceChange24h: number,
  fearGreedIndex: number = 50
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

  const signals: ProIndicatorSignal[] = [];
  voteRsi(rsi, signals);
  voteMa(currentPrice, ma20, signals);
  voteMacd(macd, signals);
  voteBollinger(bb, currentPrice, signals);
  voteStochastic(stochastic, signals);
  voteVolumeProfile(vp, signals);
  voteSentiment(fearGreedIndex, signals);
  voteMomentum24h(priceChange24h, signals);

  // §2's scoring: weighted = weight × (confidence/100), routed to whichever
  // bucket the indicator voted for; totalWeight sums every indicator's OWN
  // weight regardless of which bucket it fed.
  let buyScore = 0, sellScore = 0, holdScore = 0, totalWeight = 0;
  for (const s of signals) {
    const weighted = s.weight * (s.confidence / 100);
    if (s.signal === 'BUY') buyScore += weighted;
    else if (s.signal === 'SELL') sellScore += weighted;
    else holdScore += weighted;
    totalWeight += s.weight;
  }
  buyScore = Number(buyScore.toFixed(2));
  sellScore = Number(sellScore.toFixed(2));
  holdScore = Number(holdScore.toFixed(2));

  const maxScore = Math.max(buyScore, sellScore, holdScore);
  // Tie-break not specified by §2: HOLD wins a draw, as the safer default.
  const action: 'BUY' | 'SELL' | 'HOLD' =
    maxScore === holdScore ? 'HOLD' : maxScore === buyScore ? 'BUY' : 'SELL';

  const secondScore = [buyScore, sellScore, holdScore].sort((a, b) => b - a)[1] ?? 0;
  const dominance = totalWeight > 0 ? maxScore / totalWeight : 0;
  const margin = maxScore > 0 ? (maxScore - secondScore) / maxScore : 0;
  const coverage = Math.min(1, totalWeight / PRO_COVERAGE_FULL_WEIGHT);

  const rawConfidence = 50 + (dominance * 45 + margin * 25) * coverage - (1 - coverage) * 10;
  // §2 does not state a clamp; confidence is reported as a percentage
  // everywhere downstream, so it is bounded to [0,100] rather than left to
  // exceed that range on an edge case.
  const confidence = Number(Math.max(0, Math.min(100, rawConfidence)).toFixed(1));

  return {
    action,
    buyScore,
    sellScore,
    holdScore,
    totalWeight,
    confidence,
    signals,
    indicators: { rsi, ma20, volumeTrend: 'stable', bollingerBands: bb, volumeProfile: vp, macd, stochastic }
  };
}

/** For the reasoning line — reuses the existing composite technical score. */
export function proTechnicalScore(result: ProSignalResult): number {
  return calculateTechnicalScore(result.indicators);
}

// ── §3 — risk-level thresholds ───────────────────────────────────────────────

export type ProRiskLevel = 'low' | 'medium' | 'high';

/** §3's table, literally: minConfidence / allocation% per risk level. */
export const PRO_CONFIDENCE_BY_RISK: Record<ProRiskLevel, number> = { low: 55, medium: 40, high: 25 };
export const PRO_ALLOCATION_BY_RISK: Record<ProRiskLevel, number> = { low: 0.15, medium: 0.25, high: 0.40 };

/** §3: `minConfidenceOverride > 0 ? minConfidenceOverride : CONFIDENCE_BY_RISK[riskLevel]`. */
export function proMinConfidence(riskLevel: ProRiskLevel, override?: number): number {
  return typeof override === 'number' && override > 0 ? override : PRO_CONFIDENCE_BY_RISK[riskLevel];
}

/** §3/§6: allocation is a function of risk level alone — there is no override
 *  for it in §3, unlike the confidence threshold. */
export function proAllocationPercent(riskLevel: ProRiskLevel): number {
  return PRO_ALLOCATION_BY_RISK[riskLevel];
}

// ── §5 — fixed exit percentages ──────────────────────────────────────────────

/** §5, literally: "Take Profit 3%, Stop Loss 4.2%". Not ATR-scaled. */
export const PRO_TAKE_PROFIT_PERCENT = 3;
export const PRO_STOP_LOSS_PERCENT = 4.2;

// ── Warm-up floor ─────────────────────────────────────────────────────────────

/** Candles needed before every indicator above can compute (MACD's 26+9 is
 *  the longest). Not part of §2 — alg.md does not state a warm-up
 *  requirement, this is purely "how much history the math needs". */
export const MIN_PRO_CANDLES = 40;

// ── §4/§5 — position-level exit ──────────────────────────────────────────────

export interface ProPositionView {
  entryPrice: number;
}

export interface ProExitDecision {
  shouldExit: boolean;
  reason: string;
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
  minConfidence: number
): ProExitDecision {
  const changePercent = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

  if (changePercent <= -PRO_STOP_LOSS_PERCENT) {
    return { shouldExit: true, reason: `Stop Loss: שינוי ${changePercent.toFixed(2)}% <= -${PRO_STOP_LOSS_PERCENT}%` };
  }
  if (changePercent >= PRO_TAKE_PROFIT_PERCENT) {
    return { shouldExit: true, reason: `Take Profit: שינוי ${changePercent.toFixed(2)}% >= ${PRO_TAKE_PROFIT_PERCENT}%` };
  }
  if (currentSignal.action === 'SELL' && currentSignal.confidence >= minConfidence) {
    return { shouldExit: true, reason: `היפוך אות: SELL בביטחון ${currentSignal.confidence.toFixed(1)} >= ${minConfidence}` };
  }
  return { shouldExit: false, reason: '' };
}
