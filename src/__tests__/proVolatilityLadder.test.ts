/**
 * Pro — Volatility Profile ladder wiring (2026-09-16)
 * ============================================================================
 * `proStopTpLevels`'s new `opts.volatilityLadder`: when present it replaces
 * BOTH the ATR ladder and `calmRegimeScalp`'s fixed one, still capped at
 * PRO_STOP_LOSS_PERCENT. Absent — every other test in the suite — is a
 * byte-for-byte no-op.
 */
import { describe, it, expect } from 'vitest';
import { proStopTpLevels, PRO_STOP_LOSS_PERCENT } from '@cde/engine/analysis';

describe('proStopTpLevels — volatilityLadder', () => {
  it('replaces the ATR stop/TP with the supplied ladder (LONG)', () => {
    const levels = proStopTpLevels(100, 1.0, true, {
      volatilityLadder: { stopPct: 3.4039, targetPct: 3.0574 }
    });
    expect(levels.stopLoss).toBeCloseTo(100 * (1 - 0.034039), 4);
    expect(levels.takeProfit1).toBeCloseTo(100 * (1 + 0.030574), 4);
    expect(levels.takeProfit2).toBeCloseTo(100 * (1 + 0.030574 * 1.5), 4);
    expect(levels.tooVolatile).toBe(false);
  });

  it('SHORT mirrors direction correctly', () => {
    const levels = proStopTpLevels(100, 1.0, false, {
      volatilityLadder: { stopPct: 3.0574, targetPct: 3.4039 }
    });
    expect(levels.stopLoss).toBeCloseTo(100 * (1 + 0.030574), 4);
    expect(levels.takeProfit1).toBeCloseTo(100 * (1 - 0.034039), 4);
  });

  it('takes precedence over calmRegimeScalp when both are supplied', () => {
    const levels = proStopTpLevels(100, 1.0, true, {
      calmRegimeScalp: true,
      volatilityLadder: { stopPct: 3.4039, targetPct: 3.0574 }
    });
    // Not the fixed 2.3%/1.8% calm ladder.
    expect(levels.stopLoss).toBeCloseTo(100 * (1 - 0.034039), 4);
    expect(levels.takeProfit1).toBeCloseTo(100 * (1 + 0.030574), 4);
  });

  it('still clamps to PRO_STOP_LOSS_PERCENT — a degenerate profile cannot escape the ceiling', () => {
    const levels = proStopTpLevels(100, 1.0, true, {
      volatilityLadder: { stopPct: 25, targetPct: 20 }
    });
    const stopPct = Math.abs(100 - levels.stopLoss) / 100 * 100;
    expect(stopPct).toBeLessThanOrEqual(PRO_STOP_LOSS_PERCENT + 1e-9);
  });

  it('is a strict no-op when absent', () => {
    const withoutField = proStopTpLevels(100, 1.0, true, {});
    const explicitlyUndefined = proStopTpLevels(100, 1.0, true, { volatilityLadder: undefined });
    expect(explicitlyUndefined).toEqual(withoutField);
  });

  it('is ignored when either distance is zero or negative', () => {
    const withoutField = proStopTpLevels(100, 1.0, true, {});
    const zeroStop = proStopTpLevels(100, 1.0, true, { volatilityLadder: { stopPct: 0, targetPct: 3 } });
    const negativeTarget = proStopTpLevels(100, 1.0, true, { volatilityLadder: { stopPct: 3, targetPct: -1 } });
    expect(zeroStop).toEqual(withoutField);
    expect(negativeTarget).toEqual(withoutField);
  });
});
