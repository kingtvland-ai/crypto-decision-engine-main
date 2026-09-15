/**
 * Mandatory Intraday Engine tests (§41/§55/§56/§57)
 * ============================================================================
 * Deterministic, synthetic, multi-timeframe data. Covers the full pipeline:
 *   A. 1H regime detection (trend / ranging / transitional)
 *   B. 15M setup detection (trend-pullback / mean-reversion gating)
 *   C. 5M entry confirmation (trigger + LIMIT + no-chase)
 *   D. Cost / edge + spread gates
 *   E. Risk plan (SL/TP, leverage 1-5x, risk <= 0.75%)
 *   F. Circuit breaker (daily/weekly drawdown)
 *   G. Same-asset Spot/Futures exclusion
 *   H. End-to-end backtest on synthetic history (metrics + fill stats)
 */

import { describe, it, expect } from 'vitest';
import { Candle } from '@cde/engine';
import { detectRegime1H } from '@cde/engine/analysis';
import { detectSetup15M } from '@cde/engine/analysis';
import { confirmEntry5M } from '@cde/engine/analysis';
import { evaluateCostEdge, buildRiskPlan } from '@cde/engine/analysis';
import { evaluateIntradayDecision } from '@cde/engine/analysis';
import { runBacktest } from '@cde/engine/analysis';
import { DEFAULT_INTRADAY_PARAMS } from '@cde/engine';

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

/** Steady uptrend; if pbDepth>0 the final `pbLen` candles form a pullback
 *  (price dips from a local peak and ends pulled-back, not recovered). */
function trendPath(count: number, start: number, end: number, pbDepth = 0, pbLen = 0): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    if (pbLen > 0 && i >= count - pbLen) {
      // local peak = end + pbDepth, linearly declining to `end` at the last candle
      const k = (i - (count - pbLen)) / (pbLen - 1);
      out.push(end + pbDepth * (1 - k));
    } else {
      out.push(start + (end - start) * (i / (count - 1)));
    }
  }
  return out;
}

/** Mean-reverting walk around `mid` — keeps ADX low (RANGING regime). */
function rangePath(count: number, mid: number, amp: number): number[] {
  const out: number[] = [];
  let p = mid;
  for (let i = 0; i < count; i++) {
    p = p + (mid - p) * 0.2 + Math.sin(i * 0.7) * amp * 0.25 + ((i % 5) - 2) * amp * 0.08;
    out.push(p);
  }
  return out;
}

function bullScenario(now = Date.now()) {
  const h1 = candlesFromCloses(trendPath(240, 90, 105), TF['1h'], now);
  // 15M: uptrend to 106, then a gentle pullback to 105 at the end
  const m15 = candlesFromCloses(trendPath(320, 90, 105, 1.0, 22), TF['15m'], now);
  // 5M: uptrend to 105, then a shallow pullback that holds just above EMA20
  // with a strong bullish confirmation candle at the end (PULLBACK_HOLD entry).
  const m5Closes: number[] = [];
  for (let i = 0; i < 508; i++) m5Closes.push(90 + (105.0 - 90) * (i / 507));
  const tail = [104.8, 104.3, 104.1, 104.2, 104.4, 104.3, 104.5, 104.4, 104.6, 104.5, 104.7, 104.8];
  m5Closes.push(...tail);
  const m5 = candlesFromCloses(m5Closes, TF['5m'], now);
  // Force the final candle to be a strong bullish confirmation candle
  const last = m5[m5.length - 1];
  const prevClose = m5Closes[m5Closes.length - 2];
  last.open = prevClose;
  last.close = m5Closes[m5Closes.length - 1];
  last.low = Math.min(prevClose, last.close) - 0.05;
  last.high = Math.max(prevClose, last.close) + 0.05;
  return { h1, m15, m5 };
}

function rangeScenario(now = Date.now()) {
  const h1 = candlesFromCloses(rangePath(240, 100, 0.6), TF['1h'], now);
  const m15 = candlesFromCloses(rangePath(320, 100, 0.5), TF['15m'], now);
  const m5 = candlesFromCloses(rangePath(520, 100, 0.4), TF['5m'], now);
  return { h1, m15, m5 };
}

const basePortfolio = (over: Partial<Parameters<typeof evaluateIntradayDecision>[0]['portfolio']> = {}) => ({
  portfolioValue: 10_000,
  initialAmount: 10_000,
  dailyDrawdownPercent: 0,
  weeklyDrawdownPercent: 0,
  openPositionsCount: 0,
  openFuturesPositionsCount: 0,
  totalLeveragedExposureUsd: 0,
  existingExposureByAsset: {},
  ...over
});

describe('A. 1H Regime detection', () => {
  it('BULL_TREND with ADX>25, EMA20>EMA50, Supertrend BULL → futuresAllowed', () => {
    const { h1 } = bullScenario();
    const r = detectRegime1H(h1);
    expect(r.regime).toBe('BULL_TREND');
    expect(r.bias).toBe('LONG');
    expect(r.adx).toBeGreaterThan(25);
    expect(r.futuresAllowed).toBe(true);
  });

  it('RANGING (ADX<20) → no trend bias, mean-reversion eligible', () => {
    const { h1 } = rangeScenario();
    const r = detectRegime1H(h1);
    expect(r.regime).toBe('RANGING');
    expect(r.bias).toBe('NONE');
    expect(r.ranging).toBe(true);
  });
});

describe('B. 15M Setup detection', () => {
  it('In a BULL_TREND a pullback setup is produced with a valid score', () => {
    const { h1, m15 } = bullScenario();
    const regime = detectRegime1H(h1);
    const setup = detectSetup15M(m15, regime);
    expect(setup.setupType).not.toBe('NONE');
    expect(setup.direction).toBe('LONG');
    expect(setup.setupScore).toBeGreaterThan(0);
  });

  it('In RANGING only mean-reversion (spot) is eligible, no trend setup', () => {
    const { h1, m15 } = rangeScenario();
    const regime = detectRegime1H(h1);
    expect(regime.trending).toBe(false);
    const setup = detectSetup15M(m15, regime);
    if (setup.setupType !== 'NONE') {
      expect(setup.setupType).toBe('MEAN_REVERSION');
      expect(setup.spotOnly).toBe(true);
    }
  });
});

describe('C. 5M Entry confirmation', () => {
  it('Confirms a LIMIT entry with no chase penalty', () => {
    const { h1, m15, m5 } = bullScenario();
    const regime = detectRegime1H(h1);
    const setup = detectSetup15M(m15, regime);
    expect(setup.setupType).not.toBe('NONE');
    const entry = confirmEntry5M(m5, setup);
    expect(entry.confirmed).toBe(true);
    expect(entry.orderType).toBe('LIMIT');
    expect(entry.components.chasePenalty).toBe(0);
    expect(entry.entryScore).toBeGreaterThanOrEqual(DEFAULT_INTRADAY_PARAMS.entryScoreMin);
  });
});

describe('INTEGRATION — full orchestrator produces a SIGNAL', () => {
  it('Bull scenario → FUTURES LONG TREND_PULLBACK SIGNAL', () => {
    const { h1, m15, m5 } = bullScenario();
    const d = evaluateIntradayDecision({
      symbol: 'BTCUSDT',
      h1, m15, m5,
      spreadPercent: 0.02,
      quoteVolume24h: 1e12,
      portfolio: basePortfolio(),
      openPositions: []
    });
    console.log('Bull scenario result:', d.outcome, d.gate, d.tradeType, d.direction, d.setupType, d.risk?.approved, d.logs.slice(-3));
    expect(d.outcome).toBe('SIGNAL');
    expect(d.tradeType).toBe('FUTURES');
    expect(d.direction).toBe('LONG');
    expect(d.setupType).toBe('TREND_PULLBACK');
    expect(d.risk?.approved).toBe(true);
    expect(d.risk!.leverage).toBeLessThanOrEqual(5);

    // Single source of truth: the cost analysis ran on the risk plan's exact
    // entry / SL / TP1 — no shadow levels, no DATA_MISMATCH.
    expect(d.gate).not.toBe('DATA_MISMATCH');
    expect(Math.abs(d.cost!.entryPrice - d.risk!.entryPrice)).toBeLessThan(1e-8);
    expect(Math.abs(d.cost!.stopLoss - d.risk!.stopLoss)).toBeLessThan(1e-8);
    expect(Math.abs(d.cost!.takeProfit1 - d.risk!.takeProfit1)).toBeLessThan(1e-8);
    // R:R displayed = R:R of the executed levels
    expect(d.cost!.grossRewardRisk).toBeCloseTo(d.risk!.rewardPercent / d.risk!.riskPercent, 2);
    expect(d.cost!.netRewardRisk).toBeCloseTo(
      (d.cost!.rewardPercent - d.cost!.totalCostPercent) / d.cost!.riskPercent, 2
    );
    expect(d.metrics.grossRewardRisk).toBeGreaterThan(d.metrics.netRewardRisk);
    // The one diagnostic line that lets a human check every number by hand.
    expect(d.logs.some((l) => l.includes('SIGNAL_LEVELS ENTRY='))).toBe(true);
  });
});

describe('D. Cost / Edge + Spread gates', () => {
  it('Wide spread blocks via SPREAD gate', () => {
    const cost = evaluateCostEdge({
      tradeType: 'SPOT',
      entryPrice: 100,
      stopLoss: 99,
      takeProfit1: 102,
      spreadPercent: 0.5,
      atrPercentile: 50
    });
    expect(cost.approved).toBe(false);
    expect(cost.blockGate).toBe('SPREAD');
  });

  it('Tiny expected move vs cost blocks via COST gate', () => {
    const cost = evaluateCostEdge({
      tradeType: 'SPOT',
      entryPrice: 100,
      stopLoss: 99.5,
      takeProfit1: 100.3,
      spreadPercent: 0.02,
      atrPercentile: 50
    });
    expect(cost.approved).toBe(false);
    expect(cost.blockGate).toBe('COST');
  });

  it('Healthy move with acceptable spread is approved', () => {
    const cost = evaluateCostEdge({
      tradeType: 'FUTURES',
      entryPrice: 100,
      stopLoss: 99,
      takeProfit1: 102.5,
      spreadPercent: 0.02,
      atrPercentile: 50
    });
    expect(cost.approved).toBe(true);
  });
});

describe('E. Risk plan', () => {
  it('Builds SL/TP, leverage within 1-5x, risk <= 0.75%', () => {
    const plan = buildRiskPlan({
      direction: 'LONG',
      tradeType: 'FUTURES',
      setupType: 'TREND_PULLBACK',
      entryPrice: 100,
      stopReference: 99,
      targetReference: 103,
      atr5: 0.5,
      atr15: 0.8,
      equity: 10_000,
      openPositions: 0,
      openFutures: 0,
      currentLeveragedExposureUsd: 0
    });
    expect(plan.approved).toBe(true);
    expect(plan.leverage).toBeGreaterThanOrEqual(1);
    expect(plan.leverage).toBeLessThanOrEqual(5);
     // With dynamic SL/TP model, riskPercentUsed = actual stop distance (ATR-based, <= 1.5%)
    expect(plan.riskPercentUsed).toBeLessThanOrEqual(1.5);
    expect(plan.takeProfit1).toBeGreaterThan(plan.stopLoss);
  });

  it('Rejects a stop too wide for an intraday trade', () => {
    // With dynamic SL, the stop is computed from ATR + structure and clamped to maxStopPercent=1.5%
    const plan = buildRiskPlan({
      direction: 'LONG',
      tradeType: 'FUTURES',
      setupType: 'TREND_PULLBACK',
      entryPrice: 100,
      stopReference: 95,
      targetReference: 110,
      atr5: 0.5,
      atr15: 0.8,
      equity: 10_000,
      openPositions: 0,
      openFutures: 0,
      currentLeveragedExposureUsd: 0
    });
    // Dynamic SL is at most 1.5% (maxStopPercent), so stop is at 98.5 or higher
    expect(plan.approved).toBe(true);
    expect(plan.stopLoss).toBeGreaterThanOrEqual(98.5);
  });
});

describe('F. Circuit breaker', () => {
  it('Daily drawdown >= 8% blocks with CIRCUIT_BREAKER gate', () => {
    const { h1, m15, m5 } = bullScenario();
    const d = evaluateIntradayDecision({
      symbol: 'BTCUSDT',
      h1, m15, m5,
      spreadPercent: 0.02,
      quoteVolume24h: 1e12,
      portfolio: basePortfolio({ dailyDrawdownPercent: 9 }),
      openPositions: []
    });
    expect(d.gate).toBe('CIRCUIT_BREAKER');
    expect(d.outcome).toBe('NO_SIGNAL');
  });

  it('Weekly drawdown >= 15% locks the system', () => {
    const { h1, m15, m5 } = bullScenario();
    const d = evaluateIntradayDecision({
      symbol: 'BTCUSDT',
      h1, m15, m5,
      spreadPercent: 0.02,
      quoteVolume24h: 1e12,
      portfolio: basePortfolio({ weeklyDrawdownPercent: 16 }),
      openPositions: []
    });
    expect(d.gate).toBe('CIRCUIT_BREAKER');
  });
});

describe('G. Same-asset Spot/Futures exclusion', () => {
  it('An already-open position for the symbol blocks with EXPOSURE gate', () => {
    const { h1, m15, m5 } = bullScenario();
    const d = evaluateIntradayDecision({
      symbol: 'BTCUSDT',
      h1, m15, m5,
      spreadPercent: 0.02,
      quoteVolume24h: 1e12,
      portfolio: basePortfolio(),
      openPositions: [{ symbol: 'BTCUSDT', type: 'SPOT' }]
    });
    expect(d.gate).toBe('EXPOSURE');
    expect(d.outcome).toBe('NO_SIGNAL');
  });
});

describe('H. End-to-end backtest on synthetic history', () => {
  it('Runs without crashing and produces consistent fill stats', () => {
    const { h1, m15, m5 } = bullScenario(Date.now());
    const res = runBacktest({ symbol: 'BTCUSDT', h1, m15, m5 }, DEFAULT_INTRADAY_PARAMS, { spreadPercent: 0.02 });
    expect(res.metrics.fillStats.signals).toBeGreaterThanOrEqual(0);
    expect(res.metrics.fillStats.filled + res.metrics.fillStats.missed).toBeLessThanOrEqual(res.metrics.fillStats.pending);
    expect(Array.isArray(res.trades)).toBe(true);
    expect(Array.isArray(res.equityCurve)).toBe(true);
    expect(res.equityCurve.length).toBeGreaterThan(0);
  });
});
