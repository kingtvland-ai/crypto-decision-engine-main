// Order generation for the Prev-4H Range bot ("נתיב 4H"). One position per
// symbol, no scale-in. Shares the fill/fee/slippage core (fillDueOrders), the
// entry cooldown and the drawdown / exposure constants with the other three
// sim bots — a difference in results is a difference in DECISIONS.
//
// Its own:
//   · sizing: the shared 10% target, measured against the bot's STARTING
//     capital (positionTargetPct × initialAmount, see resolveSizingBase). The stop
//     loss only MEASURES the resulting dollar risk — it never sets the size.
//     Hard-capped by the shared per-asset (PER_ASSET_EXPOSURE_CAP_PERCENT = 10%)
//     and total (MAX_TOTAL_EXPOSURE_PERCENT = 80%) caps and the $100
//     MIN_SIM_ENTRY_USD floor.
//     (This header used to describe risk-based sizing — (equity × riskPerTrade)
//     / (R / entry) — and 8%/20% caps. All three numbers were stale.)
//   · exits: SL (= range midpoint), TP (= break level ± range × tpRangeMult),
//     END OF THE 4H WINDOW (barOpenFor(openTs) + BAR_MS), and an EMA(20) 4H
//     trend flip against the position.

import { Candle, calculateEMA } from './tradeEngine';
import { evaluateRatchet, ratchetReason } from './profitRatchet';
import { aggregateToH4 } from './pathEngine';
import { barOpenFor, BAR_MS } from './pathStudy';
import type { SignalEvaluation } from './intradayBridge';
import type { SimPosition, PendingOrder, ReentryCooldownState } from './simExecution';
import {
  isInEntryCooldown,
  MIN_SIM_ENTRY_USD,
  MIN_ORDER_EXCEEDS_POSITION_TARGET,
  LIMIT_ORDER_TTL_MS,
  blockEntry
} from './simExecution';
import {
  isLongSide,
  reachedStop,
  positionPnlPercent,
  capStopLoss,
  MAX_LOSS_PERCENT
} from './exitPolicy';
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
  evaluateCorrelationGate,
  blocksOnAbstention,
  abstentionBlockReason,
  toPositionDirection,
  DEFAULT_MAX_CORRELATED,
  type CorrelatedHolding
} from './correlation';
import { DEFAULT_PREV4H_RANGE_PARAMS, Prev4hRangeParams, readPrev4hRangePlan } from './prev4hRange';

export const uid = (p: string) => `p4h-${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/** Total leveraged + spot exposure ceiling, as a percent of equity. Re-exported
 *  from the single definition in intradayParams so all four bots share it. */
export { MAX_TOTAL_EXPOSURE_PERCENT };

export interface Prev4hRangeCandleSet {
  h1: Candle[];
}

export interface Prev4hRangeOrderGenContext {
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
  totalLeveragedExposureUsd: number;
  exitCooldown: Record<string, ReentryCooldownState>;
  priceFor: (symbol: string) => number | undefined;
  /** Keyed by BASE asset — same keys the evaluations and positions use. */
  candlesBySymbol: Record<string, Prev4hRangeCandleSet | undefined>;
  maxPositions: number;
  /** SHORTs are simulated as 1x FUTURES; this caps how many can be open at
   *  once (SIM_MAX_FUTURES_POSITIONS.path). LONGs are SPOT and unaffected. */
  maxFuturesPositions: number;
  /** The engine's clock for this batch. Defaults to `Date.now()`, so every
   *  existing caller is unchanged. A historical replay injects a synthetic
   *  clock instead, so order timestamps, TTLs, cooldowns and the 4H window
   *  time-stop all advance with the replayed bars rather than the wall clock —
   *  without it this bot cannot be backtested at all. */
  now?: number;
  /** SimBotConfig.proLimitEntries. true → the breakout entry rests as a LIMIT
   *  at the signal price (fills on a pullback back to it, else expires); false
   *  → fires as a delayed MARKET order with adverse slippage (the default —
   *  breakout strategies normally want the fill now). */
  limitEntries?: boolean;
  params?: Partial<Prev4hRangeParams>;
}

const ENTRY_SIDES = new Set(['buy', 'sell', 'long', 'short']);

/** Below this fraction of entryRef, breakoutLimitPrice's discount is too thin
 *  to be a genuine "rest and wait for a retest" — ordinary price noise closes
 *  it within a tick or two, same as a market fill, but was still charged the
 *  cheaper Maker fee with zero slippage (2026-09-16 finding). See
 *  hasGenuineDiscount at its call site. */
const MIN_GENUINE_LIMIT_DISCOUNT_FRACTION = 0.0005; // 0.05%

function h4EmaTrend(h1: Candle[] | undefined, emaPeriod: number): 'UP' | 'DOWN' | 'FLAT' | undefined {
  if (!h1 || h1.length < emaPeriod * 4) return undefined;
  const h4 = aggregateToH4(h1);
  if (h4.length < emaPeriod + 2) return undefined;
  const ema = calculateEMA(h4.map((c) => c.close), emaPeriod);
  const last = ema[ema.length - 1];
  const prev = ema[ema.length - 2];
  const close = h4[h4.length - 1].close;
  if (last > prev && close > last) return 'UP';
  if (last < prev && close < last) return 'DOWN';
  return 'FLAT';
}

export function generatePrev4hRangeOrders(ctx: Prev4hRangeOrderGenContext): PendingOrder[] {
  const p: Prev4hRangeParams = { ...DEFAULT_PREV4H_RANGE_PARAMS, ...(ctx.params ?? {}) };
  const now = ctx.now ?? Date.now();
  const delayMs = Math.max(0, ctx.executionDelaySec) * 1000;
  const newOrders: PendingOrder[] = [];
  const claimed = new Set(ctx.pending.filter((o) => o.positionId).map((o) => o.positionId as string));

  // ── Exits ──────────────────────────────────────────────────────────────
  const closingSymbols = new Set<string>();
  for (const pos of ctx.positions) {
    if (claimed.has(pos.id)) continue;
    const live = ctx.priceFor(pos.symbol) ?? pos.currentPrice ?? pos.entryPrice;
    // One helper for the side, and every comparison below goes through the
    // direction-aware predicates. This bot opens SHORTs as 1x futures, and a
    // hand-written `live >= stop` is exactly where that gets inverted.
    const isLong = isLongSide(pos.side);
    const pnlPct = positionPnlPercent(pos.entryPrice, live, isLong);
    // Hard 4.2% loss cap, re-applied every tick. A position opened before the
    // signal-side cap existed (stored stop = range midpoint, which can sit
    // past 4.2%) has its effective stop pulled in here — never loosened.
    const effectiveStopLoss = capStopLoss(pos.entryPrice, pos.stopLoss, isLong);

    // Profit ratchet (2026-09-14, reworked 2026-09-16) — the ONLY profit exit,
    // replacing TP1's 50% partial + the break-even-after-TP1 runner stop + TP2
    // outright. Once the peak clears +1.8% it sells 30% of the remainder each
    // time profit gives back 15% OF THE PEAK, re-arms only on a new high, and
    // closes the position entirely at break-even. See profitRatchet.ts. Before
    // it arms, the ORIGINAL stop still applies, unchanged.
    const ratchet = evaluateRatchet({
      entryPrice: pos.entryPrice,
      peakPrice: (isLong ? pos.highestPrice : pos.lowestPrice) ?? pos.entryPrice,
      livePrice: live,
      isLong,
      peakPctAtLastPartial: pos.ratchetPeakPct,
      remainingNotionalUsd: pos.quantity * live
    });

    if (ratchet.action === 'PARTIAL') {
      closingSymbols.add(pos.symbol);
      newOrders.push({
        id: uid(`${pos.symbol}-ratchet`),
        symbol: pos.symbol,
        positionId: pos.id,
        type: pos.type,
        side: 'partial_tp1',
        exitFraction: ratchet.fraction,
        ratchetPeakPct: ratchet.peakPctAtLastPartial,
        signalPrice: live,
        quantity: pos.quantity * (ratchet.fraction ?? 0),
        reason: ratchetReason(ratchet),
        confidence: pos.confidence,
        executeAt: now + delayMs,
        createdAt: now
      });
      continue;
    }

    let reason = '';
    if (reachedStop(live, effectiveStopLoss, isLong)) {
      reason = `Stop Loss ב-${effectiveStopLoss} (${pnlPct.toFixed(2)}%, תקרה ${MAX_LOSS_PERCENT}%)`;
    } else if (ratchet.action === 'FULL') {
      reason = ratchetReason(ratchet);
    } else if (!ratchet.armed && now >= pos.openTimestamp + BAR_MS) {
      // Suspended once a rung is crossed (operator decision 2026-09-14): a
      // position already climbing the ladder runs to the ladder's own verdict
      // instead of being cut off by the 4H window.
      reason = 'יציאה אחרי 4 שעות (time stop)';
    } else {
      const trend = h4EmaTrend(ctx.candlesBySymbol[pos.symbol]?.h1, p.emaPeriod);
      // A confirmed trend reversal still closes a laddered position — this bot
      // only exists while the 4H trend holds, ladder or not.
      if (trend && (isLong ? trend === 'DOWN' : trend === 'UP')) {
        reason = `היפוך מגמה — EMA20 (4H) התהפך ל${isLong ? 'ירידה' : 'עלייה'}`;
      }
    }

    if (!reason) continue;
    closingSymbols.add(pos.symbol);
    newOrders.push({
      id: uid(`${pos.symbol}-exit`),
      symbol: pos.symbol,
      positionId: pos.id,
      type: pos.type,
      side: isLong ? 'close_long' : 'close_short',
      signalPrice: live,
      quantity: pos.quantity,
      reason,
      confidence: pos.confidence,
      executeAt: now + delayMs,
      createdAt: now
    });
  }

  // ── Circuit breaker — exits only past this point ───────────────────────
  if (
    ctx.dailyDrawdownPercent >= DAILY_DRAWDOWN_BLOCK_PERCENT ||
    ctx.weeklyDrawdownPercent >= WEEKLY_DRAWDOWN_LOCK_PERCENT
  ) {
    return newOrders;
  }

  // Running exposure / cash / count.
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
    const n = (ctx.priceFor(pos.symbol) ?? pos.currentPrice ?? pos.entryPrice) * pos.quantity;
    exposureByBase.set(pos.symbol, (exposureByBase.get(pos.symbol) ?? 0) + n);
    totalExposure += n;
  }
  for (const o of ctx.pending) {
    if (!ENTRY_SIDES.has(o.side)) continue;
    exposureByBase.set(o.symbol, (exposureByBase.get(o.symbol) ?? 0) + (o.budgetUsd ?? 0));
    totalExposure += o.budgetUsd ?? 0;
  }

  const openSymbols = new Set(ctx.positions.map((pos) => pos.symbol));
  const pendingEntrySymbols = new Set(ctx.pending.filter((o) => ENTRY_SIDES.has(o.side)).map((o) => o.symbol));
  let positionCount = openSymbols.size + pendingEntrySymbols.size;
  let futuresCount =
    ctx.positions.filter((pos) => pos.type === 'FUTURES').length +
    ctx.pending.filter((o) => o.type === 'FUTURES' && ENTRY_SIDES.has(o.side)).length;

  // Correlation cluster gate — the same helper Intraday and TrendBreakout use.
  // Path had NO concentration check at all until 2026-09-10, despite
  // trendBreakoutExecution's comment claiming "the same helper the intraday and
  // Path bots use". It is exactly the bot that needs one: every entry is a 4H
  // range breakout, so a market-wide push breaks a dozen ranges at once and the
  // confidence-ranked loop fills them in the same tick. Live, it opened three
  // simultaneous $1,000 entries on its first tick.
  const h1BySymbol: Record<string, Candle[] | undefined> = {};
  for (const [sym, set] of Object.entries(ctx.candlesBySymbol)) {
    if (set?.h1?.length) h1BySymbol[sym] = set.h1;
  }
  const correlationBook: CorrelatedHolding[] = [
    ...ctx.positions.map((pos) => ({ symbol: pos.symbol, direction: toPositionDirection(pos.side) })),
    ...ctx.pending
      .filter((o) => ENTRY_SIDES.has(o.side))
      .map((o) => ({ symbol: o.symbol, direction: toPositionDirection(o.side) }))
  ];

  const ranked = [...ctx.evaluations]
    .filter((ev) => ev.willExecute && ev.price)
    .sort((a, b) => b.confidence - a.confidence);

  const belowFloor = isBelowCapitalFloor(ctx.initialAmount, ctx.equity);

  for (const ev of ranked) {
    if (belowFloor) {
      blockEntry(
        ev,
        'CAPITAL_FLOOR',
        `הון $${ctx.equity.toFixed(2)} מתחת ל-${(CAPITAL_FLOOR_PCT * 100).toFixed(0)}% מההון ההתחלתי $${(ctx.initialAmount ?? 0).toFixed(2)} — כניסות חדשות מושהות`,
        '[path-sim]'
      );
      continue;
    }
    const plan = readPrev4hRangePlan(ev);
    if (!plan) {
      blockEntry(ev, 'NO_PLAN', 'הערכה ללא תוכנית Prev-4H (רמות חסרות)', '[path-sim]');
      continue;
    }
    if (openSymbols.has(ev.symbol) || pendingEntrySymbols.has(ev.symbol) || closingSymbols.has(ev.symbol)) continue;
    if (isInEntryCooldown(ctx.exitCooldown[ev.symbol], ev.price, now)) {
      blockEntry(ev, 'ENTRY_COOLDOWN', 'צינון אחרי יציאה קודמת בנכס הזה', '[path-sim]');
      continue;
    }
    if (positionCount >= ctx.maxPositions) {
      blockEntry(ev, 'MAX_CONCURRENT', `${positionCount}/${ctx.maxPositions} פוזיציות פתוחות — אין מקום`, '[path-sim]');
      continue;
    }

    const isLong = plan.direction === 'LONG';
    if (!isLong && futuresCount >= ctx.maxFuturesPositions) {
      blockEntry(ev, 'MAX_FUTURES', `SHORT דורש FUTURES — ${futuresCount}/${ctx.maxFuturesPositions} תפוסות`, '[path-sim]');
      continue; // SHORT = futures
    }

    const evDirection = toPositionDirection(plan.direction);
    const corr = evaluateCorrelationGate({
      symbol: ev.symbol,
      direction: evDirection,
      held: correlationBook,
      candlesBySymbol: h1BySymbol
    });
    if (!corr.allowed) {
      blockEntry(ev, 'CORRELATION', corr.reason ?? 'ריכוז יתר בנכסים מתואמים', '[path-sim]');
      continue;
    }
    if (blocksOnAbstention(corr, correlationBook.length, DEFAULT_MAX_CORRELATED)) {
      blockEntry(ev, 'CORRELATION', abstentionBlockReason(correlationBook.length, DEFAULT_MAX_CORRELATED), '[path-sim]');
      continue;
    }
    correlationBook.push({ symbol: ev.symbol, direction: evDirection });
    // LIMIT mode rests at the plan's own discounted level; MARKET mode fires at
    // the live price. Sizing is off whichever price the order actually uses.
    const price = ctx.limitEntries ? plan.limitEntryPrice : plan.entryRef;
    // A razor-fresh breakout can leave breakoutLimitPrice with no room to rest
    // below market at all — the floor that keeps the order from buying back
    // INSIDE the broken range (prev4hRange.ts's own comment on limitEntryPrice)
    // can sit above market, and the function clamps back down to market itself
    // (see breakoutLimitPrice's "never above it" invariant, tested since
    // 2026-09-08). That clamp is correct and stays — a genuine breakout that
    // fresh has no meaningful retest to wait for. What was still wrong
    // (2026-09-16): the order kept `fill: 'limit'` anyway, which in
    // fillDueOrders means Maker treatment — zero slippage, the cheaper fee —
    // for a fill that in practice happens exactly as fast as a market order.
    // Label it honestly: only call it a resting limit when it actually rests.
    const hasGenuineDiscount = ctx.limitEntries &&
      Math.abs(plan.entryRef - plan.limitEntryPrice) > plan.entryRef * MIN_GENUINE_LIMIT_DISCOUNT_FRACTION;

    // Position sizing: 10% of equity, independent of stop-loss distance.
    // SL is used only to measure the resulting dollar risk.
    const desiredNotional = sizingBase * p.positionTargetPct;

    // Both refusals below were bare `continue`s — the same blindness that hid
    // Bybit's zero-entry run. Path is spot-first with no scale-in, so its
    // target clears the floor at any equity ≥ $1,000; the exposure/cash branch
    // is the one that actually bites, and it was the one saying nothing.
    if (desiredNotional < MIN_SIM_ENTRY_USD) {
      blockEntry(
        ev,
        MIN_ORDER_EXCEEDS_POSITION_TARGET,
        `יעד הפוזיציה $${desiredNotional.toFixed(2)} (${(p.positionTargetPct * 100).toFixed(0)}% מההון) < מינימום הזמנה $${MIN_SIM_ENTRY_USD}`,
        '[path-sim]'
      );
      continue;
    }

    const assetUsed = exposureByBase.get(ev.symbol) ?? 0;
    const assetHeadroom = Math.max(0, perAssetCap - assetUsed);
    const totalHeadroom = Math.max(0, totalCap - totalExposure);
    const notional = Math.min(desiredNotional, assetHeadroom, totalHeadroom, workingCash);
    if (notional < MIN_SIM_ENTRY_USD) {
      const binding =
        assetHeadroom <= totalHeadroom && assetHeadroom <= workingCash && assetHeadroom < desiredNotional
          ? `תקרת חשיפה לנכס (${PER_ASSET_EXPOSURE_CAP_PERCENT}%) — נותרו $${assetHeadroom.toFixed(2)}`
          : totalHeadroom <= workingCash && totalHeadroom < desiredNotional
            ? `תקרת חשיפה כוללת (${MAX_TOTAL_EXPOSURE_PERCENT}%) — נותרו $${totalHeadroom.toFixed(2)}`
            : `מזומן פנוי $${workingCash.toFixed(2)}`;
      blockEntry(
        ev,
        MIN_ORDER_EXCEEDS_POSITION_TARGET,
        `${binding} < מינימום הזמנה $${MIN_SIM_ENTRY_USD}`,
        '[path-sim]'
      );
      continue;
    }

    exposureByBase.set(ev.symbol, assetUsed + notional);
    totalExposure += notional;
    workingCash -= notional;
    positionCount++;
    if (!isLong) futuresCount++;
    pendingEntrySymbols.add(ev.symbol);

    newOrders.push({
      id: uid(`${ev.symbol}-${isLong ? 'buy' : 'short'}`),
      symbol: ev.symbol,
      type: isLong ? 'SPOT' : 'FUTURES',
      side: isLong ? 'buy' : 'short',
      signalPrice: price,
      quantity: notional / price,
      budgetUsd: notional,
      leverage: 1,
      // Default MARKET: a breakout entry normally wants the fill now. LIMIT
      // (proLimitEntries on) rests at the signal price — fills only if price
      // pulls back to it (a retest), else expires. Falls back to 'market' when
      // limitEntryPrice carries no genuine discount (see hasGenuineDiscount).
      fill: hasGenuineDiscount ? 'limit' : 'market',
      stopLoss: plan.stopLoss,
      takeProfit: plan.takeProfit,
      takeProfit1: plan.takeProfit1,
      takeProfit2: plan.takeProfit2,
      reason: ev.reasoning,
      confidence: ev.confidence,
      executeAt: now + delayMs,
      createdAt: now,
      // The position this order opens is time-stopped at the end of the SAME 4H
      // bar the setup was armed in, so the order must die with the window that
      // justifies it. Under the flat 2h TTL an order armed early in the window
      // could fill at 3h50m and open a trade with ten minutes left to reach a
      // target sized off the whole range. Cap at the window end (never past it,
      // never longer than the flat TTL would have allowed).
      expiresAt: Math.min(plan.windowEnd, now + LIMIT_ORDER_TTL_MS)
    });
  }

  return newOrders;
}
