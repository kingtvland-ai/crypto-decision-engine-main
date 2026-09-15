/**
 * Sell-pressure Macro Layer, extended to Pro/Path/Bybit (2026-09-16)
 * ============================================================================
 * Previously Intraday-only (GATE 6 in intradayEngine.ts). Operator request
 * after a FLOCK re-entry stopped out with no macro protection at all, since
 * that trade may not have been on Intraday. `applySellPressureOverride`
 * (simExecution.ts) is the shared decision-override all three other bots now
 * run through in their server engines (proSimEngine.ts / pathSimEngine.ts /
 * bybitSimEngine.ts) — same detectSellPressureFromH1 computation Intraday's
 * own GATE 6 calls, applied AFTER each bot's own evaluate function decided to
 * trade, so none of their strategies' gates/thresholds are touched.
 */

import { describe, it, expect } from 'vitest';
import { applySellPressureOverride } from '@cde/engine/execution';
import type { SignalEvaluation } from '@cde/engine';
import type { Candle } from '@cde/engine';
import type { DerivativesSnapshot } from '@cde/engine/analysis';

const TF_1H = 3_600_000;

function candlesFromCloses(closes: number[], now: number, vol = 1000): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < closes.length; i++) {
    const c = closes[i];
    const prev = i > 0 ? closes[i - 1] : c;
    out.push({
      timestamp: now - (closes.length - i) * TF_1H,
      open: prev, close: c,
      high: Math.max(prev, c) * 1.0006 + 0.001,
      low: Math.min(prev, c) * 0.9994 - 0.001,
      volume: vol
    });
  }
  return out;
}

/** 21 flat H1 bars, then a sell-pressure-shaped final bar: sharp drop on a
 *  volume spike relative to the preceding 20-bar average. */
function h1WithSellPressure(now: number): Candle[] {
  const h1 = candlesFromCloses(Array(21).fill(100), now);
  const avgVol = h1.slice(-21, -1).reduce((s, c) => s + c.volume, 0) / 20;
  const prev = h1[h1.length - 2];
  const bad = h1[h1.length - 1];
  bad.open = prev.close;
  bad.close = prev.close * 0.95; // -5%
  bad.high = prev.close * 1.001;
  bad.low = bad.close * 0.999;
  bad.volume = avgVol * 3.5;
  return h1;
}

function fallingOiSnapshot(symbol: string, now: number): DerivativesSnapshot {
  return {
    symbol,
    openInterestHistory: [
      { openInterest: 1_000_000, timestamp: now - 3 * TF_1H },
      { openInterest: 900_000, timestamp: now }
    ],
    fetchedAt: now
  };
}

function buyEvaluation(symbol: string, price = 100): SignalEvaluation {
  return {
    symbol, action: 'buy', tradeType: 'SPOT', tradeSide: 'BUY', confidence: 90,
    price, priceChange24h: -5, reasoning: 'setup qualified', status: 'SIGNAL SPOT BUY',
    willExecute: true, factors: [], confidenceGap: 0
  } as unknown as SignalEvaluation;
}

describe('applySellPressureOverride — the shared gate Pro/Path/Bybit now share with Intraday', () => {
  it('overrides a qualified BUY to a blocked hold when H1 shows a LA/FLOCK-shaped sell-pressure bar with falling OI', () => {
    const now = Date.now();
    const ev = buyEvaluation('FLOCKUSDT');
    const h1 = h1WithSellPressure(now);
    const result = applySellPressureOverride(ev, h1, fallingOiSnapshot('FLOCKUSDT', now), now);

    expect(result.action).toBe('hold');
    expect(result.willExecute).toBe(false);
    expect(result.status).toBe('NO_SIGNAL [MACRO]');
    expect(result.reasoning).toContain('לחץ מכירה');
  });

  it('does NOT override a qualified BUY when OI is rising on the same drop (not distribution)', () => {
    const now = Date.now();
    const ev = buyEvaluation('FLOCKUSDT');
    const h1 = h1WithSellPressure(now);
    const risingOi: DerivativesSnapshot = {
      symbol: 'FLOCKUSDT',
      openInterestHistory: [
        { openInterest: 1_000_000, timestamp: now - 3 * TF_1H },
        { openInterest: 1_100_000, timestamp: now }
      ],
      fetchedAt: now
    };
    const result = applySellPressureOverride(ev, h1, risingOi, now);
    expect(result).toBe(ev); // unchanged, same reference — no override applied
  });

  it('is a no-op on a HOLD evaluation — nothing to override', () => {
    const now = Date.now();
    const hold: SignalEvaluation = { ...buyEvaluation('FLOCKUSDT'), action: 'hold', willExecute: false };
    const result = applySellPressureOverride(hold, h1WithSellPressure(now), fallingOiSnapshot('FLOCKUSDT', now), now);
    expect(result).toBe(hold);
  });

  it('abstains (does not block) when derivatives data is entirely missing — same rule as detectSellPressure itself', () => {
    const now = Date.now();
    const ev = buyEvaluation('FLOCKUSDT');
    const result = applySellPressureOverride(ev, h1WithSellPressure(now), undefined, now);
    expect(result).toBe(ev);
  });

  it('does not fire on a calm H1 series (no volume spike, no drop)', () => {
    const now = Date.now();
    const ev = buyEvaluation('BTCUSDT');
    const calmH1 = candlesFromCloses(Array(21).fill(100), now);
    const result = applySellPressureOverride(ev, calmH1, fallingOiSnapshot('BTCUSDT', now), now);
    expect(result).toBe(ev);
  });

  it('blocks a SELL/SHORT evaluation too — the gate is direction-agnostic, same as Intraday GATE 6', () => {
    const now = Date.now();
    const shortEv: SignalEvaluation = { ...buyEvaluation('FLOCKUSDT'), action: 'sell', tradeSide: 'SHORT' };
    const result = applySellPressureOverride(shortEv, h1WithSellPressure(now), fallingOiSnapshot('FLOCKUSDT', now), now);
    expect(result.action).toBe('hold');
    expect(result.willExecute).toBe(false);
  });
});
