/**
 * "Bot Pro" — order generation for the alg.md engine.
 * ============================================================================
 * Mirrors the shape every other bot's order-generation layer uses (build a
 * per-symbol SignalEvaluation, then turn evaluations + open positions into
 * pending orders), but the gates inside are §4's, not any other engine's:
 *
 *   §4 gate order, as implemented here:
 *     1. Already holding this symbol, or an order already pending on it? → skip.
 *     2. Portfolio circuit breaker tripped (daily/weekly drawdown lock)? → no
 *        NEW entries (existing positions still exit normally — §4 gates
 *        openings, §5's stop/target are not a "new position").
 *     3. confidence >= minConfidence (§3)? else → no entry.
 *     4. Capacity: openPositions + queuedBuys < maxPositions?
 *     5. budget = min(initialAmount × allocation(riskLevel), cash); budget >= 5?
 *     6. All pass → buy order queued.
 *
 * Spot only, per §4's explicit "the system does not open shorts": a SELL
 * signal on a symbol with no open position produces no order at all, it only
 * closes a position that already exists.
 */
import {
  computeProSignal,
  evaluateProExit,
  proMinConfidence,
  proAllocationPercent,
  proTechnicalScore,
  MIN_PRO_CANDLES,
  type ProSignalResult,
  type ProRiskLevel
} from './proAlgEngine';
import type { Candle } from './tradeEngine';
import type { SignalEvaluation, DecisionFactor } from './intradayBridge';
import { isInEntryCooldown } from './simExecution';
import type { SimPosition, PendingOrder } from './simExecution';
import { DAILY_DRAWDOWN_BLOCK_PERCENT, WEEKLY_DRAWDOWN_LOCK_PERCENT } from './intradayParams';

export const uid = (p: string) => `pro-${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

export { MIN_PRO_CANDLES };

/**
 * §2/§4 for one symbol: computes the weighted signal, checks it against §3's
 * confidence floor, and reports the result as the same SignalEvaluation shape
 * every other bot's UI column reads.
 */
export function buildProEvaluation(
  symbol: string,
  candles: Candle[],
  currentPrice: number,
  priceChange24h: number,
  fearGreedIndex: number,
  riskLevel: ProRiskLevel,
  minConfidenceOverride: number | undefined
): SignalEvaluation {
  if (!candles || candles.length < MIN_PRO_CANDLES) {
    return {
      symbol, action: 'hold', tradeType: 'HOLD', tradeSide: 'NONE', confidence: 0,
      price: currentPrice, priceChange24h, reasoning: `אין מספיק היסטוריה (נדרשים ${MIN_PRO_CANDLES} נרות)`,
      status: 'NO_SIGNAL [NO_DATA]', willExecute: false, factors: [], confidenceGap: 0
    };
  }

  const signal = computeProSignal(candles, priceChange24h, fearGreedIndex);
  const minConfidence = proMinConfidence(riskLevel, minConfidenceOverride);
  const willExecute = signal.action === 'BUY' && signal.confidence >= minConfidence;

  const factors: DecisionFactor[] = signal.signals
    .slice()
    .sort((a, b) => (b.weight * b.confidence) - (a.weight * a.confidence))
    .slice(0, 4)
    .map((s) => ({
      label: s.name,
      value: s.reason,
      impact: s.signal === (signal.action === 'HOLD' ? 'HOLD' : signal.action) ? 'positive' : 'neutral',
      note: `משקל ${s.weight} · ביטחון ${s.confidence}`
    }));

  const reasoning = signal.action === 'HOLD'
    ? `ללא יתרון כיווני מובהק (buy ${signal.buyScore.toFixed(1)} / sell ${signal.sellScore.toFixed(1)} / hold ${signal.holdScore.toFixed(1)}) · ציון טכני ${proTechnicalScore(signal).toFixed(0)}/100`
    : signal.action === 'SELL'
      ? `אות SELL — Spot אינו פותח שורט, נדרשת פוזיציה פתוחה כדי לסגור`
      : willExecute
        ? `אות BUY בביטחון ${signal.confidence.toFixed(1)} >= סף ${minConfidence} — מבצע קנייה`
        : `אות BUY בביטחון ${signal.confidence.toFixed(1)} מתחת לסף ${minConfidence}`;

  const tradeSide: SignalEvaluation['tradeSide'] = signal.action === 'BUY' ? 'BUY' : signal.action === 'SELL' ? 'SELL' : 'NONE';

  return {
    symbol,
    action: signal.action.toLowerCase() as 'buy' | 'sell' | 'hold',
    tradeType: willExecute ? 'SPOT' : 'HOLD',
    tradeSide,
    confidence: signal.confidence,
    price: currentPrice,
    priceChange24h,
    reasoning,
    status: willExecute ? 'SIGNAL SPOT BUY' : `NO_SIGNAL [${signal.action === 'HOLD' ? 'NO_DIRECTION' : signal.action === 'SELL' ? 'SPOT_SELL_UNSUPPORTED' : 'BELOW_THRESHOLD'}]`,
    willExecute,
    factors,
    confidenceGap: Math.max(0, minConfidence - signal.confidence),
    riskLevel,
    stopLoss: undefined, // fixed % — resolved against the fill price at order time, not the signal price
    takeProfit1: undefined
  };
}

export interface ProOrderGenContext {
  positions: SimPosition[];
  pending: PendingOrder[];
  evaluations: SignalEvaluation[];
  /** Per-symbol current signal, for the exit check (§4's "flip to SELL"). */
  signalsBySymbol: Record<string, ProSignalResult>;
  minConfidence: number;
  executionDelaySec: number;
  dailyDrawdownPercent: number;
  weeklyDrawdownPercent: number;
  cash: number;
  initialAmount: number;
  riskLevel: ProRiskLevel;
  exitCooldown: Record<string, number>;
  priceFor: (symbol: string) => number | undefined;
  maxPositions: number;
}

export function generateProOrders(ctx: ProOrderGenContext): PendingOrder[] {
  const {
    positions, pending, evaluations, signalsBySymbol, minConfidence, executionDelaySec,
    dailyDrawdownPercent, weeklyDrawdownPercent, exitCooldown, priceFor, maxPositions, riskLevel
  } = ctx;
  const delayMs = Math.max(0, executionDelaySec) * 1000;
  const newOrders: PendingOrder[] = [];

  // ── §5 fixed exit + §4 flip-to-SELL exit, per open position ───────────────
  for (const pos of positions) {
    const claimed = (o: PendingOrder) => (o.positionId ? o.positionId === pos.id : o.symbol === pos.symbol);
    if (pending.some(claimed) || newOrders.some(claimed)) continue;

    const livePrice = priceFor(pos.symbol) ?? pos.currentPrice;
    const signal = signalsBySymbol[pos.symbol];
    // No fresh signal this tick (e.g. candle history briefly unavailable) —
    // §5's fixed-percentage exit still has to run, so treat it as HOLD rather
    // than skipping the position entirely.
    const effectiveSignal: ProSignalResult = signal ?? {
      action: 'HOLD', buyScore: 0, sellScore: 0, holdScore: 100, totalWeight: 0, confidence: 0, signals: [],
      indicators: { rsi: 50, ma20: livePrice, volumeTrend: 'stable', bollingerBands: { upper: livePrice, middle: livePrice, lower: livePrice, position: 'between' }, volumeProfile: { poc: livePrice, valueAreaHigh: livePrice, valueAreaLow: livePrice, position: 'in_value_area' } }
    };

    const exitCheck = evaluateProExit({ entryPrice: pos.entryPrice }, livePrice, effectiveSignal, minConfidence);
    if (!exitCheck.shouldExit) continue;

    newOrders.push({
      id: uid(`${pos.symbol}-exit`), symbol: pos.symbol, positionId: pos.id, type: 'SPOT',
      side: 'close_long', signalPrice: livePrice, quantity: pos.quantity, reason: exitCheck.reason,
      confidence: pos.confidence ?? 0, executeAt: Date.now() + delayMs, createdAt: Date.now()
    } as PendingOrder);
  }

  // §4 gate 2: portfolio circuit breaker blocks NEW entries only.
  const circuitBreakerTripped = dailyDrawdownPercent >= DAILY_DRAWDOWN_BLOCK_PERCENT || weeklyDrawdownPercent >= WEEKLY_DRAWDOWN_LOCK_PERCENT;
  if (circuitBreakerTripped) return newOrders;

  let totalPositionCount = positions.length + pending.filter((o) => o.side === 'buy').length;
  let workingCash = ctx.cash;
  const allocation = proAllocationPercent(riskLevel);

  for (const ev of evaluations) {
    if (!ev.willExecute || !ev.price) continue;
    // §4 gate 1: already holding, or an order already exists for this symbol.
    if (positions.some((p) => p.symbol === ev.symbol)) continue;
    if (newOrders.some((o) => o.symbol === ev.symbol) || pending.some((o) => o.symbol === ev.symbol)) continue;
    if (isInEntryCooldown(exitCooldown[ev.symbol])) continue;
    // §4 gate 4: capacity.
    if (totalPositionCount >= maxPositions) continue;

    // §4 gate 5 / §6: budget = min(initialAmount × allocation, cash), >= $5.
    const budget = Math.min(ctx.initialAmount * allocation, workingCash);
    if (budget < 5) continue;

    totalPositionCount++;
    workingCash -= budget;

    newOrders.push({
      id: uid(`${ev.symbol}-buy`), symbol: ev.symbol, type: 'SPOT', side: 'buy',
      signalPrice: ev.price, quantity: budget / ev.price, budgetUsd: budget, leverage: 1,
      reason: ev.reasoning, confidence: ev.confidence,
      executeAt: Date.now() + delayMs, createdAt: Date.now()
    } as PendingOrder);
  }

  return newOrders;
}

// Kept for symmetry with the other engines' UI column, which reads it off
// evaluations that carry a `regime` — Pro's alg.md has no regime classifier,
// so this is always empty.
export function activeMarketRegimesFrom(): Record<string, never> {
  return {};
}
