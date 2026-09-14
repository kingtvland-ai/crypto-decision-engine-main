/**
 * The noise floor under the fixed scalp ladder (2026-09-14)
 * ============================================================================
 * A stop placed inside one bar's ordinary range is not a risk limit — it is a
 * coin flip on noise. These tests pin the three outcomes:
 *
 *   quiet symbol   → flat 2.3%, untouched
 *   volatile one   → stop widens past the bad bar
 *   extreme one    → refused outright, because even 4.2% is inside the noise
 *
 * and the gating: with `noiseFloorStop` off, every one of them is the old flat
 * ladder, so the operator's 2026-09-11 decision is preserved exactly.
 *
 * The percentile half of the floor exists because ATR is a MEAN and bar ranges
 * are fat-tailed. Live 5M data (2026-09-14) put p90/ATR at 1.70-1.92 across
 * BTC, ETH, SOL, DOGE and FLOCK alike — so a pure `1.6 × ATR` floor lands just
 * under the bad bar on every symbol, which is the wrong side of it.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveLadderPercents,
  noiseFloorStopPct,
  detectVolatilityExpansion,
  effectiveAtrPercent,
  atrPercentOf,
  badBarPercent,
  measureStopNoise,
  MIN_STOP_ATR_MULT,
  VOLATILITY_EXPANSION_RATIO,
  FIXED_SL_PCT,
  FIXED_TP1_PCT,
  FIXED_TP2_PCT,
  SURGE_MAX_SL_PCT,
  TP2_MIN_REWARD_RISK
} from '@cde/engine/analysis';
import type { Candle } from '@cde/engine';

describe('noiseFloorStopPct', () => {
  it('takes 1.6 × ATR when the tail is unremarkable', () => {
    expect(noiseFloorStopPct(1, 1.0)).toBeCloseTo(MIN_STOP_ATR_MULT, 6);
    expect(noiseFloorStopPct(2, 2.0)).toBeCloseTo(3.2, 6);
  });

  it('takes the bad bar when the tail is fat — the FLOCK shape', () => {
    // ATR 1.42% → 1.6× = 2.27%, barely different from the flat 2.3% it replaces.
    // The 90th-percentile bar was 2.74%, and that is what actually stops you out.
    expect(noiseFloorStopPct(1.42, 2.74)).toBeCloseTo(2.74, 6);
  });

  it('reads unknown volatility as no floor, so the flat ladder stands', () => {
    expect(noiseFloorStopPct(undefined)).toBe(0);
    expect(noiseFloorStopPct(0, 0)).toBe(0);
    expect(noiseFloorStopPct(NaN, NaN)).toBe(0);
    expect(noiseFloorStopPct(-1, -1)).toBe(0);
  });
});

describe('resolveLadderPercents — noise floor', () => {
  it('a quiet symbol keeps the flat 2.3%: BTC needs 0.30%', () => {
    const l = resolveLadderPercents({ noiseFloorPct: 0.30 });
    expect(l.slPct).toBeCloseTo(FIXED_SL_PCT, 6);
    expect(l.noiseWidened).toBe(false);
    expect(l.tooVolatile).toBe(false);
    expect(l.tp2Pct).toBeCloseTo(FIXED_TP2_PCT, 6);
  });

  it('the FLOCK case: a 2.74% bad bar widens the 2.3% stop past it', () => {
    const l = resolveLadderPercents({ noiseFloorPct: 2.74 });
    expect(l.slPct).toBeCloseTo(2.74, 6);
    expect(l.noiseWidened).toBe(true);
    expect(l.surged).toBe(false);
    expect(l.tooVolatile).toBe(false);
  });

  it('TP1 stays 1.8% when the noise floor widens the stop — that is the strategy', () => {
    const l = resolveLadderPercents({ noiseFloorPct: 3.2 });
    expect(l.tp1Pct).toBeCloseTo(FIXED_TP1_PCT, 6);
    // TP2 scales with the widened stop so the R:R gate stays satisfiable.
    expect(l.tp2Pct).toBeGreaterThanOrEqual(l.slPct * TP2_MIN_REWARD_RISK - 1e-9);
  });

  it('refuses the trade when even the 4.2% ceiling sits inside one bar', () => {
    const l = resolveLadderPercents({ noiseFloorPct: 4.8 });
    expect(l.tooVolatile).toBe(true);
    expect(l.slPct).toBeCloseTo(SURGE_MAX_SL_PCT, 6);
  });

  it('the ceiling is the boundary, not an off-by-one', () => {
    expect(resolveLadderPercents({ noiseFloorPct: SURGE_MAX_SL_PCT }).tooVolatile).toBe(false);
    expect(resolveLadderPercents({ noiseFloorPct: SURGE_MAX_SL_PCT + 0.01 }).tooVolatile).toBe(true);
  });

  it('surge and noise floor both widen, and the WIDER of the two wins', () => {
    const l = resolveLadderPercents({ dynamicSlPct: 2.5, buyingSurge: true, noiseFloorPct: 3.2 });
    expect(l.slPct).toBeCloseTo(3.2, 6);
    expect(l.surged).toBe(true);
    expect(l.noiseWidened).toBe(true);
  });

  it('a surge stop already past the floor is left alone', () => {
    const l = resolveLadderPercents({ dynamicSlPct: 4.0, buyingSurge: true, noiseFloorPct: 1.6 });
    expect(l.slPct).toBeCloseTo(4.0, 6);
    expect(l.noiseWidened).toBe(false);
  });

  it('omitting the floor reproduces the pre-2026-09-14 ladder exactly', () => {
    for (const dyn of [0.4, 1.5, 2.3, 3.9, 12]) {
      const l = resolveLadderPercents({ dynamicSlPct: dyn });
      expect(l.slPct).toBeCloseTo(FIXED_SL_PCT, 6);
      expect(l.noiseWidened).toBe(false);
      expect(l.tooVolatile).toBe(false);
    }
  });
});

// ── measuring the tape ───────────────────────────────────────────────────────

/** `n` bars of `rangePct` width, with the last `spikeBars` widened to `spikePct`. */
function bars(n: number, rangePct: number, spikeBars = 0, spikePct = 0): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const isSpike = spikeBars > 0 && i >= n - spikeBars;
    const width = isSpike ? spikePct : rangePct;
    out.push({
      timestamp: i * 300_000,
      open: 100,
      high: 100 + width / 2,
      low: 100 - width / 2,
      close: 100,
      volume: 1000
    });
  }
  return out;
}

/** A fat-tailed tape: mostly quiet, with `fatCount` scattered wide bars. */
function fatTailed(n: number, quietPct: number, fatCount: number, fatPct: number): Candle[] {
  const out = bars(n, quietPct);
  for (let k = 0; k < fatCount; k++) {
    const i = Math.floor((k + 0.5) * (n / fatCount));
    out[i] = { ...out[i], high: 100 + fatPct / 2, low: 100 - fatPct / 2 };
  }
  return out;
}

describe('badBarPercent', () => {
  it('reports the tail, not the mean — that is the whole point', () => {
    // 40 bars: 36 at 1%, 4 at 6%. The mean is ~1.5%; p90 must see the 6% bars.
    const tape = fatTailed(40, 1.0, 4, 6.0);
    const atr = atrPercentOf(tape);
    const bad = badBarPercent(tape);
    expect(bad).toBeGreaterThan(atr * 1.6);
    expect(bad).toBeGreaterThan(3);
  });

  it('agrees with 1.6 × ATR on an evenly-shaped tape', () => {
    const tape = bars(60, 1.0);
    expect(badBarPercent(tape)).toBeCloseTo(1.0, 1);
  });

  it('is 0 when there is nothing to measure', () => {
    expect(badBarPercent([])).toBe(0);
    expect(badBarPercent(undefined)).toBe(0);
  });
});

describe('detectVolatilityExpansion', () => {
  it('a steady tape reads ratio ~1 and does not flag', () => {
    const e = detectVolatilityExpansion(bars(40, 1.0));
    expect(e.ratio).toBeCloseTo(1.0, 1);
    expect(e.expanding).toBe(false);
  });

  it('flags the cascade shape: three 3% bars after twenty 1% ones', () => {
    // This is the case ATR(14) cannot see — the average is still calm.
    const e = detectVolatilityExpansion(bars(40, 1.0, 3, 3.0));
    expect(e.ratio).toBeGreaterThanOrEqual(VOLATILITY_EXPANSION_RATIO);
    expect(e.expanding).toBe(true);
    expect(e.fastAtrPercent).toBeGreaterThan(e.slowAtrPercent);
  });

  it('too little history is not evidence of a cascade', () => {
    expect(detectVolatilityExpansion(bars(5, 1.0)).expanding).toBe(false);
    expect(detectVolatilityExpansion([]).expanding).toBe(false);
    expect(detectVolatilityExpansion(undefined).expanding).toBe(false);
  });
});

describe('effectiveAtrPercent', () => {
  it('a steady tape is its own ATR', () => {
    const steady = detectVolatilityExpansion(bars(40, 1.0));
    expect(effectiveAtrPercent(1.0, steady)).toBeCloseTo(1.0, 6);
  });

  it('an expanding tape raises the reading to the fresh bars', () => {
    const expansion = detectVolatilityExpansion(bars(40, 1.0, 3, 3.0));
    expect(effectiveAtrPercent(1.2, expansion)).toBeGreaterThan(2.5);
  });

  it('never lowers the reading below the steady one', () => {
    const expansion = detectVolatilityExpansion(bars(40, 1.0, 3, 3.0));
    expect(effectiveAtrPercent(5.0, expansion)).toBeCloseTo(5.0, 6);
  });
});

describe('measureStopNoise', () => {
  it('a quiet major stays far under the flat 2.3% and changes nothing', () => {
    const noise = measureStopNoise(bars(60, 0.2));
    expect(noise.floorPct).toBeLessThan(FIXED_SL_PCT);
    expect(resolveLadderPercents({ noiseFloorPct: noise.floorPct }).slPct).toBeCloseTo(FIXED_SL_PCT, 6);
  });

  it('a fat-tailed micro-cap widens the stop past the flat 2.3%', () => {
    const noise = measureStopNoise(fatTailed(60, 1.0, 8, 4.0));
    expect(noise.floorPct).toBeGreaterThan(FIXED_SL_PCT);
    expect(noise.badBarPercent).toBeGreaterThan(noise.atrPercent);
    expect(resolveLadderPercents({ noiseFloorPct: noise.floorPct }).noiseWidened).toBe(true);
  });

  it('a cascading tape can push the floor past the ceiling and refuse the trade', () => {
    const noise = measureStopNoise(bars(40, 1.0, 3, 9.0));
    expect(noise.expansion.expanding).toBe(true);
    expect(resolveLadderPercents({ noiseFloorPct: noise.floorPct }).tooVolatile).toBe(true);
  });

  it('an unmeasurable series yields no floor at all', () => {
    expect(measureStopNoise(undefined).floorPct).toBe(0);
    expect(measureStopNoise([]).floorPct).toBe(0);
  });
});
