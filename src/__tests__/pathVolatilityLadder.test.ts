/**
 * Path (Prev-4H Range) — Volatility Profile ladder wiring (2026-09-16)
 * ============================================================================
 * `evaluatePrev4hRange`'s new `input.volatilityProfiles`: when a valid
 * profile resolves for the symbol/market/side it replaces BOTH the
 * range-derived ladder and `calmRegimeScalp`'s fixed one, still bounded by
 * MAX_LOSS_PERCENT. Absent (every other test in the suite) is unchanged.
 *
 * Fixture mirrors pathRiskVsCostLadderMismatch.test.ts's h1Series/
 * nowInNextWindow helpers, but with a comfortably wide structural stop so
 * nothing else (RANGE_TOO_TIGHT, RISK_VS_COST) interferes with what this
 * file is actually testing.
 */
import { describe, it, expect } from 'vitest';
import { evaluatePrev4hRange, readPrev4hRangePlan, MAX_LOSS_PERCENT } from '@cde/engine/analysis';
import type { Candle } from '@cde/engine';
import type { VolatilityProfile } from '@cde/engine/volatility';

const H1_MS = 60 * 60 * 1000;
const BAR_MS = 4 * H1_MS;

function h1Series(n: number, base: number, step: number, k: number): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const close = base + i * step;
    return {
      timestamp: i * H1_MS,
      open: i === 0 ? close : base + (i - 1) * step,
      high: close + k, low: close - k, close, volume: 1000
    };
  });
}
function nowInNextWindow(n: number): number {
  return (Math.floor(n / 4) - 1) * BAR_MS + BAR_MS + H1_MS;
}

// A comfortably wide (~3%) structural stop — clears RANGE_TOO_TIGHT and
// RISK_VS_COST on its own, so only the volatility-ladder substitution is
// under test here.
const STOP_PCT_TARGET = 3;
const STEP = STOP_PCT_TARGET * 0.4;
const K = STOP_PCT_TARGET - 1.5 * STEP;
const N = 108;
const BASE = 100 - (N - 1) * STEP - K - 0.05;
const H1 = h1Series(N, BASE, STEP, K);
const NOW = nowInNextWindow(N);
const ENTRY = BASE + (N - 1) * STEP + K + 0.05; // just past the previous 4H high — a valid LONG breakout

function makeProfile(overrides: Partial<VolatilityProfile> = {}): VolatilityProfile {
  return {
    months: 24, meanUp: 3.4548, medianUp: 3.0574, p25Up: 2.4351, p75Up: 4.0314,
    meanDown: 3.9469, medianDown: 3.4039, p25Down: 2.5179, p75Down: 4.8087,
    meanRatio: 0.8753, medianRatio: 0.8982, consistency: 0.8737, baselineRange: 6.4613,
    diagnostics: { maxUp: 7.3658, maxDown: 10.4602 }, profileQualityScore: 0.9444,
    ...overrides
  };
}

describe('Path (Prev-4H Range) — volatilityProfiles', () => {
  it('sanity: this market signals without any ladder', () => {
    const ev = evaluatePrev4hRange({ symbol: 'RNG', h1: H1, currentPrice: ENTRY, now: NOW });
    expect(ev.willExecute).toBe(true);
  });

  it('LONG resolves to the spot profile and replaces the range-derived stop/TP1', () => {
    const profiles = new Map<string, VolatilityProfile>([['spot:RNG', makeProfile()]]);
    const ev = evaluatePrev4hRange({ symbol: 'RNG', h1: H1, currentPrice: ENTRY, now: NOW, volatilityProfiles: profiles });
    expect(ev.willExecute).toBe(true);
    const plan = readPrev4hRangePlan(ev)!;
    const stopPct = Math.abs(plan.entryRef - plan.stopLoss) / plan.entryRef * 100;
    const tp1Pct = Math.abs(plan.takeProfit1 - plan.entryRef) / plan.entryRef * 100;
    // This fixture's last H1 candle is tight relative to the profile's
    // baselineRange, so volatilityFactor lands CONTRACTED and clamps to the
    // 0.75 regime-multiplier floor — medianDown/medianUp × 0.75, not the raw
    // medians. That clamp (not the raw profile numbers) is exactly what this
    // test is verifying gets applied.
    expect(stopPct).toBeCloseTo(3.4039 * 0.75, 1);
    expect(tp1Pct).toBeCloseTo(3.0574 * 0.75, 1);
  });

  it('is a no-op when no profile exists for the symbol (PROFILE_NOT_FOUND)', () => {
    const profiles = new Map<string, VolatilityProfile>([['spot:SOMETHING_ELSE', makeProfile()]]);
    const withProfiles = evaluatePrev4hRange({ symbol: 'RNG', h1: H1, currentPrice: ENTRY, now: NOW, volatilityProfiles: profiles });
    const withoutProfiles = evaluatePrev4hRange({ symbol: 'RNG', h1: H1, currentPrice: ENTRY, now: NOW });
    expect(withProfiles).toEqual(withoutProfiles);
  });

  it('takes precedence over calmRegimeScalp when both are supplied', () => {
    const profiles = new Map<string, VolatilityProfile>([['spot:RNG', makeProfile()]]);
    const ev = evaluatePrev4hRange({
      symbol: 'RNG', h1: H1, currentPrice: ENTRY, now: NOW,
      params: { calmRegimeScalp: true }, volatilityProfiles: profiles
    });
    expect(ev.willExecute).toBe(true);
    const plan = readPrev4hRangePlan(ev)!;
    const stopPct = Math.abs(plan.entryRef - plan.stopLoss) / plan.entryRef * 100;
    // Not the fixed 2.3% calm ladder (see previous test for the 0.75 clamp).
    expect(stopPct).toBeCloseTo(3.4039 * 0.75, 1);
  });

  it('still clamps to MAX_LOSS_PERCENT — a degenerate profile cannot escape the ceiling', () => {
    const profiles = new Map<string, VolatilityProfile>([
      ['spot:RNG', makeProfile({ medianDown: 25, medianUp: 20 })]
    ]);
    const ev = evaluatePrev4hRange({ symbol: 'RNG', h1: H1, currentPrice: ENTRY, now: NOW, volatilityProfiles: profiles });
    if (ev.willExecute) {
      const plan = readPrev4hRangePlan(ev)!;
      const stopPct = Math.abs(plan.entryRef - plan.stopLoss) / plan.entryRef * 100;
      expect(stopPct).toBeLessThanOrEqual(MAX_LOSS_PERCENT + 1e-9);
    }
  });
});
