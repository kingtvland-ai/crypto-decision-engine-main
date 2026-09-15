// 4H Path engine — the empirical-bucket strategy that the fourth sim bot USED
// to run.
//
// STATUS (verified 2026-09-16 by call-graph, not by comment): the strategy
// half of this file — `evaluatePathDecision`, `pathKellyFraction`, the
// PathGate/PathDecision shapes — is NOT reachable from any bot. The bot named
// "Path" (`server/pathSimEngine.ts`) runs `prev4hRange.ts` instead. The
// DecisionEngine adapter that wrapped this engine was deleted the same day
// because it was exported and shown registered in the framework's own usage
// example while nothing actually registered it.
//
// The file stays because its MECHANICAL half is a live dependency:
// `aggregateToH4` is imported by prev4hRange.ts and prev4hRangeExecution.ts,
// and `MIN_PATH_CANDLES` / `PATH_MIN_H4_BARS` are re-exported for the candle
// warm-up. Those are timeframe arithmetic, not strategy. The strategy half is
// kept exported only so its unit tests (src/__tests__/pathEngine.test.ts)
// keep running against it; re-wiring it into a live path is a decision, not
// a refactor.
//
// The other three bots ask "is this a good setup". This one asks a narrower
// question with a measurable answer: given the state the current 4-hour bar
// opened in, which of its sixteen 15-minute slots has historically been the
// best moment to enter, and at what target?
//
// The statistics live in pathStudy.ts. This file is the runtime half: label the
// current bar, look the state up, and open a 15-minute ARMED WINDOW on the slot
// that won. Inside that window a live 5-minute trigger still has to fire —
// statistics choose when to look, price chooses whether to act. Outside it the
// engine holds, however good the chart looks, because the entire claim being
// tested is about timing.
//
// The 4H series is aggregated from the H1 candles every engine already fetches
// rather than added as a fourth timeframe: four closed H1 bars ARE the closed
// 4H bar, exactly, and re-fetching them would add a network dependency to
// reproduce data already in memory.

import { Candle, calculateATR, formatDynamicPrice } from './tradeEngine';
import { SL_ATR_MULTIPLIER } from './adaptiveRisk';
import { confirmEntry5M } from './intradayEntry';
import { DEFAULT_INTRADAY_PARAMS } from './intradayParams';
import type { Setup15M } from './intradaySetup';
import {
  BAR_MS,
  SLOT_MS,
  BarState,
  PathBucket,
  PathDirection,
  barOpenFor,
  labelBarState,
  riskUnitFrom15M,
  selectBucket,
  slotIndexAt
} from './pathStudy';

/**
 * Closed 4H bars the study needs, and the H1 candles that aggregate into them.
 *
 * Defined HERE because this file is the deepest consumer — evaluatePathDecision,
 * pathAdapter.canHandle and pathSimExecution all gate on the same requirement,
 * and they previously carried it as three separate literals (244, 244, 62*4=248).
 * Four apart by four is exactly the kind of near-miss that survives review: the
 * adapter would admit a symbol the sim engine's own H1 view had already
 * withheld. One number, re-exported, so the next edit cannot miss a copy.
 *
 * TIMEFRAME_SPECS['1h'].targetCandles must stay >= MIN_PATH_CANDLES — the
 * fetcher has to deliver what this asks for. simBotRegistry.test.ts asserts it.
 */
export const PATH_MIN_H4_BARS = 62;
export const MIN_PATH_CANDLES = PATH_MIN_H4_BARS * 4;

/** Aggregates H1 candles into closed 4H bars, aligned to the UTC epoch the way
 *  exchanges bucket them. A partial group at the end is dropped: a 4H bar built
 *  from two H1 candles is not a 4H bar, and treating it as one would let the
 *  engine label a bar using its own unfinished contents. */
export function aggregateToH4(h1: Candle[]): Candle[] {
  const byBar = new Map<number, Candle[]>();
  for (const candle of h1) {
    const open = barOpenFor(candle.timestamp);
    const group = byBar.get(open);
    if (group) group.push(candle);
    else byBar.set(open, [candle]);
  }

  const bars: Candle[] = [];
  for (const [open, group] of [...byBar.entries()].sort((a, b) => a[0] - b[0])) {
    if (group.length < 4) continue;
    group.sort((a, b) => a.timestamp - b.timestamp);
    bars.push({
      timestamp: open,
      open: group[0].open,
      high: Math.max(...group.map((c) => c.high)),
      low: Math.min(...group.map((c) => c.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((sum, c) => sum + c.volume, 0)
    });
  }
  return bars;
}

export type PathGate =
  | 'NO_DATA'
  | 'NO_STATE'
  | 'NO_BUCKET'
  | 'OUT_OF_WINDOW'
  | 'NO_TRIGGER'
  | 'SIGNAL';

export interface PathDecisionInput {
  symbol: string;
  /** H1 candles — the 4H series is aggregated from these. */
  h1: Candle[];
  m15: Candle[];
  m5: Candle[];
  livePrice: number;
  fearGreedIndex: number;
  /** The validated lookup table. Empty table = the engine abstains, which is
   *  the correct behaviour before a study has been run. */
  table: PathBucket[];
  now: number;
  /** Minimum out-of-sample expectancy a bucket must clear to be traded. */
  minExpectedR?: number;
  /**
   * Operator's confidence floor, 0-100, applied to the bucket's lower-bound hit
   * rate. Omit it and the engine behaves exactly as before.
   *
   * This bot's "confidence" is not a score borrowed from the H1 engines — it IS
   * the bucket's Wilson lower bound, so the floor here is a probability. That is
   * also why the number is small: at a 1.5R target a 45% bucket is a good bet,
   * and demanding the 58 the Legacy and Pro bots use would reject every
   * asymmetric trade this engine exists to find. The two knobs share a name in
   * the config and mean different things by it; they are not interchangeable and
   * must not be aligned "for consistency".
   */
  minConfidence?: number;
}

export interface PathDecision {
  symbol: string;
  gate: PathGate;
  outcome: 'SIGNAL' | 'NO_SIGNAL';
  direction: PathDirection | 'NONE';
  /** 0-100, derived from the bucket's own lower-bound hit rate — not a score
   *  invented for display. A 45% hit rate at 2R is a good trade and reads as
   *  confidence 45, which is honest about what it is. */
  confidence: number;
  reasoning: string[];
  state?: BarState;
  bucket?: PathBucket;
  /** Slot the current moment falls in, 0-15. */
  slot: number;
  armedSlot?: number;
  entryPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  riskUnit?: number;
  /** Expected value in R for this bucket, net of costs. */
  expectedR?: number;
}

function noSignal(symbol: string, gate: PathGate, slot: number, reason: string, extra: Partial<PathDecision> = {}): PathDecision {
  return {
    symbol,
    gate,
    outcome: 'NO_SIGNAL',
    direction: 'NONE',
    confidence: 0,
    reasoning: [reason],
    slot,
    ...extra
  };
}

/**
 * One symbol, one moment.
 *
 * Note what is NOT here: no trend score, no oscillator, no opinion about the
 * chart beyond the bar's state label. That is the point of the bot — it is the
 * control that isolates timing from signal quality. If it beats the other three,
 * the edge was in when to enter; if it loses, that hypothesis is answered.
 */
export function evaluatePathDecision(input: PathDecisionInput): PathDecision {
  const nowSlot = slotIndexAt(input.now, barOpenFor(input.now));

  if (input.h1.length < MIN_PATH_CANDLES || input.m5.length < 30) {
    return noSignal(input.symbol, 'NO_DATA', nowSlot,
      `אין מספיק נתונים: H1=${input.h1.length} (דרוש ${MIN_PATH_CANDLES}), M5=${input.m5.length} (דרוש 30)`);
  }

  const h4 = aggregateToH4(input.h1);
  if (h4.length < 61) {
    return noSignal(input.symbol, 'NO_DATA', nowSlot,
      `אין מספיק נרות 4H: ${h4.length} (דרוש 61)`);
  }

  // Prior bars only — the bar we are trading inside must not label itself.
  const currentBarOpen = barOpenFor(input.now);
  const priorBars = h4.filter((bar) => bar.timestamp < currentBarOpen);
  if (priorBars.length < 60) {
    return noSignal(input.symbol, 'NO_DATA', nowSlot,
      `אין מספיק נרות 4H סגורים לפני הנר הנוכחי: ${priorBars.length}`);
  }

  // Sentiment split forced OFF, explicitly — matching rebuildTable's own
  // explicit false in server/pathSimEngine.ts and the offline study's
  // DEFAULT_USE_FEAR_GREED. All three MUST agree: labelling live decisions
  // in a different state space than whatever table (validated or in-sample)
  // is active would look up keys that table cannot contain, and the bot
  // would abstain forever while looking like a table was working.
  const state = labelBarState(priorBars, input.fearGreedIndex, false);
  if (!state) {
    return noSignal(input.symbol, 'NO_STATE', nowSlot, 'לא ניתן לתייג את מצב הנר');
  }

  const bucket = selectBucket(input.table, state, input.minExpectedR ?? 0);
  if (!bucket) {
    return noSignal(input.symbol, 'NO_BUCKET', nowSlot,
      `אין נתח עם תוחלת חיובית למצב ${state.regime} / ${state.fng}`, { state });
  }

  // The operator's floor, applied to the statistics before the trigger runs.
  //
  // Without this the config field was inert for this bot: the panel displayed a
  // minimum confidence, the operator could edit it, and no decision anywhere
  // read it — the other three engines route theirs through the DecisionEngine
  // adapters, and this one evaluates directly. A control that moves and changes
  // nothing is worse than no control.
  const bucketConfidence = Math.round(bucket.pLow * 100);
  if (typeof input.minConfidence === 'number' && bucketConfidence < input.minConfidence) {
    return noSignal(input.symbol, 'NO_BUCKET', nowSlot,
      `ביטחון הנתח ${bucketConfidence} מתחת לרצפה שהוגדרה (${input.minConfidence})`,
      { state, bucket, armedSlot: bucket.slot, expectedR: bucket.expectedR });
  }

  if (nowSlot !== bucket.slot) {
    const armedAt = new Date(currentBarOpen + bucket.slot * SLOT_MS)
      .toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });
    return noSignal(input.symbol, 'OUT_OF_WINDOW', nowSlot,
      `מחוץ לחלון: הנתח החמוש הוא ${bucket.slot} (${armedAt}), הנוכחי ${nowSlot}`,
      { state, bucket, armedSlot: bucket.slot, expectedR: bucket.expectedR });
  }

  // Inside the window. The statistics have chosen the moment; the trigger
  // decides whether this particular instance is worth taking.
  //
  // 1R is drawn on the 15-MINUTE ATR, not the 4H one. The bot holds for at most
  // one 4H bar, and a stop set to the typical range of a whole bar is a stop the
  // trade cannot reach from inside it — measured, that left 91.5% of entries
  // expiring at neither level. See PATH_RISK_UNIT_ATR_MULT for the sweep.
  const riskUnit = riskUnitFrom15M(input.m15);
  if (!(riskUnit > 0)) {
    return noSignal(input.symbol, 'NO_DATA', nowSlot, 'יחידת סיכון לא תקינה (ATR 15M אפס)', { state, bucket });
  }

  const isLong = bucket.direction === 'LONG';
  // confirmEntry5M reads exactly four fields off a setup (setupType, direction,
  // levels.breakoutLevel and levels.targetReference), so the rest is left off
  // deliberately rather than filled with plausible-looking numbers that nothing
  // reads. TREND_PULLBACK is the neutral setup type here: it applies no
  // breakout-specific chase penalty and no mean-reversion close-confirm rule,
  // which keeps the trigger a pure momentum/volume confirmation of the slot the
  // statistics chose.
  const setup = {
    setupType: 'TREND_PULLBACK',
    direction: bucket.direction,
    levels: {
      breakoutLevel: null,
      targetReference: isLong
        ? input.livePrice + riskUnit * bucket.tpR
        : input.livePrice - riskUnit * bucket.tpR
    }
  } as unknown as Setup15M;

  const trigger = confirmEntry5M(input.m5, setup, DEFAULT_INTRADAY_PARAMS, Math.round(bucket.pLow * 100));
  if (!trigger.confirmed) {
    return noSignal(input.symbol, 'NO_TRIGGER', nowSlot,
      `בתוך החלון אך ללא אישור ב-5M: ${trigger.blockers[0] ?? 'אין טריגר'}`,
      { state, bucket, armedSlot: bucket.slot, expectedR: bucket.expectedR });
  }

  const entryPrice = input.livePrice;
  const stopLoss = isLong ? entryPrice - riskUnit : entryPrice + riskUnit;
  const takeProfit = isLong
    ? entryPrice + riskUnit * bucket.tpR
    : entryPrice - riskUnit * bucket.tpR;

  return {
    symbol: input.symbol,
    gate: 'SIGNAL',
    outcome: 'SIGNAL',
    direction: bucket.direction,
    confidence: Math.round(bucket.pLow * 100),
    slot: nowSlot,
    armedSlot: bucket.slot,
    state,
    bucket,
    entryPrice,
    stopLoss,
    takeProfit,
    riskUnit,
    expectedR: bucket.expectedR,
    reasoning: [
      `מצב נר: ${state.regime} / ${state.fng}`,
      `נתח ${bucket.slot}/16 — ${bucket.direction}, ${bucket.rawN} דגימות`,
      `סיכוי (גבול תחתון) ${(bucket.pLow * 100).toFixed(1)}% ליעד ${bucket.tpR}R`,
      `תוחלת ${bucket.expectedR.toFixed(3)}R נטו`,
      `כניסה $${formatDynamicPrice(entryPrice)} · SL $${formatDynamicPrice(stopLoss)} · TP $${formatDynamicPrice(takeProfit)}`,
      `טריגר 5M: ${trigger.reasons[0] ?? 'אושר'}`
    ]
  };
}

/**
 * Half-Kelly on the bucket's OWN measured probability and payoff.
 *
 * The other engines estimate Kelly's payoff ratio from closed-trade history,
 * which is the best they can do. This bot knows the distribution it is betting
 * on, so it can size from it directly — and it uses the lower confidence bound
 * rather than the point estimate, because betting Kelly on an overstated p is
 * the classic way a correct formula produces ruin.
 */
export function pathKellyFraction(bucket: PathBucket): number {
  const b = bucket.tpR / bucket.slR;
  const p = bucket.pLow;
  const q = 1 - p;
  if (!(b > 0)) return 0;
  const full = (p * b - q) / b;
  if (!(full > 0)) return 0;
  return Math.min(full * 0.5, 0.05);
}

/** Bar-aligned max hold: one 4H bar from entry. The claim under test is about
 *  what happens inside the bar the entry was timed to — holding past it is a
 *  different trade with no measured expectancy behind it. */
export const PATH_MAX_HOLD_MS = BAR_MS;
export const PATH_TIME_STOP_MS = Math.round(BAR_MS * 0.5);

/** The risk unit a symbol would trade with right now. Same 15M basis the live
 *  decision uses — the two must not diverge, or a position would be sized
 *  against a different R than the one its expectancy was measured in. */
export function pathRiskUnit(m15: Candle[]): number {
  return riskUnitFrom15M(m15);
}
