/**
 * "Bot Pro" — order generation for the alg.md engine.
 * ============================================================================
 * Three layers, each owning exactly what alg.md gives it:
 *
 *   buildProEvaluation  — §2's weighted signal for one symbol + §4's gate 4
 *                         (the confidence threshold), as the SignalEvaluation
 *                         shape every bot's UI column reads.
 *   applyProEntryGates  — §4's FULL gate sequence, evaluated once on the
 *                         evaluation itself so it is the single source of truth
 *                         for both the panel and the executor, in the doc's own
 *                         order, over a confidence-descending batch.
 *   generateProOrders   — §5's exits first (fixed % + the confidence-gated
 *                         flip-to-SELL), then the buy orders the evaluations
 *                         already approved. Entries are §6's delayed MARKET
 *                         fills (fill: 'market').
 *
 * Spot only, per §4's explicit "the system does not open shorts": a SELL
 * signal on a symbol with no open position produces no order at all, it only
 * closes a position that already exists.
 */
import {
  computeProSignal,
  evaluateProExit,
  proMinConfidence,
  proTechnicalScore,
  calculateOptimalEntryPrice,
  proMaxEntryDiscountPercent,
  proStopTpLevels,
  MIN_PRO_CANDLES,
  type ProSignalResult,
  type ProRiskLevel
} from './proAlgEngine';
import { PER_ASSET_EXPOSURE_CAP_PERCENT, POSITION_TARGET_PCT, CAPITAL_FLOOR_PCT, resolveSizingBase, isBelowCapitalFloor } from './intradayParams';
import { isBuyingSurge, measureStopNoise } from './calmRegime';
import type { Candle } from './tradeEngine';
import type { SignalEvaluation, DecisionFactor } from './intradayBridge';
import type { SimPosition, PendingOrder } from './simExecution';
import { MIN_SIM_ENTRY_USD, MIN_ORDER_EXCEEDS_POSITION_TARGET, blockEntry, pickPreemptibleEntryOrder, isInEntryCooldown } from './simExecution';
import { isLongSide, TP1_EXIT_FRACTION, TP1_PERCENT, TP2_PERCENT, MAX_LOSS_PERCENT } from './exitPolicy';

export const uid = (p: string) => `pro-${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

export { MIN_PRO_CANDLES };

/**
 * §2/§4 for one symbol: computes the weighted signal and the threshold-only
 * view of §4 (gate 4), as the same SignalEvaluation shape every other bot's
 * UI column reads. §4's STATE gates (queued / held / slots / price / budget)
 * are applied per batch by applyProEntryGates — they need the portfolio,
 * which a per-symbol call does not see.
 */
export function buildProEvaluation(
  symbol: string,
  candles: Candle[],
  currentPrice: number,
  priceChange24h: number,
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

  const signal = computeProSignal(candles, priceChange24h);
  const minConfidence = proMinConfidence(riskLevel, minConfidenceOverride);
  /** §16 raw signal threshold check, before any state or risk gate. */
  const signalPasses = signal.action === 'BUY' && signal.confidence >= minConfidence;

  // ATR-scaled stop + stop-relative TP ladder, as absolute prices off the
  // signal price. fillDueOrders reanchors them to the actual fill, preserving
  // the % distances. Spot is LONG only.
  // Calm-regime scalp (2026-09-11, operator request, sim only): see
  // calmRegime.ts / proStopTpLevels for the full rationale.
  const levels = proStopTpLevels(currentPrice, signal.atrPercent, true, {
    calmRegimeScalp: true,
    noiseFloorStop: true,
    // The two things that widen the fixed 2.3% stop — both measured on the same
    // candle series §2's own indicators are computed from.
    buyingSurge: isBuyingSurge(candles),
    stopNoise: measureStopNoise(candles)
  });

  // A stop that sits inside one bar's ordinary range is a coin flip on noise,
  // not a risk limit — and `levels.tooVolatile` says even the widest stop this
  // ladder allows would still be inside it. The signal itself is untouched
  // (strategyDecision stays true); this only refuses to open the position.
  const willExecute = signalPasses && !levels.tooVolatile;

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
        : signalPasses && levels.tooVolatile
          ? `אות BUY בביטחון ${signal.confidence.toFixed(1)} — נחסם: תנודתיות ${signal.atrPercent.toFixed(2)}% לנר דורשת סטופ ${levels.noiseFloorPct.toFixed(2)}% מעל התקרה, נר רגיל היה מוציא את הפוזיציה`
          : `אות BUY בביטחון ${signal.confidence.toFixed(1)} מתחת לסף ${minConfidence}`;

  const tradeSide: SignalEvaluation['tradeSide'] = signal.action === 'BUY' ? 'BUY' : signal.action === 'SELL' ? 'SELL' : 'NONE';

  // §6: compute optimal entry price from indicator support levels.
  // When limitEntries is on, the bot places a LIMIT at this price and waits —
  // so the distance from market has to be something the order TTL can actually
  // fill. Derived from THIS trade's stop distance (levels above) rather than a
  // flat number: see proMaxEntryDiscountPercent.
  const stopPercent = currentPrice > 0
    ? (Math.abs(currentPrice - levels.stopLoss) / currentPrice) * 100
    : undefined;
  const optimalEntryPrice = calculateOptimalEntryPrice(signal, currentPrice, {
    maxDiscountPercent: proMaxEntryDiscountPercent(stopPercent)
  });

  return {
    symbol,
    action: signal.action.toLowerCase() as 'buy' | 'sell' | 'hold',
    tradeType: willExecute ? 'SPOT' : 'HOLD',
    tradeSide,
    confidence: signal.confidence,
    price: currentPrice,
    priceChange24h,
    reasoning,
    status: willExecute
      ? 'SIGNAL SPOT BUY'
      : `NO_SIGNAL [${signal.action === 'HOLD' ? 'NO_DIRECTION' : signal.action === 'SELL' ? 'SPOT_SELL_UNSUPPORTED' : signalPasses ? 'VOLATILITY_TOO_HIGH' : 'BELOW_THRESHOLD'}]`,
    willExecute,
    strategyDecision: signalPasses, // §16: raw signal threshold check, before state gates
    factors,
    confidenceGap: Math.max(0, minConfidence - signal.confidence),
    riskLevel,
    stopLoss: levels.stopLoss,
    takeProfit1: levels.takeProfit1,
    takeProfit2: levels.takeProfit2,
    indicators: signal.indicators,
    isDowntrend: signal.indicators.isDowntrend ?? false,
    optimalEntryPrice
  };
}

// ── §4 — the entry gates, evaluated ONCE, on the evaluation itself ──────────
//
// alg.md §4: the SignalEvaluation is the single source of truth — the same
// object feeds the recommendations panel and the executor, "כך שאין פער בין
// מה שמוצג לבין מה שמבוצע". The state gates therefore run HERE, in §4's own
// order, over a batch walked in descending confidence so the slots and the
// cash go to the strongest signals first ("ההמלצות ממוינות לפי ביטחון יורד,
// כך שהסלוטים והמזומן מוקצים קודם לאותות החזקים ביותר").
//
// §4 itself has no per-symbol entry cooldown or drawdown circuit breaker — §9
// originally assigned both to the REAL bot only, and this file matched that.
// The circuit breaker is now applied anyway (in server/proSimEngine.ts, ahead
// of this gate pass): the four bots share one equity-protection floor, and
// simulating past it while the REAL bot would have stopped made Pro's results
// incomparable to the others precisely when the comparison mattered most. The
// entry cooldown remains genuinely absent — §4 gates re-entry on price/slots/
// confidence only, and that difference from the other three bots is by design,
// not an oversight.

export interface ProGateContext {
  positions: SimPosition[];
  pending: PendingOrder[];
  cash: number;
  /** Total portfolio equity = cash + positions value — displayed in the UI so
   *  the operator sees why a healthy-looking portfolio can still be cash-poor.
   *  The budget GATE itself allocates against `cash` (what's actually spendable):
   *  an allocation that equity would allow but cash couldn't cover would create
   *  an order the fill step then refuses — "ready to buy" with no purchase. */
  equity: number;
  initialAmount: number;
  maxPositions: number;
  riskLevel: ProRiskLevel;
  minConfidenceOverride?: number;
}

function gateResult(
  ev: SignalEvaluation,
  status: string,
  reasoning: string,
  willExecute: boolean,
  minConfidence: number,
  budgetUsd?: number
): SignalEvaluation {
  return {
    ...ev,
    tradeType: willExecute ? 'SPOT' : 'HOLD',
    status,
    reasoning,
    willExecute,
    confidenceGap: Math.max(0, minConfidence - ev.confidence),
    ...(budgetUsd !== undefined ? { budgetUsd } : {})
  };
}

export function applyProEntryGates(
  evaluations: SignalEvaluation[],
  ctx: ProGateContext
): SignalEvaluation[] {
  const heldSymbols = new Set(ctx.positions.map((p) => p.symbol));
  const queuedSymbols = new Set(ctx.pending.map((o) => o.symbol));
  const minConfidence = proMinConfidence(ctx.riskLevel, ctx.minConfidenceOverride);

  // §4 gate 5: open positions AND queued buys occupy slots. A slot an exit is
  // about to free stays occupied until that exit FILLS — but a queued buy that
  // has not filled is only a reservation, and a clearly stronger fresh signal
  // may evict the weakest one (see the gate below).
  let occupiedSlots = ctx.positions.length + ctx.pending.filter((o) => o.side === 'buy').length;
  // Resting buys this batch has already agreed to evict, so two candidates in
  // one tick cannot both free the same slot.
  const preemptClaimed = new Set<string>();
  // Budget is tracked against CASH (what's actually spendable), not equity —
  // an allocation that equity would allow but cash couldn't cover would create
  // an order the fill step then refuses, producing "ready to buy" with no
  // purchase. projectedCash decreases as we allocate within this batch.
  let projectedCash = ctx.cash;

  return evaluations
    .map((ev, i) => ({ ev, i }))
    .sort((a, b) => (b.ev.confidence - a.ev.confidence) || (a.i - b.i))
    .map(({ ev }) => {
      if (ev.action === 'sell') {
        // §4's sell logic: not held → no action (Spot never shorts). Held → a
        // close order for the WHOLE position goes out this tick, via the exit
        // loop in generateProOrders, which owns §5's fixed percentages and the
        // confidence-gated flip alike.
        if (queuedSymbols.has(ev.symbol)) {
          return gateResult(ev, 'NO_SIGNAL [ORDER_QUEUED]', 'פקודת מכירה כבר בתור ביצוע', false, minConfidence);
        }
        if (!heldSymbols.has(ev.symbol)) return ev;
        if (ev.confidence >= minConfidence) {
          return gateResult(ev, 'SIGNAL SPOT SELL', 'אות SELL מעל הסף — נשלחת פקודת מכירה לכל הפוזיציה', true, minConfidence);
        }
        return gateResult(
          ev,
          'NO_SIGNAL [BELOW_THRESHOLD]',
          `היפוך SELL מתחת לסף (${ev.confidence.toFixed(1)} < ${minConfidence}) — הפוזיציה נשארת פתוחה, SL/TP עדיין פעילים`,
          false,
          minConfidence
        );
      }
      if (ev.action !== 'buy') return ev;

      // §4's buy sequence, in the doc's own order (gate 1, "הבוט פעיל?", is
      // the runtime itself — a stopped engine produces no evaluations):
      if (queuedSymbols.has(ev.symbol)) {                                                                                       // 2
        return gateResult(ev, 'NO_SIGNAL [ORDER_QUEUED]', 'פקודה בתור ביצוע', false, minConfidence);
      }
      if (heldSymbols.has(ev.symbol)) {                                                                                         // 3
        return gateResult(ev, 'NO_SIGNAL [ALREADY_HELD]', 'כבר מוחזק בתיק', false, minConfidence);
      }
      // Knife-catch guard, softened: a background downtrend only blocks a BUY
      // that is NEITHER a deep-oversold reversal (RSI <= 42) NOR high-conviction
      // (confidence >= 75). The trend-participation lane is never affected — it
      // requires price ABOVE EMA50, so isDowntrend is false there by construction.
      if (ev.isDowntrend && ev.confidence < 75 && (ev.indicators?.rsi ?? 50) > 42) {
        return gateResult(ev, 'NO_SIGNAL [DOWNTREND_FILTER]', 'מגמת רקע דובית (EMA50 < EMA200) וקנייה לא-oversold / בביטחון בינוני — חסום למניעת תפיסת סכינים נופלות', false, minConfidence);
      }
      if (ev.confidence < minConfidence) {                                                                                      // 4
        return gateResult(ev, 'NO_SIGNAL [BELOW_THRESHOLD]', `ביטחון נמוך מהסף (${ev.confidence.toFixed(1)} < ${minConfidence})`, false, minConfidence);
      }

      if (occupiedSlots >= ctx.maxPositions) {                                                                                  // 5
        // A resting (unfilled) buy is a reservation, not a position. If this
        // BUY clearly outranks the weakest resting one, evict it and take the
        // slot; generateProOrders emits this order and the tick loop cancels
        // the incumbent once it is actually placed.
        const victimId = pickPreemptibleEntryOrder(ev.confidence, ctx.pending, preemptClaimed);
        if (!victimId) {
          return gateResult(ev, 'NO_SIGNAL [NO_SLOTS]', `אין סלוט פנוי (${occupiedSlots}/${ctx.maxPositions})`, false, minConfidence);
        }
        preemptClaimed.add(victimId);
        ev.preemptsOrderId = victimId;
      }
      if (!ev.price || ev.price <= 0) {                                                                                         // 6
        return gateResult(ev, 'NO_SIGNAL [NO_PRICE]', 'אין מחיר תקף', false, minConfidence);
      }
      if (isBelowCapitalFloor(ctx.initialAmount, ctx.equity)) {                                                                  // 7
        return gateResult(
          ev,
          'NO_SIGNAL [CAPITAL_FLOOR]',
          `הון ${ctx.equity.toFixed(2)}$ מתחת ל-${(CAPITAL_FLOOR_PCT * 100).toFixed(0)}% מההון ההתחלתי ${ctx.initialAmount.toFixed(2)}$ — כניסות חדשות מושהות`,
          false,
          minConfidence
        );
      }
      // Allocation is confidence-independent under the 10% position-target
      // model. Every new position targets 10% of current equity, regardless of
      // confidence score. Confidence is used for entry gating only.
      // Pinned to the STARTING capital, not live equity (operator decision
      // 2026-09-08). Sizing against equity meant the $100 order floor equalled
      // exactly 10% of the $1,000 starting capital, so the first cent of
      // drawdown refused every entry — measured here at equity $986.78 with
      // six positions open and plenty of cash. See resolveSizingBase.
      const sizingBase = resolveSizingBase(ctx.initialAmount, ctx.equity);
      const perAssetCap = sizingBase * (PER_ASSET_EXPOSURE_CAP_PERCENT / 100);
      const targetNotional = sizingBase * POSITION_TARGET_PCT;
      const rawBudget = Math.min(targetNotional, projectedCash, perAssetCap);
      // Skip if target is below exchange minimum — no overshoot.
      if (rawBudget < MIN_SIM_ENTRY_USD) {
        return gateResult(ev, 'NO_SIGNAL [MIN_ORDER_EXCEEDS_POSITION_TARGET]', `יעד ${rawBudget.toFixed(2)}$ מתחת למינימום ${MIN_SIM_ENTRY_USD}$`, false, minConfidence);
      }
      occupiedSlots++;                                                                                                          // 8
      projectedCash -= rawBudget;
      return gateResult(ev, 'SIGNAL SPOT BUY', `אות BUY בביטחון ${ev.confidence.toFixed(1)} >= סף ${minConfidence} — מבצע קנייה`, true, minConfidence, rawBudget);
    });
}

export interface ProOrderGenContext {
  positions: SimPosition[];
  pending: PendingOrder[];
  evaluations: SignalEvaluation[];
  /** Per-symbol current signal, for the exit check (§4's "flip to SELL"). */
  signalsBySymbol: Record<string, ProSignalResult>;
  minConfidence: number;
  executionDelaySec: number;
  /** Per-symbol timestamp of the last full exit. Pro had NO re-entry cooldown
   *  at all until 2026-09-14 — it was the one sim bot whose order generator
   *  never received this map, so it re-bought a symbol minutes after closing
   *  it (B3: closed +$12.23 at 13:45, re-bought 13:56, stopped out at 14:05).
   *  See ENTRY_COOLDOWN_MS. */
  exitCooldown?: Record<string, number>;
  priceFor: (symbol: string) => number | undefined;
  /** §6 execution mode. When true, entries rest as LIMIT orders at the signal
   *  price — the bot waits until the market reaches it (or a better price) and
   *  only then buys (Fills are Maker, and slippage is zero). When false
   *  (default, per alg.md §6) entries fire at executeAt as adverse-slippage
   *  MARKET fills. */
  limitEntries?: boolean;
}

export function generateProOrders(ctx: ProOrderGenContext): PendingOrder[] {
  const { positions, pending, evaluations, signalsBySymbol, minConfidence, executionDelaySec, priceFor, limitEntries } = ctx;
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
      action: 'HOLD', buyScore: 0, sellScore: 0, holdScore: 100, totalWeight: 0, confidence: 0, atrPercent: 0, signals: [],
      indicators: { rsi: 50, ma20: livePrice, volumeTrend: 'stable', bollingerBands: { upper: livePrice, middle: livePrice, lower: livePrice, position: 'between' }, volumeProfile: { poc: livePrice, valueAreaHigh: livePrice, valueAreaLow: livePrice, position: 'in_value_area' } }
    };

    const isLong = isLongSide(pos.side);
    const exitCheck = evaluateProExit(
      {
        entryPrice: pos.entryPrice, isLong, tp1Hit: pos.tp1Hit,
        stopLoss: pos.stopLoss, takeProfit1: pos.takeProfit1, takeProfit2: pos.takeProfit2,
        peakPrice: (isLong ? pos.highestPrice : pos.lowestPrice) ?? pos.entryPrice,
        ratchetConsumed: pos.ratchetConsumed
      },
      livePrice,
      effectiveSignal,
      minConfidence,
      // Sim only — the LIVE Pro path never sets this. See profitRatchet.ts.
      { profitRatchet: true }
    );
    if (!exitCheck.shouldExit) continue;

    const ratchetPartial = exitCheck.exitType === 'PARTIAL_RATCHET';
    const partial = ratchetPartial || exitCheck.exitType === 'PARTIAL_50';
    const fraction = ratchetPartial ? (exitCheck.ratchetFraction ?? 0) : TP1_EXIT_FRACTION;
    newOrders.push({
      id: uid(`${pos.symbol}-${partial ? (ratchetPartial ? 'ratchet' : 'tp1') : 'exit'}`),
      symbol: pos.symbol, positionId: pos.id, type: 'SPOT',
      side: partial ? 'partial_tp1' : 'close_long',
      exitFraction: partial ? fraction : undefined,
      ratchetConsumed: exitCheck.ratchetConsumed,
      signalPrice: livePrice,
      quantity: partial ? pos.quantity * fraction : pos.quantity,
      reason: exitCheck.reason,
      confidence: pos.confidence ?? 0, executeAt: Date.now() + delayMs, createdAt: Date.now()
    } as PendingOrder);
  }

  // §4's entry gates have ALREADY run — on the evaluations themselves
  // (applyProEntryGates), which is §4's single source of truth. This loop only
  // emits what an evaluation approved. The held/pending re-check is
  // defense-in-depth for runtimes where the evaluation pass and this pass can
  // straddle a state change (the browser fallback recomputes on a 5s
  // heartbeat) — not a second gate.
  for (const ev of evaluations) {
    if (!ev.willExecute || ev.action !== 'buy' || !ev.price) continue;
    // Re-entry cooldown (2026-09-14). Reported, not a bare `continue` — an
    // operator looking at "why didn't it buy" needs to see this.
    if (isInEntryCooldown(ctx.exitCooldown?.[ev.symbol])) {
      blockEntry(ev, 'ENTRY_COOLDOWN', 'צינון אחרי יציאה קודמת במטבע הזה', '[pro-sim]');
      continue;
    }
    const budget = ev.budgetUsd ?? 0; // §4 gate 7, allocated in the gate pass
    // Was a bare `continue` — the same blindness that hid Bybit's zero-entry
    // run. The §4 gate pass already approved this evaluation, so a refusal here
    // is exactly the case an operator needs to see.
    if (budget < MIN_SIM_ENTRY_USD) {
      blockEntry(
        ev,
        MIN_ORDER_EXCEEDS_POSITION_TARGET,
        `הקצאת §4 היא $${budget.toFixed(2)} < מינימום הזמנה $${MIN_SIM_ENTRY_USD}`,
        '[pro-sim]'
      );
      continue;
    }
    if (positions.some((p) => p.symbol === ev.symbol)) continue;
    if (newOrders.some((o) => o.symbol === ev.symbol) || pending.some((o) => o.symbol === ev.symbol)) continue;

    // §6: when limitEntries is on, use the optimal entry price (computed from
    // support levels) instead of the current market price. This is typically
    // LOWER — the bot waits for a dip to enter at a better price.
    const entryPrice = limitEntries && ev.optimalEntryPrice ? ev.optimalEntryPrice : ev.price;

    newOrders.push({
      id: uid(`${ev.symbol}-buy`), symbol: ev.symbol, type: 'SPOT', side: 'buy',
      signalPrice: entryPrice, quantity: budget / entryPrice, budgetUsd: budget, leverage: 1,
      // ATR-scaled levels off the signal price; fillDueOrders reanchors to fill.
      stopLoss: ev.stopLoss, takeProfit1: ev.takeProfit1, takeProfit2: ev.takeProfit2, takeProfit: ev.takeProfit1,
      // §6 default: delayed MARKET fills — at executeAt the order fills at the
      // market price of that moment, adverse slippage and a Taker fee included.
      // With `limitEntries` on, the order rests as a LIMIT at the optimal entry
      // price (from support levels): the bot waits until the market reaches that
      // price (or better, i.e. lower for a buy) and only then buys — "יחשב מתי
      // להיכנס, יגיע לשער וירכוש". Fills are Maker (lower fee) and carry no slippage.
      fill: limitEntries ? 'limit' : 'market',
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
