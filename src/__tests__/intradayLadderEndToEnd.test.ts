/**
 * Intraday — full pipeline SIGNAL with the ladder on (2026-09-14)
 * ============================================================================
 * `costGateLadderMismatch.test.ts` proved the FIX at the unit level
 * (buildRiskPlan + evaluateCostEdge in isolation). This proves it through the
 * REAL entry point the sim bot actually calls — `evaluateIntradayDecision`,
 * full 1H→15M→5M pipeline, `params: { calmRegimeScalp: true }` — because
 * that combination had NO test coverage at all before this bug was found:
 * every existing full-pipeline SIGNAL test (intradayMandatory.test.ts) uses
 * default params, so `calmRegimeScalp` was never on. That gap is exactly how
 * the bug shipped invisibly — this file exists so it cannot happen again the
 * same way.
 */

import { describe, it, expect } from 'vitest';
import { Candle } from '@cde/engine';
import { evaluateIntradayDecision } from '@cde/engine/analysis';
import { withParams } from '@cde/engine';

const TF = { '1h': 3_600_000, '15m': 900_000, '5m': 300_000 } as const;

function candlesFromCloses(closes: number[], tfMs: number, now: number, vol = 1000): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < closes.length; i++) {
    const c = closes[i];
    const prev = i > 0 ? closes[i - 1] : c;
    const open = prev;
    const close = c;
    const high = Math.max(open, close) * 1.0006 + 0.001;
    const low = Math.min(open, close) * 0.9994 - 0.001;
    out.push({ timestamp: now - (closes.length - i) * tfMs, open, high, low, close, volume: vol });
  }
  return out;
}

function trendPath(count: number, start: number, end: number, pbDepth = 0, pbLen = 0): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    if (pbLen > 0 && i >= count - pbLen) {
      const k = (i - (count - pbLen)) / (pbLen - 1);
      out.push(end + pbDepth * (1 - k));
    } else {
      out.push(start + (end - start) * (i / (count - 1)));
    }
  }
  return out;
}

/** Same construction as intradayMandatory.test.ts's `bullScenario` — a clean
 *  1H uptrend, a 15M pullback, and a confirmed 5M bounce. Kept local rather
 *  than imported so this file has no dependency on another test file's
 *  internals staying stable. */
function bullPullbackScenario(now = Date.now()) {
  const h1 = candlesFromCloses(trendPath(240, 90, 105), TF['1h'], now);
  const m15 = candlesFromCloses(trendPath(320, 90, 105, 1.0, 22), TF['15m'], now);
  const m5Closes: number[] = [];
  for (let i = 0; i < 508; i++) m5Closes.push(90 + (105.0 - 90) * (i / 507));
  const tail = [104.8, 104.3, 104.1, 104.2, 104.4, 104.3, 104.5, 104.4, 104.6, 104.5, 104.7, 104.8];
  m5Closes.push(...tail);
  const m5 = candlesFromCloses(m5Closes, TF['5m'], now);
  const last = m5[m5.length - 1];
  const prevClose = m5Closes[m5Closes.length - 2];
  last.open = prevClose;
  last.close = m5Closes[m5Closes.length - 1];
  last.low = Math.min(prevClose, last.close) - 0.05;
  last.high = Math.max(prevClose, last.close) + 0.05;
  return { h1, m15, m5 };
}

const basePortfolio = {
  portfolioValue: 10_000,
  initialAmount: 10_000,
  dailyDrawdownPercent: 0,
  weeklyDrawdownPercent: 0,
  openPositionsCount: 0,
  openFuturesPositionsCount: 0,
  totalLeveragedExposureUsd: 0,
  existingExposureByAsset: {}
};

describe('Intraday full pipeline — the ladder does not block a genuine SIGNAL', () => {
  it('the SAME bull-pullback scenario SIGNALs with calmRegimeScalp on, exactly as it does off', () => {
    const { h1, m15, m5 } = bullPullbackScenario();
    const input = {
      symbol: 'BTCUSDT', h1, m15, m5,
      spreadPercent: 0.02, quoteVolume24h: 1e12,
      portfolio: basePortfolio, openPositions: []
    };

    const off = evaluateIntradayDecision(input);
    expect(off.outcome).toBe('SIGNAL'); // sanity: the base scenario itself is sound

    const on = evaluateIntradayDecision({ ...input, params: withParams({ calmRegimeScalp: true }) });
    expect(on.gate).not.toBe('COST');
    expect(on.gate).not.toBe('DATA_MISMATCH');
    expect(on.outcome).toBe('SIGNAL');

    // The fixed ladder's own levels, not the dynamic ones `off` used.
    // riskPercent/rewardPercent/grossRewardRisk are TP1-relative DISPLAY
    // fields by design (rewardPercent = |TP1-entry|/entry — see
    // intradayRisk.ts) — TP1's own ratio is deliberately poor (1.8/2.3≈0.78),
    // that is not a bug. The real proof this signal survived is `approved`
    // being true despite that, and TP2 present at the ladder's 3.5%.
    expect(on.risk!.riskPercent).toBeCloseTo(2.3, 1);
    expect(on.risk!.rewardPercent).toBeCloseTo(1.8, 1);
    expect(on.risk!.approved).toBe(true);
    const tp2Pct = Math.abs(on.risk!.takeProfit2 - on.risk!.entryPrice) / on.risk!.entryPrice * 100;
    expect(tp2Pct).toBeCloseTo(3.5, 1);

    // What actually broke: COST measuring reward off TP1 (1.8/2.3≈0.78, net
    // ~0.67-0.73) instead of TP2 (3.5/2.3≈1.52) — the exact live symptom.
    // This is the assertion that would have failed before the fix.
    expect(on.cost!.netRewardRisk).toBeGreaterThanOrEqual(1.2);
  });

  it('a losing signal is still a losing signal — the ladder is not a bypass for every other gate', () => {
    // Circuit breaker still blocks entries regardless of the ladder.
    const { h1, m15, m5 } = bullPullbackScenario();
    const d = evaluateIntradayDecision({
      symbol: 'BTCUSDT', h1, m15, m5,
      spreadPercent: 0.02, quoteVolume24h: 1e12,
      portfolio: { ...basePortfolio, dailyDrawdownPercent: 9 },
      openPositions: [],
      params: withParams({ calmRegimeScalp: true })
    });
    expect(d.outcome).toBe('NO_SIGNAL');
    expect(d.gate).toBe('CIRCUIT_BREAKER');
  });
});
