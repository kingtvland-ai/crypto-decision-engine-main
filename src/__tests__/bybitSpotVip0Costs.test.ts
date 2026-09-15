/**
 * Bybit Spot VIP 0 trading-cost fix (2026-09-16).
 * ============================================================================
 * This desk trades Bybit Spot only, at VIP 0. Fee and base slippage are now
 * FIXED (no longer an operator-editable field in the settings dialog — see
 * SimulationEngineColumn.tsx) at the real VIP 0 schedule:
 *
 *   Spot Fee (per fill)      = 0.10%
 *   Base Slippage (per fill) = 0.10%
 *   Round Trip Fee           = 0.20% (entry + exit)
 *   Round Trip Base Slippage = 0.20% (entry + exit)
 *   Total Base Trading Cost  = 0.40%
 *
 * These assertions read the actual exported constants (not hardcoded
 * literals), so a future accidental edit to any of them fails this test
 * instead of silently drifting the whole desk's cost model.
 */

import { describe, it, expect } from 'vitest';
import { SIM_BASE_DEFAULTS, BYBIT_FEES, FEE_REFERENCE_PERCENT, DEFAULT_SLIPPAGE_PERCENT, calculateTradingFee } from '@cde/engine/execution';

describe('Bybit Spot VIP 0 trading costs — fixed, not operator-editable', () => {
  it('Spot Fee is 0.10% (VIP 0 taker/maker, both legs of a round trip cross the book)', () => {
    expect(SIM_BASE_DEFAULTS.feePercent).toBe(0.1);
    expect(BYBIT_FEES.spot.taker).toBeCloseTo(0.001, 6); // 0.10% as a fraction
    expect(BYBIT_FEES.spot.maker).toBeCloseTo(0.001, 6);
    // The configured feePercent must map 1:1 onto Bybit's real spot schedule —
    // i.e. calculateTradingFee's internal scale factor is exactly 1.
    expect(FEE_REFERENCE_PERCENT).toBeCloseTo(0.1, 6);
  });

  it('Base Slippage is 0.10%', () => {
    expect(SIM_BASE_DEFAULTS.slippagePercent).toBe(0.1);
    expect(DEFAULT_SLIPPAGE_PERCENT).toBe(0.1);
  });

  it('Round Trip Fee = 0.20%, Round Trip Base Slippage = 0.20%, Total Base Trading Cost = 0.40%', () => {
    const roundTripFeePct = SIM_BASE_DEFAULTS.feePercent * 2;
    const roundTripSlippagePct = SIM_BASE_DEFAULTS.slippagePercent * 2;
    const totalBaseCostPct = roundTripFeePct + roundTripSlippagePct;

    expect(roundTripFeePct).toBeCloseTo(0.2, 6);
    expect(roundTripSlippagePct).toBeCloseTo(0.2, 6);
    expect(totalBaseCostPct).toBeCloseTo(0.4, 6);
  });

  it('a 1.00% gross expected move nets to 0.60% after round-trip fee + base slippage', () => {
    const grossExpectedProfitPct = 1.0;
    const totalBaseCostPct = SIM_BASE_DEFAULTS.feePercent * 2 + SIM_BASE_DEFAULTS.slippagePercent * 2;
    const estimatedNetProfitPct = grossExpectedProfitPct - totalBaseCostPct;

    expect(estimatedNetProfitPct).toBeCloseTo(0.6, 6);
  });

  it('calculateTradingFee charges the SAME 0.10% rate on both the entry (maker) and exit (taker) leg of a SPOT round trip', () => {
    const notional = 1000;
    const entryFee = calculateTradingFee(notional, 'SPOT', false, SIM_BASE_DEFAULTS.feePercent); // maker
    const exitFee = calculateTradingFee(notional, 'SPOT', true, SIM_BASE_DEFAULTS.feePercent); // taker

    expect(entryFee).toBeCloseTo(1, 6); // 0.10% of $1000
    expect(exitFee).toBeCloseTo(1, 6);
    expect(entryFee + exitFee).toBeCloseTo(2, 6); // 0.20% round-trip fee in dollars
  });
});
