/**
 * Logical trades — grouping exit events by positionId (2026-09-18)
 * ============================================================================
 * Every partial fill and every final close used to be counted as its OWN
 * independent win/loss. A TP1 partial (+$12.89) followed by a break-even
 * close (-$2.91) on the SAME position counted as one win AND one loss, net
 * +$9.98 nowhere reflected. `aggregateLogicalTrades`/`summarizeLogicalTrades`
 * fix the AGGREGATION only — per-leg pnl/pnlPercent (simExecution.ts) were
 * already correct and are untouched here, and no entry/TP/SL/decision logic
 * changes.
 */

import { describe, it, expect } from 'vitest';
import { aggregateLogicalTrades, summarizeLogicalTrades, type LogicalTrade } from '@cde/engine/execution';
import type { SimTrade } from '@cde/engine/execution';

let seq = 0;
function leg(over: Partial<SimTrade> & { positionId: string }): SimTrade {
  seq++;
  return {
    id: `t${seq}`, symbol: 'LA', type: 'SPOT', side: 'close_long',
    price: 100, requestedPrice: 100, slippagePercent: 0, fee: 0, delayMs: 0,
    quantity: 1, usdValue: 100, leverage: 1, timestamp: '', at: seq,
    reason: '', confidence: 80,
    ...over
  } as SimTrade;
}

describe('aggregateLogicalTrades', () => {
  it('TP1 partial in profit + break-even close in a small loss → ONE trade, net WIN', () => {
    const trades: SimTrade[] = [
      leg({ positionId: 'p1', side: 'partial_tp1', pnl: 12.89, pnlPercent: 3.0 }),
      leg({ positionId: 'p1', side: 'close_long', pnl: -2.91, pnlPercent: -1.5 })
    ];
    const logical = aggregateLogicalTrades(trades);
    expect(logical).toHaveLength(1);
    const [lt] = logical;
    expect(lt.isClosed).toBe(true);
    expect(lt.netPnl).toBeCloseTo(9.98, 6);
    expect(lt.isWin).toBe(true);
    expect(lt.exitLegs).toHaveLength(2);
  });

  it('TP1 partial + TP2 full close (both wins) → ONE trade', () => {
    const trades: SimTrade[] = [
      leg({ positionId: 'p2', side: 'partial_tp1', pnl: 10, pnlPercent: 3 }),
      leg({ positionId: 'p2', side: 'close_long', pnl: 8, pnlPercent: 4 })
    ];
    const logical = aggregateLogicalTrades(trades);
    expect(logical).toHaveLength(1);
    expect(logical[0].netPnl).toBeCloseTo(18, 6);
    expect(logical[0].isWin).toBe(true);
  });

  it('TP1 partial (win) + stop-loss full close (bigger loss) → ONE trade, net LOSS', () => {
    const trades: SimTrade[] = [
      leg({ positionId: 'p3', side: 'partial_tp1', pnl: 5, pnlPercent: 2 }),
      leg({ positionId: 'p3', side: 'close_long', pnl: -20, pnlPercent: -4.2 })
    ];
    const logical = aggregateLogicalTrades(trades);
    expect(logical).toHaveLength(1);
    expect(logical[0].netPnl).toBeCloseTo(-15, 6);
    expect(logical[0].isWin).toBe(false);
  });

  it('LONG and SHORT positions aggregate independently by positionId', () => {
    const trades: SimTrade[] = [
      leg({ positionId: 'long1', side: 'close_long', pnl: 5, pnlPercent: 2 }),
      leg({ positionId: 'short1', side: 'close_short', pnl: -3, pnlPercent: -1 })
    ];
    const logical = aggregateLogicalTrades(trades);
    expect(logical).toHaveLength(2);
    expect(logical.find((l) => l.positionId === 'long1')?.isWin).toBe(true);
    expect(logical.find((l) => l.positionId === 'short1')?.isWin).toBe(false);
  });

  it('slippage between the nominal stop and the actual fill: the logical trade uses the REAL executed pnl, not a theoretical one', () => {
    // Nominal SL would have been -$10; an adverse gap-through fill actually
    // executed worse, at -$11.20. The logical trade must reflect what
    // actually happened, not the pre-slippage number.
    const trades: SimTrade[] = [
      leg({ positionId: 'p4', side: 'close_long', pnl: -11.2, pnlPercent: -2.3, slippagePercent: 0.15 })
    ];
    const logical = aggregateLogicalTrades(trades);
    expect(logical[0].netPnl).toBeCloseTo(-11.2, 6);
  });

  it('a trade with no partial exit — a single full close — is still one logical trade', () => {
    const trades: SimTrade[] = [
      leg({ positionId: 'p5', side: 'close_long', pnl: 7.5, pnlPercent: 3.1 })
    ];
    const logical = aggregateLogicalTrades(trades);
    expect(logical).toHaveLength(1);
    expect(logical[0].exitLegs).toHaveLength(1);
    expect(logical[0].netPnl).toBeCloseTo(7.5, 6);
    expect(logical[0].isWin).toBe(true);
  });

  it('an entry leg with no pnl is grouped in but does not count as an exit event', () => {
    const trades: SimTrade[] = [
      leg({ positionId: 'p6', side: 'buy', pnl: undefined, pnlPercent: undefined }),
      leg({ positionId: 'p6', side: 'close_long', pnl: 4, pnlPercent: 1.5 })
    ];
    const logical = aggregateLogicalTrades(trades);
    expect(logical).toHaveLength(1);
    expect(logical[0].legs).toHaveLength(2);
    expect(logical[0].exitLegs).toHaveLength(1);
  });

  it('an open position (partial fill, no full close yet) is not counted as closed', () => {
    const trades: SimTrade[] = [
      leg({ positionId: 'p7', side: 'partial_tp1', pnl: 5, pnlPercent: 2 })
    ];
    const logical = aggregateLogicalTrades(trades);
    expect(logical[0].isClosed).toBe(false);
    expect(logical[0].netPnl).toBeUndefined();
    expect(logical[0].isWin).toBeUndefined();
  });

  it('legacy rows with no positionId each become their own singleton logical trade (backward compatible)', () => {
    const trades: SimTrade[] = [
      leg({ positionId: undefined as unknown as string, id: 'legacy-1', side: 'close_long', pnl: 3, pnlPercent: 1 }),
      leg({ positionId: undefined as unknown as string, id: 'legacy-2', side: 'close_long', pnl: -2, pnlPercent: -1 })
    ];
    const logical = aggregateLogicalTrades(trades);
    expect(logical).toHaveLength(2);
    expect(logical[0].netPnl).toBeCloseTo(3, 6);
    expect(logical[1].netPnl).toBeCloseTo(-2, 6);
  });
});

describe('summarizeLogicalTrades', () => {
  function buildBook(): SimTrade[] {
    return [
      // p1: TP1 win + BE small loss → net WIN (+9.98)
      leg({ positionId: 'p1', side: 'partial_tp1', pnl: 12.89, pnlPercent: 3.0 }),
      leg({ positionId: 'p1', side: 'close_long', pnl: -2.91, pnlPercent: -1.5 }),
      // p3: TP1 win + SL big loss → net LOSS (-15)
      leg({ positionId: 'p3', side: 'partial_tp1', pnl: 5, pnlPercent: 2 }),
      leg({ positionId: 'p3', side: 'close_long', pnl: -20, pnlPercent: -4.2 }),
      // p5: single full close → net WIN (+7.5)
      leg({ positionId: 'p5', side: 'close_long', pnl: 7.5, pnlPercent: 3.1 }),
      // p7: still open (partial only) — must not count toward win/loss
      leg({ positionId: 'p7', side: 'partial_tp1', pnl: 5, pnlPercent: 2 })
    ];
  }

  it('reports Logical Trades, Exit Events, Wins, Losses, Win Rate, Gross Profit/Loss, Net PnL, Avg PnL separately', () => {
    const stats = summarizeLogicalTrades(buildBook());
    expect(stats.logicalTradeCount).toBe(4); // p1, p3, p5, p7
    expect(stats.closedLogicalTradeCount).toBe(3); // p7 excluded (still open)
    expect(stats.exitEventCount).toBe(6); // every row with a pnl, including p7's open partial
    expect(stats.wins).toBe(2); // p1, p5
    expect(stats.losses).toBe(1); // p3
    expect(stats.winRate).toBeCloseTo((2 / 3) * 100, 2);
    expect(stats.grossProfit).toBeCloseTo(9.98 + 7.5, 2);
    expect(stats.grossLoss).toBeCloseTo(-15, 2);
    expect(stats.netRealizedPnl).toBeCloseTo(9.98 + 7.5 - 15, 2);
    expect(stats.avgPnlPerLogicalTrade).toBeCloseTo(stats.netRealizedPnl / 3, 2);
  });

  it('invariant: the sum of every CLOSED logical trade\'s netPnl equals netRealizedPnl exactly', () => {
    const trades = buildBook();
    const logical = aggregateLogicalTrades(trades).filter((lt) => lt.isClosed);
    const summedFromLogical = logical.reduce((s, lt) => s + (lt.netPnl ?? 0), 0);
    const stats = summarizeLogicalTrades(trades);
    expect(stats.netRealizedPnl).toBeCloseTo(summedFromLogical, 6);
  });

  it('an empty book reports zeros, not NaN or a crash', () => {
    const stats = summarizeLogicalTrades([]);
    expect(stats).toEqual({
      logicalTradeCount: 0, closedLogicalTradeCount: 0, exitEventCount: 0,
      wins: 0, losses: 0, winRate: 0, grossProfit: 0, grossLoss: 0,
      netRealizedPnl: 0, avgPnlPerLogicalTrade: 0
    });
  });
});
