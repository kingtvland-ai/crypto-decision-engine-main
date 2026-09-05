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
  proTechnicalScore,
  proMinConfidence,
  proAllocationPercent,
  evaluateProExit,
  PRO_INDICATOR_WEIGHTS,
  PRO_COVERAGE_FULL_WEIGHT,
  PRO_CONFIDENCE_BY_RISK,
  PRO_ALLOCATION_BY_RISK,
  PRO_TAKE_PROFIT_PERCENT,
  PRO_STOP_LOSS_PERCENT,
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
export { evaluateCostEdge, buildRiskPlan } from './services/intradayRisk';

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
