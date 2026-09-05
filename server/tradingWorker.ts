// Crypto Decision Engine — Trading Worker (server-only)
// ===================================================================
// Runtime modes:
//   simulation -> public market data, no account, local simulator only (frontend)
//   testnet    -> public market data from Mainnet, authenticated orders to Bybit Testnet
//   live       -> public market data from Mainnet, authenticated orders to Bybit Mainnet
//
// CRITICAL: BYBIT_TESTNET selects ONLY the authenticated execution/account URL.
// Public candles/prices ALWAYS come from Mainnet (https://api.bybit.com) regardless of mode.
// The browser never sees the secret key. All signing happens here, server-side.
// ===================================================================

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config as loadEnv } from 'dotenv';
// Server-side simulation engine (runs the bot 24/7 without a browser).
import { createSimEngine, SimSnapshot } from './simEngine.ts';
// Server-side "Bot Pro" — a literal, verified-faithful implementation of
// ASSETS/alg.md, independent from the (drifted) legacy engine above. Same
// server, same infra, only the decision logic differs (see proSimEngine.ts).
import { createProSimEngine, ProSimSnapshot } from './proSimEngine.ts';
// Fourth bot: trades a measured 15-minute slot inside the current 4H bar
// rather than a chart score (see pathSimEngine.ts).
import { createPathSimEngine, installValidatedTable, PathSimSnapshot, getPathTableStatus } from './pathSimEngine.ts';
// Core decision engine — single source of truth for Layers 0-3 (intraday MTF).
import { evaluateIntradayDecision, IntradayDecision, IntradayTradeType as TradeType } from '@cde/engine/analysis';
import { buildPortfolioRiskStats } from '@cde/engine';
// The static half of every sim bot's config. The env-driven half
// (BOT_MIN_CONFIDENCE / BOT_POSITION_PERCENT / BOT_MAX_OPEN_POSITIONS /
// BOT_RISK_LEVEL) is layered on top below and stays owned by this file — the
// browser cannot see those variables, which is exactly why they are NOT in the
// shared module pretending to be defaults both runtimes agree on.
import type { SimBotConfig, SimBotId } from '@cde/engine/execution';
import {
  simBotDefaults,
  SIM_BOTS,
  UI_FACING_SIM_PREFIXES,
  type SimEnvOverrides
} from '@cde/engine/execution';
import { getMultiTimeframeData, exportMarketDataCache, importMarketDataCache, TIMEFRAME_SPECS, TIMEFRAME_ORDER, type TimeframeCacheEntry } from '@cde/engine/market-data';
import { toBybitSymbol } from '@cde/engine/market-data';
import { TARGET_SYMBOLS } from '@cde/engine/market-data';
import { createKVStore, isDurableStorageConfigured } from './kvStore';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Local development reads the repository .env; Render variables retain precedence.
loadEnv({ path: join(__dirname, '..', '.env') });

// Load .env (local dev). On Render, dashboard env vars are already present in
// process.env and dotenv will NOT override them (it only fills missing keys).
const DATA_DIR = join(__dirname, '.data');
const STATE_FILE = join(DATA_DIR, 'bot-state.json');

// ── Server-only configuration ──────────────────────────────────────────────
const port = Number(process.env.PORT || 3001);
const apiKey = process.env.BYBIT_API_KEY || '';
const secretKey = process.env.BYBIT_SECRET_KEY || '';
const testnet = process.env.BYBIT_TESTNET === 'true'; // default false (mainnet)
const dryRun = process.env.BOT_DRY_RUN !== 'false'; // default true (safe)
const adminToken = process.env.BOT_ADMIN_TOKEN || '';
const autostart = process.env.BOT_AUTOSTART === 'true';
// BOT_RISK_LEVEL sizes every simulated entry (riskLevelSizingMultiplier in
// simExecution.ts): low 0.6x, medium 1x, high 1.5x. It used to be read here,
// echoed in /api/status, and consumed by nothing.
const RISK_LEVELS = new Set(['low', 'medium', 'high']);
const envRiskLevel = String(process.env.BOT_RISK_LEVEL || '').toLowerCase();
const riskLevel = (RISK_LEVELS.has(envRiskLevel) ? envRiskLevel : 'medium') as 'low' | 'medium' | 'high';
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || '';
const telegramChatId = process.env.TELEGRAM_CHAT_ID || '';
function boundedNumber(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}
/** Like boundedNumber, but returns undefined when the variable is not set — so a
 *  caller can tell "operator chose this" from "nobody chose anything" and leave
 *  its own default in place. The three sim bots deliberately run different
 *  confidence floors; a plain fallback would flatten all three to one number. */
function optionalBoundedNumber(name: string, min: number, max: number): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max ? value : undefined;
}
// Optional floor across all three sims. Unset (the normal case) leaves each bot
// on its own calibrated threshold — Intraday 52, Legacy 58, Pro 58.
// A SCORE, applied to the three score-scaled bots. simBotDefaults() refuses to
// apply it to the probability-scaled one; see ConfidenceScale in simDefaults.ts.
const minConfidenceOverrideEnv = optionalBoundedNumber('BOT_MIN_CONFIDENCE', 1, 100);
// The same knob for the one bot that speaks probabilities. Separate on purpose:
// at BOT_MIN_CONFIDENCE=60 the Path bot was being asked for a bucket that hits
// 60% of the time at a 1.5R target, which does not exist — so the single shared
// knob silenced it entirely while reading as an ordinary setting.
const pathMinConfidenceEnv = optionalBoundedNumber('BOT_PATH_MIN_CONFIDENCE', 1, 100);
const positionPercent = boundedNumber('BOT_POSITION_PERCENT', 10, 0.1, 100);
// ONE position cap for the live bot and for all three simulations. They used to
// disagree (live 5, sims 7), which meant the sims were measuring a strategy the
// live bot is not allowed to run.
const maxOpenPositions = Math.floor(boundedNumber('BOT_MAX_OPEN_POSITIONS', 5, 1, 100));
const scanConcurrency = Math.floor(boundedNumber('BOT_SCAN_CONCURRENCY', 5, 1, 20));
const intervalMs = boundedNumber('BOT_SCAN_INTERVAL_SECONDS', 300, 60, 3600) * 1000;
const REENTRY_COOLDOWN_MS = boundedNumber('BOT_REENTRY_COOLDOWN_HOURS', 24, 1, 720) * 3600 * 1000;

// CORS: restrict to configured frontend origins. Comma-separated, or '*' to allow any.
const corsOriginEnv = process.env.CORS_ORIGIN || '';
const allowedOrigins = corsOriginEnv.split(',').map(s => s.trim()).filter(Boolean);
// Basic rate limiting: per-IP window.
const RATE_LIMIT_MAX = Math.floor(boundedNumber('BOT_RATE_LIMIT_MAX', 120, 1, 10000));
const RATE_LIMIT_WINDOW_MS = boundedNumber('BOT_RATE_LIMIT_WINDOW_MS', 60000, 1000, 3600000);
const REQUEST_TIMEOUT_MS = boundedNumber('BOT_REQUEST_TIMEOUT_MS', 15000, 1000, 120000);
// Engine versions — bumped when the decision algorithm changes.
// The frontend can use this to warn if the displayed sim/backtest
// results were produced by a different algorithm than the current one.
export const ENGINE_VERSIONS = {
  intraday: '1.0.0',
  pro: '1.0.0',
  path: '1.0.0',
} as const;


// ── HTTP helpers: CORS, rate limiting, timeouts ────────────────────────────
function clientIp(req: { headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } }): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

const rateBuckets = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const hits = (rateBuckets.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  hits.push(now);
  rateBuckets.set(ip, hits);
  return hits.length > RATE_LIMIT_MAX;
}

function pruneRateBuckets(): void {
  const now = Date.now();
  for (const [ip, hits] of rateBuckets) {
    const fresh = hits.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    if (fresh.length === 0) rateBuckets.delete(ip);
    else rateBuckets.set(ip, fresh);
  }
}

function setCors(req: { headers: Record<string, string | string[] | undefined> }, res: { writeHead: (status: number, headers?: Record<string, string>) => void; end: (body?: string) => void; setHeader: (name: string, value: string) => void }): void {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  if (!origin) return;
  const originAllowed = allowedOrigins.some((allowed) =>
    allowed === origin ||
    (allowed.includes('*') && origin.startsWith(allowed.split('*')[0]) && origin.endsWith(allowed.split('*').slice(1).join('*')))
  );
  const allow = allowedOrigins.length === 0 || allowedOrigins.includes('*') ? '*' : (originAllowed ? origin : null);
  if (!allow && origin) {
    console.warn('[cors] blocked origin: ' + origin + ' | allowed: [' + allowedOrigins.join(', ') + ']');
  }
  if (allow) {
    res.setHeader('Access-Control-Allow-Origin', allow);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.setHeader('Vary', 'Origin');
  }
}

async function fetchWithTimeout(url: string, options: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

let lastAlertedError: string | null = null;

async function sendTelegramOrder(message: string): Promise<void> {
  if (!telegramBotToken || !telegramChatId) {
    console.warn('[telegram] not configured (missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID) — order notification dropped');
    return;
  }
  try {
    const res = await fetchWithTimeout(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: telegramChatId, text: message })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[telegram] sendMessage failed (order): HTTP ${res.status} ${body.slice(0, 300)}`);
    }
  } catch (e) {
    console.warn('[telegram] sendMessage threw (order):', e instanceof Error ? e.message : String(e));
  }
}
async function sendTelegramAlert(message: string): Promise<void> {
  if (!telegramBotToken || !telegramChatId) return;
  if (lastAlertedError === message) return;
  lastAlertedError = message;
  try {
    const res = await fetchWithTimeout(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: telegramChatId, text: `🚨 Crypto Bot Error\n\n${message}` })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[telegram] sendMessage failed (alert): HTTP ${res.status} ${body.slice(0, 300)}`);
    }
  } catch (e) {
    console.warn('[telegram] sendMessage threw (alert):', e instanceof Error ? e.message : String(e));
  }
}

const PUBLIC_BASE = 'https://api.bybit.com';
const EXEC_BASE = testnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';



const botSymbolsRaw = process.env.BOT_SYMBOLS?.trim();
const isExplicitSymbolOverride = Boolean(botSymbolsRaw && botSymbolsRaw !== '100');
const rawSymbols = (isExplicitSymbolOverride
  ? botSymbolsRaw!.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
  : TARGET_SYMBOLS
);
const unsupportedSymbols = rawSymbols.filter(s => !s.endsWith('USDT')).map(s => ({ symbol: s, reason: 'לא מסתיים ב-USDT (לא נתמך)' }));
let symbols = [...new Set(rawSymbols.filter(s => s.endsWith('USDT')))];

const UNIVERSE_STALE_MS = 24 * 60 * 60 * 1000;
const UNIVERSE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

let universeGeneratedAt = 0;

async function refreshUniverseIfStale(): Promise<void> {
  if (isExplicitSymbolOverride) return;
  try {
    const cached = await configStore.get('targetSymbols');
    const parsed = cached ? (JSON.parse(cached) as { symbols: string[]; generatedAt: number }) : null;
    const isStale = !parsed || Date.now() - parsed.generatedAt > UNIVERSE_STALE_MS;

    if (parsed && parsed.symbols.length) {
      symbols = parsed.symbols;
      universeGeneratedAt = parsed.generatedAt;
    }
    if (!isStale) return;

    const { computeLiquidUniverse } = await import('@cde/engine/market-data');
    const fresh = await computeLiquidUniverse();
    if (!fresh.symbols.length) return;
    symbols = fresh.symbols;
    universeGeneratedAt = fresh.generatedAt;
    await configStore.set('targetSymbols', JSON.stringify({ symbols: fresh.symbols, generatedAt: fresh.generatedAt }));
    console.log(`[universe] refreshed: ${fresh.liquid.length} liquid + ${fresh.close.length} close = ${fresh.symbols.length} symbols`);
  } catch (e) {
    console.warn('[universe] refresh failed, keeping current symbol list:', e instanceof Error ? e.message : String(e));
  }
}

const health = { publicRequests: 0, publicFailures: 0, execRequests: 0, execFailures: 0, lastScanAt: null as string | null };

const state = {
  running: autostart,
  lastScanAt: null as string | null,
  lastError: null as string | null,
  scans: 0,
  startedAt: new Date().toISOString(),
  decisions: [] as ScanResult[],
  orders: [] as { at: string; dryRun: boolean; symbol: string; side: string; reason?: string; error?: string; result?: unknown }[],
  openedSymbols: new Map<string, { at: number; type: 'SPOT' | 'FUTURES'; reason?: string; confidence?: number }>(),
  skippedSymbols: [...unsupportedSymbols] as { symbol: string; reason: string }[],
  realizedPnlTotal: 0,
  pendingLimitOrders: new Map<string, { orderId: string; symbol: string; placedAt: number; expiresAt: number }>(),
  spotHoldings: new Map<string, { entryPrice: number; qty: number; at: number; reason?: string; confidence?: number }>(),
  engineVersion: ENGINE_VERSIONS.intraday as string
};

function json(res: { writeHead: (status: number, headers?: Record<string, string>) => void; end: (body?: string) => void }, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: { on: (event: string, handler: (chunk?: string | Buffer) => void) => void; destroy: () => void }, limitBytes = 5_000_000): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let data = '';
    let tooBig = false;
    req.on('data', (chunk?: string | Buffer) => {
      data += chunk;
      if (data.length > limitBytes) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooBig) return resolve(null);
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

/**
 * Route prefixes the browser reaches without a token.
 *
 * The four sim prefixes come from the registry rather than being listed here.
 * They used to be a hand-written chain of `!startsWith(...)`, and it omitted
 * `/api/path-sim/` — so all six of bot 4's endpoints answered 401 to a frontend
 * that sends no Authorization header. Nothing failed loudly: start, stop,
 * reset, config, state and table all just refused, the bot never received a
 * start command, and the UI rendered a card that never moved. Deriving the list
 * makes that omission unrepresentable.
 *
 * The REAL trading bot is deliberately NOT here. `/api/bot`, `/api/account` and
 * `/api/decisions` move actual money and stay behind the token.
 */
const UNAUTHENTICATED_PREFIXES = [
  ...UI_FACING_SIM_PREFIXES,
  '/api/public'
];

function isUnauthenticatedRoute(pathname: string): boolean {
  return UNAUTHENTICATED_PREFIXES.some((prefix) => pathname.startsWith(`${prefix}/`));
}

function authorized(req: { headers: { authorization?: string } }): boolean {
  if (!adminToken) return false;
  const header = req.headers.authorization || '';
  const expected = `Bearer ${adminToken}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function sign(timestamp: string, payload: string): string {
  return createHmac('sha256', secretKey).update(`${timestamp}${apiKey}5000${payload}`).digest('hex');
}

async function bybitExec(path: string, method = 'GET', params: Record<string, string | number | boolean | undefined> = {}, attempt = 0): Promise<unknown> {
  const MAX_ATTEMPTS = 3;
  const payload = method === 'GET' ? new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).reduce((a, [k, v]) => ({ ...a, [k]: String(v) }), {} as Record<string, string>)).toString() : JSON.stringify(params);
  const timestamp = Date.now().toString();
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey && secretKey) {
    Object.assign(headers, {
      'X-BAPI-API-KEY': apiKey,
      'X-BAPI-SIGN': sign(timestamp, payload),
      'X-BAPI-SIGN-TYPE': '2',
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-RECV-WINDOW': '5000'
    });
  }
  const url = method === 'GET' && payload ? `${EXEC_BASE}${path}?${payload}` : `${EXEC_BASE}${path}`;
  const res = await fetchWithTimeout(url, { method, headers, body: method === 'POST' ? payload : undefined });
  health.execRequests++;
  const responseText = await res.text();
  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    health.execFailures++;
    console.error(`[bybit] Invalid JSON from ${method} ${path}`, {
      status: res.status,
      contentType: res.headers.get('content-type'),
      preview: responseText.slice(0, 300)
    });
    if (method === 'GET' && attempt < MAX_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      return bybitExec(path, method, params, attempt + 1);
    }
    throw new Error(`Bybit returned an invalid response (HTTP ${res.status})`);
  }
  if (!res.ok || data.retCode !== 0) { health.execFailures++; throw new Error(data.retMsg || `Bybit HTTP ${res.status}`); }
  return data.result;
}


async function getAccountContext(): Promise<{ available: number; total: number; openFutures: { symbol: string; size: string; leverage: string; entryPrice: string; side?: string }[]; openFuturesCount: number; spotBalances: Record<string, number> } | null> {
  if (!apiKey || !secretKey) return null;
  const wallet = await bybitExec('/v5/account/wallet-balance', 'GET', { accountType: 'UNIFIED' }) as { list?: { totalEquity?: string; totalWalletBalance?: string; coin?: { coin: string; availableBalance: string; walletBalance: string }[] }[] };
  const account = wallet?.list?.[0] || {};
  const total = Number(account.totalEquity || account.totalWalletBalance || 0);
  const usdt = account.coin?.find((c: { coin: string }) => c.coin === 'USDT');
  const available = Number(usdt?.availableBalance || 0);
  const spotBalances: Record<string, number> = {};
  for (const c of account.coin || []) {
    if (c.coin === 'USDT') continue;
    spotBalances[c.coin] = Number(c.walletBalance || 0);
  }
  const positions = await bybitExec('/v5/position/list', 'GET', { category: 'linear', settleCoin: 'USDT' }) as { list?: { symbol: string; size: string; leverage: string; entryPrice: string; side?: string }[] };
  const openFutures = (positions?.list || []).filter((p: { size: string }) => parseFloat(p.size) > 0);
  return { available, total, openFutures, openFuturesCount: openFutures.length, spotBalances };
}

function baseCoin(symbol: string): string {
  return symbol.replace(/USDT$/, '');
}

async function getSpotFillSummary(symbol: string, side: 'Buy' | 'Sell', since: number): Promise<{ avgPrice: number; totalQty: number; totalFee: number } | null> {
  try {
    const res = await bybitExec('/v5/execution/list', 'GET', { category: 'spot', symbol, startTime: since, limit: 50 }) as { result?: { list?: { execPrice: string; execQty: string; execFee: string; side: string }[] } };
    const fills = (res?.result?.list ?? []).filter((e) => e.side === side);
    if (!fills.length) return null;
    const totalQty = fills.reduce((sum, f) => sum + Number(f.execQty || 0), 0);
    const totalFee = fills.reduce((sum, f) => sum + Number(f.execFee || 0), 0);
    if (totalQty <= 0) return null;
    const avgPrice = fills.reduce((sum, f) => sum + Number(f.execPrice || 0) * Number(f.execQty || 0), 0) / totalQty;
    return { avgPrice, totalQty, totalFee };
  } catch (e) {
    console.warn(`[spot-fills] ${symbol} ${side} lookup failed:`, e instanceof Error ? e.message : String(e));
    return null;
  }
}

async function confirmSpotEntries(ctx: Awaited<ReturnType<typeof getAccountContext>>): Promise<void> {
  if (dryRun || !ctx) return;
  for (const [sym, meta] of [...state.openedSymbols]) {
    if (meta.type !== 'SPOT' || state.spotHoldings.has(sym)) continue;
    const lot = await getSpotLotSize(sym);
    const balance = ctx.spotBalances[baseCoin(sym)] || 0;
    if (!lot || balance < lot.minOrderQty) continue;
    const fill = await getSpotFillSummary(sym, 'Buy', meta.at - 60_000);
    state.spotHoldings.set(sym, {
      entryPrice: fill?.avgPrice || 0,
      qty: balance,
      at: Date.now(),
      reason: meta.reason,
      confidence: meta.confidence
    });
  }
}

async function checkClosedSpotPositions(ctx: Awaited<ReturnType<typeof getAccountContext>>): Promise<void> {
  if (dryRun || !ctx) return;
  for (const [sym, holding] of [...state.spotHoldings]) {
    const lot = await getSpotLotSize(sym);
    const balance = ctx.spotBalances[baseCoin(sym)] || 0;
    if (lot && balance >= lot.minOrderQty) continue;
    state.spotHoldings.delete(sym);
    state.openedSymbols.delete(sym);
    const fill = await getSpotFillSummary(sym, 'Sell', holding.at - 60_000);
    if (!fill) continue;
    const totalPnl = (fill.avgPrice - holding.entryPrice) * fill.totalQty - fill.totalFee;
    const pnlPercent = holding.entryPrice > 0 ? ((fill.avgPrice - holding.entryPrice) / holding.entryPrice) * 100 : 0;
    state.realizedPnlTotal += totalPnl;
    const msg = `🤖 בוט מסחר אמיתי${dryRun ? ' (dry-run)' : ''}\n\n${totalPnl >= 0 ? '✅' : '🔴'} פוזיציה נסגרה (SPOT)\n\nסמל: ${sym}\nכיוון: LONG\nמחיר כניסה: ${holding.entryPrice.toFixed(4)}\nמחיר יציאה: ${fill.avgPrice.toFixed(4)}\nרווח/הפסד: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)\n` +
      (holding.reason ? `סיבת כניסה: ${holding.reason}\n` : '') +
      `\n📊 מצב כולל של הבוט\nרווח מצטבר מאז ההפעלה: ${state.realizedPnlTotal >= 0 ? '+' : ''}$${state.realizedPnlTotal.toFixed(2)}\nיתרת חשבון כוללת: $${ctx.total.toFixed(2)}\nזמן: ${new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' })}`;
    await sendTelegramOrder(msg);
  }
}

async function checkClosedFuturesPositions(ctx: Awaited<ReturnType<typeof getAccountContext>>): Promise<void> {
  if (dryRun) return;
  if (!ctx) return;
  const stillOpenSymbols = new Set(ctx.openFutures.map((p) => p.symbol));
  for (const [sym, meta] of [...state.openedSymbols]) {
    if (meta.type !== 'FUTURES' || stillOpenSymbols.has(sym)) continue;
    state.openedSymbols.delete(sym);
    try {
      const res = await bybitExec('/v5/position/closed-pnl', 'GET', { category: 'linear', symbol: sym, startTime: meta.at, limit: 50 }) as { result?: { list?: { closedPnl: string; avgEntryPrice: string; avgExitPrice: string; qty: string; side: string; leverage: string }[] } };
      const records = res?.result?.list ?? [];
      if (!records.length) continue;
      const totalPnl = records.reduce((sum, r) => sum + Number(r.closedPnl || 0), 0);
      const entryPrice = Number(records[records.length - 1]?.avgEntryPrice || 0);
      const exitPrice = Number(records[0]?.avgExitPrice || 0);
      const totalQty = records.reduce((sum, r) => sum + Number(r.qty || 0), 0);
      const side = records[0]?.side === 'Buy' ? 'LONG' : 'SHORT';
      const leverage = Number(records[0]?.leverage || 1);
      const marginUsed = leverage > 0 ? (totalQty * entryPrice) / leverage : 0;
      const pnlPercent = marginUsed > 0 ? (totalPnl / marginUsed) * 100 : 0;
      state.realizedPnlTotal += totalPnl;
      const msg = `🤖 בוט מסחר אמיתי${dryRun ? ' (dry-run)' : ''}\n\n${totalPnl >= 0 ? '✅' : '🔴'} פוזיציה נסגרה\n\nסמל: ${sym}\nכיוון: ${side} (${leverage}x)\nמחיר כניסה: ${entryPrice.toFixed(4)}\nמחיר יציאה: ${exitPrice.toFixed(4)}\nרווח/הפסד: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)\n` +
        (meta.reason ? `סיבת כניסה: ${meta.reason}\n` : '') +
        `\n📊 מצב כולל של הבוט\nרווח מצטבר מאז ההפעלה: ${state.realizedPnlTotal >= 0 ? '+' : ''}$${state.realizedPnlTotal.toFixed(2)}\nיתרת חשבון כוללת: $${ctx.total.toFixed(2)}\nפוזיציות פתוחות: ${ctx.openFuturesCount}\nזמן: ${new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' })}`;
      await sendTelegramOrder(msg);
    } catch (e) {
      console.warn(`[exit-notify] closed-pnl lookup failed for ${sym}:`, e instanceof Error ? e.message : String(e));
    }
  }
}

// Engine versions — bumped when the decision algorithm changes.

const store = createKVStore('bot-state', join(DATA_DIR, 'bot-state.json'));
/** Every sim bot's store, keyed off the registry so a new bot cannot be given a
 *  key by hand that disagrees with its route. */
function simStoreFor(id: keyof typeof SIM_BOTS) {
  const key = SIM_BOTS[id].storeKey;
  return createKVStore(key, join(DATA_DIR, `${key}.json`));
}

const simStore = simStoreFor('intraday');
const proSimStore = simStoreFor('pro');
const pathSimStore = simStoreFor('path');
/** The validated 4H path table. Durable like every other artifact the worker
 *  depends on — it used to be read from a gitignored local file that simply did
 *  not exist on the server, so the bot silently fell back to an in-sample
 *  rebuild while reporting nothing about the difference. */
const pathTableStore = createKVStore('path-table', join(DATA_DIR, 'path-table.json'));
const configStore = createKVStore('config', join(DATA_DIR, 'config.json'));

const SIM_STATE_FILE = join(DATA_DIR, 'sim-state.json');
const SIM_LEADER_TIMEOUT_MS = 8000;

// Fixed max positions: 7 for all bots (regardless of initial amount)
function calcMaxPositions(_initialAmount: number): number {
  return 7;
}

/** Validates a sim config arriving from the API or from persisted state.
 *
 *  Every numeric field is range-checked and anything out of range is dropped
 *  (so the DEFAULT_*_SIM_CONFIG spread underneath supplies the value) rather
 *  than passed through. The previous version checked exactly one field of the
 *  nine and let the rest reach the engines unread — a negative feePercent or a
 *  positionPercent of 5000 was accepted and persisted.
 *
 *  minConfidenceOverride keeps its special case: 0 means "not set", because the
 *  ?? operator downstream would otherwise pass it through and disable the
 *  confidence floor entirely. */
const SIM_CONFIG_BOUNDS: Record<string, { min: number; max: number; int?: boolean }> = {
  initialAmount: { min: 1, max: 100_000_000 },
  maxPositions: { min: 1, max: 50, int: true },
  maxFuturesPositions: { min: 0, max: 50, int: true },
  feePercent: { min: 0, max: 5 },
  slippagePercent: { min: 0, max: 5 },
  executionDelaySec: { min: 0, max: 300 },
  minConfidenceOverride: { min: 1, max: 100 },
  positionPercent: { min: 0.1, max: 100 }
};

const SIM_RISK_LEVELS = new Set(['low', 'medium', 'high']);

function sanitizeSimConfig(cfg: Record<string, unknown>): Record<string, unknown> {
  for (const [field, bound] of Object.entries(SIM_CONFIG_BOUNDS)) {
    if (cfg[field] === undefined) continue;
    const value = Number(cfg[field]);
    const ok = Number.isFinite(value) && value >= bound.min && value <= bound.max;
    cfg[field] = ok ? (bound.int ? Math.floor(value) : value) : undefined;
  }
  if (cfg.riskLevel !== undefined && !SIM_RISK_LEVELS.has(String(cfg.riskLevel))) {
    cfg.riskLevel = undefined;
  }
  return cfg;
}

/** Applies a config patch to a sim, resetting the run when the starting capital
 *  changed. A run's P&L, drawdown and sizing are all measured against the
 *  capital it opened with, so retro-fitting a new number onto a run already in
 *  progress produces figures that describe no actual account — which is what
 *  editing that field used to do. Returns true when the run was reset. */
function applySimConfigPatch<T extends { config: SimBotConfig; snapshot: unknown | null; running: boolean }>(
  state: T,
  defaults: SimBotConfig,
  patch: Record<string, unknown>,
  engine: { reset: (c: never) => void; getSnapshot: () => unknown; getInitialAmount: () => number }
): boolean {
  const before = engine.getInitialAmount();
  state.config = { ...defaults, ...state.config, ...sanitizeSimConfig({ ...patch }) } as SimBotConfig;
  const after = Number(state.config.initialAmount);
  if (!Number.isFinite(after) || after === before) return false;
  engine.reset(state.config as never);
  state.snapshot = engine.getSnapshot();
  return true;
}

/** The deploy-time layer, gathered once and handed to the registry. */
const SIM_ENV: SimEnvOverrides = {
  minConfidence: minConfidenceOverrideEnv,
  pathMinConfidence: pathMinConfidenceEnv,
  positionPercent,
  maxPositions: maxOpenPositions,
  riskLevel
};

const DEFAULT_SIM_CONFIG = simBotDefaults('intraday', SIM_ENV);
const simState = {
  running: false, config: { ...DEFAULT_SIM_CONFIG } as typeof DEFAULT_SIM_CONFIG,
  snapshot: null as unknown | null, leaderId: null as string | null,
  leaderHeartbeat: 0, updatedAt: 0, epoch: 0,
  engineVersion: ENGINE_VERSIONS.intraday as string
};

const simEngine = createSimEngine(() => symbols);

async function hydrateSim() {
  const saved = await simStore.get('state');
  if (!saved) return;
  const s = JSON.parse(saved) as Record<string, unknown>;
  simState.running = typeof s.running === 'boolean' ? s.running : false;
  simState.config = { ...DEFAULT_SIM_CONFIG, ...sanitizeSimConfig(typeof s.config === 'object' && s.config !== null ? { ...s.config as Record<string, unknown> } : {}) };
  simState.snapshot = s.snapshot ?? null;
  simState.leaderId = typeof s.leaderId === 'string' ? s.leaderId : null;
  simState.leaderHeartbeat = typeof s.leaderHeartbeat === 'number' ? s.leaderHeartbeat : 0;
  simState.updatedAt = typeof s.updatedAt === 'number' ? s.updatedAt : 0;
  simState.epoch = typeof s.epoch === 'number' ? s.epoch : 0;
  simState.engineVersion = typeof s.engineVersion === 'string' ? s.engineVersion : ENGINE_VERSIONS.intraday;
}

async function persistSim() {
  await simStore.set('state', JSON.stringify({
    running: simState.running, config: simState.config, snapshot: simState.snapshot,
    leaderId: simState.leaderId, leaderHeartbeat: simState.leaderHeartbeat,
    updatedAt: simState.updatedAt, epoch: simState.epoch,
    engineVersion: simState.engineVersion
  }));
}

const DEFAULT_PRO_SIM_CONFIG = simBotDefaults('pro', SIM_ENV);
const proSimState = { running: false, config: { ...DEFAULT_PRO_SIM_CONFIG } as typeof DEFAULT_PRO_SIM_CONFIG, snapshot: null as unknown | null, updatedAt: 0, engineVersion: ENGINE_VERSIONS.pro as string };

const proSimEngine = createProSimEngine(() => symbols);

async function hydrateProSim() {
  const saved = await proSimStore.get('state');
  if (!saved) return;
  const s = JSON.parse(saved) as Record<string, unknown>;
  proSimState.running = typeof s.running === 'boolean' ? s.running : false;
  proSimState.config = { ...DEFAULT_PRO_SIM_CONFIG, ...sanitizeSimConfig(typeof s.config === 'object' && s.config !== null ? { ...s.config as Record<string, unknown> } : {}) };
  proSimState.snapshot = s.snapshot ?? null;
  proSimState.updatedAt = typeof s.updatedAt === 'number' ? s.updatedAt : 0;
  proSimState.engineVersion = typeof s.engineVersion === 'string' ? s.engineVersion : ENGINE_VERSIONS.pro;
}

async function persistProSim() {
  await proSimStore.set('state', JSON.stringify({
    running: proSimState.running, config: proSimState.config,
    snapshot: proSimState.snapshot, updatedAt: proSimState.updatedAt,
    engineVersion: proSimState.engineVersion
  }));
}

// ── 4H Path sim (bot 4) ─────────────────────────────────────────────────────
// Same config shape and the same shared defaults as the other three: the point
// of the fourth bot is to isolate its DECISION layer, so every other variable
// (capital, position cap, costs, sizing ceiling) is deliberately identical.
// maxFuturesPositions is 0 (spot-only) and the confidence floor is a
// PROBABILITY, so BOT_MIN_CONFIDENCE deliberately does not reach it — only
// BOT_PATH_MIN_CONFIDENCE does. The registry enforces that, not this line.
const DEFAULT_PATH_SIM_CONFIG = simBotDefaults('path', SIM_ENV);
const pathSimState = { running: false, config: { ...DEFAULT_PATH_SIM_CONFIG } as typeof DEFAULT_PATH_SIM_CONFIG, snapshot: null as unknown | null, updatedAt: 0, engineVersion: ENGINE_VERSIONS.path as string };

const pathSimEngine = createPathSimEngine(() => symbols);

/**
 * Installs the validated 4H table from durable storage at boot.
 *
 * Boot, not tick: `buildEvaluations` is synchronous, so a network read inside it
 * would either block the tick or resolve after the decision it was meant to
 * inform. Failure is not fatal — the bot falls back to its in-sample rebuild and
 * `/api/path-sim/table` reports `source` so the difference is visible rather
 * than assumed.
 */
async function hydratePathTable() {
  try {
    const saved = await pathTableStore.get('table');
    if (!saved) {
      console.log('[path-table] none stored — the Path bot will rebuild in-sample until one is published');
      return;
    }
    installValidatedTable(JSON.parse(saved));
  } catch (e) {
    console.warn('[path-table] unreadable, falling back to the in-sample rebuild:', e instanceof Error ? e.message : String(e));
  }
}

async function hydratePathSim() {
  const saved = await pathSimStore.get('state');
  if (!saved) return;
  const s = JSON.parse(saved) as Record<string, unknown>;
  pathSimState.running = typeof s.running === 'boolean' ? s.running : false;
  pathSimState.config = { ...DEFAULT_PATH_SIM_CONFIG, ...sanitizeSimConfig(typeof s.config === 'object' && s.config !== null ? { ...s.config as Record<string, unknown> } : {}) };
  pathSimState.snapshot = s.snapshot ?? null;
  pathSimState.updatedAt = typeof s.updatedAt === 'number' ? s.updatedAt : 0;
  pathSimState.engineVersion = typeof s.engineVersion === 'string' ? s.engineVersion : ENGINE_VERSIONS.path;
}

async function persistPathSim() {
  await pathSimStore.set('state', JSON.stringify({
    running: pathSimState.running, config: pathSimState.config,
    snapshot: pathSimState.snapshot, updatedAt: pathSimState.updatedAt,
    engineVersion: pathSimState.engineVersion
  }));
}

function serializeState(): string {
  return JSON.stringify({
    running: state.running, lastScanAt: state.lastScanAt, lastError: state.lastError,
    scans: state.scans, startedAt: state.startedAt, decisions: state.decisions,
    orders: state.orders, openedSymbols: Object.fromEntries(state.openedSymbols),
    skippedSymbols: state.skippedSymbols, pendingLimitOrders: Object.fromEntries(state.pendingLimitOrders),
    spotHoldings: Object.fromEntries(state.spotHoldings), realizedPnlTotal: state.realizedPnlTotal, health,
    engineVersion: state.engineVersion
  });
}

async function hydrate(): Promise<void> {
  const saved = await store.get('state');
  if (!saved) return;
  const s = JSON.parse(saved) as Record<string, unknown>;
  state.running = typeof s.running === 'boolean' ? s.running : state.running;
  state.lastScanAt = typeof s.lastScanAt === 'string' ? s.lastScanAt : null;
  state.lastError = typeof s.lastError === 'string' ? s.lastError : null;
  state.scans = typeof s.scans === 'number' ? s.scans : 0;
  state.startedAt = typeof s.startedAt === 'string' ? s.startedAt : state.startedAt;
  state.decisions = Array.isArray(s.decisions) ? s.decisions as ScanResult[] : [];
  state.orders = Array.isArray(s.orders) ? s.orders as { at: string; dryRun: boolean; symbol: string; side: string; reason?: string; error?: string; result?: unknown }[] : [];
  const savedOpened = s.openedSymbols;
  if (Array.isArray(savedOpened)) {
    state.openedSymbols = new Map(savedOpened.map((symbol) => [symbol, { at: Date.now(), type: 'SPOT' }]));
  } else if (savedOpened && typeof savedOpened === 'object') {
    state.openedSymbols = new Map(Object.entries(savedOpened as Record<string, { at: number; type: 'SPOT' | 'FUTURES'; reason?: string; confidence?: number }>));
  } else {
    state.openedSymbols = new Map();
  }
  state.realizedPnlTotal = typeof s.realizedPnlTotal === 'number' ? s.realizedPnlTotal : 0;
  state.engineVersion = typeof s.engineVersion === 'string' ? s.engineVersion : ENGINE_VERSIONS.intraday as string;
  state.skippedSymbols = Array.isArray(s.skippedSymbols) ? s.skippedSymbols as { symbol: string; reason: string }[] : [];
  const savedPending = s.pendingLimitOrders;
  if (savedPending && typeof savedPending === 'object') {
    state.pendingLimitOrders = new Map(Object.entries(savedPending as Record<string, { orderId: string; symbol: string; placedAt: number; expiresAt: number }>));
  } else {
    state.pendingLimitOrders = new Map();
  }
  const savedSpotHoldings = s.spotHoldings;
  if (savedSpotHoldings && typeof savedSpotHoldings === 'object') {
    state.spotHoldings = new Map(Object.entries(savedSpotHoldings as Record<string, { entryPrice: number; qty: number; at: number; reason?: string; confidence?: number }>));
  } else {
    state.spotHoldings = new Map();
  }
  health.lastScanAt = typeof (s.health as Record<string, unknown> | undefined)?.lastScanAt === 'string' ? (s.health as Record<string, unknown> | undefined)?.lastScanAt as string : null;
}

const MARKET_CACHE_PERSIST_MS = 10 * 60 * 1000;
let lastCachePersistAt = 0;

async function hydrateMarketCache(): Promise<void> {
  for (const sym of symbols) {
    const bybitSym = toBybitSymbol(sym);
    try {
      const saved = await store.get(`mcache:${bybitSym}`);
      if (!saved) continue;
      const doc = JSON.parse(saved) as Record<string, TimeframeCacheEntry>;
      for (const tf of TIMEFRAME_ORDER) {
        const entry = doc[tf];
        if (entry && Array.isArray(entry.candles) && entry.candles.length && typeof entry.lastTimestamp === 'number') {
          importMarketDataCache({ [`${bybitSym}:${tf}`]: entry });
        }
      }
    } catch { /* corrupt warm cache is non-fatal */ }
  }
}

async function persistMarketCache(): Promise<void> {
  const now = Date.now();
  if (now - lastCachePersistAt < MARKET_CACHE_PERSIST_MS) return;
  lastCachePersistAt = now;
  const full = exportMarketDataCache();
  try {
    for (const sym of symbols) {
      const bybitSym = toBybitSymbol(sym);
      const doc: Record<string, TimeframeCacheEntry> = {};
      for (const tf of TIMEFRAME_ORDER) {
        const entry = full[`${bybitSym}:${tf}`];
        if (entry) {
          doc[tf] = { ...entry, candles: entry.candles.slice(-TIMEFRAME_SPECS[tf].minCandles) };
        }
      }
      if (Object.keys(doc).length) await store.set(`mcache:${bybitSym}`, JSON.stringify(doc));
    }
  } catch { /* never block a scan on cache persistence */ }
}

interface FearGreedReading {
  value: number;
  value_classification: string;
  timestamp: string;
  at: number;
}
const FEAR_GREED_TTL_MS = 15 * 60 * 1000;
let fearGreedCache: FearGreedReading | null = null;
let fearGreedInFlight: Promise<FearGreedReading | null> | null = null;

async function fetchFearGreedFull(): Promise<FearGreedReading | null> {
  if (fearGreedCache && Date.now() - fearGreedCache.at < FEAR_GREED_TTL_MS) {
    return fearGreedCache;
  }
  if (fearGreedInFlight) return fearGreedInFlight;
  fearGreedInFlight = (async () => {
    try {
      const res = await fetchWithTimeout('https://api.alternative.me/fng/?limit=1', { method: 'GET' });
      if (!res.ok) throw new Error(`fng HTTP ${res.status}`);
      const data = await res.json() as { data?: { value?: string; value_classification?: string; timestamp?: string }[] };
      const latest = data?.data?.[0];
      const v = Number(latest?.value);
      if (!latest || !isFinite(v)) throw new Error('invalid fng payload');
      fearGreedCache = {
        value: v,
        value_classification: latest.value_classification || 'Neutral',
        timestamp: String(latest.timestamp || Math.floor(Date.now() / 1000)),
        at: Date.now()
      };
    } catch { /* Keep any stale reading; null only if we never got a good one. */ } finally {
      fearGreedInFlight = null;
    }
    return fearGreedCache;
  })();
  return fearGreedInFlight;
}

async function fetchFearGreed(): Promise<number> {
  const fg = await fetchFearGreedFull();
  return fg ? fg.value : 50;
}

// ═══════════════════════════════════════════════════════════════════════════
// SCAN + EXECUTION ENGINE
// ═══════════════════════════════════════════════════════════════════════════

const LIMIT_ORDER_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

interface LotSizeInfo { basePrecision: number; minOrderQty: number }
const lotSizeCache = new Map<string, { info: LotSizeInfo; at: number }>();
const LOT_SIZE_TTL_MS = 6 * 60 * 60 * 1000;

async function getSpotLotSize(symbol: string): Promise<LotSizeInfo | null> {
  const cached = lotSizeCache.get(symbol);
  if (cached && Date.now() - cached.at < LOT_SIZE_TTL_MS) return cached.info;
  try {
    const res = await fetchWithTimeout(`${PUBLIC_BASE}/v5/market/instruments-info?category=spot&symbol=${symbol}`);
    health.publicRequests++;
    if (!res.ok) throw new Error(`instruments-info HTTP ${res.status}`);
    const data = await res.json() as {
      retCode: number;
      result?: { list?: { lotSizeFilter?: { basePrecision?: string; minOrderQty?: string } }[] };
    };
    const filter = data.result?.list?.[0]?.lotSizeFilter;
    if (data.retCode !== 0 || !filter?.basePrecision) throw new Error('no lotSizeFilter');
    const info: LotSizeInfo = {
      basePrecision: Number(filter.basePrecision),
      minOrderQty: Number(filter.minOrderQty ?? filter.basePrecision)
    };
    lotSizeCache.set(symbol, { info, at: Date.now() });
    return info;
  } catch (e) {
    health.publicFailures++;
    console.warn(`[lot-size] ${symbol} fetch failed:`, e instanceof Error ? e.message : String(e));
    return null;
  }
}

function roundToLotSize(qty: number, lot: LotSizeInfo): number | null {
  const stepDecimals = Math.max(0, -Math.floor(Math.log10(lot.basePrecision)));
  const stepped = Math.floor(qty / lot.basePrecision) * lot.basePrecision;
  const rounded = Number(stepped.toFixed(stepDecimals));
  return rounded >= lot.minOrderQty ? rounded : null;
}

async function executeOrder(d: IntradayDecision, ctx: { available: number } | null, runningTotals: { totalOpen: number; futuresOpen: number }): Promise<{ opened: boolean; skipped?: string }> {
  const { symbol, direction, tradeType, risk } = d;

  if (!risk || !risk.approved) {
    return { opened: false, skipped: 'נפסל על ידי מנוע הסיכון' };
  }

  if (tradeType === 'SPOT' && direction === 'SHORT') {
    if (dryRun) {
      state.orders.unshift({ at: new Date().toISOString(), dryRun: true, symbol, side: 'SELL', reason: 'Spot SELL מושבת (אין אימות יתרה מוחזקת) — dry-run only' });
      return { opened: false };
    }
    return { opened: false, skipped: 'live spot SELL disabled — no held-balance verification yet' };
  }

  const side = direction === 'LONG' ? 'LONG' : 'SHORT';
  const limitEntryPrice = d.entry?.entryPrice ?? risk.stopLoss;

  const budget = Math.max(5, (ctx?.available ?? 0) * (positionPercent / 100));
  if (budget < 5) return { opened: false, skipped: 'יתרה לא מספיקה' };

  const qty = risk.quantity;
  if (!(qty > 0) || !isFinite(qty)) return { opened: false, skipped: 'כמות לא חוקית' };

  const leverage = risk.leverage;
  const formattedLimitPrice = limitEntryPrice.toFixed(8).replace(/\.?0+$/, '').slice(0, 20);
  const order = tradeType === 'FUTURES'
    ? {
        category: 'linear', symbol,
        side: side === 'LONG' ? 'Buy' : 'Sell',
        orderType: 'Limit',
        price: formattedLimitPrice,
        timeInForce: 'GTC',
        qty: qty.toFixed(4),
        stopLoss: risk.stopLoss.toString(),
        takeProfit: risk.takeProfit1?.toString(),
        tpslMode: 'Partial',
        tpOrderType: 'Market',
        slOrderType: 'Market',
        leverage: String(leverage)
      }
    : {
        category: 'spot', symbol,
        side: 'Buy',
        orderType: 'Limit',
        price: formattedLimitPrice,
        timeInForce: 'GTC',
        qty: qty.toFixed(4)
      };

  const entryReason = `${d.setupType} ${direction} | ${d.summary}`;

  if (dryRun) {
    state.orders.unshift({ at: new Date().toISOString(), dryRun: true, ...order, reason: entryReason });
    return { opened: true };
  }
  try {
    if (tradeType === 'FUTURES') {
      await bybitExec('/v5/position/set-leverage', 'POST', { category: 'linear', symbol, buyLeverage: String(leverage), sellLeverage: String(leverage) });
    }
    const result = await bybitExec('/v5/order/create', 'POST', order) as { orderId?: string };
    const orderId = result?.orderId || '';
    state.orders.unshift({ at: new Date().toISOString(), dryRun: false, ...order, result });

    if (orderId) {
      const placedAt = Date.now();
      state.pendingLimitOrders.set(symbol, {
        orderId,
        symbol,
        placedAt,
        expiresAt: placedAt + LIMIT_ORDER_TTL_MS
      });
    }
    return { opened: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    state.orders.unshift({ at: new Date().toISOString(), dryRun: false, error: msg, symbol, side });
    return { opened: false, skipped: msg };
  }
}

interface ScanResult {
  symbol: string;
  action: 'HOLD' | 'SPOT' | 'FUTURES';
  side: string;
  confidence: number;
  reason: string;
  currentPrice: number;
  decision: IntradayDecision;
  skipped?: string;
}

let scanInProgress = false;
async function scan(): Promise<void> {
  if (!state.running || scanInProgress) return;
  scanInProgress = true;
  try {
    if (!apiKey || !secretKey) throw new Error('Missing BYBIT_API_KEY / BYBIT_SECRET_KEY (server-only)');
    let ctx: Awaited<ReturnType<typeof getAccountContext>> = null;
    try {
      ctx = await getAccountContext();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[scan] getAccountContext failed, continuing with ctx=null: ${msg}`);
      state.lastError = `Account context unavailable: ${msg}`;
    }
    const decisions: ScanResult[] = [];
    const scannedThisRun = new Set();
    state.skippedSymbols = [...unsupportedSymbols];
    // Count exchange positions plus local reservations. A LIMIT order is not
    // a filled position yet, but it still consumes a symbol/position slot
    // until it fills, expires, or is cancelled.
    const reservedEntries = [...state.openedSymbols.entries()]
      .filter(([sym]) => !state.pendingLimitOrders.has(sym));
    const activeSymbols = new Set([
      ...(ctx?.openFutures.map((p) => p.symbol) ?? []),
      ...state.spotHoldings.keys(),
      ...state.pendingLimitOrders.keys(),
      ...reservedEntries.map(([sym]) => sym)
    ]);
    const pendingFutures = [...state.pendingLimitOrders.keys()]
      .filter((sym) => state.openedSymbols.get(sym)?.type === 'FUTURES').length;
    const reservedFutures = reservedEntries.filter(([, meta]) => meta.type === 'FUTURES').length;
    const runningTotals = {
      totalOpen: activeSymbols.size,
      futuresOpen: (ctx?.openFuturesCount ?? 0) + reservedFutures + pendingFutures
    };
    const fearGreed = await fetchFearGreed();

    const now = Date.now();

    if (!dryRun) {
      for (const [sym, pending] of state.pendingLimitOrders) {
        if (now >= pending.expiresAt) {
          try {
            const category = ctx?.openFutures.some(p => p.symbol === sym) ? 'linear' : 'spot';
            await bybitExec('/v5/order/cancel', 'POST', { category, symbol: sym, orderId: pending.orderId });
            console.log(`[TTL] Cancelled expired limit order ${pending.orderId} for ${sym}`);
          } catch { /* order may have already been filled/cancelled */ }
          state.pendingLimitOrders.delete(sym);
          state.openedSymbols.delete(sym);
          state.orders.unshift({
            at: new Date().toISOString(),
            dryRun: false,
            symbol: sym,
            side: 'N/A',
            reason: `[TTL] פקודת Limit בוטלה אחרי ${LIMIT_ORDER_TTL_MS / 3600000}h ללא מילוי (orderId: ${pending.orderId})`
          });
        }
      }
    }

    // A SPOT reservation (openedSymbols entry) has no exchange to confirm a
    // close in dry-run mode, and in live mode it can otherwise outlive the
    // actual holding. Expire the reservation after REENTRY_COOLDOWN_MS so the
    // symbol gets re-scanned; genuine live closes are still reported by
    // checkClosedSpotPositions / checkClosedFuturesPositions below.
    for (const [sym, meta] of [...state.openedSymbols]) {
      if (meta.type !== 'SPOT') continue;
      // Let an unfilled limit order ride out its full TTL (it cancels itself
      // and cleans openedSymbols in the expiry block above).
      if (state.pendingLimitOrders.has(sym)) continue;
      if (Date.now() - meta.at > REENTRY_COOLDOWN_MS) {
        state.openedSymbols.delete(sym);
      }
    }
    await checkClosedFuturesPositions(ctx);
    await confirmSpotEntries(ctx);
    await checkClosedSpotPositions(ctx);

    for (let i = 0; i < symbols.length; i += scanConcurrency) {
      const batch = symbols.slice(i, i + scanConcurrency);
      const results = await Promise.all(batch.map(async (symbol): Promise<ScanResult> => {
        try {
          const snap = await getMultiTimeframeData(symbol, { log: true });
          if (snap.status !== 'READY') {
            state.skippedSymbols.push({ symbol, reason: `אין נתונים MTF (${snap.reason ?? 'NOT_READY'})` });
            return { symbol, action: 'HOLD', side: 'NONE', confidence: 0, reason: 'אין נתונים MTF', currentPrice: snap.livePrice, decision: null as unknown as IntradayDecision, skipped: undefined };
          }
          const currentPrice = snap.liquidity?.lastPrice || snap.m5[snap.m5.length - 1]?.close || 0;

          const openPositions = [
            ...[...state.openedSymbols.entries()].map(([s, m]) => ({ symbol: s, type: m.type as TradeType })),
            ...(ctx ? ctx.openFutures.map((p) => ({ symbol: p.symbol, type: 'FUTURES' as TradeType })) : [])
          ];
          const portfolio = buildPortfolioRiskStats({
            portfolioValue: ctx?.available ?? 0,
            initialAmount: ctx?.available ?? 0,
            dailyDrawdownPercent: 0,
            weeklyDrawdownPercent: 0,
            openPositionsCount: runningTotals.totalOpen,
            openFuturesPositionsCount: runningTotals.futuresOpen,
            totalLeveragedExposureUsd: 0,
            existingExposureByAsset: {}
          });

          const decision = evaluateIntradayDecision({
            symbol: snap.symbol,
            h1: snap.h1,
            m15: snap.m15,
            m5: snap.m5,
            spreadPercent: snap.liquidity?.spreadPercent ?? 0,
            quoteVolume24h: snap.liquidity?.quoteVolume24h ?? 0,
            quoteVolume24hSpot: snap.liquidity?.quoteVolume24hSpot ?? 0,
            livePrice: currentPrice,
            portfolio,
            openPositions
          });

          const action = decision.outcome === 'SIGNAL' ? (decision.tradeType as 'SPOT' | 'FUTURES') : 'HOLD';
          const side = decision.direction === 'LONG' ? 'LONG' : decision.direction === 'SHORT' ? 'SHORT' : 'NONE';
          const confidence = decision.outcome === 'SIGNAL' ? Math.round((decision.metrics.setupScore + decision.metrics.entryScore) / 2) : 0;
          return { symbol, action, side, confidence, reason: decision.summary, currentPrice, decision, skipped: undefined };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          state.skippedSymbols.push({ symbol, reason: `שגיאה בסריקה: ${msg}` });
          return { symbol, action: 'HOLD', side: 'NONE', confidence: 0, reason: `שגיאה: ${msg}`, currentPrice: 0, decision: null as unknown as IntradayDecision, skipped: undefined };
        }
      }));

      for (const d of results) {
        decisions.push(d);
        if (d.action === 'HOLD') continue;
        if (scannedThisRun.has(d.symbol)) continue;
        if (state.openedSymbols.has(d.symbol)) continue;
        if (runningTotals.totalOpen >= maxOpenPositions) { d.skipped = 'הגעה למקסימום פוזיציות'; continue; }
        const res = await executeOrder(d.decision, ctx, runningTotals);
        if (res.opened) {
          runningTotals.totalOpen++;
          if (d.action === 'FUTURES') runningTotals.futuresOpen++;
          state.openedSymbols.set(d.symbol, { at: Date.now(), type: d.action as 'SPOT' | 'FUTURES', reason: d.decision.summary, confidence: d.confidence });
          scannedThisRun.add(d.symbol);
        } else if (res.skipped) {
          d.skipped = res.skipped;
        }
      }
    }

    state.decisions = decisions;
    state.lastScanAt = new Date().toISOString();
    state.lastError = null;
    lastAlertedError = null;
    state.scans++;
    health.lastScanAt = state.lastScanAt;
    state.orders = state.orders.slice(0, 50);
    await store.set('state', serializeState());
    await persistMarketCache();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown scan error';
    state.lastError = errorMessage;
    await store.set('state', serializeState());
    await persistMarketCache();
    void sendTelegramAlert(errorMessage);
  } finally {
    scanInProgress = false;
  }
}

async function getAccountSummary(): Promise<{ availableUsdt: number; totalUsdt: number; openFuturesCount: number; positions: { symbol: string; side: string; size: number; leverage: number; entryPrice: number }[] } | null> {
  if (!apiKey || !secretKey) return null;
  const ctx = await getAccountContext();
  if (!ctx) return null;
  return {
    availableUsdt: Number(ctx.available.toFixed(2)),
    totalUsdt: Number(ctx.total.toFixed(2)),
    openFuturesCount: ctx.openFuturesCount,
    positions: ctx.openFutures.map(p => ({
      symbol: p.symbol,
      side: p.side || 'NONE',
      size: parseFloat(p.size),
      leverage: parseFloat(p.leverage || '0'),
      entryPrice: parseFloat(p.entryPrice || '0')
    }))
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// HTTP SERVER
// ═══════════════════════════════════════════════════════════════════════════

interface BotRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
  on(event: string, handler: (chunk?: string | Buffer) => void): void;
  destroy(): void;
}

interface BotResponse {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
  setHeader(name: string, value: string): void;
}

createServer(async (req: BotRequest, res: BotResponse) => {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'cache-control': 'no-store' });
    return res.end();
  }

  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, {
      ok: true, testnet, dryRun, mode: testnet ? 'testnet' : 'live',
      publicBase: PUBLIC_BASE, execBase: EXEC_BASE,
      configured: Boolean(apiKey && secretKey),
      running: state.running, lastScanAt: state.lastScanAt, lastError: state.lastError,
      symbols: symbols.length, skipped: state.skippedSymbols.length, health
    });
  }

  // Preflight (OPTIONS) requests must never be rate-limited: the browser
  // sends them automatically before every cross-origin POST, and blocking
  // them produces opaque CORS failures that look like 'no header present'.
  if (req.method === 'OPTIONS') {
    return;
  }

  if (rateLimited(clientIp(req))) {
    return json(res, 429, { error: 'Too many requests' });
  }

  if (req.method === 'GET' && url.pathname === '/api/public/universe') {
    return json(res, 200, { symbols, generatedAt: universeGeneratedAt });
  }

  /**
   * The config each sim bot ACTUALLY starts from, after the environment layer.
   *
   * `@cde/engine`'s simBotDefaults() gives both runtimes the same compile-time
   * base, but the worker then lays BOT_MIN_CONFIDENCE, BOT_POSITION_PERCENT,
   * BOT_MAX_OPEN_POSITIONS and BOT_RISK_LEVEL on top — and a browser cannot read
   * environment variables. Without this endpoint the panel showed the base and
   * called it the default, which is true only on a deployment that sets none of
   * those four.
   *
   * Public, like /api/public/universe: these are operating parameters the sim
   * state endpoints already expose to the same unauthenticated callers, and
   * nothing here is a credential.
   *
   * The RUNNING config still comes from each bot's own /state — this is only
   * what a fresh bot would start with, which is exactly the gap the frontend
   * had to fill with a guess.
   */
  if (req.method === 'GET' && url.pathname === '/api/public/sim-defaults') {
    return json(res, 200, {
      intraday: DEFAULT_SIM_CONFIG,
      pro: DEFAULT_PRO_SIM_CONFIG,
      path: DEFAULT_PATH_SIM_CONFIG,
      // Which of the four environment variables are actually set here. The
      // frontend does not need this to function; an operator looking at two
      // deployments that disagree does.
      envOverrides: {
        minConfidence: minConfidenceOverrideEnv ?? null,
        pathMinConfidence: pathMinConfidenceEnv ?? null,
        positionPercent,
        maxOpenPositions,
        riskLevel
      }
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/fear-greed') {
    const fg = await fetchFearGreedFull();
    if (!fg) return json(res, 503, { error: 'Fear & Greed unavailable' });
    return json(res, 200, { value: fg.value, value_classification: fg.value_classification, timestamp: fg.timestamp, cachedAt: fg.at });
  }

  if (url.pathname.startsWith('/api/') && !isUnauthenticatedRoute(url.pathname) && !authorized(req)) {
    return json(res, 401, { error: 'Unauthorized' });
  }

  if (req.method === 'GET' && url.pathname === '/api/bot/state') {
    return json(res, 200, {
      testnet, dryRun, mode: testnet ? 'testnet' : 'live',
      riskLevel, symbols, minConfidence: minConfidenceOverrideEnv ?? null, positionPercent, maxOpenPositions, scanConcurrency,
      ...state, openedSymbols: Object.fromEntries(state.openedSymbols), health
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/account/summary') {
    try {
      const summary = await getAccountSummary();
      if (!summary) return json(res, 503, { error: 'Account context unavailable (missing credentials or exchange error)' });
      return json(res, 200, summary);
    } catch (e: unknown) {
      return json(res, 502, { error: `Account summary failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/decisions') {
    return json(res, 200, {
      decisions: state.decisions,
      skippedSymbols: state.skippedSymbols,
      lastScanAt: state.lastScanAt,
      lastError: state.lastError
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/bot/start') {
    state.running = true;
    await store.set('state', serializeState());
    await scan();
    return json(res, 200, { ...state, openedSymbols: Object.fromEntries(state.openedSymbols), dryRun, testnet, health });
  }

  if (req.method === 'POST' && url.pathname === '/api/bot/stop') {
    state.running = false;
    await store.set('state', serializeState());
    return json(res, 200, { ...state, openedSymbols: Object.fromEntries(state.openedSymbols), dryRun, testnet, health });
  }

  if (req.method === 'GET' && url.pathname === '/api/sim/state') {
    return json(res, 200, simState);
  }

  if (req.method === 'POST' && url.pathname === '/api/sim/state') {
    const body = await readJsonBody(req);
    if (body && typeof body === 'object' && body !== null) {
      const incomingLeaderId = typeof body.leaderId === 'string' ? body.leaderId : null;
      const staleLeader = !simState.leaderId || (Date.now() - simState.leaderHeartbeat) > SIM_LEADER_TIMEOUT_MS;
      if (simState.running && !staleLeader && incomingLeaderId !== simState.leaderId) {
        return json(res, 409, { error: 'leader mismatch', leaderId: simState.leaderId });
      }
      if (incomingLeaderId) {
        simState.leaderId = incomingLeaderId;
        simState.leaderHeartbeat = Date.now();
      }
      if (body.snapshot && typeof body.snapshot === 'object') {
        simState.snapshot = body.snapshot;
      }
      simState.updatedAt = Date.now();
      await persistSim();
    }
    return json(res, 200, { ok: true, updatedAt: simState.updatedAt });
  }

  if (req.method === 'POST' && url.pathname === '/api/sim/claim') {
    const body = await readJsonBody(req);
    const leaderId = typeof body?.leaderId === 'string' ? body.leaderId : null;
    if (!leaderId) return json(res, 400, { error: 'leaderId required' });
    const stale = !simState.leaderId || (Date.now() - simState.leaderHeartbeat) > SIM_LEADER_TIMEOUT_MS;
    if (stale) {
      simState.leaderId = leaderId;
      simState.leaderHeartbeat = Date.now();
      await persistSim();
      return json(res, 200, { claimed: true, leaderId });
    }
    return json(res, 200, { claimed: false, leaderId: simState.leaderId });
  }

  if (req.method === 'POST' && url.pathname === '/api/sim/start') {
    simState.running = true;
    await persistSim();
    return json(res, 200, simState);
  }

  if (req.method === 'POST' && url.pathname === '/api/sim/stop') {
    simState.running = false;
    await persistSim();
    return json(res, 200, simState);
  }

  if (req.method === 'POST' && url.pathname === '/api/sim/reset') {
    simState.running = false;
    simEngine.reset(simState.config);
    simState.snapshot = simEngine.getSnapshot();
    simState.leaderId = null;
    simState.leaderHeartbeat = 0;
    simState.updatedAt = Date.now();
    simState.epoch = (simState.epoch || 0) + 1;
    await persistSim();
    return json(res, 200, simState);
  }

  if (req.method === 'POST' && url.pathname === '/api/sim/config') {
    const body = await readJsonBody(req);
    if (body && typeof body.config === 'object' && body.config !== null) {
      const wasReset = applySimConfigPatch(simState, DEFAULT_SIM_CONFIG, body.config as Record<string, unknown>, simEngine);
      if (wasReset) {
        simState.leaderId = null;
        simState.leaderHeartbeat = 0;
        simState.updatedAt = Date.now();
        simState.epoch = (simState.epoch || 0) + 1;
      }
    }
    await persistSim();
    return json(res, 200, simState);
  }

  if (req.method === 'GET' && url.pathname === '/api/pro-sim/state') {
    return json(res, 200, proSimState);
  }

  if (req.method === 'POST' && url.pathname === '/api/pro-sim/start') {
    proSimState.running = true;
    await persistProSim();
    return json(res, 200, proSimState);
  }

  if (req.method === 'POST' && url.pathname === '/api/pro-sim/stop') {
    proSimState.running = false;
    await persistProSim();
    return json(res, 200, proSimState);
  }

  if (req.method === 'POST' && url.pathname === '/api/pro-sim/reset') {
    proSimState.running = false;
    proSimEngine.reset(proSimState.config);
    proSimState.snapshot = proSimEngine.getSnapshot();
    proSimState.updatedAt = Date.now();
    await persistProSim();
    return json(res, 200, proSimState);
  }

  if (req.method === 'POST' && url.pathname === '/api/pro-sim/config') {
    const body = await readJsonBody(req);
    if (body && typeof body.config === 'object' && body.config !== null) {
      if (applySimConfigPatch(proSimState, DEFAULT_PRO_SIM_CONFIG, body.config as Record<string, unknown>, proSimEngine)) {
        proSimState.updatedAt = Date.now();
      }
    }
    await persistProSim();
    return json(res, 200, proSimState);
  }

  // ── 4H Path sim endpoints ─────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/path-sim/state') {
    return json(res, 200, pathSimState);
  }

  // Table telemetry: an empty table and a quiet market both produce no trades,
  // and they are not the same situation.
  // Publishing a table CHANGES WHAT THE BOT TRADES, so unlike the rest of the
  // path-sim namespace this one is not UI-facing and stays behind the token.
  // scripts/pathStudy.ts publish is the intended caller.
  if (req.method === 'POST' && url.pathname === '/api/path-sim/table') {
    if (!authorized(req)) return json(res, 401, { error: 'Unauthorized' });
    const body = await readJsonBody(req);
    if (!body || !Array.isArray((body as { table?: unknown }).table)) {
      return json(res, 400, { error: 'expected { table: PathBucket[] , … }' });
    }
    const serialised = JSON.stringify(body);
    // Firestore caps a document at 1MiB. Refuse loudly rather than write a
    // document that silently fails to save.
    if (serialised.length > 900_000) {
      return json(res, 413, { error: `table too large (${serialised.length} bytes; cap ~900KB)` });
    }
    await pathTableStore.set('table', serialised);
    const installed = installValidatedTable(body as Parameters<typeof installValidatedTable>[0]);
    return json(res, 200, { ok: installed, buckets: (body as { table: unknown[] }).table.length });
  }

  if (req.method === 'GET' && url.pathname === '/api/path-sim/table') {
    return json(res, 200, getPathTableStatus());
  }

  if (req.method === 'POST' && url.pathname === '/api/path-sim/start') {
    pathSimState.running = true;
    await persistPathSim();
    return json(res, 200, pathSimState);
  }

  if (req.method === 'POST' && url.pathname === '/api/path-sim/stop') {
    pathSimState.running = false;
    await persistPathSim();
    return json(res, 200, pathSimState);
  }

  if (req.method === 'POST' && url.pathname === '/api/path-sim/reset') {
    pathSimState.running = false;
    pathSimEngine.reset(pathSimState.config);
    pathSimState.snapshot = pathSimEngine.getSnapshot();
    pathSimState.updatedAt = Date.now();
    await persistPathSim();
    return json(res, 200, pathSimState);
  }

  if (req.method === 'POST' && url.pathname === '/api/path-sim/config') {
    const body = await readJsonBody(req);
    if (body && typeof body.config === 'object' && body.config !== null) {
      if (applySimConfigPatch(pathSimState, DEFAULT_PATH_SIM_CONFIG, body.config as Record<string, unknown>, pathSimEngine)) {
        pathSimState.updatedAt = Date.now();
      }
    }
    await persistPathSim();
    return json(res, 200, pathSimState);
  }

  return json(res, 404, { error: 'Not found' });
}).listen(port, async () => {
  // On a free-tier host the local disk is wiped on every restart/spin-down —
  // without Firestore, bot state (positions, cash, trades) silently resets
  // to defaults on every one of those, which reads as "the bots keep
  // restarting themselves" with no error anywhere. Say so loudly, once, at
  // boot, instead of leaving it to be rediscovered the hard way.
  if (!isDurableStorageConfigured()) {
    console.warn('[kv] FIREBASE_PROJECT_ID / FIREBASE_SERVICE_ACCOUNT_KEY not configured — bot state is NOT durable. It will reset to defaults on every restart or free-tier spin-down. Set both in the Render dashboard to persist across restarts.');
  }
  await refreshUniverseIfStale();
  await hydrate();
  await hydrateMarketCache();
  await hydrateSim();
  if (simState.snapshot) simEngine.hydrate(simState.snapshot as SimSnapshot);
  await hydrateProSim();
  if (proSimState.snapshot) proSimEngine.hydrate(proSimState.snapshot as ProSimSnapshot);
  await hydratePathSim();
  await hydratePathTable();
  if (pathSimState.snapshot) pathSimEngine.hydrate(pathSimState.snapshot as PathSimSnapshot);
  console.log('[cors] allowed origins: [' + allowedOrigins.join(', ') + ']' + (allowedOrigins.length === 0 ? ' (wildcard)' : ''));
  console.log(`Trading worker listening on ${port} | mode=${testnet ? 'testnet' : 'live'} | dryRun=${dryRun} | symbols=${symbols.length} | risk=${riskLevel} | cors=${allowedOrigins.join(',') || '*'}`);
  if (state.running) void scan();
  setInterval(() => void scan(), intervalMs);
  setInterval(() => void refreshUniverseIfStale(), UNIVERSE_CHECK_INTERVAL_MS);

  setInterval(pruneRateBuckets, RATE_LIMIT_WINDOW_MS);

  // Render free web services spin down after 15 minutes with NO inbound HTTP
  // traffic (https://render.com/docs/free — "goes 15 minutes without
  // receiving any inbound traffic"). A self-ping only resets that clock if it
  // actually reaches Render's public edge as a real inbound request — i.e.
  // RENDER_EXTERNAL_URL must be set. Render auto-populates that var for
  // `type: web` services, but if it's ever missing this used to fall back to
  // http://127.0.0.1, a purely in-process loopback call that never leaves the
  // dyno and therefore does NOTHING to prevent spin-down while looking
  // identical to a healthy ping in the logs. Fail loudly instead so a missing
  // env var is visible, not a silent no-op.
  // Interval tightened from 12 to 8 minutes: 12 left under 4 minutes of
  // margin against the 15-minute threshold, which one slow/failed ping cycle
  // can eat entirely.
  const SELF_PING_INTERVAL_MS = 8 * 60 * 1000;
  const renderExternalUrl = (process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
  const selfBase = renderExternalUrl || `http://127.0.0.1:${port}`;
  if (!renderExternalUrl) {
    console.warn('[self-ping] RENDER_EXTERNAL_URL is not set — pinging loopback only, which does NOT reach Render\'s edge and will NOT prevent free-tier spin-down. Set RENDER_EXTERNAL_URL (Render sets this automatically for web services) or the service will still sleep after 15 min of real inactivity.');
  }
  setInterval(async () => {
    try {
      const r = await fetchWithTimeout(`${selfBase}/health`, { method: 'GET' });
      if (!r.ok) console.warn(`[self-ping] /health responded ${r.status}`);
    } catch (e: unknown) {
      console.warn('[self-ping] failed:', e instanceof Error ? e.message : String(e));
    }
  }, SELF_PING_INTERVAL_MS);

  // Each sim engine still TICKS every 4s (evaluation + mark-to-market + order
  // fills need that cadence to stay responsive), but the snapshot it produces
  // was previously PERSISTED (Firestore PATCH + local-file read-modify-write)
  // on every single one of those ticks regardless of whether anything
  // meaningful changed — ~900 writes/hour per engine, x3 engines. Persistence
  // is now throttled to once per SIM_PERSIST_INTERVAL_MS; the in-memory
  // snapshot (served by /api/*/state) still updates every tick. A forced,
  // unthrottled flush still happens on start/stop/reset/config (those already
  // call persistX() directly at their own call sites) and on shutdown below,
  // so at most SIM_PERSIST_INTERVAL_MS of history is at risk on a hard crash.
  const SIM_PERSIST_INTERVAL_MS = 30_000;

  // Fear & Greed is one number for the whole market, so the four bots share one
  // fetch rather than pulling it four times a minute between them.
  let cachedSimFearGreed = 50;
  let lastFgFetchAt = 0;
  async function currentFearGreed(now: number): Promise<number> {
    if (now - lastFgFetchAt > 15 * 60 * 1000) {
      cachedSimFearGreed = await fetchFearGreed();
      lastFgFetchAt = now;
    }
    return cachedSimFearGreed;
  }

  /**
   * One ticker, driven by the registry.
   *
   * This replaced four near-identical 25-line loops that differed only in which
   * state object, engine and persist function they named. Four copies of a loop
   * is four places to fix a bug in it, and — as the auth guard's exempt list
   * showed — one place to forget a bot entirely.
   *
   * The 4s interval is the engine's own cadence: pending orders have an
   * execution delay measured in seconds and need that responsiveness. Persisting
   * on every tick was ~900 writes/hour per engine, so writes are throttled to
   * SIM_PERSIST_INTERVAL_MS while the in-memory snapshot (what /state serves)
   * still updates every tick. start/stop/reset/config force an unthrottled
   * flush at their own call sites, and so does shutdown, so a hard crash risks
   * at most one interval of history.
   */
  function startSimTicker(
    id: SimBotId,
    state: { running: boolean; config: SimBotConfig; snapshot: unknown | null; updatedAt: number },
    engine: { tick: (config: SimBotConfig, fearGreed: number) => Promise<unknown> },
    persist: () => Promise<void>
  ): void {
    const logPrefix = `[${SIM_BOTS[id].storeKey.replace('-state', '')}-engine]`;
    let tickInProgress = false;
    let lastPersistAt = 0;

    setInterval(async () => {
      if (!state.running || tickInProgress) return;
      tickInProgress = true;
      try {
        const now = Date.now();
        const snap = await engine.tick(state.config, await currentFearGreed(now));
        state.snapshot = snap;
        state.updatedAt = Date.now();
        if (now - lastPersistAt >= SIM_PERSIST_INTERVAL_MS) {
          await persist();
          lastPersistAt = now;
        }
      } catch (e: unknown) {
        console.warn(`${logPrefix} tick failed:`, e instanceof Error ? e.message : String(e));
      } finally {
        tickInProgress = false;
      }
    }, 4000);
  }

  startSimTicker('intraday', simState, simEngine, persistSim);
  startSimTicker('pro', proSimState, proSimEngine, persistProSim);
  startSimTicker('path', pathSimState, pathSimEngine, persistPathSim);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[shutdown] ${signal} — flushing state and warm cache`);
  try { await store.set('state', serializeState()); } catch { /* ignore */ }
  try { await persistPathSim(); } catch { /* ignore */ }
  lastCachePersistAt = 0;
  try { await persistMarketCache(); } catch { /* ignore */ }
  // Force-flush the throttled sim snapshots too — otherwise up to
  // SIM_PERSIST_INTERVAL_MS of in-memory-only history is lost on restart.
  try { await persistSim(); } catch { /* ignore */ }
  try { await persistProSim(); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

