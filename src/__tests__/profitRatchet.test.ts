/**
 * Profit ratchet — giveback-of-peak model (rewritten 2026-09-16)
 * ============================================================================
 * The original fixed-rung ladder (1.8/3/4/5%… +1% forever, 30% of the
 * remainder per rung) was replaced after a live failure on BR: on a +69% move
 * it sold 83% of the position below +12%, at a weighted-average exit of
 * +8.82%, then kept emitting sub-cent "+$0.00" orders no exchange would
 * accept. Three defects: geometric decay made the WORST prices sell the most,
 * a gradual pullback was charged once per tick while a fast one was charged
 * once, and there was no minimum order size.
 *
 * The replacement is pinned here:
 *   · arm at +1.8% peak
 *   · sell 30% of the remainder on a giveback of 15% OF THE PEAK
 *   · re-arm only on a NEW peak (one pullback = one sale)
 *   · full close at BREAK-EVEN (replaces the old 1.8% floor)
 *   · full close ("free the slot") once the remainder is below
 *     RATCHET_MIN_REMAINING_FRACTION (25%) of the ORIGINAL entry quantity —
 *     replaced the old fixed $10 RATCHET_DUST_NOTIONAL_USD floor on 2026-09-17
 */
import { describe, it, expect } from 'vitest';
import {
  RATCHET_ARM_PCT,
  RATCHET_GIVEBACK_FRACTION,
  RATCHET_PARTIAL_FRACTION,
  RATCHET_MIN_REMAINING_FRACTION,
  evaluateRatchet,
  ratchetReason,
  ratchetLevels,
  type RatchetInput
} from '@cde/engine/analysis';

/** A long from 100. `peak`/`live` are given as PROFIT PERCENTAGES. */
function longAt(peakPct: number, livePct: number, over: Partial<RatchetInput> = {}): RatchetInput {
  return {
    entryPrice: 100,
    peakPrice: 100 * (1 + peakPct / 100),
    livePrice: 100 * (1 + livePct / 100),
    isLong: true,
    ...over
  };
}

describe('arming', () => {
  it('does nothing below the arm threshold — the stop loss owns the position', () => {
    const d = evaluateRatchet(longAt(1.5, 1.2));
    expect(d.action).toBe('HOLD');
    expect(d.armed).toBe(false);
  });

  it('arms exactly at +1.8% peak', () => {
    expect(evaluateRatchet(longAt(RATCHET_ARM_PCT, RATCHET_ARM_PCT)).armed).toBe(true);
  });

  it('a peak below the live price (restored position) still arms off the live price', () => {
    const d = evaluateRatchet({ entryPrice: 100, peakPrice: 0, livePrice: 105, isLong: true });
    expect(d.armed).toBe(true);
    expect(d.peakPnlPct).toBeCloseTo(5, 6);
  });
});

describe('the giveback trigger — a percentage of the move, not a fixed rung', () => {
  it('holds while profit is above the giveback line', () => {
    // peak 69 → trigger at 69 * 0.85 = 58.65
    expect(evaluateRatchet(longAt(69, 60)).action).toBe('HOLD');
  });

  it('sells 30% once profit gives back 15% of the peak', () => {
    const d = evaluateRatchet(longAt(69, 58));
    expect(d.action).toBe('PARTIAL');
    expect(d.fraction).toBe(RATCHET_PARTIAL_FRACTION);
  });

  it('scales with the size of the move — a small peak has a small giveback', () => {
    // peak 10 → trigger at 8.5
    expect(evaluateRatchet(longAt(10, 9)).action).toBe('HOLD');
    expect(evaluateRatchet(longAt(10, 8.4)).action).toBe('PARTIAL');
  });

  it('the BR case: one +10% peak pulling back to +8% is ONE sale, not three', () => {
    // The live log showed rungs 10, 9 and 8 firing at 12:06:37/:45/:53.
    const first = evaluateRatchet(longAt(10.02, 9.79));
    expect(first.action).toBe('HOLD'); // 9.79 is above the 8.52 trigger

    const atTrigger = evaluateRatchet(longAt(10.02, 8.5));
    expect(atTrigger.action).toBe('PARTIAL');

    // …and the next two ticks of the SAME pullback sell nothing, because no
    // new high was made.
    const carried = { peakPctAtLastPartial: atTrigger.peakPctAtLastPartial };
    expect(evaluateRatchet(longAt(10.02, 8.68, carried)).action).toBe('HOLD');
    expect(evaluateRatchet(longAt(10.02, 7.99, carried)).action).toBe('HOLD');
  });
});

describe('re-arm requires a new peak', () => {
  it('will not sell twice on the same peak', () => {
    const first = evaluateRatchet(longAt(20, 17));
    expect(first.action).toBe('PARTIAL');
    expect(first.peakPctAtLastPartial).toBeCloseTo(20, 6);

    const again = evaluateRatchet(longAt(20, 16, { peakPctAtLastPartial: first.peakPctAtLastPartial }));
    expect(again.action).toBe('HOLD');
  });

  it('sells again once a genuinely new high is made and given back', () => {
    const d = evaluateRatchet(longAt(30, 25, { peakPctAtLastPartial: 20 }));
    expect(d.action).toBe('PARTIAL');
    expect(d.peakPctAtLastPartial).toBeCloseTo(30, 6);
  });

  it('a new high that has NOT been given back yet still holds', () => {
    expect(evaluateRatchet(longAt(30, 29, { peakPctAtLastPartial: 20 })).action).toBe('HOLD');
  });
});

describe('the full close is break-even, not a rung', () => {
  it('closes everything when price returns to the entry', () => {
    const d = evaluateRatchet(longAt(45, 0));
    expect(d.action).toBe('FULL');
    expect(d.fraction).toBe(1);
    expect(d.fullReason).toBe('break-even');
  });

  it('closes on a gap BELOW the entry too', () => {
    expect(evaluateRatchet(longAt(45, -3)).fullReason).toBe('break-even');
  });

  it('does not close at +1.8% any more — the old floor is gone', () => {
    // Peak 45, live 1.8: under the old ladder this was a FULL close at the
    // 1.8% floor. Now it is a partial (45 × 0.85 = 38.25 giveback line).
    const d = evaluateRatchet(longAt(45, 1.8));
    expect(d.action).toBe('PARTIAL');
  });

  it('never fires before arming — an unarmed position at break-even is the stop loss\'s business', () => {
    expect(evaluateRatchet(longAt(1.0, 0)).action).toBe('HOLD');
  });
});

describe('free the slot — below RATCHET_MIN_REMAINING_FRACTION of the original quantity', () => {
  it('closes the remainder outright once it is below 25% of the original quantity', () => {
    const d = evaluateRatchet(longAt(50, 45, { remainingQuantityFraction: RATCHET_MIN_REMAINING_FRACTION - 0.01 }));
    expect(d.action).toBe('FULL');
    expect(d.fullReason).toBe('min-remaining');
  });

  it('leaves a healthy remainder alone', () => {
    const d = evaluateRatchet(longAt(50, 45, { remainingQuantityFraction: 0.5 }));
    expect(d.action).not.toBe('FULL');
  });

  it('skips the rule entirely when no fraction is supplied', () => {
    expect(evaluateRatchet(longAt(50, 49)).action).toBe('HOLD');
  });
});

describe('shorts mirror longs', () => {
  const shortAt = (peakPct: number, livePct: number, over: Partial<RatchetInput> = {}): RatchetInput => ({
    entryPrice: 100,
    peakPrice: 100 * (1 - peakPct / 100),
    livePrice: 100 * (1 - livePct / 100),
    isLong: false,
    ...over
  });

  it('sells 30% on the same giveback', () => {
    expect(evaluateRatchet(shortAt(20, 19)).action).toBe('HOLD');
    expect(evaluateRatchet(shortAt(20, 16)).action).toBe('PARTIAL');
  });

  it('closes at break-even', () => {
    expect(evaluateRatchet(shortAt(20, 0)).fullReason).toBe('break-even');
  });
});

describe('ratchetReason', () => {
  it('names the giveback on a partial', () => {
    const text = ratchetReason(evaluateRatchet(longAt(69, 58)));
    expect(text).toContain('15%');
    expect(text).toContain('30%');
  });

  it('distinguishes a break-even close from a min-remaining ("free the slot") close', () => {
    expect(ratchetReason(evaluateRatchet(longAt(45, 0)))).toContain('ברייק-אבן');
    expect(
      ratchetReason(evaluateRatchet(longAt(45, 40, { remainingQuantityFraction: 0.1 })))
    ).toContain('פינוי סלוט');
  });
});

describe('ratchetLevels — the price-space view the UI draws', () => {
  it('reports nothing armed below the arm threshold, and the arming price above', () => {
    const l = ratchetLevels(longAt(1.0, 1.0));
    expect(l.armedSellPrice).toBeNull();
    expect(l.breakEvenPrice).toBeNull();
    expect(l.nextRungPct).toBe(RATCHET_ARM_PCT);
  });

  it('reports the giveback price and the break-even price once armed', () => {
    const l = ratchetLevels(longAt(20, 19));
    // 20 × 0.85 = 17 → price 117
    expect(l.armedSellPrice).toBeCloseTo(117, 6);
    expect(l.breakEvenPrice).toBe(100);
    expect(l.nextRungPct).toBeCloseTo(20, 6);
  });

  it('after a partial with no new high, only the break-even line is live', () => {
    const l = ratchetLevels(longAt(20, 18, { peakPctAtLastPartial: 20 }));
    expect(l.armedSellPrice).toBeNull();
    expect(l.armedIsFullClose).toBe(true);
    expect(l.breakEvenPrice).toBe(100);
  });
});

describe('the scale-out curve is no longer inverted', () => {
  it('a +69% move that only retraces in steps sells far less than the old ladder did', () => {
    // Simulate the BR shape: price climbs, giving back just under the trigger
    // repeatedly, then one real pullback at the end.
    let peakPctAtLastPartial = 0;
    let remaining = 1;
    let sales = 0;
    for (let peak = 2; peak <= 69; peak += 1) {
      // A 5% retrace of the peak on the way up — below the 15% trigger.
      const d = evaluateRatchet(longAt(peak, peak * 0.95, { peakPctAtLastPartial }));
      if (d.action === 'PARTIAL') {
        sales++;
        remaining *= 1 - RATCHET_PARTIAL_FRACTION;
        peakPctAtLastPartial = d.peakPctAtLastPartial;
      }
    }
    // The old ladder fired 38 times on this move and ended with 0.0001% left.
    expect(sales).toBe(0);
    expect(remaining).toBe(1);
  });
});
