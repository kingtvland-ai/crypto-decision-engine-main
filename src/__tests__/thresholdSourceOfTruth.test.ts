import { describe, it, expect } from 'vitest';
import {
  applyProEntryGates,
  buildProEvaluation,
  type ProGateContext,
  type PendingOrder
} from '@cde/engine/execution';
import {
  computeProSignal,
  evaluateProExit,
  proMinConfidence,
  calculateOptimalEntryPrice,
  PRO_DEFAULT_ENTRY_CONFIDENCE,
  PRO_CONFIDENCE_BY_RISK,
  PRO_STOP_LOSS_PERCENT,
  PRO_TAKE_PROFIT_PERCENT,
  PRO_ALG_MIN_CANDLES,
  proStopTpLevels,
  type ProSignalResult,
  type ProRiskLevel
} from '@cde/engine/analysis';
import type { Candle, SignalEvaluation } from '@cde/engine';
import { TP2_PERCENT } from '@cde/engine/execution';

// Three §3/§4/§5 contracts, all of the same family — a number with two
// definitions that could disagree. This file used to test the PREVIOUS Pro
// engine's routing/adapter thresholds and the Legacy engine's dynamic floors;
// both are gone. What it covers now is the alg.md engine that replaced them:
//
//   §3 — the confidence floor comes from ONE place: the risk-level table,
//        with `minConfidenceOverride > 0` replacing it entirely.
//   §4 — the SignalEvaluation is the single source of truth: the gates run on
//        it, in the doc's order, over a confidence-descending batch.
//   §5 — the fixed-percentage exits (−4.2% / +3%) precede every signal, and
//        the flip-to-SELL exit is confidence-gated by the SAME §3 number.

// ── §3 — the threshold table is the single definition ────────────────────────

describe('§3 — minConfidence comes from the risk-level table, or an override', () => {
  it('low → 55, medium → 40, high → 25 (no override)', () => {
    expect(proMinConfidence('low')).toBe(55);
    expect(proMinConfidence('medium')).toBe(40);
    expect(proMinConfidence('high')).toBe(25);
  });

  it('a positive override replaces the table entirely', () => {
    expect(proMinConfidence('low', 85)).toBe(85);
    expect(proMinConfidence('high', 85)).toBe(85);
  });

  it('a zero or negative override is not an override — table value stands', () => {
    expect(proMinConfidence('medium', 0)).toBe(40);
    expect(proMinConfidence('medium', -3)).toBe(40);
    expect(proMinConfidence('medium', undefined)).toBe(40);
  });

  it('an unknown riskLevel falls back to the default 70', () => {
    expect(proMinConfidence('unknown' as ProRiskLevel)).toBe(70);
  });

  it('allocation is fixed at 10% of equity, regardless of confidence', () => {
    // Equity 10,000 → target = 10% = 1000. Per-asset cap is also 10%, so
    // the cap no longer binds — the position is exactly the target.
    const [ev70] = applyProEntryGates([buyEval('LA', 70)], gateCtx());
    expect(ev70.budgetUsd).toBeCloseTo(1000, 6);

    const [ev80] = applyProEntryGates([buyEval('LA', 80)], gateCtx());
    expect(ev80.budgetUsd).toBeCloseTo(1000, 6);

    const [ev81] = applyProEntryGates([buyEval('LA', 81)], gateCtx());
    expect(ev81.budgetUsd).toBeCloseTo(1000, 6);
  });
});

// ── §4 — the gates, in the doc's order, on the evaluation itself ─────────────

function buyEval(symbol: string, confidence: number): SignalEvaluation {
  return {
    symbol,
    action: 'buy',
    tradeType: 'SPOT',
    tradeSide: 'BUY',
    confidence,
    price: 100,
    priceChange24h: 1,
    reasoning: 'test',
    status: '',
    willExecute: false,
    factors: [],
    confidenceGap: 0
  } as SignalEvaluation;
}

function sellEval(symbol: string, confidence: number): SignalEvaluation {
  // Stub status — a real evaluation from buildProEvaluation carries its own.
  // 2026-09-17: an unheld SELL is now a real SHORT candidate through the
  // gates below (see the describe block), not the old "Spot never shorts,
  // untouched" no-op — except when the held position is already SHORT,
  // where it genuinely IS a same-direction no-op and this stub status
  // survives untouched (see that specific test).
  return {
    ...buyEval(symbol, confidence),
    action: 'sell',
    tradeSide: 'SELL',
    status: 'NO_SIGNAL [SPOT_SELL_UNSUPPORTED]'
  } as SignalEvaluation;
}

const queuedOrder = (symbol: string, confidence = 80): PendingOrder =>
  ({ id: `o-${symbol}`, symbol, side: 'buy', confidence } as unknown as PendingOrder);

// Correlation gate fixture (added 2026-09-16 alongside the gate itself): a
// deterministic, genuinely-uncorrelated candle series per symbol, so these
// slot/threshold tests exercise the NEW correlation gate on real (allowed)
// data instead of tripping its abstention cap (no candles → "cannot verify
// independence" → blocks once 3+ positions are already held, exactly what
// several of these fixtures set up). Each symbol gets its own phase-shifted
// sine wave — same timestamps so alignCloses can pair them, different enough
// shapes that Pearson correlation reads near zero.
const CORR_SYMBOLS = ['LA', 'HELD', 'OTHER', 'AA', 'BB', 'CC', 'MO'];
const testCandlesBySymbol: Record<string, Candle[]> = {};
for (const [idx, sym] of CORR_SYMBOLS.entries()) {
  const bars: Candle[] = [];
  for (let i = 0; i < 40; i++) {
    const close = 100 + 5 * Math.sin(i / (3 + idx) + idx * 1.7);
    bars.push({ timestamp: i * 3_600_000, open: close, high: close + 0.1, low: close - 0.1, close, volume: 1000 });
  }
  testCandlesBySymbol[sym] = bars;
}

const gateCtx = (over: Partial<ProGateContext> = {}): ProGateContext => ({
  positions: [],
  pending: [],
  cash: 10_000,
  equity: 10_000,
  initialAmount: 10_000,
  maxPositions: 3,
  riskLevel: 'medium',
  candlesBySymbol: testCandlesBySymbol,
  ...over
});

describe('§4 — the gate sequence runs in the doc\'s order, on the evaluation', () => {
  it('a queued order precedes the threshold check — "פקודה בתור ביצוע"', () => {
    const [ev] = applyProEntryGates([buyEval('LA', 90)], gateCtx({ pending: [queuedOrder('LA')] }));
    expect(ev.status).toBe('NO_SIGNAL [ORDER_QUEUED]');
    expect(ev.reasoning).toBe('פקודה בתור ביצוע');
    expect(ev.willExecute).toBe(false);
  });

  it('held precedes the threshold check — "כבר מוחזק בתיק"', () => {
    const held = { id: 'p1', symbol: 'LA' } as never;
    const [ev] = applyProEntryGates([buyEval('LA', 30)], gateCtx({ positions: [held] }));
    expect(ev.status).toBe('NO_SIGNAL [ALREADY_HELD]');
    expect(ev.reasoning).toBe('כבר מוחזק בתיק');
  });

  it('below the §3 floor is refused, with the gap reported', () => {
    const [ev] = applyProEntryGates([buyEval('LA', 30)], gateCtx());
    expect(ev.status).toBe('NO_SIGNAL [BELOW_THRESHOLD]');
    expect(ev.willExecute).toBe(false);
    expect(ev.confidenceGap).toBeCloseTo(10, 6); // medium threshold 40 − 30
  });

  it('no free slot → NO_SLOTS (queued buys occupy slots too; incumbent not weak enough to evict)', () => {
    const held = { id: 'p1', symbol: 'HELD' } as never;
    const [ev] = applyProEntryGates([buyEval('LA', 80)], gateCtx({
      positions: [held],
      pending: [queuedOrder('OTHER', 80)], // equal strength — margin not met
      maxPositions: 2
    }));
    expect(ev.status).toBe('NO_SIGNAL [NO_SLOTS]');
  });

  it('equity wiped out → CAPITAL_FLOOR, the gate that replaced equity-based shrinking', () => {
    // $4 left of a $10,000 start is far below the 30% floor. Entries stop - and
    // they stop for a stated reason, not by silently sizing down to nothing.
    const [ev] = applyProEntryGates([buyEval('LA', 80)], gateCtx({ cash: 4, equity: 4 }));
    expect(ev.status).toBe('NO_SIGNAL [CAPITAL_FLOOR]');
    expect(ev.willExecute).toBe(false);
  });

  it('a 50% drawdown still trades at FULL size - above the 30% floor', () => {
    // The operator's rule verbatim: even at a 50% loss the bot keeps entering
    // at the size fixed against its starting capital.
    const [ev] = applyProEntryGates([buyEval('LA', 80)], gateCtx({ cash: 5_000, equity: 5_000 }));
    expect(ev.status).toBe('SIGNAL SPOT BUY');
    expect(ev.budgetUsd).toBeCloseTo(1000, 6); // 10% of the $10,000 START
  });

  it('the floor sits at 30% of starting capital - checked either side of the line', () => {
    const justAbove = applyProEntryGates([buyEval('LA', 80)], gateCtx({ cash: 9_000, equity: 3_001 }))[0];
    expect(justAbove.status).toBe('SIGNAL SPOT BUY');
    const justBelow = applyProEntryGates([buyEval('LA', 80)], gateCtx({ cash: 9_000, equity: 2_999 }))[0];
    expect(justBelow.status).toBe('NO_SIGNAL [CAPITAL_FLOOR]');
  });

  it('budget is allocated against CASH, not equity (cash-based sizing)', () => {
    // $150 cash but $10,000 equity → target = 10% × 10k = 1000, but cash caps at 150.
    const [ev] = applyProEntryGates([buyEval('LA', 80)], gateCtx({ cash: 150, equity: 10_000 }));
    expect(ev.status).toBe('SIGNAL SPOT BUY');
    expect(ev.willExecute).toBe(true);
    expect(ev.budgetUsd).toBeCloseTo(150, 6); // capped at available cash
  });

  it('low cash still refuses at the $100 order floor - cash is a hard constraint', () => {
    // $50 free cash against a $1,000 target. Equity is healthy so the capital
    // floor does not fire; cash trims the budget under MIN_SIM_ENTRY_USD.
    const [ev] = applyProEntryGates([buyEval('LA', 80)], gateCtx({ cash: 50, equity: 10_000 }));
    expect(ev.status).toBe('NO_SIGNAL [MIN_ORDER_EXCEEDS_POSITION_TARGET]');
    expect(ev.willExecute).toBe(false);
  });

  it('a bot started below $1,000 cannot trade at all - the floor now bites the START', () => {
    // KNOWN CONSEQUENCE of pinning size to starting capital: 10% of a $500
    // start is $50, under the $100 order floor, and no equity level rescues it.
    // Profits do not help either - the base never moves. A bot must be started
    // with at least MIN_SIM_ENTRY_USD / POSITION_TARGET_PCT = $1,000.
    const [ev] = applyProEntryGates([buyEval('LA', 80)], gateCtx({ initialAmount: 500, cash: 10_000, equity: 10_000 }));
    expect(ev.status).toBe('NO_SIGNAL [MIN_ORDER_EXCEEDS_POSITION_TARGET]');
    expect(ev.willExecute).toBe(false);
  });

  it('$1,000 is exactly the smallest workable starting capital', () => {
    const [ev] = applyProEntryGates([buyEval('LA', 80)], gateCtx({ initialAmount: 1_000, cash: 1_000, equity: 1_000 }));
    expect(ev.status).toBe('SIGNAL SPOT BUY');
    expect(ev.budgetUsd).toBeCloseTo(100, 6);
  });

  it('every gate passed → willExecute, "מבצע קנייה", and the allocated budget', () => {
    // 10% of 10,000 equity = 1000, per-asset cap is also 10% = 1000.
    const [ev] = applyProEntryGates([buyEval('LA', 80)], gateCtx());
    expect(ev.status).toBe('SIGNAL SPOT BUY');
    expect(ev.willExecute).toBe(true);
    expect(ev.budgetUsd).toBeCloseTo(1000, 6);
  });

  it('confidence no longer affects allocation — always 10% of equity', () => {
    // confidence 85 used to give 15%; now it is the same 10% target.
    const [ev] = applyProEntryGates([buyEval('LA', 85)], gateCtx());
    expect(ev.status).toBe('SIGNAL SPOT BUY');
    expect(ev.willExecute).toBe(true);
    expect(ev.budgetUsd).toBeCloseTo(1000, 6);
  });

  it('allocation is 10% of initialAmount, not equity (inverted 2026-09-08)', () => {
    // A 100x gain does not grow the position either - the base is fixed in both
    // directions. $1,000 start means $100 positions, at any equity.
    const [ev] = applyProEntryGates([buyEval('LA', 85)], gateCtx({ initialAmount: 1000, equity: 100_000, cash: 100_000 }));
    expect(ev.budgetUsd).toBeCloseTo(100, 6);
  });

  it('a starting capital under the order floor is refused, not rounded up', () => {
    // 10% of a $1 start = $0.10. MIN_ORDER stays a constraint, never a size.
    const [ev] = applyProEntryGates([buyEval('LA', 95)], gateCtx({ initialAmount: 1, equity: 1, cash: 1 }));
    expect(ev.status).toBe('NO_SIGNAL [MIN_ORDER_EXCEEDS_POSITION_TARGET]');
  });
});

// ── §4 gate 5 — slot preemption: a resting buy is a reservation, not a position
describe('§4 — a clearly stronger BUY evicts the weakest RESTING buy from its slot', () => {
  it('full slots, weak incumbent → SIGNAL + preemptsOrderId (the tick loop cancels it)', () => {
    const [ev] = applyProEntryGates([buyEval('LA', 85)], gateCtx({
      pending: [queuedOrder('AA', 82), queuedOrder('BB', 60), queuedOrder('CC', 78)],
      maxPositions: 3
    }));
    expect(ev.status).toBe('SIGNAL SPOT BUY');
    expect(ev.willExecute).toBe(true);
    expect(ev.preemptsOrderId).toBe('o-BB'); // the weakest of the three
  });

  it('not clearly stronger (< +5 margin) → NO_SLOTS, incumbent untouched', () => {
    const [ev] = applyProEntryGates([buyEval('LA', 63)], gateCtx({
      pending: [queuedOrder('AA', 80), queuedOrder('BB', 60)],
      maxPositions: 2
    }));
    expect(ev.status).toBe('NO_SIGNAL [NO_SLOTS]');
    expect(ev.preemptsOrderId).toBeUndefined();
  });

  it('a filled position is never preemptible — only pending orders are', () => {
    const held = { id: 'p1', symbol: 'HELD', confidence: 10 } as never;
    const [ev] = applyProEntryGates([buyEval('LA', 99)], gateCtx({
      positions: [held],
      maxPositions: 1
    }));
    expect(ev.status).toBe('NO_SIGNAL [NO_SLOTS]');
  });

  it('full slots, two strong candidates → only one eviction per resting order; the other waits', () => {
    const evs = applyProEntryGates(
      [buyEval('LA', 90), buyEval('MO', 88)],
      gateCtx({ pending: [queuedOrder('AA', 50), queuedOrder('BB', 84)], maxPositions: 2 })
    );
    const la = evs.find((e) => e.symbol === 'LA')!;
    const mo = evs.find((e) => e.symbol === 'MO')!;
    expect(la.status).toBe('SIGNAL SPOT BUY');
    expect(la.preemptsOrderId).toBe('o-AA');
    // MO (88) would need to beat BB (84) by +5 — it does not, and AA is already claimed.
    expect(mo.status).toBe('NO_SIGNAL [NO_SLOTS]');
    expect(mo.preemptsOrderId).toBeUndefined();
  });
});

describe('§4 — the sell logic: SHORT capability (2026-09-17), a held LONG closes whole', () => {
  it('a SELL with no position and no futures slots (default cap 0) is blocked, not silently dropped', () => {
    // maxFuturesPositions unset here → ctx.maxFuturesPositions ?? 0, same net
    // effect as before this feature existed (SHORT stays off unless configured).
    const [ev] = applyProEntryGates([sellEval('LA', 90)], gateCtx());
    expect(ev.willExecute).toBe(false);
    expect(ev.status).toBe('NO_SIGNAL [MAX_FUTURES]');
  });

  it('a SELL with no position opens a SHORT (1x FUTURES) once futures slots exist', () => {
    const [ev] = applyProEntryGates([sellEval('LA', 90)], gateCtx({ maxFuturesPositions: 2 }));
    expect(ev.status).toBe('SIGNAL FUTURES SHORT');
    expect(ev.willExecute).toBe(true);
    expect(ev.tradeType).toBe('FUTURES');
  });

  it('a SELL on a held LONG above the threshold is a full-position close signal (the flip)', () => {
    const held = { id: 'p1', symbol: 'LA', side: 'BUY' } as never;
    const [ev] = applyProEntryGates([sellEval('LA', 80)], gateCtx({ positions: [held] }));
    expect(ev.status).toBe('SIGNAL SPOT SELL');
    expect(ev.willExecute).toBe(true);
  });

  it('a SELL flip below the threshold leaves the held LONG to §5\'s SL/TP', () => {
    const held = { id: 'p1', symbol: 'LA', side: 'BUY' } as never;
    const [ev] = applyProEntryGates([sellEval('LA', 20)], gateCtx({ positions: [held] }));
    expect(ev.status).toBe('NO_SIGNAL [BELOW_THRESHOLD]');
    expect(ev.willExecute).toBe(false);
    expect(ev.reasoning).toContain('SL/TP');
  });

  it('a SELL on a symbol already held SHORT is a no-op — already positioned this direction', () => {
    const heldShort = { id: 'p1', symbol: 'LA', side: 'SHORT' } as never;
    const [ev] = applyProEntryGates([sellEval('LA', 90)], gateCtx({ positions: [heldShort], maxFuturesPositions: 2 }));
    expect(ev.willExecute).toBe(false);
    expect(ev.status).toBe('NO_SIGNAL [SPOT_SELL_UNSUPPORTED]'); // untouched — the fixture's own stub status
  });
});

// ── §5 — the fixed exits precede everything, and use the §3 number ───────────

const stubSignal = (
  action: 'BUY' | 'SELL' | 'HOLD',
  confidence: number,
  scores: { buyScore?: number; sellScore?: number } = {}
): ProSignalResult => ({
  action,
  buyScore: scores.buyScore ?? 0,
  sellScore: scores.sellScore ?? 0,
  holdScore: 0,
  totalWeight: 105,
  confidence,
  atrPercent: 0,
  signals: [],
  indicators: {} as ProSignalResult['indicators']
});

describe('§5 — fixed-percentage exits, independent of the recommendation', () => {
  const minConfidence = proMinConfidence('medium'); // 40

  it(`closes at −${PRO_STOP_LOSS_PERCENT}% — "Stop Loss"`, () => {
    const d = evaluateProExit({ entryPrice: 100 }, 100 - PRO_STOP_LOSS_PERCENT, stubSignal('BUY', 90), minConfidence);
    expect(d.shouldExit).toBe(true);
    expect(d.reason).toContain('Stop Loss');
  });

  it(`takes a PARTIAL at +${PRO_TAKE_PROFIT_PERCENT}% — TP1, half out (2026-09-08)`, () => {
    // Was a full close at 3%. The operator's ladder banks half here and lets
    // the rest run to TP2 at 4.5%.
    const d = evaluateProExit({ entryPrice: 100 }, 100 + PRO_TAKE_PROFIT_PERCENT, stubSignal('BUY', 90), minConfidence);
    expect(d.shouldExit).toBe(true);
    expect(d.exitType).toBe('PARTIAL_50');
    expect(d.reason).toContain('TP1');
  });

  it(`closes fully at +${TP2_PERCENT}% — TP2`, () => {
    const d = evaluateProExit({ entryPrice: 100 }, 100 + TP2_PERCENT, stubSignal('BUY', 90), minConfidence);
    expect(d.shouldExit).toBe(true);
    expect(d.exitType).toBe('FULL');
    expect(d.reason).toContain('TP2');
  });

  it('does not take the partial twice — tp1Hit holds it', () => {
    const d = evaluateProExit(
      { entryPrice: 100, tp1Hit: true },
      100 + PRO_TAKE_PROFIT_PERCENT + 0.5,
      stubSignal('BUY', 90),
      minConfidence
    );
    expect(d.exitType).not.toBe('PARTIAL_50');
    expect(d.shouldExit).toBe(false);
  });

  it('the runner rides a dip below TP1 as long as it stays above break-even', () => {
    // 2026-09-11: no longer a hair-trigger close. Above entry → keep running.
    const d = evaluateProExit(
      { entryPrice: 100, tp1Hit: true },
      100 + PRO_TAKE_PROFIT_PERCENT - 0.5, // below TP1, still +2.5%
      stubSignal('BUY', 90),
      minConfidence
    );
    expect(d.shouldExit).toBe(false);
  });

  it('the runner closes at break-even, not a loss, once price returns to entry', () => {
    const d = evaluateProExit(
      { entryPrice: 100, tp1Hit: true },
      100 - 0.01,
      stubSignal('BUY', 90),
      minConfidence
    );
    expect(d.shouldExit).toBe(true);
    expect(d.exitType).toBe('FULL');
    expect(d.reason).toContain('Break-even');
  });

  it('a SHORT is measured with the short formula, not the long one', () => {
    // Price DOWN from entry is a profit for a short. Under the old inline
    // `(current - entry) / entry` this read as -3% and tripped the stop.
    const win = evaluateProExit(
      { entryPrice: 100, isLong: false },
      100 - PRO_TAKE_PROFIT_PERCENT,
      stubSignal('BUY', 90),
      minConfidence
    );
    expect(win.exitType).toBe('PARTIAL_50');
    expect(win.reason).toContain('TP1');

    const loss = evaluateProExit(
      { entryPrice: 100, isLong: false },
      100 + PRO_STOP_LOSS_PERCENT,
      stubSignal('BUY', 90),
      minConfidence
    );
    expect(loss.exitType).toBe('FULL');
    expect(loss.reason).toContain('Stop Loss');
  });

  it('holds inside the band even while the recommendation is still buy', () => {
    const d = evaluateProExit({ entryPrice: 100 }, 100.5, stubSignal('BUY', 90), minConfidence);
    expect(d.shouldExit).toBe(false);
  });

  it('the flip-to-SELL exit needs Flip Hysteresis (2026-09-18): confidence AND a score margin, not just §3\'s entry number', () => {
    // Below minConfidence entirely — never flips regardless of score shape.
    const below = evaluateProExit({ entryPrice: 100 }, 99, stubSignal('SELL', 30, { sellScore: 60, buyScore: 10 }), minConfidence);
    expect(below.shouldExit).toBe(false);

    // Confidence clears the OLD (entry) threshold but not FLIP_THRESHOLD
    // (minConfidence + 4) — must NOT flip; this is exactly the case the old
    // gate (bare minConfidence) used to let through.
    const belowFlipThreshold = evaluateProExit(
      { entryPrice: 100 }, 99, stubSignal('SELL', minConfidence + 1, { sellScore: 60, buyScore: 10 }), minConfidence
    );
    expect(belowFlipThreshold.shouldExit).toBe(false);

    // Confidence clears FLIP_THRESHOLD but the opposing score barely beats
    // the position's own direction (margin < 4) — still must not flip.
    const belowScoreMargin = evaluateProExit(
      { entryPrice: 100 }, 99, stubSignal('SELL', 90, { sellScore: 52, buyScore: 50 }), minConfidence
    );
    expect(belowScoreMargin.shouldExit).toBe(false);

    // Both conditions clear — flips.
    const above = evaluateProExit(
      { entryPrice: 100 }, 99, stubSignal('SELL', 90, { sellScore: 60, buyScore: 10 }), minConfidence
    );
    expect(above.shouldExit).toBe(true);
    expect(above.reason).toContain('Flip Hysteresis');
  });
});

describe('Pro exit — ATR-scaled stop (no longer a flat 4.2% vs a 3% target)', () => {
  const minConfidence = proMinConfidence('medium');

  it('proStopTpLevels: stop = clamp(atr%×1.6, 1.8%, 4.2%), TP1 = 1.5× stop, TP2 = 1.5× TP1', () => {
    const mid = proStopTpLevels(100, 1.5, true); // atr 1.5% → stop 2.4%
    expect((100 - mid.stopLoss)).toBeCloseTo(2.4, 6);
    expect((mid.takeProfit1 - 100)).toBeCloseTo(3.6, 6);      // 1.5 × 2.4
    expect((mid.takeProfit2 - 100)).toBeCloseTo(5.4, 6);      // 1.5 × 3.6

    const lowVol = proStopTpLevels(100, 0.5, true);           // 0.8% → floored to 1.8%
    expect((100 - lowVol.stopLoss)).toBeCloseTo(1.8, 6);
    const highVol = proStopTpLevels(100, 5, true);            // 8% → capped at 4.2%
    expect((100 - highVol.stopLoss)).toBeCloseTo(4.2, 6);
  });

  it('a position carrying ATR-scaled levels exits on the price, not a flat −4.2%', () => {
    const lv = proStopTpLevels(100, 1.5, true); // stop at 97.6
    // Down 3% — beyond the ATR stop (2.4%) but nowhere near the old flat 4.2%.
    const d = evaluateProExit(
      { entryPrice: 100, isLong: true, stopLoss: lv.stopLoss, takeProfit1: lv.takeProfit1, takeProfit2: lv.takeProfit2 },
      97, stubSignal('BUY', 90), minConfidence
    );
    expect(d.shouldExit).toBe(true);
    expect(d.reason).toContain('Stop Loss');
  });

  it('a position with no stored levels still uses the flat §5 fallback (unchanged)', () => {
    const d = evaluateProExit({ entryPrice: 100 }, 100 - PRO_STOP_LOSS_PERCENT, stubSignal('BUY', 90), minConfidence);
    expect(d.shouldExit).toBe(true);
    expect(d.reason).toContain('Stop Loss');
  });
});

// ── warm-up floor ─────────────────────────────────────────────────────────────

describe('buildProEvaluation — the warm-up floor is honest about it', () => {
  it('reports NO_DATA before the candle floor, never a signal', () => {
    const candles: Candle[] = Array.from({ length: 10 }, (_, i) => ({
      timestamp: 1_700_000_000_000 + i * 3_600_000,
      open: 100, high: 101, low: 99, close: 100, volume: 1000
    }));
    const ev = buildProEvaluation('LA', candles, 100, 0, 'medium', undefined);
    expect(ev.status).toBe('NO_SIGNAL [NO_DATA]');
    expect(ev.willExecute).toBe(false);
  });

  it('accepts exactly PRO_ALG_MIN_CANDLES as the warm-up boundary', () => {
    const candles: Candle[] = Array.from({ length: PRO_ALG_MIN_CANDLES }, (_, i) => ({
      timestamp: 1_700_000_000_000 + i * 3_600_000,
      open: 100, high: 101, low: 99, close: 100, volume: 1000
    }));
    const ev = buildProEvaluation('LA', candles, 100, 0, 'medium', undefined);
    expect(ev.status).not.toBe('NO_SIGNAL [NO_DATA]');
  });
});

// ── alignment: high confidence ONLY ever means a BUY is firing ───────────────
//
// The raw confidence formula rewards dominance of ANY bucket, including HOLD —
// so a dominant HOLD vote can push confidence past 70% even though there is no
// directional signal. That makes the displayed number lie: the user sees "72%
// confidence" and expects a BUY, but the action is HOLD and nothing happens.
// computeProSignal now caps non-BUY outcomes at 50, so the number the user sees
// matches the entry decision: confidence ≥ 70% ⟹ a BUY is firing.

describe('alignment — confidence reflects directional conviction', () => {
  it('a dominant HOLD never reaches the entry bar — the user is not misled', () => {
    // Build a candle set that produces a clear HOLD: flat price, neutral
    // indicators. The action will be HOLD; confidence must stay below 50 even
    // if the raw formula would push it higher.
    const candles: Candle[] = Array.from({ length: 40 }, (_, i) => ({
      timestamp: 1_700_000_000_000 + i * 3_600_000,
      open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000 + (i % 3) * 50
    }));
    const signal = computeProSignal(candles, 0);
    if (signal.action === 'HOLD') {
      expect(signal.confidence).toBeLessThanOrEqual(50);
    }
  });

  it('a strong BUY clears the 70% bar — the user sees high confidence AND a buy', () => {
    // Strong uptrend with volume: price well above MA20, RSI in buy zone,
    // MACD bullish. This should produce a BUY with confidence ≥ 70%.
    const candles: Candle[] = Array.from({ length: 40 }, (_, i) => ({
      timestamp: 1_700_000_000_000 + i * 3_600_000,
      open: 80 + i * 1.5,
      high: 81 + i * 1.5,
      low: 79 + i * 1.5,
      close: 80 + i * 1.5,
      volume: 1000 + i * 100
    }));
    const signal = computeProSignal(candles, 12);
    if (signal.action === 'BUY') {
      expect(signal.confidence).toBeGreaterThanOrEqual(70);
    }
  });

  it('market regime (2026-09-18): a gentle uptrend never MANUFACTURES a BUY out of a raw HOLD', () => {
    // slope well under ATR + a sine wobble → RSI/Stoch/BB all sit mid-range
    // (bucket vote = HOLD), and EMA50 > EMA200, price just above EMA50 and
    // within 3×ATR of it (marketRegime = 'UP'). Before 2026-09-18 this used
    // to REWRITE the HOLD into a BUY the bucket vote never cast; now regime
    // only boosts an agreeing action or blocks a disagreeing one — it never
    // fabricates a direction from HOLD.
    const candles: Candle[] = Array.from({ length: 160 }, (_, i) => {
      // 155 bars of a very gentle rise, then a shallow 5-bar pullback that
      // lands price back on the EMA50 with the oscillators reset to neutral.
      const close = i < 155 ? 100 + i * 0.08 : (100 + 154 * 0.08) - (i - 154) * 0.22;
      return {
        timestamp: 1_700_000_000_000 + i * 3_600_000,
        open: close, high: close + 0.9, low: close - 0.9, close, volume: 1000
      };
    });
    const signal = computeProSignal(candles, 1);
    // The shallow pullback actually reads as a mild SELL on the raw bucket
    // vote (not a clean HOLD) — the point of this test either way: in an UP
    // regime, action must never become BUY unless rawSignal itself was BUY.
    expect(signal.rawSignal).not.toBe('BUY');
    expect(signal.marketRegime).toBe('UP');
    expect(signal.action).not.toBe('BUY'); // NOT promoted/rewritten to BUY
    expect(signal.confidence).toBeLessThanOrEqual(50); // NOT boosted either
  });

  it('market regime (2026-09-18): a genuine BUY riding the same uptrend still gets the confidence boost', () => {
    // Same gentle-uptrend shape, but this time seed a real oversold dip on
    // the last bar so the bucket vote itself casts BUY — the regime should
    // still boost it, since boosting an AGREEING raw signal is unchanged.
    const candles: Candle[] = Array.from({ length: 160 }, (_, i) => {
      if (i === 159) return {
        timestamp: 1_700_000_000_000 + i * 3_600_000,
        open: 112.5, high: 112.6, low: 108, close: 108.2, volume: 1000
      };
      const close = i < 155 ? 100 + i * 0.08 : (100 + 154 * 0.08) - (i - 154) * 0.22;
      return {
        timestamp: 1_700_000_000_000 + i * 3_600_000,
        open: close, high: close + 0.9, low: close - 0.9, close, volume: 1000
      };
    });
    const signal = computeProSignal(candles, 1);
    if (signal.rawSignal === 'BUY' && signal.marketRegime === 'UP') {
      expect(signal.action).toBe('BUY');
      expect(signal.confidence).toBeGreaterThanOrEqual(58);
    }
  });

  it('trend-participation lane stays out when price is extended far above EMA50', () => {
    // steep parabolic rise → price is many ATR above EMA50 → notExtended is
    // false → the lane must NOT manufacture a BUY (bucket vote decides).
    const candles: Candle[] = Array.from({ length: 160 }, (_, i) => {
      const close = 100 + i * i * 0.01;
      return {
        timestamp: 1_700_000_000_000 + i * 3_600_000,
        open: close - 0.5, high: close + 0.6, low: close - 0.6, close, volume: 1000
      };
    });
    const signal = computeProSignal(candles, 25);
    // whatever the bucket vote says, confidence must not carry the lane's
    // 58-floor boost — a non-BUY stays capped at 50.
    if (signal.action !== 'BUY') expect(signal.confidence).toBeLessThanOrEqual(50);
  });

  it('the displayed confidence never exceeds 50 when the action is not BUY', () => {
    // Sweep: for a HOLD-dominant scenario, confidence must be ≤ 50 so the
    // user never sees "high confidence, no entry".
    const candles: Candle[] = Array.from({ length: 40 }, (_, i) => ({
      timestamp: 1_700_000_000_000 + i * 3_600_000,
      open: 100 + Math.sin(i * 0.5) * 2,
      high: 102 + Math.sin(i * 0.5) * 2,
      low: 98 + Math.sin(i * 0.5) * 2,
      close: 100 + Math.sin(i * 0.5) * 2,
      volume: 1000
    }));
    const signal = computeProSignal(candles, 0);
    if (signal.action !== 'BUY') {
      expect(signal.confidence).toBeLessThanOrEqual(50);
    }
  });
});

describe('§6 — optimal entry price from support levels', () => {
  const mockSignal = (over: Partial<ProSignalResult> = {}): ProSignalResult => ({
    action: 'BUY',
    buyScore: 10,
    sellScore: 2,
    holdScore: 3,
    totalWeight: 88,
    confidence: 75,
    signals: [],
    indicators: {
      rsi: 35,
      ma20: 95,
      volumeTrend: 'increasing',
      bollingerBands: { upper: 110, middle: 100, lower: 90, position: 'between' },
      volumeProfile: { poc: 98, valueAreaHigh: 105, valueAreaLow: 92, position: 'in_value_area' },
      macd: { macd: 1, signal: 0.5, histogram: 0.5, trend: 'bullish' },
      stochastic: { k: 30, d: 25, signal: 'neutral' }
    },
    ...over
  } as ProSignalResult);

  it('computes an optimal entry price from indicator support levels', () => {
    const signal = mockSignal();
    const currentPrice = 100;
    const optimal = calculateOptimalEntryPrice(signal, currentPrice);

    // Should be between 90% and 100% of current price (support levels are lower)
    expect(optimal).toBeGreaterThanOrEqual(currentPrice * 0.90);
    expect(optimal).toBeLessThanOrEqual(currentPrice);
  });

  it('the optimal entry price is at or below current price (better entry)', () => {
    const signal = mockSignal();
    const currentPrice = 100;
    const optimal = calculateOptimalEntryPrice(signal, currentPrice);

    // The bot waits for a dip — entry should be at or below market
    expect(optimal).toBeLessThanOrEqual(currentPrice);
  });

  it('weights Bollinger lower band heavily (strong support)', () => {
    const signal = mockSignal({
      indicators: {
        rsi: 35,
        ma20: 95,
        volumeTrend: 'increasing',
        bollingerBands: { upper: 110, middle: 100, lower: 85, position: 'between' },
        volumeProfile: { poc: 98, valueAreaHigh: 105, valueAreaLow: 92, position: 'in_value_area' },
        macd: { macd: 1, signal: 0.5, histogram: 0.5, trend: 'bullish' },
        stochastic: { k: 30, d: 25, signal: 'neutral' }
      }
    });
    const currentPrice = 100;
    const optimal = calculateOptimalEntryPrice(signal, currentPrice);

    // Bollinger lower at 85 should pull the optimal price down
    expect(optimal).toBeLessThan(currentPrice);
    expect(optimal).toBeGreaterThanOrEqual(currentPrice * 0.90);
  });

  it('a sub-cent asset gets sub-cent precision, not rounded to the nearest cent', () => {
    // Observed live: a $0.02 coin (SKR) computed an optimal entry that rounded
    // to a flat 0.02 — one of at most three representable values at that
    // price scale — and sat on the wrong side of the market at 0.0205,
    // unable to ever cross. roundToPriceScale gives a sub-$0.01 price 6
    // decimals (matching formatDynamicPrice's own band), so a real support
    // level like 0.019850 survives instead of collapsing to 0.02.
    const signal = mockSignal({
      indicators: {
        rsi: 35,
        ma20: 0.0195,
        volumeTrend: 'increasing',
        bollingerBands: { upper: 0.022, middle: 0.02, lower: 0.0185, position: 'between' },
        volumeProfile: { poc: 0.0198, valueAreaHigh: 0.021, valueAreaLow: 0.0192, position: 'in_value_area' },
        macd: { macd: 0.0001, signal: 0.00005, histogram: 0.00005, trend: 'bullish' },
        stochastic: { k: 30, d: 25, signal: 'neutral' }
      }
    });
    const currentPrice = 0.0205;
    const optimal = calculateOptimalEntryPrice(signal, currentPrice);

    expect(optimal).toBeLessThan(currentPrice);
    expect(optimal).toBeGreaterThanOrEqual(currentPrice * 0.90);
    // The old flat toFixed(2) would have forced this to 0.02 exactly.
    expect(optimal).not.toBe(0.02);
  });
});