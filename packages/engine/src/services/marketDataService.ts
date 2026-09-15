/**
 * MarketDataService — Multi-Timeframe OHLCV pipeline (1H / 15M / 5M)
 * ============================================================================
 * Priority (§3):   Bybit Klines  →  Binance Klines  →  SKIP ASSET
 * CoinGecko is NEVER used as an intraday OHLCV source. It stays an analytic
 * fallback only, guarded by the asset mapping (§4/§57).
 *
 * Guarantees:
 *  - Every timeframe is fetched SEPARATELY with its own candle budget (§2).
 *  - Pagination is used when the requested history exceeds the API page size.
 *  - Candles are validated, de-duplicated and sorted oldest → newest (§5).
 *  - The currently FORMING candle is dropped: signals use closed candles (§7/§41).
 *  - A missing timeframe yields status = NOT_READY (never a silent "HOLD") (§5).
 *  - Telemetry: `[market-data] symbol=BTCUSDT 1h=200 15m=300 5m=500` (§56).
 */

import { Candle } from './tradeEngine';
import { toBybitSymbol, toBaseAsset } from './assetUniverse';
import type { FundingSnapshot } from './fundingRate';
import type { DerivativesSnapshot, OpenInterestPoint, LongShortPoint } from './derivativesRegime';

// ── Endpoints ────────────────────────────────────────────────────────────────
const BYBIT_PUBLIC_BASE = 'https://api.bybit.com';
const BINANCE_PUBLIC_BASE = 'https://api.binance.com/api/v3';

const universeFetchCache = new Map<string, Promise<{ snapshots: Map<string, MultiTimeframeSnapshot>; stats: MarketDataStats }>>();

export type TimeframeKey = '1h' | '15m' | '5m';
export type CandleSource = 'bybit' | 'binance' | 'cache' | 'none';

export interface TimeframeSpec {
  key: TimeframeKey;
  /** Bybit v5 interval code */
  bybit: string;
  /** Binance interval code */
  binance: string;
  /** Candle duration in ms */
  ms: number;
  /** Hard minimum required to evaluate the asset */
  minCandles: number;
  /** Desired history depth */
  targetCandles: number;
  /** How often live data is refreshed for this timeframe (§7) */
  refreshMs: number;
}

export const TIMEFRAME_SPECS: Record<TimeframeKey, TimeframeSpec> = {
  // 1h targetCandles covers the MOST DEMANDING consumer, not the average one.
  // The Path bot needs 62 closed 4H bars = 248 H1 candles (MIN_PATH_CANDLES);
  // at 240 it was short by two bars on every cold start and skipped every
  // symbol, producing an empty table that looked exactly like a strategy which
  // had found nothing. Still one Bybit page, so the extra depth is free.
  '1h': { key: '1h', bybit: '60', binance: '1h', ms: 3_600_000, minCandles: 200, targetCandles: 260, refreshMs: 5 * 60_000 },
  '15m': { key: '15m', bybit: '15', binance: '15m', ms: 900_000, minCandles: 300, targetCandles: 320, refreshMs: 90_000 },
  '5m': { key: '5m', bybit: '5', binance: '5m', ms: 300_000, minCandles: 500, targetCandles: 520, refreshMs: 45_000 }
};

export const TIMEFRAME_ORDER: TimeframeKey[] = ['1h', '15m', '5m'];

// ── Delta-fetch / warm-cache rules ─────────────────────────────────────────────
/** A cached timeframe older than this is treated as cold and fully refetched. */
const MAX_CACHE_AGE_MS = 6 * 60 * 60 * 1000; // 6h
/** Over-fetch a few extra candles on a delta request to absorb clock/source skew. */
const DELTA_BUFFER = 4;
/** Max candles retained per (symbol,tf) after a delta merge. */
const MAX_CANDLES_PER_TF = 600;
/**
 * How often a below-target cache may force a full backfill.
 *
 * Guards the self-heal below against hammering: a symbol listed three weeks ago
 * has fewer than targetCandles 1h bars in existence, so it can never reach the
 * target no matter how often we refetch. It gets one full window per 6h and
 * serves its short-but-valid series in between.
 */
const BACKFILL_RETRY_MS = 6 * 60 * 60 * 1000;

// ── Validation ───────────────────────────────────────────────────────────────

export interface CandleValidationResult {
  ok: boolean;
  cleaned: Candle[];
  reason?: string;
  issues: string[];
  dropped: number;
}

/**
 * Validates and normalizes a candle array:
 *   timestamp finite & positive, OHLC finite & positive, high >= low,
 *   volume finite & >= 0, no NaN, sorted ascending, duplicates removed.
 */
export function validateCandles(candles: Candle[] | undefined | null, minCandles: number): CandleValidationResult {
  const issues: string[] = [];
  if (!candles || !candles.length) {
    return { ok: false, cleaned: [], reason: 'NO_DATA', issues: ['empty candle array'], dropped: 0 };
  }

  const seen = new Set<number>();
  const cleaned: Candle[] = [];
  let dropped = 0;

  for (const c of candles) {
    const valid =
      c &&
      Number.isFinite(c.timestamp) && c.timestamp > 0 &&
      Number.isFinite(c.open) && c.open > 0 &&
      Number.isFinite(c.high) && c.high > 0 &&
      Number.isFinite(c.low) && c.low > 0 &&
      Number.isFinite(c.close) && c.close > 0 &&
      Number.isFinite(c.volume) && c.volume >= 0 &&
      c.high >= c.low &&
      c.high >= Math.max(c.open, c.close) - Math.abs(c.high) * 1e-9 &&
      c.low <= Math.min(c.open, c.close) + Math.abs(c.low) * 1e-9;

    if (!valid) {
      dropped++;
      continue;
    }
    if (seen.has(c.timestamp)) {
      dropped++;
      continue;
    }
    seen.add(c.timestamp);
    cleaned.push({
      timestamp: c.timestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume
    });
  }

  cleaned.sort((a, b) => a.timestamp - b.timestamp);

  if (dropped > 0) issues.push(`${dropped} invalid/duplicate candles dropped`);
  if (cleaned.length < minCandles) {
    return {
      ok: false,
      cleaned,
      reason: 'INSUFFICIENT_CANDLES',
      issues: [...issues, `${cleaned.length} < required ${minCandles}`],
      dropped
    };
  }

  return { ok: true, cleaned, issues, dropped };
}

/**
 * Removes the candle that is still forming so signals only ever see closed data.
 * A candle opened at T closes at T + tfMs; it is closed only when now >= T + tfMs.
 */
export function dropFormingCandle(candles: Candle[], tfMs: number, now = Date.now()): Candle[] {
  if (!candles.length) return candles;
  const out = [...candles];
  while (out.length && out[out.length - 1].timestamp + tfMs > now) {
    out.pop();
  }
  return out;
}

/** True when the last candle timestamp is aligned to the timeframe grid */
export function isAlignedToTimeframe(candles: Candle[], tfMs: number): boolean {
  if (!candles.length) return true;
  return candles[candles.length - 1].timestamp % tfMs === 0;
}

// ── HTTP helper ──────────────────────────────────────────────────────────────

async function timedFetch(url: string, timeoutMs = 10_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Binance symbol registry ──────────────────────────────────────────────────
// Binance omits CORS headers on 4xx responses, so asking it for a pair it does
// not list reaches the browser as an opaque "blocked by CORS policy" plus
// net::ERR_FAILED — never as the 400 {"code":-1121,"msg":"Invalid symbol."} it
// actually sent. The universe comes from Bybit, which lists pairs Binance does
// not (CAP, H, …), so every scan produced console errors for those symbols, and
// because `fetch` REJECTS rather than returning a response the message was
// "Failed to fetch", which matches none of the SYMBOL_NOT_FOUND patterns below
// — so each one was also retried once, for nothing.
//
// /ticker/price names every pair Binance actually trades in one 153KB call.
const BINANCE_SYMBOLS_TTL_MS = 6 * 60 * 60 * 1000;
let binanceSymbolsPromise: Promise<Set<string> | null> | null = null;
let binanceSymbolsFetchedAt = 0;

async function fetchBinanceSymbols(): Promise<Set<string> | null> {
  try {
    const res = await timedFetch(`${BINANCE_PUBLIC_BASE}/ticker/price`);
    if (!res.ok) return null;
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows) || !rows.length) return null;
    const symbols = rows
      .map((r) => (r && typeof (r as { symbol?: unknown }).symbol === 'string' ? (r as { symbol: string }).symbol : null))
      .filter((s): s is string => !!s);
    // A payload carrying no symbol strings is not the registry — a proxy, an
    // error page or a stubbed endpoint can return anything. Report it as
    // unavailable rather than building a Set that would wrongly rule out every
    // symbol on the exchange.
    return symbols.length ? new Set(symbols) : null;
  } catch {
    return null;
  }
}

// ── Perpetual funding rates ────────────────────────────────────────────────
// One call to Binance's USD-M futures endpoint returns every perpetual's
// current funding rate, so this is a single request for the whole universe
// rather than one per symbol. Public, unauthenticated, free.
//
// Funding settles every 8h; a 30-minute cache is far tighter than the data
// actually moves and keeps the request count negligible.
const BINANCE_FUTURES_BASE = 'https://fapi.binance.com/fapi/v1';
const FUNDING_TTL_MS = 30 * 60 * 1000;
let fundingPromise: Promise<Map<string, FundingSnapshot> | null> | null = null;
let fundingFetchedAt = 0;

async function fetchFundingFromBinance(): Promise<Map<string, FundingSnapshot> | null> {
  try {
    const res = await timedFetch(`${BINANCE_FUTURES_BASE}/premiumIndex`);
    if (!res.ok) return null;
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows) || !rows.length) return null;
    const out = new Map<string, FundingSnapshot>();
    const at = Date.now();
    for (const r of rows) {
      const row = r as { symbol?: unknown; lastFundingRate?: unknown };
      if (typeof row.symbol !== 'string') continue;
      const rate = Number(row.lastFundingRate);
      if (!Number.isFinite(rate)) continue;
      out.set(row.symbol.toUpperCase(), { lastFundingRate: rate, at });
    }
    return out.size ? out : null;
  } catch {
    return null;
  }
}

/**
 * Current perpetual funding rates, keyed by Binance futures pair (e.g. "BTCUSDT").
 *
 * Returns an EMPTY map when the feed is unavailable, never throws and never
 * caches a failure: the funding gate abstains on missing data, so an outage
 * must degrade to "no opinion", not to a stalled bot. Callers should treat a
 * missing key exactly the same way.
 */
export async function fetchFundingRates(): Promise<Map<string, FundingSnapshot>> {
  const fresh = fundingPromise !== null && Date.now() - fundingFetchedAt <= FUNDING_TTL_MS;
  if (!fresh) {
    fundingFetchedAt = Date.now();
    fundingPromise = fetchFundingFromBinance();
  }
  const rates = await fundingPromise;
  if (rates === null) {
    // Do not let one transient error suppress the feed for a whole TTL.
    fundingPromise = null;
    return new Map();
  }
  return rates;
}

/** Test seam — drops the cached funding response. */
export function clearFundingCache(): void {
  fundingPromise = null;
  fundingFetchedAt = 0;
}

// ── Derivatives snapshot: Open Interest + Long/Short ratio ──────────────────
// Bybit's own free public endpoints (2026-09-16, operator request — the
// "Bybit Native Derivatives Layer" of the Macro Layer). Unlike funding
// (fetchFundingRates above), Bybit has no bulk "every symbol" variant for
// these two, so each is one request PER SYMBOL — batched with limited
// concurrency, the same pattern getUniverseMarketData already uses for MTF
// candles, so a curated ~60-symbol universe stays cheap and a 400+-symbol one
// would not (see the rate-limit warning on that function).
const BYBIT_DERIVATIVES_TTL_MS = 15 * 60 * 1000; // OI/L-S move slowly; no need to hammer
const derivativesCache = new Map<string, { snapshot: DerivativesSnapshot; fetchedAt: number }>();

async function fetchOpenInterestForSymbol(bybitSymbol: string): Promise<OpenInterestPoint[]> {
  try {
    const res = await timedFetch(
      `${BYBIT_PUBLIC_BASE}/v5/market/open-interest?category=linear&symbol=${bybitSymbol}&intervalTime=1h&limit=6`
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      retCode?: number;
      result?: { list?: { openInterest?: string; timestamp?: string }[] };
    };
    if (data.retCode !== 0 || !data.result?.list) return [];
    return data.result.list
      .map((row) => ({ openInterest: Number(row.openInterest), timestamp: Number(row.timestamp) }))
      .filter((p) => Number.isFinite(p.openInterest) && Number.isFinite(p.timestamp));
  } catch {
    return [];
  }
}

async function fetchLongShortForSymbol(bybitSymbol: string): Promise<LongShortPoint | undefined> {
  try {
    const res = await timedFetch(
      `${BYBIT_PUBLIC_BASE}/v5/market/account-ratio?category=linear&symbol=${bybitSymbol}&period=1h&limit=1`
    );
    if (!res.ok) return undefined;
    const data = (await res.json()) as {
      retCode?: number;
      result?: { list?: { buyRatio?: string; sellRatio?: string; timestamp?: string }[] };
    };
    const row = data.retCode === 0 ? data.result?.list?.[0] : undefined;
    if (!row) return undefined;
    const buyRatio = Number(row.buyRatio);
    const sellRatio = Number(row.sellRatio);
    const timestamp = Number(row.timestamp);
    if (!Number.isFinite(buyRatio) || !Number.isFinite(timestamp)) return undefined;
    return { buyRatio, sellRatio: Number.isFinite(sellRatio) ? sellRatio : 1 - buyRatio, timestamp };
  } catch {
    return undefined;
  }
}

// ── Spot + cross-exchange relative volume — the OTC blind-spot fix ──────────
// (2026-09-16, two rounds). getMultiTimeframeData defaults to LINEAR candles
// (primaryCategory in fetchTimeframe), so the H1 series the sell-pressure
// check already has is derivatives-venue volume, not spot. A dump that never
// touches the derivatives book (OTC, exchange-to-exchange) can still show up
// as unusual volume once it actually hits an open market — SPOT (first
// round) or a DEEPER exchange (second round, below).
const RELVOL_LOOKBACK = 20;

function relativeVolumeFromSeries(volumesOldestFirst: number[], lookback: number = RELVOL_LOOKBACK): number | undefined {
  if (volumesOldestFirst.length < lookback + 1) return undefined;
  const last = volumesOldestFirst[volumesOldestFirst.length - 1];
  const history = volumesOldestFirst.slice(-(lookback + 1), -1);
  const avg = history.reduce((s, v) => s + v, 0) / history.length;
  if (!(avg > 0)) return undefined;
  return last / avg;
}

async function fetchSpotRelativeVolumeForSymbol(bybitSymbol: string): Promise<number | undefined> {
  try {
    const res = await timedFetch(
      `${BYBIT_PUBLIC_BASE}/v5/market/kline?category=spot&symbol=${bybitSymbol}&interval=60&limit=${RELVOL_LOOKBACK + 1}`
    );
    if (!res.ok) return undefined;
    const data = (await res.json()) as { retCode?: number; result?: { list?: string[][] } };
    if (data.retCode !== 0 || !data.result?.list) return undefined;
    // Bybit returns newest-first; oldest-to-newest for a plain windowed average.
    const volumes = data.result.list.slice().reverse().map((row) => Number(row[5])).filter(Number.isFinite);
    return relativeVolumeFromSeries(volumes);
  } catch {
    return undefined;
  }
}

// Cross-exchange leg (2026-09-16, second round). Measured live across our own
// traded universe (61 symbols): Binance's spot book runs 2-8x deeper than
// Bybit's on every symbol checked, including LA specifically (7.6x) — one of
// the two symbols in the 2026-09-15 incident this whole Macro Layer answers.
// A large seller routes through the deeper venue first; on a THIN Bybit
// symbol, Bybit's own volume signal (spot or linear) can be too noisy (small
// base) to clearly show a real move that Binance's cleaner, deeper book
// already reflects. 50/61 of this repo's traded universe is listed on
// Binance — the other 11 (newer/smaller listings) simply abstain here, same
// as any other missing-data case.
async function fetchBinanceRelativeVolumeForSymbol(bybitSymbol: string): Promise<number | undefined> {
  try {
    const res = await timedFetch(
      `${BINANCE_PUBLIC_BASE}/klines?symbol=${bybitSymbol}&interval=1h&limit=${RELVOL_LOOKBACK + 1}`
    );
    if (!res.ok) return undefined; // includes "not listed on Binance" (400) — abstain, don't throw
    const rows = (await res.json()) as unknown[][];
    if (!Array.isArray(rows) || !rows.length) return undefined;
    // Binance returns oldest-first already, unlike Bybit.
    const volumes = rows.map((row) => Number(row[5])).filter(Number.isFinite);
    return relativeVolumeFromSeries(volumes);
  } catch {
    return undefined;
  }
}

/**
 * Open Interest history + Long/Short ratio + spot relative volume + Binance
 * cross-exchange relative volume for every symbol in `symbols`, batched at
 * limited concurrency (four requests per symbol: linear OI, linear
 * account-ratio, Bybit spot kline, Binance kline). A symbol missing any one
 * of the four (no linear perpetual, delisted, not listed on the other
 * exchange, etc.) returns a partial snapshot rather than throwing — every
 * consumer (derivativesRegime.ts) already treats missing data as "abstain,
 * never block", matching the funding gate's own rule.
 *
 * Per-symbol 15-minute cache: a symbol re-requested inside the TTL is served
 * from cache with no network call, so calling this every tick (like
 * fetchFundingRates) costs nothing extra once warm.
 */
export async function fetchDerivativesSnapshots(
  symbols: string[],
  opts: { concurrency?: number } = {}
): Promise<Map<string, DerivativesSnapshot>> {
  const out = new Map<string, DerivativesSnapshot>();
  const now = Date.now();
  const toFetch: string[] = [];

  for (const raw of symbols) {
    const sym = toBybitSymbol(raw);
    if (!sym) continue;
    const cached = derivativesCache.get(sym);
    if (cached && now - cached.fetchedAt < BYBIT_DERIVATIVES_TTL_MS) {
      out.set(sym, cached.snapshot);
    } else {
      toFetch.push(sym);
    }
  }

  const concurrency = opts.concurrency ?? 4;
  for (let i = 0; i < toFetch.length; i += concurrency) {
    const batch = toFetch.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (sym) => {
        const [openInterestHistory, longShort, spotRelativeVolume, crossExchangeRelativeVolume] = await Promise.all([
          fetchOpenInterestForSymbol(sym),
          fetchLongShortForSymbol(sym),
          fetchSpotRelativeVolumeForSymbol(sym),
          fetchBinanceRelativeVolumeForSymbol(sym)
        ]);
        const snapshot: DerivativesSnapshot = {
          symbol: sym,
          openInterestHistory,
          longShort,
          spotRelativeVolume,
          crossExchangeRelativeVolume,
          fetchedAt: Date.now()
        };
        return { sym, snapshot };
      })
    );
    for (const { sym, snapshot } of results) {
      derivativesCache.set(sym, { snapshot, fetchedAt: Date.now() });
      out.set(sym, snapshot);
    }
  }

  return out;
}

/** Test seam — drops the cached derivatives snapshots. */
export function clearDerivativesCache(): void {
  derivativesCache.clear();
}

async function binanceListsSymbol(pair: string): Promise<boolean> {
  const fresh = binanceSymbolsPromise !== null && Date.now() - binanceSymbolsFetchedAt <= BINANCE_SYMBOLS_TTL_MS;
  if (!fresh) {
    binanceSymbolsFetchedAt = Date.now();
    binanceSymbolsPromise = fetchBinanceSymbols();
  }
  const known = await binanceSymbolsPromise;
  if (known === null) {
    // Fail OPEN, and do not cache the failure: one transient error must not
    // disable the guard for the whole TTL. A symbol is ruled out only when the
    // registry was actually read and does not contain it.
    binanceSymbolsPromise = null;
    return true;
  }
  return known.has(pair);
}

/** True when Binance is known NOT to list this pair (registry consulted, symbol absent). */
export async function isBinanceUnlistedSymbol(pair: string): Promise<boolean> {
  return !(await binanceListsSymbol(pair));
}

// ── Bybit klines (primary, paginated) ────────────────────────────────────────

const BYBIT_PAGE_LIMIT = 1000;

interface BybitKlineResponse {
  retCode: number;
  retMsg?: string;
  result?: { list?: string[][] };
}

/**
 * Fetches `limit` klines for one timeframe from Bybit, paginating backwards when
 * `limit` exceeds the API page size. Returns candles oldest → newest.
 */
export async function fetchBybitKlines(
  symbol: string,
  tf: TimeframeKey,
  limit: number,
  opts: { endTime?: number; startTime?: number; category?: 'spot' | 'linear' } = {}
): Promise<Candle[]> {
  const spec = TIMEFRAME_SPECS[tf];
  const bybitSymbol = toBybitSymbol(symbol);
  // The universe holds a mix: most coins have a LINEAR (perpetual) market, but
  // every coin is guaranteed to have a SPOT listing (that's a hard requirement
  // of universe inclusion — see symbolUniverse.ts). Neither category alone
  // covers every symbol, so a fixed default always strands some subset of
  // coins on Bybit rc10001 ("Symbol Is Invalid") and forces a 100% Binance
  // fallback that then ALSO fails for any coin Binance doesn't list at all
  // (e.g. KIIUSDT — Bybit-only, no futures market). Try the requested/default
  // category first, and on rc10001 specifically, retry once with the other
  // category before giving up — this covers spot-only and linear-only coins
  // without picking a single global default that strands the other group.
  const primaryCategory = opts.category || 'linear';
  const altCategory: 'spot' | 'linear' = primaryCategory === 'linear' ? 'spot' : 'linear';

  const fetchWithCategory = async (category: 'spot' | 'linear'): Promise<Candle[]> => {
    const collected: Candle[] = [];
    let end = opts.endTime;
    let guard = 0;

    while (collected.length < limit && guard < 40) {
      guard++;
      const page = Math.min(BYBIT_PAGE_LIMIT, limit - collected.length);
      const params = new URLSearchParams({
        category,
        symbol: bybitSymbol,
        interval: spec.bybit,
        limit: String(page)
      });
      if (end !== undefined) params.set('end', String(end));
      if (opts.startTime !== undefined) params.set('start', String(opts.startTime));

      const res = await timedFetch(`${BYBIT_PUBLIC_BASE}/v5/market/kline?${params.toString()}`);
      if (!res.ok) throw new Error(`Bybit kline HTTP ${res.status}`);
      const data = (await res.json()) as BybitKlineResponse;
      if (data.retCode !== 0) {
        const err = new Error(`Bybit retCode ${data.retCode} ${data.retMsg || ''}`);
        (err as Error & { retCode?: number }).retCode = data.retCode;
        throw err;
      }
      const list = data.result?.list;
      if (!list || !list.length) break;

      // Bybit returns newest → oldest
      const chunk: Candle[] = list.map((row) => ({
        timestamp: Number(row[0]),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5])
      }));

      collected.push(...chunk);

      const oldest = Math.min(...chunk.map((c) => c.timestamp));
      if (!Number.isFinite(oldest)) break;
      end = oldest - 1;
      if (chunk.length < page) break; // no more history available
    }

    collected.sort((a, b) => a.timestamp - b.timestamp);
    return collected;
  };

  try {
    return await fetchWithCategory(primaryCategory);
  } catch (e) {
    const retCode = (e as Error & { retCode?: number }).retCode;
    if (retCode === 10001) {
      return fetchWithCategory(altCategory);
    }
    throw e;
  }
}

// ── Binance klines (fallback) ────────────────────────────────────────────────

const BINANCE_PAGE_LIMIT = 1000;

export async function fetchBinanceKlines(
  symbol: string,
  tf: TimeframeKey,
  limit: number,
  opts: { endTime?: number; startTime?: number } = {}
): Promise<Candle[]> {
  const spec = TIMEFRAME_SPECS[tf];
  const pair = toBybitSymbol(symbol); // same USDT pair naming on Binance

  // Phrased to match the SYMBOL_NOT_FOUND classifier in fetchTimeframe, so an
  // unlisted pair is reported as what it is and is never retried.
  if (!(await binanceListsSymbol(pair))) {
    throw new Error(`Invalid symbol ${pair} — not listed on Binance`);
  }

  const collected: Candle[] = [];
  let endTime = opts.endTime;
  let guard = 0;

  while (collected.length < limit && guard < 40) {
    guard++;
    const page = Math.min(BINANCE_PAGE_LIMIT, limit - collected.length);
    const params = new URLSearchParams({ symbol: pair, interval: spec.binance, limit: String(page) });
    if (endTime !== undefined) params.set('endTime', String(endTime));
    if (opts.startTime !== undefined) params.set('startTime', String(opts.startTime));

    const res = await timedFetch(`${BINANCE_PUBLIC_BASE}/klines?${params.toString()}`);
    if (!res.ok) throw new Error(`Binance kline HTTP ${res.status}`);
    const rows = (await res.json()) as unknown[][];
    if (!Array.isArray(rows) || !rows.length) break;

    const chunk: Candle[] = rows.map((row) => ({
      timestamp: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5])
    }));

    collected.push(...chunk);
    const oldest = Math.min(...chunk.map((c) => c.timestamp));
    if (!Number.isFinite(oldest)) break;
    endTime = oldest - 1;
    if (chunk.length < page) break;
  }

  collected.sort((a, b) => a.timestamp - b.timestamp);
  return collected;
}

export interface FetchTimeframeResult {
  candles: Candle[];
  source: CandleSource;
  reason?: string;
  issues: string[];
  /** Raw candles received from the source before trimming/validation */
  received: number;
  /** Candles remaining after dropping the forming candle */
  closed: number;
  /** Candles remaining after validation (dedupe/sort/OHLC checks) */
  valid: number;
  /** Minimum candles required for this timeframe */
  required: number;
}

/**
 * Bybit → Binance → fail. Returns validated, closed candles for one timeframe.
 *
 * The returned `reason` distinguishes a genuine INSUFFICIENT_CANDLES (data was
 * received but below the minimum) from an API failure (API_ERROR / RATE_LIMIT /
 * SYMBOL_NOT_FOUND). This prevents an outage from being mislabeled as "not
 * enough data" (§7) and lets the telemetry show the true cause (§8).
 */
export async function fetchTimeframe(
  symbol: string,
  tf: TimeframeKey,
  opts: { limit?: number; now?: number; endTime?: number; requireClosed?: boolean; category?: 'spot' | 'linear'; since?: number; minCandles?: number } = {}
): Promise<FetchTimeframeResult> {
  const spec = TIMEFRAME_SPECS[tf];
  const limit = opts.limit ?? spec.targetCandles;
  const now = opts.now ?? Date.now();
  const requireClosed = opts.requireClosed !== false;
  // `spec.minCandles` is the ENGINE's floor (500 for 5m — ~41h, enough for the
  // intraday setup detector). A caller that only wants a short window — the
  // position-card chart asks for 36-240 bars — passes `minCandles` to lower it,
  // otherwise every small request fails validation and the caller wrongly
  // concludes "5m unavailable" and falls back to daily. An explicit override is
  // clamped to [1, limit] so it can never be unsatisfiable by construction;
  // with no override the engine floor is used unchanged.
  const minCandles = opts.minCandles !== undefined
    ? Math.min(limit, Math.max(1, opts.minCandles))
    : spec.minCandles;
  const issues: string[] = [];

  // ── Delta mode: fetch ONLY candles newer than `since` ───────────────────────
  // Used by the warm cache so a running process re-pulls only what changed
  // instead of re-fetching the full window every scan (fewer calls, smaller
  // payload). The caller merges the result into the existing cache.
  if (opts.since !== undefined) {
    const since = opts.since;
    const deltaLimit = Math.min(limit, Math.ceil((now - since) / spec.ms) + DELTA_BUFFER);
    const startTs = since + spec.ms; // first candle strictly after `since`
    const errors: string[] = [];
    for (const source of ['bybit', 'binance'] as const) {
      try {
        const raw = source === 'bybit'
          ? await fetchBybitKlines(symbol, tf, deltaLimit, { endTime: opts.endTime, startTime: startTs, category: opts.category })
          : await fetchBinanceKlines(symbol, tf, deltaLimit, { endTime: opts.endTime, startTime: startTs });
        const closed = requireClosed ? dropFormingCandle(raw, spec.ms, now) : raw;
        const validation = validateCandles(closed, 1); // just clean/dedup; don't enforce min
        if (validation.cleaned.length) {
          return {
            candles: validation.cleaned,
            source,
            issues: [...issues, ...validation.issues.map((i) => `${source}:${i}`)],
            received: raw.length,
            closed: closed.length,
            valid: validation.cleaned.length,
            required: spec.minCandles
          };
        }
        // The source ANSWERED — there is simply no closed candle newer than
        // `since` yet. That is the normal case, not a failure: the bots poll
        // every few seconds while a 1h candle closes once an hour. Treating it
        // as a failure fell through to the next source on EVERY tick, which is
        // what sent every Bybit-only symbol to Binance to be refused.
        //
        // Trade-off: if the primary is briefly returning empty for a pair the
        // fallback does have, that pair now waits for the next tick instead of
        // failing over immediately. A genuinely missing symbol still throws
        // (Bybit retCode 10001) and still fails over, below.
        issues.push(`${source}:no-new-candles`);
        return {
          candles: [],
          source: 'none',
          reason: 'NO_NEW_CANDLES',
          issues,
          received: raw.length,
          closed: closed.length,
          valid: 0,
          required: spec.minCandles
        };
      } catch (e) {
        const msg = `${source}:${e instanceof Error ? e.message : String(e)}`;
        errors.push(msg);
        issues.push(msg);
      }
    }
    const allErrors = errors.join(' | ');
    let reason: string = 'NO_NEW_CANDLES';
    if (/429|too many requests|rate limit|ratelimit/i.test(allErrors)) reason = 'RATE_LIMIT';
    else if (/10001|not supported symbols|invalid symbol|symbol not/i.test(allErrors)) reason = 'SYMBOL_NOT_FOUND';
    else if (errors.length) reason = 'API_ERROR';
    return { candles: [], source: 'none', reason, issues, received: 0, closed: 0, valid: 0, required: spec.minCandles };
  }

  const attemptOnce = async (source: 'bybit' | 'binance'): Promise<Candle[]> =>
    source === 'bybit'
      ? fetchBybitKlines(symbol, tf, limit, { endTime: opts.endTime, category: opts.category })
      : fetchBinanceKlines(symbol, tf, limit, { endTime: opts.endTime });

  // One retry on transient failures (429 / network / 5xx) — a single burst of
  // concurrent requests across the universe can trip rate limits for a
  // symbol that would otherwise have full data on the very next try (§7).
  const attempt = async (source: 'bybit' | 'binance'): Promise<Candle[]> => {
    try {
      return await attemptOnce(source);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/10001|not supported symbols|invalid symbol|symbol not/i.test(msg)) throw e;
      await new Promise((r) => setTimeout(r, 400));
      return attemptOnce(source);
    }
  };

  let insufficientReason: string | null = null;
  const errors: string[] = [];
  let receivedCount = 0;
  let closedCount = 0;

  for (const source of ['bybit', 'binance'] as const) {
    try {
      const raw = await attempt(source);
      const closed = requireClosed ? dropFormingCandle(raw, spec.ms, now) : raw;
      receivedCount = raw.length;
      closedCount = closed.length;
      const validation = validateCandles(closed, minCandles);
      issues.push(...validation.issues.map((i) => `${source}:${i}`));
      if (validation.ok) {
        return {
          candles: validation.cleaned,
          source,
          issues,
          received: receivedCount,
          closed: closedCount,
          valid: validation.cleaned.length,
          required: minCandles
        };
      }
      // Source returned data but below the minimum — record the real cause.
      insufficientReason = `${source}:${validation.reason}`;
      issues.push(insufficientReason);
    } catch (e) {
      const msg = `${source}:${e instanceof Error ? e.message : String(e)}`;
      errors.push(msg);
      issues.push(msg);
    }
  }

  // Classify the real failure so it is never masked as INSUFFICIENT_CANDLES.
  // Scan ALL error messages (not just the last source) — a genuine RATE_LIMIT
  // or SYMBOL_NOT_FOUND on one source must win even when the OTHER source
  // merely came back empty (insufficientReason set); otherwise a Binance 429
  // gets silently relabeled as "not enough data" and looks unfixable (§7).
  const allErrors = errors.join(' | ');
  let reason: string;
  if (/429|too many requests|rate limit|ratelimit/i.test(allErrors)) reason = 'RATE_LIMIT';
  else if (/10001|not supported symbols|invalid symbol|symbol not/i.test(allErrors)) reason = 'SYMBOL_NOT_FOUND';
  else if (insufficientReason) reason = 'INSUFFICIENT_CANDLES';
  else if (errors.length) reason = 'API_ERROR';
  else reason = 'INSUFFICIENT_CANDLES';

  return {
    candles: [],
    source: 'none',
    reason,
    issues,
    received: receivedCount,
    closed: closedCount,
    valid: 0,
    required: minCandles
  };
}

// ── Liquidity / spread snapshot (§26/§27) ────────────────────────────────────

export interface LiquiditySnapshot {
  symbol: string;
  lastPrice: number;
  bid: number;
  ask: number;
  /** (ask-bid)/mid * 100 */
  spreadPercent: number;
  /** 24h quote turnover in USDT — LINEAR (futures) market, used for FUTURES trades */
  quoteVolume24h: number;
  /** 24h quote turnover in USDT — SPOT market, used for SPOT trades (§26) */
  quoteVolume24hSpot: number;
  source: 'bybit' | 'binance' | 'estimate';
  fetchedAt: number;
}

let liquidityCache: { at: number; map: Map<string, LiquiditySnapshot> } = { at: 0, map: new Map() };
const LIQUIDITY_TTL_MS = 15_000;
// Concurrent callers with the SAME symbol set (e.g. two overlapping full-
// universe refreshes) can both miss the TTL cache in the same window and
// each fire their own ticker fetch. Track in-flight requests keyed by the
// exact requested symbol set — this function is called both with a single
// symbol and with the full universe list, so sharing indiscriminately across
// different symbol sets would silently hand a caller wanting many symbols
// the result of a fetch that only looked for one.
const liquidityInFlight = new Map<string, Promise<Map<string, LiquiditySnapshot>>>();

interface BybitTickerRow {
  symbol: string;
  lastPrice: string;
  bid1Price?: string;
  ask1Price?: string;
  turnover24h?: string;
  volume24h?: string;
}

/**
 * One Bybit call returns every spot ticker with best bid/ask, which gives the
 * live spread AND the 24h turnover used by the liquidity filter.
 */
export async function getLiquiditySnapshots(symbols: string[], now = Date.now()): Promise<Map<string, LiquiditySnapshot>> {
  if (now - liquidityCache.at < LIQUIDITY_TTL_MS && liquidityCache.map.size) {
    return liquidityCache.map;
  }
  const key = [...symbols].sort().join(',');
  const existing = liquidityInFlight.get(key);
  if (existing) return existing;

  const promise = fetchLiquiditySnapshots(symbols, now).finally(() => {
    liquidityInFlight.delete(key);
  });
  liquidityInFlight.set(key, promise);
  return promise;
}

async function fetchLiquiditySnapshots(symbols: string[], now: number): Promise<Map<string, LiquiditySnapshot>> {
  const wanted = new Set(symbols.map((s) => toBybitSymbol(s)));
  const map = new Map<string, LiquiditySnapshot>();

  try {
    // Use LINEAR (futures) tickers to match the market the bot actually trades
    // and the klines category above; the response schema is identical to spot.
    const res = await timedFetch(`${BYBIT_PUBLIC_BASE}/v5/market/tickers?category=linear`);
    if (res.ok) {
      const data = (await res.json()) as { retCode: number; result?: { list?: BybitTickerRow[] } };
      if (data.retCode === 0 && data.result?.list) {
        for (const row of data.result.list) {
          if (!wanted.has(row.symbol)) continue;
          const lastPrice = Number(row.lastPrice);
          const bid = Number(row.bid1Price ?? row.lastPrice);
          const ask = Number(row.ask1Price ?? row.lastPrice);
          const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : lastPrice;
          const spreadPercent = mid > 0 && ask > bid ? ((ask - bid) / mid) * 100 : 0.02;
          map.set(row.symbol, {
            symbol: row.symbol,
            lastPrice,
            bid,
            ask,
            spreadPercent: Number(spreadPercent.toFixed(5)),
            quoteVolume24h: Number(row.turnover24h ?? 0),
            quoteVolume24hSpot: 0,
            source: 'bybit',
            fetchedAt: now
          });
        }
      }
    }
  } catch {
    /* fall through to Binance */
  }

  // SPOT turnover — many assets are far more liquid on spot than on linear
  // futures, so a FUTURES-only turnover check wrongly LIQUIDITY-blocks valid
  // SPOT setups (§26). Fetch it for every wanted symbol regardless of whether
  // the linear call above found a match.
  try {
    const res = await timedFetch(`${BYBIT_PUBLIC_BASE}/v5/market/tickers?category=spot`);
    if (res.ok) {
      const data = (await res.json()) as { retCode: number; result?: { list?: BybitTickerRow[] } };
      if (data.retCode === 0 && data.result?.list) {
        for (const row of data.result.list) {
          if (!wanted.has(row.symbol)) continue;
          const spotVolume = Number(row.turnover24h ?? 0);
          const existing = map.get(row.symbol);
          if (existing) {
            existing.quoteVolume24hSpot = spotVolume;
          } else {
            const lastPrice = Number(row.lastPrice);
            const bid = Number(row.bid1Price ?? row.lastPrice);
            const ask = Number(row.ask1Price ?? row.lastPrice);
            const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : lastPrice;
            const spreadPercent = mid > 0 && ask > bid ? ((ask - bid) / mid) * 100 : 0.02;
            map.set(row.symbol, {
              symbol: row.symbol,
              lastPrice,
              bid,
              ask,
              spreadPercent: Number(spreadPercent.toFixed(5)),
              quoteVolume24h: 0,
              quoteVolume24hSpot: spotVolume,
              source: 'bybit',
              fetchedAt: now
            });
          }
        }
      }
    }
  } catch {
    /* leave quoteVolume24hSpot at 0 for symbols this call missed */
  }

  const missing = [...wanted].filter((s) => !map.has(s));
  if (missing.length) {
    try {
      const res = await timedFetch(`${BINANCE_PUBLIC_BASE}/ticker/bookTicker`);
      if (res.ok) {
        const rows = (await res.json()) as { symbol: string; bidPrice: string; askPrice: string }[];
        const byPair = new Map(rows.map((r) => [r.symbol, r]));
        for (const pair of missing) {
          const row = byPair.get(pair);
          if (!row) continue;
          const bid = Number(row.bidPrice);
          const ask = Number(row.askPrice);
          const mid = (bid + ask) / 2;
          map.set(pair, {
            symbol: pair,
            lastPrice: mid,
            bid,
            ask,
            spreadPercent: mid > 0 && ask > bid ? Number((((ask - bid) / mid) * 100).toFixed(5)) : 0.02,
            quoteVolume24h: 0,
            quoteVolume24hSpot: 0,
            source: 'binance',
            fetchedAt: now
          });
        }
      }
    } catch {
      /* leave missing symbols without a liquidity snapshot */
    }
  }

  if (map.size) liquidityCache = { at: now, map };
  return map;
}

// ── Multi-timeframe snapshot with per-timeframe refresh cadence ──────────────

export interface MultiTimeframeSnapshot {
  symbol: string;
  base: string;
  status: 'READY' | 'NOT_READY';
  reason?: string;
  h1: Candle[];
  m15: Candle[];
  m5: Candle[];
  counts: Record<TimeframeKey, number>;
  sources: Record<TimeframeKey, CandleSource>;
  /** Per-timeframe failure reason (INSUFFICIENT_CANDLES / API_ERROR / RATE_LIMIT / SYMBOL_NOT_FOUND) */
  reasons: Record<TimeframeKey, string>;
  /** Per-timeframe telemetry: raw received / after forming-candle drop / after validation / required minimum */
  telemetry: Record<TimeframeKey, { received: number; closed: number; valid: number; required: number; source: CandleSource }>;
  /** Close timestamp of the newest closed 5M candle */
  lastClosedAt: number;
  liquidity: LiquiditySnapshot | null;
  livePrice: number;
  issues: string[];
  fetchedAt: number;
}

export interface TimeframeCacheEntry {
  candles: Candle[];
  source: CandleSource;
  fetchedAt: number;
  lastTimestamp: number;
  /**
   * When a FULL window fetch last ran for this key.
   *
   * Delta mode only ever pulls candles newer than what is cached, so a cache
   * that starts SHORT stays short forever — it grows one bar per period and
   * nothing re-pulls the missing history. Recording the last full fetch lets
   * the delta path force a backfill when the merged series is under target,
   * while a symbol whose exchange history is genuinely shorter than target
   * (a new listing) retries at most once per BACKFILL_RETRY_MS instead of
   * refetching the whole window on every tick.
   */
  backfilledAt?: number;
}

const tfCache = new Map<string, TimeframeCacheEntry>();

function cacheKey(symbol: string, tf: TimeframeKey): string {
  return `${toBybitSymbol(symbol)}:${tf}`;
}

/**
 * Merges freshly-fetched candles into an existing cached series.
 * De-duplicates by timestamp, keeps the most recent `maxKeep` candles, and
 * reports whether a gap exists in the merged tail (a missing candle between the
 * old series and the new one) so the caller can fall back to a full refetch.
 */
function mergeDelta(existing: Candle[], fresh: Candle[], tfMs: number, maxKeep: number): { merged: Candle[]; gap: boolean } {
  if (!fresh.length) return { merged: existing, gap: false };
  const seen = new Set(existing.map((c) => c.timestamp));
  const combined: Candle[] = [...existing];
  for (const c of fresh) {
    if (!seen.has(c.timestamp)) {
      combined.push(c);
      seen.add(c.timestamp);
    }
  }
  combined.sort((a, b) => a.timestamp - b.timestamp);
  const merged = combined.slice(-maxKeep);
  const firstFreshTs = Math.min(...fresh.map((c) => c.timestamp));
  const startIdx = merged.findIndex((c) => c.timestamp >= firstFreshTs);
  let gap = false;
  for (let i = Math.max(1, startIdx); i < merged.length; i++) {
    if (merged[i].timestamp - merged[i - 1].timestamp !== tfMs) {
      gap = true;
      break;
    }
  }
  return { merged, gap };
}

/** Manual cache reset — used by tests and by /api/sim/reset */
export function clearMarketDataCache(): void {
  tfCache.clear();
  liquidityCache = { at: 0, map: new Map() };
}

/**
 * Exports the full in-memory timeframe cache (all retained candles per
 * (symbol,tf)). Callers that persist it should trim each entry to `minCandles`
 * so the serialized blob stays within backend document-size limits.
 */
export function exportMarketDataCache(): Record<string, TimeframeCacheEntry> {
  const out: Record<string, TimeframeCacheEntry> = {};
  for (const [k, v] of tfCache.entries()) {
    out[k] = { ...v };
  }
  return out;
}

/** Hydrates the in-memory cache from a snapshot produced by exportMarketDataCache. */
export function importMarketDataCache(data: Record<string, TimeframeCacheEntry> | null | undefined): void {
  if (!data || typeof data !== 'object') return;
  for (const [k, v] of Object.entries(data)) {
    if (v && Array.isArray(v.candles) && v.candles.length && typeof v.lastTimestamp === 'number') {
      tfCache.set(k, v);
    }
  }
}

export interface MarketDataStats {
  assetsSeen: number;
  assetsWithValidData: number;
  assetsSkipped: number;
  dataErrors: number;
  skipped: { symbol: string; reason: string }[];
}

export interface GetMarketDataOptions {
  now?: number;
  /** Force a refetch regardless of the refresh cadence */
  force?: boolean;
  /** Emit `[market-data]` telemetry lines */
  log?: boolean;
  /** Override candle budgets (backtest / tests) */
  limits?: Partial<Record<TimeframeKey, number>>;
  /** Bybit market category for klines. Defaults to 'linear' (the bot trades USDT perpetuals). */
  category?: 'spot' | 'linear';
}

function isNodeRuntime(): boolean {
  const runtime = globalThis as typeof globalThis & { process?: { versions?: { node?: string } } };
  return typeof runtime.process?.versions?.node === 'string';
}

/**
 * Loads 1H/15M/5M for a single symbol, honouring the per-timeframe refresh
 * cadence (§7) so a 5s tick does not hammer the API for 1H candles that cannot
 * have changed.
 */
export async function getMultiTimeframeData(symbol: string, opts: GetMarketDataOptions = {}): Promise<MultiTimeframeSnapshot> {
  const now = opts.now ?? Date.now();
  const bybitSymbol = toBybitSymbol(symbol);
  const issues: string[] = [];
  const candles: Record<TimeframeKey, Candle[]> = { '1h': [], '15m': [], '5m': [] };
  const sources: Record<TimeframeKey, CandleSource> = { '1h': 'none', '15m': 'none', '5m': 'none' };
  const reasons: Record<TimeframeKey, string> = { '1h': '', '15m': '', '5m': '' };
  const telemetry: Record<TimeframeKey, { received: number; closed: number; valid: number; required: number; source: CandleSource }> = {
    '1h': { received: 0, closed: 0, valid: 0, required: TIMEFRAME_SPECS['1h'].minCandles, source: 'none' },
    '15m': { received: 0, closed: 0, valid: 0, required: TIMEFRAME_SPECS['15m'].minCandles, source: 'none' },
    '5m': { received: 0, closed: 0, valid: 0, required: TIMEFRAME_SPECS['5m'].minCandles, source: 'none' }
  };

  for (const tf of TIMEFRAME_ORDER) {
    const spec = TIMEFRAME_SPECS[tf];
    const key = cacheKey(bybitSymbol, tf);
    const cached = tfCache.get(key);
    const expectedLastClose = Math.floor(now / spec.ms) * spec.ms - spec.ms;
    // A cache below targetCandles is never "fresh enough" on timestamp alone —
    // this gate used to accept ANY cache whose lastTimestamp already covered
    // the most recently closed bar, with no length check at all. That is
    // exactly the shape a rehydrated-short cache has: its last known candle
    // IS current (nothing new has closed since), so it passed here forever
    // and never reached the delta/full-fetch code below where the actual
    // below-target backfill logic lives. 1h and 15m — whose bars close slowly
    // enough that "last candle is still current" is true almost immediately
    // after a restart — got stuck at whatever length they were rehydrated
    // with; 5m, rolling over every 5 minutes, aged out of this gate on its
    // own and reached the backfill logic within minutes. Requiring target
    // length (or a recent backfill attempt, so a genuinely short-history
    // symbol doesn't refetch every tick forever) closes that gap for all
    // three timeframes alike.
    const cacheFresh =
      !!cached &&
      !opts.force &&
      (cached.candles.length >= spec.targetCandles || now - (cached.backfilledAt ?? 0) < BACKFILL_RETRY_MS) &&
      (now - cached.fetchedAt < spec.refreshMs || cached.lastTimestamp >= expectedLastClose);

    if (cacheFresh && cached) {
      candles[tf] = cached.candles;
      sources[tf] = 'cache';
      telemetry[tf] = { received: cached.candles.length, closed: cached.candles.length, valid: cached.candles.length, required: spec.minCandles, source: 'cache' };
      continue;
    }

    // PERSISTENT CACHE (Firestore / local file): check before network fetch.
    // This survives deploys and is shared across all engines.
    // Only available in Node.js environment (not browser).
    // NOTE: This uses a variable import path to prevent Vite from analyzing
    // the server-only module during frontend builds.
    if (!opts.force && isNodeRuntime()) {
      try {
        const cachePath = '../../server/historicalCandleCache';
        const cacheModule = await import(/* @vite-ignore */ cachePath);
        const { getCachedHistory, saveCachedHistory } = cacheModule;
        const persistentCached = await getCachedHistory(bybitSymbol, tf);
        if (persistentCached?.length) {
          const lastTimestamp = persistentCached[persistentCached.length - 1].timestamp;
          const isFresh = lastTimestamp >= expectedLastClose || (now - lastTimestamp) < spec.refreshMs;
          // Same rule as the in-memory gate above: minCandles is the floor a
          // timeframe is still usable at, not what the most demanding consumer
          // (Path, at 1h) needs. Accepting a short-but-recent snapshot here
          // re-adopted exactly the truncated series the in-memory cache had
          // just been rehydrated with, and warmed tfCache with the same short
          // length — a second copy of the bug above, in a cache this one
          // doesn't even track backfilledAt for. A short result now falls
          // through to the network fetch below instead, which does.
          if (isFresh && persistentCached.length >= spec.targetCandles) {
            candles[tf] = persistentCached;
            sources[tf] = 'cache';
            telemetry[tf] = { received: persistentCached.length, closed: persistentCached.length, valid: persistentCached.length, required: spec.minCandles, source: 'cache' };
            // Also warm the in-memory cache
            tfCache.set(key, { candles: persistentCached, source: 'cache', fetchedAt: now, lastTimestamp, backfilledAt: now });
            continue;
          }
        }
      } catch {
        // Persistent cache read failure — fall through to network fetch
      }
    }

    // RULE (warm cache): if we already have a recent cache, fetch ONLY the new
    // candles (delta) instead of re-pulling the full window. This is the core
    // "remember what we already downloaded, check only the new against it" rule.
    // Falls back to a full refetch on gap / insufficient / hard error.
    if (cached && now - cached.fetchedAt < MAX_CACHE_AGE_MS) {
      const delta = await fetchTimeframe(symbol, tf, { now, since: cached.lastTimestamp, category: opts.category });
      if (delta.candles.length) {
        const { merged, gap } = mergeDelta(cached.candles, delta.candles, spec.ms, MAX_CANDLES_PER_TF);
        // Accept the delta only if the merged series still covers the most
        // demanding consumer (targetCandles), not merely the usable floor
        // (minCandles). A cache rehydrated short — from an older persist that
        // truncated to minCandles, or from a partial cold fetch — passed the
        // minCandles test forever while never reaching what the Path bot needs,
        // because delta mode only ever adds what is newer. Falling through to
        // the full refetch is the only thing that recovers the missing history.
        const belowTarget = merged.length < spec.targetCandles;
        const backfillDue = belowTarget && now - (cached.backfilledAt ?? 0) >= BACKFILL_RETRY_MS;
        if (!gap && merged.length >= spec.minCandles && !backfillDue) {
          candles[tf] = merged;
          sources[tf] = delta.source;
          tfCache.set(key, {
            candles: merged,
            source: delta.source,
            fetchedAt: now,
            lastTimestamp: merged[merged.length - 1].timestamp,
            backfilledAt: cached.backfilledAt
          });
          telemetry[tf] = { received: delta.received, closed: delta.closed, valid: merged.length, required: spec.minCandles, source: delta.source };
          // Save to persistent cache after successful network fetch (Node.js only)
          // Uses variable path to prevent Vite from analyzing server-only import
          if (isNodeRuntime()) {
            const cachePath = '../../server/historicalCandleCache';
            import(/* @vite-ignore */ cachePath).then(({ saveCachedHistory }) => {
              saveCachedHistory(bybitSymbol, tf, merged).catch(() => {});
            }).catch(() => {});
          }
          continue;
        }
        issues.push(`${tf}:delta-${gap ? 'gap' : backfillDue ? 'below-target' : 'insufficient'}-full-refetch`);
      } else if (delta.reason === 'RATE_LIMIT' || delta.reason === 'API_ERROR' || delta.reason === 'NO_NEW_CANDLES') {
        // Transient upstream failure (or simply no new candle yet): serve
        // last-known-good rather than dropping the asset or re-pulling the window.
        candles[tf] = cached.candles;
        sources[tf] = 'cache';
        telemetry[tf].source = 'cache';
        issues.push(`${tf}:served-stale-cache(${delta.reason})`);
        continue;
      }
      // SYMBOL_NOT_FOUND or gap/insufficient → fall through to a full refetch.
    }

    // FULL fetch (cold / too stale / delta failed).
    const result = await fetchTimeframe(symbol, tf, { now, limit: opts.limits?.[tf], category: opts.category });
    issues.push(...result.issues);
    telemetry[tf] = { received: result.received, closed: result.closed, valid: result.valid, required: result.required, source: result.source };
    if (result.candles.length) {
      candles[tf] = result.candles;
      sources[tf] = result.source;
      tfCache.set(key, {
        candles: result.candles,
        source: result.source,
        fetchedAt: now,
        lastTimestamp: result.candles[result.candles.length - 1].timestamp,
        // Stamped even when the result is still under target: the exchange has
        // been asked for the full window and gave what it has. Without this a
        // genuinely short symbol would force a full refetch on every tick.
        backfilledAt: now
      });
      // Save to persistent cache after successful network fetch (Node.js only)
      // Uses variable path to prevent Vite from analyzing server-only import
      if (isNodeRuntime()) {
        const cachePath = '../../server/historicalCandleCache';
        import(/* @vite-ignore */ cachePath).then(({ saveCachedHistory }) => {
          saveCachedHistory(bybitSymbol, tf, result.candles).catch(() => {});
        }).catch(() => {});
      }
    } else if (cached) {
      // Transient outage: keep last-known-good rather than dropping the asset.
      candles[tf] = cached.candles;
      sources[tf] = 'cache';
      telemetry[tf].source = 'cache';
      issues.push(`${tf}:served-stale-cache`);
    } else if (result.reason) {
      reasons[tf] = result.reason;
    }
  }

  const counts: Record<TimeframeKey, number> = {
    '1h': candles['1h'].length,
    '15m': candles['15m'].length,
    '5m': candles['5m'].length
  };

  const missing = TIMEFRAME_ORDER.filter((tf) => counts[tf] < TIMEFRAME_SPECS[tf].minCandles);
  const status: 'READY' | 'NOT_READY' = missing.length ? 'NOT_READY' : 'READY';
  const reason = missing.length ? `INSUFFICIENT_CANDLES:${missing.join(',')}` : undefined;

  const liquidityMap = await getLiquiditySnapshots([bybitSymbol], now).catch(() => new Map<string, LiquiditySnapshot>());
  const liquidity = liquidityMap.get(bybitSymbol) ?? null;
  const lastM5 = candles['5m'][candles['5m'].length - 1];

  if (opts.log) {
    if (status === 'READY') {
      console.log(`[market-data] symbol=${bybitSymbol} 1h=${counts['1h']} 15m=${counts['15m']} 5m=${counts['5m']} src=${sources['5m']}`);
    } else {
      const detail = TIMEFRAME_ORDER.map((tf) => {
        const t = telemetry[tf];
        return `${tf}: received=${t.received} valid=${t.valid} required=${t.required} source=${t.source}${reasons[tf] ? ` (${reasons[tf]})` : ''}`;
      }).join(' ');
      console.log(`[market-data] symbol=${bybitSymbol} status=NOT_READY reason=${reason}\n  ${detail}`);
    }
  }

  return {
    symbol: bybitSymbol,
    base: toBaseAsset(bybitSymbol),
    status,
    reason,
    h1: candles['1h'],
    m15: candles['15m'],
    m5: candles['5m'],
    counts,
    sources,
    reasons,
    telemetry,
    lastClosedAt: lastM5 ? lastM5.timestamp + TIMEFRAME_SPECS['5m'].ms : 0,
    liquidity,
    livePrice: liquidity?.lastPrice || lastM5?.close || 0,
    issues,
    fetchedAt: now
  };
}

/**
 * Loads the whole trading universe with bounded concurrency and returns the
 * data-quality statistics required by §6 (never a bare `evals=0`).
 */
export async function getUniverseMarketData(
  symbols: string[],
  opts: GetMarketDataOptions & { concurrency?: number } = {}
): Promise<{ snapshots: Map<string, MultiTimeframeSnapshot>; stats: MarketDataStats }> {
  const cacheKey = symbols.slice().sort().join(',') + '|' + (opts.now ?? Date.now());
  const existing = universeFetchCache.get(cacheKey);
  if (existing) return existing;

  const promise = (async () => {
    const now = opts.now ?? Date.now();
    const concurrency = opts.concurrency ?? 4;
    const snapshots = new Map<string, MultiTimeframeSnapshot>();
    const stats: MarketDataStats = {
      assetsSeen: symbols.length,
      assetsWithValidData: 0,
      assetsSkipped: 0,
      dataErrors: 0,
      skipped: []
    };

    await getLiquiditySnapshots(symbols, now).catch(() => {
      stats.dataErrors++;
      return new Map<string, LiquiditySnapshot>();
    });

    for (let i = 0; i < symbols.length; i += concurrency) {
      const batch = symbols.slice(i, i + concurrency);
      const results = await Promise.all(
        batch.map(async (symbol) => {
          try {
            return await getMultiTimeframeData(symbol, { ...opts, now });
          } catch (e) {
            stats.dataErrors++;
            return {
              symbol: toBybitSymbol(symbol),
              base: toBaseAsset(symbol),
              status: 'NOT_READY' as const,
              reason: `DATA_ERROR:${e instanceof Error ? e.message : String(e)}`,
              h1: [],
              m15: [],
              m5: [],
              counts: { '1h': 0, '15m': 0, '5m': 0 } as Record<TimeframeKey, number>,
              sources: { '1h': 'none', '15m': 'none', '5m': 'none' } as Record<TimeframeKey, CandleSource>,
              reasons: { '1h': 'DATA_ERROR', '15m': 'DATA_ERROR', '5m': 'DATA_ERROR' } as Record<TimeframeKey, string>,
              telemetry: {
                '1h': { received: 0, closed: 0, valid: 0, required: TIMEFRAME_SPECS['1h'].minCandles, source: 'none' },
                '15m': { received: 0, closed: 0, valid: 0, required: TIMEFRAME_SPECS['15m'].minCandles, source: 'none' },
                '5m': { received: 0, closed: 0, valid: 0, required: TIMEFRAME_SPECS['5m'].minCandles, source: 'none' }
              },
              lastClosedAt: 0,
              liquidity: null,
              livePrice: 0,
              issues: [],
              fetchedAt: now
            } satisfies MultiTimeframeSnapshot;
          }
        })
      );

      for (const snap of results) {
        snapshots.set(snap.symbol, snap);
        if (snap.status === 'READY') stats.assetsWithValidData++;
        else {
          stats.assetsSkipped++;
          stats.skipped.push({ symbol: snap.symbol, reason: snap.reason || 'NOT_READY' });
        }
      }
    }

    return { snapshots, stats };
  })();

  universeFetchCache.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    universeFetchCache.delete(cacheKey);
  }
}

/**
 * Backtest loader: pulls a deep 5M/15M/1H history in one shot (paginated) with
 * NO cache and NO forming-candle trimming ambiguity.
 */
export async function fetchBacktestHistory(
  symbol: string,
  limits: Record<TimeframeKey, number>,
  now = Date.now()
): Promise<{ symbol: string; h1: Candle[]; m15: Candle[]; m5: Candle[]; sources: Record<TimeframeKey, CandleSource> }> {
  const out = { symbol: toBybitSymbol(symbol), h1: [] as Candle[], m15: [] as Candle[], m5: [] as Candle[] };
  const sources: Record<TimeframeKey, CandleSource> = { '1h': 'none', '15m': 'none', '5m': 'none' };

  for (const tf of TIMEFRAME_ORDER) {
    const res = await fetchTimeframe(symbol, tf, { limit: limits[tf], now });
    sources[tf] = res.source;
    if (tf === '1h') out.h1 = res.candles;
    if (tf === '15m') out.m15 = res.candles;
    if (tf === '5m') out.m5 = res.candles;
  }

  return { ...out, sources };
}
