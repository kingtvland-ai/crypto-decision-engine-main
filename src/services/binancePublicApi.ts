/**
 * Binance Public API Service (100% Free, No API Key Required)
 * Provides cross-exchange price/volume validation and zero-lag market data.
 * Rate limit: 1200 req/min — far more permissive than CoinGecko's 30 req/min.
 */

import { readJson } from '../utils/errorHandler';
import { isBinanceUnlistedSymbol } from '@cde/engine/market-data';

const BINANCE_BASE_URL = 'https://api.binance.com/api/v3';

export interface Binance24hTicker {
  symbol: string;
  priceChange: string;
  priceChangePercent: string;
  weightedAvgPrice: string;
  prevClosePrice: string;
  lastPrice: string;
  bidPrice: string;
  askPrice: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  volume: string;
  quoteVolume: string;
}

export interface BinanceKline {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** The bulk ticker calls below (get24hTicker/getKlines) had no backoff at
 *  all — a 429 was treated the same as any other failure (silently
 *  swallowed, no retry). One retry with a short backoff is enough for
 *  Binance's generous 1200 req/min limit. */
async function fetchWithBackoff(url: string, timeoutMs: number, attempt = 0): Promise<Response | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: controller.signal });
    clearTimeout(timeout);
    if (res.status === 429 && attempt < 2) {
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      return fetchWithBackoff(url, timeoutMs, attempt + 1);
    }
    return res;
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

export const binancePublicApi = {
  /**
   * Fetch 24h ticker for cross-exchange volume/price validation (single symbol).
   * For bulk price data, the app reads from `getAggregatedPrices()`
   * (packages/engine/src/services/cryptoPriceAggregator.ts) instead, which
   * has its own Bybit-first bulk-ticker cascade — this file's own bulk
   * `getAllTickers()` was a second, unused copy of that and was removed
   * 2026-09-15 once nothing called it anymore.
   */
  async get24hTicker(symbol: string): Promise<Binance24hTicker | null> {
    const formatted = symbol.toUpperCase().endsWith('USDT') ? symbol.toUpperCase() : `${symbol.toUpperCase()}USDT`;
    const res = await fetchWithBackoff(`${BINANCE_BASE_URL}/ticker/24hr?symbol=${formatted}`, 6000);
    if (!res?.ok) return null;
    try {
      return await readJson<Binance24hTicker>(res, 'binance 24h ticker');
    } catch {
      return null;
    }
  },

  /**
   * Fetch real Kline candles from Binance public endpoint.
   * No API key required. Supports up to 1000 candles per call.
   */
  async getKlines(symbol: string, interval = '1d', limit = 30): Promise<BinanceKline[]> {
    const formatted = symbol.toUpperCase().endsWith('USDT') ? symbol.toUpperCase() : `${symbol.toUpperCase()}USDT`;
    // Binance sends no CORS headers on its 400 "Invalid symbol" response, so an
    // unlisted pair reaches the console as a CORS violation instead. Ask only
    // for pairs Binance actually lists. See isBinanceUnlistedSymbol.
    if (await isBinanceUnlistedSymbol(formatted)) return [];
    const res = await fetchWithBackoff(
      `${BINANCE_BASE_URL}/klines?symbol=${formatted}&interval=${interval}&limit=${limit}`,
      8000
    );
    if (!res?.ok) return [];
    try {
      const data = await readJson<unknown[][]>(res, 'binance klines');
      return data.map(item => ({
        timestamp: item[0] as number,
        open:   parseFloat(item[1] as string),
        high:   parseFloat(item[2] as string),
        low:    parseFloat(item[3] as string),
        close:  parseFloat(item[4] as string),
        volume: parseFloat(item[5] as string)
      }));
    } catch {
      return [];
    }
  }
};
