/**
 * Natural-stop time-stop (2026-09-15)
 * ============================================================================
 * The stagnation check (progressR < 0.3R && mfeR < 0.7R) used to measure R
 * against the EXECUTED stop distance. Under the flat scalp ladder that stop
 * sits at a uniform 2.3%+ regardless of a calm symbol's real volatility, so
 * 0.3R became an unreasonably high bar — even BTC's typical 63-minute drift
 * (~0.60%, 5M ATR 0.17%) fell short of the 0.69% a 2.3% stop demanded.
 *
 * Fix: when `naturalStopPct` (RiskPlan.naturalStopPct, frozen at entry from
 * measureStopNoise().floorPct — the symbol's OWN measured noise floor) is
 * present, the stagnation check measures progress/MFE against THAT instead of
 * the executed stop. Every other R-based check (trailing activation, max-hold
 * extension, STOP_LOSS itself) is untouched — this is scoped to the one
 * question "has this symbol's tape moved", which the executed stop (often
 * inflated well past a calm symbol's real movement) cannot answer.
 *
 * Undefined naturalStopPct (live bot; or no noise measurement available) must
 * reproduce the OLD behavior exactly — these tests pin that as a regression
 * guard alongside the new behavior.
 */

import { describe, it, expect } from 'vitest';
import { evaluatePositionExit, DEFAULT_INTRADAY_PARAMS } from '@cde/engine';

const portfolio = { dailyDrawdownPercent: 0, weeklyDrawdownPercent: 0 };

// 63-minute checkpoint, matching the sim override's BREAKOUT_RETEST/
// MEAN_REVERSION window — long past the "still resolving" phase either way.
const HELD_MINUTES = 63;

function position(opts: { naturalStopPct?: number; plannedStopDistancePct?: number }) {
  const entryPrice = 100;
  const stopDistancePct = opts.plannedStopDistancePct ?? 2.3; // the flat ladder's executed stop
  const maxHoldMs = 90 * 60_000; // BREAKOUT_RETEST/MEAN_REVERSION under the sim override
  return {
    symbol: 'BTCUSDT',
    type: 'SPOT' as const,
    side: 'BUY' as const,
    entryPrice,
    quantity: 1,
    stopLoss: entryPrice * (1 - stopDistancePct / 100),
    takeProfit1: entryPrice * 1.05,
    openTimestamp: Date.now() - HELD_MINUTES * 60_000,
    plannedStopDistance: entryPrice * stopDistancePct / 100,
    naturalStopPct: opts.naturalStopPct,
    setupType: 'BREAKOUT_RETEST' as const,
    maxHoldMs,
    timeStopMs: Math.round(maxHoldMs * 0.7)
  };
}

describe('natural-stop time-stop — with naturalStopPct present', () => {
  it('a small move that fails 0.3R against the executed stop PASSES against a calm symbol\'s natural floor', () => {
    // +0.15% move: 0.15/2.3 = 0.065R against the executed stop (would cut),
    // but 0.15/0.30 = 0.50R against a BTC-like 0.30% natural floor (survives).
    const decision = evaluatePositionExit(
      position({ naturalStopPct: 0.30 }),
      100.15,
      0.17, // atr5, unrelated to this check
      portfolio,
      undefined,
      DEFAULT_INTRADAY_PARAMS
    );
    expect(decision.reasonCode).not.toBe('TIME_STOP');
    expect(decision.shouldExit).toBe(false);
  });

  it('the SAME price move is cut without naturalStopPct — proves the fix is what changed it', () => {
    const decision = evaluatePositionExit(
      position({ naturalStopPct: undefined }),
      100.15,
      0.17,
      portfolio,
      undefined,
      DEFAULT_INTRADAY_PARAMS
    );
    expect(decision.reasonCode).toBe('TIME_STOP');
  });

  it('a genuinely flat trade (no move at all) still gets cut even with a natural floor', () => {
    const decision = evaluatePositionExit(
      position({ naturalStopPct: 0.30 }),
      100.02, // 0.02/0.30 = 0.067R — still stagnant even against the tight natural floor
      0.17,
      portfolio,
      undefined,
      DEFAULT_INTRADAY_PARAMS
    );
    expect(decision.reasonCode).toBe('TIME_STOP');
  });

  it('a volatile symbol (wide natural floor) demands MORE proof of life, not less', () => {
    // +0.5% move: 0.5/2.3 = 0.22R against the executed stop (would cut),
    // AND 0.5/2.74 = 0.18R against a FLOCK-like 2.74% natural floor (also cuts —
    // a 0.5% pop on a symbol whose own noise floor is 2.74% is still nothing).
    const decision = evaluatePositionExit(
      position({ naturalStopPct: 2.74, plannedStopDistancePct: 2.74 }),
      100.5,
      1.2,
      portfolio,
      undefined,
      DEFAULT_INTRADAY_PARAMS
    );
    expect(decision.reasonCode).toBe('TIME_STOP');
  });

  it('MFE above the natural-R threshold keeps the position alive even if live progress is negative', () => {
    // Peak ran to +0.6% (mfeNaturalR = 0.6/0.30 = 2.0R, well above 0.7) then
    // pulled back to +0.05% now (progressNaturalR = 0.17R, below 0.3) — the
    // "working, just slowly" case the mfeR half of the AND exists for.
    const pos = { ...position({ naturalStopPct: 0.30 }), highestPrice: 100.6 };
    const decision = evaluatePositionExit(pos, 100.05, 0.17, portfolio, undefined, DEFAULT_INTRADAY_PARAMS);
    expect(decision.reasonCode).not.toBe('TIME_STOP');
  });
});

describe('natural-stop time-stop — regression: undefined naturalStopPct reproduces old behavior', () => {
  // decision.progressR/mfeR (the structured fields every OTHER check reads —
  // trailing activation, max-hold extension, UI display) are deliberately
  // UNTOUCHED by this fix: they stay denominated in the executed stop always.
  // Only the TIME_STOP reason string (and the internal comparison that decides
  // whether to fire) switches to the natural-R denominator. These tests pin
  // that split so a future change doesn't accidentally widen the fix's scope.
  it('decision.progressR stays executed-stop-based even when naturalStopPct changes the verdict', () => {
    const decision = evaluatePositionExit(
      position({ naturalStopPct: 0.30 }),
      100.15,
      0.17,
      portfolio,
      undefined,
      DEFAULT_INTRADAY_PARAMS
    );
    // 0.15 / 2.3 (executed stop) = 0.0652R, rounded to 0.07 — NOT 0.50R (the
    // natural-R value that actually decided this trade survives the check).
    expect(decision.progressR).toBeCloseTo(0.07, 2);
    expect(decision.shouldExit).toBe(false);
  });

  it('the TIME_STOP reason string reports the natural-R value that drove the decision', () => {
    const decision = evaluatePositionExit(
      position({ naturalStopPct: 0.30 }),
      100.02,
      0.17,
      portfolio,
      undefined,
      DEFAULT_INTRADAY_PARAMS
    );
    expect(decision.reasonCode).toBe('TIME_STOP');
    // 0.02 / 0.30 = 0.067R — matches the natural floor, not 0.02/2.3=0.009R.
    expect(decision.reason).toContain('0.07R');
  });
});
