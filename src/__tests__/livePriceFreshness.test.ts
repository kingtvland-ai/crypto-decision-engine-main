/**
 * Live Freshness Guarantee (2026-09-15)
 * ============================================================================
 * Root-caused a user report of three symptoms that turned out to be ONE bug:
 * `CRYPTO_REFRESH_MS` in server/simEngineFactory.ts throttled the LOCAL price
 * copy (`lastPrices`, read by every stop-loss/take-profit/ratchet check via
 * `priceFor()`) to once every 60 SECONDS, even though:
 *   - the underlying bulk fetch (getAggregatedPrices → fetchBybitAllTickers)
 *     already pulls the WHOLE traded universe in one call and cached it for
 *     only 10s (now 2.5s) — the 60s gate sat on top of that, doing nothing
 *     but adding staleness;
 *   - the sim tick loop itself ran every 4s (now 2.5s), so `priceFor()` could
 *     return a price up to 60s stale on every single tick;
 *   - the profit ratchet's peak tracking (`highestPrice`/`lowestPrice`) is
 *     updated from that same stale price, so a 1.8%/3%+ spike that reversed
 *     within the 60s window was invisible to it — exactly the "ratchet isn't
 *     catching momentary spikes" symptom reported.
 *
 * These tests pin the pure predicate behind the fix — the 3-second hard
 * backstop that forces an immediate re-fetch when the passive refresh (also
 * shortened, see cryptoPriceAggregator.ts) didn't keep up.
 */

import { describe, it, expect } from 'vitest';
import { needsForcedPriceRefresh } from '../../server/simEngineFactory';

const T0 = 1_700_000_000_000;

describe('needsForcedPriceRefresh', () => {
  it('does nothing when there are no open positions — nothing to mark or exit-check', () => {
    expect(needsForcedPriceRefresh(T0, T0 + 10_000, false)).toBe(false);
  });

  it('does not force a refresh when the last one is within the freshness window', () => {
    expect(needsForcedPriceRefresh(T0, T0 + 2_999, true)).toBe(false);
  });

  it('is exactly at the 3-second boundary — equal age does not yet force (strict >)', () => {
    expect(needsForcedPriceRefresh(T0, T0 + 3_000, true)).toBe(false);
  });

  it('forces a refresh the instant the price is more than 3 seconds old', () => {
    expect(needsForcedPriceRefresh(T0, T0 + 3_001, true)).toBe(true);
  });

  it('forces a refresh for badly stale data (simulating the old 60s gate)', () => {
    expect(needsForcedPriceRefresh(T0, T0 + 60_000, true)).toBe(true);
  });

  it('a custom freshness threshold is honoured (parametrized, not hardcoded)', () => {
    expect(needsForcedPriceRefresh(T0, T0 + 1_500, true, 1_000)).toBe(true);
    expect(needsForcedPriceRefresh(T0, T0 + 500, true, 1_000)).toBe(false);
  });
});
