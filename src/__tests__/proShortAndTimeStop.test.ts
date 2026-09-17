/**
 * Pro — SHORT capability's hard directional veto, and the new Time Stop
 * (2026-09-17, operator decision)
 * ============================================================================
 * Two independent additions, tested separately:
 *
 *   1. Hard veto: never short into a positive last-H1-candle return or an
 *      established uptrend (PRO_SHORT_TREND_VETO_1H_RETURN_PCT). Checked at
 *      TWO layers — inside computeProSignal (demotes a vetoed SELL to HOLD)
 *      and again at the entry gate in applyProEntryGates (belt-and-
 *      suspenders). This file pins the gate-level check directly, with a
 *      hand-built evaluation, since that is the simpler and more direct
 *      surface — computeProSignal's own veto is exercised indirectly via the
 *      indicator fields it computes (oneHourReturnPct / trendUp), pinned here
 *      too.
 *
 *   2. Pro's own Time Stop (evaluateProExit, opts.timeStopPeakTrail) —
 *      REPLACES the profit ratchet for Pro. Past PRO_TIME_STOP_MINUTES (240):
 *      not in profit → close now; in profit → run free of TP1/TP2, closing
 *      only on a PRO_TIME_STOP_TRAIL_PCT (0.6%) pullback off the peak PRICE.
 */

import { describe, it, expect } from 'vitest';
import {
  applyProEntryGates,
  type ProGateContext
} from '@cde/engine/execution';
import {
  computeProSignal,
  evaluateProExit,
  PRO_SHORT_TREND_VETO_1H_RETURN_PCT,
  PRO_TIME_STOP_MINUTES,
  PRO_TIME_STOP_TRAIL_PCT,
  type ProPositionView
} from '@cde/engine/analysis';
import type { SignalEvaluation } from '@cde/engine';

const H1 = 3_600_000;

function candlesWithLastBarReturn(returnPct: number, n = 60): { timestamp: number; open: number; high: number; low: number; close: number; volume: number }[] {
  // Flat tape (ema50 ≈ ema200 ≈ price) so `trendUp` stays false and only the
  // last bar's own return drives the veto check.
  const bars = Array.from({ length: n }, (_, i) => ({
    timestamp: i * H1, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000
  }));
  const open = bars[n - 1].open;
  const close = open * (1 + returnPct / 100);
  bars[n - 1] = { ...bars[n - 1], close, high: Math.max(open, close) + 0.1, low: Math.min(open, close) - 0.1 };
  return bars;
}

describe('computeProSignal — SHORT veto inputs', () => {
  it('computes oneHourReturnPct from the last closed candle', () => {
    const s = computeProSignal(candlesWithLastBarReturn(0.5) as never, 0);
    expect(s.indicators.oneHourReturnPct).toBeCloseTo(0.5, 4);
  });

  it('a negative last-bar return does not read as trendUp on a flat EMA structure', () => {
    const s = computeProSignal(candlesWithLastBarReturn(-0.5) as never, 0);
    expect(s.indicators.oneHourReturnPct).toBeCloseTo(-0.5, 4);
    expect(s.indicators.trendUp).toBe(false);
  });

  it('a SELL is demoted to HOLD when the last H1 candle cleared the veto threshold', () => {
    // A monotonic uptrend gives multiple oscillators (RSI/BB/Stochastic) a
    // genuine overbought SELL vote while the tape itself is still green —
    // exactly the "sell the top of a green candle" shape the veto exists for.
    const n = 80;
    const bars = Array.from({ length: n }, (_, i) => ({
      timestamp: i * H1, open: 100 + i * 0.8, high: 100.9 + i * 0.8, low: 99.6 + i * 0.8, close: 100.7 + i * 0.8, volume: 1000
    }));
    const s = computeProSignal(bars as never, 0);
    expect(s.indicators.oneHourReturnPct).toBeGreaterThan(PRO_SHORT_TREND_VETO_1H_RETURN_PCT);
    // Whatever the raw bucket vote wanted, the veto (or the trend-participation
    // lane, which promotes the same case to BUY) means it never surfaces as SELL.
    expect(s.action).not.toBe('SELL');
  });
});

describe('applyProEntryGates — SHORT_TREND_VETO (gate-level, belt-and-suspenders)', () => {
  const baseEval = (over: Partial<SignalEvaluation> = {}): SignalEvaluation => ({
    symbol: 'LA', action: 'sell', tradeType: 'HOLD', tradeSide: 'SELL', confidence: 90,
    price: 100, priceChange24h: 0, reasoning: '', status: '', willExecute: false,
    factors: [], confidenceGap: 0,
    ...over
  } as SignalEvaluation);

  const ctx = (over: Partial<ProGateContext> = {}): ProGateContext => ({
    positions: [], pending: [], cash: 10_000, equity: 10_000, initialAmount: 10_000,
    maxPositions: 5, maxFuturesPositions: 2, riskLevel: 'medium', candlesBySymbol: {},
    ...over
  });

  it('blocks a SHORT when the last H1 candle return exceeds the veto threshold', () => {
    const ev = baseEval({ indicators: { rsi: 50, ma20: 100, bollingerBands: { upper: 101, middle: 100, lower: 99, position: 'between' }, volumeProfile: { poc: 100, valueAreaHigh: 101, valueAreaLow: 99, position: 'in_value_area' }, oneHourReturnPct: PRO_SHORT_TREND_VETO_1H_RETURN_PCT + 0.1, trendUp: false } });
    const [out] = applyProEntryGates([ev], ctx());
    expect(out.willExecute).toBe(false);
    expect(out.status).toBe('NO_SIGNAL [SHORT_TREND_VETO]');
  });

  it('blocks a SHORT when ema50 > ema200 (trendUp), even with a flat/negative last candle', () => {
    const ev = baseEval({ indicators: { rsi: 50, ma20: 100, bollingerBands: { upper: 101, middle: 100, lower: 99, position: 'between' }, volumeProfile: { poc: 100, valueAreaHigh: 101, valueAreaLow: 99, position: 'in_value_area' }, oneHourReturnPct: -0.1, trendUp: true } });
    const [out] = applyProEntryGates([ev], ctx());
    expect(out.willExecute).toBe(false);
    expect(out.status).toBe('NO_SIGNAL [SHORT_TREND_VETO]');
  });

  it('allows a SHORT through to sizing when neither veto condition holds', () => {
    const ev = baseEval({ indicators: { rsi: 50, ma20: 100, bollingerBands: { upper: 101, middle: 100, lower: 99, position: 'between' }, volumeProfile: { poc: 100, valueAreaHigh: 101, valueAreaLow: 99, position: 'in_value_area' }, oneHourReturnPct: -0.3, trendUp: false } });
    const [out] = applyProEntryGates([ev], ctx());
    expect(out.status).toBe('SIGNAL FUTURES SHORT');
    expect(out.willExecute).toBe(true);
    expect(out.tradeType).toBe('FUTURES');
  });
});

describe('evaluateProExit — Pro Time Stop (opts.timeStopPeakTrail, replaces the ratchet)', () => {
  const NOW = 1_800_000_000_000;
  const pos = (over: Partial<ProPositionView> = {}): ProPositionView => ({
    entryPrice: 100, isLong: true, tp1Hit: false,
    openTimestamp: NOW - PRO_TIME_STOP_MINUTES * 60_000 - 60_000, // just past checkpoint
    ...over
  });
  const holdSignal = { action: 'HOLD' as const, buyScore: 0, sellScore: 0, holdScore: 100, totalWeight: 0, confidence: 0, atrPercent: 0, signals: [], indicators: { rsi: 50, ma20: 100, volumeTrend: 'stable' as const, bollingerBands: { upper: 101, middle: 100, lower: 99, position: 'between' as const }, volumeProfile: { poc: 100, valueAreaHigh: 101, valueAreaLow: 99, position: 'in_value_area' as const } } };

  it('before the checkpoint, the mechanism does nothing (normal TP1/TP2 still govern)', () => {
    const decision = evaluateProExit(
      pos({ openTimestamp: NOW - 60_000 }), // just 1 minute held
      100, holdSignal, 70, { timeStopPeakTrail: true }, NOW
    );
    expect(decision.shouldExit).toBe(false);
  });

  it('past the checkpoint, not in profit → closes now, in full', () => {
    const decision = evaluateProExit(pos(), 99, holdSignal, 70, { timeStopPeakTrail: true }, NOW);
    expect(decision.shouldExit).toBe(true);
    expect(decision.exitType).toBe('FULL');
    expect(decision.reason).toContain('Time Stop');
    expect(decision.reason).toContain(String(PRO_TIME_STOP_MINUTES));
  });

  it('past the checkpoint, in profit, price still within 0.6% of the peak → keeps running, bypassing TP1', () => {
    const decision = evaluateProExit(
      pos({ peakPrice: 110, takeProfit1: 101 }),
      109.5, // 0.45% off the 110 peak — inside the 0.6% trail band
      holdSignal, 70, { timeStopPeakTrail: true }, NOW
    );
    expect(decision.shouldExit).toBe(false);
  });

  it('past the checkpoint, in profit, a 0.6% pullback off the peak closes it in full', () => {
    const peak = 110;
    const trailPrice = peak * (1 - PRO_TIME_STOP_TRAIL_PCT / 100);
    const decision = evaluateProExit(
      pos({ peakPrice: peak, takeProfit1: 101 }),
      trailPrice - 0.01,
      holdSignal, 70, { timeStopPeakTrail: true }, NOW
    );
    expect(decision.shouldExit).toBe(true);
    expect(decision.exitType).toBe('FULL');
    expect(decision.reason).toContain('נעילת רווח');
  });

  it('the live path (opts omitted) is completely unaffected — always the old full-close-on-time behavior never fires because there is none', () => {
    const decision = evaluateProExit(pos(), 99, holdSignal, 70, {}, NOW);
    expect(decision.shouldExit).toBe(false); // no ratchet, no timeStopPeakTrail — plain SL/TP only, and 99 is above -4.2%
  });
});
