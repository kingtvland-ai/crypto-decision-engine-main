/**
 * Volatility Profile runtime service.
 * ============================================================================
 * The trading runtime's ONLY window onto the Deterministic Dynamic
 * Volatility Profile: it reads a compiled VolatilityProfilesFile (loaded
 * from data/volatility-profiles/volatility-profiles.json by the
 * caller — this module does no file I/O, so it stays usable from both the
 * Node worker and the browser bundle) and a single CLOSED 1H candle, and
 * returns deterministic, side-effect-free context.
 *
 * This module never decides whether to take a trade. It hands the existing
 * Risk Engine a volatility-based REFERENCE distance; the Risk Engine is
 * still the one that approves or rejects. See DynamicRiskReference's doc
 * comment.
 *
 * No AI, no LLM, no Gemini, no ML — every function here is arithmetic over
 * the compiled statistics in VolatilityProfile.
 */
import {
  volatilityOk,
  volatilityErr,
  volatilityProfileKey,
  isVolatilityErr
} from '../types/volatilityProfile';
import type {
  VolatilityMarket,
  VolatilityProfile,
  VolatilityProfilesFile,
  VolatilityRegime,
  VolatilitySide,
  VolatilityContext,
  CurrentVolatility,
  DynamicRiskReference,
  VolatilityResult
} from '../types/volatilityProfile';
import { MIN_PROFILE_MONTHS } from './volatilityCalibration';

/** A single CLOSED 1H candle — only open/high/low are needed. Using an
 *  open/high/low shape (rather than importing the full Candle type) keeps
 *  this module decoupled from the market-data layer. */
export interface VolatilityInputCandle {
  open: number;
  high: number;
  low: number;
}

// ── §7 regime thresholds — configurable constants, not magic numbers ───────
export const VOLATILITY_CONTRACTED_MAX = 0.75;
export const VOLATILITY_EXPANDED_MIN = 1.25;
export const VOLATILITY_EXTREME_MIN = 1.75;

// ── §9 regime multiplier clamp ──────────────────────────────────────────────
export const REGIME_MULTIPLIER_MIN = 0.75;
export const REGIME_MULTIPLIER_MAX = 1.75;

export { MIN_PROFILE_MONTHS };

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, decimals = 4): number {
  if (!Number.isFinite(value)) return 0;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

// ── §17.1 loadVolatilityProfiles ────────────────────────────────────────────

/**
 * Parses a compiled volatility-profiles.json payload into a lookup Map.
 * Accepts either the already-parsed object (typical: `JSON.parse` was done
 * by the caller's file loader) or a raw JSON string.
 *
 * Deliberately does not read any file itself — callers (the Node worker,
 * a test, a browser fetch()) own the I/O so this stays a pure function.
 */
export function loadVolatilityProfiles(
  source: VolatilityProfilesFile | string
): Map<string, VolatilityProfile> {
  const file: VolatilityProfilesFile = typeof source === 'string' ? JSON.parse(source) : source;
  const map = new Map<string, VolatilityProfile>();
  if (!file || typeof file !== 'object' || !file.profiles) return map;
  for (const [key, profile] of Object.entries(file.profiles)) {
    map.set(key, profile);
  }
  return map;
}

// ── §17.2 getVolatilityProfile ──────────────────────────────────────────────

/**
 * Looks up a symbol's profile. Never falls back to another symbol's data
 * and never invents a default — a miss is always PROFILE_NOT_FOUND (§22),
 * leaving it to the Risk Engine to decide what a missing profile means for
 * that trade.
 */
export function getVolatilityProfile(
  profiles: Map<string, VolatilityProfile>,
  market: VolatilityMarket,
  symbol: string
): VolatilityResult<VolatilityProfile> {
  const profile = profiles.get(volatilityProfileKey(market, symbol));
  if (!profile) return volatilityErr('PROFILE_NOT_FOUND');
  return volatilityOk(profile);
}

// ── §17.9 validateVolatilityProfile ─────────────────────────────────────────

/**
 * Structural + statistical validity check, independent of lookup. Run this
 * on anything read from disk/network before trusting it — a hand-edited or
 * corrupted JSON entry must never reach the risk math.
 */
export function validateVolatilityProfile(
  profile: VolatilityProfile | null | undefined
): VolatilityResult<VolatilityProfile> {
  if (!profile || typeof profile !== 'object') return volatilityErr('INVALID_PROFILE');

  const numericFields: (keyof VolatilityProfile)[] = [
    'meanUp', 'medianUp', 'p25Up', 'p75Up',
    'meanDown', 'medianDown', 'p25Down', 'p75Down',
    'meanRatio', 'medianRatio', 'consistency', 'baselineRange', 'profileQualityScore'
  ];
  for (const field of numericFields) {
    const v = profile[field];
    if (typeof v !== 'number' || !Number.isFinite(v)) return volatilityErr('INVALID_PROFILE');
  }

  if (!(profile.medianUp > 0) || !(profile.medianDown > 0)) return volatilityErr('INVALID_PROFILE');
  if (!(profile.baselineRange > 0)) return volatilityErr('INVALID_PROFILE');

  if (!Number.isFinite(profile.months) || profile.months < MIN_PROFILE_MONTHS) {
    return volatilityErr('PROFILE_INSUFFICIENT_HISTORY');
  }

  return volatilityOk(profile);
}

// ── §17.3 calculateCurrentVolatility ────────────────────────────────────────

/**
 * §5 — current-candle excursion, computed ONLY from a CLOSED 1H candle.
 * currentUp   = (High - Open) / Open * 100
 * currentDown = (Open - Low)  / Open * 100
 * currentRange = currentUp + currentDown
 *
 * Guards Open <= 0 (or non-finite input) by returning all zeros rather than
 * dividing by zero — a degenerate candle carries no volatility information,
 * it does not carry infinite volatility.
 */
export function calculateCurrentVolatility(candle: VolatilityInputCandle): CurrentVolatility {
  const { open, high, low } = candle;
  if (!Number.isFinite(open) || open <= 0 || !Number.isFinite(high) || !Number.isFinite(low)) {
    return { currentUp: 0, currentDown: 0, currentRange: 0 };
  }
  const currentUp = round(((high - open) / open) * 100);
  const currentDown = round(((open - low) / open) * 100);
  return { currentUp, currentDown, currentRange: round(currentUp + currentDown) };
}

// ── §17.4 calculateVolatilityFactor ─────────────────────────────────────────

/**
 * §6 — volatilityFactor = currentRange / baselineRange.
 * §6 input guard — baselineRange <= 0 never divides; returns INVALID_PROFILE.
 */
export function calculateVolatilityFactor(
  currentRange: number,
  baselineRange: number
): VolatilityResult<number> {
  if (!(baselineRange > 0)) return volatilityErr('INVALID_PROFILE');
  if (!Number.isFinite(currentRange)) return volatilityErr('INVALID_PROFILE');
  return volatilityOk(round(currentRange / baselineRange));
}

// ── §17.5 classifyVolatilityRegime ──────────────────────────────────────────

/**
 * §7 — regime is relative to the symbol's OWN historical profile, never an
 * absolute/shared threshold across symbols.
 *   < 0.75            CONTRACTED
 *   0.75 .. 1.25       NORMAL
 *   > 1.25             EXPANDED
 *   > 1.75             EXTREME  (a stricter subset of EXPANDED)
 */
export function classifyVolatilityRegime(volatilityFactor: number): VolatilityRegime {
  if (volatilityFactor > VOLATILITY_EXTREME_MIN) return 'EXTREME';
  if (volatilityFactor > VOLATILITY_EXPANDED_MIN) return 'EXPANDED';
  if (volatilityFactor >= VOLATILITY_CONTRACTED_MAX) return 'NORMAL';
  return 'CONTRACTED';
}

// ── §9 regime multiplier ────────────────────────────────────────────────────

/** §9 — regimeMultiplier = clamp(volatilityFactor, 0.75, 1.75). */
export function computeRegimeMultiplier(volatilityFactor: number): number {
  return round(clamp(volatilityFactor, REGIME_MULTIPLIER_MIN, REGIME_MULTIPLIER_MAX));
}

// ── §17.6 / §17.7 dynamic risk & opportunity ────────────────────────────────

/**
 * §8 + §10 — the direction-relevant historical adverse move, scaled by the
 * current regime. LONG reads the downside profile, SHORT reads the upside
 * profile (a short's adverse move is a rally, not a drop).
 *
 * This is a REFERENCE distance, not a stop-loss order — see §20 and the
 * DynamicRiskReference doc comment. Guards dynamicRiskPct <= 0.
 */
export function calculateDynamicRiskPct(
  side: VolatilitySide,
  profile: VolatilityProfile,
  volatilityFactor: number
): VolatilityResult<number> {
  const historicalAdverseMove = side === 'LONG' ? profile.medianDown : profile.medianUp;
  const regimeMultiplier = computeRegimeMultiplier(volatilityFactor);
  const dynamicRiskPct = round(historicalAdverseMove * regimeMultiplier);
  if (!(dynamicRiskPct > 0)) return volatilityErr('INVALID_PROFILE');
  return volatilityOk(dynamicRiskPct);
}

/** §11 — the direction-relevant historical favourable move, scaled by the
 *  current regime. A volatility-based reference TARGET, not a TP order. */
export function calculateDynamicOpportunityPct(
  side: VolatilitySide,
  profile: VolatilityProfile,
  volatilityFactor: number
): VolatilityResult<number> {
  const historicalFavourableMove = side === 'LONG' ? profile.medianUp : profile.medianDown;
  const regimeMultiplier = computeRegimeMultiplier(volatilityFactor);
  const dynamicOpportunityPct = round(historicalFavourableMove * regimeMultiplier);
  if (!Number.isFinite(dynamicOpportunityPct)) return volatilityErr('INVALID_PROFILE');
  return volatilityOk(dynamicOpportunityPct);
}

// ── §17.8 calculateExpectedRewardRisk ───────────────────────────────────────

/** §12 — expectedRewardRisk = dynamicOpportunityPct / dynamicRiskPct.
 *  Guards riskPct <= 0 — no entry should be evaluated on an invalid profile. */
export function calculateExpectedRewardRisk(
  opportunityPct: number,
  riskPct: number
): VolatilityResult<number> {
  if (!(riskPct > 0)) return volatilityErr('INVALID_PROFILE');
  return volatilityOk(round(opportunityPct / riskPct));
}

// ── composition helpers ─────────────────────────────────────────────────────

/**
 * Builds the full VolatilityContext (§5-§7) for one symbol from a validated
 * profile and a single closed 1H candle. This is the "regime" stage of the
 * §16 runtime pipeline.
 */
export function buildVolatilityContext(
  market: VolatilityMarket,
  symbol: string,
  candle: VolatilityInputCandle,
  profile: VolatilityProfile
): VolatilityResult<VolatilityContext> {
  const validated = validateVolatilityProfile(profile);
  if (isVolatilityErr(validated)) return volatilityErr(validated.error);

  const { currentUp, currentDown, currentRange } = calculateCurrentVolatility(candle);
  const factorResult = calculateVolatilityFactor(currentRange, profile.baselineRange);
  if (isVolatilityErr(factorResult)) return volatilityErr(factorResult.error);

  const volatilityFactor = factorResult.value;
  const regime = classifyVolatilityRegime(volatilityFactor);

  return volatilityOk({
    market,
    symbol,
    currentUp,
    currentDown,
    currentRange,
    baselineRange: profile.baselineRange,
    volatilityFactor,
    regime
  });
}

/**
 * Builds the full DynamicRiskReference (§8-§12) for one side of a trade.
 * This is the "Dynamic Risk Reference" stage of the §16 runtime pipeline —
 * its output is handed to the Risk Engine, never used to place an order
 * directly.
 */
export function buildDynamicRiskReference(
  side: VolatilitySide,
  profile: VolatilityProfile,
  volatilityFactor: number
): VolatilityResult<DynamicRiskReference> {
  const validated = validateVolatilityProfile(profile);
  if (isVolatilityErr(validated)) return volatilityErr(validated.error);

  const riskResult = calculateDynamicRiskPct(side, profile, volatilityFactor);
  if (isVolatilityErr(riskResult)) return volatilityErr(riskResult.error);

  const opportunityResult = calculateDynamicOpportunityPct(side, profile, volatilityFactor);
  if (isVolatilityErr(opportunityResult)) return volatilityErr(opportunityResult.error);

  const rrResult = calculateExpectedRewardRisk(opportunityResult.value, riskResult.value);
  if (isVolatilityErr(rrResult)) return volatilityErr(rrResult.error);

  return volatilityOk({
    side,
    regimeMultiplier: computeRegimeMultiplier(volatilityFactor),
    dynamicRiskPct: riskResult.value,
    dynamicOpportunityPct: opportunityResult.value,
    expectedRewardRisk: rrResult.value
  });
}

// ── §28 logging (context only — never phrased as a trading recommendation) ──

export function formatVolatilityProfileLog(context: VolatilityContext, profile: VolatilityProfile): string {
  return (
    `[volatility-profile] market=${context.market} symbol=${context.symbol} ` +
    `medianUp=${profile.medianUp} medianDown=${profile.medianDown} ` +
    `baselineRange=${context.baselineRange} currentRange=${context.currentRange} ` +
    `volatilityFactor=${context.volatilityFactor.toFixed(4)} regime=${context.regime}`
  );
}

export function formatVolatilityRiskLog(context: VolatilityContext, ref: DynamicRiskReference): string {
  return (
    `[volatility-risk] market=${context.market} symbol=${context.symbol} side=${ref.side} ` +
    `dynamicRiskPct=${ref.dynamicRiskPct} dynamicOpportunityPct=${ref.dynamicOpportunityPct} ` +
    `expectedRewardRisk=${ref.expectedRewardRisk}`
  );
}
