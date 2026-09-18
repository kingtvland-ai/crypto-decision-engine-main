/**
 * Pro — net break-even / free-running floor (items 4-5), limit-order TTL +
 * revalidation (item 8), and logical-trade streak cooldown (item 9)
 * ============================================================================
 * 2026-09-18 operator decisions. Strategy/TP/SL/sizing/indicator weights are
 * untouched — these are PnL-floor, order-lifecycle, and cooldown-counting
 * fixes only.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateProExit,
  PRO_TIME_STOP_MINUTES,
  PRO_TIME_STOP_TRAIL_PCT,
  type ProPositionView
} from '@cde/engine/analysis';
import {
  revalidateProPendingEntries,
  PRO_LIMIT_ORDER_TTL_MS,
  aggregateLogicalTrades,
  type PendingOrder
} from '@cde/engine/execution';
import type { SignalEvaluation } from '@cde/engine';

const NOW = 1_800_000_000_000;
const holdSignal = { action: 'HOLD' as const, buyScore: 0, sellScore: 0, holdScore: 100, totalWeight: 0, confidence: 0, atrPercent: 0, signals: [], indicators: { rsi: 50, ma20: 100, volumeTrend: 'stable' as const, bollingerBands: { upper: 101, middle: 100, lower: 99, position: 'between' as const }, volumeProfile: { poc: 100, valueAreaHigh: 101, valueAreaLow: 99, position: 'in_value_area' as const } } };

describe('items 4-5 — net break-even accounts for real fees, and floors the free-running trail', () => {
  const pastCheckpoint = (over: Partial<ProPositionView> = {}): ProPositionView => ({
    entryPrice: 100, isLong: true, tp1Hit: false, type: 'SPOT',
    quantity: 10, entryFee: 1, // 1 / (10*100) = 0.1% — matches BYBIT_FEES.spot exactly
    openTimestamp: NOW - PRO_TIME_STOP_MINUTES * 60_000 - 60_000,
    ...over
  });

  it('LONG: the 0.6% trail is floored at net break-even, never letting a winner become a loser', () => {
    // Peak ran to 105 (a real +5% winner). A naive 0.6%-off-peak trail would
    // sit at 105*0.994 = 104.37 — comfortably profitable on its own, so this
    // case does not exercise the floor; the NEXT test does.
    const decision = evaluateProExit(
      pastCheckpoint({ peakPrice: 105 }),
      104.5, // above both the raw trail (104.37) and net BE (~100.2) — still running
      holdSignal, 70, { timeStopPeakTrail: true }, NOW
    );
    expect(decision.shouldExit).toBe(false);
  });

  it('LONG: a peak barely past net break-even — the 0.6% trail alone would dip UNDER cost, so the floor takes over', () => {
    // Peak only reached 100.3 (barely past the ~0.2% round-trip cost). A raw
    // 0.6%-off-peak trail = 100.3*0.994 = 99.70 — BELOW entry, which would
    // realize a LOSS on a position that HAD been (barely) net-profitable.
    // The floor must keep the effective stop at net break-even instead.
    const peak = 100.3;
    const pos = pastCheckpoint({ peakPrice: peak });
    // Price sitting exactly at the raw (unfloored) trail level would exit at
    // a loss under the OLD formula — confirm it does NOT exit here, because
    // the floored stop is higher (closer to peak) than the raw trail.
    const atRawTrailOnly = peak * (1 - PRO_TIME_STOP_TRAIL_PCT / 100);
    expect(atRawTrailOnly).toBeLessThan(100); // proves the raw trail would have been a loss
    const decision = evaluateProExit(pos, atRawTrailOnly + 0.001, holdSignal, 70, { timeStopPeakTrail: true }, NOW);
    expect(decision.shouldExit).toBe(true); // net-BE floor is ABOVE this price, so it fires...
    expect(decision.reason).toContain('Net Break-Even'); // ...at net BE, not a loss
  });

  it('SHORT: the 0.6% trail is ceilinged at net break-even symmetrically', () => {
    const pos = pastCheckpoint({ isLong: false, entryPrice: 100, peakPrice: 99.7 }); // shallow winner
    const rawTrailOnly = 99.7 * (1 + PRO_TIME_STOP_TRAIL_PCT / 100);
    expect(rawTrailOnly).toBeGreaterThan(100); // raw trail alone would be a loss for a SHORT
    const decision = evaluateProExit(pos, rawTrailOnly - 0.001, holdSignal, 70, { timeStopPeakTrail: true }, NOW);
    expect(decision.shouldExit).toBe(true);
    expect(decision.reason).toContain('Net Break-Even');
  });

  it('past the checkpoint, "in profit" is NET of costs — a price only marginally above raw entry is not net-profitable and closes as a loss, not free-running', () => {
    const pos = pastCheckpoint(); // no partial, tp1Hit false
    // 100.05 is above raw entryPrice but likely below net break-even (fees ~0.2% round trip).
    const decision = evaluateProExit(pos, 100.05, holdSignal, 70, { timeStopPeakTrail: true }, NOW);
    expect(decision.shouldExit).toBe(true);
    expect(decision.reason).toContain('לא ברווח נטו');
  });

  it('after TP1, the post-partial runner-stop is floored at net break-even, not raw entryPrice', () => {
    const pos: ProPositionView = {
      entryPrice: 100, isLong: true, tp1Hit: true, type: 'SPOT', quantity: 5, entryFee: 0.5,
      stopLoss: 90 // far away, irrelevant here — runnerStop should win
    };
    // Price sitting exactly at raw entryPrice (100) — under the OLD formula
    // this would be exactly "at break-even" and not exit (reachedStop needs
    // price <= runnerStop, and runnerStop was max(stopLoss, 100) = 100, so
    // 100 <= 100 WOULD have exited at raw break-even). With net BE (~100.2,
    // above raw entry), 100 is now BELOW the runner stop — it exits, but
    // labelled as the real (still-tiny) net-positive-cost floor, not a
    // fictitious "flat" break-even.
    const decision = evaluateProExit(pos, 100, holdSignal, 70, {}, NOW);
    expect(decision.shouldExit).toBe(true);
    expect(decision.reason).toContain('Break-even stop');
  });
});

describe('item 8 — Pro limit-order TTL and pre-fill revalidation', () => {
  it('PRO_LIMIT_ORDER_TTL_MS sits in the requested 30-60 minute band', () => {
    expect(PRO_LIMIT_ORDER_TTL_MS).toBeGreaterThanOrEqual(30 * 60_000);
    expect(PRO_LIMIT_ORDER_TTL_MS).toBeLessThanOrEqual(60 * 60_000);
  });

  const restingBuy = (symbol: string): PendingOrder => ({
    id: `${symbol}-buy`, symbol, type: 'SPOT', side: 'buy', signalPrice: 100,
    quantity: 1, fill: 'limit', reason: '', confidence: 80, executeAt: NOW, createdAt: NOW
  } as PendingOrder);

  const evalFor = (symbol: string, over: Partial<SignalEvaluation> = {}): SignalEvaluation => ({
    symbol, action: 'buy', tradeType: 'HOLD', tradeSide: 'BUY', confidence: 85,
    price: 100, priceChange24h: 0, reasoning: '', status: '', willExecute: false,
    factors: [], confidenceGap: 0, ...over
  } as SignalEvaluation);

  it('keeps a resting BUY whose fresh evaluation still supports it (same direction, above threshold)', () => {
    const { pending, cancelledIds } = revalidateProPendingEntries([restingBuy('LA')], [evalFor('LA', { confidence: 85 })], 78);
    expect(cancelledIds).toHaveLength(0);
    expect(pending).toHaveLength(1);
  });

  it('cancels a resting BUY once confidence drops below the entry threshold', () => {
    const { pending, cancelledIds } = revalidateProPendingEntries([restingBuy('LA')], [evalFor('LA', { confidence: 60 })], 78);
    expect(cancelledIds).toEqual(['LA-buy']);
    expect(pending).toHaveLength(0);
  });

  it('cancels a resting BUY once the signal has flipped to SELL', () => {
    const { pending, cancelledIds } = revalidateProPendingEntries(
      [restingBuy('LA')], [evalFor('LA', { action: 'sell', tradeSide: 'SELL', confidence: 90 })], 78
    );
    expect(cancelledIds).toEqual(['LA-buy']);
    expect(pending).toHaveLength(0);
  });

  it('cancels a resting BUY when the symbol has no fresh evaluation this tick (data gap)', () => {
    const { cancelledIds } = revalidateProPendingEntries([restingBuy('LA')], [], 78);
    expect(cancelledIds).toEqual(['LA-buy']);
  });

  it('never touches a market order or an exit order — only resting limit BUY/SHORT entries are in scope', () => {
    const marketOrder = { ...restingBuy('LA'), fill: 'market' as const };
    const exitOrder = { id: 'x-1', symbol: 'LA', type: 'SPOT', side: 'close_long', signalPrice: 100, quantity: 1, fill: 'limit', reason: '', confidence: 0, executeAt: NOW, createdAt: NOW } as PendingOrder;
    const { pending, cancelledIds } = revalidateProPendingEntries([marketOrder, exitOrder], [], 78);
    expect(cancelledIds).toHaveLength(0);
    expect(pending).toHaveLength(2);
  });
});

describe('item 9 — the streak cooldown counts LOGICAL trades, not exit-event rows', () => {
  it('a TP1 win followed by a break-even loss on the SAME position is ONE net-positive trade, not a loss for streak purposes', () => {
    const legs = [
      { pnl: 12.89, pnlPercent: 3, at: 1, symbol: 'AVA', side: 'partial_tp1', positionId: 'p1' },
      { pnl: -2.91, pnlPercent: -1.5, at: 2, symbol: 'AVA', side: 'close_long', positionId: 'p1' }
    ];
    const logical = aggregateLogicalTrades(legs).filter((lt) => lt.isClosed);
    expect(logical).toHaveLength(1);
    expect(logical[0].netPnl).toBeCloseTo(9.98, 6);
    expect(logical[0].isWin).toBe(true); // NOT counted as a loss toward any streak
  });
});
