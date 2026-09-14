// Server-side simulation engine for the "נתיב 4H" bot — now runs the
// Prev-4H Range strategy (packages/engine/src/services/prev4hRange.ts).
//
// It replaced an empirical intra-bar lookup-table model whose own offline
// backtest (ASSETS/path-slot-study33) showed no bucket with positive
// expectancy after costs. Prev-4H Range is deliberately simple: read the
// previous CLOSED 4H candle's high/low, and during the next 4H window trade a
// breakout of those levels in the direction of the 4H EMA(20) trend. SL at the
// range midpoint, TP a range-multiple away, exit at the window's end.
//
// SIMULATION ONLY. Everything downstream — fills, fees, slippage, funding, the
// drawdown/exposure caps — is the shared machinery, so a difference in results
// against the other bots is a difference in decisions.

import {
  createGenericSimEngine,
  SimEngineStrategy,
  StrategyTickInput,
  SimSnapshot
} from './simEngineFactory';
import {
  SIM_MIN_CONFIDENCE,
  generatePrev4hRangeOrders,
  Prev4hRangeCandleSet
} from '@cde/engine/execution';
import type { SignalEvaluation } from '@cde/engine';
import {
  evaluatePrev4hRange,
  DEFAULT_PREV4H_RANGE_PARAMS,
  PREV4H_MIN_H1_CANDLES
} from '@cde/engine/analysis';

export type { SimPosition, SimTrade, SimPoint, PendingOrder, SimBotConfig } from '@cde/engine/execution';
export type PathSimSnapshot = SimSnapshot;

const PATH_MIN_CONFIDENCE = SIM_MIN_CONFIDENCE.path;

function overrideParams(input: StrategyTickInput) {
  const override = typeof input.config.minConfidenceOverride === 'number' && input.config.minConfidenceOverride > 0
    ? input.config.minConfidenceOverride
    : undefined;
  // Calm-regime scalp (2026-09-11, operator request, sim only): see
  // calmRegime.ts / prev4hRange.ts for the full rationale. noiseFloorStop
  // (2026-09-14) adds the second widening condition — the stop must clear one
  // H1 bar's ATR, the frame this bot actually holds across.
  return { calmRegimeScalp: true, noiseFloorStop: true, ...(override ? { minConfidence: override } : {}) };
}

const pathStrategy: SimEngineStrategy = {
  id: 'path',
  logPrefix: '[path-sim-engine]',
  telegramTag: 'path-sim',
  telegramTitle: '🕓 נתיב 4H · טווח נר קודם',
  statusFooterLabel: 'מצב כולל של הבוט (נתיב 4H)',
  minConfidence: PATH_MIN_CONFIDENCE,
  minCandlesForH1View: PREV4H_MIN_H1_CANDLES,
  logCandleFetch: false,

  buildEvaluations(input: StrategyTickInput): SignalEvaluation[] {
    const params = overrideParams(input);
    const results: SignalEvaluation[] = [];

    for (const crypto of input.cryptoData) {
      const baseAsset = input.toBase(crypto.symbol);
      const snap = input.liveCandles[baseAsset] ?? input.liveCandles[crypto.symbol.toUpperCase()];
      const h1 = snap?.h1 ?? [];
      if (h1.length < DEFAULT_PREV4H_RANGE_PARAMS.minH4Bars * 4) continue;

      const currentPrice = input.priceFor(baseAsset) ?? snap?.livePrice ?? crypto.current_price;

      results.push(evaluatePrev4hRange({
        symbol: baseAsset,
        h1,
        currentPrice,
        priceChange24h: crypto.price_change_percentage_24h ?? 0,
        params
      }));
    }

    return results;
  },

  generateOrders(input: StrategyTickInput, evaluations: SignalEvaluation[]) {
    const params = overrideParams(input);
    const candlesBySymbol: Record<string, Prev4hRangeCandleSet | undefined> = {};
    for (const [baseAsset, snap] of Object.entries(input.liveCandles)) {
      if (!snap) continue;
      candlesBySymbol[baseAsset] = { h1: snap.h1 ?? [] };
    }

    return generatePrev4hRangeOrders({
      positions: input.positions,
      pending: input.pending,
      evaluations,
      executionDelaySec: input.config.executionDelaySec,
      dailyDrawdownPercent: input.dailyDrawdownPercent,
      weeklyDrawdownPercent: input.weeklyDrawdownPercent,
      cash: input.cash,
      equity: input.equity,
      initialAmount: input.initialAmount,
      totalLeveragedExposureUsd: input.totalLeveragedExposureUsd,
      exitCooldown: input.exitCooldown,
      priceFor: input.priceFor,
      candlesBySymbol,
      maxPositions: input.maxPositions,
      maxFuturesPositions: input.maxFuturesPositions,
      limitEntries: input.config.proLimitEntries === true,
      params
    });
  }
};

export function createPathSimEngine(getSymbols?: () => string[]) {
  return createGenericSimEngine(pathStrategy, getSymbols);
}
