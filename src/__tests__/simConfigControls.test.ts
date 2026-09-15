import { describe, it, expect } from 'vitest';
import {
  computeEntryBudget,
  riskLevelSizingMultiplier,
  calculateTradingFee,
  simulateSlippage,
  DEFAULT_POSITION_PERCENT,
  DEFAULT_SLIPPAGE_PERCENT,
  FEE_REFERENCE_PERCENT,
  BYBIT_FEES
} from '@cde/engine/execution';

// Four SimBotConfig fields — positionPercent, riskLevel, feePercent and
// slippagePercent — were settable from the bot panel and from the environment
// while no engine read any of them. These tests hold them connected.
//
// The first assertion of each pair is the one that matters most: at the values
// the shipped configs already carry, wiring the control must change nothing.
// Only then do the tests check that moving it does.

describe('positionPercent sizes entries', () => {
  it('falls back to the engine default when unset', () => {
    expect(computeEntryBudget(1000, 'SPOT')).toBeCloseTo(1000 * DEFAULT_POSITION_PERCENT / 100, 6);
  });

  it('SPOT commits the configured percentage of free cash', () => {
    expect(computeEntryBudget(1000, 'SPOT', 10)).toBeCloseTo(100, 6);
    expect(computeEntryBudget(1000, 'SPOT', 25)).toBeCloseTo(250, 6);
  });

  it('FUTURES moves with it, keeping the third-of-SPOT ratio', () => {
    expect(computeEntryBudget(1000, 'FUTURES', 15)).toBeCloseTo(50, 6);
    expect(computeEntryBudget(1000, 'FUTURES', 30)).toBeCloseTo(100, 6);
  });

  it('keeps the absolute dollar caps', () => {
    expect(computeEntryBudget(1_000_000, 'SPOT', 50)).toBe(1000);
    expect(computeEntryBudget(1_000_000, 'FUTURES', 50)).toBe(500);
  });

  it('ignores a nonsensical value rather than sizing to zero', () => {
    // DEFAULT_POSITION_PERCENT = 10 (POSITION_TARGET_PCT * 100) — §1/§12
    expect(computeEntryBudget(1000, 'SPOT', 0)).toBeCloseTo(100, 6);
    expect(computeEntryBudget(1000, 'SPOT', Number.NaN)).toBeCloseTo(100, 6);
  });
});

describe('riskLevel scales the entry budget', () => {
  it('medium and unset are the neutral case', () => {
    expect(riskLevelSizingMultiplier('medium')).toBe(1);
    expect(riskLevelSizingMultiplier(undefined)).toBe(1);
  });

  it('low de-risks and high adds size', () => {
    expect(riskLevelSizingMultiplier('low')).toBe(0.6);
    expect(riskLevelSizingMultiplier('high')).toBe(1.5);
  });
});

describe('feePercent scales the cost model', () => {
  it('is neutral at the rate the shipped configs carry', () => {
    expect(FEE_REFERENCE_PERCENT).toBeCloseTo(0.1, 10);
    expect(calculateTradingFee(1000, 'SPOT', true, 0.1)).toBeCloseTo(calculateTradingFee(1000, 'SPOT', true), 10);
    expect(calculateTradingFee(1000, 'FUTURES', false, 0.1)).toBeCloseTo(calculateTradingFee(1000, 'FUTURES', false), 10);
  });

  it('scales every rate by the same factor, preserving maker/taker structure', () => {
    expect(calculateTradingFee(1000, 'SPOT', true, 0.2)).toBeCloseTo(1000 * BYBIT_FEES.spot.taker * 2, 10);
    expect(calculateTradingFee(1000, 'FUTURES', true, 0.2)).toBeCloseTo(1000 * BYBIT_FEES.futures.taker * 2, 10);
    expect(calculateTradingFee(1000, 'FUTURES', false, 0.2)).toBeCloseTo(1000 * BYBIT_FEES.futures.maker * 2, 10);
  });

  it('a zero-fee simulation is expressible', () => {
    expect(calculateTradingFee(1000, 'SPOT', true, 0)).toBe(0);
  });

  it('falls back to the real schedule when unset', () => {
    expect(calculateTradingFee(1000, 'SPOT', true)).toBeCloseTo(1000 * BYBIT_FEES.spot.taker, 10);
  });
});

describe('slippagePercent sets the fill band', () => {
  it('reproduces the Bybit Spot VIP 0 0.1%-0.3% band at the shipped default', () => {
    expect(DEFAULT_SLIPPAGE_PERCENT).toBeCloseTo(0.1, 10);
    for (let i = 0; i < 200; i++) {
      const { slippagePercent } = simulateSlippage(100, 'BUY');
      expect(slippagePercent).toBeGreaterThanOrEqual(0.1);
      expect(slippagePercent).toBeLessThanOrEqual(0.3);
    }
  });

  it('a configured value shifts and widens the band proportionally', () => {
    for (let i = 0; i < 200; i++) {
      const { slippagePercent } = simulateSlippage(100, 'BUY', 0.2);
      expect(slippagePercent).toBeGreaterThanOrEqual(0.2);
      expect(slippagePercent).toBeLessThanOrEqual(0.6);
    }
  });

  it('zero slippage fills at the market price', () => {
    const { fillPrice, slippagePercent } = simulateSlippage(100, 'BUY', 0);
    expect(slippagePercent).toBe(0);
    expect(fillPrice).toBeCloseTo(100, 10);
  });

  it('still costs the taker: a buy fills above market, a sell below', () => {
    expect(simulateSlippage(100, 'BUY', 0.1).fillPrice).toBeGreaterThan(100);
    expect(simulateSlippage(100, 'SELL', 0.1).fillPrice).toBeLessThan(100);
  });
});
