import { describe, it, expect } from 'vitest';
import { evaluateExit } from '@cde/engine/execution';
import type { ActivePosition } from '@cde/engine';

function makePosition(overrides: Partial<ActivePosition> = {}): ActivePosition {
  return {
    id: 'test-1',
    symbol: 'BTCUSDT',
    type: 'SPOT',
    side: 'BUY',
    quantity: 0.1,
    entryPrice: 100,
    currentPrice: 100,
    avgPrice: 100,
    leverage: 1,
    marginUsd: 10,
    notionalUsd: 10,
    stopLoss: 95,
    takeProfit1: 110,
    takeProfit2: 120,
    trailingStopActive: false,
    trailingStopPrice: 90,
    highestPriceSinceTP1: undefined,
    lowestPriceSinceTP1: undefined,
    highestPrice: undefined,
    lowestPrice: undefined,
    tp1Hit: false,
    openedAt: new Date().toISOString(),
    openTimestamp: Date.now(),
    entryFee: 0.1,
    reason: 'test',
    confidence: 50,
    ...overrides
  };
}

describe('evaluateExit', () => {
  it('returns FULL exit on weekly drawdown >= 15%', () => {
    const pos = makePosition();
    const result = evaluateExit(pos, 100, 1, { buy: 0, sell: 0 }, { dailyDrawdownPercent: 5, weeklyDrawdownPercent: 15 });
    expect(result.shouldExit).toBe(true);
    expect(result.exitType).toBe('FULL');
  });

  it('returns FULL exit on stop loss hit for LONG', () => {
    const pos = makePosition({ type: 'FUTURES', side: 'LONG', stopLoss: 100 });
    const result = evaluateExit(pos, 99, 1, { buy: 0, sell: 0 }, { dailyDrawdownPercent: 0, weeklyDrawdownPercent: 0 });
    expect(result.shouldExit).toBe(true);
    expect(result.exitType).toBe('FULL');
  });

  it('returns FULL exit on stop loss hit for SHORT', () => {
    const pos = makePosition({ type: 'FUTURES', side: 'SHORT', stopLoss: 100 });
    const result = evaluateExit(pos, 101, 1, { buy: 0, sell: 0 }, { dailyDrawdownPercent: 0, weeklyDrawdownPercent: 0 });
    expect(result.shouldExit).toBe(true);
    expect(result.exitType).toBe('FULL');
  });

  it('returns FULL exit on spot take profit', () => {
    const pos = makePosition({ takeProfit1: 110 });
    const result = evaluateExit(pos, 111, 1, { buy: 0, sell: 0 }, { dailyDrawdownPercent: 0, weeklyDrawdownPercent: 0 });
    expect(result.shouldExit).toBe(true);
    expect(result.exitType).toBe('FULL');
  });

  it('returns FULL exit on futures TP2 for LONG', () => {
    const pos = makePosition({ type: 'FUTURES', side: 'LONG', takeProfit1: 110, takeProfit2: 120 });
    const result = evaluateExit(pos, 121, 1, { buy: 0, sell: 0 }, { dailyDrawdownPercent: 0, weeklyDrawdownPercent: 0 });
    expect(result.shouldExit).toBe(true);
    expect(result.exitType).toBe('FULL');
  });

  it('returns PARTIAL_50 on futures TP1 for LONG', () => {
    const pos = makePosition({ type: 'FUTURES', side: 'LONG', takeProfit1: 110, takeProfit2: 120, tp1Hit: false });
    const result = evaluateExit(pos, 111, 1, { buy: 0, sell: 0 }, { dailyDrawdownPercent: 0, weeklyDrawdownPercent: 0 });
    expect(result.shouldExit).toBe(true);
    expect(result.exitType).toBe('PARTIAL_50');
  });

  it('returns PARTIAL_50 on futures TP1 for SHORT', () => {
    const pos = makePosition({ type: 'FUTURES', side: 'SHORT', takeProfit1: 90, takeProfit2: 80, tp1Hit: false });
    const result = evaluateExit(pos, 89, 1, { buy: 0, sell: 0 }, { dailyDrawdownPercent: 0, weeklyDrawdownPercent: 0 });
    expect(result.shouldExit).toBe(true);
    expect(result.exitType).toBe('PARTIAL_50');
  });

  it('does NOT trail a futures LONG after TP1 — the remainder runs to TP2', () => {
    // The trailing stop was removed. It accounted for 43.3% of this engine's
    // exits over six months while ZERO trades ever reached their take-profit,
    // so it was not protecting gains — it was ending winners before the target
    // could arrive. A position that has pulled back from its peak but is still
    // above its stop and below TP2 now simply stays open.
    const pos = makePosition({
      type: 'FUTURES',
      side: 'LONG',
      takeProfit1: 110,
      takeProfit2: 120,
      tp1Hit: true,
      highestPriceSinceTP1: 115,
      entryPrice: 100
    });
    const result = evaluateExit(pos, 113, 2, { buy: 0, sell: 0 }, { dailyDrawdownPercent: 0, weeklyDrawdownPercent: 0 });
    expect(result.shouldExit).toBe(false);
    expect(result.exitType).not.toBe('TRAILING_STOP');
  });

  it('still exits the futures LONG at TP2', () => {
    // Removing the trail must not have removed the target it was pre-empting.
    const pos = makePosition({
      type: 'FUTURES', side: 'LONG', takeProfit1: 110, takeProfit2: 120,
      tp1Hit: true, highestPriceSinceTP1: 115, entryPrice: 100
    });
    const result = evaluateExit(pos, 121, 2, { buy: 0, sell: 0 }, { dailyDrawdownPercent: 0, weeklyDrawdownPercent: 0 });
    expect(result.shouldExit).toBe(true);
    expect(result.exitType).toBe('FULL');
  });

  it('returns REVERSAL on strong opposite signal for LONG beyond TP1', () => {
    const pos = makePosition({ 
      type: 'FUTURES', 
      side: 'LONG', 
      stopLoss: 95, 
      takeProfit1: 110, 
      takeProfit2: 120, 
      tp1Hit: true,
      highestPriceSinceTP1: 115 
    });
    // Price 115 is beyond TP1 (110) but below TP2 (120) — reversal should fire
    const result = evaluateExit(pos, 115, 1, { buy: 0, sell: 70 }, { dailyDrawdownPercent: 0, weeklyDrawdownPercent: 0 });
    expect(result.shouldExit).toBe(true);
    expect(result.exitType).toBe('REVERSAL');
  });

  it('returns TIME_BASED for spot after 72h with loss beyond SL', () => {
    const pos = makePosition({
      openTimestamp: Date.now() - 72 * 60 * 60 * 1000,
      entryPrice: 100,
      stopLoss: 98.2
    });
    // Price at 97 is beyond SL (98.2) — SL hit takes precedence, returns FULL
    const result = evaluateExit(pos, 97, 1, { buy: 0, sell: 0 }, { dailyDrawdownPercent: 0, weeklyDrawdownPercent: 0 });
    expect(result.shouldExit).toBe(true);
    expect(result.exitType).toBe('FULL');
  });

  it('returns PARTIAL_50 for futures after 24h beyond TP1 without TP1 hit', () => {
    const pos = makePosition({
      type: 'FUTURES',
      side: 'LONG',
      takeProfit1: 110,
      tp1Hit: false,
      openTimestamp: Date.now() - 24 * 60 * 60 * 1000
    });
    // Price beyond TP1 (110) — time stop should fire
    const result = evaluateExit(pos, 111, 1, { buy: 0, sell: 0 }, { dailyDrawdownPercent: 0, weeklyDrawdownPercent: 0 });
    expect(result.shouldExit).toBe(true);
    expect(result.exitType).toBe('PARTIAL_50');
  });

  it('returns NONE when no exit conditions met', () => {
    const pos = makePosition({ type: 'FUTURES', side: 'LONG', takeProfit1: 110, tp1Hit: false });
    const result = evaluateExit(pos, 105, 1, { buy: 50, sell: 0 }, { dailyDrawdownPercent: 0, weeklyDrawdownPercent: 0 });
    expect(result.shouldExit).toBe(false);
    expect(result.exitType).toBe('NONE');
  });
});
