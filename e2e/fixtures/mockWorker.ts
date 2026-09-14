/**
 * A fake Render worker for E2E tests — see playwright.config.ts for why.
 * ============================================================================
 * Reproduces the four sim-bot endpoint groups
 * (`/api/{sim,pro-sim,path-sim,bybit-sim}/{state,start,stop,reset,config}`)
 * plus `/api/public/universe` and `/api/public/bots-summary`, in the exact
 * shapes `src/services/tradingApiClient.ts` expects (`SimBotStateResponse`,
 * `PublicBotsSummary`). Each bot keeps its own mutable state so start/pause/
 * reset on one column never touches another — the same isolation the real
 * four separate engine instances guarantee (see BOTS_REFERENCE.md).
 */
import type { Page, Route } from '@playwright/test';

export const MOCK_BASE_URL = 'https://mock-worker.e2e.test';

export type BotPrefix = 'sim' | 'pro-sim' | 'path-sim' | 'bybit-sim';

export interface MockPosition {
  id: string;
  symbol: string;
  type: 'SPOT' | 'FUTURES';
  side: 'LONG' | 'SHORT' | 'BUY' | 'SELL';
  quantity: number;
  entryPrice: number;
  avgPrice: number;
  currentPrice: number;
  leverage: number;
  marginUsd: number;
  notionalUsd: number;
  stopLoss: number;
  takeProfit1?: number;
  takeProfit2?: number;
  takeProfit?: number;
  tp1Hit: boolean;
  highestPrice?: number;
  lowestPrice?: number;
  openedAt: string;
  openTimestamp: number;
  reason: string;
  confidence: number;
  entryFee: number;
}

export interface MockTrade {
  id: string;
  symbol: string;
  type: 'SPOT' | 'FUTURES';
  side: string;
  price: number;
  requestedPrice: number;
  slippagePercent: number;
  fee: number;
  delayMs: number;
  quantity: number;
  usdValue: number;
  leverage: number;
  timestamp: string;
  at: number;
  reason: string;
  confidence: number;
  pnl?: number;
  pnlPercent?: number;
}

export interface MockBotSeed {
  initialAmount?: number;
  cash?: number;
  positions?: MockPosition[];
  trades?: MockTrade[];
  running?: boolean;
}

/** One realistic open LONG the "positions" tests key off — mirrors an actual
 *  snapshot (highestPrice tracked, tp1Hit false, entry-time SL/TP present). */
export function samplePosition(over: Partial<MockPosition> = {}): MockPosition {
  return {
    id: 'pos-1', symbol: 'BTC', type: 'SPOT', side: 'LONG',
    quantity: 0.0154, entryPrice: 64_800, avgPrice: 64_800, currentPrice: 65_950,
    leverage: 1, marginUsd: 0, notionalUsd: 1015.63,
    stopLoss: 63_308.4, takeProfit1: 65_966.4, takeProfit2: 67_068,
    tp1Hit: false, highestPrice: 66_100, lowestPrice: 64_750,
    openedAt: new Date(Date.now() - 40 * 60_000).toISOString(),
    openTimestamp: Date.now() - 40 * 60_000,
    reason: 'אות BUY בביטחון 82.4 >= סף 60 — מבצע קנייה',
    confidence: 82.4, entryFee: 1.02,
    ...over
  };
}

export function sampleClosedTrade(over: Partial<MockTrade> = {}): MockTrade {
  return {
    id: 'trade-1', symbol: 'ETH', type: 'SPOT', side: 'close_long',
    price: 3402.5, requestedPrice: 3400, slippagePercent: 0.07, fee: 0.85,
    delayMs: 0, quantity: 0.294, usdValue: 1000.34, leverage: 1,
    timestamp: new Date(Date.now() - 15 * 60_000).toLocaleTimeString('he-IL'),
    at: Date.now() - 15 * 60_000,
    reason: 'סולם רווח: חזרה למדרגה 3% (שיא +4.10%, כעת +3.00%) — מימוש 30%',
    confidence: 74, pnl: 30.1, pnlPercent: 3.0,
    ...over
  };
}

interface BotState {
  running: boolean;
  cash: number;
  initialAmount: number;
  positions: MockPosition[];
  trades: MockTrade[];
  config: Record<string, unknown>;
  epoch: number;
}

function freshState(seed: MockBotSeed): BotState {
  const initialAmount = seed.initialAmount ?? 10_000;
  return {
    running: seed.running ?? false,
    cash: seed.cash ?? initialAmount,
    initialAmount,
    positions: seed.positions ?? [],
    trades: seed.trades ?? [],
    config: { riskLevel: 'medium', initialAmount, maxPositions: 5, feePercent: 0.1, slippagePercent: 0.1, executionDelaySec: 0 },
    epoch: 1
  };
}

function positionsValue(positions: MockPosition[]): number {
  return positions.reduce((s, p) => s + p.quantity * p.currentPrice, 0);
}

function snapshotOf(state: BotState) {
  const equity = state.cash + positionsValue(state.positions);
  const closed = state.trades.filter((t) => typeof t.pnl === 'number');
  const wins = closed.filter((t) => (t.pnl ?? 0) > 0).length;
  return {
    runId: 'e2e-run-1',
    cash: state.cash,
    initialAmount: state.initialAmount,
    positions: state.positions,
    positionsValue: positionsValue(state.positions),
    equity,
    trades: state.trades,
    history: [{ timestamp: new Date().toLocaleTimeString('he-IL'), at: Date.now(), portfolio: equity }],
    hourlyHistory: [{ timestamp: new Date().toLocaleTimeString('he-IL'), at: Date.now(), portfolio: equity }],
    pending: [],
    totalFees: 4.2,
    totalSlippageCost: 1.1,
    totalFunding: 0,
    lastFundingAppliedAt: Date.now(),
    winRate: closed.length ? (wins / closed.length) * 100 : 0,
    totalTrades: state.trades.length,
    closedTrades: closed.length,
    lastEvaluation: new Date().toLocaleTimeString('he-IL'),
    evaluations: [],
    minConfidence: 60,
    hasSavedSession: state.trades.length > 0 || state.positions.length > 0,
    nextTickAt: Date.now() + 4000,
    totalLeveragedExposureUsd: 0,
    dailyDrawdownPercent: 0,
    weeklyDrawdownPercent: 0,
    candleCount: 500
  };
}

function stateResponse(state: BotState) {
  return {
    running: state.running,
    config: state.config,
    snapshot: snapshotOf(state),
    leaderId: state.running ? 'e2e-leader' : null,
    leaderHeartbeat: Date.now(),
    updatedAt: Date.now(),
    epoch: state.epoch
  };
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

export interface MockWorkerHandle {
  /** Read a bot's current mutable state, e.g. to assert on it directly. */
  get(bot: BotPrefix): BotState;
  /** Push an open position onto a bot's live state — for asserting the
   *  positions tab against a KNOWN snapshot rather than an empty one. */
  seed(bot: BotPrefix, seed: MockBotSeed): void;
}

const PREFIXES: BotPrefix[] = ['sim', 'pro-sim', 'path-sim', 'bybit-sim'];

/**
 * Installs the full mock worker on `page` and points the app at it
 * (`localStorage.workerConfig`, read before first paint via addInitScript —
 * see src/services/workerConfig.ts's resolution order). Call BEFORE
 * `page.goto()`.
 */
export async function installMockWorker(
  page: Page,
  seeds: Partial<Record<BotPrefix, MockBotSeed>> = {}
): Promise<MockWorkerHandle> {
  const states = new Map<BotPrefix, BotState>(
    PREFIXES.map((p) => [p, freshState(seeds[p] ?? {})])
  );

  await page.addInitScript((baseUrl) => {
    window.localStorage.setItem('workerConfig', JSON.stringify({ baseUrl }));
  }, MOCK_BASE_URL);

  // Third-party price/sentiment feeds the app calls directly from the
  // browser (useCryptoData, fear&greed) — aborted, not stubbed: the app's
  // own fetch code already treats a network failure as "source unavailable"
  // and falls through to the next one / an empty list, so this is a real,
  // already-handled path rather than a special case for tests.
  for (const host of ['api.bybit.com', 'api.binance.com', 'fapi.binance.com', 'api.coingecko.com', 'api.alternative.me']) {
    await page.route(`https://${host}/**`, (route) => route.abort());
  }

  await page.route(`${MOCK_BASE_URL}/**`, async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const path = url.pathname;

    if (path === '/api/public/universe') {
      return fulfillJson(route, { symbols: ['BTC', 'ETH', 'SOL', 'XRP', 'BNB'] });
    }

    if (path === '/api/public/bots-summary') {
      return fulfillJson(route, {
        serverTime: Date.now(),
        bots: PREFIXES.map((p) => {
          const s = states.get(p)!;
          const snap = snapshotOf(s);
          const closed = s.trades.filter((t) => typeof t.pnl === 'number');
          return {
            id: p === 'sim' ? 'intraday' : p === 'pro-sim' ? 'pro' : p === 'path-sim' ? 'path' : 'bybit',
            label: p,
            running: s.running,
            hasData: true,
            updatedAt: Date.now(),
            initialAmount: s.initialAmount,
            cash: s.cash,
            positionsValue: snap.positionsValue,
            equity: snap.equity,
            pnl: snap.equity - s.initialAmount,
            pnlPercent: ((snap.equity - s.initialAmount) / s.initialAmount) * 100,
            realizedPnl: closed.reduce((sum, t) => sum + (t.pnl ?? 0), 0),
            unrealizedPnl: 0,
            openPositions: s.positions.length,
            positionsOpened: s.trades.length,
            positionsClosed: closed.length,
            wins: closed.filter((t) => (t.pnl ?? 0) > 0).length,
            losses: closed.filter((t) => (t.pnl ?? 0) < 0).length,
            winRate: snap.winRate,
            totalFees: snap.totalFees,
            totalSlippage: snap.totalSlippageCost,
            totalFunding: snap.totalFunding,
            riskLevel: 'medium',
            maxPositions: 5,
            trades: s.trades.map((t) => ({ ...t })),
            openPositionsDetail: s.positions.map((p2) => ({
              symbol: p2.symbol, type: p2.type, side: p2.side, quantity: p2.quantity,
              entryPrice: p2.entryPrice, currentPrice: p2.currentPrice, stopLoss: p2.stopLoss,
              takeProfit1: p2.takeProfit1, takeProfit2: p2.takeProfit2, tp1Hit: p2.tp1Hit,
              notionalUsd: p2.notionalUsd, openedAt: p2.openedAt, openTimestamp: p2.openTimestamp
            }))
          };
        })
      });
    }

    const prefix = PREFIXES.find((p) => path.startsWith(`/api/${p}/`));
    if (!prefix) return fulfillJson(route, { error: 'not mocked', path }, 404);
    const state = states.get(prefix)!;
    const action = path.slice(`/api/${prefix}/`.length);

    if (action === 'state' && method === 'GET') return fulfillJson(route, stateResponse(state));
    if (action === 'start' && method === 'POST') { state.running = true; state.epoch++; return fulfillJson(route, stateResponse(state)); }
    if (action === 'stop' && method === 'POST') { state.running = false; state.epoch++; return fulfillJson(route, stateResponse(state)); }
    if (action === 'reset' && method === 'POST') {
      const fresh = freshState({ initialAmount: state.initialAmount });
      states.set(prefix, fresh);
      return fulfillJson(route, stateResponse(fresh));
    }
    if (action === 'config' && method === 'POST') {
      const body = route.request().postDataJSON() as { config?: Record<string, unknown> };
      if (body?.config) Object.assign(state.config, body.config);
      return fulfillJson(route, stateResponse(state));
    }
    if (action === 'claim' && method === 'POST') return fulfillJson(route, { claimed: true, leaderId: 'e2e-leader' });

    return fulfillJson(route, { error: 'not mocked', path, method }, 404);
  });

  return {
    get: (bot) => states.get(bot)!,
    seed: (bot, seed) => {
      const cur = states.get(bot)!;
      if (seed.positions) cur.positions = seed.positions;
      if (seed.trades) cur.trades = seed.trades;
      if (seed.running !== undefined) cur.running = seed.running;
      if (seed.cash !== undefined) cur.cash = seed.cash;
      cur.epoch++;
    }
  };
}
