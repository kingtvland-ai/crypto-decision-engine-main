/**
 * The simulation-bot registry — one definition of what a sim bot IS.
 * ============================================================================
 *
 * Three bots exist: Intraday (the real bot's own multi-timeframe engine),
 * Pro (alg.md's weighted-indicator confidence engine), and Path (bot 4, the
 * 4H lookup-table engine). A fourth — Legacy — existed here and was deleted:
 * its own decision logic (tradeEngine.ts's signal/router/risk/exit stack) went
 * with it, not just its UI card.
 *
 * Before this file the surviving bots were enumerated by hand everywhere that
 * had to know about them: the route table, the auth exempt list, the stores,
 * the tick loops, the frontend contexts, and several portfolio aggregations.
 * Several hand-written lists is not several sources of truth, it is several
 * chances to forget one — and every one of them was forgotten at least once:
 *
 *   · the portfolio risk meter under-reported exposure for as long as Path
 *     held a position, because it summed the OTHER bots by name;
 *   · the Pro panel displayed a 60 floor while its (former) engine gated on
 *     58;
 *   · the auth guard's exempt list omitted `/api/path-sim/`, so every one of
 *     bot 4's six endpoints answered 401 to a browser that sends no token.
 *
 * So this file holds each fact once, and the consumers derive. Registering a
 * new bot is one entry here; anything that forgets to handle it fails to
 * compile rather than failing at runtime in a way that looks like "the
 * strategy found nothing".
 */

import type { SimBotConfig } from './simExecution';

export type SimBotId = 'intraday' | 'pro' | 'path';

/**
 * What a bot's `confidence` number MEANS.
 *
 * Intraday and Pro report a signal score: a weighted 0-100 built from
 * indicators (Pro's is alg.md §2's dominance/margin/coverage formula). Path
 * reports the Wilson lower bound of its bucket's hit rate — a PROBABILITY. The
 * two share a name, a config field and a UI column, and they are not
 * comparable: 33 is a good probability and a terrible score.
 *
 * This is not a cosmetic distinction. `BOT_MIN_CONFIDENCE` is a single operator
 * knob applied to every score-scaled bot, and applying it to a
 * probability-scaled bot silences it while reading as a reasonable setting.
 * `simBotDefaults` below refuses to apply a score-scaled override to a
 * probability-scaled bot for exactly that reason.
 */
export type ConfidenceScale = 'score' | 'probability';

export interface SimBotSpec {
  id: SimBotId;
  /** Display name, Hebrew — the UI and the risk meter both label with this. */
  label: string;
  /** Route namespace on the worker, WITHOUT a trailing slash. */
  routePrefix: string;
  /** Key for this bot's persisted state in the KV store. */
  storeKey: string;
  /**
   * True when the browser calls these routes directly.
   *
   * These bots are UI-facing: the simulation page polls them from a plain
   * `fetch` with no Authorization header. The REAL trading bot (`/api/bot`,
   * `/api/account`, `/api/decisions`) is not in this registry and stays
   * behind the token — that is the correct posture for routes that move
   * actual money.
   */
  uiFacing: boolean;
  confidenceScale: ConfidenceScale;
  /** Confidence floor when the operator sets none. In this bot's own scale.
   *
   *  For Pro specifically: alg.md §3 makes this a function of risk level
   *  (55/40/25 for low/medium/high), not one flat number. This is the
   *  medium-risk value — SIM_BASE_DEFAULTS.riskLevel's own default — used only
   *  as the resting value before any config exists; `proMinConfidence()` is
   *  what the engine actually gates on. */
  minConfidence: number;
  /**
   * True only for Pro: its confidence floor is a FUNCTION of risk level
   * (alg.md §3), not a flat number. When true, `simBotDefaults()` leaves
   * `minConfidenceOverride` at 0 ("not set") unless the operator's own
   * override env var is present — the engine's `proMinConfidence()` then
   * applies §3's table for whichever risk level is configured. Forcing
   * `spec.minConfidence` in as a permanent override would pin the threshold
   * at one risk level's value even after the operator switches risk levels,
   * which defeats the point of the table.
   */
  confidenceDerivedFromRiskLevel?: boolean;
  /** Path is 0 by strategy, not by oversight: bot 4 is spot-only. Pro is also
   *  spot-only per alg.md §4 ("the system does not open shorts") — 0 here
   *  reflects that, not an omission. */
  maxFuturesPositions: number;
}

export const SIM_BOTS: Record<SimBotId, SimBotSpec> = {
  intraday: {
    id: 'intraday',
    label: 'חדש',
    routePrefix: '/api/sim',
    storeKey: 'sim-state',
    uiFacing: true,
    confidenceScale: 'score',
    minConfidence: 52,
    maxFuturesPositions: 2
  },
  pro: {
    id: 'pro',
    label: 'פרו',
    routePrefix: '/api/pro-sim',
    storeKey: 'pro-sim-state',
    uiFacing: true,
    confidenceScale: 'score',
    // alg.md §3's medium-risk value — display default only, see
    // confidenceDerivedFromRiskLevel.
    minConfidence: 40,
    confidenceDerivedFromRiskLevel: true,
    maxFuturesPositions: 0
  },
  path: {
    id: 'path',
    label: 'נתיב 4H',
    routePrefix: '/api/path-sim',
    storeKey: 'path-sim-state',
    uiFacing: true,
    // A probability, not a score. See ConfidenceScale.
    confidenceScale: 'probability',
    minConfidence: 33,
    maxFuturesPositions: 0
  }
};

/** Stable order: the order the simulation page lays the columns out in. */
export const SIM_BOT_IDS: SimBotId[] = ['intraday', 'pro', 'path'];

export const SIM_BOT_SPECS: SimBotSpec[] = SIM_BOT_IDS.map((id) => SIM_BOTS[id]);

/** Route prefixes the browser reaches without a token. Derived, never retyped. */
export const UI_FACING_SIM_PREFIXES: string[] = SIM_BOT_SPECS
  .filter((spec) => spec.uiFacing)
  .map((spec) => spec.routePrefix);

/** Kept as a lookup for callers that only want the number. */
export const SIM_MIN_CONFIDENCE: Record<SimBotId, number> = {
  intraday: SIM_BOTS.intraday.minConfidence,
  pro: SIM_BOTS.pro.minConfidence,
  path: SIM_BOTS.path.minConfidence
};

export const SIM_MAX_FUTURES_POSITIONS: Record<SimBotId, number> = {
  intraday: SIM_BOTS.intraday.maxFuturesPositions,
  pro: SIM_BOTS.pro.maxFuturesPositions,
  path: SIM_BOTS.path.maxFuturesPositions
};

/**
 * Everything the bots hold in common.
 *
 * `maxPositions` is 5 — the cap the live bot runs. It used to be 7 in the
 * sims, which let every simulation carry 40% more concurrent risk than the
 * bot it exists to predict.
 *
 * `positionPercent` is 10, matching the live bot. Pro does not actually read
 * it: alg.md §3/§6 size Pro's entries from risk-level allocation
 * (`proAllocationPercent`), not from an operator-set percentage. It stays here
 * so Pro's config object has the same shape as every other bot's.
 */
export const SIM_BASE_DEFAULTS = {
  riskLevel: 'medium' as const,
  initialAmount: 10000,
  maxPositions: 5,
  feePercent: 0.1,
  slippagePercent: 0.05,
  executionDelaySec: 3,
  positionPercent: 10
};

/**
 * The deploy-time layer, read from the worker's environment.
 *
 * The browser cannot see environment variables, which is why this is a
 * parameter rather than something this module reads for itself: the worker
 * passes what it found, and the frontend passes nothing and gets the base.
 */
export interface SimEnvOverrides {
  /** BOT_MIN_CONFIDENCE. A SCORE — see the guard in simBotDefaults. For Pro
   *  this is alg.md §3's `minConfidenceOverride`. */
  minConfidence?: number;
  /** BOT_PATH_MIN_CONFIDENCE. A probability, for the one bot that speaks in them. */
  pathMinConfidence?: number;
  positionPercent?: number;
  maxPositions?: number;
  riskLevel?: 'low' | 'medium' | 'high';
}

/**
 * The full default config for one bot, with the operator's environment applied.
 *
 * Called with no `env` — which is what the browser does — it returns the pure
 * compile-time base, unchanged from before this parameter existed.
 *
 * The one rule worth stating out loud: `env.minConfidence` is applied ONLY to
 * bots whose confidence is a score. Applying a score threshold to a probability
 * is not a stricter setting, it is a category error that happens to typecheck.
 * An operator who wants a floor on the probability-scaled bot sets
 * `BOT_PATH_MIN_CONFIDENCE`: one knob per meaning, rather than one knob
 * straddling two.
 */
export function simBotDefaults(id: SimBotId, env: SimEnvOverrides = {}): SimBotConfig {
  const spec = SIM_BOTS[id];

  const minConfidenceOverride = spec.confidenceDerivedFromRiskLevel
    // 0 = "not set": Pro's own proMinConfidence() applies §3's risk-level
    // table. Only an explicit operator override replaces that.
    ? (env.minConfidence ?? 0)
    : spec.confidenceScale === 'probability'
      ? (env.pathMinConfidence ?? spec.minConfidence)
      : (env.minConfidence ?? spec.minConfidence);

  return {
    ...SIM_BASE_DEFAULTS,
    riskLevel: env.riskLevel ?? SIM_BASE_DEFAULTS.riskLevel,
    maxPositions: env.maxPositions ?? SIM_BASE_DEFAULTS.maxPositions,
    positionPercent: env.positionPercent ?? SIM_BASE_DEFAULTS.positionPercent,
    maxFuturesPositions: spec.maxFuturesPositions,
    minConfidenceOverride
  };
}
