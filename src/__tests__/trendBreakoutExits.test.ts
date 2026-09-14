/**
 * Bybit (TrendBreakout) stop exits — widened ATR stop + M15-close confirmation
 * ============================================================================
 * Operator decision 2026-09-08:
 *   1. slAtrMultiplier widened 1.5 → 2.8 — the stop now stretches TOWARD the
 *      shared 4.2% cap in normal volatility instead of sitting at ~1%.
 *   2. Stop exits (entry SL, break-even, trailing) confirm on the CLOSE of the
 *      last CLOSED M15 candle — a live wick through the stop no longer closes
 *      the trade. The one intrabar exception is the 4.2% hard cap itself,
 *      which still fires on touch: the documented "never lose more than
 *      MAX_LOSS_PERCENT" promise must survive the added flexibility.
 *   3. The exit reason says "תקרה" only when the cap is what binds the stop —
 *      not on every stop, which used to imply the stop always sat at 4.2%.
 *
 * Flat M15 tape gives ATR(14) = exactly the bar range, which makes every
 * expected stop level computable by hand below.
 */

import { describe, it, expect } from 'vitest';
import {
  generateTrendBreakoutOrders,
  calculateATR,
  maxLossStopLevel,
  type Candle,
  type SimPosition
} from '@cde/engine/execution';
import {
  DEFAULT_TREND_BREAKOUT_PARAMS,
  evaluateTrendBreakout,
  readTrendBreakoutPlan,
  type TrendBreakoutPlan
} from '@cde/engine/analysis';

const H1 = 3_600_000;
const M15 = 15 * 60_000;

/** Rising H1 series → Supertrend BULL → no reversal exit for a LONG. */
function h1Uptrend(n = 220): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: i * H1,
    open: 100 + i * 0.5,
    high: 100.9 + i * 0.5,
    low: 99.5 + i * 0.5,
    close: 100.5 + i * 0.5,
    volume: 1000
  }));
}

/** Flat M15 tape: every bar identical → ATR(14) = the bar range. */
function m15Flat(range = 1.0, n = 30): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: i * M15,
    open: 100,
    high: 100 + range / 2,
    low: 100 - range / 2,
    close: 100,
    volume: 1000
  }));
}

/** Replace the last (most recent CLOSED) M15 candle. */
function withLastM15(series: Candle[], bar: Partial<Candle>): Candle[] {
  return [...series.slice(0, -1), { ...series[series.length - 1], ...bar }];
}

function lot(over: Partial<SimPosition> = {}): SimPosition {
  return {
    id: 'lot1',
    symbol: 'BTC',
    type: 'SPOT',
    side: 'LONG',
    quantity: 1,
    entryPrice: 100,
    avgPrice: 100,
    currentPrice: 100,
    leverage: 1,
    marginUsd: 100,
    notionalUsd: 100,
    // entry 100 − 2.8 × ATR(1.0) = 97.2 — the uncapped plan stop at default
    // params on flat tape (the 4.2% cap level is 95.8, well below it).
    stopLoss: 97.2,
    takeProfit1: 103,
    takeProfit2: 104.5,
    takeProfit: 103,
    tp1Hit: false,
    highestPrice: 100,
    lowestPrice: 100,
    openedAt: '',
    openTimestamp: Date.now() - 60_000,
    reason: 'test',
    confidence: 80,
    entryFee: 0,
    ...over
  };
}

function ctx(over: { positions?: SimPosition[]; price?: number; m15?: Candle[]; h1?: Candle[] } = {}) {
  return {
    positions: over.positions ?? [lot()],
    pending: [],
    evaluations: [],
    executionDelaySec: 0,
    dailyDrawdownPercent: 0,
    weeklyDrawdownPercent: 0,
    cash: 10_000,
    equity: 10_000,
    initialAmount: 10_000,
    totalLeveragedExposureUsd: 0,
    exitCooldown: {},
    priceFor: (s: string) => (s === 'BTC' ? over.price ?? 100 : undefined),
    candlesBySymbol: {
      BTC: { h1: over.h1 ?? h1Uptrend(), m15: over.m15 ?? m15Flat(), m5: [] }
    },
    maxConcurrentTrades: 7
  };
}

describe('slAtrMultiplier 1.5 → 2.8 — the stop stretches toward the cap', () => {
  it('default params carry the widened multiplier', () => {
    expect(DEFAULT_TREND_BREAKOUT_PARAMS.slAtrMultiplier).toBe(2.8);
  });

  it('the plan stop sits 2.8×ATR(M15) from entry, inside the 4.2% cap', () => {
    // Same universe shape trendBreakout.test.ts uses for a LONG signal.
    const m15: Candle[] = Array.from({ length: 320 }, (_, i) => ({
      timestamp: i * M15,
      open: 150 + i * 0.15,
      high: 150.45 + i * 0.15,
      low: 149.55 + i * 0.15,
      close: 150.15 + i * 0.15,
      volume: 1000
    }));
    const prev = m15[m15.length - 2];
    m15[m15.length - 1] = {
      timestamp: m15[m15.length - 1].timestamp,
      open: prev.close,
      high: 205.2,
      low: prev.close - 0.2,
      close: 205,
      volume: 8000
    };
    const ev = evaluateTrendBreakout({
      symbol: 'TREND',
      h1: h1Uptrend(),
      m15,
      m5: Array.from({ length: 40 }, (_, i) => ({
        timestamp: i * 5 * 60_000,
        open: 200 + i * 0.13,
        high: 200.4 + i * 0.13,
        low: 199.6 + i * 0.13,
        close: 200.2 + i * 0.13,
        volume: 1000
      })),
      currentPrice: 205
    });
    const plan = readTrendBreakoutPlan(ev) as TrendBreakoutPlan | undefined;
    expect(plan).toBeTruthy();
    const atr = calculateATR(m15, DEFAULT_TREND_BREAKOUT_PARAMS.atrPeriod).atr;
    expect(plan!.entryRef - plan!.stopLoss).toBeCloseTo(2.8 * atr, 9);
    expect(plan!.entryRef - plan!.stopLoss).toBeLessThanOrEqual(plan!.entryRef * 0.042 + 1e-9);
    expect(plan!.stopCapped).toBe(false);
  });
});

describe('stop exits trigger immediately on touch — no M15 close confirmation', () => {
  it('a live wick through the stop DOES close the trade immediately (LONG)', () => {
    // live 96.5 is below the 97.2 stop but above the 95.8 emergency cap.
    // With immediate SL execution, the trade closes on touch, not on M15 close.
    const orders = generateTrendBreakoutOrders(ctx({ price: 96.5 }));
    expect(orders).toHaveLength(1);
    expect(orders[0].side).toBe('close_long');
    expect(orders[0].reason).toContain('Stop Loss');
  });

  it('the stop closes the trade on touch, no M15 close needed', () => {
    const m15 = withLastM15(m15Flat(), { open: 100, high: 100.2, low: 96.6, close: 96.8 });
    const orders = generateTrendBreakoutOrders(ctx({ price: 96.7, m15 }));
    expect(orders).toHaveLength(1);
    expect(orders[0].side).toBe('close_long');
    expect(orders[0].reason).toContain('Stop Loss ב-');
    expect(orders[0].reason).toContain('סטופ ATR');
    // No M15 close confirmation anymore.
    expect(orders[0].reason).not.toContain('סגירת נר M15');
    // A normal ATR stop must NOT be labelled as the cap.
    expect(orders[0].reason).not.toContain('תקרה');
  });

  it('the 4.2% cap still exits INTRABAR — the emergency brake', () => {
    // live 95.0 is beyond the 95.8 cap level.
    const orders = generateTrendBreakoutOrders(ctx({ price: 95.0 }));
    expect(orders).toHaveLength(1);
    expect(orders[0].side).toBe('close_long');
    expect(orders[0].reason).toContain('חריגת תקרת הפסד');
  });

  it('when the cap is what binds the stop, the reason says תקרה', () => {
    // ATR(M15) = 1.8 → 2.8 × 1.8 = 5.04 > 4.2% → capStopLoss pins the stop to
    // 95.8. Live price at 95.7 is below the cap → immediate exit.
    const capped = lot({ stopLoss: maxLossStopLevel(100, true) });
    const orders = generateTrendBreakoutOrders(ctx({ positions: [capped], price: 95.7, m15: withLastM15(m15Flat(1.8), { open: 100, high: 96.6, low: 95.6, close: 95.7 }) }));
    expect(orders).toHaveLength(1);
    expect(orders[0].reason).toContain('תקרת הפסד');
    expect(orders[0].reason).toContain('4.2%');
  });

  it('a given-back winner exits immediately on touch — now via the ratchet floor', () => {
    // highestPrice 104 = +4%, so rungs 1.8 and 3 are crossed. Since 2026-09-14
    // the profit ratchet owns every exit above +1.8%, which makes the old
    // break-even/ATR-trail branch unreachable here: any peak high enough to
    // move the stop to break-even is also high enough to arm the ladder. What
    // this test still pins is the ORIGINAL point — the exit fires the moment
    // price touches the level, with no M15 close confirmation.
    const up = [lot({ highestPrice: 104 })];
    const orders = generateTrendBreakoutOrders(ctx({ positions: up, price: 99.5 }));
    expect(orders).toHaveLength(1);
    expect(orders[0].side).toBe('close_long');
    expect(orders[0].reason).toContain('סולם רווח');
    expect(orders[0].reason).toContain('1.8%');
    expect(orders[0].reason).not.toContain('סגירת נר M15');
  });

  it('the ATR trail still owns the exit BELOW the first rung', () => {
    // Peak 101.5 = +1.5%: under the 1.8% rung, so the ladder never arms and the
    // bot's own stop is what closes the position.
    const up = [lot({ highestPrice: 101.5 })];
    const orders = generateTrendBreakoutOrders(ctx({ positions: up, price: 96.5 }));
    expect(orders).toHaveLength(1);
    expect(orders[0].reason).not.toContain('סולם רווח');
  });
});

describe('symmetry: the same rules on a SHORT', () => {
  // entry 100 + 2.8 × ATR(1.0) = 102.8; SHORT targets sit BELOW entry.
  // h1 is left below the Supertrend warm-up floor so currentH1Supertrend
  // returns undefined and the trend-reversal branch stays inert — these tests
  // isolate the stop logic, which is symmetric under isLong by construction.
  const shortLot = lot({
    side: 'SHORT',
    stopLoss: 102.8,
    takeProfit1: 97,
    takeProfit2: 95.5,
    takeProfit: 97
  });

  it('a live wick above the stop DOES close the trade immediately (SHORT)', () => {
    const orders = generateTrendBreakoutOrders(ctx({ positions: [shortLot], price: 103.5, h1: [] }));
    expect(orders).toHaveLength(1);
    expect(orders[0].side).toBe('close_short');
    expect(orders[0].reason).toContain('Stop Loss');
  });

  it('the stop closes the trade on touch, no M15 close needed', () => {
    const m15 = withLastM15(m15Flat(), { open: 100, high: 103.4, low: 99.8, close: 103.2 });
    const orders = generateTrendBreakoutOrders(ctx({ positions: [shortLot], price: 103.0, m15, h1: [] }));
    expect(orders).toHaveLength(1);
    expect(orders[0].side).toBe('close_short');
    expect(orders[0].reason).toContain('Stop Loss ב-');
    expect(orders[0].reason).not.toContain('סגירת נר M15');
  });
});
