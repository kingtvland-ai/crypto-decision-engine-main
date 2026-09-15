/**
 * Fear-band conviction sizing (opt-in)
 * ============================================================================
 * When the Fear & Greed index sits in [FEAR_BAND_LOW, FEAR_BAND_HIGH] — "afraid,
 * not capitulating" — and the intraday engine has ALREADY approved a
 * MEAN_REVERSION buy, a recent losing streak must not shrink that entry. The
 * sizing multiplier is floored at FEAR_BAND_SIZING_FLOOR so the confirmed dip is
 * taken back toward the full 10%-of-equity target.
 *
 * Invariant it must never break: the floor is < 1, so this only UNDOES
 * de-risking. It can never push a position past 10% of equity. And it is
 * strictly opt-in (SimBotConfig.fearGreedSizeBoost) — off by default.
 *
 * Scope: intraday only. Pro/Path/Bybit carry no streak throttle for this to
 * lift, so the flag is a no-op there by construction.
 */

import { describe, it, expect } from 'vitest';
import {
  generateNewOrders,
  FEAR_BAND_LOW,
  FEAR_BAND_HIGH,
  FEAR_BAND_SIZING_FLOOR,
  type PendingOrder,
  type ReentryCooldownState
} from '@cde/engine/execution';
import type { SignalEvaluation } from '@cde/engine';

type Candle = { timestamp: number; open: number; high: number; low: number; close: number; volume: number };
const series = (n: number, base: number): Candle[] =>
  Array.from({ length: n }, (_, i) => ({
    timestamp: i * 300_000, open: base, high: base + 1, low: base - 1, close: base, volume: 1000
  }));

const candlesBySymbol: Record<string, Candle[]> = { LA: series(90, 100) };

/** An intraday BUY the engine already approved, with a streak-throttled size. */
function meanReversionBuy(streakMult: number, setupType = 'MEAN_REVERSION'): SignalEvaluation {
  return {
    symbol: 'LA',
    action: 'buy',
    tradeType: 'SPOT',
    tradeSide: 'BUY',
    confidence: 70,
    price: 100,
    priceChange24h: -3,
    reasoning: 'test',
    status: 'ready',
    willExecute: true,
    factors: [],
    confidenceGap: 0,
    leverage: 1,
    stopLoss: 90,
    takeProfit: 130,
    decision: { setupType, risk: { sizingMultiplier: streakMult } }
  } as unknown as SignalEvaluation;
}

const baseCtx = {
  positions: [],
  pending: [] as PendingOrder[],
  executionDelaySec: 0,
  dailyDrawdownPercent: 0,
  weeklyDrawdownPercent: 0,
  cash: 1_000_000,
  equity: 100_000,   // 10% target = $10,000
  exitCooldown: {} as Record<string, ReentryCooldownState>,
  priceFor: () => 100,
  candlesBySymbol,
  buildCandlesForSymbol: (s: string) => candlesBySymbol[s] ?? [],
  computeAtr5: () => 1,
  maxPositions: 7,
  maxFuturesPositions: 2
};

const budgetOf = (ctx: Parameters<typeof generateNewOrders>[0]) => {
  const o = generateNewOrders(ctx).find((x) => x.side === 'buy');
  return o?.budgetUsd ?? 0;
};

describe('fear-band sizing floor', () => {
  it('a streak-throttled MEAN_REVERSION buy sizes back up inside the fear band', () => {
    const throttled = budgetOf({ ...baseCtx, evaluations: [meanReversionBuy(0.25)], fearGreedSizeBoost: true, fearGreedIndex: 28 });
    // 0.25 → 0.9: $2,500 becomes ~$9,000
    expect(throttled).toBeGreaterThan(8_500);
    expect(throttled).toBeLessThanOrEqual(FEAR_BAND_SIZING_FLOOR * 10_000 + 1);
  });

  it('never exceeds the 10% target — a full-size entry is untouched', () => {
    const full = budgetOf({ ...baseCtx, evaluations: [meanReversionBuy(1)], fearGreedSizeBoost: true, fearGreedIndex: 28 });
    expect(full).toBeLessThanOrEqual(10_000 + 1);
    expect(full).toBeGreaterThan(9_900);
  });

  it('does nothing when the flag is off (default)', () => {
    const off = budgetOf({ ...baseCtx, evaluations: [meanReversionBuy(0.25)], fearGreedIndex: 28 });
    expect(off).toBeLessThan(3_000); // ~$2,500, the raw streak size
  });

  it('does nothing outside the band — greed, or extreme-fear capitulation', () => {
    const greed = budgetOf({ ...baseCtx, evaluations: [meanReversionBuy(0.25)], fearGreedSizeBoost: true, fearGreedIndex: 55 });
    const panic = budgetOf({ ...baseCtx, evaluations: [meanReversionBuy(0.25)], fearGreedSizeBoost: true, fearGreedIndex: 12 });
    expect(greed).toBeLessThan(3_000);
    expect(panic).toBeLessThan(3_000);
  });

  it('the band is inclusive at both ends', () => {
    const lo = budgetOf({ ...baseCtx, evaluations: [meanReversionBuy(0.25)], fearGreedSizeBoost: true, fearGreedIndex: FEAR_BAND_LOW });
    const hi = budgetOf({ ...baseCtx, evaluations: [meanReversionBuy(0.25)], fearGreedSizeBoost: true, fearGreedIndex: FEAR_BAND_HIGH });
    expect(lo).toBeGreaterThan(8_500);
    expect(hi).toBeGreaterThan(8_500);
  });

  it('only MEAN_REVERSION — a trend-continuation buy in the same tape is not boosted', () => {
    const trend = budgetOf({ ...baseCtx, evaluations: [meanReversionBuy(0.25, 'TREND_PULLBACK')], fearGreedSizeBoost: true, fearGreedIndex: 28 });
    expect(trend).toBeLessThan(3_000);
  });
});
