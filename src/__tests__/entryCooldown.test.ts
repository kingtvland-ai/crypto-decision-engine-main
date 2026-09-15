/**
 * Re-entry cooldown (2026-09-14, revised same day; smart/recompute 2026-09-16)
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
 * fire on every exit, reverted to losses-only on operator request, then
 * reopened 2026-09-16: a WINNING ratchet exit on FLOCK was followed 76
 * seconds later by a fresh re-entry on the same symbol, which then stopped
 * out. Every full exit — win or loss — now leaves cooldown state, and
 * isInEntryCooldown recomputes a recovery-based verdict against the LIVE
 * price on every check (resolveReentryRecovery) instead of trusting a
 * duration frozen once at exit — with a hard SMART_COOLDOWN_FLOOR_MS (5 min)
 * floor even on the strongest apparent recovery.
 */

import { describe, it, expect } from 'vitest';
import {
  ENTRY_COOLDOWN_MS, SMART_COOLDOWN_FLOOR_MS, isInEntryCooldown, fillDueOrders,
  type PendingOrder, type SimPosition, type ReentryCooldownState
} from '@cde/engine/execution';

const MIN = 60_000;

describe('ENTRY_COOLDOWN_MS / SMART_COOLDOWN_FLOOR_MS', () => {
  it('full cooldown is an hour, the floor is 5 minutes', () => {
    expect(ENTRY_COOLDOWN_MS).toBe(60 * MIN);
    expect(SMART_COOLDOWN_FLOOR_MS).toBe(5 * MIN);
  });

  it('a flat exit price (no recovery either way) needs the full hour', () => {
    const now = 10_000_000;
    const cooldown: ReentryCooldownState = { at: now - 11 * MIN, exitPrice: 100, isLong: true };
    expect(isInEntryCooldown(cooldown, 100, now)).toBe(true);   // the B3 gap
    expect(isInEntryCooldown({ ...cooldown, at: now - 30 * MIN }, 100, now)).toBe(true);
    expect(isInEntryCooldown({ ...cooldown, at: now - 59 * MIN }, 100, now)).toBe(true);
    expect(isInEntryCooldown({ ...cooldown, at: now - 61 * MIN }, 100, now)).toBe(false);
  });

  it('strong recovery still cannot bypass the 5-minute floor', () => {
    const now = 10_000_000;
    const cooldown: ReentryCooldownState = { at: now - MIN, exitPrice: 100, isLong: true };
    expect(isInEntryCooldown(cooldown, 100.6, now)).toBe(true); // +0.6%, but only 1 min elapsed
    expect(isInEntryCooldown(cooldown, 100.6, now + 5 * MIN)).toBe(false); // floor cleared
  });

  it('treats a symbol that never traded as free', () => {
    expect(isInEntryCooldown(undefined, 100)).toBe(false);
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

describe('the fill core writes cooldown state on every full exit, win or loss', () => {
  it('writes cooldown state after a WINNING exit too (2026-09-16, FLOCK)', () => {
    const res = fill(closeOrder(), position(), 1.05);
    expect(res.newTrades[0].pnl!).toBeGreaterThan(0);
    expect(res.newCooldowns.B3).toBeDefined();
    expect(res.newCooldowns.B3.exitPrice).toBe(1.05);
    expect(res.newCooldowns.B3.isLong).toBe(true);
  });

  it('writes one after a losing exit', () => {
    const res = fill(closeOrder(), position(), 0.95);
    expect(res.newTrades[0].pnl!).toBeLessThan(0);
    expect(res.newCooldowns.B3.at).toBeGreaterThan(0);
    expect(isInEntryCooldown(res.newCooldowns.B3, 0.95)).toBe(true);
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

// exitPrice pinned to the evaluation's own price (100) so recovery is exactly
// 0% — the "no proof yet" case that needs the full hour, matching the B3
// incident this cooldown exists for.
const flatExit = (minutesAgo: number): ReentryCooldownState => ({
  at: Date.now() - minutesAgo * MIN, exitPrice: 100, isLong: true
});

const proBuys = (exitCooldown: Record<string, ReentryCooldownState>) =>
  generateProOrders({ ...proCtx, evaluations: [proEvaluation('B3')], exitCooldown } as never)
    .filter((o) => o.side === 'buy');

describe('Pro honours the re-entry cooldown (it previously had none)', () => {
  it('refuses the 11-minute re-buy that actually happened to B3', () => {
    expect(proBuys({ B3: flatExit(11) })).toHaveLength(0);
  });

  it('still refuses at 30 minutes — the old window was too short', () => {
    expect(proBuys({ B3: flatExit(30) })).toHaveLength(0);
  });

  it('allows the entry once the hour is up', () => {
    expect(proBuys({ B3: flatExit(61) })).toHaveLength(1);
  });

  it('allows a symbol that was never traded', () => {
    expect(proBuys({})).toHaveLength(1);
  });

  it('cools down only the symbol that exited, not the whole book', () => {
    const orders = generateProOrders({
      ...proCtx,
      evaluations: [proEvaluation('B3'), proEvaluation('INJ')],
      exitCooldown: { B3: flatExit(11) }
    } as never).filter((o) => o.side === 'buy');
    expect(orders.map((o) => o.symbol)).toEqual(['INJ']);
  });
});
