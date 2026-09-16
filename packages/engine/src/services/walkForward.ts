/**
 * Walk-forward validation — TRAIN → VALIDATION → OUT-OF-SAMPLE.
 * ============================================================================
 * Pure splitting, scoring and survivor logic. No I/O, no engine, no clock —
 * `scripts/walkForward.ts` supplies the replay runs, this decides what they
 * mean.
 *
 * The discipline this encodes, and why each piece is here:
 *
 *   TRAIN       is where parameters may be chosen. Anything measured here is
 *               in-sample and proves nothing on its own.
 *   VALIDATION  is where a candidate chosen on TRAIN is checked. You may look
 *               at it as often as you like — but every look you ACT on makes
 *               it part of the training set, which is why it is separate from:
 *   OUT-OF-SAMPLE which may be consumed ONCE per configuration. The moment a
 *               parameter is changed because of an OOS result, that OOS window
 *               is spent. `assertOosUnspent` is the mechanical guard.
 *
 * On top of the split, two controls borrowed from the existing `pathStudy.ts`
 * work (which found ZERO surviving buckets across 4.9M outcomes, and is the
 * reason this project takes overfitting seriously):
 *
 *   · a NULL expectation — what a coin-flip strategy paying the same costs
 *     would return — so "positive" is measured against the right baseline
 *     rather than against zero.
 *   · a SURVIVOR rule over multiple windows, because one profitable window out
 *     of five is noise, not an edge.
 */

/** A half-open time window, [from, to). */
export interface WalkForwardWindow {
  label: 'TRAIN' | 'VALIDATION' | 'OOS';
  from: number;
  to: number;
}

export interface WalkForwardSplit {
  train: WalkForwardWindow;
  validation: WalkForwardWindow;
  oos: WalkForwardWindow;
}

/** Default split. TRAIN gets the most because it is the only window
 *  parameters may be fitted on; the other two only need enough trades to be
 *  statistically meaningful. */
export const DEFAULT_TRAIN_FRACTION = 0.6;
export const DEFAULT_VALIDATION_FRACTION = 0.2;

/**
 * Splits a timeline into the three windows, by TIME rather than by bar count,
 * so the boundaries mean the same thing across symbols with different bar
 * coverage.
 */
export function splitWalkForward(
  from: number,
  to: number,
  trainFraction: number = DEFAULT_TRAIN_FRACTION,
  validationFraction: number = DEFAULT_VALIDATION_FRACTION
): WalkForwardSplit {
  if (!(to > from)) throw new Error(`splitWalkForward: empty range ${from}..${to}`);
  if (!(trainFraction > 0) || !(validationFraction > 0) || trainFraction + validationFraction >= 1) {
    throw new Error(
      `splitWalkForward: fractions must be positive and leave room for OOS (got ${trainFraction}/${validationFraction})`
    );
  }
  const span = to - from;
  const trainEnd = from + Math.floor(span * trainFraction);
  const valEnd = trainEnd + Math.floor(span * validationFraction);
  return {
    train: { label: 'TRAIN', from, to: trainEnd },
    validation: { label: 'VALIDATION', from: trainEnd, to: valEnd },
    oos: { label: 'OOS', from: valEnd, to }
  };
}

/** Rolling windows, for the multi-window survivor rule. Each window is its own
 *  TRAIN/VAL/OOS split, stepped forward by `stepMs`. */
export function rollingWalkForward(
  from: number,
  to: number,
  windowMs: number,
  stepMs: number,
  trainFraction: number = DEFAULT_TRAIN_FRACTION,
  validationFraction: number = DEFAULT_VALIDATION_FRACTION
): WalkForwardSplit[] {
  if (!(windowMs > 0) || !(stepMs > 0)) throw new Error('rollingWalkForward: windowMs and stepMs must be positive');
  const out: WalkForwardSplit[] = [];
  for (let start = from; start + windowMs <= to; start += stepMs) {
    out.push(splitWalkForward(start, start + windowMs, trainFraction, validationFraction));
  }
  return out;
}

/** The only trade fields the scoring needs — deliberately narrow so a replay
 *  result, a live snapshot and a fixture all satisfy it. */
export interface ScorableTrade {
  pnl?: number;
  at?: number;
}

export interface RunScore {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  netProfit: number;
  grossWin: number;
  grossLoss: number;
  profitFactor: number;
  expectancy: number;
  /** Mean / standard deviation of per-trade pnl. Not annualised — a
   *  per-trade Sharpe, comparable only against other runs scored here. */
  sharpePerTrade: number;
}

export function scoreRun(trades: ScorableTrade[]): RunScore {
  const closed = trades.filter((t) => typeof t.pnl === 'number') as Required<Pick<ScorableTrade, 'pnl'>>[];
  const n = closed.length;
  if (n === 0) {
    return {
      trades: 0, wins: 0, losses: 0, winRate: 0, netProfit: 0,
      grossWin: 0, grossLoss: 0, profitFactor: 0, expectancy: 0, sharpePerTrade: 0
    };
  }
  const wins = closed.filter((t) => t.pnl > 0).length;
  const grossWin = closed.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(closed.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const netProfit = grossWin - grossLoss;
  const mean = netProfit / n;
  const variance = closed.reduce((s, t) => s + (t.pnl - mean) ** 2, 0) / n;
  const sd = Math.sqrt(variance);
  return {
    trades: n,
    wins,
    losses: n - wins,
    winRate: (wins / n) * 100,
    netProfit,
    grossWin,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    expectancy: mean,
    sharpePerTrade: sd > 0 ? mean / sd : 0
  };
}

/**
 * What a strategy with NO edge would have returned over the same number of
 * trades, paying the same round-trip cost. This is the baseline "positive"
 * has to beat — comparing against zero credits a strategy for the market
 * simply drifting up underneath it.
 *
 * Deliberately simple and pessimistic-free: a coin flip on the same average
 * win/loss sizes, minus the costs actually paid.
 */
export function nullExpectation(score: RunScore, roundTripCostUsd: number): number {
  if (score.trades === 0) return 0;
  const avgWin = score.wins > 0 ? score.grossWin / score.wins : 0;
  const avgLoss = score.losses > 0 ? score.grossLoss / score.losses : 0;
  const coinFlip = (avgWin - avgLoss) / 2;
  return (coinFlip - roundTripCostUsd) * score.trades;
}

export interface SurvivorRule {
  /** A window counts only if it produced at least this many trades. */
  minTradesPerWindow: number;
  /** …and this many windows must clear the null expectation. */
  minWindowsPositive: number;
  /** Modelled round-trip cost per trade, for `nullExpectation`. */
  roundTripCostUsd: number;
}

export const DEFAULT_SURVIVOR_RULE: SurvivorRule = {
  minTradesPerWindow: 20,
  minWindowsPositive: 2,
  roundTripCostUsd: 0
};

export interface SurvivorVerdict {
  survived: boolean;
  windowsScored: number;
  windowsPositive: number;
  windowsSkipped: number;
  reason: string;
}

/**
 * Applies the survivor rule across windows. A single profitable window is not
 * evidence — this is the check that says so out loud rather than leaving it to
 * whoever reads the numbers.
 */
export function judgeSurvivor(
  scores: RunScore[],
  rule: SurvivorRule = DEFAULT_SURVIVOR_RULE
): SurvivorVerdict {
  const scored = scores.filter((s) => s.trades >= rule.minTradesPerWindow);
  const skipped = scores.length - scored.length;
  // BOTH conditions, and they are not the same test:
  //   netProfit > 0          — it actually made money.
  //   netProfit > null       — it made money for a better reason than the
  //                            market drifting underneath it.
  // Note the null gets MORE negative as modelled costs rise (a coin flip pays
  // those costs too), so a higher cost LOWERS this bar rather than raising it.
  // That is why the profit test has to be there in its own right: beating a
  // coin flip while still losing money is not a surviving strategy.
  const positive = scored.filter(
    (s) => s.netProfit > 0 && s.netProfit > nullExpectation(s, rule.roundTripCostUsd)
  ).length;
  const survived = scored.length > 0 && positive >= rule.minWindowsPositive;

  let reason: string;
  if (scored.length === 0) {
    reason = `no window reached ${rule.minTradesPerWindow} trades — nothing to judge`;
  } else if (survived) {
    reason = `${positive}/${scored.length} windows beat the null expectation (need ${rule.minWindowsPositive})`;
  } else {
    reason = `only ${positive}/${scored.length} windows beat the null expectation (need ${rule.minWindowsPositive})`;
  }

  return { survived, windowsScored: scored.length, windowsPositive: positive, windowsSkipped: skipped, reason };
}

// ── The out-of-sample budget ────────────────────────────────────────────────

/** A record of one OOS window having been consumed. Persisted by the caller
 *  (a JSON ledger beside the snapshots) so the budget survives across runs —
 *  an in-memory guard would reset every time the script is re-launched, which
 *  is precisely when it is needed. */
export interface OosLedgerEntry {
  /** Identifies the DATA: which symbols, which window. */
  datasetKey: string;
  /** Identifies the CONFIGURATION that was tested against it. */
  configHash: string;
  at: number;
  netProfit: number;
}

/**
 * Refuses to spend an out-of-sample window twice on DIFFERENT configurations.
 *
 * Re-running the identical config is fine and returns quietly — that is a
 * reproduction, not a second look. A different config against the same OOS
 * window is the thing that silently turns out-of-sample into training data,
 * and it throws.
 */
export function assertOosUnspent(
  ledger: OosLedgerEntry[],
  datasetKey: string,
  configHash: string
): void {
  const prior = ledger.filter((e) => e.datasetKey === datasetKey);
  if (prior.length === 0) return;
  const differing = prior.filter((e) => e.configHash !== configHash);
  if (differing.length === 0) return;
  throw new Error(
    `Out-of-sample window "${datasetKey}" has already been spent on ${differing.length} other ` +
    `configuration(s) (first: ${differing[0].configHash} at ${new Date(differing[0].at).toISOString()}). ` +
    `Testing a NEW configuration against it makes it training data, and its result stops meaning ` +
    `anything. Extend the dataset, or accept the earlier result.`
  );
}

/** Stable hash of a parameter object, so the ledger can tell configurations
 *  apart without storing them whole. Key order is normalised — `{a:1,b:2}` and
 *  `{b:2,a:1}` are the same configuration. */
export function hashConfig(config: Record<string, unknown>): string {
  const normalised = JSON.stringify(config, Object.keys(config).sort());
  let h = 5381;
  for (let i = 0; i < normalised.length; i++) {
    h = ((h << 5) + h + normalised.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
