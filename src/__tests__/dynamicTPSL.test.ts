/**
 * TP/SL/R:R/Cost/Risk Sizing — comprehensive audit tests
 * ============================================================================
 * Covers:
 *  1. Dynamic SL computation (ATR + structure + 4.2% cap)
 *  2. Dynamic TP computation (ATR + structure + min 3%)
 *  3. TP impossible gate (reject when R:R < minRewardRisk)
 *  4. Immediate SL execution (no candle-close confirmation)
 *  5. Weighted average R:R for scaling out
 *  6. Position sizing = 10% equity, independent of SL distance
 *  7. Cost calculations (no double counting)
 *  8. LONG and SHORT symmetry
 *  9. Edge cases (low/high/extreme volatility, tight/wide structure)
 * 10. Precision for low-price assets (DOOD-like)
 */

import { describe, it, expect } from 'vitest';
import {
  buildRiskPlan,
  evaluateCostEdge,
  validateLevelDirection,
  FIXED_TP_PERCENT,
  MAX_LOSS_PERCENT,
  TP1_EXIT_FRACTION,
  capStopLoss,
  weightedAverageExit,
  type RiskPlanInput,
  type IntradayPositionView
} from '@cde/engine/analysis';
import { DEFAULT_INTRADAY_PARAMS, withParams, POSITION_TARGET_PCT } from '@cde/engine';
import { evaluateIntradayExit, evaluateIntradayDecision } from '@cde/engine/analysis';
import { Candle } from '@cde/engine';

// ─── Helpers ────────────────────────────────────────────────────────────────

const baseInput: Omit<RiskPlanInput, 'entryPrice' | 'atr5' | 'atr15' | 'equity'> = {
  symbol: 'DOOD',
  direction: 'LONG',
  tradeType: 'SPOT',
  setupType: 'TREND_PULLBACK',
  openPositions: 0,
  openFutures: 0,
  currentLeveragedExposureUsd: 0,
  existingExposureByAsset: {}
};

function makeCandles(count: number, basePrice: number, volatility: number): Candle[] {
  const candles: Candle[] = [];
  let price = basePrice;
  for (let i = 0; i < count; i++) {
    const change = (Math.random() - 0.5) * volatility;
    const open = price;
    price = Math.max(0.00000001, price + change);
    const high = Math.max(open, price) * (1 + Math.random() * volatility * 0.1);
    const low = Math.min(open, price) * (1 - Math.random() * volatility * 0.1);
    candles.push({
      timestamp: Date.now() - (count - i) * 300_000,
      open,
      high,
      low,
      close: price,
      volume: 1000 + Math.random() * 5000
    });
  }
  return candles;
}

// ─── 1. Dynamic SL Computation ─────────────────────────────────────────────

describe('1. Dynamic SL computation', () => {
  it('SL is based on ATR, not fixed 1.8%', () => {
    const entry = 0.00173243; // DOOD-like price
    const atr5 = entry * 0.02; // 2% ATR
    const plan = buildRiskPlan({
      ...baseInput,
      entryPrice: entry,
      atr5,
      atr15: atr5 * 1.2,
      equity: 10_000,
      params: withParams({ minStopAtrMult: 0.8, maxStopAtrMult: 2.5, minStopPercent: 0.12, maxStopPercent: 1.5 })
    });
    expect(plan.approved).toBe(true);
    // With 2% ATR and maxStopAtrMult=2.5, max ATR stop = 2.5 * 2% = 5%, clamped to maxStopPercent=1.5%
    // So SL should be clamped to ~1.5% (not 1.8%)
    expect(plan.riskPercent).toBeLessThanOrEqual(1.51);
  });

  it('structure-based stop is tighter than ATR-based stop', () => {
    const entry = 100;
    const atr5 = 2; // 2% ATR
    // Structural stop at 1% below entry (tighter than ATR's 1.6-5% range)
    const plan = buildRiskPlan({
      ...baseInput,
      entryPrice: entry,
      atr5,
      atr15: atr5,
      stopReference: entry * 0.99, // 1% structural stop
      equity: 10_000,
      params: withParams({ minStopAtrMult: 0.8, maxStopAtrMult: 2.5, minStopPercent: 0.12, maxStopPercent: 1.5, stopStructureBufferAtr: 0.15 })
    });
    expect(plan.approved).toBe(true);
    // SL should be close to 1% (structural), not 1.6% (ATR min)
    expect(plan.riskPercent).toBeCloseTo(1.0, 0.1);
  });

  it('SL is never wider than 4.2%', () => {
    const entry = 100;
    const atr5 = 10; // Very high ATR (10%)
    const plan = buildRiskPlan({
      ...baseInput,
      entryPrice: entry,
      atr5,
      atr15: atr5,
      equity: 10_000,
      params: withParams({ minStopAtrMult: 0.8, maxStopAtrMult: 2.5, minStopPercent: 0.12, maxStopPercent: 6, minRewardRisk: 0.5 })
    });
    expect(plan.approved).toBe(true);
    expect(plan.riskPercent).toBeLessThanOrEqual(MAX_LOSS_PERCENT);
  });

  it('SL respects minStopPercent floor', () => {
    const entry = 100;
    const atr5 = 0.1; // Very low ATR (0.1%)
    const plan = buildRiskPlan({
      ...baseInput,
      entryPrice: entry,
      atr5,
      atr15: atr5,
      equity: 10_000,
      params: withParams({ minStopAtrMult: 0.8, maxStopAtrMult: 2.5, minStopPercent: 0.5, maxStopPercent: 1.5 })
    });
    expect(plan.approved).toBe(true);
    expect(plan.riskPercent).toBeGreaterThanOrEqual(0.5);
  });
});

// ─── 2. Dynamic TP Computation ─────────────────────────────────────────────

describe('2. Dynamic TP computation', () => {
  it('TP1 floor is stop-relative (>=1.5% of entry AND >=1.5x the stop), not a flat 3%', () => {
    const entry = 100;
    const atr5 = 1;
    const plan = buildRiskPlan({
      ...baseInput,
      entryPrice: entry,
      atr5,
      atr15: atr5,
      stopReference: entry * 0.98, // 2% SL → clamped to maxStopPercent 1.5%
      targetReference: entry * 1.01, // 1% structural target (too close)
      equity: 10_000,
      params: withParams({ minStopAtrMult: 0.8, maxStopAtrMult: 2.5, minStopPercent: 0.12, maxStopPercent: 1.5, tp1RewardRisk: 1.5, tp2RewardRisk: 2.5 })
    });
    expect(plan.approved).toBe(true);
    expect(plan.rewardPercent).toBeGreaterThanOrEqual(1.5 - 0.01);                // absolute 1.5% floor
    expect(plan.grossRewardRisk).toBeGreaterThanOrEqual(1.5 - 0.01);             // >= 1.5x the stop
  });

  it('TP1 uses the FARTHER of ATR-based and structure-based target', () => {
    const entry = 100;
    const atr5 = 2; // 2% ATR
    const slDistance = entry * 0.015; // 1.5% SL
    const atrTp1Distance = slDistance * 1.5; // 2.25%
    const plan = buildRiskPlan({
      ...baseInput,
      entryPrice: entry,
      atr5,
      atr15: atr5,
      stopReference: entry * 0.985, // 1.5% SL
      targetReference: entry * 1.04, // 4% structural target (farther)
      equity: 10_000,
      params: withParams({ minStopAtrMult: 0.8, maxStopAtrMult: 2.5, minStopPercent: 0.12, maxStopPercent: 1.5, tp1RewardRisk: 1.5, tp2RewardRisk: 2.5 })
    });
    expect(plan.approved).toBe(true);
    // TP should be at least 4% (structure-based), not 2.25% (ATR-based)
    expect(plan.rewardPercent).toBeGreaterThanOrEqual(4.0);
  });
});

// ─── 3. TP Impossible Gate ──────────────────────────────────────────────────

describe('3. TP impossible gate', () => {
  it('rejects trade when the R:R the floor guarantees is still below minRewardRisk', () => {
    const entry = 100;
    const atr5 = 5; // 5% ATR → stop pinned to the 4.2% cap
    // tp1FloorDistance guarantees grossRR >= 1.5 (the 1.5x-stop term). Push
    // minRewardRisk above that (2.0) and the gate must still fire.
    const plan = buildRiskPlan({
      ...baseInput,
      entryPrice: entry,
      atr5,
      atr15: atr5,
      equity: 10_000,
      params: withParams({ minStopAtrMult: 0.8, maxStopAtrMult: 2.5, minStopPercent: 0.12, maxStopPercent: 6, tp1RewardRisk: 0.8, tp2RewardRisk: 1.2, minRewardRisk: 2.0 })
    });
    expect(plan.approved).toBe(false);
    expect(plan.blockReason).toMatch(/NO TRADE/);
  });

  it('approves trade when SL is tight enough for minimum TP', () => {
    const entry = 100;
    const atr5 = 1; // 1% ATR
    // SL = min(1.5%, 1.5%) = 1.5%, TP min = 3%, R:R = 2.0 >= 1.2 → approve
    const plan = buildRiskPlan({
      ...baseInput,
      entryPrice: entry,
      atr5,
      atr15: atr5,
      equity: 10_000,
      params: withParams({ minStopAtrMult: 0.8, maxStopAtrMult: 2.5, minStopPercent: 0.12, maxStopPercent: 1.5, tp1RewardRisk: 1.5, tp2RewardRisk: 2.5, minRewardRisk: 1.2 })
    });
    expect(plan.approved).toBe(true);
  });
});

// ─── 4. Immediate SL Execution ──────────────────────────────────────────────

describe('4. Immediate SL execution (no candle-close confirmation)', () => {
  it('SL triggers on live price touch, not candle close', () => {
    const entry = 100;
    const stopLoss = 98.5;
    const atr5 = 1;
    const position: IntradayPositionView = {
      symbol: 'DOOD',
      type: 'SPOT',
      side: 'LONG',
      entryPrice: entry,
      quantity: 1,
      stopLoss,
      takeProfit1: 103,
      takeProfit2: 104.5,
      tp1Hit: false,
      openTimestamp: Date.now() - 60_000,
      maxHoldMs: 3_600_000,
      timeStopMs: 1_800_000,
      setupType: 'MEAN_REVERSION',
      plannedStopDistance: 1.5
    };

    // Price touches SL within the candle but closes above — the SL is a bare
    // live-price touch for every setup type (close-confirmation was removed).
    const exit = evaluateIntradayExit(position, {
      price: 98.4, // Below SL
      now: Date.now(),
      atr5,
      params: withParams(),
      portfolio: { dailyDrawdownPercent: 0, weeklyDrawdownPercent: 0 }
    });

    expect(exit.shouldExit).toBe(true);
    expect(exit.reasonCode).toBe('STOP_LOSS');
  });
});

// ─── 5. Weighted Average R:R for Scaling Out ────────────────────────────────

describe('5. Weighted average R:R for scaling out', () => {
  it('computes correct weighted average exit and expected R:R', () => {
    const result = weightedAverageExit(100, [
      { price: 103, fraction: 0.5 }, // 50% at +3%
      { price: 104.5, fraction: 0.5 } // 50% at +4.5%
    ], 98.5, true);

    expect(result.weightedExitPrice).toBeCloseTo(103.75, 2);
    expect(result.expectedRewardPercent).toBeCloseTo(3.75, 2);
    expect(result.riskPercent).toBeCloseTo(1.5, 2);
    expect(result.expectedRewardRisk).toBeCloseTo(3.75 / 1.5, 1);
  });

  it('handles 40/30/30 allocation correctly', () => {
    const result = weightedAverageExit(100, [
      { price: 103, fraction: 0.4 },
      { price: 104.5, fraction: 0.3 },
      { price: 106, fraction: 0.3 }
    ], 98, true);

    // 103*0.4 + 104.5*0.3 + 106*0.3 = 41.2 + 31.35 + 31.8 = 104.35
    expect(result.weightedExitPrice).toBeCloseTo(104.35, 2);
    expect(result.expectedRewardPercent).toBeCloseTo(4.35, 2);
    expect(result.riskPercent).toBeCloseTo(2.0, 2);
  });

  it('mirrors correctly for SHORT', () => {
    const result = weightedAverageExit(100, [
      { price: 97, fraction: 0.5 },
      { price: 95.5, fraction: 0.5 }
    ], 102, false);

    expect(result.weightedExitPrice).toBeCloseTo(96.25, 2);
    expect(result.expectedRewardPercent).toBeCloseTo(3.75, 2);
    expect(result.riskPercent).toBeCloseTo(2.0, 2);
  });
});

// ─── 6. Position Sizing ─────────────────────────────────────────────────────

describe('6. Position sizing = 10% equity, independent of SL distance', () => {
  it('sizes 10% of equity regardless of SL distance', () => {
    const tightSlPlan = buildRiskPlan({
      ...baseInput,
      entryPrice: 100,
      atr5: 0.5,
      atr15: 0.8,
      stopReference: 99.5, // 0.5% SL
      equity: 10_000,
      params: withParams({ positionTargetPct: 0.10, minStopAtrMult: 0.8, maxStopAtrMult: 2.5, minStopPercent: 0.12, maxStopPercent: 1.5 })
    });

    const wideSlPlan = buildRiskPlan({
      ...baseInput,
      entryPrice: 100,
      atr5: 3,
      atr15: 4,
      stopReference: 96, // 4% SL
      equity: 10_000,
      params: withParams({ positionTargetPct: 0.10, minStopAtrMult: 0.8, maxStopAtrMult: 2.5, minStopPercent: 0.12, maxStopPercent: 1.5 })
    });

    expect(tightSlPlan.approved).toBe(true);
    expect(wideSlPlan.approved).toBe(true);
    // Both should target ~10% of equity
    expect(tightSlPlan.positionPercentOfEquity).toBeCloseTo(10, 0);
    expect(wideSlPlan.positionPercentOfEquity).toBeCloseTo(10, 0);
    // But riskUsd differs: tight SL = less risk, wide SL = more risk
    expect(wideSlPlan.riskUsd).toBeGreaterThan(tightSlPlan.riskUsd);
  });

  it('riskUsd = notionalUsd * riskPercent / 100', () => {
    const plan = buildRiskPlan({
      ...baseInput,
      entryPrice: 0.00173243,
      atr5: 0.00005,
      atr15: 0.00006,
      equity: 10_000,
      params: DEFAULT_INTRADAY_PARAMS
    });
    expect(plan.approved).toBe(true);
    const expectedRiskUsd = plan.notionalUsd * plan.riskPercent / 100;
    expect(plan.riskUsd).toBeCloseTo(expectedRiskUsd, 1);
  });
});

// ─── 7. Cost Calculations (No Double Counting) ─────────────────────────────

describe('7. Cost calculations', () => {
  it('totalCost = entryFee + exitFee + slippage (no double counting)', () => {
    const cost = evaluateCostEdge({
      tradeType: 'FUTURES',
      entryPrice: 100,
      stopLoss: 98.2,
      takeProfit1: 103,
      spreadPercent: 0.02,
      atrPercentile: 20,
      entryIsLimit: true
    });

    expect(cost.totalCostPercent).toBeCloseTo(
      cost.entryFeePercent + cost.exitFeePercent + cost.slippagePercent,
      4
    );
    expect(cost.totalCostPercent).toBeGreaterThan(0);
    expect(cost.totalCostPercent).toBeLessThan(1);
  });

  it('net R:R = (reward - totalCost) / risk', () => {
    const cost = evaluateCostEdge({
      tradeType: 'FUTURES',
      entryPrice: 100,
      stopLoss: 98.2,
      takeProfit1: 103,
      spreadPercent: 0.02,
      atrPercentile: 20,
      entryIsLimit: true
    });

    const expectedNetRR = (cost.rewardPercent - cost.totalCostPercent) / cost.riskPercent;
    expect(cost.netRewardRisk).toBeCloseTo(expectedNetRR, 2);
    expect(cost.netRewardRisk).toBeLessThan(cost.grossRewardRisk);
  });

  it('gross R:R = reward / risk', () => {
    const cost = evaluateCostEdge({
      tradeType: 'FUTURES',
      entryPrice: 100,
      stopLoss: 98.2,
      takeProfit1: 103,
      spreadPercent: 0.02,
      atrPercentile: 20,
      entryIsLimit: true
    });

    expect(cost.grossRewardRisk).toBeCloseTo(cost.rewardPercent / cost.riskPercent, 2);
  });
});

// ─── 8. LONG/SHORT Symmetry ─────────────────────────────────────────────────

describe('8. LONG/SHORT symmetry', () => {
  it('LONG and SHORT produce symmetric R:R', () => {
    const entry = 100;
    const atr5 = 1;
    const longPlan = buildRiskPlan({
      ...baseInput,
      direction: 'LONG',
      entryPrice: entry,
      atr5,
      atr15: atr5,
      equity: 10_000,
      params: DEFAULT_INTRADAY_PARAMS
    });

    const shortPlan = buildRiskPlan({
      ...baseInput,
      direction: 'SHORT',
      tradeType: 'FUTURES',
      entryPrice: entry,
      atr5,
      atr15: atr5,
      equity: 10_000,
      params: DEFAULT_INTRADAY_PARAMS
    });

    expect(longPlan.approved).toBe(true);
    expect(shortPlan.approved).toBe(true);
    expect(longPlan.riskPercent).toBeCloseTo(shortPlan.riskPercent, 2);
    expect(longPlan.rewardPercent).toBeCloseTo(shortPlan.rewardPercent, 2);
    expect(longPlan.grossRewardRisk).toBeCloseTo(shortPlan.grossRewardRisk, 2);
  });

  it('validateLevelDirection catches wrong-side levels for both directions', () => {
    expect(validateLevelDirection('LONG', 100, 101, 103)).toMatch(/SL/);
    expect(validateLevelDirection('SHORT', 100, 99, 97)).toMatch(/SL/);
    expect(validateLevelDirection('LONG', 100, 98, 100)).toMatch(/TP1/);
    expect(validateLevelDirection('SHORT', 100, 102, 100)).toMatch(/TP1/);
  });
});

// ─── 9. Edge Cases ──────────────────────────────────────────────────────────

describe('9. Edge cases', () => {
  it('handles very low-price assets (DOOD-like) with precision', () => {
    const entry = 0.00173243;
    const atr5 = 0.00005;
    const plan = buildRiskPlan({
      ...baseInput,
      entryPrice: entry,
      atr5,
      atr15: atr5,
      equity: 10_000,
      params: DEFAULT_INTRADAY_PARAMS
    });
    expect(plan.approved).toBe(true);
    expect(plan.stopLoss).toBeGreaterThan(0);
    expect(plan.stopLoss).toBeLessThan(entry);
    expect(plan.takeProfit1).toBeGreaterThan(entry);
    expect(plan.riskPercent).toBeGreaterThan(0);
    expect(plan.rewardPercent).toBeGreaterThanOrEqual(1.5 - 0.01); // stop-relative floor
  });

  it('rejects when entry price is zero or negative', () => {
    const plan = buildRiskPlan({
      ...baseInput,
      entryPrice: 0,
      atr5: 1,
      atr15: 1,
      equity: 10_000,
      params: DEFAULT_INTRADAY_PARAMS
    });
    expect(plan.approved).toBe(false);
  });

  it('rejects when equity is zero or negative', () => {
    const plan = buildRiskPlan({
      ...baseInput,
      entryPrice: 100,
      atr5: 1,
      atr15: 1,
      equity: 0,
      params: DEFAULT_INTRADAY_PARAMS
    });
    expect(plan.approved).toBe(false);
  });

  it('handles extreme volatility (high ATR) within 4.2% cap', () => {
    const entry = 100;
    const atr5 = 8; // 8% ATR
    const plan = buildRiskPlan({
      ...baseInput,
      entryPrice: entry,
      atr5,
      atr15: atr5,
      equity: 10_000,
      params: withParams({ minStopAtrMult: 0.8, maxStopAtrMult: 2.5, minStopPercent: 0.12, maxStopPercent: 6, minRewardRisk: 0.5 })
    });
    expect(plan.approved).toBe(true);
    expect(plan.riskPercent).toBeLessThanOrEqual(MAX_LOSS_PERCENT);
  });

  it('rejects when the floor-guaranteed R:R is still below a raised minRewardRisk', () => {
    const entry = 100;
    const atr5 = 5; // 5% ATR → stop at the 4.2% cap
    // The stop-relative floor guarantees grossRR >= 1.5; minRewardRisk 2.0
    // is above that, so the gate still fires.
    const plan = buildRiskPlan({
      ...baseInput,
      entryPrice: entry,
      atr5,
      atr15: atr5,
      equity: 10_000,
      params: withParams({ minStopAtrMult: 0.8, maxStopAtrMult: 2.5, minStopPercent: 0.12, maxStopPercent: 6, tp1RewardRisk: 0.8, tp2RewardRisk: 1.2, minRewardRisk: 2.0 })
    });
    expect(plan.approved).toBe(false);
    expect(plan.blockReason).toMatch(/NO TRADE/);
  });
});

// ─── 10. DOOD-like End-to-End Trace ─────────────────────────────────────────

describe('10. DOOD-like end-to-end trace', () => {
  it('produces consistent levels for a DOOD-like signal', () => {
    const entry = 0.00173243;
    const atr5 = 0.00005;
    const atr15 = 0.00006;
    const stopReference = 0.00170125; // Structural SL from the log
    const targetReference = 0.00178440; // Structural TP from the log

    const plan = buildRiskPlan({
      ...baseInput,
      entryPrice: entry,
      atr5,
      atr15,
      stopReference,
      targetReference,
      equity: 10_000,
      params: DEFAULT_INTRADAY_PARAMS
    });

    expect(plan.approved).toBe(true);
    expect(plan.entryPrice).toBeCloseTo(entry, 8);
    expect(plan.stopLoss).toBeGreaterThan(0);
    expect(plan.stopLoss).toBeLessThan(entry);
    expect(plan.takeProfit1).toBeGreaterThan(entry);
    expect(plan.riskPercent).toBeGreaterThan(0);
    expect(plan.rewardPercent).toBeGreaterThanOrEqual(FIXED_TP_PERCENT - 0.01);
    expect(plan.grossRewardRisk).toBeGreaterThanOrEqual(1);
  });

  it('cost analysis echoes the exact risk plan levels', () => {
    const entry = 0.00173243;
    const atr5 = 0.00005;
    const plan = buildRiskPlan({
      ...baseInput,
      entryPrice: entry,
      atr5,
      atr15: atr5,
      equity: 10_000,
      params: DEFAULT_INTRADAY_PARAMS
    });

    const cost = evaluateCostEdge({
      tradeType: 'SPOT',
      entryPrice: plan.entryPrice,
      stopLoss: plan.stopLoss,
      takeProfit1: plan.takeProfit1,
      spreadPercent: 0.02,
      atrPercentile: 20,
      entryIsLimit: true
    });

    expect(cost.entryPrice).toBeCloseTo(plan.entryPrice, 8);
    expect(cost.stopLoss).toBeCloseTo(plan.stopLoss, 8);
    expect(cost.takeProfit1).toBeCloseTo(plan.takeProfit1, 8);
    expect(cost.approved).toBe(true);
  });
});
