/**
 * @cde/engine/execution — shared technical-analysis primitives, order
 * generation, fills, and per-engine sizing.
 * ============================================================================
 */

// ── Shared candle-math + fee/slippage primitives ────────────────────────────
export type { Candle, PortfolioRiskStats, ClosedTradeMetric } from './services/tradeEngine';
export {
  formatDynamicPrice,
  calculateEMA,
  calculateATR,
  calculateADX,
  calculateSupertrend,
  detectMarketRegime,
  computeRelativeVolume,
  MIN_ENTRY_RELATIVE_VOLUME,
  BYBIT_FEES,
  calculateTradingFee,
  FEE_REFERENCE_PERCENT,
  simulateSlippage,
  breakoutLimitPrice,
  DEFAULT_SLIPPAGE_PERCENT,
  calculateBreakEvenPrice
} from './services/tradeEngine';

// ── Shared exit policy: 4.2% loss cap, TP1 3% (50% out), TP2 4.5% ───────────
export {
  MAX_LOSS_PERCENT,
  TP1_PERCENT,
  TP2_PERCENT,
  TP1_EXIT_FRACTION,
  positionPnlPercent,
  maxLossStopLevel,
  capStopLoss,
  stopWasCapped,
  takeProfitLevels,
  cappedTakeProfitLevels,
  reachedTarget,
  reachedStop,
  isLongSide,
  weightedAverageExit
} from './services/exitPolicy';
export type { ExitLevel } from './services/exitPolicy';

// ── Simulation defaults, shared by the worker and the browser ─────────────
export {
  SIM_BOTS,
  SIM_BOT_IDS,
  SIM_BOT_SPECS,
  UI_FACING_SIM_PREFIXES,
  SIM_BASE_DEFAULTS,
  SIM_MIN_CONFIDENCE,
  SIM_MAX_FUTURES_POSITIONS,
  simBotDefaults,
  riskLevelToMaxPositions
} from './services/simDefaults';
export type { SimBotId, SimBotSpec, ConfidenceScale, SimEnvOverrides } from './services/simDefaults';

// ── Order generation per engine ──────────────────────────────────────────────
export type { ProOrderGenContext, ProGateContext } from './services/proSimExecution';
export {
  MIN_PRO_CANDLES,
  buildProEvaluation,
  applyProEntryGates,
  generateProOrders
} from './services/proSimExecution';
export { calculateOptimalEntryPrice } from './services/proAlgEngine';

// ── Simulation bot: positions, fills, config (shared by all three engines) ──
export type {
  SimPosition,
  SimTrade,
  SimPoint,
  PendingOrder,
  SimBotConfig,
  OrderGenContext,
  FillableOrdersResult,
  FillEvent,
  FillResult,
  ReentryCooldownState
} from './services/simExecution';
export {
  SIM_INTRADAY_PARAMS_OVERRIDE,
  reanchorLevel,
  computeEntryBudget,
  DEFAULT_POSITION_PERCENT,
  FUTURES_POSITION_RATIO,
  riskLevelSizingMultiplier,
  ENTRY_COOLDOWN_MS,
  SMART_COOLDOWN_FLOOR_MS,
  isInEntryCooldown,
  resolveReentryRecovery,
  applySellPressureOverride,
  applyFundingOverride,
  detectMarketStress,
  MIN_SIM_ENTRY_USD,
  blockEntry,
  generateNewOrders,
  LIMIT_ORDER_TTL_MS,
  orderExpiryAt,
  ENTRY_TTL_HOLD_FRACTION,
  FEAR_BAND_LOW,
  FEAR_BAND_HIGH,
  FEAR_BAND_SIZING_FLOOR,
  selectFillableOrders,
  fillDueOrders,
  applyFundingAccrual,
  FUNDING_INTERVAL_MS,
  validateExposureModel,
  SLOT_PREEMPT_MARGIN,
  pickPreemptibleEntryOrder,
  applySlotPreemptions
} from './services/simExecution';
export type { FundingRateReading, FundingAccrualResult } from './services/simExecution';

// ── Drawdown circuit-breaker thresholds ─────────────────────────────────────
// Re-exported from intradayParams so the server-side bot engines read the SAME
// two numbers the engine does. Each bot applies them to its OWN equity curve;
// what is shared is the threshold, never the measurement.
export {
  DAILY_DRAWDOWN_BLOCK_PERCENT,
  WEEKLY_DRAWDOWN_LOCK_PERCENT,
  PER_ASSET_EXPOSURE_CAP_PERCENT,
  POSITION_TARGET_PCT,
  MAX_TOTAL_EXPOSURE_PERCENT
} from './services/intradayParams';

// ── Adaptive risk sizing (win/loss streaks, drawdown, Kelly-style sizing) ────
export type { ClosedTradeRecord, PerformanceWindow, AdaptiveRiskInput } from './services/adaptiveRisk';
export {
  EMPTY_PERFORMANCE_WINDOW,
  MIN_PERFORMANCE_SAMPLE,
  PERFORMANCE_WINDOW_SIZE,
  MIN_STOP_PERCENT,
  MAX_STOP_PERCENT,
  MIN_RISK_REWARD_RATIO,
  SL_ATR_MULTIPLIER,
  SL_TP_REWARD_RISK,
  kellyPayoffRatio,
  KELLY_MIN_SAMPLE,
  KELLY_MULTIPLIER,
  summarizeRecentPerformance,
  computeStreakFactor,
  computeDrawdownFactor,
  evaluateTimeStop,
  progressInR,
  TIME_STOP_HOURS,
  TIME_STOP_EXTENDED_HOURS,
  TIME_STOP_MIN_PROGRESS_R,
  MAX_HOLD_HOURS,
  computeWinRateFactor,
  computeAdaptiveRiskPercent,
  adaptiveRiskPercentFromHistory,
  computeSizingMultiplier,
  sizingMultiplierFromHistory,
  STREAK_COOLDOWN_LOSSES,
  STREAK_COOLDOWN_MS,
  STREAK_COOLDOWN_BIG_LOSS_THRESHOLD,
  computeSymbolStreakCooldownUntil,
  isInStreakCooldown,
  streakCooldownFromHistory,
  streakCooldownReason,
  PORTFOLIO_STREAK_COOLDOWN_LOSSES,
  PORTFOLIO_STREAK_COOLDOWN_MS,
  portfolioStreakCooldownUntil,
  portfolioStreakCooldownReason
} from './services/adaptiveRisk';

// ── 4H Path bot order generation ─────────────────────────────────────────────
// `generatePathOrders` / `pathEntryBudget` / `PathOrderGenContext` (the old
// single-timeframe empirical-bucket order generator, pathSimExecution.ts) were
// REMOVED 2026-09-14 — server/pathSimEngine.ts has called
// `generatePrev4hRangeOrders` (prev4hRangeExecution.ts) exclusively since the
// Prev-4H Range rewrite, so that file had been dead code, invisibly, for the
// life of the current "נתיב 4H" bot. It was discovered only because a profit-
// ratchet fix was wired into it by mistake and never reached the live bot.
// MIN_PATH_CANDLES / PATH_MIN_H4_BARS are still real (pathEngine.ts) — they
// are 4H timeframe arithmetic, not strategy, and the candle warm-up reads
// them. Re-exported from their actual source. (They used to be described here
// as "used by the DecisionEngine's PathAdapter"; that adapter was deleted
// 2026-09-16 — see pathEngine.ts's header.)
export { MIN_PATH_CANDLES, PATH_MIN_H4_BARS } from './services/pathEngine';

// ── Prev-4H Range ("נתיב 4H" sim bot) order generation ───────────────────────
export {
  generatePrev4hRangeOrders,
  MAX_TOTAL_EXPOSURE_PERCENT as PREV4H_MAX_TOTAL_EXPOSURE_PERCENT
} from './services/prev4hRangeExecution';
export type {
  Prev4hRangeOrderGenContext,
  Prev4hRangeCandleSet
} from './services/prev4hRangeExecution';

// ── TrendBreakout ("Bybit" sim bot) order generation ─────────────────────────
export {
  generateTrendBreakoutOrders,
  resolveScaleFractions,
  MIN_ORDER_EXCEEDS_POSITION_TARGET,
  effectiveStop as trendBreakoutEffectiveStop
} from './services/trendBreakoutExecution';
export type {
  TrendBreakoutOrderGenContext,
  TrendBreakoutCandleSet
} from './services/trendBreakoutExecution';
