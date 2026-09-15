/**
 * Funding-crowding veto for the perpetual-trading sim bots (2026-09-16)
 * ============================================================================
 * `evaluateFundingGate` (fundingRate.ts) was reachable from exactly one
 * engine — intradayEngine.ts. But Path and TrendBreakout both open their SHORT
 * side as 1x FUTURES, and server/simEngineFactory.ts's tick charges funding on
 * every open FUTURES position of every sim bot via applyFundingAccrual. Those
 * two bots were paying funding while nothing ever refused a position for it.
 *
 * `applyFundingOverride` closes that, and these tests pin the three properties
 * that make it safe to add to a running strategy:
 *
 *   1. It vetoes only the CROWDED side (the gate's own asymmetry) — it is a
 *      penalty, never a reason to take the opposite side.
 *   2. It never touches a SPOT evaluation. Funding is a perpetual cost; a spot
 *      long neither pays nor receives it, so gating one would refuse a trade
 *      for a cost it cannot incur.
 *   3. It abstains on missing/stale data, like every other macro gate here.
 */

import { describe, it, expect } from 'vitest';
import { applyFundingOverride } from '@cde/engine/execution';
import { FUNDING_PERIODS_PER_YEAR } from '@cde/engine/analysis';
import type { SignalEvaluation } from '@cde/engine';

/** Per-period rate that annualises to `annualPct`. The gate reads annualised
 *  percent: rate × FUNDING_PERIODS_PER_YEAR × 100. */
const rateForAnnualPct = (annualPct: number) => annualPct / (FUNDING_PERIODS_PER_YEAR * 100);

function evaluation(over: Partial<SignalEvaluation> = {}): SignalEvaluation {
  return {
    symbol: 'ARBUSDT',
    action: 'sell',
    tradeType: 'FUTURES',
    tradeSide: 'SHORT',
    confidence: 88,
    price: 1.23,
    priceChange24h: -2,
    reasoning: 'breakout short',
    status: 'SIGNAL FUTURES SHORT',
    willExecute: true,
    factors: [],
    confidenceGap: 0,
    ...over
  } as SignalEvaluation;
}

describe('applyFundingOverride — the crowded side is refused', () => {
  it('vetoes a FUTURES SHORT when funding is extremely negative (shorts paying to stay in)', () => {
    const now = Date.now();
    // crowdedCost for a SHORT is -annualPct, so -80%/yr → +80 of crowding.
    const snapshot = { lastFundingRate: rateForAnnualPct(-80), at: now };
    const out = applyFundingOverride(evaluation(), snapshot, now);

    expect(out.willExecute).toBe(false);
    expect(out.action).toBe('hold');
    expect(out.status).toBe('NO_SIGNAL [FUNDING]');
    expect(out.reasoning).toContain('FUNDING_GATE');
  });

  it('leaves the SAME reading alone for a FUTURES LONG — the penalty is one-sided', () => {
    const now = Date.now();
    const snapshot = { lastFundingRate: rateForAnnualPct(-80), at: now };
    const longEv = evaluation({ action: 'buy', tradeSide: 'LONG' });
    // Negative funding pays longs; the gate must not veto the side being paid.
    expect(applyFundingOverride(longEv, snapshot, now)).toBe(longEv);
  });

  it('vetoes a FUTURES LONG when funding is extremely positive (longs paying)', () => {
    const now = Date.now();
    const snapshot = { lastFundingRate: rateForAnnualPct(80), at: now };
    const longEv = evaluation({ action: 'buy', tradeSide: 'LONG' });
    expect(applyFundingOverride(longEv, snapshot, now).willExecute).toBe(false);
  });

  it('allows a moderate reading — only the EXTREME band vetoes, the trim band does not block', () => {
    const now = Date.now();
    // 30%/yr of crowding: past CROWDED (25) but well under EXTREME (50).
    const snapshot = { lastFundingRate: rateForAnnualPct(-30), at: now };
    const ev = evaluation();
    expect(applyFundingOverride(ev, snapshot, now)).toBe(ev);
  });
});

describe('applyFundingOverride — the guards that keep it safe to add', () => {
  it('NEVER touches a SPOT evaluation, even at a funding reading that would veto a perp', () => {
    const now = Date.now();
    const snapshot = { lastFundingRate: rateForAnnualPct(-500), at: now };
    // Path/Bybit longs are SPOT: they neither pay nor receive funding.
    const spotEv = evaluation({ action: 'buy', tradeType: 'SPOT', tradeSide: 'LONG' });
    expect(applyFundingOverride(spotEv, snapshot, now)).toBe(spotEv);
  });

  it('abstains when there is no funding data at all', () => {
    const ev = evaluation();
    expect(applyFundingOverride(ev, undefined, Date.now())).toBe(ev);
  });

  it('abstains on a stale reading (older than one 8h settlement cycle)', () => {
    const now = Date.now();
    const stale = { lastFundingRate: rateForAnnualPct(-500), at: now - 9 * 60 * 60 * 1000 };
    const ev = evaluation();
    expect(applyFundingOverride(ev, stale, now)).toBe(ev);
  });

  it('is a no-op on an evaluation that was not going to trade anyway', () => {
    const now = Date.now();
    const snapshot = { lastFundingRate: rateForAnnualPct(-500), at: now };
    const hold = evaluation({ action: 'hold', willExecute: false });
    expect(applyFundingOverride(hold, snapshot, now)).toBe(hold);
  });

  it('preserves the original reasoning underneath the veto line', () => {
    const now = Date.now();
    const snapshot = { lastFundingRate: rateForAnnualPct(-80), at: now };
    const out = applyFundingOverride(evaluation(), snapshot, now);
    expect(out.reasoning).toContain('breakout short');
  });
});
