/**
 * @cde/engine/market-data — OHLCV fetching, the asset universe, price feeds.
 * ============================================================================
 */

export type { Candle } from './services/tradeEngine';

// ── Multi-timeframe OHLCV pipeline (Bybit → Binance → skip) ──────────────────
export type {
  TimeframeKey,
  CandleSource,
  TimeframeSpec,
  CandleValidationResult,
  FetchTimeframeResult,
  LiquiditySnapshot,
  MultiTimeframeSnapshot,
  TimeframeCacheEntry,
  MarketDataStats,
  GetMarketDataOptions
} from './services/marketDataService';
export {
  TIMEFRAME_SPECS,
  TIMEFRAME_ORDER,
  validateCandles,
  dropFormingCandle,
  isAlignedToTimeframe,
  isBinanceUnlistedSymbol,
  fetchBybitKlines,
  fetchBinanceKlines,
  fetchTimeframe,
  getLiquiditySnapshots,
  clearMarketDataCache,
  exportMarketDataCache,
  importMarketDataCache,
  getMultiTimeframeData,
  getUniverseMarketData,
  fetchBacktestHistory,
  fetchFundingRates,
  clearFundingCache,
  fetchDerivativesSnapshots,
  clearDerivativesCache
} from './services/marketDataService';

// ── Cross-exchange price/candle aggregation ──────────────────────────────────
export { getAggregatedPrices, getAggregatedCandles, getAggregatorHealth } from './services/cryptoPriceAggregator';

// ── Asset universe (symbol normalization, tiers, exchange-name mapping) ─────
export type { LiquidityTier, AssetRegistryEntry } from './services/assetUniverse';
export {
  QUOTE_ASSET,
  ASSET_REGISTRY,
  normalizeSymbolInput,
  stripMultiplier,
  toBybitSymbol,
  toBaseAsset,
  resolveCoinGeckoId,
  isMappedAsset,
  isExcludedAsset,
  getAssetTier,
  INTRADAY_UNIVERSE,
  EXTENDED_INTRADAY_UNIVERSE,
  ANALYTICS_UNIVERSE,
  resolveTradingUniverse
} from './services/assetUniverse';

export { TARGET_SYMBOLS } from './shared/targetSymbols';
export { CRYPTO_IDS } from './services/coinGeckoIds';

// ── Liquid-universe computation (periodic Bybit volume sweep) ───────────────
export type { LiquidUniverseResult } from './services/symbolUniverse';
export { MIN_SPOT_VOLUME_FOR_INCLUSION, computeLiquidUniverse } from './services/symbolUniverse';
