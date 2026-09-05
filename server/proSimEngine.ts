// Server-side simulation engine for "Bot Pro" — a literal implementation of
// the algorithm in alg.md (weighted-indicator confidence engine, fixed-percent
// TP/SL, risk-level-driven threshold and allocation).
//
// This calls the algorithm directly (buildProEvaluation / generateProOrders),
// the same way the Path engine does — there is no DecisionEngine pipeline
// stage here, because alg.md's flow (§10) has no stages to pipeline: one
// weighted score per symbol, one threshold check, one fixed exit rule.

import {
  createGenericSimEngine,
  SimEngineStrategy,
  StrategyTickInput,
  SimSnapshot
} from './simEngineFactory';
import { SIM_MIN_CONFIDENCE } from '@cde/engine/execution';
import {
  generateProOrders,
  buildProEvaluation,
  MIN_PRO_CANDLES
} from '@cde/engine/execution';
import { computeProSignal, proMinConfidence, type ProSignalResult, type ProRiskLevel } from '@cde/engine/analysis';
import { SignalEvaluation } from '@cde/engine';

export type { SimPosition, SimTrade, SimPoint, PendingOrder, SimBotConfig } from '@cde/engine/execution';
export type ProSimSnapshot = SimSnapshot;

/**
 * This engine's confidence floor, defined once.
 *
 * Per §3, this is the DEFAULT only — a bot with no operator override falls
 * back to §3's risk-level table (CONFIDENCE_BY_RISK), not to this number. It
 * exists so the strategy record and the panel have something to report before
 * a config exists at all.
 */
const PRO_MIN_CONFIDENCE = SIM_MIN_CONFIDENCE.pro;

const proStrategy: SimEngineStrategy = {
  id: 'pro',
  logPrefix: '[pro-sim-engine]',
  telegramTag: 'pro-sim',
  telegramTitle: '🤖 בוט פרו · alg.md',
  statusFooterLabel: 'מצב כולל של הבוט (פרו)',
  minConfidence: PRO_MIN_CONFIDENCE,
  minCandlesForH1View: MIN_PRO_CANDLES,
  logCandleFetch: false,

  buildEvaluations(input: StrategyTickInput): SignalEvaluation[] {
    const results: SignalEvaluation[] = [];
    const riskLevel = (input.config.riskLevel ?? 'medium') as ProRiskLevel;
    const minConfidenceOverride = typeof input.config.minConfidenceOverride === 'number' && input.config.minConfidenceOverride > 0
      ? input.config.minConfidenceOverride
      : undefined;

    for (const crypto of input.cryptoData) {
      const symbol = crypto.symbol.toUpperCase();
      const currentPrice = crypto.current_price;
      const priceChange24h = crypto.price_change_percentage_24h || 0;
      const candles = input.candlesBySymbol[symbol];
      if (!candles || candles.length < MIN_PRO_CANDLES) continue;

      results.push(buildProEvaluation(symbol, candles, currentPrice, priceChange24h, input.fearGreedIndex, riskLevel, minConfidenceOverride));
    }

    return results;
  },

  generateOrders(input: StrategyTickInput, evaluations: SignalEvaluation[]) {
    const riskLevel = (input.config.riskLevel ?? 'medium') as ProRiskLevel;
    const minConfidenceOverride = typeof input.config.minConfidenceOverride === 'number' && input.config.minConfidenceOverride > 0
      ? input.config.minConfidenceOverride
      : undefined;
    // §3's own table when no override is set, not a flat display default.
    const minConfidence = proMinConfidence(riskLevel, minConfidenceOverride);

    // The exit check (§5's fixed %, §4's flip-to-SELL) needs each held
    // symbol's CURRENT signal, independent of whether that symbol currently
    // clears the entry threshold — a losing position must still see its own
    // fresh SELL flip even while no new entries are being considered for it.
    const signalsBySymbol: Record<string, ProSignalResult> = {};
    for (const pos of input.positions) {
      const candles = input.candlesBySymbol[pos.symbol];
      if (!candles || candles.length < MIN_PRO_CANDLES) continue;
      const crypto = input.cryptoData.find((c) => c.symbol.toUpperCase() === pos.symbol);
      signalsBySymbol[pos.symbol] = computeProSignal(candles, crypto?.price_change_percentage_24h || 0, input.fearGreedIndex);
    }

    return generateProOrders({
      positions: input.positions,
      pending: input.pending,
      evaluations,
      signalsBySymbol,
      minConfidence,
      executionDelaySec: input.config.executionDelaySec,
      dailyDrawdownPercent: input.dailyDrawdownPercent,
      weeklyDrawdownPercent: input.weeklyDrawdownPercent,
      cash: input.cash,
      initialAmount: input.initialAmount,
      riskLevel,
      exitCooldown: input.exitCooldown,
      priceFor: input.priceFor,
      maxPositions: input.maxPositions
    });
  }
};

export function createProSimEngine(getSymbols?: () => string[]) {
  return createGenericSimEngine(proStrategy, getSymbols);
}
