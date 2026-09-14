/**
 * Profit ratchet (2026-09-14)
 * ============================================================================
 * Rungs 1.8% → 3% → 4% → 5% → … Crossing one marks it and sells nothing;
 * coming back down to one sells 30% (or closes everything at the 1.8% floor)
 * and consumes it permanently.
 */

import { describe, it, expect } from 'vitest';
import {
  RATCHET_FIRST_RUNG_PCT, RATCHET_PARTIAL_FRACTION,
  rungsCrossed, evaluateRatchet, ratchetReason
} from '@cde/engine/analysis';

const ENTRY = 100;
/** Price for a given profit % on a long. */
const at = (pnlPct: number) => ENTRY * (1 + pnlPct / 100);

function longAt(peakPct: number, livePct: number, consumed: number[] = []) {
  return evaluateRatchet({
    entryPrice: ENTRY, peakPrice: at(peakPct), livePrice: at(livePct),
    isLong: true, consumed
  });
}

describe('rungsCrossed', () => {
  it('arms nothing below the first rung', () => {
    expect(rungsCrossed(0)).toEqual([]);
    expect(rungsCrossed(1.79)).toEqual([]);
    expect(rungsCrossed(-5)).toEqual([]);
  });

  it('steps 1.8 → 3 → 4 → 5, +1% thereafter', () => {
    expect(rungsCrossed(1.8)).toEqual([1.8]);
    expect(rungsCrossed(2.9)).toEqual([1.8]);
    expect(rungsCrossed(3)).toEqual([1.8, 3]);
    expect(rungsCrossed(4.2)).toEqual([1.8, 3, 4]);
    expect(rungsCrossed(7.9)).toEqual([1.8, 3, 4, 5, 6, 7]);
  });

  it('survives a nonsense peak without hanging', () => {
    expect(rungsCrossed(Number.NaN)).toEqual([]);
    expect(rungsCrossed(1e9).length).toBeLessThan(500);
  });
});

describe('evaluateRatchet — climbing', () => {
  it('holds all the way up: crossing a rung never sells', () => {
    for (const pct of [0.5, 1.8, 2.5, 3, 4, 4.2, 9]) {
      expect(longAt(pct, pct).action).toBe('HOLD');
    }
  });

  it('reports the highest rung the peak has crossed', () => {
    expect(longAt(4.2, 4.2).peakRung).toBe(4);
    expect(longAt(2.5, 2.5).peakRung).toBe(1.8);
    expect(longAt(1.0, 1.0).peakRung).toBeUndefined();
  });

  it('does nothing below +1.8% — the stop loss still owns that range', () => {
    expect(longAt(1.5, -2).action).toBe('HOLD');
    expect(longAt(1.79, 0).action).toBe('HOLD');
  });
});

describe('evaluateRatchet — the operator\'s worked example', () => {
  // "הגיע לרווח של 4.2" — peak +4.2%, rungs 1.8/3/4 crossed.
  it('peak 4.2%: holding at 4.1 does nothing, falling to 4.0 sells 30%', () => {
    expect(longAt(4.2, 4.1).action).toBe('HOLD');

    const hit = longAt(4.2, 4.0);
    expect(hit.action).toBe('PARTIAL');
    expect(hit.rung).toBe(4);
    expect(hit.fraction).toBeCloseTo(RATCHET_PARTIAL_FRACTION, 6);
    expect(hit.consumed).toContain(4);
  });

  it('the full retrace sequence pays out 30% / 30% / everything', () => {
    let consumed: number[] = [];

    const r4 = longAt(4.2, 4.0, consumed);
    expect([r4.action, r4.rung]).toEqual(['PARTIAL', 4]);
    consumed = r4.consumed;

    const r3 = longAt(4.2, 3.0, consumed);
    expect([r3.action, r3.rung]).toEqual(['PARTIAL', 3]);
    consumed = r3.consumed;

    const r18 = longAt(4.2, 1.8, consumed);
    expect([r18.action, r18.rung, r18.fraction]).toEqual(['FULL', 1.8, 1]);
  });
});

describe('evaluateRatchet — a consumed rung never fires twice', () => {
  it('oscillating around a consumed rung sells nothing more', () => {
    const consumed = longAt(4.2, 4.0).consumed;
    for (const live of [4.02, 3.97, 4.0, 3.99]) {
      expect(longAt(4.2, live, consumed).action).toBe('HOLD');
    }
  });

  it('but a fresh high arms a NEW rung above the consumed one', () => {
    const consumed = longAt(4.2, 4.0).consumed; // 4 consumed
    expect(longAt(5.4, 5.3, consumed).action).toBe('HOLD');
    const r5 = longAt(5.4, 5.0, consumed);
    expect([r5.action, r5.rung]).toEqual(['PARTIAL', 5]);
  });

  it('consuming 4 does not retire the 3 rung beneath it', () => {
    const consumed = longAt(4.2, 4.0).consumed;
    expect(longAt(4.2, 3.0, consumed).rung).toBe(3);
  });
});

describe('evaluateRatchet — the 1.8% floor', () => {
  it('closes everything, never 30%', () => {
    const d = longAt(2.5, 1.8);
    expect(d.action).toBe('FULL');
    expect(d.fraction).toBe(1);
  });

  it('a position that once touched +1.8% is not allowed to turn red', () => {
    // Gapped straight through the floor: still a full exit, at the live price.
    const d = longAt(2.5, -1.0);
    expect(d.action).toBe('FULL');
    expect(d.rung).toBe(RATCHET_FIRST_RUNG_PCT);
  });

  it('a gap through several rungs pays out ONCE and consumes them all', () => {
    const d = longAt(5.5, 3.4); // breaches 5 and 4, but not 3
    expect(d.action).toBe('PARTIAL');
    expect(d.rung).toBe(4);
    expect(d.consumed).toEqual(expect.arrayContaining([4, 5]));
    expect(d.consumed).not.toContain(3);
  });

  it('a gap that reaches the floor is a full exit, whatever else it breached', () => {
    const d = longAt(6.5, 1.0);
    expect(d.action).toBe('FULL');
    expect(d.fraction).toBe(1);
  });
});

describe('evaluateRatchet — shorts', () => {
  const shortAt = (peakPct: number, livePct: number, consumed: number[] = []) =>
    evaluateRatchet({
      entryPrice: ENTRY,
      peakPrice: ENTRY * (1 - peakPct / 100),
      livePrice: ENTRY * (1 - livePct / 100),
      isLong: false,
      consumed
    });

  it('measures profit downward and fires the same way', () => {
    expect(shortAt(4.2, 4.1).action).toBe('HOLD');
    const d = shortAt(4.2, 4.0);
    expect([d.action, d.rung]).toEqual(['PARTIAL', 4]);
    expect(shortAt(2.5, 1.8).action).toBe('FULL');
  });
});

describe('evaluateRatchet — defensive', () => {
  it('a stale peak below the live price still arms from the live price', () => {
    const d = evaluateRatchet({
      entryPrice: ENTRY, peakPrice: ENTRY, livePrice: at(4.2), isLong: true
    });
    expect(d.peakRung).toBe(4);
    expect(d.action).toBe('HOLD');
  });

  it('a broken entry price holds rather than throwing', () => {
    const d = evaluateRatchet({ entryPrice: 0, peakPrice: 1, livePrice: 1, isLong: true });
    expect(d.action).toBe('HOLD');
  });

  it('tolerates a consumed list carrying float noise', () => {
    expect(longAt(4.2, 4.0, [4.000000001]).action).toBe('HOLD');
  });
});

describe('ratchetReason', () => {
  it('names the rung, the peak and the current profit', () => {
    const full = ratchetReason(longAt(2.5, 1.8));
    expect(full).toContain('1.8%');
    expect(full).toContain('סגירה מלאה');

    const partial = ratchetReason(longAt(4.2, 4.0));
    expect(partial).toContain('4%');
    expect(partial).toContain('30%');
  });
});

// ── ratchetLevels — price-space view for the position chart (2026-09-14) ────

import { ratchetLevels } from '@cde/engine/analysis';

describe('ratchetLevels — replaces the misleading static "TP" chart line', () => {
  it('below the first rung: nothing armed, next rung is the 1.8% floor', () => {
    const lv = ratchetLevels({ entryPrice: ENTRY, peakPrice: at(1.0), livePrice: at(1.0), isLong: true });
    expect(lv.armedSellPrice).toBeNull();
    expect(lv.nextRungPct).toBe(RATCHET_FIRST_RUNG_PCT);
    expect(lv.nextRungPrice).toBeCloseTo(at(RATCHET_FIRST_RUNG_PCT), 6);
  });

  it('peak just touched a rung (not yet retraced): armed is still null', () => {
    // Mirrors evaluateRatchet: touching a rung on the way up is not "armed"
    // for a sell — only a peak STRICTLY above it is.
    const lv = ratchetLevels({ entryPrice: ENTRY, peakPrice: at(1.8), livePrice: at(1.8), isLong: true });
    expect(lv.armedSellPrice).toBeNull();
  });

  it('peak +2.5%: the 1.8% floor is armed (a full close), next rung is 3%', () => {
    const lv = ratchetLevels({ entryPrice: ENTRY, peakPrice: at(2.5), livePrice: at(2.5), isLong: true });
    expect(lv.armedSellPrice).toBeCloseTo(at(1.8), 6);
    expect(lv.armedIsFullClose).toBe(true);
    expect(lv.nextRungPct).toBe(3);
    expect(lv.nextRungPrice).toBeCloseTo(at(3), 6);
  });

  it('peak +4.2%: the lowest ARMED rung is 4% (a partial), next rung is 5%', () => {
    const lv = ratchetLevels({ entryPrice: ENTRY, peakPrice: at(4.2), livePrice: at(4.0), isLong: true });
    expect(lv.armedSellPrice).toBeCloseTo(at(4), 6);
    expect(lv.armedIsFullClose).toBe(false);
    expect(lv.nextRungPct).toBe(5);
  });

  it('a consumed rung is skipped — the NEXT lower armed rung becomes the trigger', () => {
    const lv = ratchetLevels({ entryPrice: ENTRY, peakPrice: at(4.2), livePrice: at(3.5), isLong: true, consumed: [4] });
    expect(lv.armedSellPrice).toBeCloseTo(at(3), 6);
    expect(lv.armedIsFullClose).toBe(false);
  });

  it('every rung consumed: nothing left armed, even with a high peak', () => {
    const lv = ratchetLevels({ entryPrice: ENTRY, peakPrice: at(4.2), livePrice: at(4.0), isLong: true, consumed: [1.8, 3, 4] });
    expect(lv.armedSellPrice).toBeNull();
  });

  it('mirrors evaluateRatchet\'s own armed set on the operator\'s worked example', () => {
    const input = { entryPrice: ENTRY, peakPrice: at(4.2), livePrice: at(4.0), isLong: true };
    const decision = evaluateRatchet(input);
    const lv = ratchetLevels(input);
    expect(decision.action).toBe('PARTIAL');
    expect(lv.armedSellPrice).toBeCloseTo(at(decision.rung!), 6);
  });

  it('shorts: measures the same way, downward', () => {
    const lv = ratchetLevels({
      entryPrice: ENTRY, peakPrice: ENTRY * (1 - 4.2 / 100), livePrice: ENTRY * (1 - 4.0 / 100), isLong: false
    });
    expect(lv.armedSellPrice).toBeCloseTo(ENTRY * (1 - 4 / 100), 6);
  });

  it('a broken entry price does not throw', () => {
    const lv = ratchetLevels({ entryPrice: 0, peakPrice: 1, livePrice: 1, isLong: true });
    expect(lv.armedSellPrice).toBeNull();
    expect(Number.isFinite(lv.nextRungPrice)).toBe(true);
  });
});
