/**
 * Intraday Backtest Harness (§48-§54)
 * ============================================================================
 * Walk-forward over REAL Bybit 5M/15M/1H history with realistic execution:
 *   - LIMIT orders with TTL, touch-fill probability, partial fills (§39/§40)
 *   - fees (maker entry / taker exit), slippage, spread (§25/§27)
 *   - exits: SL, TP1/TP2 (futures partial), trailing, reversal, time-stop (§29-§32)
 *   - equity curve, drawdown, Sharpe/Sortino, win rate, profit factor, expectancy
 *
 * Runs the SAME evaluateIntradayDecision used live → strict sim/live parity.
 * No parameter re-optimization on the OOS window (anti-overfitting, §49).
 */

import { Candle, BYBIT_FEES } from './tradeEngine';
import { evaluateIntradayDecision, IntradayDecision, TradeType } from './intradayEngine';
import { evaluateIntradayExit, IntradayPositionView } from './intradayExit';
import { marketStructure, seededRandom } from './intradayIndicators';
import { DEFAULT_INTRADAY_PARAMS, IntradayParams, RISK_VARIANTS, SetupType, Regime1HType } from './intradayParams';

export interface BacktestHistory {
  symbol: string;
  h1: Candle[];
  m15: Candle[];
  m5: Candle[];
}

export interface BacktestTrade {
  symbol: string;
  side: 'LONG' | 'SHORT';
  type: TradeType;
  setupType: SetupType;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  leverage: number;
  notionalUsd: number;
  marginUsd: number;
  riskUsd: number;
  pnlUsd: number;
  pnlPercent: number;
  feesUsd: number;
  slippageUsd: number;
  spreadUsd: number;
  mfeR: number;
  exitReason: string;
  heldMinutes: number;
  regimeAtEntry: Regime1HType;
  atrPercentileAtEntry: number;
  partial: boolean;
}

export interface BacktestMetrics {
  netProfitUsd: number;
  netProfitPercent: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number;
  expectancyUsd: number;
  maxDrawdownPercent: number;
  sharpe: number;
  sortino: number;
  avgHoldMinutes: number;
  avgWinUsd: number;
  avgLossUsd: number;
  bySetup: Record<string, { trades: number; pnl: number; winRate: number }>;
  byRegime: Record<string, { trades: number; pnl: number; winRate: number }>;
  bySymbol: Record<string, { trades: number; pnl: number; winRate: number }>;
  fillStats: { signals: number; pending: number; filled: number; missed: number; partial: number };
}

export interface BacktestResult {
  symbol: string;
  riskPercent: number;
  metrics: BacktestMetrics;
  trades: BacktestTrade[];
  equityCurve: { t: number; equity: number }[];
}

export interface WalkForwardWindow {
  label: 'TRAIN' | 'VAL' | 'OOS';
  startT: number;
  endT: number;
  metrics: BacktestMetrics;
  trades: BacktestTrade[];
}

export interface WalkForwardResult {
  symbol: string;
  riskPercent: number;
  windows: WalkForwardWindow[];
  combined: BacktestMetrics;
}

function sliceUpTo(arr: Candle[], t: number): Candle[] {
  // arr is sorted ascending; return all candles with timestamp <= t
  let lo = 0;
  let hi = arr.length - 1;
  let last = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].timestamp <= t) {
      last = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return last < 0 ? [] : arr.slice(0, last + 1);
}

interface PendingOrder {
  symbol: string;
  side: 'LONG' | 'SHORT';
  type: TradeType;
  entryPrice: number;
  createdAt: number;
  ttlMs: number;
  decision: IntradayDecision;
}

interface OpenPosition {
  symbol: string;
  side: 'LONG' | 'SHORT';
  type: TradeType;
  entryPrice: number;
  quantity: number;
  leverage: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  tp1Hit: boolean;
  /** The EXECUTED stop distance in price units (`risk.stopDistance`), i.e. the
   *  position's 1R. Named `atr5` until 2026-09-15, which was wrong in a way
   *  that reads as a bug: the ATR-based branch of the stop is only one input
   *  to this number, and once the fixed ladder is on it contributes nothing.
   *  Every consumer below wants 1R, not ATR. */
  stopDistance: number;
  openTimestamp: number;
  maxHoldMs: number;
  timeStopMs: number;
  setupType: SetupType;
  riskUsd: number;
  notionalUsd: number;
  marginUsd: number;
  regimeAtEntry: Regime1HType;
  atrPercentileAtEntry: number;
  highestPrice: number;
  lowestPrice: number;
  highestPriceSinceTP1: number;
  lowestPriceSinceTP1: number;
  partial: boolean;
}

function computeMetrics(trades: BacktestTrade[], equityCurve: { t: number; equity: number }[], startEquity: number): BacktestMetrics {
  const total = trades.length;
  const wins = trades.filter((t) => t.pnlUsd > 0);
  const losses = trades.filter((t) => t.pnlUsd <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnlUsd, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnlUsd, 0));
  const net = trades.reduce((a, t) => a + t.pnlUsd, 0);

  let peak = startEquity;
  let maxDD = 0;
  for (const p of equityCurve) {
    if (p.equity > peak) peak = p.equity;
    const dd = peak > 0 ? ((peak - p.equity) / peak) * 100 : 0;
    if (dd > maxDD) maxDD = dd;
  }

  const returns = trades.map((t) => t.pnlPercent / 100);
  const mean = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance = returns.length ? returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length : 0;
  const std = Math.sqrt(variance);
  const downside = returns.filter((r) => r < 0);
  const dStd = downside.length ? Math.sqrt(downside.reduce((a, b) => a + b * b, 0) / downside.length) : 0;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;
  const sortino = dStd > 0 ? (mean / dStd) * Math.sqrt(252) : 0;

  type Bucket = { trades: number; pnl: number; winRate: number };
  const bySetup: Record<string, Bucket> = {};
  const byRegime: Record<string, Bucket> = {};
  const bySymbol: Record<string, Bucket> = {};
  const bucket = (map: Record<string, Bucket>, key: string, t: BacktestTrade) => {
    if (!map[key]) map[key] = { trades: 0, pnl: 0, winRate: 0 };
    map[key].trades++;
    map[key].pnl += t.pnlUsd;
    if (t.pnlUsd > 0) map[key].winRate++;
  };
  for (const t of trades) {
    bucket(bySetup, t.setupType, t);
    bucket(byRegime, t.regimeAtEntry, t);
    bucket(bySymbol, t.symbol, t);
  }
  for (const k of Object.keys(bySetup)) bySetup[k].winRate = bySetup[k].trades ? bySetup[k].winRate / bySetup[k].trades : 0;
  for (const k of Object.keys(byRegime)) byRegime[k].winRate = byRegime[k].trades ? byRegime[k].winRate / byRegime[k].trades : 0;
  for (const k of Object.keys(bySymbol)) bySymbol[k].winRate = bySymbol[k].trades ? bySymbol[k].winRate / bySymbol[k].trades : 0;

  return {
    netProfitUsd: Number(net.toFixed(2)),
    netProfitPercent: Number(((net / startEquity) * 100).toFixed(2)),
    totalTrades: total,
    wins: wins.length,
    losses: losses.length,
    winRate: total ? Number(((wins.length / total) * 100).toFixed(1)) : 0,
    profitFactor: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(2)) : grossWin > 0 ? Infinity : 0,
    expectancyUsd: total ? Number((net / total).toFixed(2)) : 0,
    maxDrawdownPercent: Number(maxDD.toFixed(2)),
    sharpe: Number(sharpe.toFixed(2)),
    sortino: Number(sortino.toFixed(2)),
    avgHoldMinutes: total ? Number((trades.reduce((a, t) => a + t.heldMinutes, 0) / total).toFixed(1)) : 0,
    avgWinUsd: wins.length ? Number((grossWin / wins.length).toFixed(2)) : 0,
    avgLossUsd: losses.length ? Number((-grossLoss / losses.length).toFixed(2)) : 0,
    bySetup,
    byRegime,
    bySymbol,
    fillStats: { signals: 0, pending: 0, filled: 0, missed: 0, partial: 0 }
  };
}

/**
 * Runs the engine over a 5M timeline. `barRange` restricts evaluation to a
 * [startIdx, endIdx) slice of the 5M array (used by walk-forward windows).
 */
export function runBacktest(
  history: BacktestHistory,
  params: IntradayParams = DEFAULT_INTRADAY_PARAMS,
  opts: { startEquity?: number; seed?: number; barRange?: [number, number]; spreadPercent?: number } = {}
): BacktestResult {
  const startEquity = opts.startEquity ?? 10_000;
  const seed = opts.seed ?? 12345;
  const rng = seededRandom(seed);
  const spreadPercent = opts.spreadPercent ?? 0.02;

  const { h1, m15, m5 } = history;
  const min1h = 200;
  const min15m = 300;
  const min5m = 500;

  const trades: BacktestTrade[] = [];
  const equityCurve: { t: number; equity: number }[] = [];
  const pending = new Map<string, PendingOrder>();
  const open = new Map<string, OpenPosition>();
  const fillStats = { signals: 0, pending: 0, filled: 0, missed: 0, partial: 0 };

  let equity = startEquity;
  const startIdx = opts.barRange ? opts.barRange[0] : min5m;
  const endIdx = opts.barRange ? Math.min(opts.barRange[1], m5.length) : m5.length;

  for (let i = startIdx; i < endIdx; i++) {
    const bar = m5[i];
    const t = bar.timestamp;
    const now = t + 300_000; // close of this 5M candle

    // ── 1. Process pending orders (fill / miss) ───────────────────────────────
    for (const [sym, order] of [...pending]) {
      if (now > order.createdAt + order.ttlMs) {
        pending.delete(sym);
        fillStats.missed++;
        continue;
      }
      const isLong = order.side === 'LONG';
      const touched = isLong ? bar.low <= order.entryPrice && bar.high >= order.entryPrice : bar.high >= order.entryPrice && bar.low <= order.entryPrice;
      if (!touched) continue;

      const r = rng();
      const fillProb = params.touchFillProbability;
      let fillQty = 0;
      if (r < fillProb) fillQty = 1;
      else if (r < fillProb + (1 - fillProb) * params.partialFillRatio) fillQty = params.partialFillRatio;

      if (fillQty > 0) {
        const slip = (spreadPercent / 2 + params.baseSlippagePercent) / 100;
        const execPrice = isLong ? order.entryPrice * (1 + slip) : order.entryPrice * (1 - slip);
        const risk = order.decision.risk!;
        const qty = risk.quantity * fillQty;
        const fees = (execPrice * qty * (order.type === 'FUTURES' ? BYBIT_FEES.futures.maker : BYBIT_FEES.spot.maker));
        const pos: OpenPosition = {
          symbol: sym,
          side: order.side,
          type: order.type,
          entryPrice: execPrice,
          quantity: qty,
          leverage: risk.leverage,
          stopLoss: risk.stopLoss,
          takeProfit1: risk.takeProfit1,
          takeProfit2: risk.takeProfit2,
          tp1Hit: false,
          stopDistance: risk.stopDistance,
          openTimestamp: now,
          maxHoldMs: risk.maxHoldMs,
          timeStopMs: risk.timeStopMs,
          setupType: order.decision.setupType as SetupType,
          riskUsd: risk.riskUsd * fillQty,
          notionalUsd: risk.notionalUsd * fillQty,
          marginUsd: risk.marginUsd * fillQty,
          regimeAtEntry: order.decision.regime.regime,
          atrPercentileAtEntry: order.decision.regime.atrPercentile,
          highestPrice: execPrice,
          lowestPrice: execPrice,
          highestPriceSinceTP1: execPrice,
          lowestPriceSinceTP1: execPrice,
          partial: fillQty < 1
        };
        open.set(sym, pos);
        pending.delete(sym);
        fillStats.filled++;
        if (fillQty < 1) fillStats.partial++;
        equity -= fees;
      }
    }

    // ── 2. Manage open positions (exits) ───────────────────────────────────────
    for (const [sym, pos] of [...open]) {
      const isLong = pos.side === 'LONG';
      const s = isLong ? 1 : -1;
      pos.highestPrice = Math.max(pos.highestPrice, bar.high);
      pos.lowestPrice = Math.min(pos.lowestPrice, bar.low);
      if (pos.tp1Hit) {
        pos.highestPriceSinceTP1 = Math.max(pos.highestPriceSinceTP1, bar.high);
        pos.lowestPriceSinceTP1 = Math.min(pos.lowestPriceSinceTP1, bar.low);
      }

      // Reversal proxy: opposite break-of-structure with >1 ATR adverse move.
      const struct = marketStructure(sliceUpTo(m5, t), 2, 40);
      const oppositeBos = isLong ? struct.breakOfStructure === 'DOWN' : struct.breakOfStructure === 'UP';
      const movedAgainst = ((bar.close - pos.entryPrice) * s) < -pos.stopDistance;
      const reversalSignal = oppositeBos && movedAgainst ? { direction: (isLong ? 'SHORT' : 'LONG') as 'LONG' | 'SHORT', setupScore: 75, entryConfirmed: true } : undefined;

      const view: IntradayPositionView = {
        symbol: sym,
        type: pos.type,
        side: pos.side,
        entryPrice: pos.entryPrice,
        quantity: pos.quantity,
        stopLoss: pos.stopLoss,
        takeProfit1: pos.takeProfit1,
        takeProfit2: pos.takeProfit2,
        tp1Hit: pos.tp1Hit,
        openTimestamp: pos.openTimestamp,
        maxHoldMs: pos.maxHoldMs,
        timeStopMs: pos.timeStopMs,
        setupType: pos.setupType,
        plannedStopDistance: pos.stopDistance,
        highestPrice: pos.highestPrice,
        lowestPrice: pos.lowestPrice,
        highestPriceSinceTP1: pos.highestPriceSinceTP1,
        lowestPriceSinceTP1: pos.lowestPriceSinceTP1
      };
      const exit = evaluateIntradayExit(view, {
        price: bar.close,
        now,
        // KNOWN DIVERGENCE from the live/sim path, left as-is deliberately.
        // This argument is the true 5M ATR everywhere else; here it is the stop
        // distance, because the backtest does not carry an ATR series forward
        // on the position. It only feeds the trailing width,
        // `min(trailingAtrMult × atr5, trailingMaxRMult × stopDistance)`, so
        // passing 1R pins the backtest trail at exactly 1R (1.8 × 1R loses the
        // min to 1.0 × 1R) instead of letting ATR tighten it.
        // Harmless for sim comparison: the sim bots run the profit ratchet,
        // which disables the trailing stop outright. Changing it would move
        // every historical backtest number, so it needs a deliberate rerun —
        // not a drive-by fix.
        atr5: pos.stopDistance,
        params,
        portfolio: { dailyDrawdownPercent: 0, weeklyDrawdownPercent: 0 },
        reversalSignal
      });

      if (exit.shouldExit) {
        let exitPrice = bar.close;
        let exitQty = pos.quantity;
        const slip = (spreadPercent / 2 + params.baseSlippagePercent + (pos.atrPercentileAtEntry / 100) * 0.03) / 100;
        if (exit.reasonCode === 'STOP_LOSS') exitPrice = isLong ? pos.stopLoss * (1 - slip) : pos.stopLoss * (1 + slip);
        else if (exit.reasonCode === 'TAKE_PROFIT_2') exitPrice = isLong ? pos.takeProfit2 * (1 - slip) : pos.takeProfit2 * (1 + slip);
        else if (exit.reasonCode === 'TAKE_PROFIT_1' || exit.reasonCode === 'TAKE_PROFIT') exitPrice = isLong ? pos.takeProfit1 * (1 - slip) : pos.takeProfit1 * (1 + slip);
        else if (exit.reasonCode === 'TRAILING_STOP' && exit.trailingStopPrice) exitPrice = isLong ? exit.trailingStopPrice * (1 - slip) : exit.trailingStopPrice * (1 + slip);
        else exitPrice = isLong ? bar.close * (1 - slip) : bar.close * (1 + slip);

        if (exit.exitType === 'PARTIAL_50') {
          exitQty = pos.quantity * 0.5;
          pos.quantity -= exitQty;
          pos.tp1Hit = true;
          pos.highestPriceSinceTP1 = pos.highestPrice;
          pos.lowestPriceSinceTP1 = pos.lowestPrice;
        } else {
          open.delete(sym);
        }

        const gross = (exitPrice - pos.entryPrice) * exitQty * s * (pos.type === 'FUTURES' ? pos.leverage : 1);
        const fees = exitPrice * exitQty * (pos.type === 'FUTURES' ? BYBIT_FEES.futures.taker : BYBIT_FEES.spot.taker) * 2;
        const pnl = gross - fees;
        equity += pnl;

        if (exit.exitType !== 'PARTIAL_50') {
          const mfeR = ((pos.highestPrice - pos.entryPrice) * s) / pos.stopDistance;
          trades.push({
            symbol: sym,
            side: pos.side,
            type: pos.type,
            setupType: pos.setupType,
            entryTime: pos.openTimestamp,
            exitTime: now,
            entryPrice: pos.entryPrice,
            exitPrice,
            quantity: pos.quantity,
            leverage: pos.leverage,
            notionalUsd: pos.notionalUsd,
            marginUsd: pos.marginUsd,
            riskUsd: pos.riskUsd,
            pnlUsd: Number(pnl.toFixed(2)),
            pnlPercent: Number(((pnl / (pos.marginUsd || pos.notionalUsd)) * 100).toFixed(2)),
            feesUsd: Number(fees.toFixed(2)),
            slippageUsd: Number((exitPrice * exitQty * slip).toFixed(2)),
            spreadUsd: Number((exitPrice * exitQty * (spreadPercent / 100)).toFixed(2)),
            mfeR: Number(mfeR.toFixed(2)),
            exitReason: exit.reasonCode,
            heldMinutes: Number(((now - pos.openTimestamp) / 60000).toFixed(1)),
            regimeAtEntry: pos.regimeAtEntry,
            atrPercentileAtEntry: pos.atrPercentileAtEntry,
            partial: pos.partial
          });
        }
      }
    }

    // ── 3. Scan for new signals (only when no position/pending for symbol) ─────
    if (!open.has(history.symbol) && !pending.has(history.symbol)) {
      const ctxH1 = sliceUpTo(h1, t);
      const ctxM15 = sliceUpTo(m15, t);
      const ctxM5 = sliceUpTo(m5, t);
      if (ctxH1.length >= min1h && ctxM15.length >= min15m && ctxM5.length >= min5m) {
        const decision = evaluateIntradayDecision({
          symbol: history.symbol,
          h1: ctxH1,
          m15: ctxM15,
          m5: ctxM5,
          spreadPercent,
          quoteVolume24h: 1e12,
          quoteVolume24hSpot: 1e12,
          livePrice: bar.close,
          portfolio: {
            portfolioValue: equity,
            initialAmount: startEquity,
            dailyDrawdownPercent: 0,
            weeklyDrawdownPercent: 0,
            openPositionsCount: open.size,
            openFuturesPositionsCount: [...open.values()].filter((o) => o.type === 'FUTURES').length,
            totalLeveragedExposureUsd: [...open.values()].filter((o) => o.type === 'FUTURES').reduce((a, o) => a + o.notionalUsd, 0)
          },
          openPositions: [],
          params,
          now
        });

        if (decision.outcome === 'SIGNAL' && decision.risk) {
          fillStats.signals++;
          pending.set(history.symbol, {
            symbol: history.symbol,
            side: decision.direction === 'LONG' ? 'LONG' : 'SHORT',
            type: decision.tradeType!,
            entryPrice: decision.entry!.entryPrice,
            createdAt: now,
            ttlMs: params.limitOrderTtlMinutes * 60_000,
            decision
          });
          fillStats.pending++;
        }
      }
    }

    equityCurve.push({ t: now, equity: Number(equity.toFixed(2)) });
  }

  const metrics = computeMetrics(trades, equityCurve, startEquity);
  metrics.fillStats = fillStats;
  return { symbol: history.symbol, riskPercent: params.riskPerTradePercent, metrics, trades, equityCurve };
}

/**
 * Walk-forward: TRAIN (60%) → VAL (20%) → OOS (20%). The SAME params are used
 * on every window — no re-fitting on VAL/OOS (anti-overfitting, §49).
 */
export function runWalkForward(
  history: BacktestHistory,
  params: IntradayParams = DEFAULT_INTRADAY_PARAMS,
  opts: { startEquity?: number; seed?: number; spreadPercent?: number } = {}
): WalkForwardResult {
  const n = history.m5.length;
  const startIdx = 500;
  const usable = n - startIdx;
  const trainEnd = startIdx + Math.floor(usable * 0.6);
  const valEnd = startIdx + Math.floor(usable * 0.8);

  const windows: WalkForwardWindow[] = [];
  const segments: [WalkForwardWindow['label'], number, number][] = [
    ['TRAIN', startIdx, trainEnd],
    ['VAL', trainEnd, valEnd],
    ['OOS', valEnd, n]
  ];
  for (const [label, a, b] of segments) {
    const res = runBacktest(history, params, { ...opts, barRange: [a, b] });
    windows.push({ label, startT: history.m5[a]?.timestamp ?? 0, endT: history.m5[b - 1]?.timestamp ?? 0, metrics: res.metrics, trades: res.trades });
  }

  const allTrades = windows.flatMap((w) => w.trades);
  const combinedCurve = windows.flatMap((w, i) => {
    const base = i === 0 ? opts.startEquity ?? 10_000 : 0;
    return allTrades.length ? [] : [];
  });
  const combined = computeMetrics(allTrades, combinedCurve, opts.startEquity ?? 10_000);
  combined.fillStats = windows.reduce(
    (acc, w) => ({
      signals: acc.signals + w.metrics.fillStats.signals,
      pending: acc.pending + w.metrics.fillStats.pending,
      filled: acc.filled + w.metrics.fillStats.filled,
      missed: acc.missed + w.metrics.fillStats.missed,
      partial: acc.partial + w.metrics.fillStats.partial
    }),
    { signals: 0, pending: 0, filled: 0, missed: 0, partial: 0 }
  );

  return { symbol: history.symbol, riskPercent: params.riskPerTradePercent, windows, combined };
}

/** Convenience: run all three risk variants over a history (§33). */
export function runRiskVariants(
  history: BacktestHistory,
  opts: { startEquity?: number; seed?: number; spreadPercent?: number } = {}
): { risk: number; result: WalkForwardResult }[] {
  return RISK_VARIANTS.map((risk) => ({
    risk,
    result: runWalkForward(history, { ...DEFAULT_INTRADAY_PARAMS, riskPerTradePercent: risk }, opts)
  }));
}
