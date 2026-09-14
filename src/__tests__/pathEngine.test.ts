import { describe, it, expect } from 'vitest';
import {
  aggregateToH4,
  evaluatePathDecision,
  pathKellyFraction,
  buildPathTable,
  measureBarPaths,
  wilsonLowerBound,
  fearGreedBucket,
  barOpenFor,
  slotIndexAt,
  selectBucket,
  SLOTS_PER_BAR,
  BAR_MS,
  SLOT_MS
} from '@cde/engine/analysis';
import type { PathBucket, PathOutcome, BarState } from '@cde/engine/analysis';
import { MIN_PATH_CANDLES } from '@cde/engine/execution';
import type { Candle } from '@cde/engine';

const HOUR = 3_600_000;
// A 4H bar boundary, so the fixtures line up with real bar opens.
const T0 = barOpenFor(1_700_000_000_000);

function candles(n: number, stepMs: number, start = 100, drift = 0): Candle[] {
  const out: Candle[] = [];
  let price = start;
  let x = 13;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const open = price;
    price = price * (1 + ((x / 2147483648) - 0.5) * 0.01 + drift);
    out.push({
      timestamp: T0 + i * stepMs,
      open, high: Math.max(open, price) * 1.001, low: Math.min(open, price) * 0.999,
      close: price, volume: 1000 + (i % 5) * 50
    });
  }
  return out;
}

const STATE: BarState = { regime: 'TRENDING_UP', fng: 'FEAR' };

describe('4H aggregation', () => {
  it('folds four H1 candles into one bar with the right OHLCV', () => {
    const h1: Candle[] = [
      { timestamp: T0 + 0 * HOUR, open: 10, high: 12, low: 9, close: 11, volume: 100 },
      { timestamp: T0 + 1 * HOUR, open: 11, high: 15, low: 10, close: 14, volume: 200 },
      { timestamp: T0 + 2 * HOUR, open: 14, high: 14, low: 8, close: 9, volume: 300 },
      { timestamp: T0 + 3 * HOUR, open: 9, high: 13, low: 9, close: 12, volume: 400 }
    ];
    const [bar] = aggregateToH4(h1);
    expect(bar.timestamp).toBe(T0);
    expect(bar.open).toBe(10);
    expect(bar.high).toBe(15);
    expect(bar.low).toBe(8);
    expect(bar.close).toBe(12);
    expect(bar.volume).toBe(1000);
  });

  it('drops an incomplete group rather than calling three hours a 4H bar', () => {
    const h1 = candles(6, HOUR);
    expect(aggregateToH4(h1)).toHaveLength(1);
  });

  it('produces one bar per four hours over a long series', () => {
    expect(aggregateToH4(candles(240, HOUR))).toHaveLength(60);
  });
});

describe('slot arithmetic', () => {
  it('maps a moment to its 15-minute slot inside the bar', () => {
    expect(slotIndexAt(T0, T0)).toBe(0);
    expect(slotIndexAt(T0 + 14 * 60_000, T0)).toBe(0);
    expect(slotIndexAt(T0 + SLOT_MS, T0)).toBe(1);
    expect(slotIndexAt(T0 + 15 * SLOT_MS, T0)).toBe(15);
  });

  it('aligns bars to the epoch, the way exchanges bucket them', () => {
    expect(barOpenFor(T0 + 3 * HOUR + 59 * 60_000)).toBe(T0);
    expect(barOpenFor(T0 + BAR_MS)).toBe(T0 + BAR_MS);
  });
});

describe('Wilson lower bound', () => {
  it('charges a small sample for its own uncertainty', () => {
    // Same 75% hit rate, twelve samples versus four hundred. The thin one is
    // discounted far harder, which is the whole reason the table ranks on this
    // number instead of the raw rate.
    const thin = wilsonLowerBound(9, 12);
    const thick = wilsonLowerBound(300, 400);
    expect(thin).toBeLessThan(thick);
    expect(0.75 - thin).toBeGreaterThan(3 * (0.75 - thick));
  });

  it('converges towards the point estimate as samples grow', () => {
    expect(wilsonLowerBound(4500, 10_000)).toBeGreaterThan(0.44);
    expect(wilsonLowerBound(4500, 10_000)).toBeLessThan(0.45);
  });

  it('is zero on no evidence', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });
});

describe('fear and greed bucketing', () => {
  it('splits the 0-100 scale into the five named regions', () => {
    expect(fearGreedBucket(10)).toBe('EXTREME_FEAR');
    expect(fearGreedBucket(30)).toBe('FEAR');
    expect(fearGreedBucket(50)).toBe('NEUTRAL');
    expect(fearGreedBucket(65)).toBe('GREED');
    expect(fearGreedBucket(90)).toBe('EXTREME_GREED');
  });
});

describe('path measurement', () => {
  // A bar that rises monotonically: every long entry runs to profit, every
  // short entry is stopped.
  const rising: Candle[] = Array.from({ length: SLOTS_PER_BAR }, (_, i) => ({
    timestamp: T0 + i * SLOT_MS,
    open: 100 + i, high: 100 + i + 0.5, low: 100 + i - 0.5, close: 100 + i + 1, volume: 100
  }));

  it('measures favourable and adverse excursion in R', () => {
    // Explicit 3-slot horizon: this test is about the excursion maths, not about
    // the forward budget, and at the full 16-slot horizon no slot in a 16-candle
    // bar has a complete forward window.
    const outcomes = measureBarPaths(STATE, T0, rising, [], 1, 3);
    const longs = outcomes.filter((o) => o.direction === 'LONG');
    const shorts = outcomes.filter((o) => o.direction === 'SHORT');
    expect(longs.length).toBeGreaterThan(0);
    expect(longs[0].mfeR).toBeGreaterThan(0);
    // The mirror trade on the same bar must be stopped — a measurement that
    // showed both sides winning would mean the walk is not directional.
    expect(shorts[0].stopped).toBe(true);
  });

  it('assumes the adverse extreme prints first inside a candle', () => {
    // One candle that touches −1R and then +5R. Optimistic ordering would call
    // this a win; the honest answer is that the stop was hit.
    const slots: Candle[] = [
      { timestamp: T0, open: 100, high: 100, low: 100, close: 100, volume: 1 },
      { timestamp: T0 + SLOT_MS, open: 100, high: 105, low: 99, close: 105, volume: 1 }
    ];
    const [long] = measureBarPaths(STATE, T0, slots, [], 1, 1).filter((o) => o.direction === 'LONG' && o.slot === 0);
    expect(long.stopped).toBe(true);
    expect(long.mfeR).toBe(0);
  });

  it('discards a slot whose forward window is short rather than scoring it', () => {
    // No forward candles at all: at the full 16-slot horizon not one slot has a
    // complete window, so nothing is measured. Accepting the short windows would
    // have scored late slots against fewer candles than early ones — a bias in
    // exactly the comparison the study exists to make.
    expect(measureBarPaths(STATE, T0, rising, [], 1)).toHaveLength(0);
  });

  it('gives every slot the same forward budget, including the last', () => {
    const forward: Candle[] = Array.from({ length: SLOTS_PER_BAR }, (_, i) => ({
      timestamp: T0 + BAR_MS + i * SLOT_MS,
      open: 116 + i, high: 116 + i + 0.5, low: 116 + i - 0.5, close: 116 + i + 1, volume: 100
    }));
    const withForward = measureBarPaths(STATE, T0, rising, forward, 1);
    const lastSlot = withForward.filter((o) => o.slot === 15 && o.direction === 'LONG');
    // Without the forward window slot 15 would have nothing to measure at all.
    expect(lastSlot).toHaveLength(1);
    expect(lastSlot[0].mfeR).toBeGreaterThan(0);
  });
});

describe('table construction', () => {
  function outcomes(n: number, mfeR: number, slot = 3): PathOutcome[] {
    return Array.from({ length: n }, (_, i) => ({
      state: STATE, slot, direction: 'LONG' as const,
      mfeR, maeR: 0.2, stopped: false, terminalR: 0, costR: 0, at: Date.now() - i * 3_600_000
    }));
  }

  it('drops buckets below the sample floor', () => {
    expect(buildPathTable(outcomes(50, 3), { minSamples: 200 })).toHaveLength(0);
  });

  it('keeps a bucket that clears the floor and scores it on the lower bound', () => {
    const table = buildPathTable(outcomes(400, 3), { minSamples: 200 });
    expect(table).toHaveLength(1);
    expect(table[0].rawN).toBe(400);
    // Every sample reached 3R, so the point estimate is 1.0 — the lower bound
    // must still be below it.
    expect(table[0].pLow).toBeLessThan(table[0].pHit);
    expect(table[0].expectedR).toBeGreaterThan(0);
  });

  it('charges every bucket the round-trip cost', () => {
    const free = buildPathTable(outcomes(400, 3), { minSamples: 200, costR: 0 });
    const paid = buildPathTable(outcomes(400, 3), { minSamples: 200, costR: 0.5 });
    expect(paid[0].expectedR).toBeCloseTo(free[0].expectedR - 0.5, 6);
  });

  it('selects the best bucket for a state and abstains when none clears the bar', () => {
    const table = buildPathTable(outcomes(400, 3), { minSamples: 200 });
    expect(selectBucket(table, STATE, 0)?.slot).toBe(3);
    expect(selectBucket(table, STATE, 99)).toBeUndefined();
    expect(selectBucket(table, { regime: 'RANGING', fng: 'GREED' }, 0)).toBeUndefined();
  });
});

describe('the engine abstains rather than guesses', () => {
  const base = {
    symbol: 'BTC',
    // Exactly the engine's own requirement — a bare 244 here silently became a
    // NO_DATA case once the three copies of that number were unified at 248.
    h1: candles(MIN_PATH_CANDLES, HOUR),
    m15: candles(320, 15 * 60_000),
    m5: candles(520, 5 * 60_000),
    livePrice: 100,
    fearGreedIndex: 30,
    now: T0 + 250 * HOUR,
    table: [] as PathBucket[]
  };

  it('holds with an empty table — no study, no trade', () => {
    const d = evaluatePathDecision(base);
    expect(d.outcome).toBe('NO_SIGNAL');
    expect(d.gate).toBe('NO_BUCKET');
  });

  it('holds when there is not enough history to label a bar', () => {
    const d = evaluatePathDecision({ ...base, h1: candles(100, HOUR) });
    expect(d.gate).toBe('NO_DATA');
  });

  it('holds outside the armed slot, and says which slot it is waiting for', () => {
    const now = T0 + 250 * HOUR;
    const currentSlot = slotIndexAt(now, barOpenFor(now));
    const armed = (currentSlot + 5) % SLOTS_PER_BAR;
    const table: PathBucket[] = [{
      state: { regime: 'TRENDING_UP', fng: 'FEAR' },
      slot: armed, direction: 'LONG', n: 400, rawN: 400,
      tpR: 2, slR: 1, pHit: 0.5, pLow: 0.45, costR: 0.06, expectedR: 0.29
    }];
    const d = evaluatePathDecision({ ...base, table, now });
    // The state label depends on the fixture's regime, so accept either the
    // out-of-window hold or a hold for want of a matching state — what must NOT
    // happen is a signal fired from a slot the table did not nominate.
    expect(d.outcome).toBe('NO_SIGNAL');
    if (d.gate === 'OUT_OF_WINDOW') {
      expect(d.armedSlot).toBe(armed);
      expect(d.slot).not.toBe(armed);
    }
  });
});

describe('sizing comes from the bucket, capped by the operator', () => {
  const bucket = (pLow: number, tpR: number): PathBucket => ({
    state: STATE, slot: 3, direction: 'LONG', n: 400, rawN: 400,
    tpR, slR: 1, pHit: pLow + 0.05, pLow, costR: 0.06, expectedR: pLow * tpR - (1 - pLow) - 0.06
  });

  it('is half-Kelly on the LOWER bound, never the point estimate', () => {
    // p=0.45, b=2 → full Kelly (0.45·2 − 0.55)/2 = 0.175, half = 0.0875,
    // then clamped by the 5% ceiling.
    expect(pathKellyFraction(bucket(0.45, 2))).toBeCloseTo(0.05, 6);
    // p=0.36, b=2 → full 0.04, half 0.02 — under the ceiling, so it stands.
    expect(pathKellyFraction(bucket(0.36, 2))).toBeCloseTo(0.02, 6);
  });

  it('refuses to size a bucket with no edge', () => {
    expect(pathKellyFraction(bucket(0.30, 1))).toBe(0);
  });

  // `pathEntryBudget` (the old order-generator's own sizing helper) was
  // removed 2026-09-14 along with the rest of pathSimExecution.ts — dead code,
  // see that file's removal note in execution.ts. Nothing in the live
  // DecisionEngine PathAdapter ever called it; pathKellyFraction above is the
  // sizing input it actually uses.
});
