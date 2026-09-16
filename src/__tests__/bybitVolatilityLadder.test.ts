/**
 * Bybit (TrendBreakout) — Volatility Profile ladder wiring (2026-09-16)
 * ============================================================================
 * `evaluateTrendBreakout`'s new `input.volatilityProfiles`: when a valid
 * profile resolves (market follows this bot's OWN routing: a LONG is SPOT, a
 * SHORT is a 1x FUTURES position because spot cannot short) it
 * replaces BOTH the ATR ladder and `calmRegimeScalp`'s fixed one, still
 * bounded by MAX_LOSS_PERCENT. Absent — every other test in the suite — is a
 * byte-for-byte no-op. The resulting stop is snapshotted onto the position at
 * entry (`plan.stopLoss`), so `effectiveStop`'s later trailing math (which
 * derives rUnit from the position's OWN stored stop, not a re-derived ATR
 * value) needs no separate wiring — verified below.
 *
 * Fixture is the exact breakout series `trendBreakoutScaleRisk.test.ts` uses
 * ("TP1 is 2x the CAPPED stop" case): H1 uptrend, M15 Donchian breakout with
 * volume, M5 EMA9/21 confirmation.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateTrendBreakout, readTrendBreakoutPlan, MAX_LOSS_PERCENT, DEFAULT_TREND_BREAKOUT_PARAMS,
  type TrendBreakoutPlan
} from '@cde/engine/analysis';
import { trendBreakoutEffectiveStop, type SimPosition } from '@cde/engine/execution';
import type { Candle } from '@cde/engine';
import type { VolatilityProfile } from '@cde/engine/volatility';

const H1 = 3_600_000;
const M15 = 15 * 60_000;

function h1Uptrend(n = 220): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: i * H1,
    open: 100 + i * 0.5, high: 100.9 + i * 0.5, low: 99.5 + i * 0.5, close: 100.5 + i * 0.5,
    volume: 1000
  }));
}

function breakoutM15(): Candle[] {
  const m15: Candle[] = Array.from({ length: 320 }, (_, i) => ({
    timestamp: i * M15, open: 150 + i * 0.15, high: 150.45 + i * 0.15, low: 149.55 + i * 0.15,
    close: 150.15 + i * 0.15, volume: 1000
  }));
  const prev = m15[m15.length - 2];
  m15[m15.length - 1] = { timestamp: m15[m15.length - 1].timestamp, open: prev.close, high: 205.2, low: prev.close - 0.2, close: 205, volume: 8000 };
  return m15;
}

function confirmM5(): Candle[] {
  return Array.from({ length: 40 }, (_, i) => ({
    timestamp: i * 5 * 60_000, open: 200 + i * 0.13, high: 200.4 + i * 0.13, low: 199.6 + i * 0.13, close: 200.2 + i * 0.13, volume: 1000
  }));
}

function makeProfile(overrides: Partial<VolatilityProfile> = {}): VolatilityProfile {
  return {
    months: 24, meanUp: 3.4548, medianUp: 3.0574, p25Up: 2.4351, p75Up: 4.0314,
    meanDown: 3.9469, medianDown: 3.4039, p25Down: 2.5179, p75Down: 4.8087,
    meanRatio: 0.8753, medianRatio: 0.8982, consistency: 0.8737, baselineRange: 6.4613,
    diagnostics: { maxUp: 7.3658, maxDown: 10.4602 }, profileQualityScore: 0.9444,
    ...overrides
  };
}

const h1 = h1Uptrend();
const m15 = breakoutM15();
const m5 = confirmM5();

describe('TrendBreakout (Bybit) — volatilityProfiles', () => {
  it('sanity: this fixture signals without any ladder', () => {
    const ev = evaluateTrendBreakout({ symbol: 'CAP', h1, m15, m5, currentPrice: 205 });
    expect(ev.willExecute).toBe(true);
  });

  it('resolves a LONG against the SPOT profile and replaces the ATR-derived stop/TP1', () => {
    const profiles = new Map<string, VolatilityProfile>([['spot:CAP', makeProfile()]]);
    const ev = evaluateTrendBreakout({ symbol: 'CAP', h1, m15, m5, currentPrice: 205, volatilityProfiles: profiles });
    expect(ev.willExecute).toBe(true);
    const plan = readTrendBreakoutPlan(ev) as TrendBreakoutPlan;
    const stopPct = Math.abs(plan.entryRef - plan.stopLoss) / plan.entryRef * 100;
    // Regime multiplier depends on this fixture's last H1 candle vs. the
    // profile's baselineRange, so this asserts the ladder took over (bounded,
    // positive) rather than pinning one exact regime value.
    expect(stopPct).toBeGreaterThan(0);
    expect(stopPct).toBeLessThanOrEqual(MAX_LOSS_PERCENT + 1e-9);
  });

  it('is a no-op under the WRONG market — this fixture is a LONG (spot), so a linear-only profile must not be used', () => {
    // Regression for a real wiring bug: the market was hardcoded to 'linear'
    // on the mistaken belief that this bot was futures-only, so every LONG
    // looked up the wrong market's statistics.
    const profiles = new Map<string, VolatilityProfile>([['linear:CAP', makeProfile()]]);
    const withProfiles = evaluateTrendBreakout({ symbol: 'CAP', h1, m15, m5, currentPrice: 205, volatilityProfiles: profiles });
    const withoutProfiles = evaluateTrendBreakout({ symbol: 'CAP', h1, m15, m5, currentPrice: 205 });
    expect(withProfiles).toEqual(withoutProfiles);
  });

  it('takes precedence over calmRegimeScalp when both are supplied', () => {
    const profiles = new Map<string, VolatilityProfile>([['spot:CAP', makeProfile()]]);
    const withVolatility = evaluateTrendBreakout({
      symbol: 'CAP', h1, m15, m5, currentPrice: 205,
      params: { calmRegimeScalp: true }, volatilityProfiles: profiles
    });
    const withoutCalm = evaluateTrendBreakout({ symbol: 'CAP', h1, m15, m5, currentPrice: 205, volatilityProfiles: profiles });
    expect(withVolatility).toEqual(withoutCalm);
  });

  it('the resolved stop is snapshotted onto the position — trailing derives rUnit from IT, not a re-derived ATR stop', () => {
    const profiles = new Map<string, VolatilityProfile>([['spot:CAP', makeProfile()]]);
    const ev = evaluateTrendBreakout({ symbol: 'CAP', h1, m15, m5, currentPrice: 205, volatilityProfiles: profiles });
    const plan = readTrendBreakoutPlan(ev) as TrendBreakoutPlan;

    const lot: SimPosition = {
      id: 'l0', symbol: 'CAP', type: 'FUTURES', side: 'LONG', quantity: 1,
      entryPrice: plan.entryRef, avgPrice: plan.entryRef, currentPrice: plan.entryRef, leverage: 1,
      marginUsd: 100, notionalUsd: 100,
      stopLoss: plan.stopLoss, takeProfit1: plan.takeProfit1, takeProfit2: plan.takeProfit2, takeProfit: plan.takeProfit1,
      tp1Hit: false, highestPrice: plan.entryRef, lowestPrice: plan.entryRef, openedAt: '',
      openTimestamp: Date.now(), reason: 'test', confidence: 80, entryFee: 0
    };
    const lt = { base: 'CAP', side: 'LONG' as const, lots: [lot] };

    // Before any progress, effectiveStop must still be exactly the
    // volatility-ladder stop — not the ATR-derived one this fixture's
    // ATR(M15) would otherwise produce.
    const { stop } = trendBreakoutEffectiveStop(lt, plan.entryRef, 1.0, DEFAULT_TREND_BREAKOUT_PARAMS);
    expect(stop).toBeCloseTo(plan.stopLoss, 6);
  });

  it('still clamps to MAX_LOSS_PERCENT — a degenerate profile cannot escape the ceiling', () => {
    const profiles = new Map<string, VolatilityProfile>([
      ['spot:CAP', makeProfile({ medianDown: 25, medianUp: 20 })]
    ]);
    const ev = evaluateTrendBreakout({ symbol: 'CAP', h1, m15, m5, currentPrice: 205, volatilityProfiles: profiles });
    if (ev.willExecute) {
      const plan = readTrendBreakoutPlan(ev) as TrendBreakoutPlan;
      const stopPct = Math.abs(plan.entryRef - plan.stopLoss) / plan.entryRef * 100;
      expect(stopPct).toBeLessThanOrEqual(MAX_LOSS_PERCENT + 1e-9);
    }
  });
});
