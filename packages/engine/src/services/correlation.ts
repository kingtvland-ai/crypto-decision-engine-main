// Cross-asset correlation gate — shared by all three simulation engines.
//
// Why this exists: every engine caps the NUMBER of open positions and the
// TOTAL leveraged exposure, but neither cap knows that BTC/ETH/SOL long
// positions opened during the same bull leg are, risk-wise, one position
// held three times. When the leg reverses they all hit their stops within
// minutes of each other and the "diversified" 3-position book takes a
// single-factor drawdown three times the size it was sized for.
//
// The gate below measures the actual co-movement of the candidate asset
// against what is already held, using Pearson correlation of LOG RETURNS
// (not prices — price levels are non-stationary and two assets in an
// uptrend correlate ~1.0 whatever their real co-movement) over a rolling
// window of recent bars, and refuses an entry that would push the count of
// highly-correlated, SAME-DIRECTION positions past the cap.
//
// Direction matters: a LONG BTC against a SHORT ETH with rho = 0.9 is a
// spread, not a concentration — the second leg hedges the first. So the
// gate scores each pair by its EFFECTIVE correlation (rho signed by whether
// the two positions point the same way) and only counts pairs above the
// threshold in the concentrating direction.

import { Candle } from './tradeEngine';

export type PositionDirection = 'LONG' | 'SHORT';

/** Rolling window (in bars) used for the correlation estimate. On the H1
 *  candles every engine already fetches this is a 3-day window — long
 *  enough to be stable, short enough to track a regime change. */
export const DEFAULT_CORRELATION_LOOKBACK = 72;

/** Pairs at or above this |rho| are treated as the same risk factor. */
export const DEFAULT_CORRELATION_THRESHOLD = 0.7;

/** How many already-open, highly-correlated same-direction positions are
 *  tolerated before a new one in that cluster is refused.
 *  7 slots × 3 correlated = ~43% of the book in one risk factor. Judgment call,
 *  not a measured optimum — calibrate with a portfolio-level backtest before
 *  enabling live trading. */
export const DEFAULT_MAX_CORRELATED = 3;

/** Below this many overlapping bars the estimate is noise; the gate then
 *  abstains (allows the entry) rather than blocking on a bad number. */
export const MIN_CORRELATION_SAMPLES = 20;

/** Below this, the shrink stops. MIN_CORRELATION_SAMPLES (20) plus a 16-bar
 *  buffer, so ordinary gaps in a thin altcoin's candle history don't push the
 *  estimate into "abstain" exactly when a fast-reacting read matters most — an
 *  abstain ALLOWS the entry, which would defeat the point of shrinking the
 *  window in the first place. Suggested starting value, not a measured one:
 *  validate with scripts/abBacktest.ts before relying on it. */
export const CORRELATION_LOOKBACK_FLOOR = 36;

/** Local, not imported from intradayIndicators: correlation.ts is shared
 *  infrastructure for all engines, and depending on an intraday-specific module
 *  would point the dependency backwards. */
function clampNum(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Linear shrink from `baseLookback` at atrPercentile = 0 to
 * CORRELATION_LOOKBACK_FLOOR at atrPercentile = 100.
 *
 * Why shrink at all: pairwise correlation among risk assets is not stationary,
 * and the failure mode this gate exists to catch is correlation spiking toward
 * 1 during a market-wide deleveraging. A fixed 72-bar (3-day H1) window is
 * structurally slow to see that — for most of the event it is still averaging in
 * the old, lower-correlation regime, which is exactly when the gate should be
 * most willing to refuse another position in the cluster and currently is least.
 *
 * Returns `baseLookback` unchanged when atrPercentile is omitted, so every
 * existing caller that does not pass it sees byte-identical behaviour.
 *
 * v1 scope, one variable at a time: the input is the CANDIDATE asset's own
 * atrPercentile. Only the intraday regime module actually computes one — Legacy
 * and Pro expose atrPercent (ATR as a share of price), a different quantity on a
 * different scale — so those two call sites pass nothing and keep the fixed
 * window until they grow a real percentile. A
 * market-wide proxy (BTC's ATR percentile, since a correlation-regime shift is
 * market-wide rather than asset-specific) is the natural v2, deferred until v1
 * is validated against history — the same discipline pathStudy.ts applies to its
 * own bucket splits.
 */
export function resolveCorrelationLookback(baseLookback: number, atrPercentile?: number): number {
  if (atrPercentile === undefined) return baseLookback;
  const p = clampNum(atrPercentile, 0, 100) / 100;
  const shrunk = baseLookback - (baseLookback - CORRELATION_LOOKBACK_FLOOR) * p;
  return Math.max(CORRELATION_LOOKBACK_FLOOR, Math.round(shrunk));
}

export function toPositionDirection(side: string | undefined | null): PositionDirection {
  const s = typeof side === 'string' ? side.toUpperCase() : '';
  return s === 'BUY' || s === 'LONG' ? 'LONG' : 'SHORT';
}

/** Log returns are additive and stationary — the right input for a
 *  correlation estimate over a price series. */
export function toLogReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    const cur = closes[i];
    if (prev > 0 && cur > 0) out.push(Math.log(cur / prev));
  }
  return out;
}

/**
 * Aligns two candle series on their SHARED timestamps and returns the last
 * `lookback` closes of each. Aligning on index instead (the tempting
 * shortcut) silently compares bar N of one asset with bar N of another
 * whenever the two series start at different times or one has a gap — which
 * is exactly the situation on thin alts, and it produces a correlation
 * number that means nothing.
 */
export function alignCloses(a: Candle[], b: Candle[], lookback: number): { a: number[]; b: number[] } {
  const bByTs = new Map<number, number>();
  for (const c of b) bByTs.set(c.timestamp, c.close);

  const aligned: { a: number; b: number }[] = [];
  for (const c of a) {
    const other = bByTs.get(c.timestamp);
    if (other !== undefined) aligned.push({ a: c.close, b: other });
  }

  const window = aligned.slice(-Math.max(2, lookback));
  return { a: window.map((p) => p.a), b: window.map((p) => p.b) };
}

/** Pearson correlation. Returns undefined (rather than 0 or NaN) when the
 *  sample is too small or one side has no variance — "unknown" and
 *  "uncorrelated" are different answers and the caller treats them
 *  differently. */
export function pearsonCorrelation(a: number[], b: number[]): number | undefined {
  const n = Math.min(a.length, b.length);
  if (n < MIN_CORRELATION_SAMPLES) return undefined;

  let sumA = 0, sumB = 0;
  for (let i = 0; i < n; i++) { sumA += a[i]; sumB += b[i]; }
  const meanA = sumA / n;
  const meanB = sumB / n;

  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA <= 0 || varB <= 0) return undefined;

  const rho = cov / Math.sqrt(varA * varB);
  if (!Number.isFinite(rho)) return undefined;
  return Math.max(-1, Math.min(1, rho));
}

/** Correlation of two assets' returns over the shared tail of their candle
 *  series. undefined when the overlap is too short to be meaningful. */
export function correlationBetween(
  a: Candle[] | undefined,
  b: Candle[] | undefined,
  lookback: number = DEFAULT_CORRELATION_LOOKBACK
): number | undefined {
  if (!a?.length || !b?.length) return undefined;
  // +1 bar: N returns need N+1 closes.
  const { a: closesA, b: closesB } = alignCloses(a, b, lookback + 1);
  return pearsonCorrelation(toLogReturns(closesA), toLogReturns(closesB));
}

export interface CorrelatedHolding {
  symbol: string;
  direction: PositionDirection;
}

export interface CorrelationMatch {
  symbol: string;
  /** Raw Pearson rho of the two return series. */
  rho: number;
  /** rho signed by direction agreement: positive = the two positions
   *  concentrate the same risk, negative = they offset each other. */
  effective: number;
}

export interface CorrelationGateInput {
  symbol: string;
  direction: PositionDirection;
  /** Positions (and already-queued entries) that count toward the cluster. */
  held: CorrelatedHolding[];
  /** Candle series per symbol, keyed the same way `symbol`/`held[].symbol`
   *  are. Same timeframe for every asset — mixing H1 and 5M here produces
   *  meaningless numbers. */
  candlesBySymbol: Record<string, Candle[] | undefined>;
  threshold?: number;
  maxCorrelated?: number;
  lookback?: number;
  /** Candidate asset's current ATR percentile (0-100), if available. When
   *  supplied, shrinks the correlation lookback toward
   *  CORRELATION_LOOKBACK_FLOOR as volatility rises. Omit for unchanged
   *  (fixed-lookback) behaviour. */
  atrPercentile?: number;
}

export interface CorrelationGateResult {
  allowed: boolean;
  /** Human-readable Hebrew reason, set only when the gate blocks. */
  reason?: string;
  /** Every already-held position that concentrates risk with the candidate. */
  matches: CorrelationMatch[];
  /** True when there was not enough overlapping history to judge — the gate
   *  allows the entry but the caller can surface that it abstained. */
  abstained: boolean;
}

/**
 * Decides whether opening `symbol` in `direction` would over-concentrate the
 * book into one risk factor.
 */
export function evaluateCorrelationGate(input: CorrelationGateInput): CorrelationGateResult {
  const {
    symbol,
    direction,
    held,
    candlesBySymbol,
    threshold = DEFAULT_CORRELATION_THRESHOLD,
    maxCorrelated = DEFAULT_MAX_CORRELATED,
    lookback = DEFAULT_CORRELATION_LOOKBACK,
    atrPercentile
  } = input;

  const effectiveLookback = resolveCorrelationLookback(lookback, atrPercentile);

  const candidate = candlesBySymbol[symbol];
  if (!candidate?.length || held.length === 0) {
    return { allowed: true, matches: [], abstained: !candidate?.length && held.length > 0 };
  }

  const matches: CorrelationMatch[] = [];
  let compared = 0;

  for (const h of held) {
    if (h.symbol === symbol) continue;
    const rho = correlationBetween(candidate, candlesBySymbol[h.symbol], effectiveLookback);
    if (rho === undefined) continue;
    compared++;
    const effective = h.direction === direction ? rho : -rho;
    if (effective >= threshold) matches.push({ symbol: h.symbol, rho, effective });
  }

  if (compared === 0) return { allowed: true, matches: [], abstained: true };

  matches.sort((x, y) => y.effective - x.effective);

  if (matches.length >= maxCorrelated) {
    const names = matches.slice(0, 3).map((m) => `${m.symbol} (${m.rho.toFixed(2)})`).join(', ');
    return {
      allowed: false,
      abstained: false,
      matches,
      reason: `קורלציה גבוהה מדי לפוזיציות פתוחות: ${names} — כבר ${matches.length} נכסים באותו גורם סיכון (מקס' ${maxCorrelated})`
    };
  }

  return { allowed: true, abstained: false, matches };
}

/**
 * Should an ABSTAINED gate block this entry?
 *
 * `evaluateCorrelationGate` returns `allowed: true, abstained: true` whenever it
 * cannot measure the pairing — the candidate has no candle history, or none of
 * the held book does. Until 2026-09-10 every caller read `allowed` and ignored
 * `abstained`, so "I could not check" was executed as "these are independent".
 *
 * That is backwards precisely when it costs the most. The book is least
 * verifiable at COLD START — the candle cache is empty — which is also when
 * every slot is free, cash is untouched and sizing is at full target. The
 * intraday sim bot opened six full-size correlated longs inside four minutes
 * (60% of equity on one factor), and all six stopped out together 12 minutes
 * later for -$102 of a -$107 run.
 *
 * So unverified stacking is capped at the same number the VERIFIED path allows:
 * a book already holding `maxUnverified` positions may not add another one it
 * cannot prove is independent. The first few still go through — a cap that
 * blocked from an empty book would deadlock a cold start permanently, since
 * candle history only accumulates once positions exist.
 */
export function blocksOnAbstention(
  gate: Pick<CorrelationGateResult, 'allowed' | 'abstained'>,
  heldCount: number,
  maxUnverified: number = DEFAULT_MAX_CORRELATED
): boolean {
  return gate.allowed && gate.abstained === true && heldCount >= maxUnverified;
}

/** Reason text for an entry blocked by {@link blocksOnAbstention}. */
export function abstentionBlockReason(heldCount: number, maxUnverified: number): string {
  return `אין היסטוריית נרות לאימות קורלציה ו-${heldCount} פוזיציות כבר פתוחות `
    + `(מקס' ${maxUnverified} ללא אימות) — לא נערמים על גורם סיכון שאי-אפשר למדוד`;
}
