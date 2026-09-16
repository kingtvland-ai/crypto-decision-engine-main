/**
 * Walk-forward validation — TRAIN / VALIDATION / OOS (2026-09-16)
 * ============================================================================
 * The discipline, pinned. The interesting tests here are not the arithmetic —
 * they are the REFUSALS: the out-of-sample budget that throws when a second
 * configuration is aimed at a window already spent, and the survivor rule that
 * refuses to call one good window an edge.
 */
import { describe, it, expect } from 'vitest';
import {
  splitWalkForward,
  rollingWalkForward,
  scoreRun,
  nullExpectation,
  judgeSurvivor,
  assertOosUnspent,
  hashConfig,
  DEFAULT_SURVIVOR_RULE,
  type OosLedgerEntry,
  type RunScore
} from '@cde/engine/volatility';

const DAY = 24 * 3_600_000;
const T0 = Date.UTC(2025, 0, 1);

describe('splitWalkForward', () => {
  it('splits 60/20/20 by TIME, contiguous and non-overlapping', () => {
    const s = splitWalkForward(T0, T0 + 100 * DAY);
    expect(s.train.from).toBe(T0);
    expect(s.train.to).toBe(T0 + 60 * DAY);
    expect(s.validation.from).toBe(s.train.to);
    expect(s.validation.to).toBe(T0 + 80 * DAY);
    expect(s.oos.from).toBe(s.validation.to);
    expect(s.oos.to).toBe(T0 + 100 * DAY);
    expect(s.train.label).toBe('TRAIN');
    expect(s.oos.label).toBe('OOS');
  });

  it('honours custom fractions', () => {
    const s = splitWalkForward(T0, T0 + 100 * DAY, 0.5, 0.25);
    expect(s.train.to).toBe(T0 + 50 * DAY);
    expect(s.validation.to).toBe(T0 + 75 * DAY);
  });

  it('refuses fractions that leave no out-of-sample window', () => {
    expect(() => splitWalkForward(T0, T0 + 100 * DAY, 0.8, 0.2)).toThrow(/room for OOS/);
    expect(() => splitWalkForward(T0, T0 + 100 * DAY, 0.9, 0.3)).toThrow(/room for OOS/);
  });

  it('refuses an empty range', () => {
    expect(() => splitWalkForward(T0, T0)).toThrow(/empty range/);
  });
});

describe('rollingWalkForward', () => {
  it('produces stepped windows, each its own three-way split', () => {
    const windows = rollingWalkForward(T0, T0 + 100 * DAY, 40 * DAY, 20 * DAY);
    expect(windows).toHaveLength(4);
    expect(windows[0].train.from).toBe(T0);
    expect(windows[1].train.from).toBe(T0 + 20 * DAY);
    for (const w of windows) {
      expect(w.oos.to - w.train.from).toBe(40 * DAY);
    }
  });

  it('never emits a window that runs past the data', () => {
    const windows = rollingWalkForward(T0, T0 + 50 * DAY, 40 * DAY, 20 * DAY);
    for (const w of windows) expect(w.oos.to).toBeLessThanOrEqual(T0 + 50 * DAY);
  });
});

describe('scoreRun', () => {
  it('scores a mixed book', () => {
    const s = scoreRun([{ pnl: 100 }, { pnl: -50 }, { pnl: 25 }, { pnl: -25 }]);
    expect(s.trades).toBe(4);
    expect(s.wins).toBe(2);
    expect(s.winRate).toBe(50);
    expect(s.netProfit).toBe(50);
    expect(s.grossWin).toBe(125);
    expect(s.grossLoss).toBe(75);
    expect(s.profitFactor).toBeCloseTo(125 / 75, 6);
    expect(s.expectancy).toBeCloseTo(12.5, 6);
  });

  it('ignores still-open trades (no pnl yet)', () => {
    expect(scoreRun([{ pnl: 10 }, {}, { at: 1 }]).trades).toBe(1);
  });

  it('is well-defined on an empty book instead of producing NaN', () => {
    const s = scoreRun([]);
    expect(s.trades).toBe(0);
    expect(s.profitFactor).toBe(0);
    expect(Number.isNaN(s.expectancy)).toBe(false);
  });

  it('reports an all-wins book as infinite profit factor, not a divide by zero', () => {
    expect(scoreRun([{ pnl: 5 }, { pnl: 5 }]).profitFactor).toBe(Infinity);
  });
});

describe('nullExpectation — the baseline "positive" has to beat', () => {
  it('a symmetric book has a coin-flip expectation of zero before costs', () => {
    const s = scoreRun([{ pnl: 100 }, { pnl: -100 }]);
    expect(nullExpectation(s, 0)).toBeCloseTo(0, 6);
  });

  it('costs make the null NEGATIVE — which is what makes beating zero too easy', () => {
    const s = scoreRun([{ pnl: 100 }, { pnl: -100 }]);
    expect(nullExpectation(s, 5)).toBeCloseTo(-10, 6);
  });

  it('is zero on an empty book', () => {
    expect(nullExpectation(scoreRun([]), 5)).toBe(0);
  });
});

describe('judgeSurvivor — one good window is not an edge', () => {
  const window = (pnls: number[]): RunScore => scoreRun(pnls.map((pnl) => ({ pnl })));
  /** 30 trades, comfortably profitable. */
  const good = () => window([...Array(20).fill(50), ...Array(10).fill(-20)]);
  /** 30 trades, losing. */
  const bad = () => window([...Array(10).fill(30), ...Array(20).fill(-40)]);

  it('refuses a single profitable window', () => {
    const v = judgeSurvivor([good(), bad(), bad()]);
    expect(v.survived).toBe(false);
    expect(v.windowsPositive).toBe(1);
    expect(v.reason).toMatch(/only 1\/3/);
  });

  it('passes once enough windows clear the null', () => {
    const v = judgeSurvivor([good(), good(), bad()]);
    expect(v.survived).toBe(true);
    expect(v.windowsPositive).toBe(2);
  });

  it('skips windows too thin to judge rather than counting them as failures', () => {
    const thin = window([50, -20]); // 2 trades
    const v = judgeSurvivor([good(), good(), thin]);
    expect(v.windowsSkipped).toBe(1);
    expect(v.windowsScored).toBe(2);
    expect(v.survived).toBe(true);
  });

  it('refuses to judge at all when no window is thick enough', () => {
    const v = judgeSurvivor([window([10]), window([10])]);
    expect(v.survived).toBe(false);
    expect(v.reason).toMatch(/nothing to judge/);
  });

  it('a LOSING book never survives, however badly a coin flip would have done', () => {
    // This is the case the null model alone would wave through: raising the
    // modelled cost makes the coin-flip baseline hugely negative, so a losing
    // strategy "beats" it. The separate netProfit > 0 test is what stops that.
    const losers = [bad(), bad(), bad()];
    const v = judgeSurvivor(losers, { ...DEFAULT_SURVIVOR_RULE, roundTripCostUsd: 1000 });
    expect(v.survived).toBe(false);
    expect(v.windowsPositive).toBe(0);
  });

  it('a profitable book survives whether or not costs are modelled — a higher cost LOWERS the null bar', () => {
    const scores = [good(), good()];
    expect(judgeSurvivor(scores, { ...DEFAULT_SURVIVOR_RULE, roundTripCostUsd: 0 }).survived).toBe(true);
    expect(judgeSurvivor(scores, { ...DEFAULT_SURVIVOR_RULE, roundTripCostUsd: 1000 }).survived).toBe(true);
  });
});

describe('the out-of-sample budget', () => {
  const entry = (datasetKey: string, configHash: string): OosLedgerEntry =>
    ({ datasetKey, configHash, at: T0, netProfit: 1 });

  it('allows the first look at a window', () => {
    expect(() => assertOosUnspent([], 'btc-2025H1', 'abc')).not.toThrow();
  });

  it('allows re-running the IDENTICAL config — that is a reproduction', () => {
    const ledger = [entry('btc-2025H1', 'abc')];
    expect(() => assertOosUnspent(ledger, 'btc-2025H1', 'abc')).not.toThrow();
  });

  it('REFUSES a different config against a window already spent', () => {
    const ledger = [entry('btc-2025H1', 'abc')];
    expect(() => assertOosUnspent(ledger, 'btc-2025H1', 'def'))
      .toThrow(/already been spent/);
  });

  it('explains WHY, not just that it refused', () => {
    const ledger = [entry('btc-2025H1', 'abc')];
    expect(() => assertOosUnspent(ledger, 'btc-2025H1', 'def'))
      .toThrow(/makes it training data/);
  });

  it('keeps datasets independent — spending one does not spend another', () => {
    const ledger = [entry('btc-2025H1', 'abc')];
    expect(() => assertOosUnspent(ledger, 'eth-2025H1', 'def')).not.toThrow();
  });
});

describe('hashConfig', () => {
  it('is stable across key order', () => {
    expect(hashConfig({ a: 1, b: 2 })).toBe(hashConfig({ b: 2, a: 1 }));
  });

  it('separates configs that differ in any value', () => {
    expect(hashConfig({ a: 1 })).not.toBe(hashConfig({ a: 2 }));
  });

  it('is a short hex string', () => {
    expect(hashConfig({ a: 1 })).toMatch(/^[0-9a-f]{8}$/);
  });
});
