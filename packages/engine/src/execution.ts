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
  DEFAULT_SLIPPAGE_PERCENT,
  calculateBreakEvenPrice
} from './services/tradeEngine';

// ── Simulation defaults, shared by the worker and the browser ─────────────
export {
  SIM_BOTS,
  SIM_BOT_IDS,
  SIM_BOT_SPECS,
  UI_FACING_SIM_PREFIXES,
  SIM_BASE_DEFAULTS,
  SIM_MIN_CONFIDENCE,
  SIM_MAX_FUTURES_POSITIONS,
  simBotDefaults
} from './services/simDefaults';
export type { SimBotId, SimBotSpec, ConfidenceScale, SimEnvOverrides } from './services/simDefaults';

// ── Order generation per engine ──────────────────────────────────────────────
export type { ProOrderGenContext } from './services/proSimExecution';
export {
  MIN_PRO_CANDLES,
  buildProEvaluation,
  generateProOrders
} from './services/proSimExecution';

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
  FillResult
} from './services/simExecution';
export {
  SIM_INTRADAY_PARAMS_OVERRIDE,
  reanchorLevel,
  computeEntryBudget,
  DEFAULT_POSITION_PERCENT,
  FUTURES_POSITION_RATIO,
  riskLevelSizingMultiplier,
  ENTRY_COOLDOWN_MS,
  isInEntryCooldown,
  generateNewOrders,
  LIMIT_ORDER_TTL_MS,
  selectFillableOrders,
  fillDueOrders
} from './services/simExecution';

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
  streakCooldownReason
} from './services/adaptiveRisk';

// ── 4H Path bot order generation ─────────────────────────────────────────────
export { generatePathOrders, pathEntryBudget, MIN_PATH_CANDLES,
  PATH_MIN_H4_BARS } from './services/pathSimExecution';
export type { PathOrderGenContext } from './services/pathSimExecution';
