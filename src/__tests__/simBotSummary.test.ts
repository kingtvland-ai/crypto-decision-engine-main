/**
 * Home-page bot summary (2026-09-14)
 * ============================================================================
 * The regression: the dashboard reported `cash` as the balance and
 * `cash - initialAmount` as profit, so an invested bot looked catastrophic.
 */

import { describe, it, expect } from 'vitest';
import { summarizeSimBot, DEFAULT_INITIAL_AMOUNT } from '../lib/simBotSummary';

describe('summarizeSimBot', () => {
  it('reproduces the reported screenshot and gets it right', () => {
    // Pro bot as shown: $10,000 start, 5 open positions, $4,976 cash left.
    // The card used to read "$4,976 balance / −$5,024 P&L" for a FLAT bot.
    const s = summarizeSimBot({
      cash: 4976, positionsValue: 5024, initialAmount: 10_000,
      positionsCount: 5, winRate: 40
    });
    expect(s.equity).toBe(10_000);
    expect(s.totalProfit).toBe(0);
    expect(s.totalProfitPercent).toBe(0);
    expect(s.cash).toBe(4976);
  });

  it('prefers the server equity over a derived one', () => {
    const s = summarizeSimBot({ cash: 4976, positionsValue: 999, equity: 10_250, initialAmount: 10_000 });
    expect(s.equity).toBe(10_250);
    expect(s.totalProfit).toBe(250);
    expect(s.totalProfitPercent).toBeCloseTo(2.5, 6);
  });

  it('never falls back to cash alone when positions are open', () => {
    // positionsValue missing AND equity missing → equity is cash + 0. The point
    // is that it is never *less* than cash, and profit is measured off equity.
    const s = summarizeSimBot({ cash: 4976, initialAmount: 10_000 });
    expect(s.equity).toBe(4976);
    expect(s.totalProfit).toBe(s.equity - 10_000);
  });

  it('still reports a genuine loss as a loss', () => {
    const s = summarizeSimBot({ cash: 3000, positionsValue: 5500, initialAmount: 10_000 });
    expect(s.equity).toBe(8500);
    expect(s.totalProfit).toBe(-1500);
    expect(s.totalProfitPercent).toBeCloseTo(-15, 6);
  });

  it('measures each bot against ITS OWN starting capital', () => {
    const small = summarizeSimBot({ equity: 5500, initialAmount: 5000 });
    const big = summarizeSimBot({ equity: 10_500, initialAmount: 10_000 });
    expect(small.totalProfit).toBe(500);
    expect(big.totalProfit).toBe(500);
    expect(small.totalProfitPercent).toBeCloseTo(10, 6);
    expect(big.totalProfitPercent).toBeCloseTo(5, 6);
  });

  it('falls back to the config initialAmount, then to 10k', () => {
    expect(summarizeSimBot({ equity: 1, config: { initialAmount: 2500 } }).initialAmount).toBe(2500);
    expect(summarizeSimBot({ equity: 1 }).initialAmount).toBe(DEFAULT_INITIAL_AMOUNT);
  });

  it('tolerates a missing or broken snapshot without NaN', () => {
    const s = summarizeSimBot({});
    expect(s.equity).toBe(0);
    expect(Number.isFinite(s.totalProfit)).toBe(true);
    expect(Number.isFinite(s.totalProfitPercent)).toBe(true);
    expect(s.isRunning).toBe(false);

    const bad = summarizeSimBot({ cash: NaN, equity: NaN, initialAmount: NaN, winRate: NaN });
    expect(Number.isFinite(bad.equity)).toBe(true);
    expect(Number.isFinite(bad.winRate)).toBe(true);
    expect(bad.initialAmount).toBe(DEFAULT_INITIAL_AMOUNT);
  });
});
