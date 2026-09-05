/**
 * TradeEngine — shared technical-analysis and execution primitives.
 * ============================================================================
 *
 * This file used to ALSO hold the Legacy simulation bot's own decision engine
 * (its signal scoring, its trade router, its entry-timing filter, its risk
 * sizing, its exit rules). The Legacy bot has been deleted, and none of that
 * logic survived the deletion — it belonged to that bot alone.
 *
 * What remains here is genuinely shared: candle-math primitives
 * (EMA/ATR/ADX/Supertrend, and the regime classifier built from them) used by
 * the Path bot's study and by other engines, plus the fee/slippage/fill-price
 * arithmetic every simulated bot's order-execution layer draws from.
 */

import {
  MarketRegimeResult,
  MarketRegimeType,
  MarketDirectionType,
  VolatilityRegimeType
} from '../types/crypto';

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface PortfolioRiskStats {
  portfolioValue: number;
  initialAmount: number;
  dailyDrawdownPercent: number;
  weeklyDrawdownPercent: number;
  openPositionsCount: number;
  openFuturesPositionsCount: number;
  totalLeveragedExposureUsd: number;
  /** Current notional exposure per asset (symbol -> notional USD). Optional:
   *  callers that do not track per-asset exposure (backtests, the decision-
   *  funnel script) simply get no per-asset cap rather than a type error. */
  existingExposureByAsset?: Record<string, number>;
  systemLocked?: boolean;
  lockReason?: string;
  lockedAt?: number;
}

/**
 * A closed trade, for post-hoc statistics (win rate, R-multiples, streak
 * cooldowns). Pure data — no engine-specific logic reads or writes it, so it
 * stayed here as a shared shape rather than following the Legacy engine out.
 */
export interface ClosedTradeMetric {
  pnl: number;
  /** Fill timestamp. Optional for backward compatibility, but supply it:
   *  callers that order history by it get it backwards otherwise. */
  at?: number;
  /** Capital at risk when the position was OPENED: |entryPrice - stopLoss| ×
   *  quantity (× leverage for Futures). Snapshot at entry, never recomputed —
   *  a stop that has since trailed is the wrong denominator for what the
   *  trade actually risked. */
  riskUsd?: number;
}

// ═══════════════════════════════════════════════════════
// DYNAMIC PRICE PRECISION UTILITY
// ═══════════════════════════════════════════════════════

/**
 * Formats a price or numeric value with dynamic precision according to its magnitude
 * Ensures low-cost meme coins (e.g. FLOKI, PEPE, SHIB) and small values remain readable
 */
export function formatDynamicPrice(price: number): string {
  if (price === 0 || isNaN(price)) return '0.00';
  const abs = Math.abs(price);
  if (abs >= 1000) return price.toFixed(2);
  if (abs >= 1) return price.toFixed(4);
  if (abs >= 0.01) return price.toFixed(6);
  if (abs >= 0.0001) return price.toFixed(8);
  return price.toFixed(10);
}

// ═══════════════════════════════════════════════════════
// TECHNICAL INDICATOR UTILITIES (Clean Math)
// ═══════════════════════════════════════════════════════

/**
 * Calculates EMA series
 */
export function calculateEMA(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const ema: number[] = [];

  // First point SMA
  let sum = 0;
  const initialCount = Math.min(period, values.length);
  for (let i = 0; i < initialCount; i++) {
    sum += values[i];
  }
  ema.push(sum / initialCount);

  for (let i = 1; i < values.length; i++) {
    const current = values[i] * k + ema[i - 1] * (1 - k);
    ema.push(current);
  }
  return ema;
}

/**
 * Calculates Average True Range (ATR)
 */
export function calculateATR(candles: Candle[], period: number = 14): { atr: number; atrPercent: number; trSeries: number[] } {
  if (candles.length < 2) {
    const defaultAtr = candles[0]?.close ? candles[0].close * 0.02 : 1;
    return { atr: defaultAtr, atrPercent: 2.0, trSeries: [defaultAtr] };
  }

  const trSeries: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      trSeries.push(candles[i].high - candles[i].low);
    } else {
      const highLow = candles[i].high - candles[i].low;
      const highClose = Math.abs(candles[i].high - candles[i - 1].close);
      const lowClose = Math.abs(candles[i].low - candles[i - 1].close);
      trSeries.push(Math.max(highLow, highClose, lowClose));
    }
  }

  // Wilder's smoothing
  let atr = trSeries.slice(0, Math.min(period, trSeries.length)).reduce((a, b) => a + b, 0) / Math.min(period, trSeries.length);
  for (let i = period; i < trSeries.length; i++) {
    atr = (atr * (period - 1) + trSeries[i]) / period;
  }

  const currentPrice = candles[candles.length - 1].close || 1;
  const atrPercent = (atr / currentPrice) * 100;

  return { atr, atrPercent, trSeries };
}

/**
 * Calculates ADX (Average Directional Index)
 */
export function calculateADX(candles: Candle[], period: number = 14): number {
  if (candles.length < period + 1) return 22; // default transitional

  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const tr: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;

    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);

    const hl = candles[i].high - candles[i].low;
    const hc = Math.abs(candles[i].high - candles[i - 1].close);
    const lc = Math.abs(candles[i].low - candles[i - 1].close);
    tr.push(Math.max(hl, hc, lc));
  }

  if (tr.length < period) return 22;

  // Initial smoothed values
  let smoothedTR = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothedPlusDM = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothedMinusDM = minusDM.slice(0, period).reduce((a, b) => a + b, 0);

  const dxValues: number[] = [];

  for (let i = period; i < tr.length; i++) {
    smoothedTR = smoothedTR - smoothedTR / period + tr[i];
    smoothedPlusDM = smoothedPlusDM - smoothedPlusDM / period + plusDM[i];
    smoothedMinusDM = smoothedMinusDM - smoothedMinusDM / period + minusDM[i];

    const plusDI = smoothedTR === 0 ? 0 : (smoothedPlusDM / smoothedTR) * 100;
    const minusDI = smoothedTR === 0 ? 0 : (smoothedMinusDM / smoothedTR) * 100;
    const diSum = plusDI + minusDI;
    const dx = diSum === 0 ? 0 : (Math.abs(plusDI - minusDI) / diSum) * 100;
    dxValues.push(dx);
  }

  if (dxValues.length === 0) return 22;
  const adx = dxValues.slice(-period).reduce((a, b) => a + b, 0) / Math.min(period, dxValues.length);
  return Number(adx.toFixed(2));
}

/**
 * Calculates Supertrend(10, 3)
 */
export function calculateSupertrend(candles: Candle[], period: number = 10, multiplier: number = 3): { value: number; direction: 'BULL' | 'BEAR' } {
  if (candles.length < period) {
    const lastPrice = candles[candles.length - 1]?.close || 100;
    return { value: lastPrice * 0.98, direction: 'BULL' };
  }

  const { trSeries } = calculateATR(candles, period);

  // ATR=0 (e.g. every candle has the same close — a very flat/illiquid market)
  // collapses both bands to hl2, which flips BULL/BEAR on any tiny price
  // noise around that single point. Not a divide-by-zero (there is none in
  // this function), just a degenerate case worth short-circuiting cleanly.
  if (trSeries.every((tr) => tr === 0)) {
    const lastPrice = candles[candles.length - 1].close;
    return { value: lastPrice, direction: 'BULL' };
  }

  let upperBand = 0;
  let lowerBand = 0;
  let supertrend = 0;
  let direction: 'BULL' | 'BEAR' = 'BULL';

  // Calculate rolling ATR
  for (let i = period - 1; i < candles.length; i++) {
    const sliceTR = trSeries.slice(i - period + 1, i + 1);
    const currentATR = sliceTR.reduce((a, b) => a + b, 0) / period;
    const hl2 = (candles[i].high + candles[i].low) / 2;

    const basicUpper = hl2 + multiplier * currentATR;
    const basicLower = hl2 - multiplier * currentATR;

    if (i === period - 1) {
      upperBand = basicUpper;
      lowerBand = basicLower;
      supertrend = basicLower;
      direction = 'BULL';
      continue;
    }

    // Upper band logic
    upperBand = (basicUpper < upperBand || candles[i - 1].close > upperBand) ? basicUpper : upperBand;
    // Lower band logic
    lowerBand = (basicLower > lowerBand || candles[i - 1].close < lowerBand) ? basicLower : lowerBand;

    const prevSupertrend = supertrend;
    if (prevSupertrend === upperBand) {
      direction = candles[i].close > upperBand ? 'BULL' : 'BEAR';
    } else {
      direction = candles[i].close < lowerBand ? 'BEAR' : 'BULL';
    }

    supertrend = direction === 'BULL' ? lowerBand : upperBand;
  }

  return { value: Number(supertrend.toFixed(6)), direction };
}

// ═══════════════════════════════════════════════════════
// MARKET REGIME DETECTION
// ═══════════════════════════════════════════════════════

export function detectMarketRegime(candles: Candle[], currentPrice: number): MarketRegimeResult {
  const adx = calculateADX(candles, 14);
  const { atr, atrPercent } = calculateATR(candles, 14);
  const supertrend = calculateSupertrend(candles, 10, 3);

  // 1. ADX(14) Classification:
  // ADX > 25 -> TRENDING
  // ADX < 20 -> RANGING
  // 20 <= ADX <= 25 -> TRANSITIONAL
  let regime: MarketRegimeType;
  if (adx > 25) {
    regime = 'TRENDING';
  } else if (adx < 20) {
    regime = 'RANGING';
  } else {
    regime = 'TRANSITIONAL';
  }

  // 2. Supertrend(10, 3):
  // Supertrend below price -> BULL
  // Supertrend above price -> BEAR
  const isSupertrendBullish = currentPrice >= supertrend.value;
  const direction: MarketDirectionType = regime === 'RANGING'
    ? 'NEUTRAL'
    : (isSupertrendBullish ? 'BULL' : 'BEAR');

  // 3. Volatility Regime (ATR%):
  // ATR% < 2% -> LOW
  // 2% <= ATR% <= 5% -> NORMAL
  // ATR% > 5% -> HIGH
  let volatility: VolatilityRegimeType;
  if (atrPercent < 2.0) {
    volatility = 'LOW';
  } else if (atrPercent <= 5.0) {
    volatility = 'NORMAL';
  } else {
    volatility = 'HIGH';
  }

  return {
    regime,
    direction,
    volatility,
    adx,
    atr,
    atrPercent: Number(atrPercent.toFixed(2)),
    supertrend: {
      value: supertrend.value,
      direction: isSupertrendBullish ? 'BULL' : 'BEAR'
    }
  };
}

// ═══════════════════════════════════════════════════════
// LIQUIDITY / VOLUME
// ═══════════════════════════════════════════════════════

export function computeRelativeVolume(candles: Candle[], lookback: number = 20, now: number = Date.now()): number | undefined {
  if (!candles || candles.length < lookback + 1) return undefined;

  const history = candles.slice(-(lookback + 1), -1);
  const avg = history.reduce((sum, c) => sum + (c.volume || 0), 0) / history.length;
  if (!(avg > 0)) return undefined;

  const last = candles[candles.length - 1];
  if (!(last.volume > 0)) return 0;

  // Median bar spacing — robust to the odd gap a median tolerates and a mean
  // does not.
  const gaps: number[] = [];
  for (let i = candles.length - Math.min(candles.length, 11); i < candles.length; i++) {
    if (i > 0) gaps.push(candles[i].timestamp - candles[i - 1].timestamp);
  }
  gaps.sort((a, b) => a - b);
  const interval = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;

  let volume = last.volume;
  if (interval > 0) {
    const elapsed = now - last.timestamp;
    if (elapsed > 0 && elapsed < interval) {
      const fraction = Math.max(0.15, elapsed / interval);
      volume = last.volume / fraction;
    }
  }

  return volume / avg;
}

/** Below this multiple of average volume an entry is refused: a pullback
 *  nobody is trading into is not support, it is the absence of a bid. */
export const MIN_ENTRY_RELATIVE_VOLUME = 0.6;

// ═══════════════════════════════════════════════════════
// FEES / SLIPPAGE / FILL PRICING
// ═══════════════════════════════════════════════════════

export const BYBIT_FEES = {
  spot: {
    maker: 0.001, // 0.1%
    taker: 0.001  // 0.1%
  },
  futures: {
    maker: 0.0002, // 0.02%
    taker: 0.00055 // 0.055%
  }
};

/**
 * Calculates trading fee for order
 */
/** The fee percentage BYBIT_FEES already represents (spot, 0.1%). A configured
 *  feePercent is read RELATIVE to this: it scales every rate in the table by
 *  the same factor rather than flattening them to one number, so the
 *  maker/taker split and the spot/futures ratio the cost model depends on
 *  survive the override. At the default 0.1 the factor is exactly 1 and no
 *  rate moves. */
export const FEE_REFERENCE_PERCENT = BYBIT_FEES.spot.taker * 100;

export function calculateTradingFee(
  usdValue: number,
  tradeType: 'SPOT' | 'FUTURES',
  isTaker: boolean = true,
  /** Simulation cost override, as a percentage (SimBotConfig.feePercent).
   *  Omit for the exchange's real schedule. */
  feePercent?: number
): number {
  const rate = tradeType === 'SPOT'
    ? (isTaker ? BYBIT_FEES.spot.taker : BYBIT_FEES.spot.maker)
    : (isTaker ? BYBIT_FEES.futures.taker : BYBIT_FEES.futures.maker);
  const scale = typeof feePercent === 'number' && Number.isFinite(feePercent) && feePercent >= 0
    ? feePercent / FEE_REFERENCE_PERCENT
    : 1;
  return usdValue * rate * scale;
}

/** Floor of the simulated slippage band, in percent. The band runs from this
 *  value to three times it, which at the default 0.05 reproduces the 0.05%-
 *  0.15% range this function has always drawn from. */
export const DEFAULT_SLIPPAGE_PERCENT = 0.05;

/**
 * Draws simulation slippage from a band running from `basePercent` to 3x it
 * — 0.05%-0.15% at the default, which is where this number has always come
 * from. `basePercent` is SimBotConfig.slippagePercent: raising it widens and
 * shifts the whole band rather than adding a constant, so a market modelled as
 * twice as thin costs twice as much on both the good and the bad fills.
 */
export function simulateSlippage(
  marketPrice: number,
  side: 'BUY' | 'SELL' | 'LONG' | 'SHORT',
  basePercent: number = DEFAULT_SLIPPAGE_PERCENT
): { fillPrice: number; slippagePercent: number } {
  const base = Number.isFinite(basePercent) && basePercent >= 0 ? basePercent : DEFAULT_SLIPPAGE_PERCENT;
  const slipPercent = base + Math.random() * base * 2;
  const multiplier = (side === 'BUY' || side === 'LONG') ? (1 + slipPercent / 100) : (1 - slipPercent / 100);
  const fillPrice = marketPrice * multiplier;
  return { fillPrice, slippagePercent: slipPercent };
}

/**
 * Computes break-even price including round-trip fees
 */
export function calculateBreakEvenPrice(entryPrice: number, tradeType: 'SPOT' | 'FUTURES', isLong: boolean = true): number {
  const roundTripFeeRate = tradeType === 'SPOT' ? 0.002 : 0.0011; // 2x taker
  return isLong
    ? entryPrice * (1 + roundTripFeeRate)
    : entryPrice * (1 - roundTripFeeRate);
}
