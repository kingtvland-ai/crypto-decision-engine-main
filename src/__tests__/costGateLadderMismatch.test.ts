/**
 * COST gate vs. the fixed profit ladder — a "shadow levels" regression
 * (found 2026-09-14, live: Intraday had not traded in 3+ hours)
 * ============================================================================
 * `buildRiskPlan`'s OWN reward-side gate, when the ladder (`calmRegimeScalp`)
 * is active, measures gross R:R against TP2 (3.5% / 2.3% ≈ 1.52) — TP1's own
 * ratio (1.8% / 2.3% ≈ 0.78) is deliberately below `minRewardRisk` by design;
 * TP1 is a fast 30% partial, not the trade's thesis. See calmRegime.ts.
 *
 * `evaluateCostEdge` (the §25 COST gate, a SEPARATE downstream check) had no
 * knowledge of this: it always measured `expectedMovePercent` from
 * `takeProfit1` alone. A plan that buildRiskPlan had just approved on TP2 math
 * reached COST and was re-rejected on TP1 math — net R:R landing at a
 * suspiciously narrow, TP1-shaped ~0.67-0.73 regardless of symbol or setup
 * type, always below the 1.2 floor. Every ladder signal that reached COST
 * failed this way; that is what live evaluations
 * (`NO_SIGNAL [COST] — R:R נטו 0.6x-0.7x מתחת ל-1.2`) showed for hours.
 *
 * The fix: `CostInput.rewardTarget` lets the caller say what to measure
 * against; `intradayEngine.ts` passes TP2 when the ladder is active.
 */

import { describe, it, expect } from 'vitest';
import { buildRiskPlan, evaluateCostEdge, type RiskPlanInput } from '@cde/engine/analysis';
import { withParams } from '@cde/engine';

const baseInput: Omit<RiskPlanInput, 'entryPrice' | 'atr5' | 'atr15' | 'equity'> = {
  symbol: 'INJ',
  direction: 'LONG',
  tradeType: 'SPOT',
  setupType: 'MEAN_REVERSION',
  openPositions: 0,
  openFutures: 0,
  currentLeveragedExposureUsd: 0,
  existingExposureByAsset: {}
};

describe('COST gate honours the ladder\'s own reward target', () => {
  it('reproduces the live symptom: TP1-only COST re-rejects a ladder plan buildRiskPlan already approved', () => {
    const entry = 5.9852; // INJ from the live log
    const plan = buildRiskPlan({
      ...baseInput,
      entryPrice: entry,
      atr5: entry * 0.008,
      atr15: entry * 0.009,
      equity: 10_000,
      params: withParams({ calmRegimeScalp: true })
    });
    expect(plan.approved).toBe(true); // buildRiskPlan's own gate: TP2/SL ≈ 1.52 ≥ 1.2

    // Old call shape (no rewardTarget) — what intradayEngine.ts sent before
    // the fix, always defaulting to takeProfit1.
    const brokenCost = evaluateCostEdge({
      tradeType: 'SPOT',
      entryPrice: plan.entryPrice,
      stopLoss: plan.stopLoss,
      takeProfit1: plan.takeProfit1,
      spreadPercent: 0.02,
      atrPercentile: 40,
      entryIsLimit: true
    });
    expect(brokenCost.approved).toBe(false);
    expect(brokenCost.blockGate).toBe('COST');
    expect(brokenCost.netRewardRisk).toBeLessThan(1.0); // the observed 0.67-0.73 band

    // Fixed call shape — rewardTarget = TP2 for a ladder plan.
    const fixedCost = evaluateCostEdge({
      tradeType: 'SPOT',
      entryPrice: plan.entryPrice,
      stopLoss: plan.stopLoss,
      takeProfit1: plan.takeProfit1,
      rewardTarget: plan.takeProfit2,
      spreadPercent: 0.02,
      atrPercentile: 40,
      entryIsLimit: true
    });
    expect(fixedCost.approved).toBe(true);
    expect(fixedCost.blockGate).toBeNull();
    expect(fixedCost.netRewardRisk).toBeGreaterThanOrEqual(1.2);
  });

  it('a non-ladder plan is unaffected — rewardTarget omitted defaults to TP1, same as before', () => {
    const entry = 100;
    const plan = buildRiskPlan({
      ...baseInput,
      entryPrice: entry,
      atr5: entry * 0.008,
      atr15: entry * 0.009,
      equity: 10_000,
      params: withParams({}) // no calmRegimeScalp
    });
    const withoutTarget = evaluateCostEdge({
      tradeType: 'SPOT', entryPrice: plan.entryPrice, stopLoss: plan.stopLoss,
      takeProfit1: plan.takeProfit1, spreadPercent: 0.02, atrPercentile: 40, entryIsLimit: true
    });
    const withTp1AsTarget = evaluateCostEdge({
      tradeType: 'SPOT', entryPrice: plan.entryPrice, stopLoss: plan.stopLoss,
      takeProfit1: plan.takeProfit1, rewardTarget: plan.takeProfit1,
      spreadPercent: 0.02, atrPercentile: 40, entryIsLimit: true
    });
    expect(withoutTarget.expectedMovePercent).toBeCloseTo(withTp1AsTarget.expectedMovePercent, 6);
    expect(withoutTarget.approved).toBe(withTp1AsTarget.approved);
  });

  it('the echoed takeProfit1 (DATA_MISMATCH consistency) is unaffected by rewardTarget', () => {
    const entry = 100;
    const plan = buildRiskPlan({
      ...baseInput, entryPrice: entry, atr5: entry * 0.008, atr15: entry * 0.009, equity: 10_000,
      params: withParams({ calmRegimeScalp: true })
    });
    const cost = evaluateCostEdge({
      tradeType: 'SPOT', entryPrice: plan.entryPrice, stopLoss: plan.stopLoss,
      takeProfit1: plan.takeProfit1, rewardTarget: plan.takeProfit2,
      spreadPercent: 0.02, atrPercentile: 40, entryIsLimit: true
    });
    // Still echoes TP1, not TP2 — the DATA_MISMATCH check in intradayEngine.ts
    // compares THIS field against the risk plan's TP1, unrelated to reward math.
    expect(cost.takeProfit1).toBeCloseTo(plan.takeProfit1, 8);
  });
});
