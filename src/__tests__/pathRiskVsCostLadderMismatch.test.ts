/**
 * Path (Prev-4H Range) — RISK_VS_COST gated on the pre-ladder structural stop
 * ============================================================================
 * The same SHAPE of bug as Intraday's COST/TP1-vs-TP2 mismatch (see
 * costGateLadderMismatch.test.ts), found by auditing every bot for it after
 * that one was confirmed live: a gate evaluated on a value the fixed profit
 * ladder later OVERRIDES, instead of on what will actually be traded.
 *
 * `evaluatePrev4hRange`'s RISK_VS_COST gate used to run BEFORE the ladder
 * block, checking `stopDistancePct` from `structuralStop` (the prev-4H range
 * midpoint) against `costSafetyMultiplier × estimatedRoundTripCost` (≈0.5-0.6%
 * at this bot's defaults). The ladder's own floor is FIXED_SL_PCT = 2.3%
 * (never tighter — see calmRegime.ts), comfortably clearing that threshold —
 * but a narrow prev-4H range's OWN structural stop can sit well under 0.6%
 * without being narrow enough to also trip RANGE_TOO_TIGHT (whose floor,
 * minRangePct = 1.0%, sits at a different point in the same space — this
 * test's market genuinely clears it). Such a setup was rejected on a stop
 * that would never actually be traded once the ladder replaced it — exactly
 * the tight-range setups this bot's own confidence score treats as BEST
 * ("מגע נקי + טווח צר = ביטחון גבוה").
 *
 * Unlike the Intraday bug, this one was NOT confirmed against live production
 * data — it is a code-level inconsistency found by inspection and fixed
 * because it is unambiguously more correct (mirrors the Intraday fix
 * exactly: measure the safety gate against the FINAL stop, not a stale
 * pre-override one) and is covered end-to-end by this regression.
 */

import { describe, it, expect } from 'vitest';
import { evaluatePrev4hRange, readPrev4hRangePlan } from '@cde/engine/analysis';
import type { Candle } from '@cde/engine';

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

// Constructed so the prev-4H range's OWN structural stop (mid-based) sits at
// ~0.5% of entry — under the ~0.55-0.6% cost-safety threshold, but well clear
// of RANGE_TOO_TIGHT's own floor (rangePct = 2 × stopDistancePct here, so
// ~1.0% vs. the 1.0% floor — this specific construction sits just above it;
// see the stability sweep this file's history was built from). Same market
// data, no randomness — deterministic across runs.
const STOP_PCT_TARGET = 0.5;
const STEP = STOP_PCT_TARGET * 0.4;
const K = STOP_PCT_TARGET - 1.5 * STEP;
const N = 108;
const BASE = 100 - (N - 1) * STEP - K - 0.05;
const H1 = h1Series(N, BASE, STEP, K);
const NOW = nowInNextWindow(N);
const ENTRY = BASE + (N - 1) * STEP + K + 0.05; // just past the previous 4H high — a valid breakout

describe('Path RISK_VS_COST — must measure the FINAL (ladder-aware) stop', () => {
  it('sanity: this market genuinely has a tight structural stop, not a masking RANGE_TOO_TIGHT', () => {
    const ev = evaluatePrev4hRange({ symbol: 'RNG', h1: H1, currentPrice: ENTRY, now: NOW, params: {} });
    expect(ev.status).not.toBe('NO_SIGNAL [RANGE_TOO_TIGHT]');
  });

  it('ladder OFF: the structural stop is genuinely too tight for its own round trip — RISK_VS_COST correctly fires', () => {
    const ev = evaluatePrev4hRange({ symbol: 'RNG', h1: H1, currentPrice: ENTRY, now: NOW, params: {} });
    expect(ev.willExecute).toBe(false);
    expect(ev.status).toBe('NO_SIGNAL [RISK_VS_COST]');
  });

  it('ladder ON: the SAME market SIGNALs — the fixed 2.3% stop clears the same gate easily', () => {
    const ev = evaluatePrev4hRange({ symbol: 'RNG', h1: H1, currentPrice: ENTRY, now: NOW, params: { calmRegimeScalp: true } });
    expect(ev.willExecute).toBe(true);
    const plan = readPrev4hRangePlan(ev)!;
    const stopPct = Math.abs(plan.entryRef - plan.stopLoss) / plan.entryRef * 100;
    expect(stopPct).toBeCloseTo(2.3, 1);
  });

  it('a buying surge still clamps the widened stop at the 2.3% floor, so RISK_VS_COST cannot re-fire on it either', () => {
    // A green H1 bar with relVolume >= 2 arms the surge branch; the structural
    // stop here (~0.5%) is far below the floor, so resolveLadderPercents
    // clamps back up to 2.3% regardless — same guarantee as the plain case.
    const surged = h1Series(N, BASE, STEP, K);
    const last = surged[N - 1];
    surged[N - 1] = { ...last, volume: last.volume * 3, open: last.close - K, close: last.close };
    const ev = evaluatePrev4hRange({ symbol: 'RNG', h1: surged, currentPrice: ENTRY, now: NOW, params: { calmRegimeScalp: true } });
    expect(ev.willExecute).toBe(true);
    const plan = readPrev4hRangePlan(ev)!;
    const stopPct = Math.abs(plan.entryRef - plan.stopLoss) / plan.entryRef * 100;
    expect(stopPct).toBeGreaterThanOrEqual(2.3 - 1e-6);
  });
});
