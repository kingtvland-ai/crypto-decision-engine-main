/**
 * Profit ratchet — the only profit-taking mechanism in the four sim bots.
 * ============================================================================
 * Operator decision 2026-09-14, replacing the fixed TP1/TP2 ladder and every
 * bot's own trailing stop. The complaint it answers: the bots kept giving back
 * open profit and closing red in a market that was going up.
 *
 * The ladder is a set of PROFIT rungs measured from entry:
 *
 *     1.8%  →  3%  →  4%  →  5%  →  6%  →  ...   (+1% forever)
 *
 * Crossing a rung on the way UP does nothing but mark it. The position keeps
 * running — that is the whole point, and the reason this is not just a tighter
 * take-profit. Selling happens only on the way BACK DOWN:
 *
 *   · back to a rung of 3% or higher  →  sell RATCHET_PARTIAL_FRACTION (30%)
 *     of what is left, and CONSUME that rung: it never fires again for this
 *     position. Without that rule a price oscillating around a rung would sell
 *     30% on every tick and bleed the position out in fees.
 *   · back to the 1.8% rung           →  close the whole remainder. This is the
 *     floor: a position that once touched +1.8% is not allowed to turn red.
 *
 * A rung is only armed once the PEAK has crossed it, so a position that never
 * reaches +1.8% is governed entirely by the stop loss, as before.
 *
 * Consumption is NOT monotonic: consuming the 4% rung on a pullback does not
 * retire the 5% rung, which arms later if a fresh high crosses it. That is why
 * the state is a set of consumed rungs rather than a single high-water mark.
 *
 * This module is pure — no prices fetched, no orders built. Each bot's order
 * generator calls `evaluateRatchet` and translates the verdict into its own
 * order shape.
 */

import { positionPnlPercent } from './exitPolicy';

/** The floor rung. Reaching it on a pullback closes the whole position. */
export const RATCHET_FIRST_RUNG_PCT = 1.8;
/** The second rung. From here on the ladder steps by RATCHET_STEP_PCT. */
export const RATCHET_SECOND_RUNG_PCT = 3.0;
/** Spacing above the second rung. */
export const RATCHET_STEP_PCT = 1.0;
/** Fraction of the REMAINING position sold when a 3%+ rung is given back. */
export const RATCHET_PARTIAL_FRACTION = 0.30;
/** Guard against a corrupt peak price generating an unbounded ladder. */
const MAX_RUNGS = 400;

/** Rungs are compared by value after rounding, so a regenerated 3 always
 *  matches a persisted 3 despite floating-point arithmetic. */
const q = (n: number) => Math.round(n * 100) / 100;

/**
 * Every rung at or below `peakPnlPct`, ascending. An empty list means the
 * position has never been far enough into profit to arm the ratchet.
 */
export function rungsCrossed(peakPnlPct: number): number[] {
  if (!Number.isFinite(peakPnlPct) || peakPnlPct < RATCHET_FIRST_RUNG_PCT) return [];
  const out: number[] = [RATCHET_FIRST_RUNG_PCT];
  for (let i = 0; i < MAX_RUNGS; i++) {
    const rung = q(RATCHET_SECOND_RUNG_PCT + i * RATCHET_STEP_PCT);
    if (rung > peakPnlPct + 1e-9) break;
    out.push(rung);
  }
  return out;
}

export interface RatchetInput {
  entryPrice: number;
  /** Best price seen since entry — `highestPrice` for a long, `lowestPrice`
   *  for a short. Maintained per tick in server/simEngineFactory.ts. */
  peakPrice: number;
  livePrice: number;
  isLong: boolean;
  /** Rungs already paid out for this position. Persisted on the position. */
  consumed?: number[];
}

export type RatchetAction = 'HOLD' | 'PARTIAL' | 'FULL';

export interface RatchetDecision {
  action: RatchetAction;
  /** The rung that fired — the lowest one given back on this tick. */
  rung?: number;
  /** Fraction of the REMAINING quantity to sell (1 for a full exit). */
  fraction?: number;
  /** The consumed-rung set to persist after acting on this decision. */
  consumed: number[];
  /** Highest rung the peak has ever crossed — for logging and the UI. */
  peakRung?: number;
  /** Profit % at the peak and right now, for the exit reason string. */
  peakPnlPct: number;
  livePnlPct: number;
}

/**
 * Decide what the ratchet wants on this tick.
 *
 * A gap that falls through several armed rungs at once consumes all of them but
 * pays out ONCE — the move was a single event, and charging 30% per rung
 * crossed would liquidate most of a position on one bad candle. If the 1.8%
 * floor is among them the verdict is a full exit regardless, since that rung
 * subsumes every rung beneath it.
 */
export function evaluateRatchet(input: RatchetInput): RatchetDecision {
  const { entryPrice, peakPrice, livePrice, isLong } = input;
  const consumed = (input.consumed ?? []).map(q);

  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    return { action: 'HOLD', consumed, peakPnlPct: 0, livePnlPct: 0 };
  }

  const livePnlPct = positionPnlPercent(entryPrice, livePrice, isLong);
  // A peak below the live price means the tracker has not caught up yet (a
  // restored position, or the first tick after a fill) — the live price is
  // itself a peak, so take the better of the two rather than under-arming.
  const rawPeakPnl = Number.isFinite(peakPrice) && peakPrice > 0
    ? positionPnlPercent(entryPrice, peakPrice, isLong)
    : livePnlPct;
  const peakPnlPct = Math.max(rawPeakPnl, livePnlPct);

  const crossed = rungsCrossed(peakPnlPct);
  const base = {
    consumed,
    peakRung: crossed.length > 0 ? crossed[crossed.length - 1] : undefined,
    peakPnlPct,
    livePnlPct
  };
  if (crossed.length === 0) return { action: 'HOLD', ...base };

  // Armed = crossed, not yet paid out, and genuinely LEFT BEHIND: the peak has
  // to sit strictly above the rung, or simply touching it on the way up would
  // read as a retrace to it and sell immediately — the exact opposite of what
  // the ladder is for. Breached = price has since come back down to it.
  const breached = crossed.filter((r) =>
    !consumed.includes(r) && peakPnlPct > r + 1e-9 && livePnlPct <= r + 1e-9
  );
  if (breached.length === 0) return { action: 'HOLD', ...base };

  const lowest = breached[0];
  if (lowest === q(RATCHET_FIRST_RUNG_PCT)) {
    return { action: 'FULL', rung: lowest, fraction: 1, ...base, consumed: [...consumed, ...breached] };
  }
  return {
    action: 'PARTIAL',
    rung: lowest,
    fraction: RATCHET_PARTIAL_FRACTION,
    ...base,
    consumed: [...consumed, ...breached]
  };
}

/** The exit-reason string every bot writes into its trade log, so the CSV and
 *  the UI read identically across all four. */
export function ratchetReason(d: RatchetDecision): string {
  const rung = d.rung ?? 0;
  // A gap can carry price below the rung — and past zero — before the next
  // tick, so the live figure signs itself rather than assuming a profit.
  const signed = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
  const ctx = `(שיא ${signed(d.peakPnlPct)}, כעת ${signed(d.livePnlPct)})`;
  if (d.action === 'FULL') {
    return `סולם רווח: חזרה למדרגה ${rung}% ${ctx} — סגירה מלאה`;
  }
  return `סולם רווח: חזרה למדרגה ${rung}% ${ctx} — מימוש ${(RATCHET_PARTIAL_FRACTION * 100).toFixed(0)}%`;
}
