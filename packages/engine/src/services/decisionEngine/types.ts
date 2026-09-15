/**
 * DecisionEngine — unified decision-making framework
 * ============================================================================
 * A single orchestrator that runs any of the three trading algorithms
 * (Intraday MTF, Legacy H1, Pro alg.md) through a common pipeline.
 *
 * Each engine's specific logic lives in its own adapter, which implements
 * the EngineAdapter interface. The orchestrator handles:
 *   - Adapter selection based on input capabilities
 *   - Pipeline execution with stage-level blocking
 *   - Unified result normalization
 *   - Cross-cutting concerns (logging, metrics, correlation)
 *
 * The three engines remain completely independent in their algorithms —
 * this framework only unifies the orchestration, not the logic.
 */

// `Candle` and `ClosedTradeRecord` are USED by the declarations below, so they
// must be IMPORTED here. The previous version only re-exported them
// (`export type { X } from '...'`), which publishes the name to consumers but
// does NOT bind it inside this module — hence "Cannot find name 'Candle'".
import type { Candle } from '../tradeEngine';
import type { ClosedTradeRecord } from '../adaptiveRisk';
import type { DerivativesSnapshot } from '../derivativesRegime';
import type { VolatilityProfile } from '../../types/volatilityProfile';

// ── Shared Types ──────────────────────────────────────────────────────────────

export type TradeDirection = 'LONG' | 'SHORT' | 'BUY' | 'SELL' | 'NONE';
export type TradeType = 'SPOT' | 'FUTURES' | 'HOLD';
export type DecisionOutcome = 'SIGNAL' | 'NO_SIGNAL' | 'NO_DATA';
export type EngineId = 'intraday' | 'pro' | 'path';
/** What a DecisionResult may report: a real engine, or 'unknown' when no
 *  adapter could handle the input at all. */
export type ResultEngineId = EngineId | 'unknown';

/** Market data snapshot — what the engine needs to evaluate a symbol */
export interface MarketDataSnapshot {
  spreadPercent?: number;
  quoteVolume24h?: number;
  quoteVolume24hSpot?: number;
  livePrice?: number;
  fearGreedIndex?: number;
  priceChange24h?: number;
  marketCap?: number;
  volume24h?: number;
  /** Current perpetual funding for this symbol. Optional throughout: the
   *  funding gate abstains when it is missing or stale, so a feed outage costs
   *  the engines an opinion, not their ability to trade. */
  funding?: { lastFundingRate: number; at: number };
  /** Macro Layer (2026-09-16): Open Interest history + Long/Short ratio for
   *  this symbol, from Bybit's own free public endpoints. Same rule as
   *  `funding` — optional, abstains rather than blocks when absent. See
   *  derivativesRegime.ts. */
  derivatives?: DerivativesSnapshot;
}

/** Portfolio risk statistics — shared across all engines */
export interface PortfolioRiskStats {
  portfolioValue: number;
  initialAmount: number;
  dailyDrawdownPercent: number;
  weeklyDrawdownPercent: number;
  openPositionsCount: number;
  openFuturesPositionsCount: number;
  totalLeveragedExposureUsd: number;
  existingExposureByAsset?: Record<string, number>;
  systemLocked?: boolean;
  lockReason?: string;
  lockedAt?: number;
}

/** Open position — shared across all engines */
export interface OpenPosition {
  symbol: string;
  type: 'SPOT' | 'FUTURES';
  side: 'BUY' | 'SELL' | 'LONG' | 'SHORT';
  /** Candle history for correlation gate (optional — populated when available) */
  candles?: Candle[];
}

/** Multi-timeframe candles — each engine uses what it needs */
export interface MultiTimeframeCandles {
  h1: Candle[];
  m15?: Candle[];
  m5?: Candle[];
}

/** Engine-specific parameters — each engine defines its own */
export interface EngineParams {
  [key: string]: unknown;
}

/** Unified decision context — input to any engine */
export interface DecisionContext {
  /** Trading symbol (e.g. 'BTCUSDT') */
  symbol: string;
  /** Candles for all timeframes — engine uses what it needs */
  candles: MultiTimeframeCandles;
  /** Current market price */
  currentPrice: number;
  /** Portfolio state */
  portfolio: PortfolioRiskStats;
  /** Currently open positions (for same-asset exclusion, correlation) */
  openPositions: OpenPosition[];
  /** Market data snapshot */
  marketData: MarketDataSnapshot;
  /** Engine-specific parameters */
  params: EngineParams;
  /** Timestamp (for backtest determinism) */
  now?: number;
  /** Closed trade history (for adaptive sizing) */
  closedTrades?: ClosedTradeRecord[];
  /** Configuration overrides */
  config?: {
    minConfidenceOverride?: number;
    maxPositions?: number;
    maxFuturesPositions?: number;
    executionDelaySec?: number;
    /** How the entry will ACTUALLY fill, for the §25 cost/edge model. The
     *  simulations execute MARKET by default (`proLimitEntries` off) but the
     *  cost gate defaulted to the cheaper resting-LIMIT assumption, so every
     *  trade was evaluated with an optimistic round-trip cost. Pass
     *  `config.proLimitEntries === true` here. Absent → engine default (true =
     *  the live bot / backtest, which do rest limits). */
    entryIsLimit?: boolean;
    /** Deterministic Dynamic Volatility Profile store (sim only — see
     *  server/volatilityProfileStore.ts). Absent = every adapter's volatility
     *  ladder is a no-op, unchanged from before this field existed. Threaded
     *  through here rather than a top-level DecisionContext field because
     *  this is the same "operator config, not market data" bucket
     *  maxPositions/entryIsLimit already live in. */
    volatilityProfiles?: Map<string, VolatilityProfile>;
  };
}

/** Unified decision result — output from any engine */
export interface DecisionResult {
  /** Which engine produced this result ('unknown' = no adapter matched) */
  engineId: ResultEngineId;
  /** Symbol */
  symbol: string;
  /** Outcome */
  outcome: DecisionOutcome;
  /** First failing gate, or 'APPROVED' when trade is approved */
  gate: string;
  /** Trade type (SPOT, FUTURES, or HOLD) */
  tradeType: TradeType;
  /** Trade direction */
  direction: TradeDirection;
  /** Confidence score (0-100) */
  confidence: number;
  /** Risk plan (SL, TP, leverage, size) — null if no trade */
  riskPlan: RiskPlan | null;
  /** Human-readable reasoning */
  reasoning: string[];
  /** Structured NUMERIC metrics. Labels (volatility band, regime name) belong
   *  in `reasoning` or `raw`, not here — pushing a string in was the source of
   *  the "Type 'string' is not assignable to type 'number'" errors. */
  metrics: Record<string, number>;
  /** Volatility band label, when the engine reports one. */
  volatilityBand?: string;
  /** Raw engine-specific output (for advanced consumers) */
  raw?: unknown;
}

/** Risk plan — unified across all engines */
export interface RiskPlan {
  approved: boolean;
  stopLoss: number;
  takeProfit1?: number;
  takeProfit2?: number;
  takeProfit?: number;
  leverage: number;
  betSizeUsd: number;
  positionPercentOfPortfolio: number;
  riskRewardRatio: number;
  kellyFraction?: number;
  maxRiskAmountUsd?: number;
   stopDistanceUsd?: number;
   blockReason?: string;
   sizingMultiplier?: number;
}

/** Pipeline stage result */
export interface StageResult<C extends DecisionContext> {
  context: C;
  blocked: boolean;
  blockReason?: string;
  gate?: string;
}

/** Pipeline stage interface.
 *
 *  SYNCHRONOUS on purpose: every adapter runs its stages in a plain `for`
 *  loop and reads `result.context` straight away. Declaring the return as
 *  `StageResult<C> | Promise<StageResult<C>>` made that loop a type error in
 *  all three adapters (15 of them) while no stage was ever actually async.
 *  If a stage ever needs I/O, make the whole pipeline async deliberately —
 *  don't widen this type and leave the callers unawaited. */
export interface PipelineStage<C extends DecisionContext> {
  /** Stage name for logging */
  name: string;
  /** Execute the stage */
  execute(context: C): StageResult<C>;
}

/** Engine adapter interface */
export interface EngineAdapter<C extends DecisionContext> {
  /** Engine identifier */
  id: EngineId;
  /** Human-readable name */
  name: string;
  /** Can this engine handle the given input? */
  canHandle(input: Partial<DecisionContext>): boolean;
  /** Engine-specific parameters */
  params: EngineParams;
  /** Run the engine's pipeline and return its raw output. The orchestrator
   *  calls this; it was missing from the interface after `stages` was removed,
   *  so `adapter.execute(...)` type-errored while working at runtime. */
  execute(context: C): unknown;
  /** Normalize engine-specific output to unified DecisionResult */
  normalize(output: unknown, context: C): DecisionResult;
}

// ── Type re-exports ───────────────────────────────────────────────────────────
// TYPES ONLY. This module used to re-export VALUES (evaluateCorrelationGate,
// toPositionDirection, DEFAULT_CORRELATION_*, computeSizingMultiplier...).
// When that list was edited, every consumer importing them from './types' kept
// compiling in the app config but resolved to `undefined` at runtime
// ("toPositionDirection is not a function") and broke the worker's esbuild
// bundle outright. Values are imported from the module that owns them.

export type { Candle } from '../tradeEngine';
export type { ClosedTradeRecord } from '../adaptiveRisk';
export type { CorrelatedHolding, CorrelationGateResult } from '../correlation';
