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
import { POSITION_TARGET_PCT, MAX_TOTAL_EXPOSURE_PERCENT } from './intradayParams';

export type SimBotId = 'intraday' | 'pro' | 'path' | 'bybit';

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
    minConfidence: 50,
    maxFuturesPositions: 2
  },
  pro: {
    id: 'pro',
    label: 'פרו',
    routePrefix: '/api/pro-sim',
    storeKey: 'pro-sim-state',
    uiFacing: true,
    confidenceScale: 'score',
    // Operator's flat entry bar (50): the bot enters a BUY once the overall
    // confidence crosses it, regardless of risk level. PRO_CONFIDENCE_BY_RISK
    // stays exported as §3's reference table.
    minConfidence: 50,
    confidenceDerivedFromRiskLevel: true,
    maxFuturesPositions: 0
  },
  path: {
    id: 'path',
    label: 'נתיב 4H',
    routePrefix: '/api/path-sim',
    storeKey: 'path-sim-state',
    uiFacing: true,
    // Prev-4H Range reports a weighted 0-100 SIGNAL score (breakout distance +
    // trend strength + range quality) — same scale family as Intraday / Pro /
    // Bybit. The old empirical-bucket engine reported a probability (a Wilson
    // lower bound); that engine and its lookup table were removed.
    confidenceScale: 'score',
    minConfidence: 55,
    // Not spot-only: a breakout BELOW the previous 4H low is simulated as a
    // 1x FUTURES short (spot cannot short), same as the Bybit bot.
    maxFuturesPositions: 2
  },
  bybit: {
    id: 'bybit',
    label: 'Bybit · פריצת מגמה',
    routePrefix: '/api/bybit-sim',
    storeKey: 'bybit-sim-state',
    uiFacing: true,
    // TrendBreakout reports a weighted 0-100 SIGNAL score (spec §7), same scale
    // family as Intraday and Pro — not a probability like Path.
    confidenceScale: 'score',
    minConfidence: 70,
    // Unlike Pro and Path this bot is NOT spot-only: SHORT setups are simulated
    // as 1x FUTURES positions (spot cannot short), and scale-in opens up to 3
    // lots per logical trade — hence a non-zero futures cap.
    maxFuturesPositions: 3
  }
};

/** Stable order: the order the simulation page lays the columns out in. */
export const SIM_BOT_IDS: SimBotId[] = ['intraday', 'pro', 'path', 'bybit'];

export const SIM_BOT_SPECS: SimBotSpec[] = SIM_BOT_IDS.map((id) => SIM_BOTS[id]);

/** Route prefixes the browser reaches without a token. Derived, never retyped. */
export const UI_FACING_SIM_PREFIXES: string[] = SIM_BOT_SPECS
  .filter((spec) => spec.uiFacing)
  .map((spec) => spec.routePrefix);

/** Kept as a lookup for callers that only want the number. */
export const SIM_MIN_CONFIDENCE: Record<SimBotId, number> = {
  intraday: SIM_BOTS.intraday.minConfidence,
  pro: SIM_BOTS.pro.minConfidence,
  path: SIM_BOTS.path.minConfidence,
  bybit: SIM_BOTS.bybit.minConfidence
};

export const SIM_MAX_FUTURES_POSITIONS: Record<SimBotId, number> = {
  intraday: SIM_BOTS.intraday.maxFuturesPositions,
  pro: SIM_BOTS.pro.maxFuturesPositions,
  path: SIM_BOTS.path.maxFuturesPositions,
  bybit: SIM_BOTS.bybit.maxFuturesPositions
};

/**
 * Everything the bots hold in common.
 *
 * `maxPositions` is derived from the RISK PROFILE, not stored here — see
 * `riskLevelToMaxPositions` (low 3 / medium 5 / high 7). This value is the
 * medium default and is used only as a last-resort fallback where a config's
 * own `maxPositions` is somehow missing. Each position is still 10% of equity;
 * the profile changes COUNT, never SIZE (§12).
 *
 * `positionPercent` is 10, matching the live bot. Pro does not actually read
 * it: alg.md §3/§6 size Pro's entries from risk-level allocation
 * (`proAllocationPercent`), not from an operator-set percentage. It stays here
 * so Pro's config object has the same shape as every other bot's.
 */
export const SIM_BASE_DEFAULTS = {
  riskLevel: 'medium' as const,
  initialAmount: 10000,
  maxPositions: 5, // = riskLevelToMaxPositions('medium'); real value is per-config
  feePercent: 0.1,
  slippagePercent: 0.1,
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
  /** BOT_MIN_CONFIDENCE. A SCORE applied to Intraday and Pro only — see the
   *  guard in simBotDefaults. For Pro this is alg.md §3's `minConfidenceOverride`. */
  minConfidence?: number;
  /** BOT_BYBIT_MIN_CONFIDENCE. A SCORE for Bybit (TrendBreakout), calibrated
   *  differently from Intraday/Pro. Separate so the operator can tune each bot. */
  bybitMinConfidence?: number;
  /** BOT_PATH_MIN_CONFIDENCE. A SCORE for Path (Prev4hRange), separate because
   *  its confidence distribution differs from the others. */
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
/**
 * Risk profile → number of concurrent positions a sim bot may hold. Each
 * position is still POSITION_TARGET_PCT (10%) of equity — the profile changes
 * COUNT, never SIZE (§12 forbids anything downstream reshaping the 10% target).
 *
 * low 3 (30% max invested) · medium 5 (50%) · high 7 (70%) — all within the
 * 80% MAX_TOTAL_EXPOSURE_PERCENT ceiling, so validateExposureModel always
 * passes. Clamped defensively in case the constants ever change.
 */
export function riskLevelToMaxPositions(riskLevel: 'low' | 'medium' | 'high' | undefined): number {
  const byLevel = { low: 3, medium: 5, high: 7 } as const;
  const raw = byLevel[riskLevel ?? 'medium'];
  const cap = Math.floor(MAX_TOTAL_EXPOSURE_PERCENT / (POSITION_TARGET_PCT * 100));
  return Math.min(raw, cap);
}

export function simBotDefaults(id: SimBotId, env: SimEnvOverrides = {}): SimBotConfig {
  const spec = SIM_BOTS[id];

  const minConfidenceOverride = spec.confidenceDerivedFromRiskLevel
    // 0 = "not set": Pro's own proMinConfidence() applies §3's risk-level
    // table. Only an explicit operator override replaces that.
    ? (env.minConfidence ?? 0)
    : id === 'path'
      // Path has its own knob (BOT_PATH_MIN_CONFIDENCE) so the operator can
      // tune it separately from the other bots' shared knob.
      ? (env.pathMinConfidence ?? spec.minConfidence)
      : id === 'bybit'
        // Bybit (TrendBreakout) has its own calibration and knob
        // (BOT_BYBIT_MIN_CONFIDENCE).
        ? (env.bybitMinConfidence ?? spec.minConfidence)
        : (env.minConfidence ?? spec.minConfidence);

  const riskLevel = env.riskLevel ?? SIM_BASE_DEFAULTS.riskLevel;

  return {
    ...SIM_BASE_DEFAULTS,
    riskLevel,
    // Position COUNT is derived from the risk profile, not from BOT_MAX_OPEN_
    // POSITIONS (that stays the LIVE bot's knob). Keep this field in sync so the
    // panel's "positions X/Y" shows the right ceiling; the worker re-derives it
    // whenever riskLevel changes.
    maxPositions: riskLevelToMaxPositions(riskLevel),
    positionPercent: env.positionPercent ?? SIM_BASE_DEFAULTS.positionPercent,
    maxFuturesPositions: spec.maxFuturesPositions,
    minConfidenceOverride
  };
}

/**
 * Validates that the exposure model is internally consistent:
 *   maxPositions × positionTargetPct ≤ totalExposureCapPct
 *
 * If this invariant is violated, the exposure cap is the binding constraint and
 * maxPositions is silently too permissive — exactly the "Strategy says 7,
 * capital model says 2" contradiction this audit eliminates.
 *
 * Throws at startup so the misconfiguration is caught before any trade is placed.
 */
export function validateExposureModel(opts: {
  maxPositions: number;
  positionTargetPct: number;
  totalExposureCapPct: number;
}): void {
  const maxExposure = opts.maxPositions * opts.positionTargetPct;
  if (maxExposure > opts.totalExposureCapPct) {
    throw new Error(
      `EXPOSURE_MODEL_INVALID: maxPositions(${opts.maxPositions}) × ` +
      `positionTargetPct(${opts.positionTargetPct}) = ` +
      `${(maxExposure * 100).toFixed(1)}% > ` +
      `totalExposureCapPct(${opts.totalExposureCapPct})`
    );
  }
}
