/**
 * Re-entry cooldown (2026-09-14, revised same day)
 * ============================================================================
 * Originally two defects, reported from a live Pro run:
 *   1. `generateProOrders` never received `exitCooldown` at all — Pro was the
 *      only sim bot with NO re-entry cooldown. B3 closed +$12.23 at 13:45, was
 *      re-bought at 13:56, and stopped out −$20.59 at 14:05.
 *   2. The shared fill core wrote a cooldown only on a LOSING close, so a
 *      winning exit — the best reason to leave a symbol alone — left it
 *      instantly re-enterable in every bot.
 *
 * #1 is fixed permanently — Pro always gets a cooldown now. #2 was widened to
 * fire on every exit, then reverted back to losses-only on operator request:
 * a winning exit means the setup worked, so re-entering a fresh signal on the
 * same symbol is not "chasing" — that risk lived specifically in the
 * post-loss case. So: 60 minutes, on a LOSING full exit only, in all four bots.
 */

import { describe, it, expect } from 'vitest';
import {
  ENTRY_COOLDOWN_MS, isInEntryCooldown, fillDueOrders,
  type PendingOrder, type SimPosition
} from '@cde/engine/execution';

const MIN = 60_000;

describe('ENTRY_COOLDOWN_MS', () => {
  it('is a full hour', () => {
    expect(ENTRY_COOLDOWN_MS).toBe(60 * MIN);
  });

  it('blocks inside the window and clears after it', () => {
    const now = 10_000_000;
    expect(isInEntryCooldown(now - 11 * MIN, now)).toBe(true);   // the B3 gap
    expect(isInEntryCooldown(now - 30 * MIN, now)).toBe(true);   // the old limit
    expect(isInEntryCooldown(now - 59 * MIN, now)).toBe(true);
    expect(isInEntryCooldown(now - 61 * MIN, now)).toBe(false);
  });

  it('treats a symbol that never traded as free', () => {
    expect(isInEntryCooldown(undefined)).toBe(false);
  });
});

function position(over: Partial<SimPosition> = {}): SimPosition {
  return {
    id: 'p1', symbol: 'B3', type: 'SPOT', side: 'LONG',
    quantity: 100, entryPrice: 1, avgPrice: 1, currentPrice: 1,
    leverage: 1, marginUsd: 0, notionalUsd: 100,
    stopLoss: 0.977, tp1Hit: false, highestPrice: 1, lowestPrice: 1,
    openedAt: '', openTimestamp: 0, reason: '', confidence: 90, entryFee: 0,
    ...over
  } as SimPosition;
}

const closeOrder = (over: Partial<PendingOrder> = {}): PendingOrder => ({
  id: 'o1', symbol: 'B3', positionId: 'p1', type: 'SPOT', side: 'close_long',
  signalPrice: 1, quantity: 100, reason: '', confidence: 90,
  executeAt: 0, createdAt: 0, ...over
} as PendingOrder);

const fill = (order: PendingOrder, pos: SimPosition, price: number) =>
  fillDueOrders([order], 1000, [pos], () => price, String,
    { feePercent: 0.1, slippagePercent: 0 });

describe('the fill core writes a cooldown only on a LOSING full exit', () => {
  it('writes NO cooldown after a WINNING exit — banking a move is not chasing', () => {
    const res = fill(closeOrder(), position(), 1.05);
    expect(res.newTrades[0].pnl!).toBeGreaterThan(0);
    expect(res.newCooldowns.B3).toBeUndefined();
  });

  it('writes one after a losing exit', () => {
    const res = fill(closeOrder(), position(), 0.95);
    expect(res.newTrades[0].pnl!).toBeLessThan(0);
    expect(res.newCooldowns.B3).toBeGreaterThan(0);
    expect(isInEntryCooldown(res.newCooldowns.B3)).toBe(true);
  });

  it('does NOT write one for a partial exit — the position is still open', () => {
    const partial = closeOrder({ side: 'partial_tp1', exitFraction: 0.3, quantity: 30 });
    const res = fill(partial, position(), 1.05);
    expect(res.positions).toHaveLength(1);
    expect(res.newCooldowns.B3).toBeUndefined();
  });
});

// ── Pro's own gate — the bot that had no cooldown at all ────────────────────

import { generateProOrders } from '@cde/engine/execution';
import type { SignalEvaluation } from '@cde/engine';

const proEvaluation = (symbol: string): SignalEvaluation => ({
  symbol, action: 'buy', tradeType: 'SPOT', tradeSide: 'BUY', confidence: 96,
  price: 100, priceChange24h: 1, reasoning: 'test', status: 'ready',
  willExecute: true, factors: [], confidenceGap: 0, leverage: 1,
  stopLoss: 90, takeProfit: 130, budgetUsd: 1000
} as unknown as SignalEvaluation);

const proCtx = {
  positions: [] as SimPosition[],
  pending: [] as PendingOrder[],
  signalsBySymbol: {},
  minConfidence: 85,
  executionDelaySec: 0,
  priceFor: () => 100,
  cash: 100_000,
  equity: 100_000,
  dailyDrawdownPercent: 0,
  weeklyDrawdownPercent: 0,
  maxPositions: 7,
  candlesBySymbol: {}
};

const proBuys = (exitCooldown: Record<string, number>) =>
  generateProOrders({ ...proCtx, evaluations: [proEvaluation('B3')], exitCooldown } as never)
    .filter((o) => o.side === 'buy');

describe('Pro honours the re-entry cooldown (it previously had none)', () => {
  it('refuses the 11-minute re-buy that actually happened to B3', () => {
    expect(proBuys({ B3: Date.now() - 11 * MIN })).toHaveLength(0);
  });

  it('still refuses at 30 minutes — the old window was too short', () => {
    expect(proBuys({ B3: Date.now() - 30 * MIN })).toHaveLength(0);
  });

  it('allows the entry once the hour is up', () => {
    expect(proBuys({ B3: Date.now() - 61 * MIN })).toHaveLength(1);
  });

  it('allows a symbol that was never traded', () => {
    expect(proBuys({})).toHaveLength(1);
  });

  it('cools down only the symbol that exited, not the whole book', () => {
    const orders = generateProOrders({
      ...proCtx,
      evaluations: [proEvaluation('B3'), proEvaluation('INJ')],
      exitCooldown: { B3: Date.now() - 11 * MIN }
    } as never).filter((o) => o.side === 'buy');
    expect(orders.map((o) => o.symbol)).toEqual(['INJ']);
  });
});
