// Order generation for the 4H Path bot.
//
// Shares every mechanic the other three bots use — the same fill/fee/slippage
// core (fillDueOrders), the same one-position-per-symbol gate, the same
// per-position exits, the same losing-streak cooldown — so that a difference in
// results between the four is a difference in DECISIONS and nothing else. That
// is the whole reason to run four bots rather than one.
//
// The two things genuinely its own:
//   · sizing comes from the bucket's measured probability (pathKellyFraction)
//     rather than from a payoff ratio estimated off trade history;
//   · the hold budget is one 4H bar, because the measured expectancy describes
//     what happened inside one bar and says nothing about hour five.

import { Candle } from './tradeEngine';
import type { SignalEvaluation } from './intradayBridge';
import { isInEntryCooldown, computeEntryBudget, riskLevelSizingMultiplier } from './simExecution';
import type { SimPosition, PendingOrder } from './simExecution';
import {
  isInStreakCooldown,
  streakCooldownFromHistory,
  ClosedTradeRecord
} from './adaptiveRisk';
import {
  evaluateCorrelationGate,
  toPositionDirection,
  CorrelatedHolding,
  DEFAULT_CORRELATION_LOOKBACK,
  DEFAULT_CORRELATION_THRESHOLD,
  DEFAULT_MAX_CORRELATED
} from './correlation';
import { PATH_MAX_HOLD_MS, PATH_TIME_STOP_MS } from './pathEngine';
import { pathKellyFraction } from './pathEngine';
import type { PathBucket } from './pathStudy';


export const uid = (p: string) => `path-${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/**
 * H1 candles the Path engine needs before it can build a usable 4H series.
 *
 * DERIVED, not chosen. It was written as a bare 244 while the fetcher's own
 * spec asks for 240 (TIMEFRAME_SPECS['1h'].targetCandles), so on a cold start
 * every symbol failed this check and the table came back empty — a bot that
 * looked like it had found nothing when in fact it had never been given
 * anything to look at. In steady state the delta merge grows the series well
 * past either number, which is precisely why the mismatch survived: it only
 * bites the first few hours after a fresh deploy, when nobody is watching the
 * one metric that would show it.
 *
 * Two numbers that must agree get written once. This one is what the engine
 * structurally needs; TIMEFRAME_SPECS['1h'].targetCandles is what the fetcher
 * delivers, and it is now sized to cover this. `simDefaults.test.ts` asserts
 * the relationship holds, so raising the requirement without raising the fetch
 * fails a test instead of quietly reintroducing the cold-start hole.
 */
export const PATH_MIN_H4_BARS = 62;
export const MIN_PATH_CANDLES = PATH_MIN_H4_BARS * 4;

const PATH_ENTRY_ORDER_SIDES = new Set(['buy', 'sell', 'long', 'short']);

export interface PathOrderGenContext {
  positions: SimPosition[];
  pending: PendingOrder[];
  evaluations: SignalEvaluation[];
  executionDelaySec: number;
  dailyDrawdownPercent: number;
  weeklyDrawdownPercent: number;
  cash: number;
  equity: number;
  positionPercent?: number;
  riskLevel?: 'low' | 'medium' | 'high';
  exitCooldown: Record<string, number>;
  priceFor: (symbol: string) => number | undefined;
  candlesBySymbol: Record<string, Candle[]>;
  maxPositions: number;
  maxFuturesPositions: number;
  closedTradeMetrics?: ClosedTradeRecord[];
  correlationThreshold?: number;
  maxCorrelatedPositions?: number;
  correlationLookback?: number;
}

/**
 * Position size for one path signal.
 *
 * Half-Kelly on the bucket's own lower-bound probability, expressed against
 * equity, then capped by the operator's positionPercent ceiling exactly as the
 * other three bots are. Kelly here is a genuine measurement rather than an
 * estimate off a short trade history, which is the one place this bot has
 * better information than its siblings.
 */
export function pathEntryBudget(
  bucket: PathBucket | undefined,
  equity: number,
  cash: number,
  positionPercent: number | undefined,
  riskLevel: 'low' | 'medium' | 'high' | undefined
): number {
  const ceiling = computeEntryBudget(cash, 'SPOT', positionPercent) * riskLevelSizingMultiplier(riskLevel);
  if (!bucket) return 0;
  const fraction = pathKellyFraction(bucket);
  if (!(fraction > 0)) return 0;
  return Math.min(equity * fraction, ceiling);
}

export function generatePathOrders(ctx: PathOrderGenContext): PendingOrder[] {
  const {
    positions, pending, evaluations, executionDelaySec,
    exitCooldown, priceFor, candlesBySymbol, maxPositions,
    closedTradeMetrics = [],
    correlationThreshold = DEFAULT_CORRELATION_THRESHOLD,
    maxCorrelatedPositions = DEFAULT_MAX_CORRELATED,
    correlationLookback = DEFAULT_CORRELATION_LOOKBACK
  } = ctx;
  const delayMs = Math.max(0, executionDelaySec) * 1000;
  const newOrders: PendingOrder[] = [];
  const now = Date.now();

  // ── Exits ──────────────────────────────────────────────────────────────────
  // Per POSITION, not per symbol — see the identical loop in simExecution.ts.
  for (const pos of positions) {
    const claimed = (o: PendingOrder) => (o.positionId ? o.positionId === pos.id : o.symbol === pos.symbol);
    if (pending.some(claimed) || newOrders.some(claimed)) continue;

    const livePrice = priceFor(pos.symbol) ?? pos.currentPrice;
    const isLong = pos.side === 'LONG' || pos.side === 'BUY';
    const heldMs = now - (pos.openTimestamp || now);
    const riskUnit = Math.abs(pos.entryPrice - pos.stopLoss);
    const progressR = riskUnit > 0 ? ((livePrice - pos.entryPrice) * (isLong ? 1 : -1)) / riskUnit : 0;

    let reason = '';
    if (isLong ? livePrice <= pos.stopLoss : livePrice >= pos.stopLoss) {
      reason = `Stop Loss ב-${pos.stopLoss}`;
    } else if (pos.takeProfit && (isLong ? livePrice >= pos.takeProfit : livePrice <= pos.takeProfit)) {
      reason = `Take Profit ב-${pos.takeProfit} (${progressR.toFixed(2)}R)`;
    } else if (heldMs >= (pos.maxHoldMs ?? PATH_MAX_HOLD_MS)) {
      // One bar, then out. The bucket's expectancy was measured over a single
      // bar's forward window; past it the position is a trade nothing measured.
      reason = `תקרת החזקה (נר 4H אחד) — יציאה ב-${progressR.toFixed(2)}R`;
    } else if (heldMs >= (pos.timeStopMs ?? PATH_TIME_STOP_MS) && progressR < 0.3) {
      reason = `Time Stop: חצי נר ללא התקדמות (${progressR.toFixed(2)}R < 0.3R)`;
    }

    if (!reason) continue;

    newOrders.push({
      id: uid(`${pos.symbol}-exit`),
      symbol: pos.symbol,
      positionId: pos.id,
      type: pos.type,
      side: isLong ? 'close_long' : 'close_short',
      signalPrice: livePrice,
      quantity: pos.quantity,
      reason,
      confidence: pos.confidence,
      executeAt: now + delayMs,
      createdAt: now
    });
  }

  // ── Entries ────────────────────────────────────────────────────────────────
  let workingCash = ctx.cash;
  let totalPositionCount = positions.length + pending.filter((o) => PATH_ENTRY_ORDER_SIDES.has(o.side)).length;

  const correlationBook: CorrelatedHolding[] = [
    ...positions.map((p) => ({ symbol: p.symbol, direction: toPositionDirection(p.side) })),
    ...pending
      .filter((o) => PATH_ENTRY_ORDER_SIDES.has(o.side))
      .map((o) => ({ symbol: o.symbol, direction: toPositionDirection(o.side) }))
  ];

  for (const ev of evaluations) {
    if (!ev.willExecute || !ev.price) continue;
    if (positions.some((p) => p.symbol === ev.symbol)) continue;
    if (newOrders.some((o) => o.symbol === ev.symbol) || pending.some((o) => o.symbol === ev.symbol)) continue;
    if (isInEntryCooldown(exitCooldown[ev.symbol])) continue;
    if (isInStreakCooldown(streakCooldownFromHistory(closedTradeMetrics, ctx.equity, ev.symbol))) continue;
    if (totalPositionCount >= maxPositions) continue;

    // Spot only. Every measured expectancy in the table is a 1R-stop spot trade;
    // applying leverage to it would change the distribution being bet on without
    // changing the number the bet was sized from.
    if (ev.tradeSide === 'SHORT' || ev.tradeSide === 'SELL') continue;

    const bucket = (ev.decision as unknown as { bucket?: PathBucket } | undefined)?.bucket;
    const budget = pathEntryBudget(bucket, ctx.equity, workingCash, ctx.positionPercent, ctx.riskLevel);
    if (budget < 5) continue;

    const evDirection = toPositionDirection(ev.tradeSide as string);
    const gate = evaluateCorrelationGate({
      symbol: ev.symbol,
      direction: evDirection,
      held: correlationBook,
      candlesBySymbol,
      threshold: correlationThreshold,
      maxCorrelated: maxCorrelatedPositions,
      lookback: correlationLookback
    });
    if (!gate.allowed) continue;

    totalPositionCount++;
    workingCash -= budget;
    correlationBook.push({ symbol: ev.symbol, direction: evDirection });

    newOrders.push({
      id: uid(`${ev.symbol}-buy`),
      symbol: ev.symbol,
      type: 'SPOT',
      side: 'buy',
      signalPrice: ev.price,
      quantity: budget / ev.price,
      budgetUsd: budget,
      leverage: 1,
      stopLoss: ev.stopLoss,
      takeProfit: ev.takeProfit,
      takeProfit1: ev.takeProfit,
      reason: ev.reasoning,
      confidence: ev.confidence,
      executeAt: now + delayMs,
      createdAt: now,
      maxHoldMs: PATH_MAX_HOLD_MS,
      timeStopMs: PATH_TIME_STOP_MS
    });
  }

  return newOrders;
}
