// Typed client for the local trading worker (server/tradingWorker.ts or server/dist/worker.js).
// SimBotConfig belongs to the engine package, not to this hook — importing it
// from useSimulationBot.ts was the one place app code reached from a service
// into the hooks layer. See @cde/engine/execution.
import type { SimBotConfig, SimTrade } from '@cde/engine/execution';
import { resolveWorkerBaseUrl as resolveBaseUrl, resolvePublicBoardUrls } from './workerConfig';
// The browser never holds the Bybit secret and never signs orders.
// Base URL comes from VITE_TRADING_API_URL (set at build time for Netlify),
// falling back to a manually configured worker URL.

export interface WorkerHealth {
  publicRequests: number;
  publicFailures: number;
  execRequests: number;
  execFailures: number;
  lastScanAt: string | null;
}

export interface WorkerDecision {
  symbol: string;
  action: string;
  side?: string;
  confidence: number;
  reason?: string;
  skipped?: string;
  [key: string]: unknown;
}

export interface WorkerSkippedSymbol {
  symbol: string;
  reason: string;
}

export interface WorkerBotState {
  testnet: boolean;
  dryRun: boolean;
  mode: string;
  riskLevel: string;
  symbols: number;
  running: boolean;
  lastScanAt: string | null;
  lastError: string | null;
  scans: number;
  decisions: WorkerDecision[];
  orders: Record<string, unknown>[];
  skippedSymbols: WorkerSkippedSymbol[];
  health: WorkerHealth;
  openedSymbols?: Record<string, { at: number; type: 'SPOT' | 'FUTURES'; reason?: string; confidence?: number }>;
  maxOpenPositions?: number;
}

export interface WorkerAccountSummary {
  availableUsdt: number;
  totalUsdt: number;
  openFuturesCount: number;
  positions: { symbol: string; side: string; size: number; leverage: number; entryPrice: number }[];
}

export interface WorkerDecisionsResponse {
  decisions: WorkerDecision[];
  skippedSymbols: WorkerSkippedSymbol[];
  lastScanAt: string | null;
  lastError: string | null;
}

export interface SimBotSnapshot {
  cash: number;
  /** Capital the current run opened with. The denominator for every P&L
   *  figure the UI shows — it cannot be recovered from cash or equity once
   *  the run has traded. */
  initialAmount: number;
  positions: unknown[];
  positionsValue: number;
  equity: number;
  trades: unknown[];
  history: unknown[];
  hourlyHistory?: unknown[];
  pending: unknown[];
  totalFees: number;
  totalSlippageCost: number;
  /** Cumulative perpetual funding paid on FUTURES positions (USD). Spot-only
   *  bots stay 0; absent on snapshots from before funding accrual existed. */
  totalFunding?: number;
  winRate: number;
  totalTrades: number;
  closedTrades: number;
  lastEvaluation: string;
  evaluations: unknown[];
  minConfidence: number;
  hasSavedSession: boolean;
  nextTickAt: number;
  totalLeveragedExposureUsd: number;
  dailyDrawdownPercent: number;
  weeklyDrawdownPercent: number;
  candleCount: number;
  [key: string]: unknown;
}

export interface SimBotStateResponse {
  running: boolean;
  config: SimBotConfig;
  snapshot: SimBotSnapshot | null;
  leaderId: string | null;
  leaderHeartbeat: number;
  updatedAt: number;
  epoch: number;
}

export interface TradingApiClient {
  baseUrl: string;
  getHealth(): Promise<Record<string, unknown>>;
  getState(): Promise<WorkerBotState>;
  getAccountSummary(): Promise<WorkerAccountSummary>;
  getDecisions(): Promise<WorkerDecisionsResponse>;
  start(): Promise<WorkerBotState>;
  stop(): Promise<WorkerBotState>;
}

// ── Shared Simulation Bot API (public, no admin token) ────────────────────────
// The simulation bot is a single shared instance for every viewer. One browser
// runs the engine (leader) and pushes snapshots; others read the same state.

// Every function below accepts an optional `configuredBaseUrl` so callers that
// already hold the live WorkerAuthContext value (shared, synced across pages
// on this device) can pass it explicitly instead of relying on this module's
// own separate re-read of localStorage — avoids the two ever silently drifting.

export async function getSimState(configuredBaseUrl?: string): Promise<SimBotStateResponse> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/sim/state`);
  if (!res.ok) throw new Error(`Failed to fetch sim state: ${res.status} ${res.statusText}`);
  return (await res.json()) as SimBotStateResponse;
}

export async function pushSimState(leaderId: string, snapshot: SimBotSnapshot, configuredBaseUrl?: string): Promise<{ ok: boolean; updatedAt: number }> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/sim/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leaderId, snapshot })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Sim push ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as { ok: boolean; updatedAt: number };
}

export async function claimSimLeadership(leaderId: string, configuredBaseUrl?: string): Promise<{ claimed: boolean; leaderId: string | null }> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/sim/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leaderId })
  });
  if (!res.ok) throw new Error(`Failed to claim sim leadership: ${res.status} ${res.statusText}`);
  return (await res.json()) as { claimed: boolean; leaderId: string | null };
}

export async function startSim(configuredBaseUrl?: string): Promise<SimBotStateResponse> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/sim/start`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to start sim: ${res.status} ${res.statusText}`);
  return (await res.json()) as SimBotStateResponse;
}

export async function stopSim(configuredBaseUrl?: string): Promise<SimBotStateResponse> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/sim/stop`, { method: 'POST' });
  if (!res.ok) throw new Error(`Sim stop ${res.status}`);
  return (await res.json()) as SimBotStateResponse;
}

export async function resetSim(configuredBaseUrl?: string): Promise<SimBotStateResponse> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/sim/reset`, { method: 'POST' });
  if (!res.ok) throw new Error(`Sim reset ${res.status}`);
  return (await res.json()) as SimBotStateResponse;
}

export async function setSimConfig(config: SimBotConfig, configuredBaseUrl?: string): Promise<SimBotStateResponse> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/sim/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config })
  });
  if (!res.ok) throw new Error(`Sim config ${res.status}`);
  return (await res.json()) as SimBotStateResponse;
}

// ── Shared "Bot Pro" API (public, no admin token) ──────────────────────────
// Same shared-viewer model as the two blocks above, running
// server/proSimEngine.ts (a literal alg.md implementation). Fully
// server-driven — no leader election, so no claim/push counterpart.

export interface ProSimBotStateResponse {
  running: boolean;
  config: SimBotConfig;
  snapshot: SimBotSnapshot | null;
  updatedAt: number;
}

export async function getProSimState(configuredBaseUrl?: string): Promise<ProSimBotStateResponse> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/pro-sim/state`);
  if (!res.ok) throw new Error(`Failed to fetch pro sim state: ${res.status} ${res.statusText}`);
  return (await res.json()) as ProSimBotStateResponse;
}

export async function startProSim(configuredBaseUrl?: string): Promise<ProSimBotStateResponse> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/pro-sim/start`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to start pro sim: ${res.status} ${res.statusText}`);
  return (await res.json()) as ProSimBotStateResponse;
}

export async function stopProSim(configuredBaseUrl?: string): Promise<ProSimBotStateResponse> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/pro-sim/stop`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to stop pro sim: ${res.status} ${res.statusText}`);
  return (await res.json()) as ProSimBotStateResponse;
}

export async function resetProSim(configuredBaseUrl?: string): Promise<ProSimBotStateResponse> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/pro-sim/reset`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to reset pro sim: ${res.status} ${res.statusText}`);
  return (await res.json()) as ProSimBotStateResponse;
}

export async function setProSimConfig(config: SimBotConfig, configuredBaseUrl?: string): Promise<ProSimBotStateResponse> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/pro-sim/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config })
  });
  if (!res.ok) throw new Error(`Failed to set pro sim config: ${res.status} ${res.statusText}`);
  return (await res.json()) as ProSimBotStateResponse;
}

// ── "נתיב 4H" simulation bot (Prev-4H Range) ─────────────────────────
// server/pathSimEngine.ts. Server-driven like the Pro and Bybit sims — no
// leader election, so no claim/push counterpart. (The old empirical-bucket
// engine and its lookup-table endpoint were removed.)

export interface PathSimBotStateResponse {
  running: boolean;
  config: SimBotConfig;
  snapshot: SimBotSnapshot | null;
  updatedAt: number;
}

export async function getPathSimState(configuredBaseUrl?: string): Promise<PathSimBotStateResponse> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/path-sim/state`);
  if (!res.ok) throw new Error(`Failed to fetch path sim state: ${res.status} ${res.statusText}`);
  return (await res.json()) as PathSimBotStateResponse;
}

export async function startPathSim(configuredBaseUrl?: string): Promise<PathSimBotStateResponse> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/path-sim/start`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to start path sim: ${res.status} ${res.statusText}`);
  return (await res.json()) as PathSimBotStateResponse;
}

export async function stopPathSim(configuredBaseUrl?: string): Promise<PathSimBotStateResponse> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/path-sim/stop`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to stop path sim: ${res.status} ${res.statusText}`);
  return (await res.json()) as PathSimBotStateResponse;
}

export async function resetPathSim(configuredBaseUrl?: string): Promise<PathSimBotStateResponse> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/path-sim/reset`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to reset path sim: ${res.status} ${res.statusText}`);
  return (await res.json()) as PathSimBotStateResponse;
}

export async function setPathSimConfig(config: SimBotConfig, configuredBaseUrl?: string): Promise<PathSimBotStateResponse> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/path-sim/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config })
  });
  if (!res.ok) throw new Error(`Failed to set path sim config: ${res.status} ${res.statusText}`);
  return (await res.json()) as PathSimBotStateResponse;
}

// ── "Bybit" simulation bot (TrendBreakout) ───────────────────────────────────
// The fourth sim bot. Server-driven like Pro and Path — no leader election, so
// no claim/push counterpart. SIMULATION ONLY.

export interface BybitSimBotStateResponse {
  running: boolean;
  config: SimBotConfig;
  snapshot: SimBotSnapshot | null;
  updatedAt: number;
}

export async function getBybitSimState(configuredBaseUrl?: string): Promise<BybitSimBotStateResponse> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/bybit-sim/state`);
  if (!res.ok) throw new Error(`Failed to fetch bybit sim state: ${res.status} ${res.statusText}`);
  return (await res.json()) as BybitSimBotStateResponse;
}

export async function startBybitSim(configuredBaseUrl?: string): Promise<BybitSimBotStateResponse> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/bybit-sim/start`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to start bybit sim: ${res.status} ${res.statusText}`);
  return (await res.json()) as BybitSimBotStateResponse;
}

export async function stopBybitSim(configuredBaseUrl?: string): Promise<BybitSimBotStateResponse> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/bybit-sim/stop`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to stop bybit sim: ${res.status} ${res.statusText}`);
  return (await res.json()) as BybitSimBotStateResponse;
}

export async function resetBybitSim(configuredBaseUrl?: string): Promise<BybitSimBotStateResponse> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/bybit-sim/reset`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to reset bybit sim: ${res.status} ${res.statusText}`);
  return (await res.json()) as BybitSimBotStateResponse;
}

export async function setBybitSimConfig(config: SimBotConfig, configuredBaseUrl?: string): Promise<BybitSimBotStateResponse> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/bybit-sim/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config })
  });
  if (!res.ok) throw new Error(`Failed to set bybit sim config: ${res.status} ${res.statusText}`);
  return (await res.json()) as BybitSimBotStateResponse;
}

export function createTradingApiClient(configuredBaseUrl: string, adminToken: string): TradingApiClient {
  const baseUrl = resolveBaseUrl(configuredBaseUrl);

  async function authed<T>(path: string, method = 'GET'): Promise<T> {
    if (!baseUrl) throw new Error('כתובת Worker לא הוגדרה');
    if (!adminToken) throw new Error('BOT_ADMIN_TOKEN לא הוגדר');
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Worker ${res.status}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  return {
    baseUrl,
    getHealth: async () => {
      if (!baseUrl) throw new Error('כתובת Worker לא הוגדרה');
      const res = await fetch(`${baseUrl}/health`);
      if (!res.ok) throw new Error(`Worker ${res.status}`);
      return (await res.json()) as Record<string, unknown>;
    },
    getState: () => authed<WorkerBotState>('/api/bot/state'),
    getAccountSummary: () => authed<WorkerAccountSummary>('/api/account/summary'),
    getDecisions: () => authed<WorkerDecisionsResponse>('/api/decisions'),
    start: () => authed<WorkerBotState>('/api/bot/start', 'POST'),
    stop: () => authed<WorkerBotState>('/api/bot/stop', 'POST')
  };
}


// ── Sim config bootstrap ─────────────────────────────────────────────────────

export interface SimDefaultsResponse {
  intraday: SimBotConfig;
  legacy: SimBotConfig;
  pro: SimBotConfig;
  path: SimBotConfig;
  bybit: SimBotConfig;
  /** Which deploy-time variables the worker actually has set. Diagnostic only. */
  envOverrides: {
    minConfidence: number | null;
    positionPercent: number;
    maxOpenPositions: number;
    riskLevel: string;
  };
}

/**
 * The config each bot would START with on this worker.
 *
 * `@cde/engine`'s simBotDefaults() already gives the browser and the worker the
 * same compile-time base. What the browser cannot see is the environment layer
 * the worker lays on top (BOT_MIN_CONFIDENCE and friends), so until this is
 * read the panel is showing the base and calling it the default — correct only
 * on a deployment that sets none of them.
 *
 * This is NOT the running config. Each bot's own /state endpoint carries that,
 * and it always wins; this only fills the window before the first poll lands.
 */
export async function getSimDefaults(configuredBaseUrl?: string): Promise<SimDefaultsResponse> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/public/sim-defaults`);
  if (!res.ok) throw new Error(`Failed to fetch sim defaults: ${res.status} ${res.statusText}`);
  return (await res.json()) as SimDefaultsResponse;
}

// ── §9/#4 Run archive ───────────────────────────────────────────────────────
// Finished runs, captured server-side at each reset. "Reset All Bots" appends
// here; "Clear Cache + Server" clears it. BacktestResults merges these with the
// live trades so a reset does not destroy historical performance.

export interface ArchivedRun {
  runId: string;
  botId?: string;
  initialAmount: number;
  finalEquity: number;
  totalPnl: number;
  totalPnlPercent: number;
  finalCash: number;
  trades: SimTrade[];
  openPositions: Array<{
    symbol: string; type: 'SPOT' | 'FUTURES'; side: string;
    quantity: number; entryPrice: number; mark: number; pnl: number; reason: string;
  }>;
  tradeCount: number;
  feeTotal: number;
  slippageTotal: number;
  fundingTotal: number;
  startedAt?: number;
  archivedAt: number;
}

export interface BacktestArchiveResponse {
  intraday: ArchivedRun[];
  pro: ArchivedRun[];
  path: ArchivedRun[];
  bybit: ArchivedRun[];
}

export async function getBacktestArchive(configuredBaseUrl?: string): Promise<BacktestArchiveResponse> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/public/backtest-archive`);
  if (!res.ok) throw new Error(`Failed to fetch archive: ${res.status} ${res.statusText}`);
  return (await res.json()) as BacktestArchiveResponse;
}

export async function clearBacktestArchive(configuredBaseUrl?: string): Promise<void> {
  const base = resolveBaseUrl(configuredBaseUrl);
  if (!base) throw new Error('כתובת Worker לא הוגדרה');
  const res = await fetch(`${base}/api/public/backtest-archive/clear`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to clear archive: ${res.status} ${res.statusText}`);
}

// ── Public read-only board (/live) ──────────────────────────────────────────
// One GET, no token, no state. Everything the shareable results page renders
// is already derived server-side so the page cannot compute a number that
// disagrees with what the bots themselves report.

export interface PublicBotTrade {
  id: string;
  symbol: string;
  type: 'SPOT' | 'FUTURES';
  side: string;
  price: number;
  quantity: number;
  usdValue: number;
  fee: number;
  timestamp: string;
  at: number;
  reason: string;
  confidence: number;
  pnl?: number;
  pnlPercent?: number;
}

export interface PublicBotOpenPosition {
  symbol: string;
  type: 'SPOT' | 'FUTURES';
  side: string;
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  stopLoss: number;
  takeProfit1?: number;
  takeProfit2?: number;
  tp1Hit: boolean;
  notionalUsd: number;
  openedAt: string;
  openTimestamp: number;
}

export interface PublicBotSummary {
  id: string;
  label: string;
  running: boolean;
  hasData: boolean;
  updatedAt?: number | null;
  initialAmount?: number;
  cash?: number;
  positionsValue?: number;
  equity?: number;
  pnl?: number;
  pnlPercent?: number;
  realizedPnl?: number;
  unrealizedPnl?: number;
  openPositions?: number;
  positionsOpened?: number;
  positionsClosed?: number;
  wins?: number;
  losses?: number;
  winRate?: number;
  totalFees?: number;
  totalSlippage?: number;
  totalFunding?: number;
  riskLevel?: string | null;
  maxPositions?: number | null;
  trades?: PublicBotTrade[];
  openPositionsDetail?: PublicBotOpenPosition[];
}

export interface PublicBotsSummary {
  bots: PublicBotSummary[];
  serverTime: number;
}

/**
 * The public board's loader. Unlike every other call in this file it must work
 * for a visitor who has never configured anything, so it walks
 * `resolvePublicBoardUrls()` and falls through to the hardcoded production
 * worker when the operator-configured one is unreachable (a stale localStorage
 * entry, or a `localhost` URL that an https page blocks as mixed content — the
 * browser reports both as a bare "Failed to fetch").
 *
 * Errors are rethrown in Hebrew and name the address that failed, because the
 * board shows this string to a reader who cannot open a devtools console.
 */
export async function getPublicBotsSummary(configuredBaseUrl?: string): Promise<PublicBotsSummary> {
  const candidates = resolvePublicBoardUrls(configuredBaseUrl);
  if (candidates.length === 0) throw new Error('כתובת Worker לא הוגדרה');

  let lastError = '';
  for (const base of candidates) {
    try {
      const res = await fetch(`${base}/api/public/bots-summary`);
      if (!res.ok) {
        lastError = `${base} השיב ${res.status} ${res.statusText}`;
        continue;
      }
      return (await res.json()) as PublicBotsSummary;
    } catch (err) {
      lastError = `לא ניתן להגיע אל ${base}${err instanceof Error && err.message ? ` (${err.message})` : ''}`;
    }
  }
  throw new Error(`טעינת לוח התוצאות נכשלה — ${lastError}`);
}
