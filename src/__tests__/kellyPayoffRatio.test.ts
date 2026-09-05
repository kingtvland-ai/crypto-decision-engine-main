import { describe, it, expect } from 'vitest';
import { kellyPayoffRatio, KELLY_MIN_SAMPLE, KELLY_MULTIPLIER } from '@cde/engine/execution';
import type { ClosedTradeRecord } from '@cde/engine/execution';

/**
 * Regression tests for the Kelly self-feeding defect.
 *
 * Kelly sizes the bet from R = avgWin / avgLoss. Both engines measured that
 * ratio in DOLLARS. Because betFraction is itself dynamic, position sizes vary
 * across the history, so the dollar ratio is contaminated by size: a run of
 * wins taken at large size inflates R, which inflates betFraction, which
 * inflates the next R. The estimator feeds on its own output.
 *
 * Measured in R-multiples (pnl / risk-at-entry) the size cancels out and only
 * the edge remains.
 *
 * The first test is the one that fails on the bug and on nothing else: an
 * identical *edge* expressed at two different position sizes must produce an
 * identical R.
 */

const trade = (pnl: number, riskUsd?: number): ClosedTradeRecord => ({ pnl, riskUsd, at: 1 });

describe('kellyPayoffRatio measures edge, not position size', () => {
  it('returns the same R when the same edge is traded at different sizes', () => {
    // Every trade is either +2R or -1R. The EDGE is identical in both books;
    // only the capital per trade differs.
    const small = [
      trade(200, 100), trade(200, 100), trade(-100, 100), trade(-100, 100)
    ];
    // Same 2R/-1R outcomes, but sized 10x larger.
    const large = [
      trade(2000, 1000), trade(2000, 1000), trade(-1000, 1000), trade(-1000, 1000)
    ];

    const a = kellyPayoffRatio(small)!;
    const b = kellyPayoffRatio(large)!;

    expect(a.basis).toBe('r-multiple');
    expect(b.basis).toBe('r-multiple');
    expect(a.r).toBeCloseTo(b.r, 10);
    expect(a.r).toBeCloseTo(2, 10); // avgWin 2R / avgLoss 1R
  });

  it('the dollar basis it replaced does NOT survive a size change', () => {
    // The same book as above, but with the risk denominator stripped. This is
    // what the engines used to compute, and it is why the fix was needed: the
    // wins happen to be the large-size trades, so R is inflated by sizing.
    const mixed = [
      trade(2000), trade(200), trade(-100), trade(-100)
    ];
    const r = kellyPayoffRatio(mixed)!;
    expect(r.basis).toBe('dollar');
    // avgWin $1100 / avgLoss $100 = 11 — an "edge" that is almost entirely an
    // artefact of the winners having been sized 10x larger.
    expect(r.r).toBeCloseTo(11, 10);

    // Given the true risk behind each trade, the same book is a 2R edge.
    const withRisk = [
      trade(2000, 1000), trade(200, 100), trade(-100, 100), trade(-100, 100)
    ];
    expect(kellyPayoffRatio(withRisk)!.r).toBeCloseTo(2, 10);
  });
});

describe('graceful fallback for history predating riskUsd', () => {
  it('falls back to the dollar basis when no trade carries riskUsd', () => {
    const legacyHistory = [trade(300), trade(100), trade(-100), trade(-100)];
    const r = kellyPayoffRatio(legacyHistory)!;
    expect(r.basis).toBe('dollar');
    expect(r.r).toBeCloseTo(2, 10);
  });

  it('falls back rather than MIXING units when riskUsd is only partly present', () => {
    // The dangerous case: dividing R-multiple wins by dollar losses would be
    // worse than either basis alone, so a partial history must not opt in.
    const partial = [trade(200, 100), trade(200), trade(-100, 100), trade(-100)];
    expect(kellyPayoffRatio(partial)!.basis).toBe('dollar');
  });

  it('ignores a riskUsd of zero rather than dividing by it', () => {
    const zeroRisk = [trade(200, 0), trade(200, 100), trade(-100, 100), trade(-100, 100)];
    const r = kellyPayoffRatio(zeroRisk)!;
    expect(r.basis).toBe('dollar');
    expect(Number.isFinite(r.r)).toBe(true);
  });

  it('abstains when the history has no wins or no losses', () => {
    expect(kellyPayoffRatio([trade(100, 100), trade(200, 100)])).toBeNull();
    expect(kellyPayoffRatio([trade(-100, 100)])).toBeNull();
    expect(kellyPayoffRatio([])).toBeNull();
  });
});

describe('sizing constants', () => {
  it('keeps the Kelly sample floor at 30, on measured evidence', () => {
    // The statistical case for raising this to 100 is real — at n=30 the
    // standard error on a ~50% win rate is ~9.1pp — but it was A/B measured and
    // made both engines much worse, because the sub-threshold fallback is a
    // FLAT 6% with no edge feedback. Raising the floor just buys more blind
    // trades. Noisy Kelly still protects, since it clamps to zero on a losing
    // book and the SIGN of the edge is what 30 trades resolves.
    //
    // This assertion exists to make a future raise a deliberate act: if you
    // change it, re-run scripts/abBacktest.ts and fix the flat-6% fallback
    // first. Measured via scripts/abBacktest.ts.
    expect(KELLY_MIN_SAMPLE).toBe(30);
  });

  it('bets a quarter of Kelly, not a half', () => {
    // Half-Kelly is growth-optimal only when the edge is KNOWN; here it is
    // estimated from a rolling window.
    expect(KELLY_MULTIPLIER).toBe(0.25);
  });

  it('a realistic edge stays inside the 10% cap after the multiplier', () => {
    // 55% win rate at R=2 → Kelly 0.325 → quarter-Kelly 0.081, under the cap.
    const winRate = 0.55;
    const R = 2;
    const kelly = winRate - (1 - winRate) / R;
    expect(Math.min(Math.max(0, kelly * KELLY_MULTIPLIER), 0.10)).toBeCloseTo(0.08125, 5);
  });
});
