/**
 * Backtest runner — the Intraday (multi-timeframe) engine's own portfolio
 * replay.
 * ============================================================================
 *
 * This file used to ALSO drive a parameter-sweep search (`runBacktestSweep`,
 * `buildSlGrid`) over the Legacy and old-Pro engines' ATR-scaled stop/target
 * grid. Both of those engines are gone: Legacy was deleted outright, and the
 * Pro bot now implements alg.md — a fixed-percentage exit (§5: stop-loss
 * 4.2%, take-profit 3%) and a discrete risk-level table (§3), neither of
 * which is a continuous parameter a grid search makes sense to sweep. There is
 * nothing left in Pro's own spec to tune, so the sweep machinery went with the
 * engines it existed to tune.
 *
 * What remains is the Intraday engine's replay, unchanged in behaviour from
 * before this file was trimmed.
 */
import {
  Candle,
  calculateATR
} from '@cde/engine/execution';
import {
  evaluateIntradayDecision,
  evaluateIntradayExit,
  type IntradayDecision,
  type IntradayPositionView
} from '@cde/engine/analysis';
// The params live in the root barrel, not the analysis one.
import { DEFAULT_INTRADAY_PARAMS, withParams, type IntradayParams } from '@cde/engine';

/**
 * Intraday parameter overrides for a single run. Undefined reproduces
 * DEFAULT_INTRADAY_PARAMS exactly, so an unspecified run is the unmodified
 * strategy.
 */
export type IntradayOverrides = Partial<IntradayParams>;
import type { TradeSide } from '@cde/engine';

export type EngineType = 'intraday';

/**
 * One symbol's history. `candles` is the H1 series; `m15`/`m5` are the two
 * additional series the Intraday engine's multi-timeframe decision needs.
 */
export interface SymbolHistory {
  symbol: string;
  candles: Candle[];
  m15?: Candle[];
  m5?: Candle[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Simulation state ───────────────────────────────────────────────────────
interface SimPosition {
  symbol: string;
  type: 'SPOT' | 'FUTURES';
  side: TradeSide;
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number | undefined;
  takeProfit2: number | undefined;
  quantity: number;
  leverage: number;
  openTimestamp: number;
  highestPrice: number;
  lowestPrice: number;
  tp1Hit: boolean;
  sizeUsd: number;
  /** Risk-at-entry, mirroring SimPosition.initialRiskUsd in simExecution.ts. */
  initialRiskUsd: number;
  /** The engine's exit rules are time-aware — maxHold and the time-stop come
   *  out of the RiskPlan per setup type. */
  maxHoldMs?: number;
  timeStopMs?: number;
  plannedStopDistance?: number;
  setupType?: IntradayPositionView['setupType'];
}

interface SimState {
  cash: number;
  positions: SimPosition[];
  closedTrades: { pnl: number; at?: number; riskUsd?: number }[];
  totalFees: number;
  peakEquity: number;
  maxDrawdown: number;
}

function initState(): SimState {
  return { cash: 10000, positions: [], closedTrades: [], totalFees: 0, peakEquity: 10000, maxDrawdown: 0 };
}

function equity(state: SimState, prices: Record<string, number>): number {
  let eq = state.cash;
  for (const p of state.positions) {
    const price = prices[p.symbol] ?? p.entryPrice;
    if (p.type === 'SPOT') {
      eq += p.quantity * price;
    } else {
      // Futures: PnL includes leverage multiplier
      const dir = p.side === 'LONG' ? 1 : -1;
      eq += p.quantity * (price - p.entryPrice) * dir * p.leverage;
    }
  }
  return eq;
}

// Exit type union for all possible exit reasons
type ExitType = 'FULL' | 'PARTIAL_50' | 'NONE' | 'TRAILING_STOP' | 'REVERSAL' | 'TIME_BASED';

// ── Intrabar exit + position PnL ─────────────────────────────────────────────
// Fidelity helpers: a stop-loss / take-profit that the candle's RANGE crosses
// fires at the LEVEL, not at the H1 close. The old close-only check let
// intrabar SL/TP hits run through and close on a favourable close — WinRate
// and MaxDrawdown were systematically biased vs. the live engine.

type IntrabarExitType = 'SL' | 'TP1' | 'TP2';

function intrabarExit(pos: SimPosition, candle: Candle): { exitType: IntrabarExitType; price: number } | null {
  const isLong = pos.side === 'LONG' || pos.side === 'BUY';
  if (isLong) {
    if (candle.low <= pos.stopLoss) {
      return { exitType: 'SL', price: Math.min(pos.stopLoss, candle.open) };
    }
    if (!pos.tp1Hit && typeof pos.takeProfit1 === 'number' && candle.high >= pos.takeProfit1) {
      return { exitType: 'TP1', price: Math.max(pos.takeProfit1, candle.open) };
    }
    if (pos.tp1Hit && typeof pos.takeProfit2 === 'number' && candle.high >= pos.takeProfit2) {
      return { exitType: 'TP2', price: Math.max(pos.takeProfit2, candle.open) };
    }
  } else {
    if (candle.high >= pos.stopLoss) {
      return { exitType: 'SL', price: Math.max(pos.stopLoss, candle.open) };
    }
    if (!pos.tp1Hit && typeof pos.takeProfit1 === 'number' && candle.low <= pos.takeProfit1) {
      return { exitType: 'TP1', price: Math.min(pos.takeProfit1, candle.open) };
    }
    if (pos.tp1Hit && typeof pos.takeProfit2 === 'number' && candle.low <= pos.takeProfit2) {
      return { exitType: 'TP2', price: Math.min(pos.takeProfit2, candle.open) };
    }
  }
  return null;
}

function positionPnl(pos: SimPosition, price: number): number {
  if (pos.type === 'SPOT') {
    return (price - pos.entryPrice) * pos.quantity;
  }
  const dir = pos.side === 'LONG' || pos.side === 'BUY' ? 1 : -1;
  return (price - pos.entryPrice) * pos.quantity * dir * pos.leverage;
}

// ── Intraday (Multi-Timeframe) ──────────────────────────────────────────────
//
// Parity notes:
//
//  * It needs three series. Its first gate is a hard NO_DATA on
//    1H < 200 || 15M < 300 || 5M < 500 bars, so an H1-only snapshot does not
//    produce a thin version of Intraday — it produces no Intraday at all.
//
//  * It sizes itself. `buildRiskPlan` returns quantity, leverage, stops,
//    targets AND a per-setup time budget, used verbatim.
//
//  * It decides on the 5M clock, which is production parity: the worker scans
//    every BOT_SCAN_INTERVAL_SECONDS (default 300 — five minutes), and the
//    engine's entry confirmation is itself a 5M trigger. An hourly sampling
//    clock previously made a MEAN_REVERSION position (45-120 minute hold
//    budgets) reach its first exit check already past its own deadline — a
//    backtest whose sampling interval is coarser than the strategy's holding
//    period does not measure the strategy.

/** Per-symbol read cursors into the 15M and 5M series. */
interface MtfCursors { h1: number; m15: number; m5: number }

/**
 * Advances a cursor to the last bar that CLOSED at or before `upTo`.
 *
 * Monotonic and amortised O(1) across the run. A `filter` per decision would be
 * O(bars) each and turns a six-month 5M series into minutes of wall clock for
 * no extra fidelity.
 */
function advanceCursor(series: Candle[], from: number, upTo: number): number {
  let i = from;
  while (i < series.length && series[i].timestamp <= upTo) i++;
  return i;
}

function intradayEvaluate(
  history: SymbolHistory, cursors: MtfCursors, now: number, currentPrice: number,
  state: SimState, params?: IntradayParams
): { decision: IntradayDecision | null; willExecute: boolean } {
  const m15 = history.m15, m5 = history.m5;
  if (!m15 || !m5) return { decision: null, willExecute: false };

  const eq = equity(state, { [history.symbol]: currentPrice });
  const dailyDD = state.peakEquity > 0 ? Math.max(0, (state.peakEquity - eq) / state.peakEquity * 100) : 0;

  const decision = evaluateIntradayDecision({
    symbol: history.symbol,
    h1: history.candles.slice(0, cursors.h1),
    m15: m15.slice(0, cursors.m15),
    m5: m5.slice(0, cursors.m5),
    livePrice: currentPrice,
    params,
    now,
    portfolio: {
      portfolioValue: eq,
      initialAmount: 10000,
      dailyDrawdownPercent: dailyDD,
      weeklyDrawdownPercent: dailyDD,
      openPositionsCount: state.positions.length,
      openFuturesPositionsCount: state.positions.filter(p => p.type === 'FUTURES').length,
      totalLeveragedExposureUsd: state.positions
        .filter(p => p.type === 'FUTURES')
        .reduce((sum, p) => sum + p.quantity * p.entryPrice * p.leverage, 0),
      existingExposureByAsset: {},
      systemLocked: false
    },
    openPositions: state.positions.map(p => ({ symbol: p.symbol, type: p.type }))
  });

  const willExecute = decision.outcome === 'SIGNAL'
    && decision.risk !== null
    && decision.risk.approved
    && decision.tradeType !== null
    && (decision.direction === 'LONG' || decision.direction === 'SHORT');
  return { decision, willExecute };
}

function openPositionIntraday(
  symbol: string, candles: Candle[], idx: number, decision: IntradayDecision
): SimPosition | null {
  const plan = decision.risk;
  if (!plan || !plan.approved || plan.quantity <= 0) return null;
  const entryPrice = candles[idx].close;
  const side: TradeSide = decision.direction === 'SHORT' ? 'SHORT' : 'LONG';
  return {
    symbol,
    type: decision.tradeType as 'SPOT' | 'FUTURES',
    side,
    entryPrice,
    stopLoss: plan.stopLoss,
    takeProfit1: plan.takeProfit1,
    takeProfit2: plan.takeProfit2,
    quantity: plan.quantity,
    leverage: plan.leverage,
    openTimestamp: candles[idx].timestamp,
    highestPrice: entryPrice,
    lowestPrice: entryPrice,
    tp1Hit: false,
    // marginUsd for futures, notional for spot — the same money the accounting
    // loop below removes from cash.
    sizeUsd: decision.tradeType === 'FUTURES' ? plan.marginUsd : plan.notionalUsd,
    initialRiskUsd: plan.riskUsd,
    maxHoldMs: plan.maxHoldMs,
    timeStopMs: plan.timeStopMs,
    plannedStopDistance: plan.stopDistance,
    setupType: decision.setupType
  };
}

function checkExitIntraday(
  pos: SimPosition, candle: Candle, history: SymbolHistory, cursors: MtfCursors,
  state: SimState, params?: IntradayParams
): { shouldExit: boolean; exitType: ExitType; pnl: number; reasonCode?: string } {
  const m5 = history.m5;
  if (!m5) return { shouldExit: false, exitType: 'NONE', pnl: 0 };

  const eq = equity(state, { [pos.symbol]: candle.close });
  const dailyDD = state.peakEquity > 0 ? Math.max(0, (state.peakEquity - eq) / state.peakEquity * 100) : 0;

  // The 5M ATR the live exit reads, from the 5M series — not the H1 ATR
  // rescaled. Trailing distance and the time-stop's progress test are both
  // measured against it, so borrowing the wrong timeframe would move every
  // trailing exit.
  const view = m5.slice(Math.max(0, cursors.m5 - 100), cursors.m5);
  const atr5 = view.length >= 15 ? calculateATR(view, 14).atr : 0;

  const posView: IntradayPositionView = {
    symbol: pos.symbol,
    type: pos.type,
    // TradeSide also carries 'NONE'; a held position never has it, and the
    // exit engine's two-sided view is the honest projection.
    side: pos.side === 'SHORT' || pos.side === 'SELL' ? 'SHORT' : 'LONG',
    entryPrice: pos.entryPrice,
    quantity: pos.quantity,
    stopLoss: pos.stopLoss,
    takeProfit1: pos.takeProfit1,
    takeProfit2: pos.takeProfit2,
    tp1Hit: pos.tp1Hit,
    openTimestamp: pos.openTimestamp,
    maxHoldMs: pos.maxHoldMs,
    timeStopMs: pos.timeStopMs,
    setupType: pos.setupType === 'NONE' ? undefined : pos.setupType,
    plannedStopDistance: pos.plannedStopDistance,
    highestPrice: pos.highestPrice,
    lowestPrice: pos.lowestPrice
  };

  const exit = evaluateIntradayExit(posView, {
    price: candle.close,
    now: candle.timestamp,
    atr5,
    params,
    portfolio: { dailyDrawdownPercent: dailyDD, weeklyDrawdownPercent: dailyDD, systemLocked: false }
  });

  if (!exit.shouldExit) return { shouldExit: false, exitType: 'NONE', pnl: 0 };
  return { shouldExit: true, exitType: exit.exitType, pnl: positionPnl(pos, candle.close), reasonCode: exit.reasonCode };
}

// ── Result shape ─────────────────────────────────────────────────────────────
export interface BacktestResult {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  netProfit: number;
  profitFactor: number;
  expectancy: number;
  maxDrawdown: number;
  /** Per-trade records behind the aggregates above — the raw PnL series an
   *  A/B harness needs for dispersion metrics the aggregates cannot express. */
  closedTrades: { pnl: number; at?: number; riskUsd?: number }[];
  /** Why bars produced no trade, bucketed. */
  gateReasons: Record<string, number>;
  /** How the trades ended, by reason. */
  exitReasons: Record<string, number>;
}

// Fee and slippage constants (matching simExecution.ts fillDueOrders)
const FEE_PERCENT = 0.001;      // 0.1% taker fee (entry + exit = 0.2% total)
const SLIPPAGE_PERCENT = 0.001; // 0.1% slippage on entry

// ── Portfolio backtest (cross-symbol) ──────────────────────────────────────
// Runs ALL symbols together on a merged time axis so the portfolio-level
// gates (maxPositions=7, maxFutures=2) actually bind — matching how the live
// bot trades.

const PORTFOLIO_MAX_POSITIONS = 7;
const PORTFOLIO_MAX_FUTURES = 2;

export async function runPortfolioBacktest(
  histories: SymbolHistory[],
  engine: EngineType,
  intradayOverrides?: IntradayOverrides
): Promise<BacktestResult> {
  void engine; // single valid value today; kept for API stability
  // Merged, never replaced. `input.params ?? DEFAULT_INTRADAY_PARAMS` only
  // fell back when params was null/undefined — a partial object handed
  // straight to the engine blanks every threshold it does not name.
  const intradayParams = intradayOverrides
    ? withParams(intradayOverrides)
    : DEFAULT_INTRADAY_PARAMS;
  const state = initState();
  const lossCooldownUntil = new Map<string, number>();
  const exitReasons: Record<string, number> = {};
  const tally = (reason: string) => { exitReasons[reason] = (exitReasons[reason] ?? 0) + 1; };
  const gateReasons: Record<string, number> = {};
  const tallyGate = (gate: string) => { gateReasons[gate] = (gateReasons[gate] ?? 0) + 1; };

  // Intraday cannot run on an H1-only snapshot: its first gate is a hard
  // NO_DATA below 200/300/500 bars, so it would report zero trades and look
  // like a strategy that never fires rather than a snapshot that never fed it.
  // Fail loudly instead — a silent zero is the worst possible backtest result.
  const missing = histories.filter(h => !h.m15 || !h.m5).map(h => h.symbol);
  if (missing.length) {
    throw new Error(
      `intraday needs 15M and 5M series; missing for ${missing.join(', ')}. ` +
      `Build one with: npx tsx scripts/abBacktest.ts snapshot-mtf --from <date> --to <date>`
    );
  }

  const STREAK_COOLDOWN_MS = 30 * 60 * 1000;

  // Merged, time-ordered event stream on the engine's OWN clock — the 5M
  // series, since Intraday's entry confirmation is a 5M trigger.
  const events: { ts: number; symbol: string; idx: number }[] = [];
  for (const h of histories) {
    const clock = h.m5!;
    for (let i = 500; i < clock.length; i++) {
      events.push({ ts: clock[i].timestamp, symbol: h.symbol, idx: i });
    }
  }
  events.sort((a, b) => a.ts - b.ts || a.symbol.localeCompare(b.symbol));
  const historyBySymbol = new Map(histories.map(h => [h.symbol, h]));
  const candlesBySymbol = new Map(histories.map(h => [h.symbol, h.candles]));
  // Monotonic per-symbol read heads. The event stream is time-ordered and each
  // symbol's own events are in increasing index order, so these only ever move
  // forward.
  const cursorsBySymbol = new Map<string, MtfCursors>(histories.map(h => [h.symbol, { h1: 0, m15: 0, m5: 0 }]));
  let processed = 0;

  for (const ev of events) {
    if (++processed % 1000 === 0) await sleep(0);
    const symbol = ev.symbol;
    const history = historyBySymbol.get(symbol)!;
    const candles = candlesBySymbol.get(symbol)!;
    const bars = history.m5!;
    const candle = bars[ev.idx];

    // Advance the HIGHER-timeframe heads to the last bar that closed at or
    // before this 5M bar. A 1H bar that closes later has not happened yet;
    // letting one through would be look-ahead, the one bug a backtest cannot
    // survive. The 5M head is the event index itself.
    const cursors = cursorsBySymbol.get(symbol)!;
    cursors.h1 = advanceCursor(candles, cursors.h1, candle.timestamp);
    cursors.m15 = advanceCursor(history.m15!, cursors.m15, candle.timestamp);
    cursors.m5 = ev.idx + 1;
    // The engine's own NO_DATA thresholds on the two slower series.
    if (cursors.h1 < 200 || cursors.m15 < 300) continue;

    // 1. Exits for THIS symbol's positions
    const toRemove: number[] = [];
    for (let i = 0; i < state.positions.length; i++) {
      const pos = state.positions[i];
      if (pos.symbol !== symbol) continue;
      const intrabar = intrabarExit(pos, candle);
      const check = intrabar
        ? { shouldExit: true, exitType: (intrabar.exitType === 'TP1' ? 'PARTIAL_50' : 'FULL') as ExitType, pnl: positionPnl(pos, intrabar.price) }
        : checkExitIntraday(pos, candle, history, cursors, state, intradayParams);
      if (check.shouldExit) {
        tally(intrabar ? intrabar.exitType : ((check as { reasonCode?: string }).reasonCode ?? check.exitType));
        const exitPrice = intrabar ? intrabar.price : candle.close;
        const exitNotional = pos.type === 'SPOT' ? pos.quantity * exitPrice : pos.sizeUsd + check.pnl;
        const exitFee = exitNotional * FEE_PERCENT;
        const pnlAfterFee = check.pnl - exitFee;
        state.totalFees += exitFee;

        if (check.exitType === 'PARTIAL_50') {
          const halfQty = pos.quantity / 2;
          const halfPnl = pnlAfterFee / 2;
          state.closedTrades.push({ pnl: halfPnl, at: ev.ts, riskUsd: pos.initialRiskUsd / 2 });
          pos.quantity = halfQty;
          pos.initialRiskUsd = pos.initialRiskUsd / 2;
          pos.tp1Hit = true;
          if (pos.type === 'SPOT') { state.cash += halfQty * exitPrice - exitFee / 2; } else { state.cash += (pos.sizeUsd / 2) + halfPnl; }
          pos.sizeUsd = pos.sizeUsd / 2;
        } else {
          state.closedTrades.push({ pnl: pnlAfterFee, at: ev.ts, riskUsd: pos.initialRiskUsd });
          if (pnlAfterFee < 0) lossCooldownUntil.set(symbol, Math.max(lossCooldownUntil.get(symbol) ?? 0, ev.ts + STREAK_COOLDOWN_MS));
          if (pos.type === 'SPOT') { state.cash += pos.quantity * exitPrice - exitFee; } else { state.cash += pos.sizeUsd + pnlAfterFee; }
          toRemove.push(i);
        }
      } else {
        pos.highestPrice = Math.max(pos.highestPrice, candle.high);
        pos.lowestPrice = Math.min(pos.lowestPrice, candle.low);
      }
    }
    for (let i = toRemove.length - 1; i >= 0; i--) state.positions.splice(toRemove[i], 1);

    // 2. Equity (this symbol at its live price; others at their entry price)
    const eq = equity(state, { [symbol]: candle.close });
    state.peakEquity = Math.max(state.peakEquity, eq);
    const drawdown = state.peakEquity > 0 ? (state.peakEquity - eq) / state.peakEquity * 100 : 0;
    state.maxDrawdown = Math.max(state.maxDrawdown, drawdown);

    // 3. New entry — portfolio-level capacity gates
    if (state.positions.some(p => p.symbol === symbol)) { tallyGate('ALREADY_IN_SYMBOL'); continue; }
    if (ev.ts < (lossCooldownUntil.get(symbol) ?? 0)) { tallyGate('LOSS_COOLDOWN'); continue; }
    if (state.positions.length >= PORTFOLIO_MAX_POSITIONS) { tallyGate('PORTFOLIO_FULL'); continue; }

    const { decision, willExecute } = intradayEvaluate(history, cursors, candle.timestamp, candle.close, state, intradayParams);
    tallyGate(willExecute ? 'SIGNAL' : (decision?.gate ?? 'NO_DECISION'));
    if (!willExecute || !decision) continue;
    if (decision.tradeType === 'FUTURES' && state.positions.filter(p => p.type === 'FUTURES').length >= PORTFOLIO_MAX_FUTURES) { tallyGate('FUTURES_FULL'); continue; }
    const pos = openPositionIntraday(symbol, bars, ev.idx, decision);

    if (!pos) tallyGate('RISK_REJECTED');
    if (pos) {
      const entryNotional = pos.type === 'SPOT' ? pos.quantity * candle.close : pos.sizeUsd;
      const entryFee = entryNotional * FEE_PERCENT;
      const slippage = entryNotional * SLIPPAGE_PERCENT;
      const totalEntryCost = entryFee + slippage;
      state.cash -= totalEntryCost;
      state.totalFees += totalEntryCost;
      if (pos.type === 'SPOT') { state.cash -= pos.quantity * candle.close; } else { state.cash -= pos.sizeUsd; }
      state.positions.push(pos);
    }
  }

  const totalTrades = state.closedTrades.length;
  const wins = state.closedTrades.filter(t => t.pnl > 0).length;
  const losses = totalTrades - wins;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const netProfit = state.closedTrades.reduce((s, t) => s + t.pnl, 0);
  const grossWin = state.closedTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(state.closedTrades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  const expectancy = totalTrades > 0 ? netProfit / totalTrades : 0;
  return { totalTrades, wins, losses, winRate, netProfit, profitFactor, expectancy, maxDrawdown: state.maxDrawdown, closedTrades: state.closedTrades, exitReasons, gateReasons };
}
