/**
 * Direct tests for server/simEngineFactory.ts's tick() orchestration.
 * ============================================================================
 * This layer had NO direct tests before 2026-09-16 — every other module in
 * this codebase is pure/synchronous and unit-testable in isolation, but
 * `tick()` is a stateful async closure that calls real network fetchers
 * (getAggregatedPrices, fetchFundingRates, fetchDerivativesSnapshots,
 * getUniverseMarketData), which is exactly why an ordering bug lived here
 * undetected: a manual code-reading audit (2026-09-16) found
 * `fetchDerivativesSnapshots` awaited directly in the critical path, between
 * the Live Freshness Guarantee and the position mark-to-market/exit-check
 * loop — a slow fetch (4 requests/symbol, cold cache) could delay Stop-Loss/
 * Take-Profit/ratchet evaluation for OPEN POSITIONS by several seconds.
 *
 * These tests mock the network layer (`@cde/engine/market-data`) and run the
 * REAL, exported `createGenericSimEngine` — the same factory all four sim
 * bots use — to verify the property that actually matters and that a
 * type-level or pure-logic test cannot see: does the ORDER/blocking-ness of
 * operations inside tick() hold?
 *
 *   1. A macro-layer fetch (Open Interest/L-S/derivatives) that never
 *      resolves must NOT prevent tick() from completing — regression guard
 *      for the exact bug found 2026-09-16.
 *   2. The SAME non-blocking property for the candle refresh (pre-existing,
 *      never had a direct test either).
 *   3. Mark-to-market must reflect the fresh price even while #1's fetch is
 *      still pending — proves the bug's real-world consequence (a stale SL
 *      check) cannot happen, not just that tick() "returns eventually".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SimPosition, SimBotConfig, PendingOrder } from '@cde/engine/execution';

// A never-resolving derivatives fetch is the sharpest possible regression
// probe: if tick() ever awaits it in the critical path again, this test
// hangs and times out — an unambiguous failure, not a timing-flakiness race.
const derivativesDeferred = (() => {
  let resolve!: (v: Map<string, unknown>) => void;
  const promise = new Promise<Map<string, unknown>>((r) => { resolve = r; });
  return { promise, resolve };
})();

const candlesDeferred = (() => {
  let resolve!: (v: { snapshots: Map<string, unknown>; stats: unknown }) => void;
  const promise = new Promise<{ snapshots: Map<string, unknown>; stats: unknown }>((r) => { resolve = r; });
  return { promise, resolve };
})();

vi.mock('@cde/engine/market-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cde/engine/market-data')>();
  return {
    ...actual,
    getAggregatedPrices: vi.fn(async () => [
      {
        id: 'btc', symbol: 'btc', name: 'BTCUSDT', current_price: 51000,
        price_change_percentage_24h: 1, total_volume: 1e9, market_cap: 0,
        last_updated: new Date().toISOString()
      }
    ]),
    fetchFundingRates: vi.fn(async () => new Map()),
    // Never resolves during the test — see the module doc comment above.
    fetchDerivativesSnapshots: vi.fn(() => derivativesDeferred.promise),
    // Also never resolves: proves the PRE-EXISTING candle refresh is (and
    // must stay) non-blocking too, since nothing here awaits it either.
    getUniverseMarketData: vi.fn(() => candlesDeferred.promise)
  };
});

// Imported AFTER vi.mock (hoisted by vitest regardless of literal order, but
// written this way so the dependency is visually obvious).
const { createGenericSimEngine } = await import('../../server/simEngineFactory');

function openPosition(overrides: Partial<SimPosition> = {}): SimPosition {
  return {
    id: 'pos-1',
    symbol: 'BTCUSDT',
    type: 'SPOT',
    side: 'BUY',
    quantity: 0.01,
    entryPrice: 50000,
    avgPrice: 50000,
    currentPrice: 50000,
    leverage: 1,
    marginUsd: 500,
    notionalUsd: 500,
    stopLoss: 48000,
    tp1Hit: false,
    openedAt: new Date().toISOString(),
    openTimestamp: Date.now(),
    reason: 'test fixture',
    confidence: 80,
    entryFee: 0,
    ...overrides
  };
}

const noopStrategy = {
  id: 'test-strategy',
  logPrefix: '[test]',
  telegramTag: 'test',
  telegramTitle: 'Test',
  statusFooterLabel: 'Test',
  minConfidence: 50,
  minCandlesForH1View: 0,
  logCandleFetch: false,
  buildEvaluations: () => [],
  generateOrders: (): PendingOrder[] => []
};

const config: SimBotConfig = {
  riskLevel: 'medium',
  initialAmount: 10000,
  maxPositions: 7,
  feePercent: 0.1,
  slippagePercent: 0.05,
  executionDelaySec: 0
};

describe('simEngineFactory tick() orchestration — non-blocking guarantees', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a derivatives (Macro Layer) fetch that NEVER resolves does not prevent tick() from completing', async () => {
    const engine = createGenericSimEngine(noopStrategy, () => ['BTCUSDT']);
    engine.hydrate({
      runId: 'test-run',
      cash: 9500,
      initialAmount: 10000,
      positions: [openPosition()],
      trades: [],
      history: [],
      hourlyHistory: [],
      pending: []
    } as never);

    // If tick() ever awaits fetchDerivativesSnapshots directly again, this
    // call hangs forever and the test times out (vitest's default 5s) — a
    // hard, unambiguous regression signal.
    const snapshot = await engine.tick(config);

    expect(snapshot.positions).toHaveLength(1);
  }, 10_000);

  it('mark-to-market reflects the FRESH price while the derivatives fetch is still pending — proves SL/TP would see live data, not stale', async () => {
    const engine = createGenericSimEngine(noopStrategy, () => ['BTCUSDT']);
    engine.hydrate({
      runId: 'test-run',
      cash: 9500,
      initialAmount: 10000,
      positions: [openPosition({ currentPrice: 40000 })], // stale on purpose
      trades: [],
      history: [],
      hourlyHistory: [],
      pending: []
    } as never);

    const snapshot = await engine.tick(config);

    // getAggregatedPrices mock returns 51000 — the position's currentPrice
    // must have been marked to THAT, not left at the stale 40000, even
    // though the derivatives promise (awaited nowhere) never resolved.
    expect(snapshot.positions[0].currentPrice).toBe(51000);
  }, 10_000);

  it('a candle-history (MTF) fetch that NEVER resolves ALSO does not block tick() — the pre-existing non-blocking pattern this session\'s fix now matches', async () => {
    const engine = createGenericSimEngine(noopStrategy, () => ['BTCUSDT']);
    engine.hydrate({
      runId: 'test-run',
      cash: 10000,
      initialAmount: 10000,
      positions: [],
      trades: [],
      history: [],
      hourlyHistory: [],
      pending: []
    } as never);

    const snapshot = await engine.tick(config);

    expect(snapshot).toBeDefined();
  }, 10_000);
});
