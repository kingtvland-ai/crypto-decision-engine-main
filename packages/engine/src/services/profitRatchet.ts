/**
 * Profit ratchet — the only profit-taking mechanism in the four sim bots.
 * ============================================================================
 * Operator decision 2026-09-14, replacing the fixed TP1/TP2 ladder and every
 * bot's own trailing stop. The complaint it answers: the bots kept giving back
 * open profit and closing red in a market that was going up.
 *
 * REWRITTEN 2026-09-16 after a live failure on BR. The original design was a
 * ladder of fixed rungs (1.8%, 3%, 4%, 5%, … +1% forever) that sold 30% of the
 * REMAINDER every time price fell back to an unconsumed rung. Measured on the
 * actual trade log, on a move that ran +69% in two hours:
 *
 *     sale  rung   % of original sold   cumulative   remaining
 *       1    3%          30.0%             30%         70%
 *       2   10%          21.0%             51%         49%
 *       3    9%          14.7%             66%         34%
 *       4    8%          10.3%             76%         24%
 *       5   11%           7.2%             83%         16.8%
 *      38   69%           0.0%            100%          0.0001%
 *
 * 83% of the position was sold below +12% of a +69% move; the weighted average
 * exit was +8.82%. Three separate defects produced that:
 *
 *   1. GEOMETRIC DECAY INVERTED THE LADDER. Selling 30% of what is left means
 *      the EARLIEST (lowest, worst) rungs sell the most. The ladder sold hardest
 *      at the worst prices, by construction.
 *   2. TICK TIMING SET THE PRICE. A fall through several rungs inside ONE tick
 *      consumed them all and paid once — but a gradual decline picked off one
 *      rung per tick. The same $-move cost 3x more purely because it took three
 *      ticks (12:06:37 / :45 / :53 on BR — one pullback from +10% to +8%, three
 *      separate 30% sales in sixteen seconds).
 *   3. NO MINIMUM ORDER SIZE. After ~15 sales the remainder was dust, and the
 *      ladder kept emitting sub-cent orders that no exchange would accept —
 *      the "+$0.00" rows in the log — each still paying a fee.
 *
 * The replacement, per the operator's decision:
 *
 *   · ARM at +RATCHET_ARM_PCT of peak profit, as before. Below that the stop
 *     loss governs the position and this module does nothing.
 *   · SELL RATCHET_PARTIAL_FRACTION of the remainder when profit gives back
 *     RATCHET_GIVEBACK_FRACTION **of the peak profit** — a percentage of the
 *     move, not a fixed rung. The trigger scales itself: a symbol that ran
 *     +69% has to give back ~10 points, one that ran +3% gives back ~0.45.
 *     Normal noise on a volatile micro-cap no longer reads as a reversal.
 *   · RE-ARM ONLY ON A NEW PEAK. After a partial, nothing else sells until the
 *     peak makes a genuinely new high. One pullback = one sale, however many
 *     ticks it takes. This is what removes the tick-timing dependency.
 *   · THE FULL CLOSE IS BREAK-EVEN, not a rung. Once armed, the whole remainder
 *     closes if price returns to the ENTRY price. This REPLACES the old 1.8%
 *     floor: a position that has seen profit still never closes red, but it now
 *     has the room to survive a deep pullback and catch the continuation, which
 *     the 1.8% floor made impossible.
 *   · THE SLOT IS FREED, NOT NIBBLED FOREVER. Once the remainder falls below
 *     RATCHET_MIN_REMAINING_FRACTION (25%) of the ORIGINAL entry quantity, the
 *     position is closed outright rather than sold down in 30%-of-remainder
 *     slices indefinitely. (Replaced RATCHET_DUST_NOTIONAL_USD, a flat $10
 *     floor, on 2026-09-17 — a percentage scales with account/position size
 *     the way a flat dollar amount never did.)
 *
 * This module is pure — no prices fetched, no orders built. Each bot's order
 * generator calls `evaluateRatchet` and translates the verdict into its own
 * order shape.
 */

import { positionPnlPercent } from './exitPolicy';

/** Peak profit that arms the ratchet. Below this the position is governed by
 *  the stop loss alone, exactly as before. */
export const RATCHET_ARM_PCT = 1.8;

/** Share of the PEAK PROFIT that must be given back to trigger a partial.
 *  0.15 = a peak of +69% sells at +58.65%, a peak of +10% sells at +8.5%.
 *  Replaces the old fixed +1% rung spacing, which was far tighter than the
 *  ordinary noise of the symbols these bots actually trade. */
export const RATCHET_GIVEBACK_FRACTION = 0.15;

/** Fraction of the REMAINING position sold when the giveback triggers. */
export const RATCHET_PARTIAL_FRACTION = 0.30;

/** Below this fraction of the ORIGINAL entry quantity, the position is closed
 *  outright to free the slot instead of being sold down further in 30%
 *  slices. Operator decision 2026-09-17, replacing the old fixed
 *  RATCHET_DUST_NOTIONAL_USD ($10) floor — a percentage of the position
 *  scales with account size the way a flat dollar amount never did (a $10,000
 *  position had no business shrinking all the way to $10 before the slot was
 *  freed). Measured in QUANTITY, not current dollar value: the ratchet's own
 *  30% partials are quantity fractions, and a $-value comparison would move
 *  around with price on top of the sales themselves. */
export const RATCHET_MIN_REMAINING_FRACTION = 0.25;

export interface RatchetInput {
  entryPrice: number;
  /** Best price seen since entry — `highestPrice` for a long, `lowestPrice`
   *  for a short. Maintained per tick in server/simEngineFactory.ts, and
   *  widened to the true bar extremes by marketValuations.ts. */
  peakPrice: number;
  livePrice: number;
  isLong: boolean;
  /** Peak profit %, as it stood when this position last took a partial.
   *  The next partial requires the peak to exceed it — that is the "new high
   *  required" rule. Absent on a position that has never partialed (and on
   *  positions restored from state written before this rewrite, which simply
   *  means their first partial under the new rules can fire immediately). */
  peakPctAtLastPartial?: number;
  /** Remaining quantity / quantity at entry — for the "free the slot" rule
   *  (RATCHET_MIN_REMAINING_FRACTION). Omit to skip that rule (e.g. a caller
   *  with no `initialQuantity` on record for a position restored from old
   *  state). */
  remainingQuantityFraction?: number;
}

export type RatchetAction = 'HOLD' | 'PARTIAL' | 'FULL';

/** Why a FULL close fired — the two are very different events and the trade
 *  log should not conflate them. */
export type RatchetFullReason = 'break-even' | 'min-remaining';

export interface RatchetDecision {
  action: RatchetAction;
  /** Fraction of the REMAINING quantity to sell (1 for a full exit). */
  fraction?: number;
  /** The peak has cleared RATCHET_ARM_PCT, so this module — not the stop
   *  loss — is what governs the position's profit side. The time stops read
   *  this to decide whether to leave a running position alone. */
  armed: boolean;
  /** Persist this onto the remainder when a PARTIAL fills; it is what the
   *  "new high required" rule compares against next time. */
  peakPctAtLastPartial: number;
  fullReason?: RatchetFullReason;
  /** Profit % at the peak and right now, for the exit reason string. */
  peakPnlPct: number;
  livePnlPct: number;
}

/**
 * Decide what the ratchet wants on this tick.
 *
 * Order of precedence: break-even close, then dust close, then the giveback
 * partial. The two full closes come first because either one makes the partial
 * moot — there is no point selling 30% of a position that is about to close.
 */
export function evaluateRatchet(input: RatchetInput): RatchetDecision {
  const { entryPrice, peakPrice, livePrice, isLong } = input;

  const idle = (peakPnlPct = 0, livePnlPct = 0): RatchetDecision => ({
    action: 'HOLD',
    armed: false,
    peakPctAtLastPartial: input.peakPctAtLastPartial ?? 0,
    peakPnlPct,
    livePnlPct
  });

  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return idle();

  const livePnlPct = positionPnlPercent(entryPrice, livePrice, isLong);
  // A peak below the live price means the tracker has not caught up yet (a
  // restored position, or the first tick after a fill) — the live price is
  // itself a peak, so take the better of the two rather than under-arming.
  const rawPeakPnl = Number.isFinite(peakPrice) && peakPrice > 0
    ? positionPnlPercent(entryPrice, peakPrice, isLong)
    : livePnlPct;
  const peakPnlPct = Math.max(rawPeakPnl, livePnlPct);

  const armed = peakPnlPct >= RATCHET_ARM_PCT - 1e-9;
  const lastPartialPeak = input.peakPctAtLastPartial ?? 0;
  const base = {
    armed,
    peakPctAtLastPartial: lastPartialPeak,
    peakPnlPct,
    livePnlPct
  };

  if (!armed) return { action: 'HOLD', ...base };

  // Break-even: replaces the old 1.8% floor. A position that has been in
  // profit does not close red, but it is allowed to give the profit back in
  // exchange for the room to survive a pullback and catch the continuation.
  if (livePnlPct <= 0) {
    return { action: 'FULL', fraction: 1, fullReason: 'break-even', ...base };
  }

  // Free the slot: what is left is a small enough sliver of the ORIGINAL
  // position that further 30%-of-the-remainder partials would just nibble at
  // it indefinitely. Close it outright instead of holding the slot open.
  if (
    typeof input.remainingQuantityFraction === 'number' &&
    input.remainingQuantityFraction < RATCHET_MIN_REMAINING_FRACTION
  ) {
    return { action: 'FULL', fraction: 1, fullReason: 'min-remaining', ...base };
  }

  // A new high is required before the ratchet can sell again — this is what
  // makes one pullback cost one sale regardless of how many ticks it spans.
  if (peakPnlPct <= lastPartialPeak + 1e-9) return { action: 'HOLD', ...base };

  const triggerPct = peakPnlPct * (1 - RATCHET_GIVEBACK_FRACTION);
  if (livePnlPct > triggerPct + 1e-9) return { action: 'HOLD', ...base };

  return {
    action: 'PARTIAL',
    fraction: RATCHET_PARTIAL_FRACTION,
    ...base,
    peakPctAtLastPartial: peakPnlPct
  };
}

/** The exit-reason string every bot writes into its trade log, so the CSV and
 *  the UI read identically across all four. */
export function ratchetReason(d: RatchetDecision): string {
  const signed = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
  const ctx = `(שיא ${signed(d.peakPnlPct)}, כעת ${signed(d.livePnlPct)})`;
  if (d.action === 'FULL') {
    return d.fullReason === 'min-remaining'
      ? `סולם רווח: נותרו פחות מ-${(RATCHET_MIN_REMAINING_FRACTION * 100).toFixed(0)}% מהכמות המקורית ${ctx} — סגירה מלאה לפינוי סלוט`
      : `סולם רווח: חזרה למחיר הכניסה ${ctx} — סגירה מלאה בברייק-אבן`;
  }
  const giveback = (RATCHET_GIVEBACK_FRACTION * 100).toFixed(0);
  return `סולם רווח: החזרת ${giveback}% מהשיא ${ctx} — מימוש ${(RATCHET_PARTIAL_FRACTION * 100).toFixed(0)}%`;
}

export interface RatchetLevels {
  /** Price that would sell 30% right now if it were reached — the
   *  giveback trigger for the CURRENT peak. `null` until the ratchet arms, in
   *  which case the stop loss is what governs the position, not this. */
  armedSellPrice: number | null;
  /** The price at which the whole remainder closes: the entry price, once
   *  armed. `null` before arming. */
  breakEvenPrice: number | null;
  /** Kept for the position cards: true when the next thing to trigger is the
   *  full close rather than a partial (i.e. the break-even line sits above
   *  the giveback line, which happens on a peak barely above the arm point). */
  armedIsFullClose: boolean;
  /** The price the PEAK must exceed for the ratchet to be able to sell again
   *  (a new high, per the re-arm rule) — or the arming price when it has not
   *  armed yet. Always defined. */
  nextRungPrice: number;
  nextRungPct: number;
}

/**
 * Price-space view of the ladder for a chart or a position card — the UI
 * layer that used to draw a static "TP" line at `takeProfit1` even though the
 * ratchet, not that price, decides when the position actually sells.
 */
export function ratchetLevels(input: RatchetInput): RatchetLevels {
  const { entryPrice, isLong } = input;

  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    return {
      armedSellPrice: null,
      breakEvenPrice: null,
      armedIsFullClose: false,
      nextRungPrice: entryPrice,
      nextRungPct: RATCHET_ARM_PCT
    };
  }

  const s = isLong ? 1 : -1;
  const priceAt = (pct: number) => entryPrice * (1 + s * pct / 100);

  // Single source of truth: the real decision function decides what is armed.
  const decision = evaluateRatchet(input);
  const { peakPnlPct, armed } = decision;

  if (!armed) {
    return {
      armedSellPrice: null,
      breakEvenPrice: null,
      armedIsFullClose: false,
      nextRungPrice: priceAt(RATCHET_ARM_PCT),
      nextRungPct: RATCHET_ARM_PCT
    };
  }

  const lastPartialPeak = input.peakPctAtLastPartial ?? 0;
  const triggerPct = peakPnlPct * (1 - RATCHET_GIVEBACK_FRACTION);
  // No new high since the last partial → nothing can sell partially; the
  // break-even line is the only live trigger.
  const canPartial = peakPnlPct > lastPartialPeak + 1e-9;

  return {
    armedSellPrice: canPartial ? priceAt(triggerPct) : null,
    breakEvenPrice: entryPrice,
    armedIsFullClose: !canPartial || triggerPct <= 0,
    // A new peak is what re-arms the partial, so the next level that matters
    // upward is the current peak itself.
    nextRungPrice: priceAt(peakPnlPct),
    nextRungPct: peakPnlPct
  };
}
