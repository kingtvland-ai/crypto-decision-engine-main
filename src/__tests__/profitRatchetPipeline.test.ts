/**
 * Profit ratchet — end to end through the real fill core (2026-09-14,
 * reworked 2026-09-16 for the giveback-of-peak model)
 * ============================================================================
 * profitRatchet.test.ts pins the pure decision. This file pins the part that
 * actually moves money: that a PARTIAL order built from a ratchet verdict sells
 * exactly 30% (not the legacy 50%), that the remainder carries the
 * peak-at-last-partial forward so the SAME peak cannot sell twice, and that a
 * position walks down the way the operator described it.
 */

import { describe, it, expect } from 'vitest';
import { fillDueOrders, type PendingOrder, type SimPosition } from '@cde/engine/execution';
import { evaluateRatchet, ratchetReason, RATCHET_PARTIAL_FRACTION } from '@cde/engine/analysis';

const ENTRY = 100;
const QTY = 10;

function position(over: Partial<SimPosition> = {}): SimPosition {
  return {
    id: 'p1', symbol: 'TEST', type: 'SPOT', side: 'LONG',
    quantity: QTY, entryPrice: ENTRY, avgPrice: ENTRY, currentPrice: ENTRY,
    leverage: 1, marginUsd: 0, notionalUsd: QTY * ENTRY,
    stopLoss: ENTRY * 0.977, tp1Hit: false,
    highestPrice: ENTRY, lowestPrice: ENTRY,
    openedAt: '', openTimestamp: Date.now(), reason: '', confidence: 70,
    entryFee: 0,
    ...over
  } as SimPosition;
}

/** Build the partial order a bot's generator would emit for this verdict. */
function ratchetOrder(pos: SimPosition, live: number): PendingOrder | null {
  const d = evaluateRatchet({
    entryPrice: pos.entryPrice,
    peakPrice: pos.highestPrice ?? pos.entryPrice,
    livePrice: live,
    isLong: true,
    peakPctAtLastPartial: pos.ratchetPeakPct,
    remainingNotionalUsd: pos.quantity * live
  });
  if (d.action === 'HOLD') return null;
  return {
    id: `o-${live}`, symbol: pos.symbol, positionId: pos.id, type: pos.type,
    side: d.action === 'FULL' ? 'close_long' : 'partial_tp1',
    exitFraction: d.fraction,
    ratchetPeakPct: d.peakPctAtLastPartial,
    signalPrice: live,
    quantity: pos.quantity * (d.fraction ?? 1),
    reason: ratchetReason(d),
    confidence: 70, executeAt: 0, createdAt: 0
  } as PendingOrder;
}

const fill = (order: PendingOrder, pos: SimPosition, live: number) =>
  fillDueOrders([order], 1000, [pos], () => live, (n) => String(n),
    { feePercent: 0.1, slippagePercent: 0 });

describe('ratchet partial through the fill core', () => {
  // Peak +20%, live +16% → past the 15%-of-peak giveback line (17%).
  const PEAK = ENTRY * 1.20;
  const GIVEBACK_PRICE = ENTRY * 1.16;

  it('sells 30% of the position, not the legacy 50%', () => {
    const pos = position({ highestPrice: PEAK });
    const order = ratchetOrder(pos, GIVEBACK_PRICE)!;
    expect(order.side).toBe('partial_tp1');
    expect(order.exitFraction).toBeCloseTo(RATCHET_PARTIAL_FRACTION, 6);

    const res = fill(order, pos, GIVEBACK_PRICE);
    expect(res.positions).toHaveLength(1);
    expect(res.positions[0].quantity).toBeCloseTo(QTY * 0.7, 6);
    expect(res.newTrades[0].quantity).toBeCloseTo(QTY * 0.3, 6);
    expect(res.newTrades[0].pnl!).toBeGreaterThan(0);
  });

  it('carries the peak forward onto the remainder, so the same peak cannot sell twice', () => {
    const pos = position({ highestPrice: PEAK });
    const res = fill(ratchetOrder(pos, GIVEBACK_PRICE)!, pos, GIVEBACK_PRICE);
    const after = { ...res.positions[0], highestPrice: PEAK };
    expect(after.ratchetPeakPct).toBeCloseTo(20, 6);

    // Same peak, deeper pullback → still nothing, because no NEW high was made.
    expect(ratchetOrder(after, GIVEBACK_PRICE)).toBeNull();
    expect(ratchetOrder(after, ENTRY * 1.10)).toBeNull();
    expect(ratchetOrder(after, ENTRY * 1.02)).toBeNull();
  });

  it('a genuinely new high re-arms it, and each leg books a profit', () => {
    let pos = position({ highestPrice: PEAK });
    const sold: number[] = [];

    // Leg 1: peak +20%, give back to +16%.
    let res = fill(ratchetOrder(pos, GIVEBACK_PRICE)!, pos, GIVEBACK_PRICE);
    sold.push(res.newTrades[0].quantity);
    expect(res.newTrades[0].pnl!).toBeGreaterThan(0);

    // Leg 2: a NEW high at +40%, then a give-back to +33%.
    pos = { ...res.positions[0], highestPrice: ENTRY * 1.40 };
    res = fill(ratchetOrder(pos, ENTRY * 1.33)!, pos, ENTRY * 1.33);
    sold.push(res.newTrades[0].quantity);
    expect(res.newTrades[0].pnl!).toBeGreaterThan(0);

    // 30% of 10, then 30% of the remaining 7.
    expect(sold[0]).toBeCloseTo(3, 6);
    expect(sold[1]).toBeCloseTo(2.1, 6);
  });

  it('break-even closes the whole remainder', () => {
    const pos = position({ highestPrice: PEAK, quantity: 4.9, ratchetPeakPct: 20 });
    const order = ratchetOrder(pos, ENTRY)!;
    expect(order.side).toBe('close_long');
    expect(fill(order, pos, ENTRY).positions).toHaveLength(0);
  });

  it('a dust remainder is closed outright instead of being nibbled', () => {
    // 0.05 units at ~$116 = $5.80, under the $10 exchange minimum.
    const pos = position({ highestPrice: PEAK, quantity: 0.05, ratchetPeakPct: 0 });
    const order = ratchetOrder(pos, GIVEBACK_PRICE)!;
    expect(order.side).toBe('close_long');
    expect(order.reason).toContain('מינימום');
    expect(fill(order, pos, GIVEBACK_PRICE).positions).toHaveLength(0);
  });

  it('initialCostUsd survives a partial — the position card can still say what went in', () => {
    // notionalUsd is REWRITTEN to the remainder's market value on every
    // partial and marginUsd is scaled, so neither can answer "how much did
    // this trade cost to open". initialCostUsd is the field that can.
    const pos = position({ highestPrice: PEAK, initialCostUsd: 1000 });
    const res = fill(ratchetOrder(pos, GIVEBACK_PRICE)!, pos, GIVEBACK_PRICE);
    const after = res.positions[0];

    expect(after.initialCostUsd).toBe(1000);
    // …while the remaining cost basis really did drop to 70%.
    expect(after.quantity * after.avgPrice).toBeCloseTo(QTY * 0.7 * ENTRY, 6);
    expect(after.notionalUsd).not.toBeCloseTo(1000, 0);
  });

  it('a legacy TP1 order with no exitFraction still means half', () => {
    const pos = position();
    const legacy = {
      id: 'legacy', symbol: 'TEST', positionId: 'p1', type: 'SPOT',
      side: 'partial_tp1', signalPrice: ENTRY * 1.03, quantity: QTY * 0.5,
      reason: 'TP1', confidence: 70, executeAt: 0, createdAt: 0
    } as PendingOrder;
    const res = fill(legacy, pos, ENTRY * 1.03);
    expect(res.positions[0].quantity).toBeCloseTo(QTY * 0.5, 6);
  });
});
