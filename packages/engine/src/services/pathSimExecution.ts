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
import { isInEntryCooldown, computeEntryBudget, MIN_SIM_ENTRY_USD, pickPreemptibleEntryOrder } from './simExecution';
import type { SimPosition, PendingOrder } from './simExecution';
import {
  isInStreakCooldown,
  streakCooldownFromHistory,
  portfolioStreakCooldownUntil,
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
import { DAILY_DRAWDOWN_BLOCK_PERCENT, WEEKLY_DRAWDOWN_LOCK_PERCENT, PER_ASSET_EXPOSURE_CAP_PERCENT, POSITION_TARGET_PCT } from './intradayParams';
import { PATH_MAX_HOLD_MS, PATH_TIME_STOP_MS } from './pathEngine';
import { pathKellyFraction } from './pathEngine';
import type { PathBucket } from './pathStudy';
import { evaluateRatchet, ratchetReason } from './profitRatchet';


export const uid = (p: string) => `path-${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/**
 * H1 candles the Path engine needs before it can build a usable 4H series.
 *
 * Re-exported, not redefined — the number lives in pathEngine.ts next to the
 * check that actually enforces it. It used to be declared here as 62*4=248
 * while evaluatePathDecision and pathAdapter each carried their own 244, so
 * this module's H1 view and the engine's own gate disagreed by four candles.
 */
export { PATH_MIN_H4_BARS, MIN_PATH_CANDLES } from './pathEngine';

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
  if (!bucket) return 0;
  // Position sizing: 10% of equity as target notional, independent of Kelly.
  // The operator's positionPercent and riskLevel are no longer primary sizing
  // inputs — they remain as safety ceilings.
  const targetNotional = equity * POSITION_TARGET_PCT;
  const ceiling = computeEntryBudget(cash, 'SPOT', positionPercent);
  const perAssetCap = equity * (PER_ASSET_EXPOSURE_CAP_PERCENT / 100);
  return Math.min(targetNotional, ceiling, perAssetCap);
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

    // Profit ratchet (2026-09-14) — the ONLY profit exit. It replaced the single
    // fixed takeProfit level: crossing 1.8/3/4/5%… marks a rung and sells
    // nothing, coming back down to one sells 30% (or closes out at the 1.8%
    // floor). See profitRatchet.ts.
    const ratchet = evaluateRatchet({
      entryPrice: pos.entryPrice,
      peakPrice: (isLong ? pos.highestPrice : pos.lowestPrice) ?? pos.entryPrice,
      livePrice,
      isLong,
      consumed: pos.ratchetConsumed
    });

    if (ratchet.action === 'PARTIAL') {
      newOrders.push({
        id: uid(`${pos.symbol}-ratchet`),
        symbol: pos.symbol,
        positionId: pos.id,
        type: pos.type,
        side: 'partial_tp1',
        exitFraction: ratchet.fraction,
        ratchetConsumed: ratchet.consumed,
        signalPrice: livePrice,
        quantity: pos.quantity * (ratchet.fraction ?? 0),
        reason: ratchetReason(ratchet),
        confidence: pos.confidence,
        executeAt: now + delayMs,
        createdAt: now
      });
      continue;
    }

    let reason = '';
    if (isLong ? livePrice <= pos.stopLoss : livePrice >= pos.stopLoss) {
      reason = `Stop Loss ב-${pos.stopLoss}`;
    } else if (ratchet.action === 'FULL') {
      reason = ratchetReason(ratchet);
    } else if (ratchet.peakRung === undefined && heldMs >= (pos.maxHoldMs ?? PATH_MAX_HOLD_MS)) {
      // One bar, then out. The bucket's expectancy was measured over a single
      // bar's forward window; past it the position is a trade nothing measured.
      // Suspended once a rung is crossed (operator decision 2026-09-14): a
      // position already climbing the ladder is let run to the ladder's verdict.
      reason = `תקרת החזקה (נר 4H אחד) — יציאה ב-${progressR.toFixed(2)}R`;
    } else if (ratchet.peakRung === undefined && heldMs >= (pos.timeStopMs ?? PATH_TIME_STOP_MS) && progressR < 0.3) {
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
  // Resting entry orders this batch has already agreed to evict for a stronger
  // candidate — so one slot cannot be freed twice in the same tick.
  const preemptClaimed = new Set<string>();

  const correlationBook: CorrelatedHolding[] = [
    ...positions.map((p) => ({ symbol: p.symbol, direction: toPositionDirection(p.side) })),
    ...pending
      .filter((o) => PATH_ENTRY_ORDER_SIDES.has(o.side))
      .map((o) => ({ symbol: o.symbol, direction: toPositionDirection(o.side) }))
  ];

  // Circuit breaker: stop opening new positions if daily/weekly drawdown exceeded.
  //
  // ctx.dailyDrawdownPercent / weeklyDrawdownPercent are measured by THIS bot's
  // own engine instance against its OWN equity curve (server/simEngineFactory.ts
  // drawdowns()). Only the two thresholds are shared with the other bots; the
  // measurement is never pooled, so a Pro or Intraday loss cannot halt Path.
  if (
    ctx.dailyDrawdownPercent >= DAILY_DRAWDOWN_BLOCK_PERCENT ||
    ctx.weeklyDrawdownPercent >= WEEKLY_DRAWDOWN_LOCK_PERCENT
  ) {
    return newOrders; // Only exits, no new entries
  }

  for (const ev of evaluations) {
    if (!ev.willExecute || !ev.price) continue;
    if (positions.some((p) => p.symbol === ev.symbol)) continue;
    if (newOrders.some((o) => o.symbol === ev.symbol) || pending.some((o) => o.symbol === ev.symbol)) continue;
    if (isInEntryCooldown(exitCooldown[ev.symbol])) continue;
    if (isInStreakCooldown(streakCooldownFromHistory(closedTradeMetrics, ctx.equity, ev.symbol))) continue;
    if (isInStreakCooldown(portfolioStreakCooldownUntil(closedTradeMetrics, ctx.equity))) continue;
    if (totalPositionCount >= maxPositions) {
      // A resting (unfilled) entry order only reserves a slot. A clearly
      // stronger fresh candidate evicts the weakest one; the tick loop cancels
      // the incumbent once this order is actually placed.
      const victimId = pickPreemptibleEntryOrder(ev.confidence, pending, preemptClaimed);
      if (!victimId) continue;
      preemptClaimed.add(victimId);
      ev.preemptsOrderId = victimId;
    }

    // Spot only. Every measured expectancy in the table is a 1R-stop spot trade;
    // applying leverage to it would change the distribution being bet on without
    // changing the number the bet was sized from.
    if (ev.tradeSide === 'SHORT' || ev.tradeSide === 'SELL') continue;

    const bucket = (ev.decision as unknown as { bucket?: PathBucket } | undefined)?.bucket;
    const budget = pathEntryBudget(bucket, ctx.equity, workingCash, ctx.positionPercent, ctx.riskLevel);
    if (budget < MIN_SIM_ENTRY_USD) continue; // operator floor: no sim entry below $100

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
      // Market, not a resting limit: evaluatePathDecision sets entryPrice to
      // input.livePrice itself (pathEngine.ts) — a "trade now, at this
      // price" value, not a discount below it the way Pro's
      // calculateOptimalEntryPrice is. Left unmarked, fillDueOrders defaults
      // any entry order to LIMIT (crossed only once price falls back to
      // signalPrice or below — simExecution.ts:730), which would hold this
      // order open waiting for the SAME reversal that invalidates the specific
      // 15-minute slot the bucket's statistics armed it for (evaluatePathDecision's
      // OUT_OF_WINDOW gate only allows a signal during that one slot in the
      // first place — a fill minutes later, after price has reversed, is not
      // a late version of the same trade).
      fill: 'market',
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
