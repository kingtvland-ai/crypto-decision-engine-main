/**
 * Volatility Profile calibration — pure, deterministic statistics.
 * ============================================================================
 * Turns rows of data/volatility-profiles/monthly-results.csv into
 * VolatilityProfile objects. No I/O here (no fs, no network) — this module
 * is used both by the Node calibration script (scripts/generateVolatility
 * Profiles.ts, which writes volatility-profiles.json) and, with a cutoff
 * month, by the Backtest engine's look-ahead guard, so it has to stay
 * platform-agnostic and side-effect free.
 *
 * NOT machine learning. Every number below is mean/median/percentile
 * arithmetic over historical (High-Open)/Open and (Open-Low)/Open excursions
 * on closed 1H candles.
 */
import type { VolatilityMarket, VolatilityProfile } from '../types/volatilityProfile';

/** One row of monthly-results.csv, already parsed to numbers. */
export interface MonthlyExcursionRow {
  category: VolatilityMarket;
  symbol: string;
  /** "YYYY-MM" — lexicographically sortable, which is all the ordering this
   *  module ever needs. */
  month: string;
  /** (High - Open) / Open * 100 over the month, POSITIVE. */
  maxUpsidePct: number;
  /** (Low - Open) / Open * 100 over the month, NEGATIVE (or zero). */
  maxDownsidePct: number;
}

/** Minimum monthly observations required before a profile is trusted.
 *  Below this: PROFILE_INSUFFICIENT_HISTORY, never a profile built on less. */
export const MIN_PROFILE_MONTHS = 24;

// ── profileQualityScore weights (§13) — named constants, not magic numbers ──
export const QUALITY_WEIGHT_MONTHS = 0.4;
export const QUALITY_WEIGHT_CONSISTENCY = 0.4;
export const QUALITY_WEIGHT_RATIO_STABILITY = 0.2;
/** Months at/above this count contribute the full months-weight share. */
export const QUALITY_MONTHS_SATURATION = MIN_PROFILE_MONTHS;

// ── basic statistics ────────────────────────────────────────────────────────

export function mean(values: readonly number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Linear-interpolation percentile (same method the existing diagnostic
 *  script in ASSETS/bybit-analysis-results uses, kept for reference — its
 *  own output is not the runtime source of truth), `p` in [0,1]. */
export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function round(value: number, decimals = 4): number {
  if (!Number.isFinite(value)) return 0;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/**
 * §13 profileQualityScore — based only on (1) month count, (2) consistency,
 * (3) stability of the median Up/Down ratio vs the mean Up/Down ratio.
 * Never an arbitrary/hand-picked score: every term is derived from the same
 * distribution the profile itself is built from.
 */
export function computeProfileQualityScore(
  months: number,
  consistency: number,
  medianRatio: number,
  meanRatio: number
): number {
  const monthsTerm = clamp01(months / QUALITY_MONTHS_SATURATION);
  const consistencyTerm = clamp01(consistency);
  const ratioStabilityTerm = medianRatio > 0
    ? clamp01(1 - Math.abs(medianRatio - meanRatio) / medianRatio)
    : 0;

  return round(
    QUALITY_WEIGHT_MONTHS * monthsTerm +
    QUALITY_WEIGHT_CONSISTENCY * consistencyTerm +
    QUALITY_WEIGHT_RATIO_STABILITY * ratioStabilityTerm,
    4
  );
}

/**
 * Builds one VolatilityProfile from a symbol's monthly UP/DOWN excursion
 * values (DOWN already made positive by the caller). Returns null when there
 * is not enough history (§13: months >= MIN_PROFILE_MONTHS) — the caller
 * decides what PROFILE_INSUFFICIENT_HISTORY means for it (skip in
 * calibration output, or surface as an error at runtime).
 */
export function buildProfileFromMonthlyValues(
  upValues: readonly number[],
  downValues: readonly number[]
): VolatilityProfile | null {
  const months = Math.min(upValues.length, downValues.length);
  if (months < MIN_PROFILE_MONTHS) return null;

  const meanUp = mean(upValues);
  const medianUp = median(upValues);
  const p25Up = percentile(upValues, 0.25);
  const p75Up = percentile(upValues, 0.75);

  const meanDown = mean(downValues);
  const medianDown = median(downValues);
  const p25Down = percentile(downValues, 0.25);
  const p75Down = percentile(downValues, 0.75);

  const meanRatio = meanDown > 0 ? meanUp / meanDown : 0;
  const medianRatio = medianDown > 0 ? medianUp / medianDown : 0;

  const upConsistency = meanUp > 0 ? medianUp / meanUp : 0;
  const downConsistency = meanDown > 0 ? medianDown / meanDown : 0;
  const consistency = (upConsistency + downConsistency) / 2;

  const baselineRange = medianUp + medianDown;

  const profileQualityScore = computeProfileQualityScore(months, consistency, medianRatio, meanRatio);

  return {
    months,
    meanUp: round(meanUp),
    medianUp: round(medianUp),
    p25Up: round(p25Up),
    p75Up: round(p75Up),
    meanDown: round(meanDown),
    medianDown: round(medianDown),
    p25Down: round(p25Down),
    p75Down: round(p75Down),
    meanRatio: round(meanRatio),
    medianRatio: round(medianRatio),
    consistency: round(consistency),
    baselineRange: round(baselineRange),
    diagnostics: {
      maxUp: round(Math.max(...upValues)),
      maxDown: round(Math.max(...downValues))
    },
    profileQualityScore
  };
}

/** market:symbol grouping key — mirrors volatilityProfileKey but local to
 *  avoid a runtime<->calibration import cycle. */
function groupKey(category: VolatilityMarket, symbol: string): string {
  return `${category}:${symbol}`;
}

/**
 * Groups monthly rows by market+symbol and builds a profile per group,
 * dropping (never fabricating) groups with fewer than MIN_PROFILE_MONTHS
 * observations.
 *
 * @param asOfMonth  Exclusive upper bound ("YYYY-MM"), inclusive of nothing
 *   at or after it. Pass this from the Backtest engine to build a
 *   point-in-time profile using only months that had actually closed before
 *   the backtest timestamp being evaluated — the look-ahead guard (§27).
 *   Omit it (or leave undefined) for the full-history calibration run that
 *   produces volatility-profiles.json.
 */
export function buildVolatilityProfiles(
  rows: readonly MonthlyExcursionRow[],
  asOfMonth?: string
): Map<string, VolatilityProfile> {
  const groups = new Map<string, { up: number[]; down: number[]; months: Set<string> }>();

  for (const row of rows) {
    if (asOfMonth !== undefined && row.month >= asOfMonth) continue;

    const key = groupKey(row.category, row.symbol);
    let group = groups.get(key);
    if (!group) {
      group = { up: [], down: [], months: new Set() };
      groups.set(key, group);
    }
    // A CSV should never repeat a month for the same symbol, but guard
    // against silently double-counting one if it does.
    if (group.months.has(row.month)) continue;
    group.months.add(row.month);
    group.up.push(row.maxUpsidePct);
    group.down.push(Math.abs(row.maxDownsidePct));
  }

  const profiles = new Map<string, VolatilityProfile>();
  for (const [key, group] of groups) {
    const profile = buildProfileFromMonthlyValues(group.up, group.down);
    if (profile) profiles.set(key, profile);
  }
  return profiles;
}

// ── minimal CSV parsing (shared by the calibration script) ─────────────────

/** Same quoted-field CSV line parser the existing diagnostic script uses. */
export function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { current += '"'; i++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

/** Parses monthly-results.csv text into MonthlyExcursionRow[], skipping any
 *  row that fails to parse rather than fabricating a value for it. */
export function parseMonthlyResultsCsv(text: string): MonthlyExcursionRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]);
  const idx = (name: string) => headers.indexOf(name);
  const iCategory = idx('category');
  const iSymbol = idx('symbol');
  const iMonth = idx('month');
  const iUp = idx('max_upside_pct');
  const iDown = idx('max_downside_pct');
  if ([iCategory, iSymbol, iMonth, iUp, iDown].some((i) => i < 0)) return [];

  const rows: MonthlyExcursionRow[] = [];
  for (const line of lines.slice(1)) {
    const values = parseCsvLine(line);
    const category = values[iCategory]?.trim();
    const symbol = values[iSymbol]?.trim();
    const month = values[iMonth]?.trim();
    const maxUpsidePct = Number(values[iUp]);
    const maxDownsidePct = Number(values[iDown]);
    if (
      (category !== 'spot' && category !== 'linear') ||
      !symbol || !month ||
      !Number.isFinite(maxUpsidePct) || !Number.isFinite(maxDownsidePct)
    ) continue;
    rows.push({ category, symbol, month, maxUpsidePct, maxDownsidePct });
  }
  return rows;
}
