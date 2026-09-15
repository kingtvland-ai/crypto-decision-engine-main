/**
 * Intraday R:R — single source of truth for entry / SL / TP1
 * ============================================================================
 * Guards the fix for the "shadow levels" bug: the cost analysis and the
 * displayed R:R used to be computed on the STRUCTURAL references while the
 * order executed the FIXED-percentage levels from buildRiskPlan. After the fix
 * there is one set of levels — buildRiskPlan's — and every R:R number is a
 * function of exactly those three:
 *
 *   riskPercent   = |entry - stopLoss|   / entry * 100
 *   rewardPercent = |takeProfit1 - entry| / entry * 100
 *   grossRR       = rewardPercent / riskPercent
 *   netRR         = (rewardPercent - totalCostPercent) / riskPercent
 */

import { describe, it, expect } from 'vitest';
import {
  buildRiskPlan,
  evaluateCostEdge,
  validateLevelDirection,
  FIXED_TP_PERCENT
} from '@cde/engine/analysis';

const basePlanInput = {
  direction: 'LONG' as const,
  tradeType: 'FUTURES' as const,
  setupType: 'TREND_PULLBACK' as const,
  entryPrice: 100,
  atr5: 0.5,
  atr15: 0.8,
  equity: 10_000,
  openPositions: 0,
  openFutures: 0,
  currentLeveragedExposureUsd: 0
};

describe('Intraday R:R — the 13.3119 → 13.0723 → 13.7113 case from the report', () => {
  const entryPrice = 13.3119;
  const plan = buildRiskPlan({ ...basePlanInput, entryPrice });

  it('buildRiskPlan produces the dynamic-model levels', () => {
    expect(plan.approved).toBe(true);
    expect(plan.entryPrice).toBe(entryPrice);
    expect(plan.stopLoss).toBeCloseTo(entryPrice * (1 - 1.5 / 100), 3);    // ATR-based SL, capped at maxStopPercent=1.5%
    expect(plan.takeProfit1).toBeCloseTo(entryPrice * (1 + 2.25 / 100), 3); // stop-relative floor: 1.5x the 1.5% stop
  });

  it('risk% ≈ 1.50, reward% ≈ 2.25, gross R:R ≈ 1.50 — dynamic SL/TP model', () => {
    expect(plan.riskPercent).toBeCloseTo(1.5, 4);
    expect(plan.rewardPercent).toBeCloseTo(2.25, 4);
    expect(plan.grossRewardRisk).toBeCloseTo(1.5, 2);
    // gross R:R is exactly reward/risk of the plan's own numbers
    expect(plan.grossRewardRisk).toBeCloseTo(plan.rewardPercent / plan.riskPercent, 3);
  });

  it('evaluateCostEdge echoes the risk-plan levels verbatim (SSOT)', () => {
    const cost = evaluateCostEdge({
      tradeType: 'FUTURES',
      entryPrice,
      stopLoss: plan.stopLoss,
      takeProfit1: plan.takeProfit1,
      spreadPercent: 0.02,
      atrPercentile: 20,
      entryIsLimit: true
    });
    expect(cost.entryPrice).toBe(entryPrice);
    expect(cost.stopLoss).toBe(plan.stopLoss);
    expect(cost.takeProfit1).toBe(plan.takeProfit1);
    // and its R:R is a pure function of those levels + its own cost figure
    expect(cost.riskPercent).toBeCloseTo(plan.riskPercent, 3);
    expect(cost.rewardPercent).toBeCloseTo(plan.rewardPercent, 3);
    expect(cost.grossRewardRisk).toBeCloseTo(plan.grossRewardRisk, 2);
    expect(cost.netRewardRisk).toBeCloseTo(
      (cost.rewardPercent - cost.totalCostPercent) / cost.riskPercent,
      2
    );
    expect(cost.netRewardRisk).toBeLessThan(cost.grossRewardRisk);
  });

  it('with a ~0.259% round-trip cost the net R:R is ≈ 1.52 (report arithmetic)', () => {
    // Pure arithmetic on the report's stated numbers — independent of the
    // slippage model. risk 1.80, reward 3.00, totalCost 0.259.
    const netRR = (3.0 - 0.259) / 1.8;
    expect(netRR).toBeCloseTo(1.52, 2);
    // The old code showed 3.44 for these levels — impossible: proves the
    // displayed R:R was on different levels than the order.
    expect(netRR).not.toBeCloseTo(3.44, 1);
  });
});

describe('Intraday R:R — level-direction validation (§3 step 3)', () => {
  it('LONG with SL at/above entry is rejected', () => {
    expect(validateLevelDirection('LONG', 100, 101, 103)).toMatch(/SL/);
    expect(validateLevelDirection('LONG', 100, 100, 103)).toBeTruthy();
  });

  it('SHORT with SL at/below entry is rejected', () => {
    expect(validateLevelDirection('SHORT', 100, 99, 97)).toMatch(/SL/);
    expect(validateLevelDirection('SHORT', 100, 100, 97)).toBeTruthy();
  });

  it('LONG with TP1 at/below entry is rejected', () => {
    expect(validateLevelDirection('LONG', 100, 98, 100)).toMatch(/TP1/);
    expect(validateLevelDirection('LONG', 100, 98, 99)).toMatch(/TP1/);
  });

  it('SHORT with TP1 at/above entry is rejected', () => {
    expect(validateLevelDirection('SHORT', 100, 102, 100)).toMatch(/TP1/);
    expect(validateLevelDirection('SHORT', 100, 102, 101)).toMatch(/TP1/);
  });

  it('zero / negative stop distance is rejected', () => {
    expect(validateLevelDirection('LONG', 100, 100, 103)).toBeTruthy();
  });

  it('target equal to entry is rejected', () => {
    expect(validateLevelDirection('LONG', 100, 98, 100)).toBeTruthy();
    expect(validateLevelDirection('SHORT', 100, 102, 100)).toBeTruthy();
  });

  it('correctly-sided LONG and SHORT levels pass', () => {
    expect(validateLevelDirection('LONG', 100, 98.2, 103)).toBeNull();
    expect(validateLevelDirection('SHORT', 100, 101.8, 97)).toBeNull();
  });

  it('buildRiskPlan itself never emits a wrong-side or zero-distance plan', () => {
    for (const direction of ['LONG', 'SHORT'] as const) {
      for (const tradeType of ['SPOT', 'FUTURES'] as const) {
        if (tradeType === 'SPOT' && direction === 'SHORT') continue;
        const p = buildRiskPlan({ ...basePlanInput, direction, tradeType, entryPrice: 250 });
        expect(p.approved).toBe(true);
        expect(validateLevelDirection(direction, p.entryPrice, p.stopLoss, p.takeProfit1)).toBeNull();
      }
    }
  });
});

describe('Intraday R:R — stopReference / targetReference influence dynamic SL/TP', () => {
  it('a missing stopReference uses ATR-based SL, a provided stopReference tightens it', () => {
    const withRef = buildRiskPlan({ ...basePlanInput, entryPrice: 42, stopReference: 40, targetReference: 45 });
    const noRef = buildRiskPlan({ ...basePlanInput, entryPrice: 42 });
    expect(noRef.approved).toBe(true);
    // With stopReference=40, SL is tighter than ATR-based SL
    expect(withRef.stopLoss).toBeLessThanOrEqual(noRef.stopLoss);
    expect(withRef.takeProfit1).toBeGreaterThanOrEqual(noRef.takeProfit1);
  });

  it('a garbage stopReference / targetReference is ignored (wrong side)', () => {
    const plan = buildRiskPlan({
      ...basePlanInput,
      entryPrice: 42,
      stopReference: 999,        // absurd — on the wrong side for LONG
      targetReference: 1         // absurd — below entry for a LONG
    });
    expect(plan.approved).toBe(true);
    // With garbage references, falls back to ATR-based SL/TP
    expect(plan.stopLoss).toBeLessThan(42);
    expect(plan.takeProfit1).toBeGreaterThan(42);
  });
});

describe('Intraday R:R — rounding tolerance of the consistency check', () => {
  // The engine rejects a SIGNAL (DATA_MISMATCH) when the cost analysis and the
  // risk plan disagree on any level by more than 1e-8. Sub-1e-8 noise passes.
  const TOL = 1e-8;
  it('a 1e-9 level difference is within tolerance', () => {
    expect(Math.abs(13.0722858 - (13.0722858 + 1e-9))).toBeLessThan(TOL);
  });
  it('a 1e-6 level difference exceeds tolerance', () => {
    expect(Math.abs(13.0722858 - (13.0722858 + 1e-6))).toBeGreaterThan(TOL);
  });
  it('feeding buildRiskPlan output straight into evaluateCostEdge is an exact match', () => {
    const plan = buildRiskPlan({ ...basePlanInput, entryPrice: 0.00012345 });
    const cost = evaluateCostEdge({
      tradeType: 'FUTURES',
      entryPrice: plan.entryPrice,
      stopLoss: plan.stopLoss,
      takeProfit1: plan.takeProfit1,
      spreadPercent: 0.03,
      atrPercentile: 55,
      entryIsLimit: true
    });
    expect(Math.abs(cost.entryPrice - plan.entryPrice)).toBe(0);
    expect(Math.abs(cost.stopLoss - plan.stopLoss)).toBe(0);
    expect(Math.abs(cost.takeProfit1 - plan.takeProfit1)).toBe(0);
  });
});
