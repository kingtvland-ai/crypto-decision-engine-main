/**
 * Macro Layer — Open Interest, Long/Short ratio, sell-pressure proxy, and the
 * funding gate wired in for the first time (2026-09-16, operator request).
 * ============================================================================
 * Two parts:
 *   1. Pure unit tests for derivativesRegime.ts (no candles, no pipeline).
 *   2. Integration tests proving the MACRO gate actually sits in
 *      evaluateIntradayDecision's pipeline: same SIGNAL-producing fixture as
 *      intradayMandatory.test.ts's bull scenario, with/without derivatives
 *      data, to show it (a) is a true no-op when data is absent (regression
 *      safety — the gate must never change behavior for the live bot, which
 *      supplies neither field today) and (b) actually blocks/trims when fed
 *      the exact LA/FLOCK-shaped data (2026-09-15 session).
 */

import { describe, it, expect } from 'vitest';
import { Candle } from '@cde/engine';
import { evaluateIntradayDecision } from '@cde/engine/analysis';
import {
  classifyOpenInterestTrend,
  classifyLongShortSentiment,
  evaluateDerivativesRegime,
  detectSellPressure,
  OI_TREND_THRESHOLD_PCT,
  LONG_SHORT_CROWDED_LONG_RATIO,
  LONG_SHORT_CROWDED_SHORT_RATIO,
  SELL_PRESSURE_REL_VOLUME,
  SELL_PRESSURE_MIN_DROP_PCT,
  type OpenInterestPoint
} from '@cde/engine/analysis';

// ── Part 1: pure derivativesRegime.ts ────────────────────────────────────────

function oiSeries(values: number[], startTs = 0, stepMs = 3_600_000): OpenInterestPoint[] {
  return values.map((v, i) => ({ openInterest: v, timestamp: startTs + i * stepMs }));
}

describe('classifyOpenInterestTrend', () => {
  it('rising: newest well above oldest', () => {
    const v = classifyOpenInterestTrend(oiSeries([1000, 1010, 1030, 1060]));
    expect(v.trend).toBe('rising');
    expect(v.changePercent).toBeCloseTo(6, 0);
  });

  it('falling: newest well below oldest — the LA/FLOCK shape', () => {
    const v = classifyOpenInterestTrend(oiSeries([1000, 980, 950, 900]));
    expect(v.trend).toBe('falling');
    expect(v.changePercent).toBeCloseTo(-10, 0);
  });

  it('flat: change stays under the threshold', () => {
    const v = classifyOpenInterestTrend(oiSeries([1000, 1005, 998, 1010]));
    expect(v.trend).toBe('flat');
  });

  it('unknown: fewer than 2 points, or a zero/invalid starting reading', () => {
    expect(classifyOpenInterestTrend([]).trend).toBe('unknown');
    expect(classifyOpenInterestTrend(oiSeries([1000])).trend).toBe('unknown');
    expect(classifyOpenInterestTrend(oiSeries([0, 500])).trend).toBe('unknown');
  });

  it('sorts defensively — the SAME timestamped points in array order (Bybit\'s own) still read as falling', () => {
    const properOrder = oiSeries([1000, 900]); // ascending timestamps: falling
    const bybitOrder = [properOrder[1], properOrder[0]]; // newest-first array order, timestamps unchanged
    const a = classifyOpenInterestTrend(properOrder);
    const b = classifyOpenInterestTrend(bybitOrder);
    expect(b.trend).toBe(a.trend);
    expect(b.changePercent).toBeCloseTo(a.changePercent, 5);
  });

  it('the threshold constant is the calibrated 1.5% (2026-09-16 study)', () => {
    expect(OI_TREND_THRESHOLD_PCT).toBe(1.5);
  });
});

describe('classifyLongShortSentiment — recalibrated to the REAL (non-symmetric) distribution', () => {
  it('crowded_long at/above the calibrated 0.78 (~p95 of the measured buyRatio distribution)', () => {
    expect(classifyLongShortSentiment({ buyRatio: 0.78, sellRatio: 0.22, timestamp: 0 })).toBe('crowded_long');
    expect(classifyLongShortSentiment({ buyRatio: 0.8, sellRatio: 0.2, timestamp: 0 })).toBe('crowded_long');
  });

  it('crowded_short at/below the calibrated 0.62 (~p5) — NOT the mirror of the long threshold', () => {
    expect(classifyLongShortSentiment({ buyRatio: 0.62, sellRatio: 0.38, timestamp: 0 })).toBe('crowded_short');
    expect(classifyLongShortSentiment({ buyRatio: 0.55, sellRatio: 0.45, timestamp: 0 })).toBe('crowded_short');
  });

  it('balanced in between — includes 0.73, the measured MEDIAN, which the original symmetric 0.65 cutoff would have wrongly called crowded_long', () => {
    expect(classifyLongShortSentiment({ buyRatio: 0.73, sellRatio: 0.27, timestamp: 0 })).toBe('balanced');
    expect(classifyLongShortSentiment({ buyRatio: 0.70, sellRatio: 0.30, timestamp: 0 })).toBe('balanced');
  });

  it('unknown when absent', () => {
    expect(classifyLongShortSentiment(undefined)).toBe('unknown');
  });

  it('the two threshold constants match the 2026-09-16 calibration (~p95 / ~p5, not a symmetric split)', () => {
    expect(LONG_SHORT_CROWDED_LONG_RATIO).toBe(0.78);
    expect(LONG_SHORT_CROWDED_SHORT_RATIO).toBe(0.62);
  });
});

describe('evaluateDerivativesRegime — advisory only, never blocks', () => {
  it('supportive: OI rising and sentiment not crowded against the direction', () => {
    const v = evaluateDerivativesRegime(
      { symbol: 'BTCUSDT', openInterestHistory: oiSeries([1000, 1100]), longShort: { buyRatio: 0.55, sellRatio: 0.45, timestamp: 0 }, fetchedAt: 0 },
      'LONG'
    );
    expect(v.supportive).toBe(true);
    expect(v.notes.some((n) => n.includes('OI עולה'))).toBe(true);
  });

  it('not supportive when the book is crowded against the direction, even with rising OI', () => {
    const v = evaluateDerivativesRegime(
      { symbol: 'BTCUSDT', openInterestHistory: oiSeries([1000, 1100]), longShort: { buyRatio: 0.8, sellRatio: 0.2, timestamp: 0 }, fetchedAt: 0 },
      'LONG'
    );
    expect(v.supportive).toBe(false);
    expect(v.notes.some((n) => n.includes('צפוף'))).toBe(true);
  });

  it('degrades to empty notes / not-supportive on a fully missing snapshot — never throws', () => {
    const v = evaluateDerivativesRegime(undefined, 'LONG');
    expect(v.oi.trend).toBe('unknown');
    expect(v.longShort).toBe('unknown');
    expect(v.supportive).toBe(false);
    expect(v.notes).toEqual([]);
  });
});

describe('detectSellPressure — the free Whale Alert substitute', () => {
  it('blocks on the full LA/FLOCK shape: volume spike + sharp drop + falling OI', () => {
    const v = detectSellPressure({
      relativeVolume: 3.2,
      priceChangePercent: -4.4,
      openInterestHistory: oiSeries([1000, 900])
    });
    expect(v.blocked).toBe(true);
    expect(v.oiTrend).toBe('falling');
    expect(v.reason).toContain('MACRO');
    expect(v.confirmedBy).toEqual(['oi']);
  });

  it('does NOT block the same drop when OI is RISING and there is no spot confirmation — fresh leveraged selling meeting fresh buying, not distribution', () => {
    const v = detectSellPressure({
      relativeVolume: 3.2,
      priceChangePercent: -4.4,
      openInterestHistory: oiSeries([1000, 1100])
    });
    expect(v.blocked).toBe(false);
    expect(v.confirmedBy).toEqual([]);
  });

  it('OTC blind-spot fix: blocks on unusual SPOT volume alone, even with OI rising — the case pure-OI detection would miss', () => {
    const v = detectSellPressure({
      relativeVolume: 3.2,
      priceChangePercent: -4.4,
      openInterestHistory: oiSeries([1000, 1100]), // OI rising — would NOT block alone
      spotRelativeVolume: 2.5 // but the dump hit the spot order book
    });
    expect(v.blocked).toBe(true);
    expect(v.confirmedBy).toEqual(['spot_volume']);
    expect(v.reason).toContain('נפח ספוט חריג');
  });

  it('both legs confirming is reported as both, not just one', () => {
    const v = detectSellPressure({
      relativeVolume: 3.2,
      priceChangePercent: -4.4,
      openInterestHistory: oiSeries([1000, 900]),
      spotRelativeVolume: 2.5
    });
    expect(v.blocked).toBe(true);
    expect(v.confirmedBy).toEqual(['oi', 'spot_volume']);
  });

  it('a spot volume reading BELOW the trigger does not confirm on its own', () => {
    const v = detectSellPressure({
      relativeVolume: 3.2,
      priceChangePercent: -4.4,
      openInterestHistory: oiSeries([1000, 1100]),
      spotRelativeVolume: 1.2
    });
    expect(v.blocked).toBe(false);
  });

  it('cross-exchange (Binance) round: blocks on unusual Binance volume alone, even with OI rising and no spot confirmation — the LA-shaped case (Binance 7.6x deeper than Bybit for that symbol)', () => {
    const v = detectSellPressure({
      relativeVolume: 3.2,
      priceChangePercent: -4.4,
      openInterestHistory: oiSeries([1000, 1100]), // rising — would not block alone
      crossExchangeRelativeVolume: 2.8
    });
    expect(v.blocked).toBe(true);
    expect(v.confirmedBy).toEqual(['cross_exchange_volume']);
    expect(v.reason).toContain('נפח Binance חריג');
  });

  it('all three legs confirming is reported together', () => {
    const v = detectSellPressure({
      relativeVolume: 3.2,
      priceChangePercent: -4.4,
      openInterestHistory: oiSeries([1000, 900]),
      spotRelativeVolume: 2.5,
      crossExchangeRelativeVolume: 2.8
    });
    expect(v.blocked).toBe(true);
    expect(v.confirmedBy).toEqual(['oi', 'spot_volume', 'cross_exchange_volume']);
  });

  it('a symbol not listed on Binance (crossExchangeRelativeVolume absent) still resolves on its other legs, not stuck abstaining', () => {
    const v = detectSellPressure({
      relativeVolume: 3.2,
      priceChangePercent: -4.4,
      openInterestHistory: oiSeries([1000, 900])
      // crossExchangeRelativeVolume omitted — e.g. VVVUSDT, not on Binance
    });
    expect(v.blocked).toBe(true);
    expect(v.confirmedBy).toEqual(['oi']);
  });

  it('does not block on volume + OI falling alone — needs the price drop too', () => {
    const v = detectSellPressure({
      relativeVolume: 3.2,
      priceChangePercent: -0.3,
      openInterestHistory: oiSeries([1000, 900])
    });
    expect(v.blocked).toBe(false);
  });

  it('does not block on a sharp drop with falling OI but no volume confirmation', () => {
    const v = detectSellPressure({
      relativeVolume: 0.8,
      priceChangePercent: -4.4,
      openInterestHistory: oiSeries([1000, 900])
    });
    expect(v.blocked).toBe(false);
  });

  it('abstains (never blocks) when OI data is entirely missing, regardless of volume/price', () => {
    const v = detectSellPressure({ relativeVolume: 5, priceChangePercent: -10 });
    expect(v.blocked).toBe(false);
    expect(v.oiTrend).toBe('unknown');
  });

  it('the two trigger constants match the documented defaults', () => {
    expect(SELL_PRESSURE_REL_VOLUME).toBe(2.0);
    expect(SELL_PRESSURE_MIN_DROP_PCT).toBe(1.5);
  });
});

// ── Part 2: wired into evaluateIntradayDecision ──────────────────────────────

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

/** Same bull scenario as intradayMandatory.test.ts's INTEGRATION describe —
 *  reproduced locally since that file's fixtures are not exported. Produces a
 *  confirmed FUTURES LONG TREND_PULLBACK SIGNAL with no macro data supplied. */
function bullScenario(now: number) {
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

describe('MACRO gate — integration with evaluateIntradayDecision', () => {
  it('regression: absent derivatives/funding data reproduces the exact pre-MACRO SIGNAL', () => {
    const now = Date.now();
    const { h1, m15, m5 } = bullScenario(now);
    const d = evaluateIntradayDecision({
      symbol: 'BTCUSDT', h1, m15, m5,
      spreadPercent: 0.02, quoteVolume24h: 1e12,
      portfolio: basePortfolio, openPositions: [], now
      // derivativesSnapshot / fundingSnapshot both omitted — the live bot's
      // exact situation today, since nothing yet feeds them there.
    });
    expect(d.outcome).toBe('SIGNAL');
    expect(d.gate).not.toBe('MACRO');
  });

  it('a symbol with a LA/FLOCK-shaped H1 close (volume spike + sharp drop + falling OI) is blocked at MACRO, before setup/entry ever run', () => {
    const now = Date.now();
    const { h1, m15, m5 } = bullScenario(now);
    // Overwrite the final H1 bar into a sell-pressure shape: a sharp drop on
    // a volume spike relative to the preceding 20 bars.
    const avgVol = h1.slice(-21, -1).reduce((s, c) => s + c.volume, 0) / 20;
    const prev = h1[h1.length - 2];
    const bad = h1[h1.length - 1];
    bad.open = prev.close;
    bad.close = prev.close * 0.95; // -5%
    bad.high = prev.close * 1.001;
    bad.low = bad.close * 0.999;
    bad.volume = avgVol * 3.5;

    const d = evaluateIntradayDecision({
      symbol: 'BTCUSDT', h1, m15, m5,
      spreadPercent: 0.02, quoteVolume24h: 1e12,
      portfolio: basePortfolio, openPositions: [], now,
      derivativesSnapshot: {
        symbol: 'BTCUSDT',
        openInterestHistory: oiSeries([1_000_000, 900_000], now - 3 * TF['1h'], TF['1h']),
        fetchedAt: now
      }
    });
    expect(d.outcome).toBe('NO_SIGNAL');
    expect(d.gate).toBe('MACRO');
    expect(d.logs.some((l) => l.includes('לחץ מכירה'))).toBe(true);
  });

  it('the SAME sharp drop with RISING open interest is NOT blocked at MACRO (may still fail later gates on its own merits)', () => {
    const now = Date.now();
    const { h1, m15, m5 } = bullScenario(now);
    const avgVol = h1.slice(-21, -1).reduce((s, c) => s + c.volume, 0) / 20;
    const prev = h1[h1.length - 2];
    const bad = h1[h1.length - 1];
    bad.open = prev.close;
    bad.close = prev.close * 0.95;
    bad.high = prev.close * 1.001;
    bad.low = bad.close * 0.999;
    bad.volume = avgVol * 3.5;

    const d = evaluateIntradayDecision({
      symbol: 'BTCUSDT', h1, m15, m5,
      spreadPercent: 0.02, quoteVolume24h: 1e12,
      portfolio: basePortfolio, openPositions: [], now,
      derivativesSnapshot: {
        symbol: 'BTCUSDT',
        openInterestHistory: oiSeries([1_000_000, 1_100_000], now - 3 * TF['1h'], TF['1h']),
        fetchedAt: now
      }
    });
    expect(d.gate).not.toBe('MACRO');
  });

  it('an extreme crowded funding reading vetoes the LONG signal at MACRO, right before sizing', () => {
    const now = Date.now();
    const { h1, m15, m5 } = bullScenario(now);
    const d = evaluateIntradayDecision({
      symbol: 'BTCUSDT', h1, m15, m5,
      spreadPercent: 0.02, quoteVolume24h: 1e12,
      portfolio: basePortfolio, openPositions: [], now,
      // annualisedFundingPct = rate * 1095 * 100. 0.0005 -> 54.75%/yr, past
      // FUNDING_EXTREME_ANNUAL_PCT (50).
      fundingSnapshot: { lastFundingRate: 0.0005, at: now }
    });
    expect(d.outcome).toBe('NO_SIGNAL');
    expect(d.gate).toBe('MACRO');
    expect(d.logs.some((l) => l.includes('FUNDING_GATE'))).toBe(true);
  });

  it('a moderately crowded funding reading trims sizing rather than blocking', () => {
    const now = Date.now();
    const { h1, m15, m5 } = bullScenario(now);
    // 0.00035 -> 38.3%/yr: above FUNDING_CROWDED_ANNUAL_PCT (25) but below
    // FUNDING_EXTREME_ANNUAL_PCT (50) — the trim band, not the veto band.
    const d = evaluateIntradayDecision({
      symbol: 'BTCUSDT', h1, m15, m5,
      spreadPercent: 0.02, quoteVolume24h: 1e12,
      portfolio: basePortfolio, openPositions: [], now,
      fundingSnapshot: { lastFundingRate: 0.00035, at: now }
    });
    expect(d.outcome).toBe('SIGNAL');
    expect(d.logs.some((l) => l.includes('FUNDING_GATE'))).toBe(true);
  });
});
