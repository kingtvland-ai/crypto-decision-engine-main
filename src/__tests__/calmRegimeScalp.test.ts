/**
 * Fixed scalp ladder — SL 2.3% / TP1 1.8% / TP2 3.5% (2026-09-11)
 * ============================================================================
 * Operator decision: trade a FIXED, tighter ladder in every sim bot, ALWAYS —
 * profit from small moves instead of chasing. The single exception is a BUYING
 * SURGE (relVolume >= 2 on the entry timeframe AND a green bar): only then does
 * the stop widen back to the bot's own dynamic value, clamped to [2.3%, 4.2%],
 * because a flat 2.3% sits inside the noise of such a move. TP1 stays 1.8%
 * unconditionally — that is the point of the strategy.
 *
 * TP1/SL = 1.8/2.3 = 0.78 is BELOW every bot's minRewardRisk gate (1.2) on
 * purpose — TP1 is a fast 50% partial, not the whole thesis. The R:R gate is
 * re-pointed at TP2 (3.5/2.3 = 1.52, clears 1.2), and TP2 scales with the stop
 * in the surge branch (max(3.5%, 1.2 × SL)) so the gate stays satisfiable.
 *
 * Every bot defaults the flag OFF (`calmRegimeScalp` unset) — the live bot and
 * every OTHER test in the suite never set it, so this is purely additive.
 */

import { describe, it, expect } from 'vitest';
import {
  FIXED_SL_PCT, FIXED_TP1_PCT, FIXED_TP2_PCT,
  SURGE_REL_VOLUME, SURGE_MIN_SL_PCT, SURGE_MAX_SL_PCT, TP2_MIN_REWARD_RISK,
  isBuyingSurge, resolveLadderPercents,
  buildRiskPlan, evaluatePrev4hRange, readPrev4hRangePlan,
  proStopTpLevels,
  evaluateTrendBreakout, readTrendBreakoutPlan,
  type RiskPlanInput
} from '@cde/engine/analysis';
import { withParams, DEFAULT_INTRADAY_PARAMS } from '@cde/engine';
import type { Candle } from '@cde/engine';

// ── the pure helpers ─────────────────────────────────────────────────────────

describe('resolveLadderPercents', () => {
  it('default (no surge): the fixed ladder, whatever the dynamic stop says', () => {
    for (const dynamicSlPct of [0.4, 1.5, 2.3, 3.9, 12]) {
      expect(resolveLadderPercents({ dynamicSlPct })).toEqual({
        slPct: FIXED_SL_PCT, tp1Pct: FIXED_TP1_PCT, tp2Pct: FIXED_TP2_PCT, surged: false,
        // Without an atrPercent there is no noise floor to measure against, so
        // the flat ladder stands exactly as before.
        noiseWidened: false, tooVolatile: false, noiseFloorPct: 0
      });
    }
  });

  it('surge: the stop widens to the dynamic value, clamped to [2.3%, 4.2%]', () => {
    expect(resolveLadderPercents({ dynamicSlPct: 3.1, buyingSurge: true }).slPct).toBeCloseTo(3.1, 6);
    // below the floor → floored
    expect(resolveLadderPercents({ dynamicSlPct: 0.8, buyingSurge: true }).slPct).toBeCloseTo(SURGE_MIN_SL_PCT, 6);
    // above the cap → capped at MAX_LOSS_PERCENT
    expect(resolveLadderPercents({ dynamicSlPct: 99, buyingSurge: true }).slPct).toBeCloseTo(SURGE_MAX_SL_PCT, 6);
  });

  it('surge: TP1 stays 1.8% and TP2 never drops below 1.2 × SL', () => {
    const wide = resolveLadderPercents({ dynamicSlPct: SURGE_MAX_SL_PCT, buyingSurge: true });
    expect(wide.tp1Pct).toBeCloseTo(FIXED_TP1_PCT, 6);
    expect(wide.tp2Pct).toBeGreaterThanOrEqual(wide.slPct * TP2_MIN_REWARD_RISK - 1e-9);
    expect(wide.tp2Pct).toBeGreaterThanOrEqual(FIXED_TP2_PCT);
    expect(wide.surged).toBe(true);
  });

  it('surge with a missing/invalid dynamic stop falls back to the fixed ladder', () => {
    expect(resolveLadderPercents({ buyingSurge: true }).slPct).toBeCloseTo(FIXED_SL_PCT, 6);
    expect(resolveLadderPercents({ dynamicSlPct: NaN, buyingSurge: true }).slPct).toBeCloseTo(FIXED_SL_PCT, 6);
  });

  it('the fixed ladder is internally consistent: TP1 < SL, TP2/SL clears 1.2', () => {
    expect(FIXED_TP1_PCT).toBeLessThan(FIXED_SL_PCT);
    expect(FIXED_TP2_PCT / FIXED_SL_PCT).toBeGreaterThanOrEqual(TP2_MIN_REWARD_RISK);
  });
});

function volBars(n: number, lastVolume: number, lastGreen: boolean): Candle[] {
  const bars: Candle[] = Array.from({ length: n }, (_, i) => ({
    timestamp: i * 60_000, open: 100, high: 101, low: 99, close: 100, volume: 1000
  }));
  const last = bars[n - 1];
  bars[n - 1] = { ...last, volume: lastVolume, open: 100, close: lastGreen ? 101 : 99 };
  return bars;
}

describe('isBuyingSurge', () => {
  it('needs BOTH a volume spike and a green bar', () => {
    expect(isBuyingSurge(volBars(25, 1000 * SURGE_REL_VOLUME, true))).toBe(true);
    expect(isBuyingSurge(volBars(25, 1000 * SURGE_REL_VOLUME, false))).toBe(false); // red
    expect(isBuyingSurge(volBars(25, 1900, true))).toBe(false);                     // 1.9x < 2x
  });

  it('is false when there is nothing to measure', () => {
    expect(isBuyingSurge([])).toBe(false);
    expect(isBuyingSurge(volBars(1, 99_999, true))).toBe(false);
  });
});

// ── Intraday (buildRiskPlan) ─────────────────────────────────────────────────

const baseIntradayInput: Omit<RiskPlanInput, 'entryPrice' | 'atr5' | 'atr15' | 'equity'> = {
  symbol: 'CALM',
  direction: 'LONG',
  tradeType: 'SPOT',
  setupType: 'TREND_PULLBACK',
  openPositions: 0,
  openFutures: 0,
  currentLeveragedExposureUsd: 0,
  existingExposureByAsset: {}
};

function intradayPlan(atrMult: number, extra: Record<string, unknown> = {}, buyingSurge = false) {
  const entry = 100;
  return {
    entry,
    plan: buildRiskPlan({
      ...baseIntradayInput,
      entryPrice: entry,
      atr5: entry * atrMult,
      atr15: entry * (atrMult * 1.1),
      equity: 10_000,
      buyingSurge,
      params: withParams({ calmRegimeScalp: true, ...extra })
    })
  };
}

describe('Intraday — buildRiskPlan fixed ladder', () => {
  it('quiet market: SL 2.3%, TP1 1.8%, TP2 3.5%, NOT rejected', () => {
    const { entry, plan } = intradayPlan(0.005);
    expect(plan.approved).toBe(true);
    expect(plan.riskPercent).toBeCloseTo(FIXED_SL_PCT, 1);
    expect(plan.rewardPercent).toBeCloseTo(FIXED_TP1_PCT, 1);
    expect(Math.abs(plan.takeProfit2 - entry) / entry * 100).toBeCloseTo(FIXED_TP2_PCT, 1);
  });

  it('big ATR but NO surge: still the fixed ladder — volatility alone no longer widens the stop', () => {
    const { entry, plan } = intradayPlan(0.02, { maxStopPercent: 5 });
    expect(plan.approved).toBe(true);
    expect(plan.riskPercent).toBeCloseTo(FIXED_SL_PCT, 1);
    expect(plan.rewardPercent).toBeCloseTo(FIXED_TP1_PCT, 1);
    expect(Math.abs(plan.takeProfit2 - entry) / entry * 100).toBeCloseTo(FIXED_TP2_PCT, 1);
  });

  it('buying surge: the stop widens past 2.3% while TP1 stays 1.8%', () => {
    const { plan } = intradayPlan(0.02, { maxStopPercent: 5 }, true);
    expect(plan.approved).toBe(true);
    expect(plan.riskPercent).toBeGreaterThan(FIXED_SL_PCT);
    expect(plan.riskPercent).toBeLessThanOrEqual(SURGE_MAX_SL_PCT + 1e-6);
    expect(plan.rewardPercent).toBeCloseTo(FIXED_TP1_PCT, 1);
  });

  // REGRESSION. The test above raises maxStopPercent to 5 — a value production
  // never uses — which is why it kept passing while the surge branch was dead
  // at the real 1.5%. buildRiskPlan used to clamp the dynamic stop to
  // maxStopPercent BEFORE handing it to the ladder, so `max(2.3%, <=1.5%)` was
  // always 2.3% and no surge ever widened anything in this bot. Run the same
  // case at production params.
  it('buying surge widens the stop at the PRODUCTION maxStopPercent (1.5%)', () => {
    const quiet = intradayPlan(0.005, {}, true).plan;   // ATR 0.5% → dynamic < 2.3%
    const loud = intradayPlan(0.02, {}, true).plan;     // ATR 2.0% → dynamic  > 2.3%

    // A quiet tape has nothing to widen to: the 2.3% floor stands.
    expect(quiet.riskPercent).toBeCloseTo(FIXED_SL_PCT, 1);
    // A volatile one must actually move off the flat stop.
    expect(loud.riskPercent).toBeGreaterThan(FIXED_SL_PCT);
    expect(loud.riskPercent).toBeLessThanOrEqual(SURGE_MAX_SL_PCT + 1e-6);
    expect(loud.rewardPercent).toBeCloseTo(FIXED_TP1_PCT, 1);
  });

  it('the executed stop still respects maxStopPercent when the ladder is OFF', () => {
    // The fix moved the ceiling later in the pipeline; it must still bind here.
    for (const atrMult of [0.002, 0.005, 0.01, 0.02, 0.04]) {
      const plan = buildRiskPlan({
        ...baseIntradayInput,
        entryPrice: 100,
        atr5: 100 * atrMult,
        atr15: 100 * atrMult * 1.1,
        equity: 10_000,
        params: withParams({})
      });
      expect(plan.riskPercent).toBeLessThanOrEqual(DEFAULT_INTRADAY_PARAMS.maxStopPercent + 1e-9);
    }
  });

  it('surge in a QUIET market cannot tighten the stop below the 2.3% floor', () => {
    const { plan } = intradayPlan(0.005, {}, true);
    expect(plan.riskPercent).toBeCloseTo(FIXED_SL_PCT, 1);
  });

  it('flag off (default): identical to today — never the fixed 2.3% stop', () => {
    const entry = 100;
    const plan = buildRiskPlan({
      ...baseIntradayInput,
      entryPrice: entry,
      atr5: entry * 0.005,
      atr15: entry * 0.006,
      equity: 10_000,
      params: withParams({})
    });
    expect(plan.approved).toBe(true);
    expect(plan.riskPercent).not.toBeCloseTo(FIXED_SL_PCT, 1);
  });
});

// ── Pro (proStopTpLevels) ────────────────────────────────────────────────────

const slPctOf = (entry: number, stopLoss: number) => (entry - stopLoss) / entry * 100;

describe('Pro — proStopTpLevels fixed ladder', () => {
  it('quiet market (low ATR%): SL 2.3%, TP1 1.8%, TP2 3.5%', () => {
    const entry = 100;
    const levels = proStopTpLevels(entry, 0.5, true, { calmRegimeScalp: true });
    expect(slPctOf(entry, levels.stopLoss)).toBeCloseTo(FIXED_SL_PCT, 6);
    expect((levels.takeProfit1 - entry) / entry * 100).toBeCloseTo(FIXED_TP1_PCT, 6);
    expect((levels.takeProfit2 - entry) / entry * 100).toBeCloseTo(FIXED_TP2_PCT, 6);
  });

  it('high ATR% but NO surge: still the fixed ladder', () => {
    const entry = 100;
    const levels = proStopTpLevels(entry, 2.0, true, { calmRegimeScalp: true });
    expect(slPctOf(entry, levels.stopLoss)).toBeCloseTo(FIXED_SL_PCT, 6);
    expect((levels.takeProfit1 - entry) / entry * 100).toBeCloseTo(FIXED_TP1_PCT, 6);
  });

  it('buying surge + high ATR%: the ATR stop comes back, TP1 still 1.8%', () => {
    const entry = 100;
    const surged = proStopTpLevels(entry, 2.0, true, { calmRegimeScalp: true, buyingSurge: true });
    const plain = proStopTpLevels(entry, 2.0, true);
    expect(slPctOf(entry, surged.stopLoss)).toBeCloseTo(
      Math.min(SURGE_MAX_SL_PCT, Math.max(SURGE_MIN_SL_PCT, slPctOf(entry, plain.stopLoss))), 6
    );
    expect(slPctOf(entry, surged.stopLoss)).toBeGreaterThan(FIXED_SL_PCT);
    expect((surged.takeProfit1 - entry) / entry * 100).toBeCloseTo(FIXED_TP1_PCT, 6);
  });

  it('flag off (default): identical to today', () => {
    const entry = 100;
    const levels = proStopTpLevels(entry, 0.5, true);
    expect(slPctOf(entry, levels.stopLoss)).not.toBeCloseTo(FIXED_SL_PCT, 1);
  });
});

// ── Path (evaluatePrev4hRange) ───────────────────────────────────────────────

const H1_MS = 60 * 60 * 1000;
const BAR_MS = 4 * H1_MS;
function h1Series(n: number, base: number, step: number, k: number, lastVolume = 1000): Candle[] {
  const bars = Array.from({ length: n }, (_, i) => {
    const close = base + i * step;
    return {
      timestamp: i * H1_MS,
      open: i === 0 ? close : base + (i - 1) * step,
      high: close + k, low: close - k, close, volume: 1000
    };
  });
  bars[n - 1] = { ...bars[n - 1], volume: lastVolume };
  return bars;
}
function nowInNextWindow(n: number): number {
  return (Math.floor(n / 4) - 1) * BAR_MS + BAR_MS + H1_MS;
}

describe('Path — evaluatePrev4hRange fixed ladder', () => {
  // Tight prev-4H range (base 50, step 0.5, k 0.2): mid-stop dist ≈ 1.0,
  // entry ≈ 103.75 → dynSlPct ≈ 0.96%.
  const N = 108;
  const TIGHT_H1 = h1Series(N, 50, 0.5, 0.2);
  const NOW = nowInNextWindow(N);

  it('no surge: SL 2.3%, TP1 1.8%, TP2 3.5%, still SIGNAL', () => {
    const ev = evaluatePrev4hRange({ symbol: 'RNG', h1: TIGHT_H1, currentPrice: 103.75, now: NOW, params: { calmRegimeScalp: true } });
    expect(ev.willExecute).toBe(true);
    const plan = readPrev4hRangePlan(ev)!;
    const entry = plan.entryRef;
    expect(Math.abs(entry - plan.stopLoss) / entry * 100).toBeCloseTo(FIXED_SL_PCT, 1);
    expect(Math.abs(plan.takeProfit1 - entry) / entry * 100).toBeCloseTo(FIXED_TP1_PCT, 1);
    expect(Math.abs(plan.takeProfit2 - entry) / entry * 100).toBeCloseTo(FIXED_TP2_PCT, 1);
  });

  it('wide prev-4H range but NO surge: still the fixed 2.3% stop', () => {
    // base 10, step 0.1, k 0.4 → mid-stop ≈ 2.8% of entry, but volume is flat.
    const wideH1 = h1Series(N, 10, 0.1, 0.4);
    const H = wideH1[wideH1.length - 1].high;
    const ev = evaluatePrev4hRange({ symbol: 'RNG', h1: wideH1, currentPrice: H + 0.05, now: nowInNextWindow(N), params: { calmRegimeScalp: true } });
    expect(ev.willExecute).toBe(true);
    const plan = readPrev4hRangePlan(ev)!;
    const entry = plan.entryRef;
    expect(Math.abs(entry - plan.stopLoss) / entry * 100).toBeCloseTo(FIXED_SL_PCT, 1);
    expect(Math.abs(plan.takeProfit1 - entry) / entry * 100).toBeCloseTo(FIXED_TP1_PCT, 1);
  });

  it('buying surge on H1 (volume 3x + green bar): the range stop comes back, TP1 still 1.8%', () => {
    const wideH1 = h1Series(N, 10, 0.1, 0.4, 3000);
    const H = wideH1[wideH1.length - 1].high;
    const ev = evaluatePrev4hRange({ symbol: 'RNG', h1: wideH1, currentPrice: H + 0.05, now: nowInNextWindow(N), params: { calmRegimeScalp: true } });
    expect(ev.willExecute).toBe(true);
    const plan = readPrev4hRangePlan(ev)!;
    const entry = plan.entryRef;
    expect(Math.abs(entry - plan.stopLoss) / entry * 100).toBeGreaterThan(FIXED_SL_PCT);
    expect(Math.abs(plan.takeProfit1 - entry) / entry * 100).toBeCloseTo(FIXED_TP1_PCT, 1);
  });

  it('flag off: identical to today (tight mid-stop, not 2.3%)', () => {
    const ev = evaluatePrev4hRange({ symbol: 'RNG', h1: TIGHT_H1, currentPrice: 103.75, now: NOW, params: {} });
    expect(ev.willExecute).toBe(true);
    const plan = readPrev4hRangePlan(ev)!;
    const entry = plan.entryRef;
    expect(Math.abs(entry - plan.stopLoss) / entry * 100).not.toBeCloseTo(FIXED_SL_PCT, 1);
  });
});

// ── Bybit (evaluateTrendBreakout) ────────────────────────────────────────────

function ramp2(n: number, start: number, driftStep: number, spreadK: number, tf: number, volume = 1000): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const close = start + i * driftStep;
    return {
      timestamp: i * tf,
      open: i === 0 ? close : start + (i - 1) * driftStep,
      high: close + spreadK, low: close - spreadK, close, volume
    };
  });
}
const H1MS = 60 * 60 * 1000, M15MS = 15 * 60 * 1000, M5MS = 5 * 60 * 1000;

/** `breakoutVolume` 1500 clears the x1.2 breakout gate without reaching the
 *  x2.0 surge bar; 8000 is a genuine surge. */
function bybitInput(spreadK: number, params: Record<string, unknown> = {}, breakoutVolume = 1500) {
  const h1 = ramp2(220, 100, 0.5, 0.6, H1MS);
  const m15 = ramp2(320, 150, 0.15, spreadK, M15MS);
  const prev = m15[m15.length - 2];
  const closeVal = prev.close + spreadK * 1.3 + 0.5;
  m15[m15.length - 1] = { timestamp: m15[m15.length - 1].timestamp, open: prev.close, high: closeVal + 0.2, low: prev.close - spreadK, close: closeVal, volume: breakoutVolume };
  const m5 = ramp2(40, closeVal - 5, 0.13, 0.3, M5MS);
  return { symbol: 'TREND', h1, m15, m5, currentPrice: closeVal, params };
}

describe('Bybit — evaluateTrendBreakout fixed ladder', () => {
  it('no surge: SL 2.3%, TP1 1.8%, TP2 3.5%, still SIGNAL', () => {
    const ev = evaluateTrendBreakout(bybitInput(0.2, { calmRegimeScalp: true }));
    expect(ev.willExecute).toBe(true);
    const plan = readTrendBreakoutPlan(ev)!;
    const entry = plan.entryRef;
    expect(Math.abs(entry - plan.stopLoss) / entry * 100).toBeCloseTo(FIXED_SL_PCT, 1);
    expect(Math.abs(plan.takeProfit1 - entry) / entry * 100).toBeCloseTo(FIXED_TP1_PCT, 1);
    expect(Math.abs(plan.takeProfit2 - entry) / entry * 100).toBeCloseTo(FIXED_TP2_PCT, 1);
  });

  it('wide ATR(M15) but NO surge: still the fixed 2.3% stop', () => {
    const ev = evaluateTrendBreakout(bybitInput(1.0, { calmRegimeScalp: true }));
    expect(ev.willExecute).toBe(true);
    const plan = readTrendBreakoutPlan(ev)!;
    const entry = plan.entryRef;
    expect(Math.abs(entry - plan.stopLoss) / entry * 100).toBeCloseTo(FIXED_SL_PCT, 1);
    expect(Math.abs(plan.takeProfit1 - entry) / entry * 100).toBeCloseTo(FIXED_TP1_PCT, 1);
  });

  it('buying surge on M15 (x8 volume + green breakout bar): the ATR stop comes back', () => {
    const ev = evaluateTrendBreakout(bybitInput(1.0, { calmRegimeScalp: true }, 8000));
    expect(ev.willExecute).toBe(true);
    const plan = readTrendBreakoutPlan(ev)!;
    const entry = plan.entryRef;
    expect(Math.abs(entry - plan.stopLoss) / entry * 100).toBeGreaterThan(FIXED_SL_PCT);
    expect(Math.abs(plan.takeProfit1 - entry) / entry * 100).toBeCloseTo(FIXED_TP1_PCT, 1);
  });

  it('flag off: identical to today', () => {
    const ev = evaluateTrendBreakout(bybitInput(0.2, {}));
    expect(ev.willExecute).toBe(true);
    const plan = readTrendBreakoutPlan(ev)!;
    const entry = plan.entryRef;
    expect(Math.abs(entry - plan.stopLoss) / entry * 100).not.toBeCloseTo(FIXED_SL_PCT, 1);
  });
});
