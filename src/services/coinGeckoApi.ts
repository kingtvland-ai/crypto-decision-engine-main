
import { HistoricalPrice } from '@cde/engine';
import { CRYPTO_IDS } from '@cde/engine/market-data';

const COINGECKO_BASE_URL = 'https://api.coingecko.com/api/v3';

// ── Rate limiter state ────────────────────────────────────────────────────────
// CoinGecko's free-tier rate limit gates the calls below. getCurrentPrices()
// used to live here with its own 2-minute gate — removed 2026-09-15 once
// useCryptoData.ts stopped calling it in favor of the shared
// getAggregatedPrices() (cryptoPriceAggregator.ts), which already tries
// Bybit → Binance → CoinGecko itself. This file's historical-price/volume
// calls (AdvancedAnalysis.tsx's only remaining callers) are unrelated to that
// cascade and keep their own gate below.

/** Minimum gap per-coin for historical candle fetches: 10 minutes */
const HIST_FETCH_MIN_GAP_MS = 10 * 60 * 1000;
const lastHistFetchAt: Record<string, number> = {};
const cachedHistData: Record<string, HistoricalPrice[]> = {};

interface CoinGeckoMarketChart {
  prices: [number, number][];
  total_volumes: [number, number][];
}

/**
 * Lightweight fetch wrapper — fail fast on 429 (return null), single retry max.
 * The aggregator (cryptoPriceAggregator.ts) is the primary source; CoinGecko is
 * last-resort, so we should NEVER burn retries here.
 */
async function apiCall<T>(url: string, retries = 1, delay = 1000): Promise<T | null> {
  for (let i = 0; i <= retries; i++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const response = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.status === 429) {
        // Rate limited — never retry, let the caller serve cached data instead.
        console.warn(`[CoinGecko] 429 rate limited on attempt ${i + 1} — stopping immediately`);
        return null;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as T;
      return data;
    } catch (error) {
      console.warn(`[CoinGecko] API call failed (attempt ${i + 1}/${retries + 1}):`, error);
      if (i === retries) return null;
      const waitTime = Math.min(delay * Math.pow(2, i), 8000);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
  return null;
}

export const coinGeckoApi = {
  /**
   * Returns daily historical prices for a coin.
   * RATE-GATED per coin: returns cached data if called within 10 minutes.
   * retries parameter kept for backward compatibility but defaults to 0 (fail fast).
   */
  async getHistoricalPrices(coinId: string, days = 60, retries = 0): Promise<HistoricalPrice[]> {
    const now = Date.now();
    const key = `${coinId}-${days}`;

    // Serve cache if within the per-coin gap
    if (now - (lastHistFetchAt[key] || 0) < HIST_FETCH_MIN_GAP_MS && cachedHistData[key]?.length > 0) {
      return cachedHistData[key];
    }

    const url = `${COINGECKO_BASE_URL}/coins/${coinId}/market_chart?vs_currency=usd&days=${days}&interval=daily`;

    const data = await apiCall<CoinGeckoMarketChart>(url, retries, 2000);

    if (!data || !data.prices || data.prices.length === 0) {
      // Return cached data rather than throwing
      if (cachedHistData[key]?.length > 0) {
        console.warn(`[CoinGecko] Historical fetch failed for ${coinId} — returning cached`);
        return cachedHistData[key];
      }
      throw new Error(`No historical data for ${coinId}`);
    }

    const volumes: number[] = Array.isArray(data.total_volumes)
      ? data.total_volumes.map(([, volume]: [number, number]) => volume)
      : [];

    const historicalData = data.prices.map(([timestamp, price]: [number, number], idx: number) => ({
      timestamp,
      price,
      volume: volumes[idx] ?? 0
    }));

    lastHistFetchAt[key] = now;
    cachedHistData[key] = historicalData;
    return historicalData;
  },

  async getVolumeData(coinId: string, days = 30): Promise<number[]> {
    const url = `${COINGECKO_BASE_URL}/coins/${coinId}/market_chart?vs_currency=usd&days=${days}&interval=daily`;
    const data = await apiCall<CoinGeckoMarketChart>(url, 1, 2000);
    if (!data || !data.total_volumes || data.total_volumes.length === 0) {
      throw new Error(`No volume data for ${coinId}`);
    }
    return data.total_volumes.map(([, volume]: [number, number]) => volume);
  },

  getCoinId(symbol: string): string {
    const upperSymbol = symbol.toUpperCase();
    return CRYPTO_IDS[upperSymbol as keyof typeof CRYPTO_IDS] || symbol.toLowerCase();
  },

  getSupportedSymbols(): string[] {
    return Object.keys(CRYPTO_IDS);
  }
};
