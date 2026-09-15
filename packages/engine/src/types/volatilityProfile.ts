/**
 * Volatility Profile types — Deterministic Dynamic Volatility Profile.
 * ============================================================================
 * A statistical (NOT machine-learned, NOT LLM-derived) model of a symbol's
 * historical 1H excursion behaviour, compiled offline from
 * data/volatility-profiles/monthly-results.csv into
 * data/volatility-profiles/volatility-profiles.json.
 *
 * Runtime (paper trading / live) reads ONLY the compiled JSON — never the
 * raw CSV and never a live market-data feed to derive a profile. See
 * volatilityCalibration.ts for the offline calibration math and
 * volatilityProfile.ts for the runtime consumer.
 */

/** Bybit only — spot and linear (USDT-margined perpetual) are kept as
 *  strictly separate profiles, never mixed. */
export type VolatilityMarket = 'spot' | 'linear';

export type VolatilitySide = 'LONG' | 'SHORT';

/** One symbol's compiled historical volatility signature. All percentages
 *  are excursion-from-open magnitudes on CLOSED 1H candles, in percent
 *  (e.g. 3.05 means 3.05%). */
export interface VolatilityProfile {
  /** Number of monthly observations the profile was built from. */
  months: number;

  meanUp: number;
  medianUp: number;
  p25Up: number;
  p75Up: number;

  meanDown: number;
  medianDown: number;
  p25Down: number;
  p75Down: number;

  /** meanUp / meanDown */
  meanRatio: number;
  /** medianUp / medianDown */
  medianRatio: number;

  /** (medianUp/meanUp + medianDown/meanDown) / 2 — how close the median sits
   *  to the mean; lower means more outlier skew. */
  consistency: number;

  /** medianUp + medianDown — the central baseline excursion range. */
  baselineRange: number;

  /** Diagnostics only — NEVER used as the calculation baseline (extreme
   *  events would distort it). Kept for inspection/reporting. */
  diagnostics: {
    maxUp: number;
    maxDown: number;
  };

  /** 0..1 composite score from months / consistency / ratio stability.
   *  See QUALITY_WEIGHT_* constants in volatilityCalibration.ts. */
  profileQualityScore: number;
}

/** The compiled runtime artifact — the ONLY file the trading runtime reads. */
export interface VolatilityProfilesFile {
  version: string;
  timeframe: '1H';
  historyMonths: number;
  generatedAt: string;
  profiles: Record<string, VolatilityProfile>;
}

export type VolatilityRegime = 'CONTRACTED' | 'NORMAL' | 'EXPANDED' | 'EXTREME';

/** Current-candle excursion measurement (from a single CLOSED 1H candle). */
export interface CurrentVolatility {
  currentUp: number;
  currentDown: number;
  currentRange: number;
}

/** Full volatility context for one symbol at one point in time — the thing
 *  handed to the (existing, unmodified) Risk Engine as CONTEXT, not as a
 *  trading instruction. */
export interface VolatilityContext {
  market: VolatilityMarket;
  symbol: string;
  currentUp: number;
  currentDown: number;
  currentRange: number;
  baselineRange: number;
  volatilityFactor: number;
  regime: VolatilityRegime;
}

/** Volatility-based reference distances for one side of a trade. NOT a
 *  stop-loss or take-profit order — see §20 of the spec this implements:
 *  the Risk Engine still decides whether/how to act on this. */
export interface DynamicRiskReference {
  side: VolatilitySide;
  regimeMultiplier: number;
  dynamicRiskPct: number;
  dynamicOpportunityPct: number;
  expectedRewardRisk: number;
}

/** Every failure mode is a named, deterministic error — never a fabricated
 *  fallback value. */
export type VolatilityProfileError =
  | 'PROFILE_NOT_FOUND'
  | 'INVALID_PROFILE'
  | 'PROFILE_INSUFFICIENT_HISTORY';

export type VolatilityResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: VolatilityProfileError };

export function volatilityOk<T>(value: T): VolatilityResult<T> {
  return { ok: true, value };
}

export function volatilityErr<T>(error: VolatilityProfileError): VolatilityResult<T> {
  return { ok: false, error };
}

/** Explicit type guard — with this repo's `strictNullChecks: false`,
 *  control-flow narrowing on `!result.ok` alone does not reliably discriminate
 *  a generic union coming back from a function call, so every consumer below
 *  narrows through this guard instead of a bare `if (!result.ok)`. */
export function isVolatilityErr<T>(
  result: VolatilityResult<T>
): result is { ok: false; error: VolatilityProfileError } {
  return result.ok === false;
}

/** `${market}:${symbol}` — the only allowed profile key shape. Never mix
 *  spot and linear under the same key. */
export function volatilityProfileKey(market: VolatilityMarket, symbol: string): string {
  return `${market}:${symbol}`;
}
