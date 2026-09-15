
import { useQuery } from '@tanstack/react-query';
import { bybitApi } from '../services/bybitApi';
import { binancePublicApi } from '../services/binancePublicApi';
import { fearGreedApi } from '../services/fearGreedApi';
import { calculateTechnicalIndicators } from '@cde/engine/analysis';
import { generateSmartRecommendation } from '@cde/engine/analysis';
import { getAggregatedPrices } from '@cde/engine/market-data';
import { CryptoData, CryptoRecommendation, HistoricalPrice } from '@cde/engine';
import { getActiveSymbols } from '../services/liveUniverse';

export function useCryptoData() {
  // Bybit → Binance → CoinGecko, in that order, is ALREADY implemented once
  // in packages/engine/src/services/cryptoPriceAggregator.ts (the same
  // pipeline server/simEngineFactory.ts uses for the live sim bots). This
  // hook used to carry its own second copy of that exact cascade — found
  // 2026-09-15 during a cleanup pass. Consolidated onto the shared one: same
  // output shape (CryptoData[]), runs fine in the browser (fetch-only, no
  // Node-specific imports), and inherits BYBIT_TICKER_TTL (2.5s) instead of
  // drifting out of sync with the server's own freshness fix.
  const { data: cryptoData, isLoading: cryptoLoading, error: cryptoError } = useQuery({
    queryKey: ['crypto-prices'],
    queryFn: async (): Promise<CryptoData[]> => {
      const targetSymbols = await getActiveSymbols();
      const data = await getAggregatedPrices(targetSymbols);
      if (data && data.length > 0) return data;
      throw new Error('All live price sources failed (Bybit, Binance, CoinGecko)');
    },
    refetchInterval: 90 * 1000,  // 90 seconds — Bybit/Binance are fast, no need to hammer
    retry: 1,
    retryDelay: 3000,
    staleTime: 45 * 1000,
  });

  const { data: fearGreedData, isLoading: fearGreedLoading } = useQuery({
    queryKey: ['fear-greed'],
    queryFn: async () => {
      console.log('😨 Fetching live Fear & Greed index...');
      const data = await fearGreedApi.getFearGreedIndex();
      if (!data) throw new Error('Fear & Greed API failed');
      return data;
    },
    refetchInterval: 60 * 60 * 1000, // 1 hour — index barely changes
    retry: 1,
    staleTime: 30 * 60 * 1000,
  });

  const { data: recommendations, isLoading: recommendationsLoading } = useQuery({
    queryKey: ['smart-recommendations', cryptoData, fearGreedData],
    queryFn: async (): Promise<CryptoRecommendation[]> => {
      if (!cryptoData || cryptoData.length === 0 || !fearGreedData) return [];

      console.log('🧠 Generating smart recommendations for', cryptoData.length, 'cryptocurrencies...');

      const recommendations: CryptoRecommendation[] = [];

      // Process top 5 coins to avoid overwhelming the system
      for (let i = 0; i < Math.min(cryptoData.length, 5); i++) {
        const crypto = cryptoData[i];

        try {
          console.log(`🔍 Processing ${crypto.symbol}... (${i + 1}/${Math.min(cryptoData.length, 5)})`);

          let historicalData: HistoricalPrice[] = [];
          let volumes: number[] = [];

          // 1) Try Bybit klines first
          try {
            const bybitSymbol = bybitApi.getBybitSymbol(crypto.symbol);
            const bybitKlineData = await Promise.race([
              bybitApi.getKlineData(bybitSymbol, 'D', 30),
              new Promise<null>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 4000))
            ]);

            if (bybitKlineData && bybitKlineData.length > 0) {
              historicalData = bybitKlineData.map(kline => ({
                timestamp: parseInt(kline.openTime),
                price: parseFloat(kline.close),
                volume: parseFloat(kline.volume)
              }));
              volumes = bybitKlineData.map(kline => parseFloat(kline.volume));
            }
          } catch { /* fall through to Binance */ }

          // 2) Try Binance klines if Bybit failed
          if (historicalData.length === 0) {
            try {
              const bklines = await Promise.race([
                binancePublicApi.getKlines(crypto.symbol, '1d', 30),
                new Promise<null>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 4000))
              ]);
              if (bklines && bklines.length > 0) {
                historicalData = bklines.map(k => ({
                  timestamp: k.timestamp,
                  price: k.close,
                  volume: k.volume
                }));
                volumes = bklines.map(k => k.volume);
              }
            } catch { /* fall through */ }
          }

          if (historicalData.length === 0) {
            console.warn(`No live kline data for ${crypto.symbol}, skipping`);
            continue;
          }

          const indicators = calculateTechnicalIndicators(historicalData, volumes);
          const recommendation = generateSmartRecommendation({
            cryptoData: crypto,
            indicators,
            fearGreedIndex: fearGreedData,
            marketCap: crypto.market_cap || 0,
            volume24h: crypto.total_volume || 0
          });

          recommendations.push(recommendation);

        } catch (error) {
          // Fallback recommendation with basic data
          recommendations.push({
            symbol: crypto.symbol.toUpperCase(),
            recommendation: 'hold' as const,
            confidence: 50,
            reasoning: `המתנה מומלצת עבור ${crypto.symbol.toUpperCase()} בשל מחסור בנתונים`,
            indicators: {
              rsi: 50,
              ma20: crypto.current_price,
              volumeTrend: 'stable' as const,
              bollingerBands: {
                upper: crypto.current_price * 1.02,
                middle: crypto.current_price,
                lower: crypto.current_price * 0.98,
                position: 'between' as const
              },
              volumeProfile: {
                poc: crypto.current_price,
                valueAreaHigh: crypto.current_price * 1.01,
                valueAreaLow: crypto.current_price * 0.99,
                position: 'in_value_area' as const
              }
            },
            currentPrice: crypto.current_price,
            priceChange24h: crypto.price_change_percentage_24h || 0,
            suggestedAmounts: { usd: 100, crypto: 100 / crypto.current_price },
            riskLevel: 'medium' as const,
            timeframe: 'medium' as const
          });
        }

        // Small pause between coins to be kind to the APIs
        if (i < Math.min(cryptoData.length, 5) - 1) {
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }

      return recommendations;
    },
    enabled: !!cryptoData && cryptoData.length > 0 && !!fearGreedData,
    retry: 1,
    staleTime: 5 * 60 * 1000,
  });

  const hasCrypto = Array.isArray(cryptoData) && cryptoData.length > 0;
  const hasRecommendations = Array.isArray(recommendations) && recommendations.length > 0;

  return {
    cryptoData: cryptoData || [],
    fearGreedData,
    recommendations: recommendations || [],
    isLoading: (cryptoLoading && !hasCrypto) || (recommendationsLoading && !hasRecommendations),
    error: cryptoError
  };
}
