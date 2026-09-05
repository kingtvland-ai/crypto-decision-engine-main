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

// Four bots, enumerated by hand in the route table, the auth exempt list, the
// stores, the tick loops and eight portfolio aggregations. Every one of those
// lists was forgotten at least once. These tests hold the registry to being the
// single definition, so forgetting is a failing test rather than a bot that
// silently never runs.

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('the registry covers every bot', () => {
  it('lists all four, in the order the page renders them', () => {
    expect(SIM_BOT_IDS).toEqual(['intraday', 'legacy', 'pro', 'path']);
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

describe('Test B — scale parity: a score floor never lands on a probability bot', () => {
  // BOT_MIN_CONFIDENCE is a signal score. The Path bot's "confidence" is the
  // Wilson lower bound of a hit rate. At the deployed value of 60 the shared
  // knob asked Path for a bucket that hits 60% of the time at a 1.5R target —
  // which does not exist — so it silenced the bot while reading as an ordinary
  // setting.
  it('labels each bot with what its confidence number means', () => {
    expect(SIM_BOTS.intraday.confidenceScale).toBe('score');
    expect(SIM_BOTS.legacy.confidenceScale).toBe('score');
    expect(SIM_BOTS.pro.confidenceScale).toBe('score');
    expect(SIM_BOTS.path.confidenceScale).toBe('probability');
  });

  it('applies BOT_MIN_CONFIDENCE to the score bots only', () => {
    const env = { minConfidence: 60 };
    expect(simBotDefaults('intraday', env).minConfidenceOverride).toBe(60);
    expect(simBotDefaults('legacy', env).minConfidenceOverride).toBe(60);
    expect(simBotDefaults('pro', env).minConfidenceOverride).toBe(60);
    // The regression: this was 60, and 60 is unreachable on a probability scale.
    expect(simBotDefaults('path', env).minConfidenceOverride).toBe(33);
  });

  it('gives the probability bot its own knob', () => {
    const config = simBotDefaults('path', { minConfidence: 60, pathMinConfidence: 40 });
    expect(config.minConfidenceOverride).toBe(40);
  });

  it('leaves the score bots untouched by the path knob', () => {
    const config = simBotDefaults('legacy', { pathMinConfidence: 40 });
    expect(config.minConfidenceOverride).toBe(58);
  });

  it('with no environment, returns the compile-time base unchanged', () => {
    for (const id of SIM_BOT_IDS) {
      const config = simBotDefaults(id);
      expect(config.minConfidenceOverride).toBe(SIM_BOTS[id].minConfidence);
      expect(config.maxPositions).toBe(SIM_BASE_DEFAULTS.maxPositions);
      expect(config.maxFuturesPositions).toBe(SIM_BOTS[id].maxFuturesPositions);
    }
  });

  it('applies the non-confidence environment layer to every bot alike', () => {
    const env = { positionPercent: 4, maxPositions: 9, riskLevel: 'high' as const };
    for (const id of SIM_BOT_IDS) {
      const config = simBotDefaults(id as SimBotId, env);
      expect(config.positionPercent).toBe(4);
      expect(config.maxPositions).toBe(9);
      expect(config.riskLevel).toBe('high');
    }
  });

  it('keeps bot 4 spot-only whatever the environment says', () => {
    expect(simBotDefaults('path', { maxPositions: 9 }).maxFuturesPositions).toBe(0);
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
  it('the path table is loaded from the store, not from a gitignored file', () => {
    const engine = read('server/pathSimEngine.ts');
    // The old loader read path-study/table.json off local disk — a path inside
    // a gitignored directory, so it never existed on the server and the bot
    // silently ran the in-sample fallback on every deploy.
    expect(engine).not.toContain('path-study');
    expect(engine).not.toContain('readFileSync');
    expect(engine).toContain('installValidatedTable');

    const worker = read('server/tradingWorker.ts');
    expect(worker).toContain('pathTableStore');
    expect(worker).toContain('hydratePathTable');
  });

  it('every bot’s store key comes from the registry', () => {
    const worker = read('server/tradingWorker.ts');
    expect(worker).toContain('simStoreFor');
    for (const spec of SIM_BOT_SPECS) {
      expect(spec.storeKey).toMatch(/^[a-z-]+-state$/);
    }
  });

  it('reports WHY the table is empty, not just that it is', () => {
    // "no symbol had enough history yet" and "nothing cleared the expectancy
    // bar" are both zero buckets and completely different situations.
    const engine = read('server/pathSimEngine.ts');
    expect(engine).toContain('readiness');
    expect(engine).toContain('warming-up');
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
