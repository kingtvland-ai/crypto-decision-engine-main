/**
 * Bybit (TrendBreakout) Time Stop — half-close, not full (2026-09-16)
 * ============================================================================
 * Same fix as Intraday's Time Stop and Path's 4H window time stop: a full
 * close marks the ENTIRE logical trade to market on one stagnant tick, while
 * the profit ratchet above it only ever realizes gains incrementally (30% per
 * rung). The first `maxHoldHours` hit now half-closes every open lot instead;
 * `first.tp1Hit` (set by the same shared `partial_tp1` fill path the
 * ratchet's own PARTIAL branch already uses) marks that it already happened,
 * so a second hit closes what is left, in full — no geometric decay.
 */

import { describe, it, expect } from 'vitest';
import { generateTrendBreakoutOrders, type Candle, type SimPosition } from '@cde/engine/execution';
import { DEFAULT_TREND_BREAKOUT_PARAMS } from '@cde/engine/analysis';

const H1 = 3_600_000;
const M15 = 15 * 60_000;

/** Flat H1/M15 tape: no trend flip, no breakout — nothing but the clock
 *  should be able to fire an exit here. */
function h1Flat(n = 220): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: i * H1, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000
  }));
}
function m15Flat(n = 30): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: i * M15, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000
  }));
}

function lot(over: Partial<SimPosition> = {}): SimPosition {
  const maxHoldMs = DEFAULT_TREND_BREAKOUT_PARAMS.maxHoldHours * 60 * 60 * 1000;
  return {
    id: 'lot1', symbol: 'BTC', type: 'SPOT', side: 'LONG', quantity: 1,
    entryPrice: 100, avgPrice: 100, currentPrice: 100, leverage: 1,
    marginUsd: 100, notionalUsd: 100,
    stopLoss: 90, // far away — never touched at price 100
    takeProfit1: 110, takeProfit2: 115, takeProfit: 110,
    tp1Hit: false, highestPrice: 100, lowestPrice: 100,
    openedAt: '', openTimestamp: Date.now() - maxHoldMs - 60_000,
    reason: 'test', confidence: 80, entryFee: 0,
    ...over
  };
}

function ctx(positions: SimPosition[]) {
  return {
    positions, pending: [], evaluations: [], executionDelaySec: 0,
    dailyDrawdownPercent: 0, weeklyDrawdownPercent: 0,
    cash: 10_000, equity: 10_000, initialAmount: 10_000,
    totalLeveragedExposureUsd: 0, exitCooldown: {},
    priceFor: () => 100,
    candlesBySymbol: { BTC: { h1: h1Flat(), m15: m15Flat(), m5: [] } },
    maxConcurrentTrades: 7
  };
}

describe('Bybit Time Stop — half-close under the ratchet', () => {
  it('half-closes (not a full close) the first time maxHoldHours is exceeded', () => {
    const orders = generateTrendBreakoutOrders(ctx([lot({ tp1Hit: false })]) as never);
    const exit = orders.find((o) => o.positionId === 'lot1');
    expect(exit?.side).toBe('partial_tp1');
    expect(exit?.quantity).toBe(0.5);
    expect(exit?.reason).toContain('Time Stop');
  });

  it('closes what is left in full on a second hit (tp1Hit already true)', () => {
    const orders = generateTrendBreakoutOrders(ctx([lot({ tp1Hit: true })]) as never);
    const exit = orders.find((o) => o.positionId === 'lot1');
    expect(exit?.side).toBe('close_long');
    expect(exit?.quantity).toBe(1);
    expect(exit?.reason).toContain('Time Stop');
  });
});
