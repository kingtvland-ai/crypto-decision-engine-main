// Order generation, sizing, scale-in and exit management for the TrendBreakout
// bot. Shares the fill/fee/slippage core (fillDueOrders), the entry/streak
// cooldowns and the drawdown / exposure constants with the other three sim
// bots — so a difference in results is a difference in DECISIONS, not in
// plumbing. What is genuinely its own:
//
//   · sizing: the shared 10% target, measured against the bot's STARTING
//     capital (POSITION_TARGET_PCT × initialAmount, see resolveSizingBase). The stop
//     loss only MEASURES the resulting dollar risk — it never sets the size.
//     Hard-capped by the shared per-asset (PER_ASSET_EXPOSURE_CAP_PERCENT = 10%)
//     and total (MAX_TOTAL_EXPOSURE_PERCENT = 80%) limits (spec §15).
//     (This header used to describe risk-based sizing — (equity × riskPerTrade)
//     / |entry − SL| — and 8%/20% caps. All three numbers were stale.)
//   · scale-in (spec §11): the shared fill core cannot add to a position, so
//     each of the 50/30/20 % lots is its OWN SimPosition. One logical trade =
//     every lot with the same base asset + side. Lots share one logical
//     SL/TP and are closed together. At small equity the lots are merged so
//     none falls under the $100 order floor — see resolveScaleFractions.
//   · stop management (spec §12): break-even at +1R, ATR trailing from +1.5R,
//     recomputed every tick from the immutable entry + the factory-tracked
//     highest/lowest price (the codebase never mutates pos.stopLoss).
//   · exits (spec §13): effective stop — CLOSE-CONFIRMED on the last closed
//     M15 candle (a wick through the stop does not close the trade; the
//     shared 4.2% cap is the one intrabar emergency exit), TP ladder, H1
//     Supertrend reversal, 24×H1 time stop.

import { Candle, calculateATR, calculateSupertrend } from './tradeEngine';
import type { SignalEvaluation } from './intradayBridge';
import type { SimPosition, PendingOrder, ReentryCooldownState } from './simExecution';
import {
  isInEntryCooldown,
  MIN_SIM_ENTRY_USD,
  MIN_ORDER_EXCEEDS_POSITION_TARGET,
  blockEntry as blockEntryShared,
  pickPreemptibleEntryOrder
} from './simExecution';
import {
  reachedStop,
  positionPnlPercent,
  capStopLoss,
  maxLossStopLevel,
  TP1_EXIT_FRACTION,
  MAX_LOSS_PERCENT
} from './exitPolicy';
import {
  isInStreakCooldown,
  streakCooldownFromHistory,
  portfolioStreakCooldownUntil,
  portfolioStreakCooldownReason,
  ClosedTradeRecord
} from './adaptiveRisk';
import {
  evaluateCorrelationGate,
  blocksOnAbstention,
  abstentionBlockReason,
  toPositionDirection,
  DEFAULT_MAX_CORRELATED,
  type CorrelatedHolding
} from './correlation';
import {
  DAILY_DRAWDOWN_BLOCK_PERCENT,
  WEEKLY_DRAWDOWN_LOCK_PERCENT,
  PER_ASSET_EXPOSURE_CAP_PERCENT,
  MAX_TOTAL_EXPOSURE_PERCENT,
  CAPITAL_FLOOR_PCT,
  resolveSizingBase,
  isBelowCapitalFloor
} from './intradayParams';
import {
  DEFAULT_TREND_BREAKOUT_PARAMS,
  TrendBreakoutParams,
  readTrendBreakoutPlan
} from './trendBreakout';
import { evaluateRatchet, ratchetReason } from './profitRatchet';

export const uid = (p: string) => `tb-${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

const H4_MS = 4 * 60 * 60 * 1000;

// Now defined once in simExecution.ts alongside MIN_SIM_ENTRY_USD, since all
// four bots raise it. Re-exported so existing importers keep working.
export { MIN_ORDER_EXCEEDS_POSITION_TARGET };

/**
 * The scale-in shape this equity can actually express, given that NO LOT MAY
 * BE SMALLER THAN `minLotUsd`.
 *
 * This bot is the only one of the four with scale-in, and that made it the only
 * one that could never trade at small equity: the first lot is 50% of the 10%
 * target, so at $1,000 equity it asked for $50 against a $100 floor and every
 * signal — including a 93%-confidence one — was dropped by a silent `continue`.
 * The other three bots size a single $100 lot and were unaffected, which is why
 * only this bot sat at zero positions.
 *
 * MIN_ORDER stays a CONSTRAINT, not a sizing input: the 10% target is never
 * inflated to clear the floor. What adapts is how the target is SPLIT — the
 * fractions are merged forward until each surviving lot clears the floor, so
 * the returned fractions always sum to exactly 1 (the full target, never more).
 *
 *   target $2,000 → [0.5, 0.3, 0.2]  (unchanged: 1000/600/400 all clear $100)
 *   target   $250 → [0.5, 0.5]       (125/125 — the 0.3 lot would be $75)
 *   target   $100 → [1]              (one $100 lot, no scale-in)
 *   target    $80 → []               (below the floor entirely — skip, correctly)
 *
 * Exported for the tests; pure, no side effects.
 */
export function resolveScaleFractions(
  targetNotional: number,
  fractions: number[],
  minLotUsd: number = MIN_SIM_ENTRY_USD
): number[] {
  if (!(targetNotional >= minLotUsd)) return [];
  const out: number[] = [];
  let carry = 0;
  for (const f of fractions) {
    if (!(f > 0)) continue;
    carry += f;
    if (targetNotional * carry >= minLotUsd) {
      out.push(carry);
      carry = 0;
    }
  }
  // Trailing crumbs too small to stand alone join the last lot rather than
  // being dropped — otherwise the lots would sum to less than the target.
  if (carry > 0) {
    if (out.length > 0) out[out.length - 1] += carry;
    else out.push(carry);
  }
  return out;
}

export interface TrendBreakoutCandleSet {
  h1: Candle[];
  m15: Candle[];
  m5: Candle[];
}

export interface TrendBreakoutOrderGenContext {
  positions: SimPosition[];
  pending: PendingOrder[];
  evaluations: SignalEvaluation[];
  executionDelaySec: number;
  dailyDrawdownPercent: number;
  weeklyDrawdownPercent: number;
  cash: number;
  equity: number;
  /** The bot's STARTING capital. Position size and every percent-of-capital cap
   *  are pinned to THIS, not to live equity, so a drawdown reduces how many
   *  positions fit rather than shrinking each one. Absent → size against equity
   *  (previous behaviour). See resolveSizingBase. */
  initialAmount?: number;
  /** FUTURES notional already open (from the engine factory). */
  totalLeveragedExposureUsd: number;
  exitCooldown: Record<string, ReentryCooldownState>;
  priceFor: (symbol: string) => number | undefined;
  /** Keyed by BASE asset — same keys the evaluations and positions use. */
  candlesBySymbol: Record<string, TrendBreakoutCandleSet | undefined>;
  closedTradeMetrics?: ClosedTradeRecord[];
  /** Max concurrent LOGICAL trades (base+side groups), not lots. */
  maxConcurrentTrades: number;
  /** SimBotConfig.proLimitEntries. true → every lot (fresh + scale-in) rests as
   *  a LIMIT at the signal price (fills on a pullback back to it, else expires);
   *  false → delayed MARKET fill with adverse slippage (the default — a
   *  breakout normally wants the fill now). */
  limitEntries?: boolean;
  params?: Partial<TrendBreakoutParams>;
  /** The engine's clock for this batch. Defaults to `Date.now()`, so every
   *  existing caller is unchanged. A historical replay injects a synthetic
   *  clock instead, so order timestamps, TTLs and the max-hold time stop
   *  advance with the replayed bars rather than the wall clock. */
  now?: number;
}

interface LogicalTrade {
  base: string;
  side: 'LONG' | 'SHORT';
  lots: SimPosition[];
}

const ENTRY_SIDES = new Set(['buy', 'sell', 'long', 'short']);

function groupLogicalTrades(positions: SimPosition[]): LogicalTrade[] {
  const map = new Map<string, LogicalTrade>();
  for (const pos of positions) {
    const side: 'LONG' | 'SHORT' = pos.side === 'SHORT' || pos.side === 'SELL' ? 'SHORT' : 'LONG';
    const key = `${pos.symbol}|${side}`;
    let lt = map.get(key);
    if (!lt) {
      lt = { base: pos.symbol, side, lots: [] };
      map.set(key, lt);
    }
    lt.lots.push(pos);
  }
  // Oldest lot first — it anchors the logical entry / R.
  for (const lt of map.values()) lt.lots.sort((a, b) => a.openTimestamp - b.openTimestamp);
  return [...map.values()];
}

function positionNotional(pos: SimPosition, priceFor: (s: string) => number | undefined): number {
  const live = priceFor(pos.symbol) ?? pos.currentPrice ?? pos.entryPrice;
  // quantity already carries leverage for FUTURES (=1 here), so notional is
  // quantity × price for both position types.
  return pos.quantity * live;
}

function currentH1Supertrend(
  set: TrendBreakoutCandleSet | undefined,
  p: TrendBreakoutParams
): 'BULL' | 'BEAR' | undefined {
  if (!set || !set.h1 || set.h1.length < p.supertrendAtrPeriod + 2) return undefined;
  return calculateSupertrend(set.h1, p.supertrendAtrPeriod, p.supertrendMultiplier).direction;
}

function currentAtrM15(set: TrendBreakoutCandleSet | undefined, p: TrendBreakoutParams): number | undefined {
  if (!set || !set.m15 || set.m15.length < p.atrPeriod + 1) return undefined;
  return calculateATR(set.m15, p.atrPeriod).atr;
}

/**
 * Effective stop for a logical trade this tick — break-even at +breakEvenR,
 * ATR trailing from +trailingStartR, never looser than the entry stop.
 */
export function effectiveStop(
  lt: LogicalTrade,
  livePrice: number,
  atrM15Now: number | undefined,
  p: TrendBreakoutParams
): { stop: number; progressR: number } {
  const first = lt.lots[0];
  const isLong = lt.side === 'LONG';
  const entry0 = first.entryPrice;
  const stop0 = first.stopLoss;
  const rUnit = Math.abs(entry0 - stop0) || (Math.abs(entry0) * 0.005);

  const extreme = isLong
    ? Math.max(...lt.lots.map((l) => l.highestPrice ?? l.entryPrice), livePrice)
    : Math.min(...lt.lots.map((l) => l.lowestPrice ?? l.entryPrice), livePrice);
  const progressR = ((extreme - entry0) * (isLong ? 1 : -1)) / rUnit;

  let stop = stop0;
  if (progressR >= p.breakEvenR) {
    stop = isLong ? Math.max(stop, entry0) : Math.min(stop, entry0);
  }
  if (progressR >= p.trailingStartR && atrM15Now && atrM15Now > 0) {
    const trail = isLong
      ? extreme - p.trailingAtrMultiplier * atrM15Now
      : extreme + p.trailingAtrMultiplier * atrM15Now;
    stop = isLong ? Math.max(stop, trail) : Math.min(stop, trail);
  }
  // Never loosen past the original protective stop.
  stop = isLong ? Math.max(stop, stop0) : Math.min(stop, stop0);
  // Scale-in lots are entered progressively further from stop0 than lot 0 —
  // a lot added at +0.5R sits 1.5R from the shared stop. Without this, a
  // reversal loses MORE on that lot than a clean −1R stop-out would, so the
  // logical trade's downside grows every time it scales. Pull the shared stop
  // up (down, for a short) so the WORST-positioned lot never risks more than
  // rUnit (= |entry0 − stop0|, already ≤ the 4.2% cap). Single-lot trade:
  // worstEntry === entry0 → scaleFloor === stop0 → inert.
  const worstEntry = isLong
    ? Math.max(...lt.lots.map((l) => l.entryPrice))
    : Math.min(...lt.lots.map((l) => l.entryPrice));
  const scaleFloor = isLong ? worstEntry - rUnit : worstEntry + rUnit;
  stop = isLong ? Math.max(stop, scaleFloor) : Math.min(stop, scaleFloor);
  // Apply the shared 4.2% loss cap — tightens stop if needed, never loosens.
  // The signal computed structuralStop from slAtrMultiplier×ATR; trailing may
  // have loosened it, but the policy ceiling applies to all exits (operator
  // decision 2026-09-08).
  stop = capStopLoss(entry0, stop, isLong);
  return { stop, progressR };
}

export function generateTrendBreakoutOrders(ctx: TrendBreakoutOrderGenContext): PendingOrder[] {
  const p: TrendBreakoutParams = { ...DEFAULT_TREND_BREAKOUT_PARAMS, ...(ctx.params ?? {}) };
  const now = ctx.now ?? Date.now();
  const delayMs = Math.max(0, ctx.executionDelaySec) * 1000;
  const newOrders: PendingOrder[] = [];

  const trades = groupLogicalTrades(ctx.positions);
  const claimedPositionIds = new Set(
    ctx.pending.filter((o) => o.positionId).map((o) => o.positionId as string)
  );

  const blockEntry = (ev: SignalEvaluation, code: string, message: string) =>
    blockEntryShared(ev, code, message, '[bybit-sim]');

  // ── Exits (spec §13) — per logical trade; closes every lot together ──────
  const closingBaseSides = new Set<string>();
  for (const lt of trades) {
    if (lt.lots.every((l) => claimedPositionIds.has(l.id))) continue;
    const set = ctx.candlesBySymbol[lt.base];
    const live = ctx.priceFor(lt.base) ?? lt.lots[0].currentPrice ?? lt.lots[0].entryPrice;
    const isLong = lt.side === 'LONG';
    const first = lt.lots[0];
    const atrM15Now = currentAtrM15(set, p);
    const { stop, progressR } = effectiveStop(lt, live, atrM15Now, p);

    // Stop exits trigger immediately on touch/cross — no candle-close
    // confirmation. The executed stop is the effective stop (4.2% cap applied).
    // The shared cap below is the emergency brake that still fires on touch.
    // Defensive fallback: with no M15 series the stop reverts to touch behaviour.
    const capLevel = maxLossStopLevel(first.entryPrice, isLong);
    // The 4.2% cap must bound EVERY lot, not just lot 0: a scale-in lot entered
    // up to 1R higher hits its own −4.2% before lot 0's capLevel is reached. If
    // an intrabar gap blows past effectiveStop's scaleFloor, this catches the
    // worst lot regardless of which lot anchors the shared level.
    const worstLotLossPct = Math.max(
      ...lt.lots.map((l) => -positionPnlPercent(l.entryPrice, live, isLong))
    );

    const pnlPct = positionPnlPercent(first.entryPrice, live, isLong);
    // No TP-level exit here by design: the ratchet below owns every profit
    // exit for this bot, so the plan's takeProfit1/takeProfit2 are carried on
    // the order for reporting only and are never compared against `live`.
    // (`tp` / `tp2` / `tp2Reached` locals computing exactly that comparison
    // sat here unread — removed 2026-09-16.)

    // Profit ratchet (2026-09-14) — replaced the TP1-half / TP2 pair outright.
    // Crossing 1.8/3/4/5%… marks a rung and sells nothing; coming back down to
    // one sells 30% of every lot, or closes the trade at the 1.8% floor. The
    // peak is the best price any lot has seen, measured against lot 0's entry —
    // the same anchor pnlPct above already uses. See profitRatchet.ts.
    const peaks = lt.lots.map((l) => (isLong ? l.highestPrice : l.lowestPrice) ?? l.entryPrice);
    const ratchet = evaluateRatchet({
      entryPrice: first.entryPrice,
      peakPrice: isLong ? Math.max(...peaks) : Math.min(...peaks),
      livePrice: live,
      isLong,
      peakPctAtLastPartial: first.ratchetPeakPct,
      remainingNotionalUsd: lt.lots.reduce((s, l) => s + l.quantity * live, 0)
    });

    const openLots = lt.lots.filter((l) => !claimedPositionIds.has(l.id));
    if (ratchet.action === 'PARTIAL' && openLots.length > 0) {
      closingBaseSides.add(`${lt.base}|${lt.side}`);
      for (const lot of openLots) {
        newOrders.push({
          id: uid(`${lt.base}-ratchet`),
          symbol: lt.base,
          positionId: lot.id,
          type: lot.type,
          side: 'partial_tp1',
          exitFraction: ratchet.fraction,
          ratchetPeakPct: ratchet.peakPctAtLastPartial,
          signalPrice: live,
          quantity: lot.quantity * (ratchet.fraction ?? 0),
          reason: ratchetReason(ratchet),
          confidence: lot.confidence,
          executeAt: now + delayMs,
          createdAt: now
        });
      }
      continue;
    }

    let reason = '';
    if (reachedStop(live, capLevel, isLong) || worstLotLossPct >= MAX_LOSS_PERCENT) {
      reason = `חריגת תקרת הפסד ${MAX_LOSS_PERCENT}% בתוך נר — יציאת חירום (${pnlPct.toFixed(2)}%)`;
    } else if (ratchet.action === 'FULL') {
      reason = ratchetReason(ratchet);
    } else if (!ratchet.armed && reachedStop(live, stop, isLong)) {
      // The ATR trail governs only BELOW the first rung. Once +1.8% has been
      // crossed the ladder owns the exit (operator decision 2026-09-14) — the
      // trail used to close these positions long before a rung was given back,
      // which is exactly the give-back-the-profit behaviour being removed.
      // "תקרה" only when the cap is what actually binds the stop (capStopLoss
      // pulled the ATR stop in) — a normal ATR stop is labelled as such.
      const atCap = Math.abs(stop - capLevel) <= Math.abs(capLevel) * 1e-9 + 1e-12;
      const stopTag = atCap ? `תקרה ${MAX_LOSS_PERCENT}%` : 'סטופ ATR';
      reason = progressR >= p.breakEvenR
        ? `Trailing/BE stop ב-${stop.toFixed(6)} (${progressR.toFixed(2)}R)`
        : `Stop Loss ב-${stop.toFixed(6)} (${pnlPct.toFixed(2)}%, ${stopTag})`;
    } else {
      const stNow = currentH1Supertrend(set, p);
      if (stNow && (isLong ? stNow === 'BEAR' : stNow === 'BULL')) {
        // A confirmed trend reversal still closes a laddered position: this bot
        // only exists while the trend holds.
        reason = `היפוך מגמה — H1 Supertrend התהפך ל-${stNow}`;
      } else if (!ratchet.armed && now - first.openTimestamp >= p.maxHoldHours * 60 * 60 * 1000) {
        // Half-close, not full, the first time (2026-09-16 — same fix as
        // Intraday's Time Stop, same live-data shape: a full close marks the
        // ENTIRE logical trade to market on one tick while the ratchet above
        // only ever realizes profit incrementally). `first.tp1Hit` doubles as
        // "already half-closed once" (set by the SAME partial_tp1 fill path
        // the ratchet's own PARTIAL branch above already uses) — a second hit
        // closes what's left, in full, so this cannot decay geometrically.
        if (!first.tp1Hit) {
          closingBaseSides.add(`${lt.base}|${lt.side}`);
          for (const lot of openLots) {
            newOrders.push({
              id: uid(`${lt.base}-timestop`),
              symbol: lt.base,
              positionId: lot.id,
              type: lot.type,
              side: 'partial_tp1',
              exitFraction: 0.5,
              signalPrice: live,
              quantity: lot.quantity * 0.5,
              reason: `Time Stop (חלקי 50%, השאר ממשיך) — ${p.maxHoldHours} נרות H1 (${progressR.toFixed(2)}R)`,
              confidence: lot.confidence,
              executeAt: now + delayMs,
              createdAt: now
            });
          }
          continue;
        }
        reason = `Time Stop — ${p.maxHoldHours} נרות H1 (${progressR.toFixed(2)}R) — סגירה מלאה (כבר מומש חלקית)`;
      }
    }

    if (!reason) continue;
    closingBaseSides.add(`${lt.base}|${lt.side}`);
    for (const lot of lt.lots) {
      if (claimedPositionIds.has(lot.id)) continue;
      newOrders.push({
        id: uid(`${lt.base}-exit`),
        symbol: lt.base,
        positionId: lot.id,
        type: lot.type,
        side: isLong ? 'close_long' : 'close_short',
        signalPrice: live,
        quantity: lot.quantity,
        reason,
        confidence: lot.confidence,
        executeAt: now + delayMs,
        createdAt: now
      });
    }
  }

  // ── Circuit breaker (spec §16) — exits only past this point ─────────────
  if (
    ctx.dailyDrawdownPercent >= DAILY_DRAWDOWN_BLOCK_PERCENT ||
    ctx.weeklyDrawdownPercent >= WEEKLY_DRAWDOWN_LOCK_PERCENT
  ) {
    return newOrders;
  }

  // Running exposure / cash / count as this batch adds orders.
  let workingCash = ctx.cash;
  // Sizing and every percent-of-capital cap read the STARTING capital, so a
  // drawdown reduces how many positions fit (cash is still a hard limit) and
  // never how big each one is. See resolveSizingBase.
  const sizingBase = resolveSizingBase(ctx.initialAmount, ctx.equity);
  const perAssetCap = sizingBase * (PER_ASSET_EXPOSURE_CAP_PERCENT / 100);
  const totalCap = sizingBase * (MAX_TOTAL_EXPOSURE_PERCENT / 100);

  const exposureByBase = new Map<string, number>();
  let totalExposure = 0;
  for (const pos of ctx.positions) {
    const n = positionNotional(pos, ctx.priceFor);
    exposureByBase.set(pos.symbol, (exposureByBase.get(pos.symbol) ?? 0) + n);
    totalExposure += n;
  }
  for (const o of ctx.pending) {
    if (!ENTRY_SIDES.has(o.side)) continue;
    const n = o.budgetUsd ?? 0;
    exposureByBase.set(o.symbol, (exposureByBase.get(o.symbol) ?? 0) + n);
    totalExposure += n;
  }

  const tradeKey = (base: string, side: 'LONG' | 'SHORT') => `${base}|${side}`;
  const openLogicalKeys = new Set(trades.map((lt) => tradeKey(lt.base, lt.side)));
  const pendingEntryKeys = new Set(
    ctx.pending
      .filter((o) => ENTRY_SIDES.has(o.side))
      .map((o) => tradeKey(o.symbol, o.side === 'sell' || o.side === 'short' ? 'SHORT' : 'LONG'))
  );
  let logicalTradeCount = openLogicalKeys.size + pendingEntryKeys.size;
  // Resting lot-0 entry orders (no positionId — scale-in adds carry one) are
  // only reservations: a clearly stronger fresh breakout may evict the weakest.
  const preemptiblePending = ctx.pending.filter((o) => !o.positionId);
  const preemptClaimed = new Set<string>();

  /** Places one entry lot, respecting cash + both exposure caps. Returns the
    *  notional actually committed (0 if nothing could be placed). */
  const placeLot = (opts: {
    base: string;
    side: 'LONG' | 'SHORT';
    desiredNotional: number;
    price: number;
    stopLoss: number;
    takeProfit: number;
    takeProfit1: number;
    takeProfit2: number;
    confidence: number;
    reason: string;
    scaleLabel: string;
    onBlocked?: (code: string, message: string) => void;
  }): number => {
    const isLong = opts.side === 'LONG';
    const assetUsed = exposureByBase.get(opts.base) ?? 0;
    const assetHeadroom = Math.max(0, perAssetCap - assetUsed);
    const totalHeadroom = Math.max(0, totalCap - totalExposure);
    const notional = Math.min(opts.desiredNotional, assetHeadroom, totalHeadroom, workingCash);

    // MIN_ORDER is a constraint, not a sizing input. Skip when target < floor.
    // Name the constraint that actually bound: "blocked" with no cause is the
    // state this bot sat in for a whole run.
    if (notional < MIN_SIM_ENTRY_USD) {
      const binding =
        assetHeadroom <= totalHeadroom && assetHeadroom <= workingCash && assetHeadroom < opts.desiredNotional
          ? `תקרת חשיפה לנכס (${PER_ASSET_EXPOSURE_CAP_PERCENT}%) — נותרו $${assetHeadroom.toFixed(2)}`
          : totalHeadroom <= workingCash && totalHeadroom < opts.desiredNotional
            ? `תקרת חשיפה כוללת (${MAX_TOTAL_EXPOSURE_PERCENT}%) — נותרו $${totalHeadroom.toFixed(2)}`
            : workingCash < opts.desiredNotional
              ? `מזומן פנוי $${workingCash.toFixed(2)}`
              : `גודל הלוט המבוקש $${opts.desiredNotional.toFixed(2)}`;
      opts.onBlocked?.(
        MIN_ORDER_EXCEEDS_POSITION_TARGET,
        `${binding} < מינימום הזמנה $${MIN_SIM_ENTRY_USD}`
      );
      return 0;
    }

    exposureByBase.set(opts.base, assetUsed + notional);
    totalExposure += notional;
    workingCash -= notional;

    newOrders.push({
      id: uid(`${opts.base}-${isLong ? 'buy' : 'short'}`),
      symbol: opts.base,
      type: isLong ? 'SPOT' : 'FUTURES',
      side: isLong ? 'buy' : 'short',
      signalPrice: opts.price,
      quantity: notional / opts.price,
      budgetUsd: notional,
      leverage: 1,
      // ALWAYS market — `ctx.limitEntries` is deliberately not consulted here.
      // A resting limit BELOW market is adverse selection for a breakout: it
      // fills only when price comes back through the level, i.e. only when the
      // breakout is failing, while every breakout that runs (the ones this
      // strategy exists to catch) never fills at all. Live, that showed as five
      // entries, zero take-profits and three trend-reversal exits. Pullback and
      // mean-reversion engines legitimately rest below market; a Donchian
      // breakout cannot. See §5 ENTRY_TOO_EXTENDED — the chase guard, not the
      // fill mode, is what keeps the entry honest.
      fill: 'market',
      stopLoss: opts.stopLoss,
      takeProfit: opts.takeProfit,
      takeProfit1: opts.takeProfit1,
      takeProfit2: opts.takeProfit2,
      reason: `TrendBreakout ${opts.side} ${opts.scaleLabel} · ${opts.reason}`,
      confidence: opts.confidence,
      executeAt: now + delayMs,
      createdAt: now
    });
    return notional;
  };

  // ── Scale-in for existing logical trades (spec §11) ────────────────────
  for (const lt of trades) {
    const key = tradeKey(lt.base, lt.side);
    if (closingBaseSides.has(key)) continue;
    if (pendingEntryKeys.has(key)) continue; // a lot is already queued
    const lotCount = lt.lots.length;
    // The shape this equity can express (no lot below the $100 floor), not the
    // nominal 5/3/2 — at small equity the whole target is one lot and there is
    // nothing left to scale into.
    const targetNotional = sizingBase * p.positionTargetPct;
    const scaleFractions = resolveScaleFractions(targetNotional, p.scaleFractions);
    if (lotCount >= scaleFractions.length) continue;

    const set = ctx.candlesBySymbol[lt.base];
    const stNow = currentH1Supertrend(set, p);
    const isLong = lt.side === 'LONG';
    if (stNow && (isLong ? stNow !== 'BULL' : stNow !== 'BEAR')) continue;

    const live = ctx.priceFor(lt.base) ?? lt.lots[0].currentPrice ?? lt.lots[0].entryPrice;
    const first = lt.lots[0];
    const rUnit = Math.abs(first.entryPrice - first.stopLoss) || Math.abs(first.entryPrice) * 0.005;
    const progressR = ((live - first.entryPrice) * (isLong ? 1 : -1)) / rUnit;
    if (progressR <= 0) continue; // never average down (no martingale)

    const nextScaleMinR = lotCount === 1 ? p.scale2MinR : p.scale3MinR;
    if (progressR < nextScaleMinR) continue;

    const fraction = scaleFractions[lotCount] ?? 0;
    if (!(fraction > 0)) continue;

    // Position sizing: target notional = 10% of equity, independent of SL.
    // Scale-in lots are fractions of that target notional. The total logical
    // trade never exceeds 10% equity: 5% + 3% + 2% = 10%.
    //
    // The headroom cap is what actually enforces that ceiling, and it holds
    // even when the entry collapsed the scale plan into a single full-size lot
    // (small equity) or when equity has grown since the entry: what is already
    // committed to this logical trade can never be topped up past the target.
    const committed = lt.lots.reduce(
      (sum, l) => sum + (l.avgPrice || l.entryPrice) * l.quantity,
      0
    );
    const headroom = Math.max(0, targetNotional - committed);
    const desiredNotional = Math.min(targetNotional * fraction, headroom);

    if (!(desiredNotional > 0)) continue;

    placeLot({
      base: lt.base,
      side: lt.side,
      desiredNotional,
      price: live,
      stopLoss: first.stopLoss,
      // A scale-in lot joins an existing logical trade, so it inherits that
      // trade's ladder rather than deriving a new one from its own fill.
      takeProfit: first.takeProfit ?? first.takeProfit1 ?? live,
      takeProfit1: first.takeProfit1 ?? first.takeProfit ?? live,
      takeProfit2: first.takeProfit2 ?? first.takeProfit1 ?? live,
      confidence: first.confidence,
      reason: `scale ${lotCount + 1}/${p.scaleFractions.length} ב-${progressR.toFixed(2)}R`,
      scaleLabel: `scale ${lotCount + 1}/${p.scaleFractions.length}`
    });
  }

  // ── Fresh entries (SCALE_1) from SIGNAL evaluations ────────────────────
  const ranked = [...ctx.evaluations]
    .filter((ev) => ev.willExecute && ev.price)
    .sort((a, b) => b.confidence - a.confidence);

  const belowFloor = isBelowCapitalFloor(ctx.initialAmount, ctx.equity);

  // Correlation cluster gate — same helper the intraday and Path bots use.
  // A trend-following breakout bot with leverage is exactly the case where
  // five correlated longs opening on one market-wide breakout is one bet.
  const h1BySymbol: Record<string, Candle[] | undefined> = {};
  for (const [base, set] of Object.entries(ctx.candlesBySymbol)) {
    if (set?.h1?.length) h1BySymbol[base] = set.h1;
  }
  const correlationBook: CorrelatedHolding[] = [
    ...trades.map((lt) => ({ symbol: lt.base, direction: toPositionDirection(lt.side) })),
    ...ctx.pending
      .filter((o) => ENTRY_SIDES.has(o.side))
      .map((o) => ({ symbol: o.symbol, direction: toPositionDirection(o.side) }))
  ];

  for (const ev of ranked) {
    if (belowFloor) {
      blockEntry(
        ev,
        'CAPITAL_FLOOR',
        `הון $${ctx.equity.toFixed(2)} מתחת ל-${(CAPITAL_FLOOR_PCT * 100).toFixed(0)}% מההון ההתחלתי $${(ctx.initialAmount ?? 0).toFixed(2)} — כניסות חדשות מושהות`
      );
      continue;
    }
    const plan = readTrendBreakoutPlan(ev);
    if (!plan) {
      blockEntry(ev, 'NO_PLAN', 'הערכה ללא תוכנית TrendBreakout (SL/TP חסרים)');
      continue;
    }
    const side = plan.direction;
    const key = tradeKey(ev.symbol, side);
    if (openLogicalKeys.has(key) || pendingEntryKeys.has(key)) continue; // one logical trade per base+side; blocks double-entry on the same breakout
    if (closingBaseSides.has(key)) continue;
    if (isInEntryCooldown(ctx.exitCooldown[ev.symbol], ev.price, now)) {
      blockEntry(ev, 'ENTRY_COOLDOWN', 'צינון אחרי יציאה קודמת בנכס הזה');
      continue;
    }
    if (isInStreakCooldown(streakCooldownFromHistory(ctx.closedTradeMetrics ?? [], ctx.equity, ev.symbol))) {
      blockEntry(ev, 'STREAK_COOLDOWN', 'צינון אחרי רצף הפסדים');
      continue;
    }
    const bookCooldown = portfolioStreakCooldownUntil(ctx.closedTradeMetrics ?? [], ctx.equity);
    if (isInStreakCooldown(bookCooldown)) {
      blockEntry(ev, 'STREAK_COOLDOWN', portfolioStreakCooldownReason(bookCooldown!));
      continue;
    }
    if (logicalTradeCount >= ctx.maxConcurrentTrades) {
      const victimId = pickPreemptibleEntryOrder(ev.confidence, preemptiblePending, preemptClaimed);
      if (!victimId) {
        blockEntry(ev, 'MAX_CONCURRENT', `${logicalTradeCount}/${ctx.maxConcurrentTrades} עסקאות פתוחות — אין מקום`);
        continue;
      }
      preemptClaimed.add(victimId);
      ev.preemptsOrderId = victimId;
    }
    const corr = evaluateCorrelationGate({
      symbol: ev.symbol,
      direction: toPositionDirection(side),
      held: correlationBook,
      candlesBySymbol: h1BySymbol
    });
    if (!corr.allowed) {
      blockEntry(ev, 'CORRELATION', corr.reason ?? 'ריכוז יתר בנכסים מתואמים');
      continue;
    }
    if (blocksOnAbstention(corr, correlationBook.length, DEFAULT_MAX_CORRELATED)) {
      blockEntry(ev, 'CORRELATION', abstentionBlockReason(correlationBook.length, DEFAULT_MAX_CORRELATED));
      continue;
    }

    // Breakout entries fire at the live reference price, never at the plan's
    // discounted resting level — see the `fill: 'market'` note in pushOrder.
    // `plan.limitEntryPrice` stays on the plan for telemetry and for the UI's
    // "waiting for" display; it is no longer an order price.
    const price = plan.entryRef || ev.price;

    // Position sizing: 10% of equity, independent of stop-loss distance.
    // SL is used only to measure the resulting dollar risk.
    //
    // The first lot is the first fraction the CURRENT equity can express with
    // no lot under the $100 floor — [0.5,0.3,0.2] at $2,000+ target, a single
    // [1] lot at a $100 target. Sizing the first lot at a flat 0.5 made this
    // bot unable to open anything at all below $2,000 equity, silently.
    const targetNotional = sizingBase * p.positionTargetPct;
    const scaleFractions = resolveScaleFractions(targetNotional, p.scaleFractions);

    if (scaleFractions.length === 0) {
      blockEntry(
        ev,
        MIN_ORDER_EXCEEDS_POSITION_TARGET,
        `יעד הפוזיציה $${targetNotional.toFixed(2)} (${(p.positionTargetPct * 100).toFixed(0)}% מההון) < מינימום הזמנה $${MIN_SIM_ENTRY_USD}`
      );
      continue;
    }

    const desiredNotional = targetNotional * scaleFractions[0];

    // entryRef is the signal-time price; the actual fill may differ (execution
    // delay, limit vs market). Shift SL/TP by the same delta so the risk
    // distance in price units is preserved regardless of where the order fills.
    const entryDiff = price - plan.entryRef;
    const sideIsLong = side === 'LONG';
    const adjustedStopLoss = sideIsLong ? plan.stopLoss + entryDiff : plan.stopLoss + entryDiff;
    const adjustedTakeProfit = sideIsLong ? plan.takeProfit + entryDiff : plan.takeProfit + entryDiff;
    const adjustedTakeProfit1 = sideIsLong ? plan.takeProfit1 + entryDiff : plan.takeProfit1 + entryDiff;
    const adjustedTakeProfit2 = sideIsLong ? plan.takeProfit2 + entryDiff : plan.takeProfit2 + entryDiff;

    const committed = placeLot({
      base: ev.symbol,
      side,
      desiredNotional,
      price,
      stopLoss: adjustedStopLoss,
      takeProfit: adjustedTakeProfit,
      takeProfit1: adjustedTakeProfit1,
      takeProfit2: adjustedTakeProfit2,
      confidence: ev.confidence,
      reason: `כניסה ראשונית · SL ${adjustedStopLoss.toFixed(6)} TP ${adjustedTakeProfit.toFixed(6)}`,
      scaleLabel: `scale 1/${scaleFractions.length}`,
      onBlocked: (code, message) => blockEntry(ev, code, message)
    });
    if (committed > 0) {
      logicalTradeCount++;
      openLogicalKeys.add(key);
      pendingEntryKeys.add(key);
      correlationBook.push({ symbol: ev.symbol, direction: toPositionDirection(side) });
    }
  }

  return newOrders;
}
