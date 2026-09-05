/**
 * Combined-portfolio arithmetic for the simulation bots.
 * ============================================================================
 *
 * Lives outside the page component for one reason: it is the part that was
 * wrong, and a React page with no jsdom in this repo cannot be tested. The page
 * shipped four engines while eight aggregations still read
 * `intraday + legacy + pro`, so the risk meter under-reported the portfolio for
 * as long as the fourth engine held anything, and nothing failed.
 *
 * Everything here is pure. The page supplies the engines; this file decides what
 * the combined numbers are.
 */

import { SIM_BOT_STORAGE_KEY } from '../hooks/useSimulationBot';
import { PRO_SIM_BOT_STORAGE_KEY } from '../hooks/useProSimulationBot';
import { PATH_SIM_BOT_LAST_KNOWN_RUNNING_KEY } from '../contexts/PathSimulationBotContext';

/**
 * Keys holding the bots' remembered history (positions/trades/equity/running).
 *
 * Distinct from workerConfig/theme/credentials — those are connection and app
 * settings, not simulation state, and are intentionally left untouched.
 *
 * Read ONLY by Clear Cache. Reset All must never touch this list: resetting a
 * simulation and wiping the browser's cached market data are two different
 * operations, and collapsing them makes the cheap one unavailable.
 */
export const SIM_CACHE_KEYS = [
  SIM_BOT_STORAGE_KEY,
  'simulation-bot-state-v1',
  // The Legacy bot itself is deleted, but a browser that ran it before this
  // still has its snapshot cached under this literal key — there is no hook
  // left to import the constant from, so it is spelled out once here.
  'legacy-simulation-bot-state-v1',
  PRO_SIM_BOT_STORAGE_KEY,
  // The Path bot keeps no snapshot in the browser (it is server-only), but it
  // does remember whether it was running. Leaving that behind made a cleared
  // bot come back "running" on the next load.
  PATH_SIM_BOT_LAST_KNOWN_RUNNING_KEY,
  'crypto-portfolio'
];

/**
 * The shared shape every "all bots" calculation needs from an engine.
 *
 * Deliberately narrower than any one context: the four contexts differ in the
 * extras they carry, and aggregating over their union means fighting the type
 * checker at every field. This interface is the actual contract.
 */
export interface AggregatedBot {
  label: string;
  equity: number;
  positionsValue: number;
  totalLeveragedExposureUsd: number;
  positions: Array<{ type?: string }>;
  maxPositions: number;
  maxFuturesPositions: number;
  dailyDrawdownPercent: number;
  weeklyDrawdownPercent: number;
  /** False only when the figures above are placeholders rather than readings. */
  dataAvailable: boolean;
  start: () => Promise<void>;
  pause: () => Promise<void>;
  resetAll: () => Promise<void>;
  isRunning: boolean;
  controlError: string | null;
}

/** The subset of a bot context `toAggregated` reads. */
export interface AggregatableContext {
  equity: number;
  positionsValue: number;
  totalLeveragedExposureUsd: number;
  positions: Array<{ type?: string }>;
  config: { maxPositions?: number; maxFuturesPositions?: number };
  dailyDrawdownPercent: number;
  weeklyDrawdownPercent: number;
  start: () => Promise<void>;
  pause: () => Promise<void>;
  resetAll: () => Promise<void>;
  isRunning: boolean;
  controlError: string | null;
}

export function toAggregated(
  label: string,
  bot: AggregatableContext,
  dataAvailable = true
): AggregatedBot {
  return {
    label,
    equity: bot.equity,
    positionsValue: bot.positionsValue,
    totalLeveragedExposureUsd: bot.totalLeveragedExposureUsd,
    positions: bot.positions,
    maxPositions: bot.config.maxPositions ?? 7,
    maxFuturesPositions: bot.config.maxFuturesPositions ?? 2,
    dailyDrawdownPercent: bot.dailyDrawdownPercent,
    weeklyDrawdownPercent: bot.weeklyDrawdownPercent,
    dataAvailable,
    start: bot.start,
    pause: bot.pause,
    resetAll: bot.resetAll,
    isRunning: bot.isRunning,
    controlError: bot.controlError
  };
}

export interface CombinedRisk {
  portfolioValue: number;
  totalInvestedUsd: number;
  totalLeveragedExposureUsd: number;
  openPositionsCount: number;
  maxPositions: number;
  openFuturesCount: number;
  maxFutures: number;
  dailyDrawdownPercent: number;
  weeklyDrawdownPercent: number;
  /** Engines excluded from every figure above, by label. */
  unavailableEngines: string[];
}

/**
 * Combines the engines into the numbers the risk meter renders.
 *
 * Two rules the caller does not get to override:
 *
 * 1. Existing exposure counts, running engines do not. A paused bot still holds
 *    its positions; a meter that forgets them tells the operator they are flat
 *    when they are not. Nothing here reads `isRunning`.
 *
 * 2. An engine whose figures are placeholders is EXCLUDED, not folded in at
 *    zero. The Path bot has no browser fallback, so an unreachable worker
 *    yields equity 10,000 and exposure 0 — adding that puts 10,000 into the
 *    denominator and nothing into the numerator, and every percentage on the
 *    card shrinks by an amount nobody measured. The exclusion is reported in
 *    `unavailableEngines` so the UI can say so out loud.
 */
export function combineRisk(bots: AggregatedBot[]): CombinedRisk {
  const included = bots.filter((bot) => bot.dataAvailable);
  const sum = (pick: (bot: AggregatedBot) => number) =>
    included.reduce((total, bot) => total + (pick(bot) || 0), 0);

  return {
    portfolioValue: sum((bot) => bot.equity),
    totalInvestedUsd: sum((bot) => bot.positionsValue),
    totalLeveragedExposureUsd: sum((bot) => bot.totalLeveragedExposureUsd),
    openPositionsCount: included.reduce((total, bot) => total + bot.positions.length, 0),
    maxPositions: sum((bot) => bot.maxPositions),
    openFuturesCount: included.reduce(
      (total, bot) => total + bot.positions.filter((position) => position.type === 'FUTURES').length,
      0
    ),
    maxFutures: sum((bot) => bot.maxFuturesPositions),
    // Drawdown stays a MAX, not a sum: each engine measures its own equity curve
    // against its own capital, so the percentages are not additive. The breaker
    // fires on the worst engine — unchanged semantics, only the membership of
    // the set changes.
    dailyDrawdownPercent: included.reduce((worst, bot) => Math.max(worst, bot.dailyDrawdownPercent || 0), 0),
    weeklyDrawdownPercent: included.reduce((worst, bot) => Math.max(worst, bot.weeklyDrawdownPercent || 0), 0),
    unavailableEngines: bots.filter((bot) => !bot.dataAvailable).map((bot) => bot.label)
  };
}

/**
 * The action list for a group control (Start All / Pause All / Reset All).
 *
 * A one-line helper with a real job: it makes "did this action reach every
 * engine?" a property of the bot list rather than of a hand-written array
 * literal that someone has to remember to extend.
 */
export function groupAction(
  bots: AggregatedBot[],
  which: 'start' | 'pause' | 'resetAll'
): Array<() => Promise<void>> {
  return bots.map((bot) => bot[which]);
}
