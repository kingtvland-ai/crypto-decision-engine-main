/**
 * DecisionEngine — unified decision-making framework
 * ============================================================================
 * Public API for the DecisionEngine module.
 *
 * Only Intraday (the real bot's multi-timeframe engine) and Path (bot 4) use
 * this pipeline framework. Legacy has been deleted, and Pro's alg.md algorithm
 * is a single weighted score with no stages to pipeline — it calls
 * `computeProSignal` / `generateProOrders` directly (see
 * `server/proSimEngine.ts`), the same way Path used to be the odd one out.
 *
 * Usage:
 *   import { DecisionEngine, IntradayAdapter, PathAdapter } from './decisionEngine';
 *
 *   const engine = new DecisionEngine();
 *   engine.registerAdapter(new IntradayAdapter());
 *   engine.registerAdapter(new PathAdapter());
 *
 *   const result = await engine.evaluate({
 *     symbol: 'BTCUSDT',
 *     candles: { h1: [...], m15: [...], m5: [...] },
 *     currentPrice: 67500,
 *     portfolio: { ... },
 *     openPositions: [],
 *     marketData: { ... },
 *     params: { ... }
 *   });
 */

export { DecisionEngine } from './orchestrator';
export type { DecisionEngineOptions } from './orchestrator';

export { IntradayAdapter } from './adapters/intradayAdapter';
export { PathAdapter } from './adapters/pathAdapter';
export type { PathEngineParams } from './adapters/pathAdapter';

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
} from './types';
