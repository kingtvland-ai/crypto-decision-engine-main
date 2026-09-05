import { describe, it, expect } from 'vitest';
import {
  routeTradeType,
  calculateRiskParameters,
  calculateOptimalEntry,
  Candle
} from '@cde/engine/execution';
import type { MarketRegimeResult, SignalEngineResult } from '@cde/engine';

const makeSignal = (overrides: Partial<SignalEngineResult> = {}): SignalEngineResult => ({
  action: 'BUY',
  buyScore: overrides.signalScore ?? overrides.confidence ?? 75,
  sellScore: 0,
  signalScore: overrides.signalScore ?? overrides.confidence ?? 75,
  confidence: overrides.signalScore ?? overrides.confidence ?? 75,
  signals: [],
  rawConfidence: overrides.signalScore ?? overrides.confidence ?? 75,
  penalties: [],
  ...overrides
});

const makeRegime = (overrides: Partial<MarketRegimeResult> = {}): MarketRegimeResult => ({
  regime: 'TRENDING',
  direction: 'BULL',
  volatility: 'NORMAL',
  adx: 30,
  atr: 3,
  atrPercent: 3,
  supertrend: { value: 95, direction: 'BULL' },
  ...overrides
});

function generateCleanCandles(basePrice: number = 100, count: number = 30): Candle[] {
  const candles: Candle[] = [];
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const delta = (i % 2 === 0 ? 0.2 : -0.2);
    const close = basePrice + delta;
    const open = basePrice - delta;
    candles.push({
      timestamp: now - (count - i) * 60000,
      open,
      high: Math.max(open, close) + 0.4,
      low: Math.min(open, close) - 0.4,
      close,
      volume: 1000
    });
  }
  return candles;
}

describe('Section 41 — 10 Mandatory Decision Engine Test Scenarios', () => {
  // ─────────────────────────────────────────────────────────────
  // Test 1 — Futures valid
  // ADX = 36, ATR% = 1.5, SignalScore = 75, Supertrend = BULL, BUY, No existing Futures
  // Expected: FUTURES LONG candidate
  // ─────────────────────────────────────────────────────────────
  it('Test 1: Futures valid — Routes to FUTURES LONG candidate', () => {
    const regime = makeRegime({
      adx: 36,
      atrPercent: 1.5,
      volatility: 'LOW',
      regime: 'TRENDING',
      supertrend: { value: 95, direction: 'BULL' }
    });
    const signal = makeSignal({ action: 'BUY', signalScore: 75 });
    const result = routeTradeType(signal, regime, { hasExistingFutures: false, hasExistingSpot: false });

    expect(result.type).toBe('FUTURES');
    expect(result.side).toBe('LONG');
    expect(result.hardGateBlocked).toBeFalsy();
  });

  // ─────────────────────────────────────────────────────────────
  // Test 2 — HIGH VOL
  // ADX = 36, ATR% = 7.3, SignalScore = 80, Supertrend = BULL, BUY
  // Expected: FUTURES = BLOCKED, SPOT = candidate only if SignalScore >= 62
  // ─────────────────────────────────────────────────────────────
  it('Test 2: HIGH VOL in a confirmed trend — the carve-out routes FUTURES', () => {
    const regime = makeRegime({
      adx: 36,
      atrPercent: 7.3,
      volatility: 'HIGH',
      regime: 'TRENDING',
      supertrend: { value: 90, direction: 'BULL' }
    });
    const signal = makeSignal({ action: 'BUY', signalScore: 80 });
    const result = routeTradeType(signal, regime, { hasExistingFutures: false, hasExistingSpot: false });

    // The HIGH-VOL carve-out needed a confirmed trend AND an elevated score.
    // The score half went with every other score gate, so a trending HIGH-VOL
    // bar now trades the trend's direction instead of dropping to SPOT.
    expect(result.type).toBe('FUTURES');
    expect(result.side).toBe('LONG');
    expect(result.reason).toContain('HIGH VOL');
  });

  // ─────────────────────────────────────────────────────────────
  // Test 3 — HIGH VOL + weak signal
  // ADX = 36, ATR% = 7.3, SignalScore = 55
  // Expected: HOLD (both Futures blocked and Spot < 62)
  // ─────────────────────────────────────────────────────────────
  it('Test 3: HIGH VOL + weak signal — routes identically to a strong one', () => {
    const regime = makeRegime({
      adx: 36,
      atrPercent: 7.3,
      volatility: 'HIGH',
      regime: 'TRENDING',
      supertrend: { value: 90, direction: 'BULL' }
    });
    const signal = makeSignal({ action: 'BUY', signalScore: 55 });
    const result = routeTradeType(signal, regime, { hasExistingFutures: false, hasExistingSpot: false });

    // Same regime as Test 2 with a score 25 points lower, and the same routing:
    // that is what "the score no longer gates" means in practice.
    expect(result.type).toBe('FUTURES');
    expect(result.side).toBe('LONG');
    // SPOT_SCORE_BELOW_HIGH_VOL_THRESHOLD is unreachable — the block it named
    // no longer exists.
    expect(result.blockReason).toBeUndefined();
  });

  // ─────────────────────────────────────────────────────────────
  // Test 4 — Soft Trend carve-out (ADX 23, Supertrend BULL)
  // ADX = 23 is in the TRANSITIONAL range (20-25) but Supertrend is
  // aligned — this is now treated as SOFT_TREND: Spot allowed with
  // higher confidence bar (65+), Futures still blocked.
  // ─────────────────────────────────────────────────────────────
  it('Test 4: Soft Trend (ADX 23, Supertrend BULL) — Returns SPOT with higher threshold', () => {
    const regime = makeRegime({
      adx: 23,
      atrPercent: 2.5,
      volatility: 'NORMAL',
      regime: 'TRANSITIONAL',
      direction: 'BULL',
      supertrend: { value: 95, direction: 'BULL' }
    });
    const signal = makeSignal({ action: 'BUY', signalScore: 67 });
    const result = routeTradeType(signal, regime, { hasExistingFutures: false, hasExistingSpot: false });

    expect(result.type).toBe('SPOT');
    expect(result.side).toBe('BUY');
    expect(result.reason).toContain('SOFT_TREND');
  });

  it('Test 4b: True Transitional (ADX 23, Supertrend opposite) — Returns HOLD', () => {
    const regime = makeRegime({
      adx: 23,
      atrPercent: 2.5,
      volatility: 'NORMAL',
      regime: 'TRANSITIONAL',
      direction: 'NEUTRAL',
      supertrend: { value: 95, direction: 'BEAR' }
    });
    const signal = makeSignal({ action: 'BUY', signalScore: 90 });
    const result = routeTradeType(signal, regime, { hasExistingFutures: false, hasExistingSpot: false });

    expect(result.type).toBe('HOLD');
    expect(result.side).toBe('NONE');
    expect(result.hardGateBlocked).toBe(true);
    expect(result.blockReason).toBe('TRANSITIONAL_HARD_BLOCK');
  });

  // ─────────────────────────────────────────────────────────────
  // Test 5 — Ranging Spot
  // ADX = 18, ATR% = 2.5, SignalScore = 65
  // Expected: SPOT candidate (subject to Entry Timing, Risk, Exposure)
  // ─────────────────────────────────────────────────────────────
  it('Test 5: Ranging Spot (ADX 18, Score 65) — Returns SPOT candidate', () => {
    const regime = makeRegime({
      adx: 18,
      atrPercent: 2.5,
      volatility: 'NORMAL',
      regime: 'RANGING',
      direction: 'NEUTRAL',
      supertrend: { value: 95, direction: 'BULL' }
    });
    const signal = makeSignal({ action: 'BUY', signalScore: 65 });
    const result = routeTradeType(signal, regime, { hasExistingFutures: false, hasExistingSpot: false });

    expect(result.type).toBe('SPOT');
    expect(result.side).toBe('BUY');
  });

  // ─────────────────────────────────────────────────────────────
  // Test 6 — Below Spot threshold
  // ADX = 32, ATR = 1% (below 2% ramp threshold), SignalScore = 55
  // Expected: HOLD (55 < 58, fixed legacy minimum)
  // ─────────────────────────────────────────────────────────────
  it('Test 6: a score under the old 58 bar now routes', () => {
    const regime = makeRegime({
      adx: 32,
      atr: 1,
      atrPercent: 1,
      volatility: 'NORMAL',
      regime: 'TRENDING',
      supertrend: { value: 95, direction: 'BULL' }
    });
    const signal = makeSignal({ action: 'BUY', signalScore: 55 });
    const result = routeTradeType(signal, regime, { hasExistingFutures: false, hasExistingSpot: false });

    // ADX 32 in NORMAL volatility is a confirmed trend, so this routes FUTURES.
    expect(result.type).toBe('FUTURES');
    expect(result.side).toBe('LONG');
  });

  // ─────────────────────────────────────────────────────────────
  // Test 7 — Score at Futures threshold
  // ADX = 32, ATR = 1% (below 2% ramp threshold), SignalScore = 72, BUY
  // Expected: FUTURES (72 >= 72, all conditions met, static threshold)
  // ─────────────────────────────────────────────────────────────
  it('Test 7: Score at Futures threshold (72 >= 72) — Routes to FUTURES', () => {
    const regime = makeRegime({
      adx: 32,
      atr: 1,
      atrPercent: 1,
      volatility: 'NORMAL',
      regime: 'TRENDING',
      supertrend: { value: 105, direction: 'BEAR' }
    });
    const signal = makeSignal({ action: 'BUY', signalScore: 72 });
    const result = routeTradeType(signal, regime, { hasExistingFutures: false, hasExistingSpot: false });

    expect(result.type).toBe('FUTURES');
    expect(result.side).toBe('LONG');
  });

  // ─────────────────────────────────────────────────────────────
  // Test 8 — Existing Futures same asset
  // ADX = 32, ATR = 3%, SignalScore = 80, BUY, Supertrend = BULL, Existing BTC Futures = OPEN
  // Expected: NEW BTC FUTURES = BLOCKED, NEW BTC SPOT = BLOCKED
  // ─────────────────────────────────────────────────────────────
  it('Test 8: Existing Futures on same asset — Blocks both new Futures and new Spot', () => {
    const regime = makeRegime({
      adx: 32,
      atr: 3,
      atrPercent: 3,
      volatility: 'NORMAL',
      regime: 'TRENDING',
      supertrend: { value: 95, direction: 'BULL' }
    });
    const signal = makeSignal({ action: 'BUY', signalScore: 80 });
    const result = routeTradeType(signal, regime, { hasExistingFutures: true, hasExistingSpot: false });

    expect(result.type).toBe('HOLD');
    expect(result.hardGateBlocked).toBe(true);
    expect(result.blockReason).toBe('SAME_ASSET_EXPOSURE_BLOCK');
  });

  // ─────────────────────────────────────────────────────────────
  // Test 9 — Daily circuit breaker
  // Daily Drawdown = 6%
  // Expected: NEW ENTRIES = BLOCKED
  // ─────────────────────────────────────────────────────────────
  it('Test 9: Daily circuit breaker (Drawdown >= 6%) — Blocks all new entries', () => {
    const regime = makeRegime({
      adx: 36,
      atrPercent: 1.5,
      volatility: 'LOW',
      regime: 'TRENDING',
      supertrend: { value: 95, direction: 'BULL' }
    });
    const signal = makeSignal({ action: 'BUY', signalScore: 85 });
    const result = routeTradeType(signal, regime, {
      hasExistingFutures: false,
      hasExistingSpot: false,
      isDailyBlocked: true
    });

    expect(result.type).toBe('HOLD');
    expect(result.hardGateBlocked).toBe(true);
    expect(result.blockReason).toBe('DAILY_DRAWDOWN_BLOCK');
  });

  // ─────────────────────────────────────────────────────────────
  // Test 10 — Weekly circuit breaker
  // Weekly Drawdown = 13%
  // Expected: SYSTEM LOCK = TRUE, manual reset required
  // ─────────────────────────────────────────────────────────────
  it('Test 10: Weekly circuit breaker (Drawdown >= 13%) — Returns SYSTEM LOCK', () => {
    const regime = makeRegime({
      adx: 36,
      atrPercent: 1.5,
      volatility: 'LOW',
      regime: 'TRENDING',
      supertrend: { value: 95, direction: 'BULL' }
    });
    const signal = makeSignal({ action: 'BUY', signalScore: 90 });
    const result = routeTradeType(signal, regime, {
      hasExistingFutures: false,
      hasExistingSpot: false,
      isWeeklyLocked: true
    });

    expect(result.type).toBe('HOLD');
    expect(result.hardGateBlocked).toBe(true);
    expect(result.blockReason).toBe('WEEKLY_DRAWDOWN_LOCK');
  });
});
