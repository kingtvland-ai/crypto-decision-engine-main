import { describe, it, expect } from 'vitest';
import {
  evaluatePrev4hRange,
  readPrev4hRangePlan,
  DEFAULT_PREV4H_RANGE_PARAMS,
  PREV4H_MIN_H1_CANDLES,
  type Prev4hRangePlan
} from '@cde/engine/analysis';
import {
  generatePrev4hRangeOrders,
  type Prev4hRangeOrderGenContext
} from '@cde/engine/execution';
import type { SimPosition } from '@cde/engine/execution';
import type { SignalEvaluation } from '@cde/engine';

// Prev-4H Range is the strategy behind the "נתיב 4H" bot after the empirical
// bucket model was removed. These tests hold its contract: a breakout of the
// previous CLOSED 4H candle, in the direction of the 4H EMA20 trend, taken on
// closed candles only, with every no-trade path naming itself.

const H1_MS = 60 * 60 * 1000;
const BAR_MS = 4 * H1_MS;

interface C { timestamp: number; open: number; high: number; low: number; close: number; volume: number }

/** H1 candles aligned to a 4H boundary, `n` of them, close = base + i·step. */
function h1Series(n: number, base: number, step: number, startTs = 0): C[] {
  const out: C[] = [];
  for (let i = 0; i < n; i++) {
    const close = base + i * step;
    out.push({
      timestamp: startTs + i * H1_MS,
      open: i === 0 ? close : base + (i - 1) * step,
      high: close + 0.2,
      low: close - 0.2,
      close,
      volume: 1000
    });
  }
  return out;
}

/** `now` set 1h into the window that immediately follows the last CLOSED 4H bar
 *  of an `n`-candle aligned series. */
function nowInNextWindow(n: number, startTs = 0): number {
  const lastClosedBarOpen = startTs + (Math.floor(n / 4) - 1) * BAR_MS;
  return lastClosedBarOpen + BAR_MS + H1_MS;
}

describe('evaluatePrev4hRange — signal', () => {
  const N = 108; // 27 full 4H bars

  // prev 4H bar of h1Series(108,50,0.5): H=103.7, L=101.8, mid=102.75, range=1.9.
  // A LONG breakout must sit in (103.7, 103.7 + range·0.5 = 104.65].
  // RR at d=0: 2.0; at d=0.5*range: 0.5. minRR=1.2 requires d <= 0.236 * 1.9 = 0.448.
  const BREAKOUT_LONG = 104.0;

  it('fires a LONG SPOT SIGNAL on a breakout above the prev-4H high in an EMA20 uptrend', () => {
    const h1 = h1Series(N, 50, 0.5);
    const ev = evaluatePrev4hRange({ symbol: 'RNG', h1, currentPrice: BREAKOUT_LONG, now: nowInNextWindow(N) });
    expect(ev.willExecute).toBe(true);
    expect(ev.tradeSide).toBe('LONG');
    expect(ev.tradeType).toBe('SPOT');
    expect(ev.confidence).toBeGreaterThanOrEqual(DEFAULT_PREV4H_RANGE_PARAMS.minConfidence);

    const plan = readPrev4hRangePlan(ev) as Prev4hRangePlan;
    expect(plan.state).toBe('SIGNAL');
    expect(plan.stopLoss).toBeCloseTo(plan.mid, 6);        // SL = range midpoint
    expect(plan.takeProfit).toBeGreaterThan(plan.prevHigh); // TP above the break level
    expect(plan.windowEnd - plan.windowStart).toBe(BAR_MS);
  });

  it('abstains with AGAINST_TREND when the 4H EMA20 is flat', () => {
    const h1 = h1Series(N, 100, 0); // dead flat
    const ev = evaluatePrev4hRange({ symbol: 'FLAT', h1, currentPrice: 105, now: nowInNextWindow(N) });
    expect(ev.willExecute).toBe(false);
    expect(ev.status).toContain('AGAINST_TREND');
  });

  it('abstains with RANGE_TOO_TIGHT when the prev bar barely moved', () => {
    const h1 = h1Series(N, 50, 0.5);
    const ev = evaluatePrev4hRange({
      symbol: 'RNG', h1, currentPrice: BREAKOUT_LONG, now: nowInNextWindow(N),
      params: { minRangePct: 0.05 } // demand a 5% range → the ~1.8% real range fails
    });
    expect(ev.status).toContain('RANGE_TOO_TIGHT');
  });

  it('abstains with ENTRY_TOO_EXTENDED when price has already run far past the break level', () => {
    const h1 = h1Series(N, 50, 0.5);
    const ev = evaluatePrev4hRange({ symbol: 'RNG', h1, currentPrice: 200, now: nowInNextWindow(N) });
    expect(ev.willExecute).toBe(false);
    expect(ev.status).toContain('ENTRY_TOO_EXTENDED');
  });

  it('is ARMED (NO_BREAKOUT) while price is still inside the prev range', () => {
    const h1 = h1Series(N, 50, 0.5);
    const prevClose = 50 + (N - 1) * 0.5;
    const ev = evaluatePrev4hRange({ symbol: 'RNG', h1, currentPrice: prevClose, now: nowInNextWindow(N) });
    expect(ev.willExecute).toBe(false);
    expect(ev.status).toContain('NO_BREAKOUT');
  });

  it('abstains with STALE_BAR when H1 data is not current for this window', () => {
    const h1 = h1Series(N, 50, 0.5);
    const ev = evaluatePrev4hRange({ symbol: 'RNG', h1, currentPrice: BREAKOUT_LONG, now: nowInNextWindow(N) + 10 * BAR_MS });
    expect(ev.status).toContain('STALE_BAR');
  });

  it('abstains with NO_DATA below the minimum candle count (< 4)', () => {
    // Fallback mode kicks in at 4 H1 candles (1 H4 bar). Below that is NO_DATA.
    const ev = evaluatePrev4hRange({ symbol: 'THIN', h1: h1Series(3, 50, 0.5), currentPrice: 120, now: nowInNextWindow(3) });
    expect(ev.status).toContain('NO_DATA');
  });

  it('is lookahead-free: appending a partial current-window H1 candle does not change the decision', () => {
    const h1 = h1Series(N, 50, 0.5);
    const now = nowInNextWindow(N);
    const a = evaluatePrev4hRange({ symbol: 'RNG', h1, currentPrice: BREAKOUT_LONG, now });
    expect(a.willExecute).toBe(true); // exercising a real SIGNAL path
    // 2 more H1 candles in the forming window — aggregateToH4 drops the
    // incomplete group, so `prev` is unchanged.
    const partial = h1Series(N + 2, 50, 0.5);
    const b = evaluatePrev4hRange({ symbol: 'RNG', h1: partial, currentPrice: BREAKOUT_LONG, now });
    expect(b.confidence).toBe(a.confidence);
    expect(b.status).toBe(a.status);
    expect(readPrev4hRangePlan(b)?.stopLoss).toBe(readPrev4hRangePlan(a)?.stopLoss);
  });

  it('confidence stays within 0-100', () => {
    const h1 = h1Series(N, 50, 0.5);
    const ev = evaluatePrev4hRange({ symbol: 'RNG', h1, currentPrice: 104.0, now: nowInNextWindow(N) });
    expect(ev.confidence).toBeGreaterThan(0);
    expect(ev.confidence).toBeLessThanOrEqual(100);
  });
});

describe('generatePrev4hRangeOrders — window-end time stop', () => {
  function windowEndPos(tp1Hit: boolean): SimPosition {
    const openTs = Date.now() - 2 * BAR_MS; // opened two windows ago
    return {
      id: 'p1', symbol: 'RNG', type: 'SPOT', side: 'BUY', quantity: 1, entryPrice: 100,
      avgPrice: 100, currentPrice: 101, leverage: 1, marginUsd: 100, notionalUsd: 100,
      stopLoss: 98, takeProfit: 106, tp1Hit, openedAt: '', openTimestamp: openTs,
      reason: '', confidence: 60, entryFee: 0
    };
  }
  function ctxFor(pos: SimPosition): Prev4hRangeOrderGenContext {
    return {
      positions: [pos], pending: [], evaluations: [] as SignalEvaluation[],
      executionDelaySec: 0, dailyDrawdownPercent: 0, weeklyDrawdownPercent: 0,
      cash: 9900, equity: 10000, totalLeveragedExposureUsd: 0, exitCooldown: {},
      priceFor: () => 101, candlesBySymbol: {}, maxPositions: 5, maxFuturesPositions: 2
    };
  }

  // 2026-09-16: a full close on the FIRST hit marks the entire position to
  // market on one tick, the same shape fixed on Intraday's Time Stop — half
  // closes instead, and the remainder keeps running.
  it('half-closes (not a full close) the first time its 4H window has ended', () => {
    const orders = generatePrev4hRangeOrders(ctxFor(windowEndPos(false)));
    expect(orders).toHaveLength(1);
    expect(orders[0].side).toBe('partial_tp1');
    expect(orders[0].quantity).toBe(0.5);
    expect(orders[0].positionId).toBe('p1');
    expect(orders[0].reason).toContain('4 שעות');
  });

  it('closes what is left in full on a second window-end hit (tp1Hit already true)', () => {
    const orders = generatePrev4hRangeOrders(ctxFor(windowEndPos(true)));
    expect(orders).toHaveLength(1);
    expect(orders[0].side).toBe('close_long');
    expect(orders[0].positionId).toBe('p1');
    expect(orders[0].reason).toContain('4 שעות');
  });
});
