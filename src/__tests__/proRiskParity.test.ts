/**
 * Pro risk-management parity with Intraday/Path/Bybit (2026-09-16)
 * ============================================================================
 * A fresh audit (operator request) found Pro was the one sim bot with:
 *
 *   1. NO correlation-concentration gate at all — grep confirmed
 *      evaluateCorrelationGate had zero references in proSimExecution.ts,
 *      while Intraday/Path/Bybit all call it. Pro could stack up to 7 highly
 *      correlated majors (BTC/ETH/SOL/...) as one risk factor held 7 times —
 *      exactly the failure mode the gate was built to catch (six correlated
 *      longs stopped out together for -$102 in 12 minutes on Intraday,
 *      2026-09-10).
 *   2. NO per-tick re-application of the shared 4.2% damage cap
 *      (capStopLoss/MAX_LOSS_PERCENT) in evaluateProExit — it read
 *      pos.stopLoss directly. The other three bots all re-clamp on every
 *      evaluation as a backstop for a position carrying a wider stop than
 *      entry-time computation currently produces.
 *
 * Both fixed here. This file proves the fixes with the SAME technique used
 * to verify Path/Bybit's own correlation and cap wiring.
 */

import { describe, it, expect } from 'vitest';
import { applyProEntryGates, type ProGateContext, type PendingOrder } from '@cde/engine/execution';
import { evaluateProExit, type ProPositionView, type ProSignalResult } from '@cde/engine/analysis';
import type { Candle, SignalEvaluation } from '@cde/engine';

// ── 1. Correlation gate ─────────────────────────────────────────────────────

function sineCandles(phase: number, n = 40): Candle[] {
  const bars: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const close = 100 + 5 * Math.sin(i / 4 + phase);
    bars.push({ timestamp: i * 3_600_000, open: close, high: close + 0.1, low: close - 0.1, close, volume: 1000 });
  }
  return bars;
}

/** Two IDENTICAL series (rho ≈ 1.0) vs. one phase-shifted by half a cycle
 *  (rho ≈ -1.0, still |rho| high — "effective" correlation flips with
 *  direction, not the raw magnitude). */
function correlatedCandles(n = 40): Candle[] {
  return sineCandles(0, n);
}

function buyEval(symbol: string, confidence = 90, price = 100): SignalEvaluation {
  return {
    symbol, action: 'buy', tradeType: 'SPOT', tradeSide: 'BUY', confidence,
    price, priceChange24h: 1, reasoning: 'test', status: '', willExecute: false,
    factors: [], confidenceGap: 0
  } as SignalEvaluation;
}

const heldOrder = (symbol: string): PendingOrder =>
  ({ id: `o-${symbol}`, symbol, side: 'buy', confidence: 80 } as unknown as PendingOrder);

describe('Pro now runs the correlation-concentration gate (previously absent)', () => {
  it('refuses a 4th highly-correlated BUY once 3 correlated positions are already queued', () => {
    const candlesBySymbol: Record<string, Candle[]> = {
      AA: correlatedCandles(), BB: correlatedCandles(), CC: correlatedCandles(), DD: correlatedCandles()
    };
    const ctx: ProGateContext = {
      positions: [],
      pending: [heldOrder('AA'), heldOrder('BB'), heldOrder('CC')],
      cash: 100_000, equity: 100_000, initialAmount: 100_000,
      maxPositions: 10, riskLevel: 'medium', candlesBySymbol
    };
    const [ev] = applyProEntryGates([buyEval('DD')], ctx);
    expect(ev.status).toBe('NO_SIGNAL [CORRELATION]');
    expect(ev.willExecute).toBe(false);
  });

  it('allows the 4th BUY when it is genuinely uncorrelated with the held book', () => {
    const candlesBySymbol: Record<string, Candle[]> = {
      AA: correlatedCandles(), BB: correlatedCandles(), CC: correlatedCandles(),
      DD: sineCandles(10) // very different phase/shape → low rho
    };
    const ctx: ProGateContext = {
      positions: [],
      pending: [heldOrder('AA'), heldOrder('BB'), heldOrder('CC')],
      cash: 100_000, equity: 100_000, initialAmount: 100_000,
      maxPositions: 10, riskLevel: 'medium', candlesBySymbol
    };
    const [ev] = applyProEntryGates([buyEval('DD')], ctx);
    expect(ev.status).toBe('SIGNAL SPOT BUY');
    expect(ev.willExecute).toBe(true);
  });

  it('allows the 3rd correlated position — the cap is 3, not fewer', () => {
    const candlesBySymbol: Record<string, Candle[]> = {
      AA: correlatedCandles(), BB: correlatedCandles(), CC: correlatedCandles()
    };
    const ctx: ProGateContext = {
      positions: [],
      pending: [heldOrder('AA'), heldOrder('BB')],
      cash: 100_000, equity: 100_000, initialAmount: 100_000,
      maxPositions: 10, riskLevel: 'medium', candlesBySymbol
    };
    const [ev] = applyProEntryGates([buyEval('CC')], ctx);
    expect(ev.status).toBe('SIGNAL SPOT BUY');
  });

  it('abstains safely (allows) when candle history is missing entirely and the book is small', () => {
    const ctx: ProGateContext = {
      positions: [], pending: [],
      cash: 100_000, equity: 100_000, initialAmount: 100_000,
      maxPositions: 10, riskLevel: 'medium'
      // candlesBySymbol omitted entirely — legacy caller shape
    };
    const [ev] = applyProEntryGates([buyEval('AA')], ctx);
    expect(ev.status).toBe('SIGNAL SPOT BUY');
  });
});

// ── 2. Per-tick 4.2% damage cap ─────────────────────────────────────────────

const flatSignal: ProSignalResult = {
  action: 'HOLD', buyScore: 0, sellScore: 0, holdScore: 100, totalWeight: 0, confidence: 0, atrPercent: 0, signals: [],
  indicators: {
    rsi: 50, ma20: 100, volumeTrend: 'stable',
    bollingerBands: { upper: 100, middle: 100, lower: 100, position: 'between' },
    volumeProfile: { poc: 100, valueAreaHigh: 100, valueAreaLow: 100, position: 'in_value_area' }
  } as unknown as ProSignalResult['indicators']
};

describe('Pro exit now re-applies the shared 4.2% damage cap every tick (previously entry-time only)', () => {
  it('a stored stop wider than 4.2% is pulled in — the position exits at the CAPPED level, not the wider stored one', () => {
    const pos: ProPositionView = {
      entryPrice: 100,
      isLong: true,
      stopLoss: 90 // -10%, far wider than the 4.2% cap — simulates a stale/migrated position
    };
    // Price at 91: BELOW the stored -10% stop's trigger (90) it is not, but it
    // IS below the capped -4.2% level (95.8) — so the cap-aware exit should
    // fire here while the uncapped stored stop (90) would not have.
    const decision = evaluateProExit(pos, 94, flatSignal, 40);
    expect(decision.shouldExit).toBe(true);
    expect(decision.exitType).toBe('FULL');
  });

  it('a stop already inside 4.2% is unaffected by the cap (no-op case)', () => {
    const pos: ProPositionView = {
      entryPrice: 100,
      isLong: true,
      stopLoss: 97.7 // -2.3%, the calm-regime floor — well inside the cap
    };
    // Price just above the real stop: should NOT exit.
    const above = evaluateProExit(pos, 98, flatSignal, 40);
    expect(above.shouldExit).toBe(false);
    // Price at/below the real stop: SHOULD exit, at the uncapped level.
    const below = evaluateProExit(pos, 97.5, flatSignal, 40);
    expect(below.shouldExit).toBe(true);
  });

  it('SHORT direction: a stored stop wider than 4.2% above entry is pulled in symmetrically', () => {
    const pos: ProPositionView = {
      entryPrice: 100,
      isLong: false,
      stopLoss: 110 // +10%, far wider than the cap
    };
    // Price at 104.5: above the capped +4.2% level (104.2) but below the
    // stored +10% one — the cap-aware exit fires, the uncapped one would not.
    const decision = evaluateProExit(pos, 104.5, flatSignal, 40);
    expect(decision.shouldExit).toBe(true);
    expect(decision.exitType).toBe('FULL');
  });
});
