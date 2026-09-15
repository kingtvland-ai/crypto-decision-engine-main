/**
 * Smart re-entry cooldown and market stress detection
 * ============================================================================
 * Recovery-based re-entry logic (not time-only), recomputed against the live
 * price on every check — applies after BOTH a win and a loss (2026-09-16;
 * previously loss-only with a 0-minute floor on strong recovery — see
 * ENTRY_COOLDOWN_MS's doc comment in simExecution.ts for why: a WINNING
 * ratchet exit on FLOCK was followed 76 seconds later by a fresh entry that
 * then stopped out). Every tier now has a SMART_COOLDOWN_FLOOR_MS (5 min)
 * floor, even on strong recovery. Plus slippage monitoring for the market-
 * stress circuit breaker.
 */

import { describe, it, expect } from 'vitest';
import { resolveReentryRecovery, detectMarketStress, ENTRY_COOLDOWN_MS, SMART_COOLDOWN_FLOOR_MS, isInEntryCooldown } from '@cde/engine/execution';

describe('resolveReentryRecovery', () => {
  it('strong recovery (+0.5%) still respects the 5-minute floor', () => {
    const res = resolveReentryRecovery({
      exitPrice: 100,
      currentPrice: 100.50,
      isLong: true,
      timeSinceExit: 5000 // 5 seconds — well under the floor
    });
    expect(res.allowed).toBe(false);
    expect(res.effectiveCooldown).toBe(SMART_COOLDOWN_FLOOR_MS);
    expect(res.reason).toContain('Recovery');
  });

  it('strong recovery (+0.5%) is allowed once the 5-minute floor has passed', () => {
    const res = resolveReentryRecovery({
      exitPrice: 100,
      currentPrice: 100.50,
      isLong: true,
      timeSinceExit: SMART_COOLDOWN_FLOOR_MS
    });
    expect(res.allowed).toBe(true);
    expect(res.reason).toContain('Recovery');
  });

  it('disallows entry with weak recovery (+0.2-0.5%) until 15 min passes', () => {
    const res = resolveReentryRecovery({
      exitPrice: 100,
      currentPrice: 100.30, // +0.3%
      isLong: true,
      timeSinceExit: 5 * 60 * 1000 // 5 minutes into cooldown
    });
    expect(res.allowed).toBe(false);
    expect(res.effectiveCooldown).toBe(15 * 60 * 1000);
    expect(res.reason).toContain('Weak recovery');
  });

  it('allows re-entry after 15 min when weak recovery occurred', () => {
    const res = resolveReentryRecovery({
      exitPrice: 100,
      currentPrice: 100.30, // +0.3%
      isLong: true,
      timeSinceExit: 16 * 60 * 1000 // 16 minutes (> 15 min reduced cooldown)
    });
    expect(res.allowed).toBe(true);
    expect(res.reason).toContain('Weak recovery');
  });

  it('keeps full 60-min cooldown when price stays below exit', () => {
    const res = resolveReentryRecovery({
      exitPrice: 100,
      currentPrice: 99.80, // -0.2% (below exit)
      isLong: true,
      timeSinceExit: 30 * 60 * 1000 // 30 minutes
    });
    expect(res.allowed).toBe(false);
    expect(res.effectiveCooldown).toBe(ENTRY_COOLDOWN_MS);
    expect(res.reason).toContain('full cooldown');
  });

  it('handles SHORT positions (inverted logic)', () => {
    const res = resolveReentryRecovery({
      exitPrice: 100,
      currentPrice: 99.50, // -0.5% (good recovery for SHORT)
      isLong: false,
      timeSinceExit: SMART_COOLDOWN_FLOOR_MS
    });
    expect(res.allowed).toBe(true);
  });
});

describe('isInEntryCooldown — applies after a WIN, not just a loss', () => {
  it('a WINNING exit still blocks re-entry inside the 5-minute floor', () => {
    const now = Date.now();
    const cooldown = { at: now - 60_000, exitPrice: 100, isLong: true }; // 1 min ago, "won" (no sign of pnl here — the state no longer carries it)
    expect(isInEntryCooldown(cooldown, 100.01, now)).toBe(true);
  });

  it('clears once the floor passes and price has NOT meaningfully continued', () => {
    const now = Date.now();
    const cooldown = { at: now - SMART_COOLDOWN_FLOOR_MS - 1000, exitPrice: 100, isLong: true };
    // recoveryPercent ~0 → below the 0.2% weak-recovery band → full ENTRY_COOLDOWN_MS applies
    expect(isInEntryCooldown(cooldown, 100.0, now)).toBe(true);
  });

  it('a bare legacy timestamp (pre-migration in-memory state) degrades to the flat floor', () => {
    const now = Date.now();
    expect(isInEntryCooldown(now - 60_000, 100, now)).toBe(true);
    expect(isInEntryCooldown(now - SMART_COOLDOWN_FLOOR_MS - 1, 100, now)).toBe(false);
  });

  it('missing currentPrice cannot bypass the floor', () => {
    const now = Date.now();
    const cooldown = { at: now - 60_000, exitPrice: 100, isLong: true };
    expect(isInEntryCooldown(cooldown, undefined, now)).toBe(true);
  });
});

describe('detectMarketStress', () => {
  it('detects high slippage (> 0.5%) as market stress', () => {
    const trades = [
      { slippagePercent: 0.45 },
      { slippagePercent: 0.60 },
      { slippagePercent: 0.55 }
    ];
    const res = detectMarketStress({ recentTrades: trades });
    expect(res.isStressed).toBe(true);
    expect(res.avgSlippage).toBeCloseTo(0.533, 2);
    expect(res.recommendation).toContain('50%');
  });

  it('detects elevated slippage (0.30-0.50%) as warning', () => {
    const trades = [
      { slippagePercent: 0.25 },
      { slippagePercent: 0.35 },
      { slippagePercent: 0.40 }
    ];
    const res = detectMarketStress({ recentTrades: trades });
    expect(res.isStressed).toBe(true);
    expect(res.recommendation).toContain('75%');
  });

  it('returns normal conditions when slippage is healthy', () => {
    const trades = [
      { slippagePercent: 0.05 },
      { slippagePercent: 0.08 },
      { slippagePercent: 0.12 }
    ];
    const res = detectMarketStress({ recentTrades: trades });
    expect(res.isStressed).toBe(false);
    expect(res.avgSlippage).toBeCloseTo(0.083, 2);
  });

  it('uses only last N trades (windowSize)', () => {
    const trades = [
      { slippagePercent: 2.0 }, // old, ignored
      { slippagePercent: 0.05 },
      { slippagePercent: 0.08 },
      { slippagePercent: 0.07 }
    ];
    const res = detectMarketStress({ recentTrades: trades, windowSize: 3 });
    expect(res.isStressed).toBe(false);
    // avg of last 3: (0.05 + 0.08 + 0.07) / 3
    expect(res.avgSlippage).toBeCloseTo(0.0667, 2);
  });
});
