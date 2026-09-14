/**
 * Home-page summary numbers for one simulation bot.
 * ============================================================================
 * Extracted from ExecutiveDashboard on 2026-09-14 because the arithmetic here
 * was wrong in a way nothing could catch: the dashboard read `cash` — the
 * UNINVESTED remainder — as both the bot's balance and the basis for its
 * profit. A bot holding $5,024 of open positions against $10,000 of starting
 * capital therefore showed a $4,976 "balance" and a −$5,024 "loss" while it was
 * actually flat. The number that belongs on both is EQUITY: cash plus the
 * mark-to-market value of what is open.
 *
 * Pure and exported so the regression has a test.
 */

export interface SimBotSummarySource {
  cash?: number;
  /** Cash + open positions, marked to market. Authoritative when present. */
  equity?: number;
  positionsValue?: number;
  /** Capital this run opened with, from the server snapshot. */
  initialAmount?: number;
  config?: { initialAmount?: number };
  positionsCount?: number;
  totalTrades?: number;
  winRate?: number;
  isRunning?: boolean;
}

export interface SimBotSummary {
  equity: number;
  cash: number;
  initialAmount: number;
  positionsCount: number;
  totalTrades: number;
  winRate: number;
  /** equity − initialAmount. Negative only on a real loss. */
  totalProfit: number;
  /** totalProfit as a percent of THIS bot's own starting capital. */
  totalProfitPercent: number;
  isRunning: boolean;
}

/** Fallback when a bot has no starting capital recorded yet. */
export const DEFAULT_INITIAL_AMOUNT = 10_000;

const num = (v: unknown, fallback = 0) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

export function summarizeSimBot(source: SimBotSummarySource): SimBotSummary {
  const initialAmount = num(source.initialAmount, 0) || num(source.config?.initialAmount, 0) || DEFAULT_INITIAL_AMOUNT;
  const cash = num(source.cash, 0);
  // Prefer the server's own equity; derive it only when absent. Never fall back
  // to cash alone — that is the bug this module exists to prevent.
  const equity = typeof source.equity === 'number' && Number.isFinite(source.equity)
    ? source.equity
    : cash + num(source.positionsValue, 0);
  const totalProfit = equity - initialAmount;

  return {
    equity,
    cash,
    initialAmount,
    positionsCount: num(source.positionsCount, 0),
    totalTrades: num(source.totalTrades, 0),
    winRate: num(source.winRate, 0),
    totalProfit,
    totalProfitPercent: initialAmount > 0 ? (totalProfit / initialAmount) * 100 : 0,
    isRunning: source.isRunning === true
  };
}
