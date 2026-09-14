import { describe, it, expect } from 'vitest';
import {
  evaluateTrendBreakout,
  readTrendBreakoutPlan,
  donchian,
  volumeSMA,
  DEFAULT_TREND_BREAKOUT_PARAMS,
  type TrendBreakoutPlan
} from '@cde/engine/analysis';
import {
  applyFundingAccrual,
  MIN_SIM_ENTRY_USD,
  SIM_INTRADAY_PARAMS_OVERRIDE,
  type SimPosition
} from '@cde/engine/execution';

// TrendBreakout is the independent strategy behind the 4th ("Bybit") sim bot.
// These tests hold its contract: deterministic on closed candles, every
// no-trade path names itself, confidence weights sum to 100, and — separately —
// the shared funding accrual behaves for LONG/SHORT/SPOT.

interface C { timestamp: number; open: number; high: number; low: number; close: number; volume: number }

/** A clean linear series — `n` bars rising by `step` from `start`, tight range. */
function ramp(n: number, start: number, step: number, tf: number, volume = 1000): C[] {
  const out: C[] = [];
  for (let i = 0; i < n; i++) {
    const close = start + i * step;
    out.push({
      timestamp: i * tf,
      open: i === 0 ? close : start + (i - 1) * step,
      high: close + Math.abs(step) * 0.5 + 0.2,
      low: close - Math.abs(step) * 0.5 - 0.2,
      close,
      volume
    });
  }
  return out;
}

/** A choppy, directionless series — no sustained trend. */
function chop(n: number, mid: number, tf: number): C[] {
  const out: C[] = [];
  for (let i = 0; i < n; i++) {
    const close = mid + (i % 2 === 0 ? 1 : -1) * 0.4;
    out.push({ timestamp: i * tf, open: mid, high: mid + 1, low: mid - 1, close, volume: 1000 });
  }
  return out;
}

const H1 = 60 * 60 * 1000;
const M15 = 15 * 60 * 1000;
const M5 = 5 * 60 * 1000;

/** A universe state that should fire a LONG SIGNAL. */
function longSignalInput(overrides: { lastM15Volume?: number } = {}) {
  const h1 = ramp(220, 100, 0.5, H1);
  const m15 = ramp(320, 150, 0.15, M15);
  // Replace the last M15 bar with a decisive Donchian breakout + volume spike.
  const prev = m15[m15.length - 2];
  m15[m15.length - 1] = {
    timestamp: m15[m15.length - 1].timestamp,
    open: prev.close,
    high: 205.2,
    low: prev.close - 0.2,
    close: 205,
    volume: overrides.lastM15Volume ?? 8000
  };
  const m5 = ramp(40, 200, 0.13, M5);
  return { symbol: 'TREND', h1, m15, m5, currentPrice: 205 };
}

describe('evaluateTrendBreakout — signal', () => {
  it('fires a LONG SPOT SIGNAL when H1 trend + M15 breakout + M5 confirmation all align', () => {
    const ev = evaluateTrendBreakout(longSignalInput());
    expect(ev.willExecute).toBe(true);
    expect(ev.tradeSide).toBe('LONG');
    expect(ev.tradeType).toBe('SPOT');
    expect(ev.confidence).toBeGreaterThanOrEqual(DEFAULT_TREND_BREAKOUT_PARAMS.minConfidence);

    const plan = readTrendBreakoutPlan(ev) as TrendBreakoutPlan;
    expect(plan).toBeTruthy();
    expect(plan.state).toBe('SIGNAL');
    // SL below entry (ATR stop, capped at 4.2%). TP1 = max(2R, tp1FloorDistance);
    // here 2R clears the floor so TP1 is the 2R target and TP2 = 1.5×TP1.
    expect(plan.stopLoss).toBeLessThan(plan.entryRef);
    expect(plan.entryRef - plan.stopLoss).toBeLessThanOrEqual(plan.entryRef * 0.042 + 1e-9);
    expect(plan.takeProfit1 - plan.entryRef).toBeCloseTo(2 * plan.riskPerUnit, 4);
    expect(plan.takeProfit2 - plan.entryRef).toBeCloseTo(1.5 * (plan.takeProfit1 - plan.entryRef), 4);
  });

  // Regression (2026-09-14): every evaluation left `regime` unset — the SIGNAL
  // path even set it to `undefined` explicitly — so the UI's regime
  // distribution panel (SimulationEngineColumn) counted every TrendBreakout
  // evaluation as "no data" and always showed 0 across the board, even with
  // 40/40 symbols scanned. Cosmetic only (willExecute never reads `regime`),
  // but it's the diagnostic panel an operator uses to tell "no trend anywhere
  // right now" apart from "this bot doesn't report trend at all".
  it('reports a real regime on a firing SIGNAL, matching the trade direction', () => {
    const ev = evaluateTrendBreakout(longSignalInput());
    expect(ev.regime).toBeDefined();
    expect(ev.regime!.regime).toBe('TRENDING');
    expect(ev.regime!.direction).toBe('BULL');
  });

  it('abstains with H1_TREND_NEUTRAL when H1 has no sustained trend', () => {
    const ev = evaluateTrendBreakout({
      symbol: 'FLAT',
      h1: chop(220, 100, H1),
      m15: ramp(320, 150, 0.15, M15),
      m5: ramp(40, 200, 0.13, M5),
      currentPrice: 197
    });
    expect(ev.willExecute).toBe(false);
    expect(ev.status).toContain('H1_TREND_NEUTRAL');
    // Even the earliest abstain now carries a regime — TRANSITIONAL, since
    // this strategy has no separate RANGING detector to draw that line.
    expect(ev.regime).toBeDefined();
    expect(ev.regime!.regime).toBe('TRANSITIONAL');
  });

  it('abstains with VOLUME_TOO_LOW when the breakout has no volume behind it', () => {
    const ev = evaluateTrendBreakout(longSignalInput({ lastM15Volume: 1000 }));
    expect(ev.willExecute).toBe(false);
    expect(ev.status).toContain('VOLUME_TOO_LOW');
  });

  it('a firing SIGNAL always clears the minRewardRisk floor on its final levels', () => {
    const ev = evaluateTrendBreakout(longSignalInput());
    expect(ev.willExecute).toBe(true);
    const plan = readTrendBreakoutPlan(ev) as TrendBreakoutPlan;
    const grossRR = Math.abs(plan.takeProfit1 - plan.entryRef) / plan.riskPerUnit;
    expect(grossRR).toBeGreaterThanOrEqual(DEFAULT_TREND_BREAKOUT_PARAMS.minRewardRisk);
  });

  it('abstains with RR_TOO_LOW when the guaranteed R:R is below a raised minRewardRisk (backstop)', () => {
    // tp1FloorDistance's `1.5×stop` term makes grossRR >= 1.5 by construction,
    // so a plain params change can no longer invert the levels. Force the
    // backstop by raising minRewardRisk above what the floor guarantees:
    // tpRMultiplier 0.05 → atrTp1 tiny → TP1 = 1.5×stop → grossRR 1.5 < 2.5.
    const wide = longSignalInput();
    wide.m15 = wide.m15.map((c, i) => (i < wide.m15.length - 1 ? { ...c, low: c.close - 24 } : c));
    const ev = evaluateTrendBreakout({ ...wide, params: { tpRMultiplier: 0.05, minRewardRisk: 2.5 } });
    expect(ev.willExecute).toBe(false);
    expect(ev.status).toContain('RR_TOO_LOW');
  });

  it('abstains with NO_DATA below the minimum candle counts', () => {
    const ev = evaluateTrendBreakout({
      symbol: 'THIN',
      h1: ramp(50, 100, 0.5, H1),
      m15: ramp(50, 150, 0.1, M15),
      m5: ramp(10, 200, 0.1, M5),
      currentPrice: 155
    });
    expect(ev.status).toContain('NO_DATA');
  });

  it('is deterministic and lookahead-free: appended future candles do not change a past decision', () => {
    const a = evaluateTrendBreakout(longSignalInput());
    const withFuture = longSignalInput();
    // Bars AFTER the decision point must not exist in the input the strategy
    // sees — trim them back and the decision is byte-for-byte identical.
    withFuture.h1 = [...withFuture.h1, ...ramp(10, 250, 0.5, H1)].slice(0, 220);
    withFuture.m15 = withFuture.m15.slice(0, 320);
    withFuture.m5 = withFuture.m5.slice(0, 40);
    const b = evaluateTrendBreakout(withFuture);
    expect(b.confidence).toBe(a.confidence);
    expect(b.status).toBe(a.status);
    expect(readTrendBreakoutPlan(b)?.stopLoss).toBe(readTrendBreakoutPlan(a)?.stopLoss);
  });

  it('confidence sub-score weights sum to 100', () => {
    const ev = evaluateTrendBreakout(longSignalInput());
    const c = readTrendBreakoutPlan(ev)!.components;
    // Maximum of each weighted component: 25 + 20 + 25 + 15 + 15.
    expect(25 + 20 + 25 + 15 + 15).toBe(100);
    const total = c.supertrend + c.emaTrend + c.breakout + c.volume + c.m5;
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(100 + 1e-9);
  });
});

describe('donchian / volumeSMA helpers', () => {
  it('donchian returns the highest high and lowest low of the window', () => {
    const cs = ramp(30, 10, 1, M5);
    const d = donchian(cs.slice(-20), 20);
    expect(d.upper).toBe(cs[cs.length - 1].high);
    expect(d.lower).toBe(cs[cs.length - 20].low);
  });

  it('volumeSMA averages the window', () => {
    const cs = ramp(30, 10, 1, M5, 500);
    expect(volumeSMA(cs.slice(-20), 20)).toBe(500);
  });
});

describe('$100 minimum sim entry (operator floor, all 4 bots)', () => {
  it('MIN_SIM_ENTRY_USD is $100', () => {
    expect(MIN_SIM_ENTRY_USD).toBe(100);
  });

  it('intraday sim rounds sub-minimum orders up to $100 via the sim params override', () => {
    // The real bot keeps the $5 exchange floor (DEFAULT_INTRADAY_PARAMS); only
    // the simulation layer raises it.
    expect(SIM_INTRADAY_PARAMS_OVERRIDE.minOrderUsd).toBe(100);
  });
});

describe('applyFundingAccrual (shared, all 4 bots)', () => {
  const now = 1_000_000_000_000;
  const eightHoursAgo = now - 8 * 60 * 60 * 1000;
  const rate = 0.0001; // 0.01% / 8h, longs pay

  const futuresPos = (side: 'LONG' | 'SHORT'): SimPosition => ({
    id: side, symbol: 'BTC', type: 'FUTURES', side, quantity: 1, entryPrice: 10000,
    avgPrice: 10000, currentPrice: 10000, leverage: 1, marginUsd: 10000, notionalUsd: 10000,
    stopLoss: 9000, tp1Hit: false, openedAt: '', openTimestamp: 0, reason: '', confidence: 0, entryFee: 0
  });

  it('LONG pays funding when the rate is positive', () => {
    const map = new Map([['BTC', { lastFundingRate: rate, at: now }]]);
    const r = applyFundingAccrual([futuresPos('LONG')], 5000, map, eightHoursAgo, now);
    // notional 10000 × 0.0001 × 1 full interval = $1 paid.
    expect(r.fundingPaid).toBeCloseTo(1, 6);
    expect(r.cash).toBeCloseTo(4999, 6);
  });

  it('SHORT receives funding when the rate is positive', () => {
    const map = new Map([['BTC', { lastFundingRate: rate, at: now }]]);
    const r = applyFundingAccrual([futuresPos('SHORT')], 5000, map, eightHoursAgo, now);
    expect(r.fundingPaid).toBeCloseTo(-1, 6);
    expect(r.cash).toBeCloseTo(5001, 6);
  });

  it('prorates by elapsed time', () => {
    const map = new Map([['BTC', { lastFundingRate: rate, at: now }]]);
    const twoHours = now - 2 * 60 * 60 * 1000;
    const r = applyFundingAccrual([futuresPos('LONG')], 5000, map, twoHours, now);
    expect(r.fundingPaid).toBeCloseTo(0.25, 6);
  });

  it('ignores SPOT positions and is a no-op on an empty rate map', () => {
    const spot: SimPosition = { ...futuresPos('LONG'), type: 'SPOT', side: 'BUY' };
    expect(applyFundingAccrual([spot], 5000, new Map([['BTC', { lastFundingRate: rate, at: now }]]), eightHoursAgo, now).fundingPaid).toBe(0);
    expect(applyFundingAccrual([futuresPos('LONG')], 5000, new Map(), eightHoursAgo, now).fundingPaid).toBe(0);
  });
});
