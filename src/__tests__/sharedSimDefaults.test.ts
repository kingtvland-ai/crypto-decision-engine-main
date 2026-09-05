import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SIM_BASE_DEFAULTS,
  SIM_MIN_CONFIDENCE,
  SIM_MAX_FUTURES_POSITIONS,
  simBotDefaults,
  type SimBotId
} from '@cde/engine/execution';

// The frontend and the worker used to hold independent copies of these numbers,
// kept in step by comments that said "matches tradingWorker.ts". They did not
// stay in step: Pro's config had been corrected to 58 while the panel's display
// fallback stayed at 60, so the UI advertised a threshold two points tighter
// than the one actually refusing trades.

const BOTS: SimBotId[] = ['intraday', 'legacy', 'pro', 'path'];

describe('shared sim defaults', () => {
  it('gives every bot a complete config', () => {
    for (const bot of BOTS) {
      const config = simBotDefaults(bot);
      expect(config.minConfidenceOverride).toBe(SIM_MIN_CONFIDENCE[bot]);
      expect(config.maxFuturesPositions).toBe(SIM_MAX_FUTURES_POSITIONS[bot]);
      expect(config.initialAmount).toBe(SIM_BASE_DEFAULTS.initialAmount);
      expect(config.maxPositions).toBe(SIM_BASE_DEFAULTS.maxPositions);
      expect(config.positionPercent).toBe(SIM_BASE_DEFAULTS.positionPercent);
    }
  });

  it('keeps the four floors distinct — they are calibrated per engine', () => {
    expect(SIM_MIN_CONFIDENCE.intraday).toBe(52);
    expect(SIM_MIN_CONFIDENCE.legacy).toBe(58);
    expect(SIM_MIN_CONFIDENCE.pro).toBe(58);
    // A probability, not a score. Never align this with the other three.
    expect(SIM_MIN_CONFIDENCE.path).toBe(33);
  });

  it('keeps bot 4 spot-only', () => {
    expect(SIM_MAX_FUTURES_POSITIONS.path).toBe(0);
  });

  it('caps the sims at the live bot’s position limit, not above it', () => {
    // At 7 the simulations carried 40% more concurrent risk than the bot they
    // exist to predict.
    expect(SIM_BASE_DEFAULTS.maxPositions).toBe(5);
  });

  it('returns a fresh object each call — a shared default must not be mutable state', () => {
    const a = simBotDefaults('pro');
    a.maxPositions = 99;
    expect(simBotDefaults('pro').maxPositions).toBe(SIM_BASE_DEFAULTS.maxPositions);
  });
});

describe('no second copy of the defaults survives', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

  it('the worker builds every sim config from the shared module', () => {
    const worker = read('server/tradingWorker.ts');
    for (const bot of BOTS) {
      // Built from the registry, with the environment layer passed IN rather
      // than spread over the result afterwards — that spread was how the
      // score-scaled BOT_MIN_CONFIDENCE reached the probability-scaled bot.
      expect(worker).toContain(`simBotDefaults('${bot}', SIM_ENV)`);
    }
    expect(worker).not.toMatch(/minConfidenceOverrideEnv \?\? \d+/);
  });

  it('each context builds its default config from the shared module', () => {
    const contexts: Array<[string, SimBotId]> = [
      ['src/contexts/SimulationBotContext.tsx', 'intraday'],
      ['src/contexts/LegacySimulationBotContext.tsx', 'legacy'],
      ['src/contexts/ProSimulationBotContext.tsx', 'pro'],
      ['src/contexts/PathSimulationBotContext.tsx', 'path']
    ];
    for (const [file, bot] of contexts) {
      expect(read(file)).toContain(`simBotDefaults('${bot}')`);
    }
  });

  it('no hand-typed confidence floor is left in the contexts or hooks', () => {
    const files = [
      'src/contexts/SimulationBotContext.tsx',
      'src/contexts/LegacySimulationBotContext.tsx',
      'src/contexts/ProSimulationBotContext.tsx',
      'src/contexts/PathSimulationBotContext.tsx',
      'src/hooks/useSimulationBot.ts',
      'src/hooks/useLegacySimulationBot.ts',
      'src/hooks/useProSimulationBot.ts'
    ];
    for (const file of files) {
      // `minConfidence: 58` / `minConfidence: activeSource.minConfidence ?? 60`
      expect(read(file)).not.toMatch(/minConfidence(?:Override)?:\s*(?:[^,\n]*\?\?\s*)?\d+/);
    }
  });
});

// ── Config bootstrap ─────────────────────────────────────────────────────────
//
// The shared module closes the compile-time half of the gap. The other half is
// the worker's environment layer (BOT_MIN_CONFIDENCE and friends), which a
// browser cannot read — so the panel showed the base and called it the default.
// These pin the two ends of the endpoint that closes it.

describe('config bootstrap endpoint', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
  const ROUTE = '/api/public/sim-defaults';

  it('the worker serves all four bots plus the env layer it applied', () => {
    const worker = read('server/tradingWorker.ts');
    expect(worker).toContain(ROUTE);
    const handler = worker.slice(worker.indexOf(ROUTE), worker.indexOf(ROUTE) + 1200);
    for (const config of ['DEFAULT_SIM_CONFIG', 'DEFAULT_LEGACY_SIM_CONFIG', 'DEFAULT_PRO_SIM_CONFIG', 'DEFAULT_PATH_SIM_CONFIG']) {
      expect(handler).toContain(config);
    }
    expect(handler).toContain('envOverrides');
  });

  it('is public, like /api/public/universe — it carries no credential', () => {
    // The auth guard exempts the /api/public prefix; a route outside it would
    // 401 the very unauthenticated callers that already read /api/sim/state.
    // The exempt list is now derived (see simBotRegistry.test.ts) rather than
    // being a hand-written chain, so assert the list, not the old expression.
    expect(ROUTE.startsWith('/api/public/')).toBe(true);
    const worker = read('server/tradingWorker.ts');
    expect(worker).toContain('UNAUTHENTICATED_PREFIXES');
    expect(worker).toContain("'/api/public'");
  });

  it('the client calls the same path the worker serves', () => {
    expect(read('src/services/tradingApiClient.ts')).toContain(ROUTE);
  });

  it('every context adopts its own bot’s defaults', () => {
    const contexts: Array<[string, SimBotId]> = [
      ['src/contexts/SimulationBotContext.tsx', 'intraday'],
      ['src/contexts/LegacySimulationBotContext.tsx', 'legacy'],
      ['src/contexts/ProSimulationBotContext.tsx', 'pro'],
      ['src/contexts/PathSimulationBotContext.tsx', 'path']
    ];
    for (const [file, bot] of contexts) {
      expect(read(file)).toContain(`useServerSimDefaults('${bot}'`);
    }
  });

  it('the running config wins: the hook is gated on configFromServer', () => {
    // A bot mid-run has a config that is a FACT. Overwriting it with what a
    // fresh bot would start with is worse than the placeholder it replaces.
    const hook = read('src/hooks/useServerSimDefaults.ts');
    expect(hook).toContain('hasServerConfigRef.current');
    for (const file of [
      'src/contexts/SimulationBotContext.tsx',
      'src/contexts/LegacySimulationBotContext.tsx',
      'src/contexts/ProSimulationBotContext.tsx',
      'src/contexts/PathSimulationBotContext.tsx'
    ]) {
      expect(read(file)).toContain('configFromServer.current = true;');
    }
  });

  it('writes locally and never pushes — no setConfig in the bootstrap path', () => {
    // Calling setConfig() here would POST a config the operator did not choose,
    // turning a display fix into an unrequested write to the worker.
    const hook = read('src/hooks/useServerSimDefaults.ts');
    expect(hook).not.toMatch(/set\w*SimConfig\(/);
  });
});
