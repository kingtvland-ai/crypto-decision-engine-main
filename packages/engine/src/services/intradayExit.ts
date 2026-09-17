/**
 * Intraday Exit Engine (§29/§31/§32/§52)
 * ============================================================================
 * Exit priority (never re-ordered):
 *      Weekly emergency protection
 *        ↓ Stop Loss
 *        ↓ Take Profit (TP2 → TP1 partial)
 *        ↓ Trailing (only after the trade proved itself)
 *        ↓ Reversal
 *        ↓ Time Stop / Max duration
 *
 * The exit engine keeps running even when new entries are blocked.
 */

import { formatDynamicPrice } from './tradeEngine';
import { evaluateRatchet, ratchetReason } from './profitRatchet';
import { DEFAULT_INTRADAY_PARAMS, Direction, IntradayParams, SetupType } from './intradayParams';
import { capStopLoss } from './exitPolicy';

export type ExitReasonCode =
  | 'WEEKLY_PROTECTION'
  | 'STOP_LOSS'
  | 'TAKE_PROFIT_2'
  | 'TAKE_PROFIT_1'
  | 'TAKE_PROFIT'
  | 'TRAILING_STOP'
  | 'REVERSAL'
  | 'TIME_STOP'
  | 'PROFIT_RATCHET'
  | 'MAX_DURATION'
  | 'NONE';

export interface IntradayPositionView {
  symbol: string;
  type: 'SPOT' | 'FUTURES';
  side: 'LONG' | 'SHORT' | 'BUY' | 'SELL';
  entryPrice: number;
  quantity: number;
  stopLoss: number;
  takeProfit1?: number;
  takeProfit2?: number;
  tp1Hit?: boolean;
  /** Peak profit % as of this position's last ratchet partial — the "new high
   *  required" state. See profitRatchet.ts. */
  ratchetPeakPct?: number;
  openTimestamp: number;
  maxHoldMs?: number;
  timeStopMs?: number;
  setupType?: SetupType;
  plannedStopDistance?: number;
  /** The symbol's own natural noise floor at entry, as a percent of entry
   *  price — see RiskPlan.naturalStopPct (intradayRisk.ts) for the full
   *  rationale. Read ONLY by the time-stop stagnation check below; every
   *  other R-based check (trailing activation, max-hold extension) keeps
   *  using the executed stop, because those are legitimately about how much
   *  of the RISK budget has been used, not about the symbol's own movement.
   *  Undefined = old behavior (time stop also uses the executed stop). */
  naturalStopPct?: number;
  highestPrice?: number;
  lowestPrice?: number;
  highestPriceSinceTP1?: number;
  lowestPriceSinceTP1?: number;
  /** Quantity at entry, frozen — for the ratchet's "free the slot" rule
   *  (RATCHET_MIN_REMAINING_FRACTION). Absent → that rule is skipped (treated
   *  as 100% remaining), same as a position restored from old state. */
  initialQuantity?: number;
}

export interface IntradayExitContext {
  price: number;
  now: number;
  atr5: number;
  params?: IntradayParams;
  portfolio: {
    dailyDrawdownPercent: number;
    weeklyDrawdownPercent: number;
    systemLocked?: boolean;
  };
  reversalSignal?: {
    direction: Direction;
    setupScore: number;
    entryConfirmed: boolean;
  };
}

export interface IntradayExitDecision {
  shouldExit: boolean;
  exitType: 'FULL' | 'PARTIAL_50' | 'PARTIAL_RATCHET' | 'NONE';
  /** PARTIAL_RATCHET only: fraction of the REMAINING position to close. */
  ratchetFraction?: number;
  /** PARTIAL_RATCHET: the peak-at-last-partial to persist onto the remainder,
   *  which is what enforces the "new high required" re-arm rule. */
  ratchetPeakPct?: number;
  reasonCode: ExitReasonCode;
  reason: string;
  trailingStopPrice?: number;
  /** Favourable progress measured in R at decision time */
  progressR: number;
  /** Maximum favourable excursion in R */
  mfeR: number;
  heldMinutes: number;
}

export function evaluateIntradayExit(pos: IntradayPositionView, ctx: IntradayExitContext): IntradayExitDecision {
  const params = ctx.params ?? DEFAULT_INTRADAY_PARAMS;
  const isLong = pos.side === 'LONG' || pos.side === 'BUY';
  const s = isLong ? 1 : -1;
  const price = ctx.price;
  const atr5 = ctx.atr5 > 0 ? ctx.atr5 : pos.entryPrice * 0.001;

  // Hard 4.2% loss cap, enforced on every evaluation. A position opened before
  // the cap existed (or with a wider structural stop) has its effective stop
  // pulled in here on the next tick — never loosened. Normally a no-op: the
  // live bot's entry stop is capped at maxStopPercent (1.5%) and the sim
  // ladder's widest is MAX_LOSS_PERCENT itself. It is the backstop for a
  // persisted position carrying a wider stop than either path can produce.
  const effectiveStopLoss = capStopLoss(pos.entryPrice, pos.stopLoss, isLong);

  const stopDistance = pos.plannedStopDistance && pos.plannedStopDistance > 0
    ? Math.min(pos.plannedStopDistance, Math.abs(pos.entryPrice - effectiveStopLoss))
    : Math.max(Math.abs(pos.entryPrice - effectiveStopLoss), 1e-12);

  const progressR = ((price - pos.entryPrice) * s) / stopDistance;
  const peak = isLong
    ? Math.max(pos.highestPrice ?? pos.entryPrice, price)
    : Math.min(pos.lowestPrice ?? pos.entryPrice, price);
  const mfeR = ((peak - pos.entryPrice) * s) / stopDistance;
  const heldMs = Math.max(0, ctx.now - pos.openTimestamp);
  const heldMinutes = Number((heldMs / 60_000).toFixed(1));

  const base = { progressR: Number(progressR.toFixed(2)), mfeR: Number(mfeR.toFixed(2)), heldMinutes };

  // Per-setup parameter lookups all key off this: 'NONE' is a valid SetupType
  // on the position record but never a key in the per-setup tables, so it is
  // narrowed once here instead of at each lookup.
  const setupForParams: Exclude<SetupType, 'NONE'> =
    pos.setupType && pos.setupType !== 'NONE' ? pos.setupType : 'TREND_PULLBACK';

  // 1 ── Weekly emergency protection ─────────────────────────────────────────
  if (ctx.portfolio.systemLocked || ctx.portfolio.weeklyDrawdownPercent >= params.weeklyDrawdownFlattenPercent) {
    return {
      shouldExit: true,
      exitType: 'FULL',
      reasonCode: 'WEEKLY_PROTECTION',
      reason: `הגנת תיק שבועית (Drawdown ${ctx.portfolio.weeklyDrawdownPercent.toFixed(1)}% >= ${params.weeklyDrawdownFlattenPercent}%) — סגירת פוזיציה`,
      ...base
    };
  }

  // 2 ── Stop loss ───────────────────────────────────────────────────────────
  // SL triggers immediately on touch/cross — no candle-close confirmation.
  // The executed stop is the effective stop (4.2% cap applied).
  if ((isLong && price <= effectiveStopLoss) || (!isLong && price >= effectiveStopLoss)) {
    return {
      shouldExit: true,
      exitType: 'FULL',
      reasonCode: 'STOP_LOSS',
      reason: `Stop Loss ב-$${formatDynamicPrice(effectiveStopLoss)} (מחיר $${formatDynamicPrice(price)})`,
      ...base
    };
  }

  // 3 ── Profit ratchet (sim only, opt-in) ───────────────────────────────────
  // Operator decision 2026-09-14, reworked 2026-09-16. When on, it OWNS every
  // profit exit: once the peak clears +1.8% the position sells 30% of what is
  // left each time profit gives back 15% OF THE PEAK, re-arming only on a new
  // high, and closes entirely at break-even. TP1/TP2 and the trailing stop
  // below are skipped entirely — the trail is what kept handing back open
  // profit, which is the behaviour being replaced. See profitRatchet.ts. The
  // LIVE bot leaves `profitRatchet` unset and is completely unaffected.
  const ratchet = params.profitRatchet === true
    ? evaluateRatchet({
        entryPrice: pos.entryPrice,
        peakPrice: peak,
        livePrice: price,
        isLong,
        peakPctAtLastPartial: pos.ratchetPeakPct,
        remainingQuantityFraction: pos.quantity / (pos.initialQuantity ?? pos.quantity)
      })
    : undefined;

  if (ratchet && ratchet.action !== 'HOLD') {
    return {
      shouldExit: true,
      exitType: ratchet.action === 'FULL' ? 'FULL' : 'PARTIAL_RATCHET',
      reasonCode: 'PROFIT_RATCHET',
      reason: ratchetReason(ratchet),
      ratchetFraction: ratchet.fraction,
      ratchetPeakPct: ratchet.peakPctAtLastPartial,
      ...base
    };
  }

  // 4 ── Take profit ─────────────────────────────────────────────────────────
  // Same ladder for SPOT and FUTURES (operator rule 2026-09-08): TP1 at 3%
  // closes 50% and arms the trailing stop, the runner goes to TP2 at 4.5%.
  // SPOT used to take a single FULL exit at TP1 — the 50%/TP2 half of the
  // policy was FUTURES-only, and intraday is mostly SPOT.
  if (!ratchet && pos.takeProfit2 && ((isLong && price >= pos.takeProfit2) || (!isLong && price <= pos.takeProfit2))) {
    return {
      shouldExit: true,
      exitType: 'FULL',
      reasonCode: 'TAKE_PROFIT_2',
      reason: `TP2 הושג ב-$${formatDynamicPrice(pos.takeProfit2)}`,
      ...base
    };
  }
  if (!ratchet && !pos.tp1Hit && pos.takeProfit1 && ((isLong && price >= pos.takeProfit1) || (!isLong && price <= pos.takeProfit1))) {
    return {
      shouldExit: true,
      exitType: 'PARTIAL_50',
      reasonCode: 'TAKE_PROFIT_1',
      reason: `TP1 הושג ב-$${formatDynamicPrice(pos.takeProfit1)} — סגירת 50% והפעלת Trailing`,
      ...base
    };
  }

  // 4 ── Trailing — only after the trade proved itself (§32) ─────────────────
  // "Reached TP1" here means the trade PROVED it got there — NOT that the live
  // price is above TP1 on this tick. `tp1Hit` is set the moment the partial
  // fills; `mfeR >= tp1RewardRisk` covers a runner that touched TP1 between
  // ticks without the flag. The old gate (`price >= takeProfit1`, live) silently
  // DISABLED the trailing stop the instant a runner pulled back through TP1 —
  // exactly when the trail exists to protect it. Observed on the worker: an ENA
  // MEAN_REVERSION runner peaked at +2.0R, fell back below TP1, then drifted
  // down with only the hard SL because `trailingActive` had flipped to false at
  // the TP1 level. This only ever ADDS protection (exits a fading runner
  // sooner), so it is safe for the live bot.
  const provedTp1 = !!pos.tp1Hit || mfeR >= (params.tp1RewardRisk ?? 1.5);
  const trailingActive = ratchet ? false : pos.type === 'FUTURES'
    ? provedTp1
    : provedTp1 && mfeR >= (params.trailingActivationRBySetup[setupForParams] ?? params.trailingActivationR);
  if (trailingActive) {
    const anchor = pos.type === 'FUTURES'
      ? isLong
        ? Math.max(pos.highestPriceSinceTP1 ?? peak, price)
        : Math.min(pos.lowestPriceSinceTP1 ?? peak, price)
      : peak;
    // Trail width is the TIGHTER of the ATR distance and an R-multiple of the
    // stop. On a structural (sub-ATR) stop, `trailingAtrMult × atr5` can be
    // 2-4R wide — wider than the whole original stop — so the runner never
    // reached TP2: a peak just past TP1 (1.5R) minus a ~1.8R trail exits the
    // runner near break-even. Capping the width at `trailingMaxRMult` (1R) of
    // the stop keeps the runner in play up to TP2. It only ever TIGHTENS the
    // trail, so it is safe for the live bot too.
    const trailDistance = Math.min(
      params.trailingAtrMult * atr5,
      params.trailingMaxRMult * stopDistance
    );
    const trailingStopPrice = anchor - s * trailDistance;
    const trailingHit = isLong ? price <= trailingStopPrice : price >= trailingStopPrice;
    if (trailingHit && mfeR >= params.trailingActivationR * 0.8) {
      return {
        shouldExit: true,
        exitType: 'FULL',
        reasonCode: 'TRAILING_STOP',
        reason: `Trailing Stop ב-$${formatDynamicPrice(trailingStopPrice)} (MFE ${mfeR.toFixed(2)}R)`,
        trailingStopPrice,
        ...base
      };
    }
  }

  // 5 ── Reversal — an opposite, CONFIRMED setup, not a single indicator ─────
  // Act on a reversal ONLY when the trade has either proved itself (progress
  // past the TP1 reward-risk — so we bank a real gain instead of a noise flip)
  // or is already meaningfully underwater (thesis broken — cut it before the
  // full stop). In the dead zone between, the position is still inside its own
  // risk plan: let SL / TP / time decide. A choppy tape flips the setup every
  // few bars, and exiting there just churns the book at small losses which the
  // 30-min re-entry cooldown then locks in. (The previous version computed a
  // guard and never applied it — the reversal fired at ANY P&L.)
  const reversalInProfit = progressR >= (params.tp1RewardRisk ?? 1.5);
  const reversalThesisBroken = progressR <= params.reversalMaxLossR;
  if (
    (reversalInProfit || reversalThesisBroken) &&
    ctx.reversalSignal &&
    ctx.reversalSignal.entryConfirmed &&
    ctx.reversalSignal.setupScore >= 70
  ) {
    const opposite = isLong ? ctx.reversalSignal.direction === 'SHORT' : ctx.reversalSignal.direction === 'LONG';
    if (opposite) {
      return {
        shouldExit: true,
        exitType: 'FULL',
        reasonCode: 'REVERSAL',
        reason: `היפוך מאושר בכיוון הנגדי (SetupScore ${ctx.reversalSignal.setupScore}, ${progressR.toFixed(2)}R)`,
        ...base
      };
    }
  }

  // 6 ── Time stops (§28/§29) ────────────────────────────────────────────────
  const maxHoldMs = pos.maxHoldMs ?? params.maxHoldMinutes.TREND_PULLBACK * 60_000;
  const timeStopMs = pos.timeStopMs ?? Math.round(maxHoldMs * params.timeStopFraction);

  // Progress-aware max hold: a position that has covered half its stop
  // distance in the right direction has earned the longer budget. Re-tested
  // on every evaluation — if progress falls back below the bar, the very
  // next check cuts it at the original budget.
  const extensionFactor = params.maxHoldExtensionFactor?.[setupForParams] ?? 1;
  const extensionEarned = extensionFactor > 1 && progressR >= params.maxHoldExtensionMinProgressR;
  const effectiveMaxHoldMs = extensionEarned ? Math.round(maxHoldMs * extensionFactor) : maxHoldMs;

  // No `beyondTp || beyondSl` guard here, deliberately. It used to wrap this
  // branch and made it unreachable: a price beyond the stop returned at the
  // STOP_LOSS check above and a price beyond the target at TAKE_PROFIT, so the
  // condition was only ever true for prices that had already exited. A max hold
  // is a budget — when it runs out the position closes wherever it stands,
  // which is the whole point of having one.
  // Suspended once the ratchet is ARMED (operator decision 2026-09-14): a
  // position already climbing the ladder runs to the ladder's own verdict.
  if (ratchet?.armed === true) {
    return { shouldExit: false, exitType: 'NONE', reasonCode: 'NONE', reason: '', ...base };
  }

  if (heldMs >= effectiveMaxHoldMs) {
    return {
      shouldExit: true,
      exitType: 'FULL',
      reasonCode: 'MAX_DURATION',
      reason: `משך החזקה מקסימלי (${Math.round(effectiveMaxHoldMs / 60_000)} דק'${extensionEarned ? ' — כולל הרחבה' : ''}) — יציאת זמן`,
      ...base
    };
  }

  // Stagnant = little forward progress AND never printed a real favourable
  // excursion. A trade that once ran to +0.7R (mfeR) is working, just slowly —
  // it has earned the full maxHold budget (MAX_DURATION above still ends it on
  // time), so the early 0.7× checkpoint no longer cuts it at a small loss.
  // Those early cuts were a large share of the bot's losing-trade COUNT.
  //
  // "R" here is measured against `naturalStopPct` (the symbol's own measured
  // noise floor, frozen at entry — see the field's doc comment) instead of the
  // executed stop distance, when available. Fixed 2026-09-15: the executed
  // stop under the flat scalp ladder sits at a uniform 2.3%+ regardless of a
  // calm symbol's real volatility, so `progressR` (denominated in THAT stop)
  // made 0.3R an unreasonably high bar even for BTC — its typical 63-minute
  // drift (~0.60%, ATR 0.17%) fell short of the 0.69% the flat stop demanded.
  // Every other R-based check in this function (trailing activation, max-hold
  // extension) keeps using the executed stop deliberately — those measure how
  // much of the RISK budget is used, which correctly IS about the stop. Only
  // "has this symbol's tape actually moved" should be measured against what
  // the symbol actually does. Undefined naturalStopPct (live bot, or no
  // measurement available) falls through to the old executed-stop behavior
  // exactly — same numbers, same threshold, byte-identical result.
  const naturalStopDistance = typeof pos.naturalStopPct === 'number' && pos.naturalStopPct > 0
    ? pos.entryPrice * (pos.naturalStopPct / 100)
    : stopDistance;
  const progressNaturalR = ((price - pos.entryPrice) * s) / naturalStopDistance;
  const mfeNaturalR = ((peak - pos.entryPrice) * s) / naturalStopDistance;
  if (
    heldMs >= timeStopMs &&
    progressNaturalR < params.timeStopMinProgressR &&
    mfeNaturalR < params.timeStopStagnantMfeR
  ) {
    // Half-close, not full, the first time this fires under the ratchet
    // (2026-09-16 — live sim data: 14 Time-Stop/Max-Duration exits averaged
    // -$8.05 against the ratchet's own average partial win of +$2.29, net
    // -$69 on Intraday alone). A full close realizes the ENTIRE stagnant
    // position at whatever this tick's price is; the ratchet already treats
    // profit-taking as incremental (30% per rung) — a stagnant/losing
    // position deserves the same "don't bet it all on one tick" treatment.
    // The remainder still runs under the real SL / ratchet / MAX_DURATION —
    // it is not given a free pass, only a second chance to recover instead of
    // being marked to market as a full loss on a single stagnant tick.
    // `pos.tp1Hit` doubles as "already time-stopped once" here (same shared
    // partial_tp1 fill path the ratchet itself reuses for its partials) so
    // this cannot decay geometrically like the pre-2026-09-16 profit ladder
    // did: the SECOND time-stop hit always closes what is left, in full.
    // Gated on `params.profitRatchet === true` (ratchet defined but not yet
    // armed, or the live bot leaves it unset) — the live bot's `tp1Hit` still
    // means exactly "TP1 price was touched" and nothing here changes for it.
    if (params.profitRatchet === true && !pos.tp1Hit) {
      return {
        shouldExit: true,
        exitType: 'PARTIAL_50',
        reasonCode: 'TIME_STOP',
        reason: `Time Stop (חלקי 50%, השאר ממשיך): אחרי ${heldMinutes} דק' התקדמות ${progressNaturalR.toFixed(2)}R < ${params.timeStopMinProgressR}R (MFE ${mfeNaturalR.toFixed(2)}R)`,
        ...base
      };
    }
    return {
      shouldExit: true,
      exitType: 'FULL',
      reasonCode: 'TIME_STOP',
      reason: `Time Stop: אחרי ${heldMinutes} דק' התקדמות ${progressNaturalR.toFixed(2)}R < ${params.timeStopMinProgressR}R (MFE ${mfeNaturalR.toFixed(2)}R)${params.profitRatchet === true ? ' — סגירה מלאה (כבר מומש חלקית)' : ''}`,
      ...base
    };
  }

  return {
    shouldExit: false,
    exitType: 'NONE',
    reasonCode: 'NONE',
    reason: 'הפוזיציה ממשיכה להתנהל',
    ...base
  };
}
