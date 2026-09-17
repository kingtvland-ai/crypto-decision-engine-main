/**
 * @cde/engine/analysis — the Pro algorithm, the Multi-Timeframe intraday
 * engine and its internals, and general technical-analysis utilities.
 * ============================================================================
 */

// ── Pro engine (alg.md — weighted-indicator confidence engine) ──────────────
export type {
  ProIndicatorSignal, ProSignalResult, ProRiskLevel, ProPositionView, ProExitDecision
} from './services/proAlgEngine';
export {
  computeProSignal,
  aggregateProBuckets,
  proTechnicalScore,
  proMinConfidence,
  calculateOptimalEntryPrice,
  evaluateProExit,
  PRO_INDICATOR_WEIGHTS,
  PRO_COVERAGE_FULL_WEIGHT,
  PRO_CORRELATED_CLUSTER,
  PRO_SHORT_TREND_VETO_1H_RETURN_PCT,
  PRO_TIME_STOP_MINUTES,
  PRO_TIME_STOP_TRAIL_PCT,
  PRO_CONFIDENCE_BY_RISK,
  PRO_ENTRY_ALLOCATION_PERCENT,
  PRO_DEFAULT_ENTRY_CONFIDENCE,
  PRO_TAKE_PROFIT_PERCENT,
  PRO_STOP_LOSS_PERCENT,
  PRO_STOP_ATR_MULT,
  PRO_STOP_MIN_PERCENT,
  proStopTpLevels,
  proMaxEntryDiscountPercent,
  PRO_MAX_ENTRY_DISCOUNT_PCT,
  PRO_ENTRY_DISCOUNT_STOP_FRACTION,
  MIN_PRO_CANDLES as PRO_ALG_MIN_CANDLES
} from './services/proAlgEngine';

export {
  evaluateFundingGate,
  annualisedFundingPct,
  FUNDING_PERIODS_PER_YEAR,
  FUNDING_CROWDED_ANNUAL_PCT,
  FUNDING_EXTREME_ANNUAL_PCT,
  FUNDING_MIN_SIZE_MULTIPLIER,
  FUNDING_MAX_AGE_MS
} from './services/fundingRate';
export type { FundingSnapshot, FundingVerdict } from './services/fundingRate';

// ── Derivatives regime: Open Interest + Long/Short ratio + sell-pressure ─────
export {
  classifyOpenInterestTrend,
  classifyLongShortSentiment,
  evaluateDerivativesRegime,
  detectSellPressure,
  OI_TREND_THRESHOLD_PCT,
  LONG_SHORT_CROWDED_LONG_RATIO,
  LONG_SHORT_CROWDED_SHORT_RATIO,
  SELL_PRESSURE_REL_VOLUME,
  SELL_PRESSURE_MIN_DROP_PCT
} from './services/derivativesRegime';
export type {
  OpenInterestPoint,
  LongShortPoint,
  OpenInterestTrend,
  OpenInterestVerdict,
  LongShortSentiment,
  DerivativesSnapshot,
  DerivativesRegimeVerdict,
  SellPressureInput,
  SellPressureVerdict
} from './services/derivativesRegime';

// ── Multi-Timeframe intraday engine ──────────────────────────────────────────
export type { IntradayDecisionInput, IntradayDecision } from './services/intradayEngine';
export { evaluateIntradayDecision } from './services/intradayEngine';
// Named distinctly from the main `TradeType` (index.ts) — this one is the
// intraday engine's own narrower 'SPOT' | 'FUTURES' union, not the shared
// 'SPOT' | 'FUTURES' | 'HOLD' one.
export type { TradeType as IntradayTradeType } from './services/intradayEngine';

export type { BacktestHistory, BacktestTrade, BacktestMetrics, BacktestResult, WalkForwardWindow, WalkForwardResult } from './services/intradayBacktest';
export { runBacktest, runWalkForward, runRiskVariants } from './services/intradayBacktest';

export type { Entry5M } from './services/intradayEntry';
export { confirmEntry5M } from './services/intradayEntry';

export type { ExitReasonCode, IntradayPositionView, IntradayExitContext, IntradayExitDecision } from './services/intradayExit';
export { evaluateIntradayExit } from './services/intradayExit';

export type { Regime1H } from './services/intradayRegime';
export { detectRegime1H } from './services/intradayRegime';

export type { SetupScores, Setup15M } from './services/intradaySetup';
export { detectSetup15M } from './services/intradaySetup';

export type { CostAnalysis, CostInput, RiskPlanInput, RiskPlan as IntradayRiskPlan } from './services/intradayRisk';
export { evaluateCostEdge, buildRiskPlan, validateLevelDirection, FIXED_TP_PERCENT } from './services/intradayRisk';
export { MAX_LOSS_PERCENT, TP1_EXIT_FRACTION, weightedAverageExit, capStopLoss } from './services/exitPolicy';
export type { ExitLevel } from './services/exitPolicy';

export {
  FIXED_SL_PCT, FIXED_TP1_PCT, FIXED_TP2_PCT,
  SURGE_REL_VOLUME, SURGE_VOLUME_LOOKBACK, SURGE_MIN_SL_PCT, SURGE_MAX_SL_PCT,
  TP2_MIN_REWARD_RISK,
  MIN_STOP_ATR_MULT, VOLATILITY_EXPANSION_RATIO, NOISE_PERCENTILE,
  EXPANSION_FAST_BARS, EXPANSION_SLOW_BARS,
  isBuyingSurge, resolveLadderPercents,
  noiseFloorStopPct, atrPercentOf, badBarPercent, measureStopNoise,
  detectVolatilityExpansion, effectiveAtrPercent
} from './services/calmRegime';
export type { LadderPercents, VolatilityExpansion, StopNoise } from './services/calmRegime';

export {
  RATCHET_ARM_PCT, RATCHET_GIVEBACK_FRACTION,
  RATCHET_PARTIAL_FRACTION, RATCHET_MIN_REMAINING_FRACTION,
  evaluateRatchet, ratchetReason, ratchetLevels
} from './services/profitRatchet';
export type {
  RatchetInput, RatchetDecision, RatchetAction, RatchetFullReason, RatchetLevels
} from './services/profitRatchet';


export type { ScoreContext } from './services/intradaySetupScores';
export { scoreTrend, scoreMomentum, scoreLocation, scoreParticipation, scoreStructure, retracementAtr } from './services/intradaySetupScores';

// Low-level indicator/statistics library shared by the intraday engine.
export type {
  MacdResult, BollingerResult, StochasticResult, VolatilityBucket, AtrRegimeResult,
  VwapResult, VolumeStats, Swing, StructureBias, MarketStructureResult,
  CompressionResult, CandleQuality
} from './services/intradayIndicators';
export {
  last, clamp, ramp, mean, stdDev, percentileRank, simpleMovingAverage,
  rsiSeries, rsi, macd, bollinger, stochastic, atrRegime, sessionVwap,
  volumeStats, findSwings, marketStructure, compression, candleQuality,
  seededRandom, hashString
} from './services/intradayIndicators';

// ── General technical analysis (used by the AdvancedAnalysis page) ──────────
export {
  calculateRSI,
  calculateMovingAverage,
  calculateStandardDeviation,
  calculateBollingerBands,
  calculateVolumeProfile,
  analyzeVolumeTrend,
  calculateTechnicalIndicators,
  calculateTechnicalScore
} from './utils/technicalAnalysis';

export type { MACDResult, StochasticResult as AdvancedStochasticResult, FibonacciLevels, SupportResistance } from './utils/advancedTechnicalAnalysis';
export {
  calculateMACD,
  calculateStochastic,
  calculateFibonacci,
  calculateSupportResistance,
  calculateAdvancedIndicators
} from './utils/advancedTechnicalAnalysis';

export { generateSmartRecommendation } from './utils/smartRecommendationEngine';

// ── 4H Path engine (bot 4) ───────────────────────────────────────────────────
export {
  aggregateToH4,
  evaluatePathDecision,
  pathKellyFraction,
  pathRiskUnit,
  PATH_MAX_HOLD_MS,
  PATH_TIME_STOP_MS
} from './services/pathEngine';
export type { PathDecision, PathDecisionInput, PathGate } from './services/pathEngine';
export {
  buildPathTable,
  measureBarPaths,
  labelBarState,
  riskUnitFrom15M,
  prior15mFor,
  PATH_RISK_UNIT_ATR_MULT,
  RISK_UNIT_LOOKBACK_15M,
  selectBucket,
  wilsonLowerBound,
  recencyWeight,
  fearGreedBucket,
  barOpenFor,
  slotIndexAt,
  stateKey,
  bucketKey,
  SLOTS_PER_BAR,
  BAR_MS,
  SLOT_MS,
  TP_GRID_R,
  MIN_BUCKET_SAMPLES,
  DEFAULT_COST_R
} from './services/pathStudy';
export type { PathBucket, PathOutcome, BarState, PathDirection, PathRegime, FearGreedBucket } from './services/pathStudy';
export {
  buildValidatedPathTable,
  buildWalkForwardWindows,
  scoreBucketOutOfSample
} from './services/pathStudy';
// WalkForwardWindow is aliased: intradayBacktest.ts already exports a type of
// that name for a different thing (a backtest window, not a study split).
export type {
  ValidatedBucket,
  WalkForwardWindow as PathWalkForwardWindow,
  WalkForwardReport,
  WalkForwardOptions
} from './services/pathStudy';
export {
  fetchFearGreedHistory,
  buildFearGreedSeries,
  parseFearGreedPayload,
  fearGreedAt,
  utcDayStart
} from './services/fearGreedHistory';
export type { FearGreedPoint, FearGreedSeries } from './services/fearGreedHistory';

// ── Prev-4H Range (the "נתיב 4H" sim bot — breakout of the previous closed
//    4H candle's high/low, filtered by the 4H EMA20 trend; simulation only).
//    Replaced the empirical-bucket Path engine. Order generation is in
//    @cde/engine/execution. ──────────────────────────────────────────────────
export {
  evaluatePrev4hRange,
  readPrev4hRangePlan,
  DEFAULT_PREV4H_RANGE_PARAMS,
  maxAdmissibleExtensionMult,
  PREV4H_MIN_H4_BARS,
  PREV4H_MIN_H1_CANDLES
} from './services/prev4hRange';
export type {
  Prev4hRangeParams,
  Prev4hRangePlan,
  Prev4hRangeState,
  Prev4hRangeReason,
  Prev4hRangeInput
} from './services/prev4hRange';

// ── TrendBreakout (the "Bybit" sim bot — an independent trend-following
//    breakout strategy; simulation only). Its signal function lives here; its
//    order generation is in @cde/engine/execution alongside the other bots'. ──
export {
  evaluateTrendBreakout,
  readTrendBreakoutPlan,
  computeConfidence as computeTrendBreakoutConfidence,
  donchian,
  volumeSMA,
  DEFAULT_TREND_BREAKOUT_PARAMS
} from './services/trendBreakout';
export type {
  TrendBreakoutParams,
  TrendBreakoutPlan,
  TrendBreakoutState,
  TrendBreakoutReason,
  TrendDirection,
  TrendBreakoutInput
} from './services/trendBreakout';
