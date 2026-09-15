/**
 * Cross-bot symbol concentration cap (2026-09-15)
 * ============================================================================
 * LA opened in Path, Pro and Bybit simultaneously on 2026-09-15 and lost
 * -$90.56 combined (48% of that session's total loss) when it broke down —
 * three independently-approved 10%-of-equity positions the per-bot risk model
 * never saw as one correlated bet. These tests pin the registry that now
 * blocks a THIRD bot from piling onto a symbol two others already hold.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerBotHoldings,
  countOtherBotsHolding,
  otherBotsHolding,
  wouldExceedCrossBotCap,
  CROSS_BOT_MAX_HOLDERS_PER_SYMBOL,
  _resetCrossBotExposureForTests
} from '../../server/crossBotExposure';

beforeEach(() => {
  _resetCrossBotExposureForTests();
});

describe('registerBotHoldings / countOtherBotsHolding', () => {
  it('counts zero when no bot has registered anything', () => {
    expect(countOtherBotsHolding('LAUSDT', 'pro')).toBe(0);
  });

  it('does not count the bot against itself', () => {
    registerBotHoldings('pro', ['LAUSDT']);
    expect(countOtherBotsHolding('LAUSDT', 'pro')).toBe(0);
  });

  it('counts other bots holding the same symbol', () => {
    registerBotHoldings('pro', ['LAUSDT']);
    registerBotHoldings('path', ['LAUSDT']);
    registerBotHoldings('bybit', ['LAUSDT']);
    expect(countOtherBotsHolding('LAUSDT', 'intraday')).toBe(3);
    expect(countOtherBotsHolding('LAUSDT', 'pro')).toBe(2);
  });

  it('a later call REPLACES the bot\'s previous holdings, never accumulates', () => {
    registerBotHoldings('pro', ['LAUSDT', 'BTCUSDT']);
    registerBotHoldings('pro', ['BTCUSDT']); // LA closed since last tick
    expect(countOtherBotsHolding('LAUSDT', 'intraday')).toBe(0);
    expect(countOtherBotsHolding('BTCUSDT', 'intraday')).toBe(1);
  });

  it('ignores symbols the bot does not hold', () => {
    registerBotHoldings('pro', ['BTCUSDT']);
    expect(countOtherBotsHolding('LAUSDT', 'intraday')).toBe(0);
  });
});

describe('otherBotsHolding', () => {
  it('names the holders, sorted, excluding self', () => {
    registerBotHoldings('bybit', ['LAUSDT']);
    registerBotHoldings('path', ['LAUSDT']);
    registerBotHoldings('pro', ['LAUSDT']);
    expect(otherBotsHolding('LAUSDT', 'intraday')).toEqual(['bybit', 'path', 'pro']);
    expect(otherBotsHolding('LAUSDT', 'pro')).toEqual(['bybit', 'path']);
  });

  it('is empty when nobody holds the symbol', () => {
    expect(otherBotsHolding('LAUSDT', 'pro')).toEqual([]);
  });
});

describe('wouldExceedCrossBotCap — the actual gate', () => {
  it('allows the FIRST bot into an empty symbol', () => {
    expect(wouldExceedCrossBotCap('LAUSDT', 'path')).toBe(false);
  });

  it('allows a SECOND bot alongside one holder (two independent signals agreeing is normal)', () => {
    registerBotHoldings('path', ['LAUSDT']);
    expect(wouldExceedCrossBotCap('LAUSDT', 'pro')).toBe(false);
  });

  it('blocks a THIRD bot once two others already hold the symbol — the observed LA case', () => {
    registerBotHoldings('path', ['LAUSDT']);
    registerBotHoldings('pro', ['LAUSDT']);
    expect(wouldExceedCrossBotCap('LAUSDT', 'bybit')).toBe(true);
    expect(wouldExceedCrossBotCap('LAUSDT', 'intraday')).toBe(true);
  });

  it('a bot already holding the symbol is not blocked from also being counted as itself', () => {
    // path + pro hold LA; path re-checking (e.g. re-evaluating while already
    // in) must not count itself as a third holder.
    registerBotHoldings('path', ['LAUSDT']);
    registerBotHoldings('pro', ['LAUSDT']);
    expect(wouldExceedCrossBotCap('LAUSDT', 'path')).toBe(false);
  });

  it('does not block a DIFFERENT symbol just because one symbol is saturated', () => {
    registerBotHoldings('path', ['LAUSDT']);
    registerBotHoldings('pro', ['LAUSDT']);
    expect(wouldExceedCrossBotCap('BTCUSDT', 'bybit')).toBe(false);
  });

  it('the cap constant is 2 — two holders is fine, a third is not', () => {
    expect(CROSS_BOT_MAX_HOLDERS_PER_SYMBOL).toBe(2);
  });
});

describe('_resetCrossBotExposureForTests', () => {
  it('clears all registered state', () => {
    registerBotHoldings('pro', ['LAUSDT']);
    _resetCrossBotExposureForTests();
    expect(countOtherBotsHolding('LAUSDT', 'intraday')).toBe(0);
  });
});
