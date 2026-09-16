/**
 * Inter-tick valuation sync — `updateMarketValuations` (2026-09-16)
 * ============================================================================
 * The bots sample ONE price every ~2.5-4s and a 5M bar is 300s, so everything
 * that happened between two samples was invisible: wicks through the stop,
 * spikes through a ratchet rung, dips that should have filled a resting limit.
 * These tests pin the reconciliation against the real bar ranges.
 */
import { describe, it, expect } from 'vitest';
import { updateMarketValuations, rangeSince, selectFillableOrders } from '@cde/engine/execution';
import type { Candle } from '@cde/engine';
import type { SimPosition, PendingOrder } from '@cde/engine/execution';

const M5 = 5 * 60_000;

function bar(timestamp: number, open: number, high: number, low: number, close = open): Candle {
  return { timestamp, open, high, low, close, volume: 1000 };
}

function longPos(over: Partial<SimPosition> = {}): SimPosition {
  return {
    id: 'p1', symbol: 'BTCUSDT', type: 'SPOT', side: 'LONG', quantity: 1,
    entryPrice: 100, avgPrice: 100, currentPrice: 100, leverage: 1, marginUsd: 100, notionalUsd: 100,
    stopLoss: 97, takeProfit1: 103, takeProfit2: 105, takeProfit: 103,
    tp1Hit: false, highestPrice: 100, lowestPrice: 100, openedAt: '',
    openTimestamp: 0, reason: 'test', confidence: 80, entryFee: 0,
    ...over
  };
}

function limitOrder(over: Partial<PendingOrder> = {}): PendingOrder {
  return {
    id: 'o1', symbol: 'BTCUSDT', type: 'SPOT', side: 'buy',
    signalPrice: 98, quantity: 1, reason: 'test', confidence: 80,
    executeAt: 0, createdAt: 0,
    ...over
  };
}

const noBars = () => [];

describe('rangeSince', () => {
  it('collapses only bars NEWER than the cursor', () => {
    const bars = [bar(M5, 100, 101, 99), bar(2 * M5, 100, 105, 95), bar(3 * M5, 100, 102, 98)];
    const range = rangeSince(bars, M5)!;
    expect(range.high).toBe(105);
    expect(range.low).toBe(95);
    expect(range.open).toBe(100);
    expect(range.lastTimestamp).toBe(3 * M5);
  });

  it('returns null when no bar is newer than the cursor (stalled feed)', () => {
    const bars = [bar(M5, 100, 101, 99)];
    expect(rangeSince(bars, M5)).toBeNull();
    expect(rangeSince(bars, 10 * M5)).toBeNull();
  });

  it('returns null for an empty/absent series instead of throwing', () => {
    expect(rangeSince([], 0)).toBeNull();
    expect(rangeSince(undefined, 0)).toBeNull();
  });
});

describe('updateMarketValuations — honest extremes (fixes ratchet peak tracking)', () => {
  it('widens highestPrice to the real bar high the point-price sampling missed', () => {
    // Sampled price never left 100, but the bar printed 106.
    const result = updateMarketValuations({
      positions: [longPos({ highestPrice: 100 })],
      pending: [],
      barsFor: () => [bar(M5, 100, 106, 99, 100)],
      lastReconciledAt: 0
    });
    expect(result.positions[0].highestPrice).toBe(106);
    expect(result.positions[0].lowestPrice).toBe(99);
  });

  it('never NARROWS an extreme the sampled price already established', () => {
    const result = updateMarketValuations({
      positions: [longPos({ highestPrice: 120, lowestPrice: 80 })],
      pending: [],
      barsFor: () => [bar(M5, 100, 101, 99)],
      lastReconciledAt: 0
    });
    expect(result.positions[0].highestPrice).toBe(120);
    expect(result.positions[0].lowestPrice).toBe(80);
  });

  it('tracks the post-TP1 extremes only once TP1 is hit', () => {
    const before = updateMarketValuations({
      positions: [longPos({ tp1Hit: false })],
      pending: [], barsFor: () => [bar(M5, 100, 106, 99)], lastReconciledAt: 0
    });
    expect(before.positions[0].highestPriceSinceTP1).toBeUndefined();

    const after = updateMarketValuations({
      positions: [longPos({ tp1Hit: true, stopLoss: 90 })],
      pending: [], barsFor: () => [bar(M5, 100, 106, 99)], lastReconciledAt: 0
    });
    expect(after.positions[0].highestPriceSinceTP1).toBe(106);
  });

  it('leaves a position untouched when its symbol has no new bars', () => {
    const pos = longPos({ highestPrice: 100 });
    const result = updateMarketValuations({
      positions: [pos], pending: [], barsFor: noBars, lastReconciledAt: 0
    });
    expect(result.positions[0]).toEqual(pos);
    expect(result.touches).toEqual([]);
  });
});

describe('updateMarketValuations — level touches', () => {
  it('reports a stop the wick reached even though the close recovered', () => {
    const result = updateMarketValuations({
      positions: [longPos({ stopLoss: 97 })],
      pending: [],
      barsFor: () => [bar(M5, 100, 101, 96.5, 100)], // wick to 96.5, closes back at 100
      lastReconciledAt: 0
    });
    const stop = result.touches.find((t) => t.kind === 'stop')!;
    expect(stop).toBeDefined();
    expect(stop.level).toBe(97);
    expect(stop.price).toBe(97); // traded through the level — fills AT the level
  });

  it('fills a GAPPED stop at the bar open, not at the level', () => {
    // Window opens at 95, already below the 97 stop.
    const result = updateMarketValuations({
      positions: [longPos({ stopLoss: 97 })],
      pending: [],
      barsFor: () => [bar(M5, 95, 96, 94, 95)],
      lastReconciledAt: 0
    });
    const stop = result.touches.find((t) => t.kind === 'stop')!;
    expect(stop.price).toBe(95);
  });

  it('prefers the stop over a target reached in the same window', () => {
    const result = updateMarketValuations({
      positions: [longPos({ stopLoss: 97, takeProfit1: 103 })],
      pending: [],
      barsFor: () => [bar(M5, 100, 104, 96, 100)], // both levels inside one bar
      lastReconciledAt: 0
    });
    expect(result.touches.map((t) => t.kind)).toEqual(['stop']);
  });

  it('reports TP1 before TP1 is hit, and TP2 after', () => {
    const first = updateMarketValuations({
      positions: [longPos({ tp1Hit: false })],
      pending: [], barsFor: () => [bar(M5, 100, 103.5, 99)], lastReconciledAt: 0
    });
    expect(first.touches[0].kind).toBe('tp1');

    const second = updateMarketValuations({
      positions: [longPos({ tp1Hit: true, stopLoss: 90 })],
      pending: [], barsFor: () => [bar(M5, 100, 105.5, 99)], lastReconciledAt: 0
    });
    expect(second.touches[0].kind).toBe('tp2');
  });

  it('mirrors correctly for a SHORT', () => {
    const result = updateMarketValuations({
      positions: [longPos({ side: 'SHORT', type: 'FUTURES', stopLoss: 103, takeProfit1: 97 })],
      pending: [],
      barsFor: () => [bar(M5, 100, 103.5, 99, 100)],
      lastReconciledAt: 0
    });
    const stop = result.touches.find((t) => t.kind === 'stop')!;
    expect(stop.level).toBe(103);
    expect(stop.price).toBe(103);
  });
});

describe('updateMarketValuations — resting limit crossings', () => {
  it('reports a limit the wick filled between ticks', () => {
    const result = updateMarketValuations({
      positions: [], pending: [limitOrder({ signalPrice: 98 })],
      barsFor: () => [bar(M5, 100, 101, 97.5, 100)],
      lastReconciledAt: 0
    });
    const touch = result.touches.find((t) => t.kind === 'limit')!;
    expect(touch.orderId).toBe('o1');
    expect(touch.price).toBe(98);
  });

  it('does not report a limit the window never reached', () => {
    const result = updateMarketValuations({
      positions: [], pending: [limitOrder({ signalPrice: 90 })],
      barsFor: () => [bar(M5, 100, 101, 99)], lastReconciledAt: 0
    });
    expect(result.touches).toEqual([]);
  });

  it('ignores MARKET entries — they never rest on a price condition', () => {
    const result = updateMarketValuations({
      positions: [], pending: [limitOrder({ fill: 'market', signalPrice: 98 })],
      barsFor: () => [bar(M5, 100, 101, 97)], lastReconciledAt: 0
    });
    expect(result.touches).toEqual([]);
  });

  it('ignores EXIT orders — they are market-style and unconditional', () => {
    const result = updateMarketValuations({
      positions: [], pending: [limitOrder({ side: 'close_long', signalPrice: 98 })],
      barsFor: () => [bar(M5, 100, 101, 97)], lastReconciledAt: 0
    });
    expect(result.touches).toEqual([]);
  });
});

describe('updateMarketValuations — the no-double-count guarantee', () => {
  it('advances the cursor to the newest bar consumed', () => {
    const result = updateMarketValuations({
      positions: [longPos()], pending: [],
      barsFor: () => [bar(M5, 100, 101, 99), bar(2 * M5, 100, 101, 99)],
      lastReconciledAt: 0
    });
    expect(result.reconciledAt).toBe(2 * M5);
  });

  it('a second pass over the SAME bars reports nothing and moves nothing', () => {
    const bars = [bar(M5, 100, 101, 96.5, 100)];
    const first = updateMarketValuations({
      positions: [longPos()], pending: [limitOrder()], barsFor: () => bars, lastReconciledAt: 0
    });
    expect(first.touches.length).toBeGreaterThan(0);

    const second = updateMarketValuations({
      positions: first.positions, pending: [limitOrder()], barsFor: () => bars,
      lastReconciledAt: first.reconciledAt
    });
    expect(second.touches).toEqual([]);
    expect(second.reconciledAt).toBe(first.reconciledAt);
    expect(second.positions).toEqual(first.positions);
  });

  it('never lets a position inherit extremes from bars older than its own open', () => {
    // Worker restart: lastReconciledAt is back to 0 and the M5 window still
    // holds a 130-high bar from BEFORE this position was opened.
    const bars = [bar(M5, 100, 130, 99), bar(2 * M5, 100, 104, 99)];
    const result = updateMarketValuations({
      positions: [longPos({ openTimestamp: M5 + 1, highestPrice: 100 })],
      pending: [],
      barsFor: () => bars,
      lastReconciledAt: 0
    });
    // Only the post-open bar counts — 104, not the stale 130.
    expect(result.positions[0].highestPrice).toBe(104);
  });

  it('never lets a resting order be filled by a bar older than the order', () => {
    const bars = [bar(M5, 100, 101, 90), bar(2 * M5, 100, 101, 99)];
    const result = updateMarketValuations({
      positions: [],
      pending: [limitOrder({ signalPrice: 95, createdAt: M5 + 1 })],
      barsFor: () => bars,
      lastReconciledAt: 0
    });
    // The 90-low bar predates the order; the post-order bar never reached 95.
    expect(result.touches).toEqual([]);
  });

  it('holds the cursor still when the candle feed stalls — never slides over unseen bars', () => {
    const result = updateMarketValuations({
      positions: [longPos()], pending: [], barsFor: noBars, lastReconciledAt: 12345
    });
    expect(result.reconciledAt).toBe(12345);
  });
});

describe('selectFillableOrders — intrabar limit crossings actually fill', () => {
  // Price sampled back at 100; the limit sits at 98; the wick that reached
  // 97.5 happened between two samples.
  const restingBuy = limitOrder({ signalPrice: 98, stopLoss: 95 });
  const priceBackAt100 = () => 100;

  it('does NOT fill on the sampled price alone (the bug being fixed)', () => {
    const { due } = selectFillableOrders([restingBuy], 1, priceBackAt100);
    expect(due).toHaveLength(0);
  });

  it('DOES fill once the intrabar touch is supplied', () => {
    const touches = new Map([[restingBuy.id, 97.5]]);
    const { due } = selectFillableOrders([restingBuy], 1, priceBackAt100, touches);
    expect(due).toHaveLength(1);
    expect(due[0].id).toBe(restingBuy.id);
  });

  it('still refuses an entry whose intrabar move blew through its own stop', () => {
    // Touched 94 — past the 95 stop. Opening here would start underwater.
    const touches = new Map([[restingBuy.id, 94]]);
    const { due, expired } = selectFillableOrders([restingBuy], 1, priceBackAt100, touches);
    expect(due).toHaveLength(0);
    expect(expired.map((o) => o.id)).toEqual([restingBuy.id]);
  });

  it('is a strict superset — a fill the sampler already made is unaffected', () => {
    const priceAtLimit = () => 97;
    const withoutTouches = selectFillableOrders([restingBuy], 1, priceAtLimit);
    const withTouches = selectFillableOrders([restingBuy], 1, priceAtLimit, new Map());
    expect(withoutTouches.due).toHaveLength(1);
    expect(withTouches).toEqual(withoutTouches);
  });

  it('ignores a touch for an order that is not resting (market entry)', () => {
    const marketEntry = limitOrder({ id: 'm1', fill: 'market', signalPrice: 98 });
    const touches = new Map([['m1', 97.5]]);
    const { due } = selectFillableOrders([marketEntry], 1, priceBackAt100, touches);
    // Market entries were already due on delay alone — unchanged by touches.
    expect(due).toHaveLength(1);
  });
});
