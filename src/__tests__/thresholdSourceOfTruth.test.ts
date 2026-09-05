import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  routeTradeType,
  evaluateExit,
  dynamicConfidenceThreshold,
  LEGACY_SPOT_BASE_THRESHOLD,
  LEGACY_FUTURES_BASE_THRESHOLD
} from '@cde/engine/execution';
import {
  routeProTradeType,
  proDynamicConfidenceThreshold,
  PRO_SPOT_BASE_THRESHOLD,
  PRO_FUTURES_BASE_THRESHOLD
} from '@cde/engine/analysis';
import type { ProSignalResult, ProMarketRegimeResult } from '@cde/engine/analysis';
import { ProAdapter } from '@cde/engine';
import type { MarketRegimeResult, SignalEngineResult, DecisionContext } from '@cde/engine';

// Three defects these cover, all of the same family — a threshold with two
// definitions that disagree:
//
//   1. Legacy Spot was a hard-coded 58 while Legacy Futures ramped with ATR, so
//      volatility tightened one leg and left the other where it was.
//   2. Legacy Futures used 72 while the routing comment directly above it
//      already documented "base 70".
//   3. Pro routed on rawConfidence while the adapter gated on the post-penalty
//      confidence, and then printed the post-penalty number in the approval
//      string for a decision the raw number had made.

function regime(over: Partial<MarketRegimeResult> = {}): MarketRegimeResult {
  return {
    regime: 'TRENDING',
    volatility: 'NORMAL',
    direction: 'BULL',
    adx: 30,
    atrPercent: 2,
    atr: 100,
    ...over
  } as MarketRegimeResult;
}

function signal(over: Partial<SignalEngineResult> = {}): SignalEngineResult {
  return {
    action: 'BUY',
    signalScore: 65,
    buyScore: 65,
    sellScore: 20,
    confidence: 65,
    signals: [],
    ...over
  } as SignalEngineResult;
}

describe('Legacy routes on regime and direction, not on a score bar', () => {
  // The score gates were REMOVED. Measured over six months they refused 87.7%
  // of all bars while the survivors won 43.3% of the time — a filter that
  // discards nine bars in ten without improving the tenth is not selecting, it
  // is only shrinking the sample. dynamicConfidenceThreshold and the two base
  // constants still exist and are still exported: they describe what the bot
  // USED to require, and the UI still reports them. They no longer gate.

  it('routes a low-scoring BUY that used to be refused', () => {
    const calm = regime({ regime: 'RANGING', adx: 15, atrPercent: 2 });
    // 40 is far under the old base of 58.
    expect(routeTradeType(signal({ signalScore: 40, confidence: 40 }), calm).type).toBe('SPOT');
  });

  it('does not tighten with volatility any more', () => {
    const wild = regime({ regime: 'RANGING', adx: 15, atrPercent: 8 });
    // The old ramp put the bar at 73 here; the same score now routes.
    expect(routeTradeType(signal({ signalScore: 58, confidence: 58 }), wild).type).toBe('SPOT');
  });

  it('still refuses when there is no directional edge', () => {
    // Direction is the algorithm's own judgement, not a threshold, and it stays.
    const calm = regime({ regime: 'RANGING', adx: 15, atrPercent: 2 });
    expect(routeTradeType(signal({ action: 'HOLD', signalScore: 90, confidence: 90 }), calm).type).toBe('HOLD');
  });

  it('still refuses SPOT in a TRANSITIONAL regime with weak ADX', () => {
    // The regime gate is a judgement about the market, not about the score, so
    // it survives — including for a signal that scores well.
    const transitional = regime({ regime: 'TRANSITIONAL', adx: 18, atrPercent: 2 });
    expect(routeTradeType(signal({ signalScore: 95, confidence: 95 }), transitional).type).toBe('HOLD');
  });

  it('still routes FUTURES only in a confirmed trend at safe volatility', () => {
    // Regime conditions are untouched: TRENDING + ADX>25 + LOW/NORMAL vol.
    const trending = regime({ regime: 'TRENDING', adx: 30, atrPercent: 2 });
    expect(routeTradeType(signal({ signalScore: 40, confidence: 40 }), trending).type).toBe('FUTURES');
    const ranging = regime({ regime: 'RANGING', adx: 15, atrPercent: 2 });
    expect(routeTradeType(signal({ signalScore: 99, confidence: 99 }), ranging).type).toBe('SPOT');
  });

  it('keeps the base constants exported for reporting', () => {
    expect(LEGACY_SPOT_BASE_THRESHOLD).toBe(58);
    expect(LEGACY_FUTURES_BASE_THRESHOLD).toBe(70);
    expect(dynamicConfidenceThreshold(LEGACY_FUTURES_BASE_THRESHOLD, 8)).toBe(85);
  });
});

// ── Pro ──────────────────────────────────────────────────────────────────────

function proRegime(over: Partial<ProMarketRegimeResult> = {}): ProMarketRegimeResult {
  return {
    regime: 'TRENDING',
    direction: 'BULL',
    volatility: 'NORMAL',
    adx: 30,
    atrPercent: 2,
    atr: 100,
    ...over
  } as ProMarketRegimeResult;
}

function proSignal(rawConfidence: number, confidence = rawConfidence): ProSignalResult {
  return {
    action: 'BUY',
    buyScore: rawConfidence,
    sellScore: 10,
    rawConfidence,
    confidence,
    signals: [],
    penalties: []
  };
}

describe('Test 9 — Pro routes on the post-penalty confidence', () => {
  it('routes on the post-penalty number, and says so', () => {
    // The score gates are gone, so a penalised signal is no longer BLOCKED by
    // one — but which number the engine reports must still be the one it used.
    // Printing the post-penalty confidence for a decision the raw score made
    // was the original defect, and it would still be a lie today.
    const routed = routeProTradeType(proSignal(74, 55), proRegime());
    expect(routed.reason).toContain('55');
    expect(routed.reason).not.toContain('74');
  });

  it('still routes when the penalties leave enough', () => {
    expect(routeProTradeType(proSignal(90, 75), proRegime()).type).toBe('FUTURES');
  });

  it('the approval string quotes the routing number, not a different one', () => {
    const routed = routeProTradeType(proSignal(90, 75), proRegime());
    expect(routed.reason).toContain('confidence 75');
  });

  it('routes every score the same way once the gates are gone', () => {
    // Regime decides, not the number. In a confirmed trend at safe volatility
    // every one of these routes FUTURES — including the 55 that the old base of
    // 72 refused.
    for (const score of [55, 60, 65, 70, 72, 80]) {
      expect(routeProTradeType(proSignal(score), proRegime()).type).toBe('FUTURES');
    }
  });

  it('the SOFT_TREND carve-out reads the post-penalty score too', () => {
    // TRANSITIONAL is a hard block unless the trend is soft-confirmed; that
    // carve-out used to be reachable on a raw score the penalties had removed.
    const transitional = proRegime({ regime: 'TRANSITIONAL', adx: 18 });
    const routed = routeProTradeType(proSignal(85, 40), transitional);
    expect(routed.type).toBe('HOLD');
    expect(routed.blockReason).toBe('TRANSITIONAL_HARD_BLOCK');
  });
});

describe('Test 10 — Pro base thresholds are exported and owned by the engine', () => {
  it('exports 60 / 72, matching alg.md', () => {
    expect(PRO_SPOT_BASE_THRESHOLD).toBe(60);
    expect(PRO_FUTURES_BASE_THRESHOLD).toBe(72);
  });

  it('Legacy and Pro are allowed to disagree — but each has ONE definition', () => {
    expect(LEGACY_FUTURES_BASE_THRESHOLD).not.toBe(PRO_FUTURES_BASE_THRESHOLD);
    // What matters is that both ramp through the same function.
    expect(dynamicConfidenceThreshold(70, 6)).toBe(proDynamicConfidenceThreshold(70, 6));
  });
});

// ── Test 10 (continued) — the configuration must actually bite ───────────────
//
// minConfidenceOverride is applied in ProAdapter.normalize(), AFTER the router
// has approved a trade. That placement is what made the §11 mismatch dangerous
// rather than merely untidy: routing said yes on the raw score, and this veto
// said no on the post-penalty one, so the operator saw a signal appear and then
// be refused a stage later under a gate name that explained nothing. With
// routing moved onto the same number, the two now agree by construction and
// this veto only ever raises the bar.

describe('Test 10 — minConfidenceOverride changes trade eligibility', () => {
  const routed = {
    outcome: 'SIGNAL' as const,
    gate: 'COMPLETE',
    logs: [],
    summary: 'ok',
    regime: proRegime(),
    signal: proSignal(90, 75),
    router: { type: 'FUTURES' as const, side: 'LONG' as const, reason: 'ok' },
    risk: undefined
  };
  const ctx = (minConfidenceOverride?: number) =>
    ({ symbol: 'BTC', config: { minConfidenceOverride } }) as unknown as DecisionContext;

  it('lets a 75-confidence signal through when the floor is below it', () => {
    const out = new ProAdapter().normalize(routed, ctx(58));
    expect(out.outcome).toBe('SIGNAL');
    expect(out.confidence).toBe(75);
  });

  it('blocks the SAME signal when the floor is raised above it', () => {
    const out = new ProAdapter().normalize(routed, ctx(80));
    expect(out.outcome).toBe('NO_SIGNAL');
    expect(out.gate).toBe('MIN_CONFIDENCE');
  });

  it('gates on the post-penalty confidence, not the raw score', () => {
    // raw 90, post-penalty 75. A floor of 80 must block: the raw number is not
    // the one on the table.
    expect(new ProAdapter().normalize(routed, ctx(80)).outcome).toBe('NO_SIGNAL');
  });

  it('omitting the override leaves the decision exactly as the engine made it', () => {
    const out = new ProAdapter().normalize(routed, ctx(undefined));
    expect(out.outcome).toBe('SIGNAL');
    expect(out.gate).toBe('COMPLETE');
  });
});

// ── The exit engines must not read the wall clock ────────────────────────────
//
// `evaluateExit` and `evaluateProExit` computed hold time as
// `Date.now() - openTimestamp`. In production that is right. In a replay of
// 2025 data it made every position look about a year old, so the 72-hour
// max-hold rule fired on the first exit check and no trade ever reached its
// stop or its target. Every Legacy and Pro backtest run before this fix was
// measuring a one-bar-hold strategy under those engines' names.

describe('exit timing is injected, not read from the clock', () => {
  const heldPosition = {
    id: 'x', symbol: 'BTC', type: 'SPOT' as const, side: 'BUY' as const,
    quantity: 1, entryPrice: 100, currentPrice: 101, avgPrice: 100,
    leverage: 1, marginUsd: 100, notionalUsd: 100,
    stopLoss: 95, takeProfit1: 110, takeProfit2: 120,
    highestPrice: 101, lowestPrice: 100, tp1Hit: false,
    openedAt: '', openTimestamp: Date.UTC(2025, 0, 1), entryFee: 0, reason: '', confidence: 50
  };
  const flat = { dailyDrawdownPercent: 0, weeklyDrawdownPercent: 0, systemLocked: false };
  const scores = { buy: 0, sell: 0 };

  it('does not time out a position that is one hour old on the bar’s clock', () => {
    const oneHourIn = heldPosition.openTimestamp + 3_600_000;
    const decision = evaluateExit(heldPosition, 101, 1, scores, { ...flat, now: oneHourIn });
    expect(decision.exitType).not.toBe('TIME_BASED');
  });

  it('DOES time out the same position once the hold budget passes', () => {
    // MAX_HOLD_HOURS.spot is 72.
    const wellPast = heldPosition.openTimestamp + 80 * 3_600_000;
    const decision = evaluateExit(heldPosition, 101, 1, scores, { ...flat, now: wellPast });
    expect(decision.shouldExit).toBe(true);
    expect(decision.exitType).toBe('TIME_BASED');
  });

  it('the backtest runner passes the bar timestamp, never Date.now()', () => {
    const runner = readFileSync(join(process.cwd(), 'server/backtestRunner.ts'), 'utf8');
    expect(runner).toContain('now: candle.timestamp');
    // Two call sites: checkExitLegacy and checkExitPro.
    expect(runner.match(/now: candle\.timestamp/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
