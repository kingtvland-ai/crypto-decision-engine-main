/**
 * Intraday — Volatility Profile ladder wiring (2026-09-16)
 * ============================================================================
 * `buildRiskPlan`'s new `RiskPlanInput.volatilityLadder` field: when present
 * and both distances are positive it replaces the dynamic ATR/structure SL/TP1
 * AND `calmRegimeScalp`'s fixed ladder outright (highest precedence of the
 * three), still bounded by MAX_LOSS_PERCENT. Absent — the default for every
 * OTHER test in the suite, which is exactly the point — every existing test's
 * expectations are untouched.
 */
import { describe, it, expect } from 'vitest';
import {
  buildRiskPlan,
  MAX_LOSS_PERCENT,
  type RiskPlanInput
} from '@cde/engine/analysis';
import { withParams, DEFAULT_INTRADAY_PARAMS } from '@cde/engine';

const baseInput: Omit<RiskPlanInput, 'entryPrice' | 'atr5' | 'atr15'> = {
  symbol: 'BTCUSDT',
  direction: 'LONG',
  tradeType: 'SPOT',
  setupType: 'TREND_PULLBACK',
  equity: 10_000,
  openPositions: 0,
  openFutures: 0,
  currentLeveragedExposureUsd: 0,
  existingExposureByAsset: {}
};

describe('buildRiskPlan — volatilityLadder', () => {
  it('replaces the dynamic SL/TP1 with the supplied ladder, TP2 scaled proportionally', () => {
    const params = withParams({});
    const plan = buildRiskPlan({
      ...baseInput,
      entryPrice: 100,
      atr5: 0.5,
      atr15: 0.5,
      params,
      volatilityLadder: { stopPct: 3.4039, targetPct: 3.0574 }
    });
    expect(plan.approved).toBe(true);
    expect(plan.stopLoss).toBeCloseTo(100 - 100 * 0.034039, 3);
    expect(plan.takeProfit1).toBeCloseTo(100 + 100 * 0.030574, 3);
    const expectedTp2Distance = 100 * 0.030574 * (params.tp2RewardRisk / params.tp1RewardRisk);
    expect(plan.takeProfit2).toBeCloseTo(100 + expectedTp2Distance, 3);
  });

  it('SHORT mirrors direction correctly', () => {
    const plan = buildRiskPlan({
      ...baseInput,
      direction: 'SHORT',
      tradeType: 'FUTURES',
      entryPrice: 100,
      atr5: 0.5,
      atr15: 0.5,
      volatilityLadder: { stopPct: 3.0574, targetPct: 3.4039 }
    });
    expect(plan.approved).toBe(true);
    expect(plan.stopLoss).toBeCloseTo(100 + 100 * 0.030574, 3);
    expect(plan.takeProfit1).toBeCloseTo(100 - 100 * 0.034039, 3);
  });

  it('takes precedence over calmRegimeScalp when both are supplied', () => {
    const params = withParams({ calmRegimeScalp: true });
    const plan = buildRiskPlan({
      ...baseInput,
      entryPrice: 100,
      atr5: 0.5,
      atr15: 0.5,
      params,
      volatilityLadder: { stopPct: 3.4039, targetPct: 3.0574 }
    });
    expect(plan.approved).toBe(true);
    // Not the fixed 2.3%/1.8% calm ladder — the volatility-profile one.
    expect(plan.stopLoss).toBeCloseTo(100 - 100 * 0.034039, 3);
    expect(plan.takeProfit1).toBeCloseTo(100 + 100 * 0.030574, 3);
  });

  it('still clamps to MAX_LOSS_PERCENT — a degenerate profile cannot escape the ceiling', () => {
    const plan = buildRiskPlan({
      ...baseInput,
      entryPrice: 100,
      atr5: 0.5,
      atr15: 0.5,
      volatilityLadder: { stopPct: 25, targetPct: 20 } // absurdly wide, as if from bad data
    });
    // Either rejected by the TP-impossible/exposure gates, or approved with the
    // stop clamped — either way the executed risk% never exceeds the ceiling.
    if (plan.approved) {
      expect(plan.riskPercent).toBeLessThanOrEqual(MAX_LOSS_PERCENT + 1e-9);
    }
  });

  it('is a strict no-op when absent — identical plan with and without the field omitted', () => {
    const withoutField = buildRiskPlan({ ...baseInput, entryPrice: 100, atr5: 0.5, atr15: 0.5 });
    const explicitlyUndefined = buildRiskPlan({
      ...baseInput, entryPrice: 100, atr5: 0.5, atr15: 0.5, volatilityLadder: undefined
    });
    expect(explicitlyUndefined).toEqual(withoutField);
  });

  it('is ignored when either distance is zero or negative (never fabricates a ladder from bad input)', () => {
    const withoutField = buildRiskPlan({ ...baseInput, entryPrice: 100, atr5: 0.5, atr15: 0.5 });
    const zeroStop = buildRiskPlan({
      ...baseInput, entryPrice: 100, atr5: 0.5, atr15: 0.5,
      volatilityLadder: { stopPct: 0, targetPct: 3 }
    });
    const negativeTarget = buildRiskPlan({
      ...baseInput, entryPrice: 100, atr5: 0.5, atr15: 0.5,
      volatilityLadder: { stopPct: 3, targetPct: -1 }
    });
    expect(zeroStop).toEqual(withoutField);
    expect(negativeTarget).toEqual(withoutField);
  });
});
