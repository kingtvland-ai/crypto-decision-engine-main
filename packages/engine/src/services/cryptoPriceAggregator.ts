/**
 * CryptoPriceAggregator — Multi-Source, Rate-Limit-Safe Price & Candle Feed
 * ============================================================================
 * Priority order for prices:   Bybit → Binance → CoinGecko (cached)
 * Priority order for candles:  Bybit → Binance → CoinGecko (heavily rate-gated)
 *
 * CoinGecko is last-resort ONLY — Bybit's bulk ticker call already covers
 * this pipeline's normal case, so CoinGecko is reached only when BOTH Bybit
 * AND Binance fail. This aggregator enforces a 120s minimum TTL for CoinGecko
 * calls regardless of CoinGecko's own current free-tier limit (which changes
 * over time and is not worth hardcoding a number for here) — 120s keeps this
 * pipeline's CoinGecko usage far under any plausible free-tier ceiling, and
 * stale cached data is served rather than risking a rate-limit block.
 *
 * Binance public API: 1200 req/min, no API key needed. Fetch ALL 24h tickers
 * in a SINGLE call instead of one per symbol.
 */

import { CryptoData } from '../types/crypto';
import { Candle } from './tradeEngine';
import { toBaseAsset } from './assetUniverse';
import { CRYPTO_IDS } from './coinGeckoIds';

// ── Binance ticker shape ──────────────────────────────────────────────────────
interface BinanceTicker {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  quoteVolume: string;
  highPrice: string;
  lowPrice: string;
  openPrice: string;
}

interface BinanceKlineRaw {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

// ── Internal cache entries ────────────────────────────────────────────────────
interface PriceCache {
  data: CryptoData[];
  fetchedAt: number;
  source: 'bybit' | 'binance' | 'coingecko';
}

interface CandleCache {
  candles: Candle[];
  fetchedAt: number;
  source: 'bybit' | 'binance' | 'coingecko';
}

// ── Constants ─────────────────────────────────────────────────────────────────
const BINANCE_BASE = 'https://api.binance.com/api/v3';
const BYBIT_BASE   = 'https://api.bybit.com';
const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

/** Minimum time between CoinGecko getCurrentPrices() calls (2 minutes) */
const COINGECKO_PRICE_TTL = 2 * 60 * 1000;
/** Minimum time between CoinGecko per-coin candle fetches (10 minutes) */
const COINGECKO_CANDLE_TTL = 10 * 60 * 1000;
/** Binance full-ticker cache TTL (15 seconds — Binance allows it) */
const BINANCE_TICKER_TTL = 15_000;
/** Bybit ticker cache TTL. One bulk call (`/v5/market/tickers?category=spot`,
 *  no `symbol` param) returns EVERY USDT pair on the exchange regardless of
 *  how many symbols a caller actually wants, so shortening this costs nothing
 *  extra per request — it only controls how often that one request repeats.
 *  2.5s (2026-09-15, down from 10s) matches the sim bots' tick cadence
 *  (server/simEngineFactory.ts TICK_MS) so live positions mark-to-market and
 *  their stop-loss/profit-ratchet checks are never computed against a price
 *  older than roughly one tick. */
const BYBIT_TICKER_TTL = 2_500;

// ── CoinGecko symbol → ID map — see coinGeckoIds.ts ───────────────────────────

// ── In-memory caches ──────────────────────────────────────────────────────────
let priceCache: PriceCache | null = null;
let binanceTickerCache: { tickers: BinanceTicker[]; fetchedAt: number } | null = null;
let bybitTickerCache: { tickers: CryptoData[]; fetchedAt: number } | null = null;
const candleCache = new Map<string, CandleCache>();

// ── Helper: timed fetch ───────────────────────────────────────────────────────
async function timedFetch(url: string, timeoutMs = 8000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

// ── Binance: fetch ALL USDT tickers in one call ───────────────────────────────
async function fetchBinanceAllTickers(): Promise<BinanceTicker[]> {
  const now = Date.now();
  if (binanceTickerCache && now - binanceTickerCache.fetchedAt < BINANCE_TICKER_TTL) {
    return binanceTickerCache.tickers;
  }

  try {
    // Fetching ALL tickers without a symbol filter — single call, max efficiency
    const res = await timedFetch(`${BINANCE_BASE}/ticker/24hr`);
    if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
    const all = await res.json() as BinanceTicker[];
    // Keep only USDT pairs with real volume
    const filtered = all.filter(t =>
      t.symbol.endsWith('USDT') &&
      parseFloat(t.quoteVolume) > 10000
    );
    binanceTickerCache = { tickers: filtered, fetchedAt: now };
    return filtered;
  } catch (e) {
    console.warn('[aggregator] Binance ticker fetch failed:', e instanceof Error ? e.message : String(e));
    return binanceTickerCache?.tickers ?? [];
  }
}

// ── Bybit: fetch all spot tickers ─────────────────────────────────────────────
async function fetchBybitAllTickers(): Promise<CryptoData[]> {
  const now = Date.now();
  if (bybitTickerCache && now - bybitTickerCache.fetchedAt < BYBIT_TICKER_TTL) {
    return bybitTickerCache.tickers;
  }

  try {
    const res = await timedFetch(`${BYBIT_BASE}/v5/market/tickers?category=spot`);
    if (!res.ok) throw new Error(`Bybit HTTP ${res.status}`);
    const data = await res.json() as {
      retCode: number;
      result?: { list?: { symbol: string; lastPrice: string; price24hPcnt: string; volume24h: string }[] }
    };
    if (data.retCode !== 0 || !data.result?.list) throw new Error('Bybit retCode not 0');

    const tickers = data.result.list
      .filter(t => t.symbol.endsWith('USDT'))
      .map(t => {
        const sym = toBaseAsset(t.symbol).toLowerCase();
        return {
          id: sym,
          symbol: sym,
          name: t.symbol,
          current_price: parseFloat(t.lastPrice),
          price_change_percentage_24h: parseFloat(t.price24hPcnt) * 100,
          total_volume: parseFloat(t.volume24h),
          // Real market cap needs circulating supply, which ticker endpoints
          // don't provide — price × volume is NOT market cap. 0 means
          // "genuinely unknown" (see recommendationEngine.ts, which treats
          // 0 as neutral rather than assuming the smallest/riskiest tier).
          market_cap: 0,
          last_updated: new Date().toISOString()
        } as CryptoData;
      });

    bybitTickerCache = { tickers, fetchedAt: now };
    return tickers;
  } catch (e) {
    console.warn('[aggregator] Bybit ticker fetch failed:', e instanceof Error ? e.message : String(e));
    return bybitTickerCache?.tickers ?? [];
  }
}

// ── CoinGecko: rate-gated price fetch ────────────────────────────────────────
let lastCoinGeckoPriceFetch = 0;
let coinGeckoPriceCache: CryptoData[] = [];

async function fetchCoinGeckoPrices(): Promise<CryptoData[]> {
  const now = Date.now();
  if (now - lastCoinGeckoPriceFetch < COINGECKO_PRICE_TTL) {
    return coinGeckoPriceCache; // serve stale rather than blow rate limit
  }

  const ids = Object.values(CRYPTO_IDS).join(',');
  const url = `${COINGECKO_BASE}/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&per_page=100&page=1&sparkline=false&price_change_percentage=24h&locale=en`;

  try {
    const res = await timedFetch(url, 10000);
    if (res.status === 429) {
      console.warn('[aggregator] CoinGecko rate limited — serving cached data');
      return coinGeckoPriceCache;
    }
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    const data = await res.json() as CryptoData[];
    if (!data || data.length === 0) throw new Error('Empty response');

    // Map CoinGecko IDs back to our symbol names
    const mapped = data.map(coin => {
      const entry = Object.entries(CRYPTO_IDS).find(([, id]) => id === coin.id);
      return { ...coin, symbol: entry ? entry[0].toLowerCase() : coin.symbol.toLowerCase() };
    });

    lastCoinGeckoPriceFetch = now;
    coinGeckoPriceCache = mapped;
    return mapped;
  } catch (e) {
    console.warn('[aggregator] CoinGecko price fetch failed:', e instanceof Error ? e.message : String(e));
    return coinGeckoPriceCache;
  }
}

// ── Main: getCurrentPrices — Bybit → Binance → CoinGecko ─────────────────────
// Both tickers (t.symbol, mapped bare e.g. "lit") and targetSymbols (caller-
// supplied, usually suffixed e.g. "LITUSDT") need the SAME base-asset form
// before comparing — comparing "LIT" to "LITUSDT" directly never matches,
// which silently emptied the target-filtered result down to the CoinGecko
// fallback (ignoring targetSymbols entirely) whenever a caller filtered.
// Uses the shared toBaseAsset() (assetUniverse.ts) rather than a local
// ad-hoc implementation — every price/candle source in this file used to
// carry its own copy of this normalization, which is exactly how the
// bare-vs-suffixed mismatches shipped in the first place.
export async function getAggregatedPrices(targetSymbols?: string[]): Promise<CryptoData[]> {
  const targetBases = targetSymbols?.map(toBaseAsset);
  // 1) Try Bybit (fastest, real-time)
  const bybitTickers = await fetchBybitAllTickers();
  if (bybitTickers.length > 10) {
    const filtered = targetBases
      ? bybitTickers.filter(t => targetBases.includes(toBaseAsset(t.symbol)))
      : bybitTickers;
    if (filtered.length > 10) {
      priceCache = { data: filtered, fetchedAt: Date.now(), source: 'bybit' };
      return filtered;
    }
  }

  // 2) Try Binance (one call for all tickers)
  const binanceTickers = await fetchBinanceAllTickers();
  if (binanceTickers.length > 10) {
    const mapped: CryptoData[] = binanceTickers
      .filter(t => {
        const sym = toBaseAsset(t.symbol).toLowerCase();
        return targetBases
          ? targetBases.includes(toBaseAsset(sym))
          : true;
      })
      .map(t => {
        const sym = toBaseAsset(t.symbol).toLowerCase();
        const price = parseFloat(t.lastPrice);
        const vol   = parseFloat(t.quoteVolume);
        return {
          id: sym,
          symbol: sym,
          name: t.symbol,
          current_price: price,
          price_change_percentage_24h: parseFloat(t.priceChangePercent),
          total_volume: vol,
          market_cap: 0, // genuinely unknown — see the Bybit branch above for why
          last_updated: new Date().toISOString()
        } as CryptoData;
      });

    if (mapped.length > 10) {
      priceCache = { data: mapped, fetchedAt: Date.now(), source: 'binance' };
      return mapped;
    }
  }

  // 3) Fallback: CoinGecko (rate-gated, 2min TTL minimum)
  const cgData = await fetchCoinGeckoPrices();
  if (cgData.length > 0) {
    priceCache = { data: cgData, fetchedAt: Date.now(), source: 'coingecko' };
    return cgData;
  }

  // 4) Absolute last resort: return previously cached data
  return priceCache?.data ?? [];
}

// ── Candle fetching: Bybit → Binance → CoinGecko ────────────────────────────
export async function getAggregatedCandles(symbol: string, days = 60): Promise<Candle[]> {
  // Accept either a base symbol ("STX") or an already-suffixed pair ("STXUSDT") —
  // callers pass both (e.g. LivePositionChart receives Bybit position symbols,
  // which already include "USDT"). toBaseAsset() strips any existing suffix
  // before re-adding it, avoiding "STXUSDTUSDT" (which Binance/Bybit reject,
  // surfacing as a confusing CORS error in the browser since the error
  // response has no CORS header).
  const BASE = toBaseAsset(symbol);
  const SYM = BASE;
  const now = Date.now();

  // 1) Bybit klines
  try {
    const res = await timedFetch(
      `${BYBIT_BASE}/v5/market/kline?category=spot&symbol=${SYM}USDT&interval=D&limit=${Math.min(days, 200)}`,
      8000
    );
    if (res.ok) {
      const data = await res.json() as {
        retCode: number;
        result?: { list?: string[][] }
      };
      if (data.retCode === 0 && data.result?.list && data.result.list.length > 2) {
        const candles: Candle[] = [...data.result.list].reverse().map(a => ({
          timestamp: Number(a[0]),
          open:  Number(a[1]),
          high:  Number(a[2]),
          low:   Number(a[3]),
          close: Number(a[4]),
          volume: Number(a[5])
        }));
        candleCache.set(SYM, { candles, fetchedAt: now, source: 'bybit' });
        return candles;
      }
    }
  } catch { /* fall through */ }

  // 2) Binance klines
  try {
    const res = await timedFetch(
      `${BINANCE_BASE}/klines?symbol=${SYM}USDT&interval=1d&limit=${Math.min(days, 1000)}`,
      8000
    );
    if (res.ok) {
      const raw: BinanceKlineRaw[] = (await res.json() as unknown[][]).map(a => ({
        openTime: a[0] as number,
        open:  a[1] as string,
        high:  a[2] as string,
        low:   a[3] as string,
        close: a[4] as string,
        volume: a[5] as string
      }));
      if (raw.length > 2) {
        const candles: Candle[] = raw.map(k => ({
          timestamp: k.openTime,
          open:  parseFloat(k.open),
          high:  parseFloat(k.high),
          low:   parseFloat(k.low),
          close: parseFloat(k.close),
          volume: parseFloat(k.volume)
        }));
        candleCache.set(SYM, { candles, fetchedAt: now, source: 'binance' });
        return candles;
      }
    }
  } catch { /* fall through */ }

  // 3) CoinGecko — rate-gated: minimum COINGECKO_CANDLE_TTL per symbol
  const cached = candleCache.get(SYM);
  if (cached && now - cached.fetchedAt < COINGECKO_CANDLE_TTL) {
    return cached.candles; // serve last-known-good rather than blow rate limit
  }

  const coinId = CRYPTO_IDS[SYM] || SYM.toLowerCase();
  try {
    const url = `${COINGECKO_BASE}/coins/${coinId}/market_chart?vs_currency=usd&days=${days}&interval=daily`;
    const res = await timedFetch(url, 10000);
    if (res.status === 429) {
      console.warn(`[aggregator] CoinGecko candle rate limited for ${SYM} — serving cached`);
      return cached?.candles ?? [];
    }
    if (!res.ok) throw new Error(`CoinGecko candle HTTP ${res.status}`);
    const data = await res.json() as { prices: [number, number][]; total_volumes: [number, number][] };
    if (!data.prices || data.prices.length < 2) throw new Error('insufficient data');

    const candles: Candle[] = data.prices.map(([ts, price], i) => {
      const open = i > 0 ? data.prices[i - 1][1] : price;
      const vol  = data.total_volumes[i]?.[1] ?? 0;
      return {
        timestamp: ts,
        open,
        high: Math.max(open, price),
        low:  Math.min(open, price),
        close: price,
        volume: vol
      };
    });

    candleCache.set(SYM, { candles, fetchedAt: now, source: 'coingecko' });
    return candles;
  } catch (e) {
    console.warn(`[aggregator] CoinGecko candle fetch failed for ${SYM}:`, e instanceof Error ? e.message : String(e));
    return cached?.candles ?? [];
  }
}

/** Expose cache health stats for /health endpoint */
export function getAggregatorHealth() {
  return {
    priceSource: priceCache?.source ?? 'none',
    priceCacheAge: priceCache ? Date.now() - priceCache.fetchedAt : null,
    candlesCached: candleCache.size,
    coinGeckoPriceCooldown: Math.max(0, COINGECKO_PRICE_TTL - (Date.now() - lastCoinGeckoPriceFetch))
  };
}
