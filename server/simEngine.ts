// Server-side simulation engine — runs the Intraday MTF algorithm through
// the unified DecisionEngine framework.
//
// The evaluation logic now lives in the DecisionEngine (with the IntradayAdapter),
// providing a single entry point for all three engines. Order generation still
// uses the shared simExecution.ts for fill/slippage/fee logic.

import { DecisionEngine, IntradayAdapter } from '@cde/engine';
import {
  createGenericSimEngine,
  SimEngineStrategy,
  StrategyTickInput,
  SimSnapshot
} from './simEngineFactory';
import { SIM_MIN_CONFIDENCE, SIM_INTRADAY_PARAMS_OVERRIDE } from '@cde/engine/execution';
import { generateNewOrders } from '@cde/engine/execution';
import { SignalEvaluation, DecisionFactor, resolveTradeSide } from '@cde/engine';
import { Candle, PortfolioRiskStats } from '@cde/engine';
import { IntradayParams, DEFAULT_INTRADAY_PARAMS } from '@cde/engine';

/**
 * Notional exposure per base asset — feeds the 8%-per-asset cap in the risk
 * layer, which read a hardcoded {} before and so never saw existing holdings.
 *
 * Takes the caller's own toBase (input.toBase, i.e. toBaseAsset from
 * @cde/engine/market-data) rather than a local re-implementation. This file
 * used to carry its own USDT/BUSD-stripping toBase() plus a third, inline
 * copy of the same regex a few lines below — three normalizations of the
 * same symbol, none of them the one simEngineFactory.ts already threads
 * through as input.toBase and already uses to key candlesBySymbol/
 * correlationCandles/liveCandles. A base asset normalized one way here and
 * looked up the other way in those maps is a silent miss, not an error.
 */
function exposureByAsset(positions: { symbol: string; notionalUsd?: number }[], toBase: (symbol: string) => string): Record<string, number> {
  const map: Record<string, number> = {};
  for (const p of positions) {
    const base = toBase(p.symbol);
    map[base] = (map[base] || 0) + (p.notionalUsd || 0);
  }
  return map;
}


export type { SimPosition, SimTrade, SimPoint, PendingOrder, SimBotConfig } from '@cde/engine/execution';
export type { SimSnapshot };

// Create the DecisionEngine with IntradayAdapter
const engine = new DecisionEngine({
  verbose: false
});
engine.registerAdapter(new IntradayAdapter());

/**
 * This engine's confidence floor, defined once.
 *
 * It was written twice: here as the strategy's default, and again as a
 * literal fallback in the DecisionContext below. Two copies of a threshold
 * do not stay equal, and the one that drifts is invisible — the panel reads
 * the strategy field while the engine gates on the fallback.
 *
 * An operator override (config.minConfidenceOverride / BOT_MIN_CONFIDENCE)
 * still replaces it; this is the value in force when nobody set one.
 */
const INTRADAY_MIN_CONFIDENCE = SIM_MIN_CONFIDENCE.intraday;

const intradayStrategy: SimEngineStrategy = {
  id: 'intraday',
  logPrefix: '[sim-engine]',
  telegramTag: 'sim',
  telegramTitle: '🤖 מנוע חדש · Multi-Timeframe',
  statusFooterLabel: 'מצב כולל של הבוט',
  minConfidence: INTRADAY_MIN_CONFIDENCE,
  minCandlesForH1View: 0,
  logCandleFetch: true,

  buildEvaluations(input: StrategyTickInput): SignalEvaluation[] {
    const results: SignalEvaluation[] = [];
    const baseAssetToSymbol = new Map<string, string>();

    // Build symbol mapping
    for (const c of input.cryptoData) {
      baseAssetToSymbol.set(input.toBase(c.symbol), c.symbol);
    }

    for (const [baseAsset, snap] of Object.entries(input.liveCandles)) {
      if (!snap || snap.status !== 'READY') continue;
      if (!snap.h1 || snap.h1.length < 200 || !snap.m15 || snap.m15.length < 300 || !snap.m5 || snap.m5.length < 500) continue;

      const symbol = baseAssetToSymbol.get(baseAsset) || `${baseAsset}USDT`;
      const cryptoData = input.cryptoData.find(c => c.symbol === symbol) || input.cryptoData.find(c => input.toBase(c.symbol) === baseAsset);
      const currentPrice = snap.livePrice || cryptoData?.current_price || 0;
      const priceChange24h = cryptoData?.price_change_percentage_24h || 0;

      // Build DecisionContext
      const context = {
        symbol: baseAsset,
        candles: {
          h1: snap.h1,
          m15: snap.m15,
          m5: snap.m5
        },
        currentPrice,
        portfolio: {
          portfolioValue: input.equity,
          initialAmount: input.initialAmount,
          dailyDrawdownPercent: input.dailyDrawdownPercent,
          weeklyDrawdownPercent: input.weeklyDrawdownPercent,
          openPositionsCount: input.positions.length,
          openFuturesPositionsCount: input.positions.filter(p => p.type === 'FUTURES').length,
          totalLeveragedExposureUsd: input.totalLeveragedExposureUsd,
          existingExposureByAsset: exposureByAsset(input.positions, input.toBase),
          systemLocked: false
        } as PortfolioRiskStats,
        // `candles` is what lets the correlation gate actually run — without a
        // series per held position it finds nothing and abstains.
        openPositions: input.positions.map(p => ({
          symbol: input.toBase(p.symbol),
          type: p.type,
          side: p.side,
          candles: input.correlationCandles[input.toBase(p.symbol)]
        })),
        marketData: {
          spreadPercent: snap.liquidity?.spreadPercent ?? 0,
          quoteVolume24h: snap.liquidity?.quoteVolume24h ?? 0,
          quoteVolume24hSpot: snap.liquidity?.quoteVolume24hSpot ?? 0,
          livePrice: snap.livePrice,
          priceChange24h,
          // Macro Layer (2026-09-16). Both maps are keyed by the uppercase
          // suffixed symbol (e.g. "BTCUSDT"); a missing entry (feed outage,
          // or a symbol with no Bybit linear perpetual) leaves this
          // undefined, and every downstream gate abstains rather than blocks
          // on that — see fundingRate.ts / derivativesRegime.ts.
          funding: input.fundingBySymbol.get(symbol.toUpperCase()),
          derivatives: input.derivativesBySymbol.get(symbol.toUpperCase())
        },
        // Simulation-only param layer — NOT the real bot's (tradingWorker.ts's
        // scan() passes DEFAULT_INTRADAY_PARAMS unmodified). Carries the sim's
        // mean-reversion tuning AND minOrderUsd:100 so buildRiskPlan rounds a
        // sub-$100 intraday order up to the operator floor instead of opening
        // it small.
        params: { ...DEFAULT_INTRADAY_PARAMS, ...SIM_INTRADAY_PARAMS_OVERRIDE } as unknown as Record<string, unknown>,
        now: Date.now(),
        closedTrades: input.closedTrades,
        config: {
          // The server's configured floor comes from the persisted sim config
          // (DEFAULT_SIM_CONFIG.minConfidenceOverride = 52). The old hardcoded
          // 40 silently contradicted both the UI default and ALG_intraday.md.
          minConfidenceOverride: typeof input.config.minConfidenceOverride === 'number' ? input.config.minConfidenceOverride : INTRADAY_MIN_CONFIDENCE,
          maxPositions: input.config.maxPositions ?? DEFAULT_INTRADAY_PARAMS.maxOpenPositions, // 2 × 10% = 20% = totalExposureCap
          maxFuturesPositions: input.config.maxFuturesPositions ?? DEFAULT_INTRADAY_PARAMS.maxOpenFutures,
          // Cost/edge gate prices the fill this sim actually gets: MARKET
          // (taker + full slippage) unless the operator turned limit entries on.
          entryIsLimit: input.config.proLimitEntries === true
        }
      };

      // Evaluate using DecisionEngine
      const result = engine.evaluate(context);

      // Convert to SignalEvaluation for order generation
      const evaluation = convertToSignalEvaluation(result, currentPrice, priceChange24h, snap);
      results.push(evaluation);
    }

    return results;
  },

  generateOrders(input: StrategyTickInput, evaluations: SignalEvaluation[]) {
    return generateNewOrders({
      positions: input.positions,
      pending: input.pending,
      evaluations,
      executionDelaySec: input.config.executionDelaySec,
      dailyDrawdownPercent: input.dailyDrawdownPercent,
      weeklyDrawdownPercent: input.weeklyDrawdownPercent,
      cash: input.cash,
      equity: input.equity,
      initialAmount: input.initialAmount,
      positionPercent: input.config.positionPercent,
      riskLevel: input.config.riskLevel,
      limitEntries: input.config.proLimitEntries === true,
      fearGreedIndex: input.fearGreedIndex,
      fearGreedSizeBoost: input.config.fearGreedSizeBoost === true,
      exitCooldown: input.exitCooldown,
      priceFor: input.priceFor,
      buildCandlesForSymbol: input.buildCandlesForSymbol,
      computeAtr5: input.computeAtr5,
      maxPositions: input.maxPositions,
      maxFuturesPositions: input.maxFuturesPositions,
      closedTrades: input.closedTrades,
      correlationCandles: input.correlationCandles,
      toBase: input.toBase
    });
  }
};

/** Convert DecisionResult to SignalEvaluation for order generation */
function convertToSignalEvaluation(
  result: ReturnType<DecisionEngine['evaluate']>,
  currentPrice: number,
  priceChange24h: number,
  snap: { livePrice?: number; liquidity?: { spreadPercent?: number; quoteVolume24h?: number; quoteVolume24hSpot?: number } | null }
): SignalEvaluation {
  const isSignal = result.outcome === 'SIGNAL';
  const tradeType = result.tradeType || 'HOLD';
  const action = result.direction === 'LONG' ? 'buy' : result.direction === 'SHORT' ? 'sell' : 'hold';
  // SPOT must report 'BUY', never 'LONG' — generateNewOrders derives the order
  // side from this, and 'LONG' on a SPOT eval fell through to a 'sell' order
  // that fillDueOrders silently no-ops (it only treats buy/long/short as
  // entries). That is why SIGNAL SPOT LONG never opened a position on the
  // server sim. Single definition lives in intradayBridge.resolveTradeSide.
  const tradeSide = resolveTradeSide(tradeType as 'SPOT' | 'FUTURES' | 'HOLD', result.direction);

  const factors: DecisionFactor[] = [];
  if (result.reasoning.length > 0) {
    factors.push({
      label: 'יומן החלטה',
      value: result.reasoning[result.reasoning.length - 1] || result.gate,
      impact: isSignal ? 'positive' : 'neutral',
      note: result.reasoning.join(' | ')
    });
  }

  // The real bot places a genuine resting LIMIT order at entry.entryPrice —
  // confirmEntry5M's small maker discount below market (intradayEntry.ts),
  // never at the raw live price (tradingWorker.ts:876: `d.entry?.entryPrice
  // ?? risk.stopLoss`). This simulation used to hand `price` (the live
  // price, for display) to the order generator too, so its entry order
  // rested at today's live tick instead of the intended discount — a LONG
  // could then only fill once price fell BACK to or below where it was at
  // signal time, which is the reversal case for a momentum/pullback setup
  // betting on continuation, not the continuation case itself. `price`
  // still carries the live price for the panel; `optimalEntryPrice` is the
  // level generateNewOrders (simExecution.ts) actually rests the order at —
  // same field Pro already uses for its own (differently-intentioned) limit
  // price, reused here rather than adding a second field with one meaning.
  const entryPrice = isSignal ? (result.raw as { entry?: { entryPrice?: number } } | undefined)?.entry?.entryPrice : undefined;

  return {
    symbol: result.symbol,
    action: action as 'buy' | 'sell' | 'hold',
    tradeType: tradeType as 'SPOT' | 'FUTURES' | 'HOLD',
    tradeSide: tradeSide as 'LONG' | 'SHORT' | 'BUY' | 'SELL' | 'NONE',
    confidence: result.confidence,
    price: currentPrice,
    priceChange24h,
    reasoning: result.reasoning.join('\n'),
    status: isSignal ? `SIGNAL ${tradeType} ${result.direction}` : `NO_SIGNAL [${result.gate}]`,
    willExecute: isSignal,
    factors,
    confidenceGap: 0,
    leverage: result.riskPlan?.leverage,
    betSizeUsd: result.riskPlan?.betSizeUsd,
    stopLoss: result.riskPlan?.stopLoss,
    takeProfit1: result.riskPlan?.takeProfit1,
    takeProfit2: result.riskPlan?.takeProfit2,
    takeProfit: result.riskPlan?.takeProfit,
    optimalEntryPrice: typeof entryPrice === 'number' && entryPrice > 0 ? entryPrice : undefined,
    decision: result.raw as never
  };
}

export function createSimEngine(getSymbols?: () => string[]) {
  return createGenericSimEngine(intradayStrategy, getSymbols);
}
