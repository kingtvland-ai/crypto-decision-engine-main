/**
 * DecisionEngine — unified decision-making framework
 * ============================================================================
 * Public API for the DecisionEngine module.
 *
 * Intraday (the real bot's multi-timeframe engine) is the ONLY engine that
 * runs through this pipeline framework. The other three sim bots call their
 * strategy directly — Pro's alg.md algorithm is a single weighted score with
 * no stages to pipeline (`server/proSimEngine.ts`), and Path/TrendBreakout
 * likewise (`server/pathSimEngine.ts`, `server/bybitSimEngine.ts`).
 *
 * A `PathAdapter` used to be exported here and shown registered in the usage
 * example below, wrapping the empirical-bucket engine in `pathEngine.ts`
 * (16-slot lookup, Wilson lower bound, Kelly sizing). Nothing ever registered
 * it: the sim bot named "Path" runs `prev4hRange.ts`, which replaced that
 * strategy. An exported-and-documented adapter for a strategy no bot runs is
 * a trap — the example itself was the instruction for wiring it back in — so
 * the adapter was removed on 2026-09-16. `pathEngine.ts` itself stays: it
 * still owns `aggregateToH4`, which prev4hRange.ts depends on.
 *
 * Usage:
 *   import { DecisionEngine, IntradayAdapter } from './decisionEngine';
 *
 *   const engine = new DecisionEngine();
 *   engine.registerAdapter(new IntradayAdapter());
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
