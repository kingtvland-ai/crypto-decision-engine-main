import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SIM_BOTS,
  SIM_BOT_IDS,
  SIM_BOT_SPECS,
  UI_FACING_SIM_PREFIXES,
  SIM_BASE_DEFAULTS,
  simBotDefaults,
  MIN_PATH_CANDLES,
  PATH_MIN_H4_BARS,
  type SimBotId
} from '@cde/engine/execution';
import { TIMEFRAME_SPECS } from '@cde/engine/market-data';

// Three bots, enumerated by hand in the route table, the auth exempt list, the
// stores, the tick loops and the portfolio aggregations. Every one of those
// lists was forgotten at least once. These tests hold the registry to being the
// single definition, so forgetting is a failing test rather than a bot that
// silently never runs.

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('the registry covers every bot', () => {
  it('lists all four, in the order the page renders them', () => {
    expect(SIM_BOT_IDS).toEqual(['intraday', 'pro', 'path', 'bybit']);
    expect(SIM_BOT_SPECS).toHaveLength(4);
  });

  it('gives each bot a unique route prefix and store key', () => {
    const prefixes = SIM_BOT_SPECS.map((s) => s.routePrefix);
    const keys = SIM_BOT_SPECS.map((s) => s.storeKey);
    expect(new Set(prefixes).size).toBe(4);
    expect(new Set(keys).size).toBe(4);
  });

  it('never collides with the real trading bot’s namespace', () => {
    // /api/bot, /api/account and /api/decisions move actual money and are
    // deliberately absent from this registry — they stay behind the token.
    for (const spec of SIM_BOT_SPECS) {
      expect(spec.routePrefix.startsWith('/api/bot')).toBe(false);
      expect(spec.routePrefix.startsWith('/api/account')).toBe(false);
    }
  });
});

describe('Test A — routing parity: every sim bot is reachable without a token', () => {
  // THE regression. `/api/path-sim/` was missing from the auth guard's exempt
  // chain, so all six of bot 4's endpoints answered 401 to a frontend that
  // sends no Authorization header — start, stop, reset, config, state and
  // table. The bot never received a start command and never ran a tick, and the
  // UI showed a card that never moved.
  it('exposes every ui-facing prefix', () => {
    expect(UI_FACING_SIM_PREFIXES).toContain('/api/path-sim');
    expect(UI_FACING_SIM_PREFIXES).toContain('/api/bybit-sim');
    expect(UI_FACING_SIM_PREFIXES).toHaveLength(4);
  });

  it('the worker derives its exempt list instead of retyping the prefixes', () => {
    const worker = read('server/tradingWorker.ts');
    expect(worker).toContain('UI_FACING_SIM_PREFIXES');
    // The old hand-written chain must be gone: it is the thing that could omit
    // a bot while still compiling and still passing every other test.
    expect(worker).not.toContain("!url.pathname.startsWith('/api/legacy-sim/')");
    expect(worker).not.toContain("!url.pathname.startsWith('/api/pro-sim/')");
  });

  it('keeps the real bot’s routes authenticated', () => {
    for (const prefix of UI_FACING_SIM_PREFIXES) {
      expect(['/api/bot', '/api/account', '/api/decisions']).not.toContain(prefix);
    }
  });

  it('the client calls every prefix the registry publishes', () => {
    const client = read('src/services/tradingApiClient.ts');
    for (const spec of SIM_BOT_SPECS) {
      expect(client).toContain(`${spec.routePrefix}/state`);
    }
  });
});

describe('Test B — scale parity: every sim bot now reports a 0-100 signal score', () => {
  // Historical note: the Path bot used to report a PROBABILITY (a Wilson lower
  // bound), and BOT_MIN_CONFIDENCE — a score — silenced it at the deployed
  // value of 60. That engine and its lookup table were removed; Prev-4H Range
  // reports a weighted score like the other three, so the probability special
  // case in simBotDefaults() is now dormant.
  it('labels each bot with what its confidence number means', () => {
    expect(SIM_BOTS.intraday.confidenceScale).toBe('score');
    expect(SIM_BOTS.pro.confidenceScale).toBe('score');
    expect(SIM_BOTS.path.confidenceScale).toBe('score');
    expect(SIM_BOTS.bybit.confidenceScale).toBe('score');
  });

  it('applies BOT_MIN_CONFIDENCE to intraday and pro (shared knob)', () => {
    const env = { minConfidence: 60 };
    expect(simBotDefaults('intraday', env).minConfidenceOverride).toBe(60);
    expect(simBotDefaults('pro', env).minConfidenceOverride).toBe(60);
    // Bybit has its own knob (BOT_BYBIT_MIN_CONFIDENCE) to avoid dampening
    // its separate confidence distribution, so the shared knob does NOT reach it.
    expect(simBotDefaults('bybit', env).minConfidenceOverride).toBe(70); // its default, not 60
  });

  it('applies BOT_BYBIT_MIN_CONFIDENCE to bybit only (separate knob)', () => {
    const env = { minConfidence: 60, bybitMinConfidence: 65 };
    expect(simBotDefaults('bybit', env).minConfidenceOverride).toBe(65);
    expect(simBotDefaults('intraday', env).minConfidenceOverride).toBe(60);
    expect(simBotDefaults('pro', env).minConfidenceOverride).toBe(60);
  });

  it('path has its own knob (BOT_PATH_MIN_CONFIDENCE), separate from the shared knob', () => {
    const env = { minConfidence: 60, pathMinConfidence: 62 };
    // Path uses pathMinConfidence if set, not the shared knob.
    expect(simBotDefaults('path', env).minConfidenceOverride).toBe(62);
    // Intraday and Pro use the shared knob.
    expect(simBotDefaults('intraday', env).minConfidenceOverride).toBe(60);
  });

  it('with no environment, returns the compile-time base unchanged', () => {
    for (const id of SIM_BOT_IDS) {
      const config = simBotDefaults(id);
      // Pro's base is UNSET (0 — confidenceDerivedFromRiskLevel) so the engine's
      // proMinConfidence() table governs; every other bot carries its floor.
      const expected = id === 'pro' ? 0 : SIM_BOTS[id].minConfidence;
      expect(config.minConfidenceOverride).toBe(expected);
      expect(config.maxPositions).toBe(SIM_BASE_DEFAULTS.maxPositions);
      expect(config.maxFuturesPositions).toBe(SIM_BOTS[id].maxFuturesPositions);
    }
  });

  it('applies the non-confidence environment layer to every bot alike', () => {
    // maxPositions is NOT taken from env — it is derived from riskLevel
    // (riskLevelToMaxPositions: low 3 / medium 5 / high 7). BOT_MAX_OPEN_POSITIONS
    // is the LIVE bot's knob only.
    const env = { positionPercent: 4, maxPositions: 9, riskLevel: 'high' as const };
    for (const id of SIM_BOT_IDS) {
      const config = simBotDefaults(id as SimBotId, env);
      expect(config.positionPercent).toBe(4);
      expect(config.riskLevel).toBe('high');
      expect(config.maxPositions).toBe(7); // from riskLevel:'high', not env.maxPositions(9)
    }
  });

  it('keeps each bot’s futures cap fixed whatever the environment says', () => {
    // Path (Prev-4H Range) and Bybit take SHORTs as 1x futures. Pro gained
    // the same SHORT capability 2026-09-17 (hard-vetoed against shorting
    // into an uptrend) — no longer spot-only, no longer 0.
    expect(simBotDefaults('path', { maxPositions: 9 }).maxFuturesPositions).toBe(2);
    expect(simBotDefaults('pro', { maxPositions: 9 }).maxFuturesPositions).toBe(2);
    expect(simBotDefaults('bybit', { maxPositions: 9 }).maxFuturesPositions).toBe(3);
  });
});

describe('Test C — the fetcher covers its most demanding consumer', () => {
  // MIN_PATH_CANDLES (248) and TIMEFRAME_SPECS['1h'].targetCandles were written
  // independently at 244 and 240. Every symbol failed the check on a cold start
  // and the table came back empty — indistinguishable, in the status endpoint,
  // from a strategy that had found nothing.
  it('pulls enough 1h history for the Path bot to build its 4H series', () => {
    expect(TIMEFRAME_SPECS['1h'].targetCandles).toBeGreaterThanOrEqual(MIN_PATH_CANDLES);
  });

  it('derives the requirement from the bar count it exists to satisfy', () => {
    expect(MIN_PATH_CANDLES).toBe(PATH_MIN_H4_BARS * 4);
    expect(Math.floor(TIMEFRAME_SPECS['1h'].targetCandles / 4)).toBeGreaterThanOrEqual(PATH_MIN_H4_BARS);
  });
});

describe('Test D — durable state goes through the KV store', () => {
  it('every bot’s store key comes from the registry', () => {
    const worker = read('server/tradingWorker.ts');
    expect(worker).toContain('simStoreFor');
    for (const spec of SIM_BOT_SPECS) {
      expect(spec.storeKey).toMatch(/^[a-z-]+-state$/);
    }
  });

  it('the removed path-table apparatus leaves no dangling wiring', () => {
    // The empirical-bucket engine and its /api/path-sim/table endpoint were
    // deleted; nothing should still reference the table store or its loader.
    const worker = read('server/tradingWorker.ts');
    expect(worker).not.toContain('pathTableStore');
    expect(worker).not.toContain('hydratePathTable');
    expect(worker).not.toContain('/api/path-sim/table');
    expect(read('src/services/tradingApiClient.ts')).not.toContain('/api/path-sim/table');
  });
});

describe('Test E — one ticker, not four', () => {
  it('drives every bot through the same loop', () => {
    const worker = read('server/tradingWorker.ts');
    expect(worker).toContain('startSimTicker');
    for (const id of SIM_BOT_IDS) {
      expect(worker).toContain(`startSimTicker('${id}'`);
    }
  });
});
