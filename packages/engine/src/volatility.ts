/**
 * @cde/engine/volatility — Deterministic Dynamic Volatility Profile.
 * ============================================================================
 * Curated surface for the volatility-profile module: types, the runtime
 * service (reads the compiled JSON, never the raw CSV, never an LLM), and
 * the pure calibration math the Backtest engine's look-ahead guard reuses.
 */

export type {
  VolatilityMarket,
  VolatilitySide,
  VolatilityProfile,
  VolatilityProfilesFile,
  VolatilityRegime,
  CurrentVolatility,
  VolatilityContext,
  DynamicRiskReference,
  VolatilityProfileError,
  VolatilityResult
} from './types/volatilityProfile';
export { volatilityProfileKey, volatilityOk, volatilityErr, isVolatilityErr } from './types/volatilityProfile';

export type { VolatilityInputCandle } from './services/volatilityProfile';
export {
  loadVolatilityProfiles,
  getVolatilityProfile,
  validateVolatilityProfile,
  calculateCurrentVolatility,
  calculateVolatilityFactor,
  classifyVolatilityRegime,
  computeRegimeMultiplier,
  calculateDynamicRiskPct,
  calculateDynamicOpportunityPct,
  calculateExpectedRewardRisk,
  buildVolatilityContext,
  buildDynamicRiskReference,
  formatVolatilityProfileLog,
  formatVolatilityRiskLog,
  VOLATILITY_CONTRACTED_MAX,
  VOLATILITY_EXPANDED_MIN,
  VOLATILITY_EXTREME_MIN,
  REGIME_MULTIPLIER_MIN,
  REGIME_MULTIPLIER_MAX,
  MIN_PROFILE_MONTHS
} from './services/volatilityProfile';

export type { MonthlyExcursionRow } from './services/volatilityCalibration';
export {
  buildVolatilityProfiles,
  buildProfileFromMonthlyValues,
  parseMonthlyResultsCsv,
  parseCsvLine,
  computeProfileQualityScore,
  mean,
  median,
  percentile,
  MIN_PROFILE_MONTHS as CALIBRATION_MIN_PROFILE_MONTHS,
  QUALITY_WEIGHT_MONTHS,
  QUALITY_WEIGHT_CONSISTENCY,
  QUALITY_WEIGHT_RATIO_STABILITY
} from './services/volatilityCalibration';
