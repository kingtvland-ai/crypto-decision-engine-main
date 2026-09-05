// Performance-adaptive position sizing and the streak cooldown — shared by
// all three simulation engines and by the server's 24/7 runners.
//
// The problem this solves: every engine sized each trade from a CONSTANT
// (0.5%/0.75% risk-per-trade for the intraday engine, a Kelly bet fraction
// for the legacy and pro engines). A constant means the fifth consecutive
// loss is taken at exactly the same size as the first, and the book keeps
// pressing while whatever edge it had is demonstrably not working. Neither
// the streak nor the open drawdown fed back into size anywhere.
//
// Two mechanisms live here:
//   1. A size multiplier from the recent streak, the recent win rate and the
//      current daily drawdown — de-risking into losses, re-risking (only
//      where the sizing model allows it) into wins.
//   2. A portfolio-level entry cooldown after consecutive losses, so a bad
//      patch stops the book entirely for a while rather than merely
//      shrinking it. A confidence threshold cannot do this: the signals that
//      lose in a chop are frequently the high-confidence ones.

import { toBaseAsset } from './assetUniverse';

/** A closed trade as the engines record it. `at` is the fill timestamp —
 *  supply it whenever available: it is what lets this module order the
 *  history itself instead of trusting the caller's array order.
 *  `symbol` is the base asset (e.g. "BTC") — required for per-symbol cooldown. */
export interface ClosedTradeRecord {
  pnl: number;
  /** Base symbol (e.g. "BTC") — used for per-symbol cooldown tracking. */
  symbol?: string;
  at?: number;
  /** Capital at risk at ENTRY — see ClosedTradeMetric.riskUsd in tradeEngine.ts
   *  for why this is snapshotted rather than derived at close. */
  riskUsd?: number;
}

/** Kelly's payoff ratio R = avgWin / avgLoss.
 *
 *  Measured in DOLLARS this is contaminated by position size: a run of wins
 *  taken at large size inflates R, which inflates betFraction, which inflates
 *  the next R — the estimator feeds on its own output. Measured in R-multiples
 *  (pnl / risk-at-entry) the size cancels and what is left is the edge.
 *
 *  Returns null when the history cannot support the R-multiple form, so the
 *  caller can fall back rather than silently mixing units. Requires EVERY
 *  trade in the window to carry riskUsd: a partial mix would divide dollar
 *  wins by R-multiple losses, which is worse than either alone.
 */
/**
 * How far back Kelly is allowed to remember.
 *
 * Without a bound the estimator is an ABSORBING STATE. `calculateRiskParameters`
 * refuses to size a trade when the measured edge is negative — correct on its
 * own — but the edge was measured over every trade ever closed, so once a bad
 * stretch pushed it below zero no new trade could open, no new data could
 * arrive, and the estimate could never change. Measured on six months of
 * Legacy: 421 signals cleared routing and 373 of them (88%) died at sizing.
 *
 * Bounding the memory breaks the trap without ever deliberately sizing into a
 * known-negative edge: as old trades age out the sample eventually falls below
 * KELLY_MIN_SAMPLE, sizing reverts to the flat pre-Kelly default, and the bot
 * re-measures. An edge from a regime three months gone is not evidence about
 * this one.
 *
 * The reference point is the most recent CLOSED TRADE, not the wall clock —
 * reading the clock inside a pure function is the exact bug that made every
 * backtested position look a year old (see evaluateExit's `now`).
 */
export const KELLY_MEMORY_MS = 90 * 24 * 3_600_000;

/** The slice of history Kelly is allowed to see. */
export function recentTrades<T extends { at?: number }>(
  trades: ReadonlyArray<T>,
  memoryMs: number = KELLY_MEMORY_MS
): T[] {
  let newest = 0;
  for (const t of trades) if (typeof t.at === 'number' && t.at > newest) newest = t.at;
  if (!newest) return [...trades];
  const cutoff = newest - memoryMs;
  return trades.filter((t) => typeof t.at !== 'number' || t.at >= cutoff);
}

export function kellyPayoffRatio(
  trades: ReadonlyArray<ClosedTradeRecord>
): { r: number; basis: 'r-multiple' | 'dollar' } | null {
  const winning = trades.filter((t) => t.pnl > 0);
  const losing = trades.filter((t) => t.pnl < 0);
  if (!winning.length || !losing.length) return null;

  const usable = (t: ClosedTradeRecord) => typeof t.riskUsd === 'number' && t.riskUsd > 0;
  if (trades.every(usable)) {
    const avgWinR = winning.reduce((s, t) => s + t.pnl / t.riskUsd!, 0) / winning.length;
    const avgLossR = Math.abs(losing.reduce((s, t) => s + t.pnl / t.riskUsd!, 0) / losing.length);
    if (avgLossR > 0) return { r: avgWinR / avgLossR, basis: 'r-multiple' };
  }

  const avgWin = winning.reduce((s, t) => s + t.pnl, 0) / winning.length;
  const avgLoss = Math.abs(losing.reduce((s, t) => s + t.pnl, 0) / losing.length);
  if (avgLoss > 0) return { r: avgWin / avgLoss, basis: 'dollar' };
  return null;
}

/** Trades required before Kelly is trusted to size at all.
 *
 *  KEPT AT 30 ON EVIDENCE, against the statistical argument for raising it.
 *
 *  The argument for 100 is sound in isolation: at n=30 the standard error on a
 *  win rate near 50% is ~9.1pp, which swings the resulting bet fraction 3.5x on
 *  sampling noise alone. But raising it was measured (A/B, 6 symbols x 6 months,
 *  scripts/abBacktest.ts) and made both engines dramatically worse — Pro went
 *  from +$17.66 to -$103.21 and its max drawdown from 1.66% to 7.22%.
 *
 *  The reason is the fallback, not the threshold. Below this floor the engines
 *  size at a FLAT 6% with no edge feedback at all, so raising the floor simply
 *  buys more trades taken blind. Noisy Kelly still beats no Kelly here because
 *  it clamps to zero on a losing book — the protection comes from the sign of
 *  the edge, which 30 trades does resolve, not its magnitude, which it doesn't.
 *
 *  MAKING THE SUB-THRESHOLD PATH EDGE-AWARE WAS TRIED AND IS WORSE. The
 *  obvious fix — replace the step with a continuous Beta-Binomial posterior on
 *  the win rate plus shrinkage of the payoff ratio toward the structural one —
 *  was implemented and A/B measured across prior strengths. Pro, same window,
 *  against this step function's +$44.10 / PF 1.315 / 0.90% drawdown:
 *
 *      k=5    +$12.31  PF 1.061   DD 1.29%     k=40   -$107.96  PF 0.726  DD 4.84%
 *      k=10    +$5.61  PF 1.027   DD 1.33%     k=80   -$131.10  PF 0.729  DD 5.44%
 *      k=20   -$61.33  PF 0.772   DD 4.30%     k=160  -$155.11  PF 0.731  DD 5.98%
 *      lower-confidence-bound variant, k=40:   -$5.65   PF 0.949  DD 0.76%
 *
 *  Monotone in k, and every variant loses. The reason is that this threshold's
 *  value was never the flat 6% below it — it is that RAW Kelly above it clamps
 *  to zero within a few trades of a book turning negative, which halts trading
 *  outright. Any prior floors that estimate and keeps the engine in the market:
 *  at k=40 Pro's trade count went from 42 to 177. The prior is optimistic by
 *  construction (52.5% against a 37.5% breakeven at R=1.67), so it cannot help
 *  being a floor.
 *
 *  The premise that the first 30 trades are "taken blind" is therefore wrong in
 *  the way that matters: they are taken at a fixed small size, which costs
 *  little, whereas diluting Kelly's shutoff costs a great deal. Treat this as
 *  settled unless you have a mechanism that de-risks a losing book FASTER than
 *  raw Kelly, not merely more smoothly. Measured via scripts/abBacktest.ts. */
export const KELLY_MIN_SAMPLE = 30;

/** Fraction of full Kelly actually bet. Was 0.5 (half-Kelly).
 *
 *  Half-Kelly is the growth-optimal ceiling when the edge is KNOWN. Here it is
 *  estimated from a rolling window and drifts with regime, so the quarter is
 *  the standard allowance for estimation error. Measured: +$12.15 -> +$17.66
 *  on Pro over the A/B window, with drawdown flat. */
export const KELLY_MULTIPLIER = 0.25;

export interface PerformanceWindow {
  /** Number of closed trades actually considered. */
  sampleSize: number;
  /** Consecutive losses ending at the most recent closed trade. */
  lossStreak: number;
  /** Consecutive wins ending at the most recent closed trade. */
  winStreak: number;
  /** Fraction in [0,1] over the window. */
  winRate: number;
  /** Timestamp of the most recent losing trade, when known. */
  lastLossAt?: number;
  /** PnL percentage of the most recent losing trade (vs portfolio value). */
  lastLossPnlPercent?: number;
}

export const EMPTY_PERFORMANCE_WINDOW: PerformanceWindow = {
  sampleSize: 0,
  lossStreak: 0,
  winStreak: 0,
  winRate: 0
};

/** Trades below this many closed trades are not a sample — sizing stays at
 *  base rather than reacting to two coin flips. */
export const MIN_PERFORMANCE_SAMPLE = 5;

/** Rolling window of closed trades used for the win-rate term. */
export const PERFORMANCE_WINDOW_SIZE = 20;

// ── Stop Loss floor / ceiling (shared by Legacy + Pro) ─────────────────────
// Prevents ATR-based SL from collapsing onto the entry (a sub-1.5% stop on a
// low-vol coin like TRUMPUSDT gets blown through by normal noise) or from
// ballooning in a high-vol regime into a stop so wide it commits far more
// capital than intended. Applied as a clamp on the SL distance in
// tradeEngine.calculateRiskParameters and proAlgEngine.calculateProRisk.
export const MIN_STOP_PERCENT = 1.5;  // floor — minimum SL distance (% of entry)
export const MAX_STOP_PERCENT = 6;    // ceiling — maximum SL distance (% of entry)

/** ATR multiple defining the stop distance in Legacy and Pro, before the
 *  [MIN_STOP_PERCENT, MAX_STOP_PERCENT] clamp.
 *
 *  Replaces a flat 1.8%, which was a measurement error: the same percentage is
 *  noise-width on a large cap and multiple sessions' range on a small one. The
 *  clamp then binds on the quiet majors while the ATR binds on the volatile
 *  alts, which is the intended division of labour. The intraday engine's
 *  equivalent is intradayParams.minStopAtrMult.
 *
 *  Swept over the A/B window (scripts/abBacktest.ts), Pro profit factor /
 *  Legacy profit factor:
 *      1.0 -> 1.191 / 0.796      2.0 -> 1.131 / 0.849
 *      1.2 -> 1.315 / 0.889      2.5 -> 1.058 / 0.843
 *      1.5 -> 1.320 / 0.873
 *
 *  READ THIS BEFORE TUNING IT. The optimum is FLAT between 1.2 and 1.5 — those
 *  two are within noise of each other on ~40 trades, and choosing between them
 *  on this window would be curve-fitting. The robust finding is the shape: the
 *  1.2-1.5 region beats everything outside it, and >=2.0 is clearly worse on
 *  both engines. 1.2 is taken for the better drawdown on Pro (0.90% vs 1.03%)
 *  and the better Legacy profit factor, not because it is a located optimum. */
export const SL_ATR_MULTIPLIER = 1.2;

/** Reward:risk of the first take-profit. Was implied by the fixed 1.8%/3.0%
 *  pair; now applied explicitly so TP scales WITH the stop and the ratio stays
 *  invariant across volatility regimes. */
export const SL_TP_REWARD_RISK = 3.0 / 1.8; // 1.67

// ── Cost / Edge Gate (shared by Legacy + Pro) ──────────────────────────────
// Minimum risk-reward ratio for a trade to be worth taking. Derived from the
// ATR multipliers (SL = ATR*1.5/1.8, TP = ATR*2.0/2.7) which produce ratios
// in the 1.33-1.5 range. Trades below this threshold don't have enough edge
// to justify the risk. Applied in legacySimExecution and proSimExecution.
export const MIN_RISK_REWARD_RATIO = 1.5;

/**
 * Summarizes recent closed trades into the streak/win-rate figures the
 * sizing rules below consume.
 *
 * Ordering: if every record carries `at`, the history is sorted ascending by
 * it here. That is deliberate and load-bearing — the engines keep their
 * trade arrays NEWEST-FIRST for display, so a caller that simply took the
 * tail of its own array and walked it backwards was reading the OLDEST
 * trades and reporting a streak from ancient history. Records without `at`
 * are assumed to be in chronological (oldest-first) order.
 *
 * @param portfolioValue  If supplied, used to calculate lastLossPnlPercent
 *                        (the most recent loss as % of portfolio).
 */
export function summarizeRecentPerformance(
  closed: ClosedTradeRecord[],
  windowSize: number = PERFORMANCE_WINDOW_SIZE,
  portfolioValue?: number
): PerformanceWindow {
  if (!closed?.length) return { ...EMPTY_PERFORMANCE_WINDOW };

  const hasTimestamps = closed.every((t) => typeof t.at === 'number');
  const ordered = hasTimestamps
    ? [...closed].sort((a, b) => (a.at as number) - (b.at as number))
    : closed;

  const window = ordered.slice(-Math.max(1, windowSize));

  let lossStreak = 0;
  for (let i = window.length - 1; i >= 0; i--) {
    if (window[i].pnl < 0) lossStreak++;
    else break;
  }

  let winStreak = 0;
  for (let i = window.length - 1; i >= 0; i--) {
    if (window[i].pnl > 0) winStreak++;
    else break;
  }

  const wins = window.filter((t) => t.pnl > 0).length;

  let lastLossAt: number | undefined;
  let lastLossPnl: number | undefined;
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (ordered[i].pnl < 0) { lastLossAt = ordered[i].at; lastLossPnl = ordered[i].pnl; break; }
  }

  // Calculate last loss as percentage of portfolio value
  let lastLossPnlPercent: number | undefined;
  if (typeof lastLossPnl === 'number' && portfolioValue && portfolioValue > 0) {
    lastLossPnlPercent = (lastLossPnl / portfolioValue) * 100;
  }

  return {
    sampleSize: window.length,
    lossStreak,
    winStreak,
    winRate: window.length ? wins / window.length : 0,
    lastLossAt,
    lastLossPnlPercent
  };
}

/**
 * Streak term. Cuts hard into a losing run and adds only modestly into a
 * winning one — the asymmetry is intentional: a loss streak is evidence the
 * current regime does not suit the strategy, while a win streak is mostly
 * evidence the regime is favourable, which is the situation in which
 * over-sizing does the most damage when it ends.
 */
export function computeStreakFactor(lossStreak: number, winStreak: number): number {
  if (lossStreak >= 5) return 0.25;
  if (lossStreak >= 3) return 0.5;
  if (lossStreak >= 2) return 0.75;
  if (winStreak >= 5) return 1.5;
  if (winStreak >= 3) return 1.25;
  return 1;
}

/**
 * Drawdown term. Linear from 1.0 at flat to 0.25 at the 11.25% mark, floored
 * there — the daily circuit breaker halts the book at 8% anyway, so this
 * shapes sizing on the way to that line rather than replacing it.
 */
export function computeDrawdownFactor(dailyDrawdownPercent: number): number {
  if (!(dailyDrawdownPercent > 0)) return 1;
  return Math.max(0.25, 1 - dailyDrawdownPercent / 15);
}

/**
 * Win-rate term — a gentle tilt, not a lever. Requires a real sample before
 * it does anything, and is capped at +/-10% so a 20-trade window can never
 * dominate the streak and drawdown terms.
 */
export function computeWinRateFactor(perf: PerformanceWindow): number {
  if (perf.sampleSize < 10) return 1;
  const tilt = (perf.winRate - 0.5) * 0.2;
  return Math.max(0.9, Math.min(1.1, 1 + tilt));
}

export interface AdaptiveRiskInput {
  baseRiskPercent: number;
  recentLossStreak: number;
  recentWinStreak: number;
  recentWinRate: number;
  dailyDrawdownPercent: number;
  /** Window size behind the win-rate figure; below MIN=10 the win-rate term
   *  is neutral. Defaults to a full window for backward compatibility. */
  sampleSize?: number;
}

/**
 * Risk-per-trade sizing (the intraday engine): returns the percentage of
 * equity to risk on the next trade. Used as an override for
 * IntradayParams.riskPerTradePercent, and clamped to the same 0.05..2.0
 * band that intradayRisk.ts enforces downstream.
 */
export function computeAdaptiveRiskPercent(input: AdaptiveRiskInput): number {
  const {
    baseRiskPercent, recentLossStreak, recentWinStreak, recentWinRate,
    dailyDrawdownPercent, sampleSize = PERFORMANCE_WINDOW_SIZE
  } = input;

  const streakFactor = computeStreakFactor(recentLossStreak, recentWinStreak);
  const drawdownFactor = computeDrawdownFactor(dailyDrawdownPercent);
  const winRateFactor = computeWinRateFactor({
    sampleSize, lossStreak: recentLossStreak, winStreak: recentWinStreak, winRate: recentWinRate
  });

  const adjusted = baseRiskPercent * streakFactor * drawdownFactor * winRateFactor;
  return Number(Math.max(0.05, Math.min(2, adjusted)).toFixed(3));
}

/** Convenience wrapper: performance window in, risk percent out. */
export function adaptiveRiskPercentFromHistory(
  baseRiskPercent: number,
  closed: ClosedTradeRecord[],
  dailyDrawdownPercent: number
): number | undefined {
  const perf = summarizeRecentPerformance(closed);
  if (perf.sampleSize < MIN_PERFORMANCE_SAMPLE) return undefined;
  return computeAdaptiveRiskPercent({
    baseRiskPercent,
    recentLossStreak: perf.lossStreak,
    recentWinStreak: perf.winStreak,
    recentWinRate: perf.winRate,
    dailyDrawdownPercent,
    sampleSize: perf.sampleSize
  });
}

/**
 * Bet-fraction sizing (the legacy and pro engines, which size directly from
 * Kelly rather than from a risk percentage).
 *
 * Deliberately capped at 1.0 — it can only de-risk. Half-Kelly is already
 * the growth-optimal ceiling for the estimated edge; scaling ABOVE it on a
 * win streak is not "pressing the edge", it is betting more than the edge
 * supports precisely when the estimate is most inflated by a lucky run. The
 * upside branch of computeStreakFactor is therefore clamped away here while
 * the downside branch is kept in full.
 */
export function computeSizingMultiplier(perf: PerformanceWindow, dailyDrawdownPercent: number): number {
  if (perf.sampleSize < MIN_PERFORMANCE_SAMPLE) {
    // Not enough trades to judge the streak, but the drawdown is a fact
    // regardless of sample size — it is measured from equity, not from wins.
    return computeDrawdownFactor(dailyDrawdownPercent);
  }
  const streakFactor = Math.min(1, computeStreakFactor(perf.lossStreak, perf.winStreak));
  const multiplier = streakFactor * computeDrawdownFactor(dailyDrawdownPercent) * computeWinRateFactor(perf);
  return Number(Math.max(0.2, Math.min(1, multiplier)).toFixed(4));
}

/** Convenience wrapper for the Kelly-sized engines. */
export function sizingMultiplierFromHistory(closed: ClosedTradeRecord[], dailyDrawdownPercent: number): number {
  return computeSizingMultiplier(summarizeRecentPerformance(closed), dailyDrawdownPercent);
}

// ── Streak cooldown ──────────────────────────────────────────────────────────
// Sizing down is not the same as standing down. A losing streak on a single
// symbol usually means that symbol is the problem — so the cooldown is now
// PER-SYMBOL, not portfolio-level.
//
// The cooldown is CANCELLED if the loss was greater than 5% of the total
// portfolio value — large losses are a different regime and should not
// trigger a cooldown (the position was already stopped out).

export const STREAK_COOLDOWN_LOSSES = 2;
export const STREAK_COOLDOWN_MS = 30 * 60 * 1000;
/** Losses above this percentage of portfolio value cancel the cooldown. */
export const STREAK_COOLDOWN_BIG_LOSS_THRESHOLD = 5;

/**
 * Timestamp until which new entries are blocked for a specific symbol, or
 * undefined when the book is clear for that symbol.
 *
 * @param perf  Performance window for the symbol
 * @param portfolioValue  Total portfolio value — used to check if the loss
 *                        was > 5% (which cancels the cooldown)
 * @param lossesRequired  Consecutive losses before cooldown triggers
 * @param cooldownMs  Duration of the cooldown
 */
export function computeSymbolStreakCooldownUntil(
  perf: PerformanceWindow,
  portfolioValue: number,
  lossesRequired: number = STREAK_COOLDOWN_LOSSES,
  cooldownMs: number = STREAK_COOLDOWN_MS
): number | undefined {
  if (perf.lossStreak < lossesRequired || typeof perf.lastLossAt !== 'number') return undefined;

  // Cancel cooldown if the loss was > 5% of portfolio — large losses are
  // a different regime and should not trigger a cooldown.
  if (portfolioValue > 0 && perf.lastLossPnlPercent !== undefined) {
    const lossPercentOfPortfolio = Math.abs(perf.lastLossPnlPercent);
    if (lossPercentOfPortfolio > STREAK_COOLDOWN_BIG_LOSS_THRESHOLD) return undefined;
  }

  return perf.lastLossAt + cooldownMs;
}

export function isInStreakCooldown(until: number | undefined, now: number = Date.now()): boolean {
  return typeof until === 'number' && now < until;
}

/** Convenience wrapper: closed-trade history in, cooldown deadline out.
 *  Filters trades by the given symbol. If no trades have symbols (legacy data),
 *  falls back to portfolio-level behavior (all trades considered). */
export function streakCooldownFromHistory(
  closed: ClosedTradeRecord[],
  portfolioValue: number,
  symbol?: string
): number | undefined {
  // Check if any trades have symbols — if not, use portfolio-level behavior
  const hasSymbolData = closed.some((t) => t.symbol !== undefined);
  const filtered = (hasSymbolData && symbol)
    ? closed.filter((t) => t.symbol && toBaseAsset(t.symbol) === toBaseAsset(symbol))
    : closed;
  return computeSymbolStreakCooldownUntil(
    summarizeRecentPerformance(filtered, PERFORMANCE_WINDOW_SIZE, portfolioValue),
    portfolioValue
  );
}

export function streakCooldownReason(until: number, symbol?: string): string {
  const minutesLeft = Math.max(1, Math.ceil((until - Date.now()) / 60_000));
  const symbolText = symbol ? ` על ${symbol}` : '';
  return `הפוגה אחרי רצף הפסדים${symbolText} — כניסות חדשות חסומות עוד ${minutesLeft} דק'`;
}

// ── Time stops for the H1 engines (Legacy + Pro) ─────────────────────────────
//
// A stop answers "was I wrong about direction". A time stop answers a different
// question: "was I wrong about the trade happening at all". A position sitting
// between its stop and its target after two days is not a thesis any more, it is
// capital and a position slot spent on nothing, and it carries the same gap and
// funding risk as a working trade while earning none of the payoff.
//
// Both H1 engines already had the clock and the branches. What they did not have
// was a reachable exit: each branch was wrapped in
//
//     if (beyondTp || beyondSl) { ...close... }
//
// and by the time the code reached it, a price beyond the stop had already
// returned at the STOP_LOSS check and a price beyond the target at the TAKE_PROFIT
// check. The guard was therefore true only for prices that had already exited,
// which is to say never — documented behaviour, dead in practice, and exactly
// backwards: the trades a time stop exists to cut are the ones sitting BETWEEN
// the two levels.
//
// What replaces it is the question the checkpoint is actually asking, measured in
// R (favourable move / original stop distance) so it means the same thing on a
// 1.5% stop and a 6% one.

/** Hours after which a position is asked to justify itself. */
export const TIME_STOP_HOURS = { spot: 48, futures: 24 };

/** A futures position that is working at its checkpoint earns a reprieve to this
 *  hour — once, and it faces the same test again on arrival. */
export const TIME_STOP_EXTENDED_HOURS = 36;

/** Favourable progress, in R, that counts as "this trade is going somewhere". */
export const TIME_STOP_MIN_PROGRESS_R = 0.3;

/** Hard ceiling on holding time. Reached regardless of progress: past this the
 *  position is no longer the trade that was entered. */
export const MAX_HOLD_HOURS = { spot: 72, futures: 48 };

/** Favourable move as a multiple of the original stop distance. Negative when
 *  the position is under water. Returns 0 when the stop distance is unusable. */
export function progressInR(entryPrice: number, currentPrice: number, stopLoss: number, isLong: boolean): number {
  const stopDistance = Math.abs(entryPrice - stopLoss);
  if (!(stopDistance > 0)) return 0;
  return ((currentPrice - entryPrice) * (isLong ? 1 : -1)) / stopDistance;
}

export interface TimeStopInput {
  heldMs: number;
  isFutures: boolean;
  /** Favourable progress in R at the moment of the check. */
  progressR: number;
  /** Futures only: TP1 already taken. A position that has banked half is
   *  running on house money and is not what this check is for. */
  tp1Hit?: boolean;
}

export interface TimeStopVerdict {
  action: 'NONE' | 'PARTIAL_50' | 'FULL';
  reason: string;
}

/**
 * The time-stop rule shared by both H1 engines.
 *
 * Futures cut HALF at the checkpoint (alg.md §Layer4.4 asks for a reduction, not
 * a close) and the whole position at the hard ceiling. Spot has no partial, so
 * its checkpoint closes outright.
 */
export function evaluateTimeStop(input: TimeStopInput): TimeStopVerdict {
  const hoursHeld = input.heldMs / 3_600_000;
  const maxHold = input.isFutures ? MAX_HOLD_HOURS.futures : MAX_HOLD_HOURS.spot;

  if (hoursHeld >= maxHold) {
    return {
      action: 'FULL',
      reason: `תקרת החזקה (${maxHold} שעות) — סגירה מלאה ללא תלות בהתקדמות (${input.progressR.toFixed(2)}R)`
    };
  }

  const checkpoint = input.isFutures ? TIME_STOP_HOURS.futures : TIME_STOP_HOURS.spot;
  if (hoursHeld < checkpoint) return { action: 'NONE', reason: '' };

  if (input.isFutures && input.tp1Hit) {
    return { action: 'NONE', reason: '' };
  }

  // Working at the checkpoint: one reprieve, re-tested on arrival.
  if (input.progressR > TIME_STOP_MIN_PROGRESS_R) {
    const extendedTo = input.isFutures ? TIME_STOP_EXTENDED_HOURS : maxHold;
    if (hoursHeld < extendedTo) {
      return {
        action: 'NONE',
        reason: `הרחבת יציאת זמן: ${input.progressR.toFixed(2)}R לטובתנו אחרי ${hoursHeld.toFixed(1)} שעות — ממשיכים עד ${extendedTo} שעות`
      };
    }
  }

  return input.isFutures
    ? {
        action: 'PARTIAL_50',
        reason: `יציאת זמן (${Math.floor(hoursHeld)} שעות): התקדמות ${input.progressR.toFixed(2)}R < ${TIME_STOP_MIN_PROGRESS_R}R — צמצום הפוזיציה ב-50%`
      }
    : {
        action: 'FULL',
        reason: `יציאת זמן (${Math.floor(hoursHeld)} שעות): התקדמות ${input.progressR.toFixed(2)}R < ${TIME_STOP_MIN_PROGRESS_R}R — סגירת פוזיציית Spot`
      };
}
