/**
 * Time-Stop partial close under the ratchet (2026-09-16)
 * ============================================================================
 * Live sim data (cde-engine.onrender.com, Intraday bot) showed 14 Time-Stop /
 * Max-Duration exits averaging -$8.05, against the profit ratchet's own
 * average partial realization of +$2.29 — net -$69.23 on Intraday alone,
 * even though the ratchet's own trades were net positive. A full close marks
 * the ENTIRE stagnant position to market on one tick; the ratchet already
 * treats profit-taking as incremental. Fix: under the ratchet
 * (`profitRatchet: true`), the first Time-Stop hit closes only 50% and lets
 * the remainder keep running under the real SL/ratchet/MAX_DURATION; a
 * second hit (guarded by the shared `tp1Hit` flag, so it cannot decay
 * geometrically) closes what's left, in full.
 *
 * The live bot leaves `profitRatchet` unset — must reproduce the old
 * full-close-every-time behavior exactly.
 */

import { describe, it, expect } from 'vitest';
import { evaluatePositionExit, DEFAULT_INTRADAY_PARAMS } from '@cde/engine';

const portfolio = { dailyDrawdownPercent: 0, weeklyDrawdownPercent: 0 };
const HELD_MINUTES = 63;

function stagnantPosition(opts: { tp1Hit?: boolean }) {
  const entryPrice = 100;
  const stopDistancePct = 2.3;
  const maxHoldMs = 90 * 60_000;
  return {
    symbol: 'BTCUSDT',
    type: 'SPOT' as const,
    side: 'BUY' as const,
    entryPrice,
    quantity: 1,
    stopLoss: entryPrice * (1 - stopDistancePct / 100),
    takeProfit1: entryPrice * 1.05,
    tp1Hit: opts.tp1Hit ?? false,
    openTimestamp: Date.now() - HELD_MINUTES * 60_000,
    plannedStopDistance: entryPrice * stopDistancePct / 100,
    setupType: 'BREAKOUT_RETEST' as const,
    maxHoldMs,
    timeStopMs: Math.round(maxHoldMs * 0.7)
  };
}

// Flat — no progress, no MFE — the same "genuinely stagnant" shape the
// existing natural-stop tests use, at the executed 2.3% stop (no
// naturalStopPct here, so progressR/mfeR fall back to the executed stop).
const STAGNANT_PRICE = 100;

describe('Time Stop partial close under the ratchet', () => {
  it('ratchet on, first hit (tp1Hit false): PARTIAL_50, not a full close', () => {
    const decision = evaluatePositionExit(
      stagnantPosition({ tp1Hit: false }),
      STAGNANT_PRICE,
      0.17,
      portfolio,
      undefined,
      { ...DEFAULT_INTRADAY_PARAMS, profitRatchet: true },
    );
    expect(decision.reasonCode).toBe('TIME_STOP');
    expect(decision.shouldExit).toBe(true);
    expect(decision.exitType).toBe('PARTIAL_50');
  });

  it('ratchet on, second hit (tp1Hit already true from the first partial): FULL close', () => {
    const decision = evaluatePositionExit(
      stagnantPosition({ tp1Hit: true }),
      STAGNANT_PRICE,
      0.17,
      portfolio,
      undefined,
      { ...DEFAULT_INTRADAY_PARAMS, profitRatchet: true },
    );
    expect(decision.reasonCode).toBe('TIME_STOP');
    expect(decision.shouldExit).toBe(true);
    expect(decision.exitType).toBe('FULL');
  });

  it('ratchet off (live bot default): always a FULL close, byte-identical to the old behavior', () => {
    const decision = evaluatePositionExit(
      stagnantPosition({ tp1Hit: false }),
      STAGNANT_PRICE,
      0.17,
      portfolio,
      undefined,
      DEFAULT_INTRADAY_PARAMS,
    );
    expect(decision.reasonCode).toBe('TIME_STOP');
    expect(decision.shouldExit).toBe(true);
    expect(decision.exitType).toBe('FULL');
  });
});
