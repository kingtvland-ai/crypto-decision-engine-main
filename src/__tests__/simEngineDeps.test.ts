/**
 * Injectable dependencies on createGenericSimEngine (2026-09-16)
 * ============================================================================
 * `tick()` used to reach the wall clock and four network fetchers through
 * hardcoded module imports, which is why only ONE of the four sim bots could
 * be backtested: the Intraday backtest is a second, thinner re-implementation
 * of the execution loop rather than the loop itself.
 *
 * `SimEngineDeps` makes the clock and the four feeds injectable, every field
 * defaulting to the live implementation. These tests pin both halves of that
 * contract:
 *   - injected deps are actually used (no module mocking needed at all — note
 *     this file has no `vi.mock`, unlike simEngineFactoryOrchestration.ts)
 *   - an injected CLOCK really drives the engine, which is the property a
 *     historical replay depends on.
 */
import { describe, it, expect } from 'vitest';
import { createGenericSimEngine } from '../../server/simEngineFactory';
import type { SimBotConfig, PendingOrder, SimPosition } from '@cde/engine/execution';

const FIXED_NOW = Date.UTC(2025, 0, 15, 12, 0, 0);

const config: SimBotConfig = {
  riskLevel: 'medium',
  initialAmount: 10000,
  maxPositions: 7,
  feePercent: 0.1,
  slippagePercent: 0.05,
  executionDelaySec: 0
};

function openPosition(overrides: Partial<SimPosition> = {}): SimPosition {
  return {
    id: 'pos-1', symbol: 'BTCUSDT', type: 'SPOT', side: 'BUY', quantity: 0.01,
    entryPrice: 50000, avgPrice: 50000, currentPrice: 50000, leverage: 1,
    marginUsd: 500, notionalUsd: 500, stopLoss: 48000, tp1Hit: false,
    openedAt: new Date(FIXED_NOW).toISOString(), openTimestamp: FIXED_NOW - 60_000,
    reason: 'test fixture', confidence: 80, entryFee: 0,
    ...overrides
  };
}

/** Records what the strategy saw, so the injected clock can be asserted on. */
function recordingStrategy(seen: { now: number[] }) {
  return {
    id: 'deps-test', logPrefix: '[deps-test]', telegramTag: 'test',
    telegramTitle: 'Test', statusFooterLabel: 'Test',
    minConfidence: 50, minCandlesForH1View: 0, logCandleFetch: false,
    buildEvaluations: (input: { now: number }) => { seen.now.push(input.now); return []; },
    generateOrders: (): PendingOrder[] => []
  };
}

function offlineDeps(now: () => number) {
  let priceCalls = 0;
  let candleCalls = 0;
  let fundingCalls = 0;
  let derivativesCalls = 0;
  return {
    counts: () => ({ priceCalls, candleCalls, fundingCalls, derivativesCalls }),
    deps: {
      now,
      getPrices: async () => {
        priceCalls++;
        return [{
          id: 'btc', symbol: 'btc', name: 'BTCUSDT', current_price: 51000,
          price_change_percentage_24h: 1, total_volume: 1e9, market_cap: 0,
          last_updated: new Date(now()).toISOString()
        }];
      },
      getCandles: async () => { candleCalls++; return { snapshots: new Map() }; },
      getFunding: async () => { fundingCalls++; return new Map(); },
      getDerivatives: async () => { derivativesCalls++; return new Map(); }
    } as never
  };
}

describe('createGenericSimEngine — injected dependencies', () => {
  it('runs a full tick with NO network module mocking at all', async () => {
    const seen = { now: [] as number[] };
    const { deps, counts } = offlineDeps(() => FIXED_NOW);
    const engine = createGenericSimEngine(recordingStrategy(seen), () => ['BTCUSDT'], deps);
    engine.hydrate({
      runId: 'deps-run', cash: 9500, initialAmount: 10000,
      positions: [openPosition()], trades: [], history: [], hourlyHistory: [], pending: []
    } as never);

    const snapshot = await engine.tick(config);

    expect(snapshot.positions).toHaveLength(1);
    // The injected price feed is what marked the book to market.
    expect(snapshot.positions[0].currentPrice).toBe(51000);
    expect(counts().priceCalls).toBeGreaterThan(0);
  }, 10_000);

  it('hands the strategy the INJECTED clock, not the wall clock', async () => {
    const seen = { now: [] as number[] };
    const { deps } = offlineDeps(() => FIXED_NOW);
    const engine = createGenericSimEngine(recordingStrategy(seen), () => ['BTCUSDT'], deps);
    engine.hydrate({
      runId: 'deps-run', cash: 10000, initialAmount: 10000,
      positions: [], trades: [], history: [], hourlyHistory: [], pending: []
    } as never);

    await engine.tick(config);

    expect(seen.now).toContain(FIXED_NOW);
    // A wall-clock read would be ~2026, nowhere near the injected 2025 date.
    expect(seen.now.every((t) => t === FIXED_NOW)).toBe(true);
  }, 10_000);

  it('advances with the clock — a replay stepping bar by bar sees each step', async () => {
    const seen = { now: [] as number[] };
    let clock = FIXED_NOW;
    const { deps } = offlineDeps(() => clock);
    const engine = createGenericSimEngine(recordingStrategy(seen), () => ['BTCUSDT'], deps);
    engine.hydrate({
      runId: 'deps-run', cash: 10000, initialAmount: 10000,
      positions: [], trades: [], history: [], hourlyHistory: [], pending: []
    } as never);

    await engine.tick(config);
    clock += 5 * 60_000;
    await engine.tick(config);

    expect(seen.now).toEqual([FIXED_NOW, FIXED_NOW + 5 * 60_000]);
  }, 10_000);

  it('omitting deps entirely keeps the live implementations (construction is unchanged)', () => {
    const seen = { now: [] as number[] };
    // No third argument — the shape every existing caller uses.
    const engine = createGenericSimEngine(recordingStrategy(seen), () => ['BTCUSDT']);
    expect(typeof engine.tick).toBe('function');
  });
});
