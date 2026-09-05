import { describe, it, expect } from 'vitest';
import { routeTradeType } from '@cde/engine/execution';
import type { MarketRegimeResult, SignalEngineResult } from '@cde/engine';

const makeSignal = (overrides: Partial<SignalEngineResult> = {}): SignalEngineResult => ({
  action: 'HOLD',
  buyScore: overrides.signalScore ?? overrides.confidence ?? 50,
  sellScore: 0,
  signalScore: overrides.signalScore ?? overrides.confidence ?? 50,
  confidence: overrides.signalScore ?? overrides.confidence ?? 50,
  signals: [],
  rawConfidence: overrides.signalScore ?? overrides.confidence ?? 50,
  penalties: [],
  ...overrides
});

const makeRegime = (overrides: Partial<MarketRegimeResult> = {}): MarketRegimeResult => ({
  regime: 'TRENDING',
  direction: 'BULL',
  volatility: 'NORMAL',
  adx: 30,
  atr: 1,
  atrPercent: 2.5,
  supertrend: { value: 90, direction: 'BULL' },
  ...overrides
});

describe('routeTradeType', () => {
  const trendingLayer0 = makeRegime({ regime: 'TRENDING', direction: 'BULL', volatility: 'NORMAL', adx: 30, atrPercent: 2.5, supertrend: { value: 90, direction: 'BULL' } });
  const trendingBearLayer0 = makeRegime({ regime: 'TRENDING', direction: 'BEAR', volatility: 'NORMAL', adx: 30, atrPercent: 2.5, supertrend: { value: 110, direction: 'BEAR' } });
  const rangingLayer0 = makeRegime({ regime: 'RANGING', direction: 'NEUTRAL', volatility: 'LOW', adx: 15, atrPercent: 1.5 });
  const transitionalLayer0 = makeRegime({ regime: 'TRANSITIONAL', direction: 'BULL', volatility: 'NORMAL', adx: 22, atrPercent: 2.5 });

  it('returns HOLD when action is HOLD', () => {
    const result = routeTradeType(makeSignal({ action: 'HOLD', signalScore: 75 }), trendingLayer0);
    expect(result.type).toBe('HOLD');
  });

  it('routes a low score that the old 58 bar refused', () => {
    // The score gates were removed: they refused 87.7% of bars while the
    // survivors won 43.3% of the time. Regime and direction decide now.
    const result = routeTradeType(makeSignal({ action: 'BUY', signalScore: 50 }), trendingLayer0);
    expect(result.type).toBe('FUTURES');
  });

  it('routes to FUTURES LONG when all conditions met (Score >= 72)', () => {
    const result = routeTradeType(makeSignal({ action: 'BUY', signalScore: 75 }), trendingLayer0);
    expect(result.type).toBe('FUTURES');
    expect(result.side).toBe('LONG');
  });

  it('routes to FUTURES SHORT for SELL signal when Supertrend matches BEAR', () => {
    const result = routeTradeType(makeSignal({ action: 'SELL', signalScore: 75 }), trendingBearLayer0);
    expect(result.type).toBe('FUTURES');
    expect(result.side).toBe('SHORT');
  });

  it('blocks when existing futures position on same asset', () => {
    const result = routeTradeType(makeSignal({ action: 'BUY', signalScore: 75 }), trendingLayer0, { hasExistingFutures: true });
    expect(result.type).toBe('HOLD');
    expect(result.hardGateBlocked).toBe(true);
  });

  it('does not route to FUTURES when ADX <= 25 (Transitional block)', () => {
    const result = routeTradeType(makeSignal({ action: 'BUY', signalScore: 75 }), transitionalLayer0);
    expect(result.type).toBe('HOLD');
    expect(result.blockReason).toBe('TRANSITIONAL_HARD_BLOCK');
  });

  it('routes to SPOT in RANGING regime when Score >= 60', () => {
    const result = routeTradeType(makeSignal({ action: 'BUY', signalScore: 65 }), rangingLayer0);
    expect(result.type).toBe('SPOT');
    expect(result.side).toBe('BUY');
  });

  it('blocks SPOT/FUTURES in TRANSITIONAL regime when score is below the high-confidence bar', () => {
    const result = routeTradeType(makeSignal({ action: 'BUY', signalScore: 65 }), transitionalLayer0);
    expect(result.type).toBe('HOLD');
    expect(result.hardGateBlocked).toBe(true);
  });

  it('no longer lets a high score buy its way past the TRANSITIONAL block', () => {
    // The carve-out used to open on `adx > 22 || score >= 80`. The ADX half is
    // a judgement about the market and stays; the score half was an escape
    // hatch for the very filter that was removed, so it went with it.
    const result = routeTradeType(makeSignal({ action: 'BUY', signalScore: 80 }), transitionalLayer0);
    expect(result.type).toBe('HOLD');
  });

  it('takes the HIGH-VOL carve-out in a confirmed trend', () => {
    // The carve-out required a confirmed trend AND an elevated score. The trend
    // half remains; with the score half gone a trending HIGH-VOL bar now routes
    // FUTURES in the trend's direction rather than dropping to SPOT.
    const highVolRegime = makeRegime({ regime: 'TRENDING', volatility: 'HIGH', atrPercent: 6.5, adx: 30 });
    const result = routeTradeType(makeSignal({ action: 'BUY', signalScore: 72 }), highVolRegime);
    expect(result.type).toBe('FUTURES');
    expect(result.side).toBe('LONG');
  });

  it('treats a weak score in HIGH VOL exactly like a strong one', () => {
    // SPOT_SCORE_BELOW_HIGH_VOL_THRESHOLD is unreachable now: the block it
    // reported no longer exists. Same regime, half the score, same routing.
    const highVolRegime = makeRegime({ regime: 'TRENDING', volatility: 'HIGH', atrPercent: 6.5, adx: 30 });
    const result = routeTradeType(makeSignal({ action: 'BUY', signalScore: 55 }), highVolRegime);
    expect(result.type).toBe('FUTURES');
    expect(result.blockReason).toBeUndefined();
  });
});
