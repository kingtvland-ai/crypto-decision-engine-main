/**
 * Replay runner — all four bots through the REAL execution engine (2026-09-16)
 * ============================================================================
 * The old `backtestRunner.ts` is `EngineType = 'intraday'` — a second, thinner
 * implementation of the trading loop that only one of the four bots can use.
 * `runReplay` instead drives the SAME `tick()` the live bots run, over stored
 * candles, via the injectable `SimEngineDeps`. These tests pin the two claims
 * that matter:
 *
 *   1. it really is engine-agnostic — every one of the four registered
 *      strategies replays without the driver knowing anything about it;
 *   2. it is look-ahead-safe — a bar that had not closed at the decision
 *      timestamp is never visible to the strategy.
 *
 * Note there is no `vi.mock` here: the injected deps ARE the isolation.
 */
import { describe, it, expect } from 'vitest';
import { runReplay, type ReplaySymbolHistory } from '../../server/replayRunner';
import { intradayStrategy } from '../../server/simEngine';
import { proStrategy } from '../../server/proSimEngine';
import { pathStrategy } from '../../server/pathSimEngine';
import { bybitStrategy } from '../../server/bybitSimEngine';
import type { SimBotConfig, SimPosition, PendingOrder } from '@cde/engine/execution';
import type { Candle } from '@cde/engine';

const T0 = Date.UTC(2025, 0, 1);
const M5 = 5 * 60_000;

/** A deterministic random walk — no Math.random, so two runs are identical. */
function series(n: number, stepMs: number, seed = 7): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const open = price;
    price = price * (1 + ((x / 2147483648) - 0.5) * 0.01);
    out.push({
      timestamp: T0 + i * stepMs,
      open,
      high: Math.max(open, price) * 1.001,
      low: Math.min(open, price) * 0.999,
      close: price,
      volume: 1000 + (i % 5) * 50
    });
  }
  return out;
}

function history(symbol = 'BTCUSDT'): ReplaySymbolHistory {
  return {
    symbol,
    h1: series(300, 3_600_000, 11),
    m15: series(400, 900_000, 13),
    m5: series(700, M5, 7)
  };
}

const config: SimBotConfig = {
  riskLevel: 'medium',
  initialAmount: 10_000,
  maxPositions: 7,
  feePercent: 0.1,
  // Zero so a replay is byte-for-byte reproducible — the live slippage draw is
  // the one nondeterministic thing in the execution path.
  slippagePercent: 0,
  executionDelaySec: 0
};

describe('runReplay — engine-agnostic by construction', () => {
  // Each of the four is the REAL strategy object the live worker registers.
  const bots = [
    ['intraday', intradayStrategy],
    ['pro', proStrategy],
    ['path', pathStrategy],
    ['bybit', bybitStrategy]
  ] as const;

  for (const [name, strategy] of bots) {
    it(`replays the ${name} bot end to end`, async () => {
      const result = await runReplay(strategy, {
        histories: [history()],
        config,
        warmupBars: 600
      });

      expect(result.steps).toBe(100); // 700 M5 bars − 600 warmup
      expect(result.startedAt).toBe(T0 + 600 * M5);
      expect(result.endedAt).toBe(T0 + 699 * M5);
      expect(Number.isFinite(result.finalEquity)).toBe(true);
      expect(result.initialAmount).toBe(10_000);
      // A synthetic random walk need not produce trades; what matters is that
      // the run completes through the real engine rather than throwing.
      expect(Array.isArray(result.trades)).toBe(true);
    }, 60_000);
  }
});

describe('runReplay — look-ahead safety', () => {
  it('never shows a strategy a bar that had not closed at the decision time', async () => {
    const violations: string[] = [];
    let steps = 0;

    const probe = {
      ...proStrategy,
      id: 'lookahead-probe',
      buildEvaluations: (input: {
        now: number;
        liveCandles: Record<string, { h1?: Candle[]; m15?: Candle[]; m5?: Candle[] } | undefined>;
        candlesBySymbol: Record<string, Candle[]>;
      }) => {
        steps++;
        for (const [key, snap] of Object.entries(input.liveCandles)) {
          for (const tf of ['h1', 'm15', 'm5'] as const) {
            for (const bar of snap?.[tf] ?? []) {
              if (bar.timestamp > input.now) {
                violations.push(`${key}.${tf} bar ${bar.timestamp} > now ${input.now}`);
              }
            }
          }
        }
        for (const [key, bars] of Object.entries(input.candlesBySymbol)) {
          for (const bar of bars) {
            if (bar.timestamp > input.now) violations.push(`${key}.h1view bar ${bar.timestamp} > now ${input.now}`);
          }
        }
        return [];
      },
      generateOrders: (): PendingOrder[] => []
    };

    await runReplay(probe as never, { histories: [history()], config, warmupBars: 600 });

    expect(steps).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  }, 60_000);

  it('advances the injected clock one M5 bar per step', async () => {
    const seen: number[] = [];
    const probe = {
      ...proStrategy,
      buildEvaluations: (input: { now: number }) => { seen.push(input.now); return []; },
      generateOrders: (): PendingOrder[] => []
    };

    await runReplay(probe as never, { histories: [history()], config, warmupBars: 695 });

    expect(seen).toHaveLength(5);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i] - seen[i - 1]).toBe(M5);
    }
  }, 30_000);
});

describe('runReplay — input validation', () => {
  it('refuses a history with no M5 series, naming the symbol', async () => {
    const broken = { ...history(), m5: [] };
    await expect(runReplay(proStrategy, { histories: [broken], config }))
      .rejects.toThrow(/BTCUSDT.*M5/);
  });

  it('refuses when the warmup consumes the whole timeline', async () => {
    await expect(runReplay(proStrategy, { histories: [history()], config, warmupBars: 5000 }))
      .rejects.toThrow(/warmup/);
  });

  it('refuses an empty history list', async () => {
    await expect(runReplay(proStrategy, { histories: [], config })).rejects.toThrow(/no histories/);
  });
});

describe('runReplay — determinism', () => {
  it('two runs over the same data agree exactly', async () => {
    const opts = { histories: [history()], config, warmupBars: 650 };
    const a = await runReplay(proStrategy, opts);
    const b = await runReplay(proStrategy, opts);

    expect(b.finalEquity).toBe(a.finalEquity);
    expect(b.steps).toBe(a.steps);
    expect(b.trades.length).toBe(a.trades.length);
  }, 60_000);
});
