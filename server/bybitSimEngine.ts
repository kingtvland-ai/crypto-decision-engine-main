// Server-side simulation engine for the "Bybit" bot — runs the independent
// TrendBreakout strategy (packages/engine/src/services/trendBreakout.ts), the
// user's spec in TRENDBREAKOUT_SPEC.md.
//
// SIMULATION ONLY. This bot never sends a real order and is not a candidate for
// real money until a separate decision. It exists as a 4th sim bot so its
// results can be compared against Intraday / Pro / Path.
//
// Like the Pro and Path engines it calls its strategy directly (no
// DecisionEngine stage) and plugs into the shared createGenericSimEngine
// factory: same market-data feed, same fill/fee/slippage core, same drawdown
// and exposure constants, its own isolated cash / positions / trades / state.

import {
  createGenericSimEngine,
  SimEngineStrategy,
  StrategyTickInput,
  SimSnapshot
} from './simEngineFactory';
import {
  SIM_MIN_CONFIDENCE,
  generateTrendBreakoutOrders,
  TrendBreakoutCandleSet,
  applySellPressureOverride,
  applyFundingOverride
} from '@cde/engine/execution';
import { SignalEvaluation } from '@cde/engine';
import {
  evaluateTrendBreakout,
  DEFAULT_TREND_BREAKOUT_PARAMS
} from '@cde/engine/analysis';
import { getVolatilityProfileStore } from './volatilityProfileStore';

export type { SimPosition, SimTrade, SimPoint, PendingOrder, SimBotConfig } from '@cde/engine/execution';
export type BybitSimSnapshot = SimSnapshot;

const BYBIT_MIN_CONFIDENCE = SIM_MIN_CONFIDENCE.bybit;

function overrideParams(input: StrategyTickInput) {
  const override = typeof input.config.minConfidenceOverride === 'number' && input.config.minConfidenceOverride > 0
    ? input.config.minConfidenceOverride
    : undefined;
  // Calm-regime scalp (2026-09-11, operator request, sim only): see
  // calmRegime.ts / trendBreakout.ts for the full rationale. noiseFloorStop
  // (2026-09-14) adds the second widening condition — the stop must clear one
  // M15 bar's ATR, so ordinary candles stop taking out intact theses.
  return { calmRegimeScalp: true, noiseFloorStop: true, ...(override ? { minConfidence: override } : {}) };
}

const bybitStrategy: SimEngineStrategy = {
  id: 'bybit',
  logPrefix: '[bybit-sim-engine]',
  telegramTag: 'bybit-sim',
  telegramTitle: '🤖 בוט Bybit · TrendBreakout',
  statusFooterLabel: 'מצב כולל של הבוט (Bybit)',
  minConfidence: BYBIT_MIN_CONFIDENCE,
  // Reads input.liveCandles directly (like the intraday engine), so it needs no
  // candlesBySymbol H1 view from the factory.
  minCandlesForH1View: 0,
  logCandleFetch: false,

  buildEvaluations(input: StrategyTickInput): SignalEvaluation[] {
    const params = overrideParams(input);
    const results: SignalEvaluation[] = [];

    for (const [baseAsset, snap] of Object.entries(input.liveCandles)) {
      if (!snap || snap.status !== 'READY') continue;
      const h1 = snap.h1 ?? [];
      const m15 = snap.m15 ?? [];
      const m5 = snap.m5 ?? [];
      if (h1.length < DEFAULT_TREND_BREAKOUT_PARAMS.minH1) continue;
      if (m15.length < DEFAULT_TREND_BREAKOUT_PARAMS.minM15) continue;
      if (m5.length < DEFAULT_TREND_BREAKOUT_PARAMS.minM5) continue;

      const currentPrice = input.priceFor(baseAsset) ?? snap.livePrice ?? h1[h1.length - 1].close;
      const crypto = input.cryptoData.find((c) => input.toBase(c.symbol) === baseAsset);

      const evaluation = evaluateTrendBreakout({
        symbol: baseAsset,
        h1,
        m15,
        m5,
        currentPrice,
        priceChange24h: crypto?.price_change_percentage_24h ?? 0,
        params,
        volatilityProfiles: getVolatilityProfileStore()
      });
      // Macro Layer sell-pressure (2026-09-16) — same check as Intraday's GATE
      // 6, extended to Bybit/TrendBreakout. Overrides a signal that already
      // qualified; evaluateTrendBreakout's own gates/thresholds are untouched.
      const now = Date.now();
      const symbolKey = crypto?.symbol?.toUpperCase();
      const afterSellPressure = applySellPressureOverride(
        evaluation, h1, symbolKey ? input.derivativesBySymbol.get(symbolKey) : undefined, now
      );
      // Funding-crowding veto (2026-09-16). SHORT lots here are 1x FUTURES and
      // the shared tick already bills them funding (applyFundingAccrual), so
      // the cost was being paid with no gate refusing the entry. SPOT longs
      // are a no-op. See applyFundingOverride.
      results.push(applyFundingOverride(
        afterSellPressure, symbolKey ? input.fundingBySymbol.get(symbolKey) : undefined, now
      ));
    }

    return results;
  },

  generateOrders(input: StrategyTickInput, evaluations: SignalEvaluation[]) {
    const params = overrideParams(input);
    const candlesBySymbol: Record<string, TrendBreakoutCandleSet | undefined> = {};
    for (const [baseAsset, snap] of Object.entries(input.liveCandles)) {
      if (!snap) continue;
      candlesBySymbol[baseAsset] = { h1: snap.h1 ?? [], m15: snap.m15 ?? [], m5: snap.m5 ?? [] };
    }

    return generateTrendBreakoutOrders({
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
      closedTradeMetrics: input.closedTradeMetrics,
      maxConcurrentTrades: input.maxPositions,
      limitEntries: input.config.proLimitEntries === true,
      params
    });
  }
};

export function createBybitSimEngine(getSymbols?: () => string[]) {
  return createGenericSimEngine(bybitStrategy, getSymbols);
}
