/**
 * Deterministic Dynamic Volatility Profile — unit tests.
 * ============================================================================
 * Covers the calibration math (monthly-results.csv -> VolatilityProfile) and
 * the runtime service (compiled JSON -> regime / dynamic risk & opportunity
 * references), including every case enumerated in the implementation spec:
 * BTC Spot/Linear from the real compiled file, missing profile, insufficient
 * history, division-by-zero guards, all four regimes, LONG/SHORT risk and
 * opportunity, and malformed/invalid input.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  loadVolatilityProfiles,
  getVolatilityProfile,
  validateVolatilityProfile,
  calculateCurrentVolatility,
  calculateVolatilityFactor,
  classifyVolatilityRegime,
  computeRegimeMultiplier,
  REGIME_MULTIPLIER_MIN,
  calculateDynamicRiskPct,
  calculateDynamicOpportunityPct,
  calculateExpectedRewardRisk,
  buildVolatilityContext,
  buildDynamicRiskReference,
  resolveVolatilityLadder,
  isVolatilityErr,
  buildVolatilityProfiles,
  buildProfileFromMonthlyValues,
  parseMonthlyResultsCsv,
  MIN_PROFILE_MONTHS,
  type VolatilityProfile,
  type VolatilityProfilesFile,
  type MonthlyExcursionRow
} from '@cde/engine/volatility';

// ── fixtures ─────────────────────────────────────────────────────────────

/** A well-formed, valid 24-month profile modeled on BTC Spot's real numbers. */
function makeProfile(overrides: Partial<VolatilityProfile> = {}): VolatilityProfile {
  return {
    months: 24,
    meanUp: 3.4548,
    medianUp: 3.0574,
    p25Up: 2.4351,
    p75Up: 4.0314,
    meanDown: 3.9469,
    medianDown: 3.4039,
    p25Down: 2.5179,
    p75Down: 4.8087,
    meanRatio: 0.8753,
    medianRatio: 0.8982,
    consistency: 0.8737,
    baselineRange: 6.4613,
    diagnostics: { maxUp: 7.3658, maxDown: 10.4602 },
    profileQualityScore: 0.9444,
    ...overrides
  };
}

function loadRealProfiles(): VolatilityProfilesFile {
  const file = path.resolve(
    __dirname, '../../data/volatility-profiles/volatility-profiles.json'
  );
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ── §26.1 / §26.2 — BTC Spot / BTC Linear profile loads from the real file ──

describe('real compiled volatility-profiles.json', () => {
  const raw = loadRealProfiles();
  const profiles = loadVolatilityProfiles(raw);

  it('loads a valid BTC Spot profile', () => {
    const result = getVolatilityProfile(profiles, 'spot', 'BTCUSDT');
    expect(isVolatilityErr(result)).toBe(false);
    if (!isVolatilityErr(result)) {
      expect(result.value.months).toBeGreaterThanOrEqual(MIN_PROFILE_MONTHS);
      expect(result.value.medianUp).toBeCloseTo(3.0574, 3);
      expect(result.value.medianDown).toBeCloseTo(3.4039, 3);
      expect(result.value.baselineRange).toBeCloseTo(6.4613, 3);
    }
  });

  it('loads a valid BTC Linear profile, distinct from BTC Spot', () => {
    const spotResult = getVolatilityProfile(profiles, 'spot', 'BTCUSDT');
    const linearResult = getVolatilityProfile(profiles, 'linear', 'BTCUSDT');
    expect(isVolatilityErr(linearResult)).toBe(false);
    if (!isVolatilityErr(linearResult) && !isVolatilityErr(spotResult)) {
      // spot and linear are never the same profile, even for the same symbol
      expect(linearResult.value).not.toEqual(spotResult.value);
    }
  });

  it('never mixes spot and linear under the same key', () => {
    expect(profiles.has('spot:BTCUSDT')).toBe(true);
    expect(profiles.has('linear:BTCUSDT')).toBe(true);
    expect(profiles.get('spot:BTCUSDT')).not.toBe(profiles.get('linear:BTCUSDT'));
  });
});

// ── §26.3 — missing profile ──────────────────────────────────────────────

describe('getVolatilityProfile', () => {
  it('returns PROFILE_NOT_FOUND for a symbol with no compiled profile', () => {
    const profiles = new Map<string, VolatilityProfile>([['spot:BTCUSDT', makeProfile()]]);
    const result = getVolatilityProfile(profiles, 'spot', 'NOSUCHUSDT');
    expect(isVolatilityErr(result)).toBe(true);
    if (isVolatilityErr(result)) expect(result.error).toBe('PROFILE_NOT_FOUND');
  });

  it('does not fall back to a different symbol or market', () => {
    const profiles = new Map<string, VolatilityProfile>([['spot:BTCUSDT', makeProfile()]]);
    const result = getVolatilityProfile(profiles, 'linear', 'BTCUSDT');
    expect(isVolatilityErr(result)).toBe(true);
    if (isVolatilityErr(result)) expect(result.error).toBe('PROFILE_NOT_FOUND');
  });
});

// ── §26.4 — fewer than 24 months rejected ───────────────────────────────

describe('validateVolatilityProfile', () => {
  it('rejects a profile with fewer than 24 months', () => {
    const result = validateVolatilityProfile(makeProfile({ months: 12 }));
    expect(isVolatilityErr(result)).toBe(true);
    if (isVolatilityErr(result)) expect(result.error).toBe('PROFILE_INSUFFICIENT_HISTORY');
  });

  it('accepts a valid 24-month profile', () => {
    const result = validateVolatilityProfile(makeProfile());
    expect(isVolatilityErr(result)).toBe(false);
  });

  // ── §26.16 — malformed profile ──────────────────────────────────────────
  it('rejects a malformed profile (missing/non-numeric fields)', () => {
    const malformed = { ...makeProfile(), medianUp: 'not-a-number' } as unknown as VolatilityProfile;
    const result = validateVolatilityProfile(malformed);
    expect(isVolatilityErr(result)).toBe(true);
    if (isVolatilityErr(result)) expect(result.error).toBe('INVALID_PROFILE');
  });

  it('rejects null/undefined outright', () => {
    expect(isVolatilityErr(validateVolatilityProfile(null))).toBe(true);
    expect(isVolatilityErr(validateVolatilityProfile(undefined))).toBe(true);
  });
});

// ── §26.5 — baselineRange = 0 ────────────────────────────────────────────

describe('calculateVolatilityFactor', () => {
  it('returns INVALID_PROFILE when baselineRange <= 0 (no division by zero)', () => {
    const result = calculateVolatilityFactor(6.5, 0);
    expect(isVolatilityErr(result)).toBe(true);
    if (isVolatilityErr(result)) expect(result.error).toBe('INVALID_PROFILE');
  });

  it('returns INVALID_PROFILE for a negative baselineRange', () => {
    const result = calculateVolatilityFactor(6.5, -1);
    expect(isVolatilityErr(result)).toBe(true);
  });

  // ── §26.6 — currentRange = 0 ────────────────────────────────────────────
  it('computes factor 0 for a flat (currentRange = 0) candle against a valid baseline', () => {
    const result = calculateVolatilityFactor(0, 6.4613);
    expect(isVolatilityErr(result)).toBe(false);
    if (!isVolatilityErr(result)) expect(result.value).toBe(0);
  });

  it('matches the worked BTC Spot example (§19): ~1.006', () => {
    const result = calculateVolatilityFactor(6.5, 6.4613);
    expect(isVolatilityErr(result)).toBe(false);
    if (!isVolatilityErr(result)) expect(result.value).toBeCloseTo(1.006, 3);
  });
});

// ── §26.7-10 — regime classification ────────────────────────────────────

describe('classifyVolatilityRegime', () => {
  it('classifies < 0.75 as CONTRACTED', () => {
    expect(classifyVolatilityRegime(0.5)).toBe('CONTRACTED');
  });

  it('classifies 0.75..1.25 as NORMAL', () => {
    expect(classifyVolatilityRegime(0.75)).toBe('NORMAL');
    expect(classifyVolatilityRegime(1.0)).toBe('NORMAL');
    expect(classifyVolatilityRegime(1.25)).toBe('NORMAL');
  });

  it('classifies > 1.25 as EXPANDED', () => {
    expect(classifyVolatilityRegime(1.5)).toBe('EXPANDED');
  });

  it('classifies > 1.75 as EXTREME', () => {
    expect(classifyVolatilityRegime(2.0)).toBe('EXTREME');
  });
});

// ── §26.11-12 — LONG/SHORT dynamic risk ─────────────────────────────────

describe('calculateDynamicRiskPct', () => {
  const profile = makeProfile();

  it('LONG risk reads the DOWN profile, scaled by the regime multiplier', () => {
    const result = calculateDynamicRiskPct('LONG', profile, 1.006);
    expect(isVolatilityErr(result)).toBe(false);
    if (!isVolatilityErr(result)) {
      // medianDown(3.4039) * clamp(1.006, .75, 1.75) ≈ 3.42
      expect(result.value).toBeCloseTo(3.4245, 2);
    }
  });

  it('SHORT risk reads the UP profile, scaled by the regime multiplier', () => {
    const result = calculateDynamicRiskPct('SHORT', profile, 1.006);
    expect(isVolatilityErr(result)).toBe(false);
    if (!isVolatilityErr(result)) {
      expect(result.value).toBeCloseTo(profile.medianUp * computeRegimeMultiplier(1.006), 3);
    }
  });

  // ── §26.15 — division by zero / non-positive guard ──────────────────────
  it('returns INVALID_PROFILE when the resulting risk distance is not positive', () => {
    const zeroProfile = makeProfile({ medianDown: 0 });
    const result = calculateDynamicRiskPct('LONG', zeroProfile, 1.0);
    expect(isVolatilityErr(result)).toBe(true);
    if (isVolatilityErr(result)) expect(result.error).toBe('INVALID_PROFILE');
  });
});

// ── §26.13-14 — LONG/SHORT dynamic opportunity ──────────────────────────

describe('calculateDynamicOpportunityPct', () => {
  const profile = makeProfile();

  it('LONG opportunity reads the UP profile', () => {
    const result = calculateDynamicOpportunityPct('LONG', profile, 1.006);
    expect(isVolatilityErr(result)).toBe(false);
    if (!isVolatilityErr(result)) {
      expect(result.value).toBeCloseTo(profile.medianUp * computeRegimeMultiplier(1.006), 3);
    }
  });

  it('SHORT opportunity reads the DOWN profile', () => {
    const result = calculateDynamicOpportunityPct('SHORT', profile, 1.006);
    expect(isVolatilityErr(result)).toBe(false);
    if (!isVolatilityErr(result)) {
      expect(result.value).toBeCloseTo(profile.medianDown * computeRegimeMultiplier(1.006), 3);
    }
  });
});

describe('calculateExpectedRewardRisk', () => {
  it('divides opportunity by risk', () => {
    const result = calculateExpectedRewardRisk(3.07, 3.42);
    expect(isVolatilityErr(result)).toBe(false);
    if (!isVolatilityErr(result)) expect(result.value).toBeCloseTo(0.8977, 3);
  });

  it('returns INVALID_PROFILE when riskPct <= 0 (division by zero guard)', () => {
    const result = calculateExpectedRewardRisk(3.07, 0);
    expect(isVolatilityErr(result)).toBe(true);
    if (isVolatilityErr(result)) expect(result.error).toBe('INVALID_PROFILE');
  });
});

// ── §26.17 / §26.18 — invalid market / invalid symbol ───────────────────

describe('invalid market / invalid symbol', () => {
  const profiles = new Map<string, VolatilityProfile>([['spot:BTCUSDT', makeProfile()]]);

  it('an unrecognized market key produces PROFILE_NOT_FOUND, never a fabricated profile', () => {
    // @ts-expect-error — deliberately an invalid market to prove no silent coercion
    const result = getVolatilityProfile(profiles, 'margin', 'BTCUSDT');
    expect(isVolatilityErr(result)).toBe(true);
    if (isVolatilityErr(result)) expect(result.error).toBe('PROFILE_NOT_FOUND');
  });

  it('an empty/invalid symbol produces PROFILE_NOT_FOUND', () => {
    const result = getVolatilityProfile(profiles, 'spot', '');
    expect(isVolatilityErr(result)).toBe(true);
    if (isVolatilityErr(result)) expect(result.error).toBe('PROFILE_NOT_FOUND');
  });
});

// ── calculateCurrentVolatility ───────────────────────────────────────────

describe('calculateCurrentVolatility', () => {
  it('matches the worked BTC Spot example (§19)', () => {
    // open=100, high=103.5 -> up 3.5; low=97 -> down 3.0
    const result = calculateCurrentVolatility({ open: 100, high: 103.5, low: 97 });
    expect(result.currentUp).toBeCloseTo(3.5, 4);
    expect(result.currentDown).toBeCloseTo(3.0, 4);
    expect(result.currentRange).toBeCloseTo(6.5, 4);
  });

  it('guards against open <= 0 without dividing by zero', () => {
    const result = calculateCurrentVolatility({ open: 0, high: 10, low: -10 });
    expect(result).toEqual({ currentUp: 0, currentDown: 0, currentRange: 0 });
  });
});

// ── resolveVolatilityLadder — the single "try it, else null" entry point ───
// Every bot's SL/TP wiring calls only this. It must return the correct
// ladder when everything lines up, and null (never throw, never fabricate)
// on every failure mode a bot could hand it.

describe('resolveVolatilityLadder', () => {
  const profile = makeProfile();
  const profiles = new Map<string, VolatilityProfile>([['spot:BTCUSDT', profile]]);
  const candle = { open: 100, high: 103.5, low: 97 }; // volatilityFactor ~1.006, NORMAL

  it('returns the dynamic risk/opportunity ladder for a valid LONG', () => {
    const ladder = resolveVolatilityLadder({
      profiles, market: 'spot', symbol: 'BTCUSDT', side: 'LONG', lastClosedH1: candle
    });
    expect(ladder).not.toBeNull();
    expect(ladder!.regime).toBe('NORMAL');
    expect(ladder!.stopPct).toBeCloseTo(profile.medianDown * computeRegimeMultiplier(1.006), 3);
    expect(ladder!.targetPct).toBeCloseTo(profile.medianUp * computeRegimeMultiplier(1.006), 3);
  });

  it('SHORT reads the opposite side of the profile', () => {
    const ladder = resolveVolatilityLadder({
      profiles, market: 'spot', symbol: 'BTCUSDT', side: 'SHORT', lastClosedH1: candle
    });
    expect(ladder).not.toBeNull();
    expect(ladder!.stopPct).toBeCloseTo(profile.medianUp * computeRegimeMultiplier(1.006), 3);
    expect(ladder!.targetPct).toBeCloseTo(profile.medianDown * computeRegimeMultiplier(1.006), 3);
  });

  it('classifies all four regimes correctly through the full pipeline', () => {
    // baselineRange = 6.4613. Build candles whose currentRange lands in each band.
    const asCandle = (range: number) => ({ open: 100, high: 100 + range / 2, low: 100 - range / 2 });
    const regimeFor = (range: number) => resolveVolatilityLadder({
      profiles, market: 'spot', symbol: 'BTCUSDT', side: 'LONG', lastClosedH1: asCandle(range)
    })?.regime;

    expect(regimeFor(3)).toBe('CONTRACTED');   // factor ~0.46
    expect(regimeFor(6.5)).toBe('NORMAL');     // factor ~1.006
    expect(regimeFor(9)).toBe('EXPANDED');     // factor ~1.39
    expect(regimeFor(12)).toBe('EXTREME');     // factor ~1.86
  });

  it('returns null (never throws) when no profile exists for the symbol', () => {
    const ladder = resolveVolatilityLadder({
      profiles, market: 'spot', symbol: 'NOSUCHUSDT', side: 'LONG', lastClosedH1: candle
    });
    expect(ladder).toBeNull();
  });

  it('returns null for the wrong market (spot profile, linear requested)', () => {
    const ladder = resolveVolatilityLadder({
      profiles, market: 'linear', symbol: 'BTCUSDT', side: 'LONG', lastClosedH1: candle
    });
    expect(ladder).toBeNull();
  });

  it('returns null when the profile has insufficient history', () => {
    const shortProfiles = new Map<string, VolatilityProfile>([['spot:BTCUSDT', makeProfile({ months: 10 })]]);
    const ladder = resolveVolatilityLadder({
      profiles: shortProfiles, market: 'spot', symbol: 'BTCUSDT', side: 'LONG', lastClosedH1: candle
    });
    expect(ladder).toBeNull();
  });

  it('returns null when the profile is malformed', () => {
    const badProfiles = new Map<string, VolatilityProfile>([
      ['spot:BTCUSDT', { ...profile, medianDown: 0 }]
    ]);
    const ladder = resolveVolatilityLadder({
      profiles: badProfiles, market: 'spot', symbol: 'BTCUSDT', side: 'LONG', lastClosedH1: candle
    });
    expect(ladder).toBeNull();
  });

  it('returns null when there is no closed H1 candle to measure from', () => {
    const ladder = resolveVolatilityLadder({
      profiles, market: 'spot', symbol: 'BTCUSDT', side: 'LONG', lastClosedH1: undefined
    });
    expect(ladder).toBeNull();
  });

  it('treats a degenerate candle (open <= 0) as flat (currentRange=0) rather than dividing by zero', () => {
    // calculateCurrentVolatility guards open<=0 to {0,0,0}; a currentRange of 0
    // against a positive baselineRange is a valid (CONTRACTED) factor of 0, not
    // an error — so this still resolves a ladder, clamped to the regime floor.
    const ladder = resolveVolatilityLadder({
      profiles, market: 'spot', symbol: 'BTCUSDT', side: 'LONG', lastClosedH1: { open: 0, high: 10, low: -10 }
    });
    expect(ladder).not.toBeNull();
    expect(ladder!.regime).toBe('CONTRACTED');
    expect(ladder!.stopPct).toBeCloseTo(profile.medianDown * REGIME_MULTIPLIER_MIN, 3);
  });
});

// ── end-to-end composition (buildVolatilityContext / buildDynamicRiskReference) ──

describe('buildVolatilityContext + buildDynamicRiskReference (end to end)', () => {
  it('reproduces the §19 worked BTC Spot example exactly', () => {
    const profile = makeProfile();
    const contextResult = buildVolatilityContext('spot', 'BTCUSDT', { open: 100, high: 103.5, low: 97 }, profile);
    expect(isVolatilityErr(contextResult)).toBe(false);
    if (isVolatilityErr(contextResult)) return;

    expect(contextResult.value.volatilityFactor).toBeCloseTo(1.006, 3);
    expect(contextResult.value.regime).toBe('NORMAL');

    const riskRefResult = buildDynamicRiskReference('LONG', profile, contextResult.value.volatilityFactor);
    expect(isVolatilityErr(riskRefResult)).toBe(false);
    if (isVolatilityErr(riskRefResult)) return;
    expect(riskRefResult.value.dynamicRiskPct).toBeCloseTo(3.42, 1);
  });

  it('propagates PROFILE_INSUFFICIENT_HISTORY through the composed pipeline', () => {
    const shortProfile = makeProfile({ months: 6 });
    const contextResult = buildVolatilityContext('spot', 'BTCUSDT', { open: 100, high: 103.5, low: 97 }, shortProfile);
    expect(isVolatilityErr(contextResult)).toBe(true);
    if (isVolatilityErr(contextResult)) expect(contextResult.error).toBe('PROFILE_INSUFFICIENT_HISTORY');
  });
});

// ── calibration determinism (used by both the JSON build and the backtest guard) ──

describe('buildVolatilityProfiles (calibration)', () => {
  function rowsFor(symbol: 'BTCUSDT', months: number, up: number, down: number): MonthlyExcursionRow[] {
    return Array.from({ length: months }, (_, i) => ({
      category: 'spot' as const,
      symbol,
      month: `2024-${String((i % 12) + 1).padStart(2, '0')}`,
      maxUpsidePct: up,
      maxDownsidePct: -down
    }));
  }

  it('drops a group with fewer than 24 months rather than fabricating a profile', () => {
    const rows = rowsFor('BTCUSDT', 12, 3, 3);
    const profiles = buildVolatilityProfiles(rows);
    expect(profiles.has('spot:BTCUSDT')).toBe(false);
  });

  it('is deterministic: the same rows always produce the same profile', () => {
    const rows = rowsFor('BTCUSDT', 24, 3.1, 2.9);
    const a = buildVolatilityProfiles(rows);
    const b = buildVolatilityProfiles(rows);
    expect(a.get('spot:BTCUSDT')).toEqual(b.get('spot:BTCUSDT'));
  });

  it('the look-ahead guard (asOfMonth) only sees months strictly before it', () => {
    const rows = rowsFor('BTCUSDT', 24, 3, 3).map((r, i) => ({ ...r, month: `2024-01`.slice(0, 4) + '-' + String(i + 1).padStart(2, '0') }));
    // Only 10 months exist before month "11" in this synthetic set — below MIN_PROFILE_MONTHS.
    const asOf = buildVolatilityProfiles(rows, '2024-11');
    expect(asOf.has('spot:BTCUSDT')).toBe(false);
  });
});

describe('parseMonthlyResultsCsv', () => {
  it('parses category/symbol/month/up/down and skips malformed rows', () => {
    const csv = [
      'category,symbol,month,max_upside_pct,max_upside_time,max_downside_pct,max_downside_time,candle_count',
      'spot,BTCUSDT,2024-09,2.4388,2024-09-17T14:00:00.000Z,-2.7493,2024-09-04T01:00:00.000Z,720',
      'bogus,XXXUSDT,not-a-month,abc,,def,,0'
    ].join('\n');
    const rows = parseMonthlyResultsCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe('BTCUSDT');
    expect(rows[0].maxUpsidePct).toBeCloseTo(2.4388);
  });
});

describe('buildProfileFromMonthlyValues', () => {
  it('returns null below MIN_PROFILE_MONTHS', () => {
    const result = buildProfileFromMonthlyValues([1, 2, 3], [1, 2, 3]);
    expect(result).toBeNull();
  });

  it('uses medians, not means, as the baseline (outlier resistance)', () => {
    const up = Array(23).fill(3).concat([50]); // one huge outlier
    const down = Array(24).fill(3);
    const profile = buildProfileFromMonthlyValues(up, down)!;
    expect(profile.medianUp).toBeCloseTo(3, 1);
    expect(profile.meanUp).toBeGreaterThan(4); // mean is dragged up, median isn't
    expect(profile.baselineRange).toBeCloseTo(profile.medianUp + profile.medianDown, 4);
  });
});
