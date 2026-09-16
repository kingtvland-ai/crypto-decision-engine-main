/**
 * "S" markers on the position chart (2026-09-16)
 * ============================================================================
 * The profit ratchet sells 30% at a time and the position keeps running, so a
 * chart could show a position quietly shrinking with nothing to say WHEN that
 * happened. `attachSaleMarkers` maps each partial sale to the candle that
 * contains it; `CandleBar` draws the "S".
 *
 * The mapping is what has the edge cases, so it is what is tested: sales
 * between bars, sales older than the rendered window, several in one bar.
 */
import { describe, it, expect } from 'vitest';
import { attachSaleMarkers, type Row } from '@/components/trading/LivePositionChart';

const M5 = 300_000;
const T0 = Date.UTC(2025, 0, 1, 12, 0, 0);

function rows(count: number): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    ts: T0 + i * M5,
    open: 100, high: 101, low: 99, close: 100,
    ohlc: [99, 101] as [number, number],
    isEntry: false
  }));
}

describe('attachSaleMarkers', () => {
  it('marks the candle that CONTAINS the sale, not the next one', () => {
    const r = rows(5);
    // 2 minutes into bar 2 — still bar 2, not bar 3.
    attachSaleMarkers(r, [T0 + 2 * M5 + 120_000]);
    expect(r[2].sales).toBe(1);
    expect(r[1].sales).toBeUndefined();
    expect(r[3].sales).toBeUndefined();
  });

  it('marks the exact bar when the sale lands on its open', () => {
    const r = rows(5);
    attachSaleMarkers(r, [T0 + 3 * M5]);
    expect(r[3].sales).toBe(1);
  });

  it('counts several sales in the same candle', () => {
    const r = rows(5);
    attachSaleMarkers(r, [T0 + M5 + 10_000, T0 + M5 + 20_000, T0 + M5 + 30_000]);
    expect(r[1].sales).toBe(3);
  });

  it('spreads sales across the bars they actually happened in', () => {
    const r = rows(5);
    attachSaleMarkers(r, [T0 + 60_000, T0 + 2 * M5 + 60_000, T0 + 4 * M5 + 60_000]);
    expect(r.map((x) => x.sales ?? 0)).toEqual([1, 0, 1, 0, 1]);
  });

  it('pins a sale older than the window to the left edge instead of dropping it', () => {
    const r = rows(5);
    attachSaleMarkers(r, [T0 - 10 * M5]);
    expect(r[0].sales).toBe(1);
  });

  it('puts a sale after the last bar on the last (forming) bar', () => {
    const r = rows(5);
    attachSaleMarkers(r, [T0 + 4 * M5 + 290_000]);
    expect(r[4].sales).toBe(1);
  });

  it('is a no-op with no sales — an unsold position gets no markers at all', () => {
    const r = rows(5);
    attachSaleMarkers(r, []);
    attachSaleMarkers(r, undefined);
    expect(r.every((x) => x.sales === undefined)).toBe(true);
  });

  it('survives an empty candle set and garbage timestamps without throwing', () => {
    expect(() => attachSaleMarkers([], [T0])).not.toThrow();
    const r = rows(3);
    attachSaleMarkers(r, [NaN, Infinity]);
    expect(r.every((x) => x.sales === undefined)).toBe(true);
  });
});
