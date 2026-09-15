/**
 * Intraday Bridge — adapter between the legacy simulation/live clients and the
 * new Intraday MTF engine (§8-§47).
 * ============================================================================
 * The legacy clients (useSimulationBot, simEngine, tradingWorker) used the old
 * single-timeframe tradeEngine (detectMarketRegime / evaluateSignals /
 * routeTradeType / calculateRiskParameters / evaluateExit). This module is the
 * single seam that maps their state into `evaluateIntradayDecision` /
 * `evaluateIntradayExit` and back into the UI-facing `SignalEvaluation` shape.
 *
 * Nothing here changes decision logic — it only translates data in and out.
 */

import { Candle, PortfolioRiskStats, calculateATR } from './tradeEngine';
import {
  evaluateIntradayDecision,
  IntradayDecision,
  TradeType
} from './intradayEngine';
import {
  evaluateIntradayExit,
  IntradayPositionView,
  IntradayExitContext,
  IntradayExitDecision
} from './intradayExit';
import { DEFAULT_INTRADAY_PARAMS, IntradayParams, Direction, SetupType } from './intradayParams';
import {
  getUniverseMarketData,
  getMultiTimeframeData,
  MultiTimeframeSnapshot,
  MarketDataStats
} from './marketDataService';
import { toBybitSymbol } from './assetUniverse';
import {
  MarketRegimeResult,
  MarketRegimeType,
  MarketDirectionType,
  VolatilityRegimeType
} from '../types/crypto';
import { Regime1H } from './intradayRegime';
import type { DecisionResult } from './decisionEngine/types';

export type { MultiTimeframeSnapshot } from './marketDataService';

export interface DecisionFactor {
  label: string;
  value: string;
  impact: 'positive' | 'negative' | 'neutral';
  note: string;
}

export interface SignalEvaluation {
  symbol: string;
  action: 'buy' | 'sell' | 'hold';
  tradeType: 'SPOT' | 'FUTURES' | 'HOLD';
  tradeSide: 'LONG' | 'SHORT' | 'BUY' | 'SELL' | 'NONE';
  confidence: number;
  price: number;
  priceChange24h: number;
  reasoning: string;
  status: string;
   willExecute: boolean;
   /** §16: the strategy-level decision BEFORE state-based execution gates
    *  (held / queued / slots). willExecute is the final execution choice after
    *  both layers; strategyDecision is the raw signal threshold check. */
   strategyDecision?: boolean;
  factors: DecisionFactor[];
  confidenceGap: number;
  riskLevel?: 'low' | 'medium' | 'high';
  timeframe?: 'short' | 'medium' | 'long';
  regime?: MarketRegimeResult;
  leverage?: number;
  /** Position size the RISK LAYER asked for, in USD (RiskPlan.betSizeUsd —
   *  Kelly, capped at half-Kelly and scaled by recent performance). This is what
   *  the backtest runner has always sized from; the simulations discarded it and
   *  sized from free cash instead, so a backtest result described a different
   *  position size than the engine it was supposed to validate. */
  betSizeUsd?: number;
  /** Pro (§4): the budget the gate pass actually allocated to this entry —
   *  min(initialAmount × allocation(riskLevel), projected cash at its turn in
   *  the confidence-descending batch). The order generator emits exactly this;
   *  recomputing it there would mean a second walk of the same allocation. */
  budgetUsd?: number;
  stopLoss?: number;
  takeProfit1?: number;
  takeProfit2?: number;
  takeProfit?: number;
  /** Raw engine decision — used by the order generator for exact levels */
  decision?: IntradayDecision;
  /** Advanced Analysis (Bot Pro): 24h/week/month price projections + helper
   *  levels — surfaced as auxiliary data alongside the signal. */
  advancedPredictions?: {
    h24: number; h24pct: number; w: number; wpct: number; m: number; mpct: number; confidence: number;
  };
  advancedReason?: string;
  advancedSupport?: number;
  advancedResistance?: number;
  advancedRiskLevel?: 'low' | 'medium' | 'high';
  /** Pro (§2): the full indicator breakdown, carried onto the evaluation so the
   *  order generator can compute an optimal entry price from support levels
   *  (Bollinger lower, MA20, Volume Profile VAL/POC) instead of buying at the
   *  current market price. */
  indicators?: {
    rsi: number;
    ma20: number;
    bollingerBands: { upper: number; middle: number; lower: number; position: string };
    volumeProfile: { poc: number; valueAreaHigh: number; valueAreaLow: number; position: string };
  };
  /** Pro (§4 regime filter): true when EMA50 < EMA200 on the higher timeframe —
   *  injected by proAlgEngine to block BUY signals during confirmed downtrends. */
  isDowntrend?: boolean;
  /** Live bid/ask spread as a % of mid-price, forwarded from the liquidity
   *  snapshot so the Pro gate can screen out illiquid entries. */
  spreadPercent?: number;
  /** Pro (§6): the optimal entry price computed from indicator support levels.
   *  When `limitEntries` is true, the bot places a LIMIT order at this price and
   *  waits for the market to reach it — "יחשב מתי להיכנס, יגיע לשער וירכוש".
   *  This is typically LOWER than current price (a better entry at support). */
  optimalEntryPrice?: number;
  /** Slot preemption: this entry claimed a full slot by evicting the weakest
   *  RESTING (unfilled) entry order, whose id this holds. The tick loop cancels
   *  that order once THIS entry is actually placed (a downstream budget refusal
   *  leaves the incumbent untouched). Filled positions are never preemptible —
   *  only pending orders. See pickPreemptibleEntryOrder in simExecution.ts. */
  preemptsOrderId?: string;
}

export interface PortfolioInput {
  portfolioValue: number;
  initialAmount: number;
  dailyDrawdownPercent: number;
  weeklyDrawdownPercent: number;
  openPositionsCount: number;
  openFuturesPositionsCount: number;
  totalLeveragedExposureUsd: number;
  /** Current notional exposure per asset (symbol -> notional USD). Optional:
   *  a caller that does not track it (backtests, the decision-funnel script)
   *  simply gets no per-asset cap. */
  existingExposureByAsset?: Record<string, number>;
  systemLocked?: boolean;
  lockReason?: string;
  lockedAt?: number;
}

export function buildPortfolioRiskStats(p: PortfolioInput): PortfolioRiskStats {
  return {
    portfolioValue: p.portfolioValue,
    initialAmount: p.initialAmount,
    dailyDrawdownPercent: p.dailyDrawdownPercent,
    weeklyDrawdownPercent: p.weeklyDrawdownPercent,
    openPositionsCount: p.openPositionsCount,
    openFuturesPositionsCount: p.openFuturesPositionsCount,
    totalLeveragedExposureUsd: p.totalLeveragedExposureUsd,
    existingExposureByAsset: p.existingExposureByAsset ?? {},
    systemLocked: p.systemLocked,
    lockReason: p.lockReason,
    lockedAt: p.lockedAt
  };
}

function mapRegimeToMarketRegimeResult(r: Regime1H): MarketRegimeResult {
  const regimeMap: Record<string, MarketRegimeType> = {
    BULL_TREND: 'TRENDING',
    BEAR_TREND: 'TRENDING',
    TRANSITIONAL: 'TRANSITIONAL',
    RANGING: 'RANGING'
  };
  const directionMap: Record<string, MarketDirectionType> = {
    BULL_TREND: 'BULL',
    BEAR_TREND: 'BEAR',
    TRANSITIONAL: 'NEUTRAL',
    RANGING: 'NEUTRAL'
  };
  const volMap: Record<string, VolatilityRegimeType> = {
    LOW: 'LOW',
    NORMAL: 'NORMAL',
    HIGH: 'HIGH',
    EXTREME: 'HIGH'
  };
  return {
    regime: regimeMap[r.regime] ?? 'TRANSITIONAL',
    direction: directionMap[r.regime] ?? 'NEUTRAL',
    volatility: volMap[r.volatility] ?? 'NORMAL',
    adx: r.adx,
    atr: r.atr,
    atrPercent: r.atrPercent,
    supertrend: { value: r.supertrend.value, direction: r.supertrend.direction }
  };
}

/**
 * tradeType + direction → SignalEvaluation.tradeSide. THE single definition —
 * every converter that builds a SignalEvaluation for the intraday engine must
 * call this (intradayBridge, server/simEngine.ts, useSimulationBot.ts).
 *
 * SPOT only ever goes long here (short-selling spot is unsupported — see the
 * explicit "Spot SELL disabled" guard in tradingWorker.ts's executeOrder), so a
 * SPOT signal must report tradeSide as 'BUY', never 'LONG'. Checking
 * `direction === 'LONG'` FIRST shadowed that for every SPOT LONG signal,
 * producing tradeSide='LONG' — which then failed the `=== 'BUY'` checks
 * downstream (order-side derivation in the simulation engines, and the
 * "already held" SPOT dedupe guard), so every SPOT LONG entry was queued as a
 * SELL order against a position that did not exist yet, silently no-opped on
 * fill (fillDueOrders only treats buy/long/short as entries), and never opened.
 *
 * That bug was fixed here and in useSimulationBot.ts but NOT in
 * server/simEngine.ts's parallel DecisionEngine converter — three hand-written
 * copies of one mapping, one of which drifted. Hence this function.
 */
export function resolveTradeSide(
  tradeType: 'SPOT' | 'FUTURES' | 'HOLD',
  direction: Direction | string
): 'LONG' | 'SHORT' | 'BUY' | 'SELL' | 'NONE' {
  if (tradeType === 'SPOT') return direction === 'LONG' ? 'BUY' : 'NONE';
  if (direction === 'LONG') return 'LONG';
  if (direction === 'SHORT') return 'SHORT';
  return 'NONE';
}

export function mapDecisionToSignalEvaluation(
  d: IntradayDecision,
  price: number,
  priceChange24h: number
): SignalEvaluation {
  const isSignal = d.outcome === 'SIGNAL';
  const tradeType = (d.tradeType ?? 'HOLD') as TradeType;
  const direction = d.direction;
  const action: 'buy' | 'sell' | 'hold' =
    direction === 'LONG' ? 'buy' : direction === 'SHORT' ? 'sell' : 'hold';
  const tradeSide = resolveTradeSide(tradeType, direction);
  // Reflect actual progress through the gate chain, not just full SIGNAL:
  // a NO_ENTRY case that cleared Setup still has a meaningful score to show,
  // and a NO_SETUP case can at least show how close the best candidate got.
  const confidence = d.entry
    ? Math.round(((d.setup?.setupScore ?? 0) + d.entry.entryScore) / 2)
    : d.setup
    ? Math.round(d.setup.setupScore)
    : 0;
  const priceOut = d.entry?.entryPrice || price || 0;

  const factors: DecisionFactor[] = [];
  if (d.regime) {
    factors.push({
      label: 'משטר שוק 1H (ADX 14)',
      value: `${d.regime.regime} (ADX ${d.regime.adx.toFixed(1)})`,
      impact: d.regime.trending ? 'positive' : d.regime.ranging ? 'neutral' : 'negative',
      note: d.regime.futuresAllowed ? 'מגמה מובהקת — Futures מותר' : 'ללא מגמה — Spot בלבד'
    });
    factors.push({
      label: 'תנודתיות (ATR%)',
      value: `${d.regime.volatility} (${d.regime.atrPercent.toFixed(2)}%)`,
      impact: d.regime.volatility === 'HIGH' || d.regime.volatility === 'EXTREME' ? 'negative' : 'positive',
      note: d.regime.strictMode ? 'EXTREME — סף מחמיר (§10)' : 'תנודתיות מתאימה'
    });
  }
  if (d.setup) {
    const setupPassed = d.setup.setupType !== 'NONE';
    factors.push({
      label: 'Setup 15M',
      value: setupPassed
        ? `${d.setup.setupType} ${d.setup.direction} (${d.setup.setupScore})`
        : `SetupScore ${d.setup.setupScore} (סף ${DEFAULT_INTRADAY_PARAMS.setupScoreMin}) — לא עבר`,
      impact: !setupPassed ? 'negative' : d.setup.strong ? 'positive' : 'neutral',
      note: d.setup.blockers?.length ? d.setup.blockers[0] : setupPassed ? 'Setup תקין' : 'לא זוהה Setup תקף'
    });
  }
  if (d.entry) {
    factors.push({
      label: 'Entry 5M',
      value: d.entry.confirmed
        ? `${d.entry.trigger} (${d.entry.entryScore})`
        : `EntryScore ${d.entry.entryScore} — לא אושר`,
      impact: !d.entry.confirmed ? 'negative' : d.entry.strong ? 'positive' : 'neutral',
      note: d.entry.blockers?.length ? d.entry.blockers[0] : d.entry.confirmed ? 'אישור כניסה' : 'לא אושרה כניסה'
    });
  }
  if (d.cost) {
    // Same entry/SL/TP1 as the risk plan (asserted in the engine — DATA_MISMATCH
    // otherwise), so gross R:R = reward%/risk% and net = (reward%-cost%)/risk%.
    factors.push({
      label: 'עלות/שוליים (Cost/Edge)',
      value: `R:R ${d.cost.grossRewardRisk} → נטו ${d.cost.netRewardRisk} | סיכון ${d.cost.riskPercent}% / רווח ${d.cost.rewardPercent}% / עלות ${d.cost.totalCostPercent}%`,
      impact: d.cost.approved ? 'positive' : 'negative',
      note: d.cost.reason
    });
  }
  if (d.risk && d.risk.approved) {
    factors.push({
      label: 'ניהול סיכונים (SL/TP/מינוף)',
      value: `ENTRY ${d.risk.entryPrice} SL ${d.risk.stopLoss} TP1 ${d.risk.takeProfit1} ${d.risk.leverage}x risk ${d.risk.riskPercentUsed}%`,
      impact: 'positive',
      note: `כמות ${d.risk.quantity} · R:R ${d.risk.grossRewardRisk}`
    });
  }
  factors.push({
    label: 'יומן החלטה',
    value: d.logs[d.logs.length - 1] ?? d.summary,
    impact: 'neutral',
    note: d.logs.join(' | ')
  });

  const status = isSignal
    ? `SIGNAL ${tradeType} ${direction} ${d.setupType}`
    : `NO_SIGNAL [${d.gate}] — ${d.logs[d.logs.length - 1] ?? d.summary}`;

  return {
    symbol: d.symbol,
    action,
    tradeType,
    tradeSide,
    confidence,
    price: priceOut,
    priceChange24h,
    reasoning: d.summary,
    status,
    willExecute: isSignal,
    factors,
    confidenceGap: 0,
    regime: d.regime ? mapRegimeToMarketRegimeResult(d.regime) : undefined,
    leverage: d.risk?.leverage,
    stopLoss: d.risk?.stopLoss,
    takeProfit1: d.risk?.takeProfit1,
    takeProfit2: d.risk?.takeProfit2,
    takeProfit: d.risk?.takeProfit1,
    decision: d
  };
}

export function evaluateSymbolFromSnapshot(
  snap: MultiTimeframeSnapshot,
  priceInfo: { price: number; priceChange24h: number },
  portfolio: PortfolioRiskStats,
  openPositions: { symbol: string; type: TradeType }[],
  params: IntradayParams = DEFAULT_INTRADAY_PARAMS,
  now?: number
): SignalEvaluation {
  const decision = evaluateIntradayDecision({
    symbol: snap.symbol,
    h1: snap.h1,
    m15: snap.m15,
    m5: snap.m5,
    spreadPercent: snap.liquidity?.spreadPercent ?? 0,
    quoteVolume24h: snap.liquidity?.quoteVolume24h ?? 0,
    quoteVolume24hSpot: snap.liquidity?.quoteVolume24hSpot ?? 0,
    livePrice: snap.liquidity?.lastPrice || priceInfo.price || snap.livePrice,
    portfolio,
    openPositions,
    params,
    now
  });
  return mapDecisionToSignalEvaluation(decision, priceInfo.price || snap.livePrice, priceInfo.priceChange24h);
}

export interface EvaluateUniverseOptions {
  now?: number;
  force?: boolean;
  log?: boolean;
  concurrency?: number;
}

export async function evaluateUniverse(
  symbols: string[],
  priceMap: Record<string, { price: number; priceChange24h: number }>,
  portfolio: PortfolioRiskStats,
  openPositions: { symbol: string; type: TradeType }[],
  params: IntradayParams = DEFAULT_INTRADAY_PARAMS,
  opts: EvaluateUniverseOptions = {}
): Promise<{ evaluations: SignalEvaluation[]; stats: MarketDataStats }> {
  const { snapshots, stats } = await getUniverseMarketData(symbols, {
    now: opts.now,
    force: opts.force,
    log: opts.log,
    concurrency: opts.concurrency
  });

  const evaluations: SignalEvaluation[] = [];
  for (const symbol of symbols) {
    const snap = snapshots.get(toBybitSymbol(symbol));
    if (!snap || snap.status !== 'READY') continue;
    const info = priceMap[symbol.toUpperCase()] ?? { price: snap.livePrice, priceChange24h: 0 };
    evaluations.push(evaluateSymbolFromSnapshot(snap, info, portfolio, openPositions, params, opts.now));
  }
  return { evaluations, stats };
}

export async function fetchSymbolSnapshot(
  symbol: string,
  opts: { now?: number; force?: boolean; log?: boolean } = {}
): Promise<MultiTimeframeSnapshot> {
  return getMultiTimeframeData(symbol, opts);
}

export function computeAtr5(candles: Candle[], period = 14): number {
  if (!candles || candles.length < period) return 0;
  return calculateATR(candles, period).atr;
}

export interface ExitPositionInput {
  symbol: string;
  type: 'SPOT' | 'FUTURES';
  side: 'LONG' | 'SHORT' | 'BUY' | 'SELL';
  entryPrice: number;
  quantity: number;
  stopLoss: number;
  takeProfit1?: number;
  takeProfit2?: number;
  tp1Hit?: boolean;
  ratchetConsumed?: number[];
  openTimestamp: number;
  setupType?: SetupType;
  plannedStopDistance?: number;
  highestPrice?: number;
  lowestPrice?: number;
  highestPriceSinceTP1?: number;
  lowestPriceSinceTP1?: number;
  /** Per-setup-type hold budget from the entry-time RiskPlan. Without these,
   *  evaluateIntradayExit falls back to a single hardcoded default
   *  (TREND_PULLBACK's) for every position regardless of its real setup type. */
  maxHoldMs?: number;
  timeStopMs?: number;
  /** See IntradayPositionView.naturalStopPct (intradayExit.ts) — frozen at
   *  entry from RiskPlan.naturalStopPct (intradayRisk.ts). */
  naturalStopPct?: number;
}

export function buildExitView(pos: ExitPositionInput): IntradayPositionView {
  return {
    symbol: pos.symbol,
    type: pos.type,
    side: pos.side,
    entryPrice: pos.entryPrice,
    quantity: pos.quantity,
    stopLoss: pos.stopLoss,
    takeProfit1: pos.takeProfit1,
    takeProfit2: pos.takeProfit2,
    tp1Hit: pos.tp1Hit,
    ratchetConsumed: pos.ratchetConsumed,
    openTimestamp: pos.openTimestamp,
    setupType: pos.setupType,
    plannedStopDistance: pos.plannedStopDistance,
    highestPrice: pos.highestPrice,
    lowestPrice: pos.lowestPrice,
    highestPriceSinceTP1: pos.highestPriceSinceTP1,
    lowestPriceSinceTP1: pos.lowestPriceSinceTP1,
    maxHoldMs: pos.maxHoldMs,
    timeStopMs: pos.timeStopMs,
    naturalStopPct: pos.naturalStopPct
  };
}

export interface ExitPortfolioInput {
  dailyDrawdownPercent: number;
  weeklyDrawdownPercent: number;
  systemLocked?: boolean;
}

export function evaluatePositionExit(
  pos: ExitPositionInput,
  price: number,
  atr5: number,
  portfolio: ExitPortfolioInput,
  reversal?: { direction: Direction; setupScore: number; entryConfirmed: boolean },
  params?: IntradayParams
): IntradayExitDecision {
  const view = buildExitView(pos);
  const ctx: IntradayExitContext = {
    price,
    now: Date.now(),
    atr5,
    params,
    portfolio: {
      dailyDrawdownPercent: portfolio.dailyDrawdownPercent,
      weeklyDrawdownPercent: portfolio.weeklyDrawdownPercent,
      systemLocked: portfolio.systemLocked
    },
    reversalSignal: reversal
  };
  return evaluateIntradayExit(view, ctx);
}

const METRIC_CONFIG: Record<string, { label: string; higherIsBetter: boolean; threshold: number }> = {
  setupScore: { label: 'Setup Score', higherIsBetter: true, threshold: 50 },
  entryScore: { label: 'Entry Score', higherIsBetter: true, threshold: 50 },
  edgeRatio: { label: 'Edge Ratio', higherIsBetter: true, threshold: 1 },
  netRewardRisk: { label: 'Net R/R', higherIsBetter: true, threshold: 0 },
  grossRewardRisk: { label: 'Gross R/R', higherIsBetter: true, threshold: 1 },
  stopLossDistancePercent: { label: 'SL מרחק %', higherIsBetter: false, threshold: 5 },
  rewardDistancePercent: { label: 'TP1 מרחק %', higherIsBetter: true, threshold: 0 },
  riskPercent: { label: 'Risk %', higherIsBetter: false, threshold: 50 },
  atrPercentile: { label: 'ATR Percentile', higherIsBetter: false, threshold: 70 },
  adx: { label: 'ADX', higherIsBetter: true, threshold: 25 },
  atrPercent: { label: 'ATR %', higherIsBetter: false, threshold: 50 },
  buyScore: { label: 'Buy Score', higherIsBetter: true, threshold: 50 },
  sellScore: { label: 'Sell Score', higherIsBetter: true, threshold: 50 },
  signalScore: { label: 'Signal Score', higherIsBetter: true, threshold: 50 },
  confidence: { label: 'Confidence', higherIsBetter: true, threshold: 50 },
};

export function buildFactorsFromDecisionResult(result: DecisionResult): DecisionFactor[] {
  const factors: DecisionFactor[] = [];

  // Only include metrics that are non-zero or explicitly meaningful —
  // when a pipeline blocks early (NO_DATA, CIRCUIT_BREAKER, etc), the
  // adapters return zeroed metrics for layers that never ran, which clutter
  // the decision breakdown with noise like "ADX: 0" when ADX was never calculated.
  // A zero metric is only meaningful if the gate is SIGNAL (it was computed).
  const includeZeroMetrics = result.outcome === 'SIGNAL';

  for (const [key, value] of Object.entries(result.metrics)) {
    if (typeof value !== 'number') continue;
    if (!includeZeroMetrics && value === 0) continue;

    const config = METRIC_CONFIG[key];
    if (!config) continue;

    let impact: 'positive' | 'negative' | 'neutral' = 'neutral';
    if (config.higherIsBetter) {
      if (value >= config.threshold) impact = 'positive';
      else if (value < config.threshold * 0.6) impact = 'negative';
    } else {
      if (value <= config.threshold) impact = 'positive';
      else if (value > config.threshold * 1.4) impact = 'negative';
    }

    factors.push({
      label: config.label,
      value: typeof value === 'number' ? value.toFixed(2) : String(value),
      impact,
      note: result.reasoning?.[0] || result.gate || ''
    });
  }

  // Always add the Gate label when a trade is blocked — it's the most important
  // piece of decision information for a NO_SIGNAL outcome, and its absence makes
  // the decision breakdown appear empty/broken even though the gate is the point.
  if (result.gate && result.outcome !== 'SIGNAL') {
    factors.push({
      label: 'Gate',
      value: result.gate,
      impact: 'neutral',
      note: result.reasoning?.[0] || ''
    });
  }

  return factors;
}
