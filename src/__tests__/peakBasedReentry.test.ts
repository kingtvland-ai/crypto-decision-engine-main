/**
 * Peak-based re-entry and market stress detection (2026-09-14)
 * ============================================================================
 * Mathematical re-entry logic (not time-based), and slippage monitoring
 * for circuit breaker when market conditions degrade.
 */

import { describe, it, expect } from 'vitest';
import { shouldAllowReentryAfterLoss, detectMarketStress, ENTRY_COOLDOWN_MS } from '@cde/engine/execution';

describe('shouldAllowReentryAfterLoss', () => {
  it('allows immediate re-entry when price recovers +0.5% (trend reversed)', () => {
    const res = shouldAllowReentryAfterLoss({
      exitPrice: 100,
      currentPrice: 100.50,
      isLong: true,
      timeSinceExit: 5000 // 5 seconds
    });
    expect(res.allowed).toBe(true);
    expect(res.effectiveCooldown).toBe(0);
    expect(res.reason).toContain('Recovery');
  });

  it('disallows entry with weak recovery (+0.2-0.5%) until 15 min passes', () => {
    const res = shouldAllowReentryAfterLoss({
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
    const res = shouldAllowReentryAfterLoss({
      exitPrice: 100,
      currentPrice: 100.30, // +0.3%
      isLong: true,
      timeSinceExit: 16 * 60 * 1000 // 16 minutes (> 15 min reduced cooldown)
    });
    expect(res.allowed).toBe(true);
    expect(res.reason).toContain('Weak recovery');
  });

  it('keeps full 60-min cooldown when price stays below exit', () => {
    const res = shouldAllowReentryAfterLoss({
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
    const res = shouldAllowReentryAfterLoss({
      exitPrice: 100,
      currentPrice: 99.50, // -0.5% (good recovery for SHORT)
      isLong: false,
      timeSinceExit: 5000
    });
    expect(res.allowed).toBe(true);
    expect(res.effectiveCooldown).toBe(0);
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
