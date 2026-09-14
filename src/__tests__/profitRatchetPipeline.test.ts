/**
 * Profit ratchet — end to end through the real fill core (2026-09-14)
 * ============================================================================
 * profitRatchet.test.ts pins the pure decision. This file pins the part that
 * actually moves money: that a PARTIAL order built from a ratchet verdict sells
 * exactly 30% (not the legacy 50%), that the remainder keeps its consumed-rung
 * set so the same rung cannot fire twice, and that the ladder walks a position
 * down 30% / 30% / everything the way the operator described it.
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
    consumed: pos.ratchetConsumed
  });
  if (d.action === 'HOLD') return null;
  return {
    id: `o-${live}`, symbol: pos.symbol, positionId: pos.id, type: pos.type,
    side: d.action === 'FULL' ? 'close_long' : 'partial_tp1',
    exitFraction: d.fraction,
    ratchetConsumed: d.consumed,
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
  it('sells 30% of the position, not the legacy 50%', () => {
    const pos = position({ highestPrice: ENTRY * 1.042 });
    const order = ratchetOrder(pos, ENTRY * 1.04)!;
    expect(order.side).toBe('partial_tp1');
    expect(order.exitFraction).toBeCloseTo(RATCHET_PARTIAL_FRACTION, 6);

    const res = fill(order, pos, ENTRY * 1.04);
    expect(res.positions).toHaveLength(1);
    expect(res.positions[0].quantity).toBeCloseTo(QTY * 0.7, 6);
    expect(res.newTrades[0].quantity).toBeCloseTo(QTY * 0.3, 6);
    expect(res.newTrades[0].pnl!).toBeGreaterThan(0);
  });

  it('writes the consumed rung onto the remainder, so it cannot fire twice', () => {
    const pos = position({ highestPrice: ENTRY * 1.042 });
    const res = fill(ratchetOrder(pos, ENTRY * 1.04)!, pos, ENTRY * 1.04);
    const after = res.positions[0];
    expect(after.ratchetConsumed).toContain(4);
    // Same price again → the ladder now says HOLD.
    expect(ratchetOrder(after, ENTRY * 1.04)).toBeNull();
    expect(ratchetOrder(after, ENTRY * 1.039)).toBeNull();
  });

  it('walks the operator\'s example down: 30% at 4%, 30% at 3%, the rest at 1.8%', () => {
    let pos = position({ highestPrice: ENTRY * 1.042 });
    const sold: number[] = [];

    for (const live of [ENTRY * 1.04, ENTRY * 1.03, ENTRY * 1.018]) {
      const order = ratchetOrder(pos, live);
      expect(order).not.toBeNull();
      const res = fill(order!, pos, live);
      sold.push(res.newTrades[0].quantity);
      if (res.positions.length === 0) break;
      pos = { ...res.positions[0], highestPrice: pos.highestPrice };
    }

    // 30% of 10, then 30% of the remaining 7, then the whole remaining 4.9.
    expect(sold[0]).toBeCloseTo(3, 6);
    expect(sold[1]).toBeCloseTo(2.1, 6);
    expect(sold[2]).toBeCloseTo(4.9, 6);
    // The 1.8% floor closed it out entirely.
    expect(fill(ratchetOrder(pos, ENTRY * 1.018)!, pos, ENTRY * 1.018).positions).toHaveLength(0);
  });

  it('every leg books a profit — the point of the exercise', () => {
    let pos = position({ highestPrice: ENTRY * 1.042 });
    for (const live of [ENTRY * 1.04, ENTRY * 1.03]) {
      const res = fill(ratchetOrder(pos, live)!, pos, live);
      expect(res.newTrades[0].pnl!).toBeGreaterThan(0);
      pos = { ...res.positions[0], highestPrice: pos.highestPrice };
    }
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
