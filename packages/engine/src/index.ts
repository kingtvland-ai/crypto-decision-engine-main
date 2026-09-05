/**
 * @cde/engine — public surface, decision layer
 * ============================================================================
 * The DecisionEngine itself, its three adapters, every DecisionEngine type,
 * the shared domain types (Candle, CryptoData, PortfolioItem, …), the
 * decision→UI bridge, intraday parameter config, and the correlation gate.
 *
 * This is a curated surface, not `export *` from every file in the package —
 * see the other three entry points (./market-data, ./execution, ./analysis)
 * for the rest. What is not exported from one of the four is internal to the
 * package and must not be reached by a deep import.
 */

// ── Decision engine ──────────────────────────────────────────────────────────
export { DecisionEngine } from './services/decisionEngine';
export type { DecisionEngineOptions } from './services/decisionEngine';
export { IntradayAdapter, PathAdapter } from './services/decisionEngine';
export type {
  DecisionContext,
  DecisionResult,
  EngineAdapter,
  PipelineStage,
  StageResult,
  EngineId,
  RiskPlan,
  TradeDirection,
  TradeType,
  DecisionOutcome,
  EngineParams,
  MarketDataSnapshot,
  PortfolioRiskStats,
  OpenPosition,
  MultiTimeframeCandles,
  ClosedTradeRecord
} from './services/decisionEngine';

// ── Core OHLCV type — used across every entry point ──────────────────────────
export type { Candle } from './services/tradeEngine';

// ── Domain types (crypto data, portfolio, recommendations, …) ───────────────
export type {
  CryptoData,
  HistoricalPrice,
  BollingerBands,
  VolumeProfile,
  MACDIndicator,
  StochasticIndicator,
  FibonacciLevels,
  SupportResistance,
  TechnicalIndicators,
  FearGreedIndex,
  RecommendationType,
  CryptoRecommendation,
  PortfolioItem,
  Portfolio,
  PortfolioAnalysis,
  CryptoChartData,
  MarketSentiment,
  RiskMetrics,
  EnhancedCryptoData,
  MarketRegimeType,
  MarketDirectionType,
  VolatilityRegimeType,
  TradeSide,
  MarketRegimeResult,
  IndicatorSignalDetail,
  SignalEngineResult,
  TradeRouterResult,
  RiskParametersResult,
  TradeEngineEvaluation,
  ActivePosition
} from './types/crypto';

// ── Decision → UI bridge ─────────────────────────────────────────────────────
// Converts a raw DecisionResult into the SignalEvaluation / DecisionFactor
// shape the frontend and the worker both render. See intradayBridge.ts.
export type { DecisionFactor, SignalEvaluation, PortfolioInput, EvaluateUniverseOptions, ExitPositionInput, ExitPortfolioInput } from './services/intradayBridge';
export {
  buildPortfolioRiskStats,
  mapDecisionToSignalEvaluation,
  evaluateSymbolFromSnapshot,
  evaluateUniverse,
  fetchSymbolSnapshot,
  computeAtr5,
  buildExitView,
  evaluatePositionExit,
  buildFactorsFromDecisionResult
} from './services/intradayBridge';

// ── Intraday engine configuration ────────────────────────────────────────────
export type { Regime1HType, SetupType, Direction, EntryTrigger, DecisionGate, IntradayParams } from './services/intradayParams';
export { DEFAULT_INTRADAY_PARAMS, RISK_VARIANTS, withParams } from './services/intradayParams';

// ── Correlation gate ─────────────────────────────────────────────────────────
export type { PositionDirection, CorrelatedHolding, CorrelationMatch, CorrelationGateInput, CorrelationGateResult } from './services/correlation';
export {
  DEFAULT_CORRELATION_LOOKBACK,
  DEFAULT_CORRELATION_THRESHOLD,
  DEFAULT_MAX_CORRELATED,
  MIN_CORRELATION_SAMPLES,
  toPositionDirection,
  toLogReturns,
  alignCloses,
  pearsonCorrelation,
  correlationBetween,
  evaluateCorrelationGate,
  resolveCorrelationLookback,
  CORRELATION_LOOKBACK_FLOOR
} from './services/correlation';
