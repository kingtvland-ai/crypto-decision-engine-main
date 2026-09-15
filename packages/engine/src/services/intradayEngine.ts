/**
 * Intraday Engine — shared decision orchestrator (§8-§47)
 * ============================================================================
 * Synchronous, pure, side-effect free. It takes already-fetched, validated,
 * CLOSED candles for 1H/15M/5M and produces ONE IntradayDecision.
 *
 * The same function is used by:
 *   - the live worker (tradingWorker.ts)  → candles from getMultiTimeframeData
 *   - the browser simulation (useSimulationBot.ts)
 *   - the server sim (simEngine.ts)
 *   - the backtest harness (intradayBacktest.ts) over historical 5M candles
 *
 * Gate order (§55) — the FIRST failing gate is reported as the block reason:
 *   NO_DATA → CIRCUIT_BREAKER → EXPOSURE → NO_REGIME → VOLATILITY → MACRO →
 *   LIQUIDITY → SPREAD → NO_SETUP → NO_ENTRY → RISK → COST → DATA_MISMATCH
 *
 * MACRO (2026-09-16) is the Macro Layer: Bybit's own free Open Interest,
 * Long/Short ratio and funding-rate data. It can ONLY refuse a trade
 * (sell-pressure proxy, funding veto) or trim its size (funding crowding) —
 * missing/partial derivatives data always abstains, never blocks, the same
 * rule fundingRate.ts already established. See derivativesRegime.ts.
 *
 * RISK before COST is deliberate: buildRiskPlan produces the FINAL, executed
 * entry / SL / TP1 (dynamic ATR/structure SL, TP with a 3% floor), and the
 * cost gate + every R:R number must be computed on those exact levels — never
 * on the structural references, which are telemetry only. DATA_MISMATCH is the
 * guard that no SIGNAL escapes with a cost analysis on different levels than
 * the order.
 */

import { Candle, PortfolioRiskStats, formatDynamicPrice } from './tradeEngine';
import { detectRegime1H, Regime1H } from './intradayRegime';
import { detectSetup15M, Setup15M } from './intradaySetup';
import { confirmEntry5M, Entry5M } from './intradayEntry';
import { evaluateCostEdge, CostAnalysis, buildRiskPlan, RiskPlan } from './intradayRisk';
import { isBuyingSurge, SURGE_VOLUME_LOOKBACK, measureStopNoise } from './calmRegime';
import { DEFAULT_INTRADAY_PARAMS, DecisionGate, Direction, IntradayParams, SetupType,
  withParams
} from './intradayParams';
import type { FundingSnapshot } from './fundingRate';
import { evaluateFundingGate } from './fundingRate';
import type { DerivativesSnapshot } from './derivativesRegime';
import { evaluateDerivativesRegime, detectSellPressureFromH1 } from './derivativesRegime';

export type TradeType = 'SPOT' | 'FUTURES';
export type DecisionOutcome = 'SIGNAL' | 'NO_SIGNAL' | 'NO_DATA';

export interface IntradayDecisionInput {
  symbol: string;
  h1: Candle[];
  m15: Candle[];
  m5: Candle[];
  /** Live spread / 24h turnover snapshot (optional for backtest) */
  spreadPercent?: number;
  /** 24h quote turnover on the LINEAR (futures) market */
  quoteVolume24h?: number;
  /** 24h quote turnover on the SPOT market — many assets are far more liquid
   *  here than on futures, so a SPOT trade must be gated by this, not the
   *  futures number (§26) */
  quoteVolume24hSpot?: number;
  livePrice?: number;
  portfolio: PortfolioRiskStats;
  /** Open positions of the SAME account, for same-asset Spot/Futures exclusion (§36) */
  openPositions: { symbol: string; type: TradeType }[];
  /** Partial overrides are merged over DEFAULT_INTRADAY_PARAMS — see the note
   *  in evaluateIntradayDecision. Was typed as a COMPLETE IntradayParams,
   *  which is what let `{}` slip past the compiler as a valid params object. */
  params?: Partial<IntradayParams>;
  now?: number;
  /** Current notional exposure per asset for per-asset cap checks */
  existingExposureByAsset?: Record<string, number>;
  /** How the entry will actually fill, for the §25 cost model. Defaults to true
   *  (the live bot and the backtest rest LIMIT orders). A market entry pays
   *  taker + full slippage; a caller that fills at market should pass false so
   *  the gate prices the real cost rather than the cheaper resting fill. */
  entryIsLimit?: boolean;
  /** Macro Layer (§MACRO, 2026-09-16): Bybit Open Interest + Long/Short ratio
   *  for this symbol. Optional — absent/partial data makes the MACRO gate a
   *  no-op (abstain, never block on missing data). See derivativesRegime.ts. */
  derivativesSnapshot?: DerivativesSnapshot;
  /** Macro Layer: perpetual funding rate for this symbol (already fetched by
   *  every caller for funding ACCRUAL — see fetchFundingRates — just not
   *  previously read for a trading decision). Optional, same abstain rule. */
  fundingSnapshot?: FundingSnapshot;
}

export interface IntradayDecision {
  symbol: string;
  timestamp: number;
  outcome: DecisionOutcome;
  /** First failing gate, or 'RISK' when a trade is approved */
  gate: DecisionGate;
  decision: DecisionOutcome;
  tradeType: TradeType | null;
  direction: Direction;
  setupType: SetupType;
  regime: Regime1H;
  setup: Setup15M;
  entry: Entry5M;
  cost: CostAnalysis | null;
  risk: RiskPlan | null;
  /** Human-readable log lines (Hebrew) for §44/§45/§46 */
  logs: string[];
  /** One-line summary for the evaluation list */
  summary: string;
  /** Structured telemetry for the UI / backtest.
   *  `netRewardRisk` / `grossRewardRisk` / `stopLossDistancePercent` /
   *  `rewardDistancePercent` are ALL computed on the final executed levels
   *  (RiskPlan = single source of truth). `riskPercent` here is the SIZING
   *  risk-per-trade (% of equity), a different quantity from the SL distance. */
  metrics: {
    setupScore: number;
    entryScore: number;
    edgeRatio: number;
    netRewardRisk: number;
    grossRewardRisk: number;
    /** |entry - SL| / entry * 100 on the executed levels (dynamic, <= 4.2%). */
    stopLossDistancePercent: number;
    /** |TP1 - entry| / entry * 100 on the executed levels (dynamic, >= 3%). */
    rewardDistancePercent: number;
    riskPercent: number;
    atrPercentile: number;
    volatility: string;
  };
  /** Per-window funnel telemetry (§10) */
  funnel: {
    evaluated: true;
    regimePassed: boolean;
    setupCandidates: number;
    entryCandidates: number;
    costBlocked: boolean;
    riskBlocked: boolean;
    approved: boolean;
    executed: boolean;
  };
}

function emptyDecision(symbol: string, gate: DecisionGate, outcome: DecisionOutcome, logs: string[]): IntradayDecision {
  return {
    symbol,
    timestamp: Date.now(),
    outcome,
    gate,
    decision: outcome,
    tradeType: null,
    direction: 'NONE',
    setupType: 'NONE',
    regime: null as unknown as Regime1H,
    setup: null as unknown as Setup15M,
    entry: null as unknown as Entry5M,
    cost: null,
    risk: null,
    logs,
    summary: logs[logs.length - 1] ?? 'NO_DATA',
    metrics: { setupScore: 0, entryScore: 0, edgeRatio: 0, netRewardRisk: 0, grossRewardRisk: 0, stopLossDistancePercent: 0, rewardDistancePercent: 0, riskPercent: 0, atrPercentile: 0, volatility: 'NONE' },
    funnel: { evaluated: true, regimePassed: false, setupCandidates: 0, entryCandidates: 0, costBlocked: false, riskBlocked: false, approved: false, executed: false }
  };
}

/** Cheap identity check so the common case (a caller that already passed a
 *  complete params object) skips the merge allocation entirely. */
function isFullParams(p: Partial<IntradayParams> | undefined): p is IntradayParams {
  return !!p && typeof (p as IntradayParams).adxTrendMin === 'number';
}

export function evaluateIntradayDecision(input: IntradayDecisionInput): IntradayDecision {
  // MERGE, never replace. `input.params ?? DEFAULT_INTRADAY_PARAMS` only fell
  // back when params was null/undefined — a caller passing `{}` (which the
  // DecisionEngine adapter did, because the orchestrator always writes at
  // least one key into context.params) handed this function an object where
  // EVERY threshold is undefined. Every `x >= params.someThreshold` then
  // evaluates to false, so the engine silently produced NO_SETUP for every
  // symbol AND the drawdown circuit breaker below never fired.
  // withParams() deep-merges over the defaults, so a partial override can
  // never blank out a threshold again.
  const params = isFullParams(input.params) ? input.params : withParams(input.params);
  const now = input.now ?? Date.now();
  const logs: string[] = [];
  const symbol = input.symbol;

  // ── GATE 1: NO_DATA ─────────────────────────────────────────────────────────
  const min1h = 200;
  const min15m = 300;
  const min5m = 500;
  if (input.h1.length < min1h || input.m15.length < min15m || input.m5.length < min5m) {
    logs.push(`[${symbol}] NO_DATA — חסרים נרות: 1h=${input.h1.length} 15m=${input.m15.length} 5m=${input.m5.length}`);
    return emptyDecision(symbol, 'NO_DATA', 'NO_DATA', logs);
  }

  // ── GATE 2: CIRCUIT BREAKER (§38) ───────────────────────────────────────────
  const p = input.portfolio;
  if (p.systemLocked) {
    logs.push(`[${symbol}] CIRCUIT_BREAKER — מערכת נעולה (${p.lockReason ?? 'unknown'})`);
    return emptyDecision(symbol, 'CIRCUIT_BREAKER', 'NO_SIGNAL', logs);
  }
  if (p.dailyDrawdownPercent >= params.dailyDrawdownBlockPercent) {
    logs.push(`[${symbol}] CIRCUIT_BREAKER — Drawdown יומי ${p.dailyDrawdownPercent.toFixed(1)}% >= ${params.dailyDrawdownBlockPercent}%`);
    return emptyDecision(symbol, 'CIRCUIT_BREAKER', 'NO_SIGNAL', logs);
  }
  if (p.weeklyDrawdownPercent >= params.weeklyDrawdownLockPercent) {
    logs.push(`[${symbol}] CIRCUIT_BREAKER — Drawdown שבועי ${p.weeklyDrawdownPercent.toFixed(1)}% >= ${params.weeklyDrawdownLockPercent}% (נעילה)`);
    return emptyDecision(symbol, 'CIRCUIT_BREAKER', 'NO_SIGNAL', logs);
  }

  // ── GATE 3: EXPOSURE + same-asset Spot/Futures exclusion (§36) ──────────────
  if (p.openPositionsCount >= params.maxOpenPositions) {
    logs.push(`[${symbol}] EXPOSURE — ${p.openPositionsCount} פוזיציות פתוחות (מקס ${params.maxOpenPositions})`);
    return emptyDecision(symbol, 'EXPOSURE', 'NO_SIGNAL', logs);
  }
  const sameAsset = input.openPositions.find((o) => o.symbol === symbol);
  if (sameAsset) {
    logs.push(`[${symbol}] EXPOSURE — נכס כבר פתוח (${sameAsset.type}); אין כפילות Spot/Futures (§36)`);
    return emptyDecision(symbol, 'EXPOSURE', 'NO_SIGNAL', logs);
  }

  // ── LAYER A: 1H REGIME ──────────────────────────────────────────────────────
  const regime = detectRegime1H(input.h1, params);
  logs.push(`[${symbol}] 1H=${regime.regime} bias=${regime.bias} ADX=${regime.adx.toFixed(1)} ATR%=${regime.atrPercent.toFixed(2)} vol=${regime.volatility} futuresAllowed=${regime.futuresAllowed}`);

  const transitional = regime.regime === 'TRANSITIONAL';
  const softTrend = regime.regime === 'SOFT_TREND';
  // TRANSITIONAL no longer hard-blocks: new FUTURES are blocked, but an especially
  // quality SPOT setup is still allowed (enforced at trade-type routing below).
  // SOFT_TREND is similar: Futures blocked, Spot allowed with an even higher
  // quality bar (Setup+Entry both strong + good ATR percentile).
  if (transitional) {
    logs.push(`[${symbol}] TRANSITIONAL — Futures חסום; Spot רק עבור Setup איכותי במיוחד (§8/§34)`);
  }
  if (softTrend) {
    logs.push(`[${symbol}] SOFT_TREND — Futures חסום עד אישור מגמה מלאה; Spot מותר עם סף איכותי מוגבר (§8)`);
  }

  const regimePassed = regime.regime !== 'TRANSITIONAL' && regime.regime !== 'SOFT_TREND';
  const mkFunnel = (
    gate: DecisionGate,
    outcome: DecisionOutcome,
    setup: Setup15M | null,
    entry: Entry5M | null
  ): IntradayDecision['funnel'] => ({
    evaluated: true,
    regimePassed,
    setupCandidates: setup ? setup.candidateCount : 0,
    entryCandidates: entry ? entry.confirmationCount : 0,
    costBlocked: gate === 'COST' || gate === 'SPREAD' || gate === 'RISK_VS_COST',
    riskBlocked: gate === 'RISK' && outcome === 'NO_SIGNAL',
    approved: outcome === 'SIGNAL',
    executed: false
  });

  // ── GATE 5: VOLATILITY (strict bar in EXTREME) ──────────────────────────────
  const strictMode = regime.strictMode;
  if (regime.volatility === 'EXTREME' && !regime.futuresAllowed) {
    logs.push(`[${symbol}] VOLATILITY — EXTREME; Futures חסום, Spot רק במסלול מחמיר (§10)`);
  }

  // ── GATE 6: MACRO — sell-pressure proxy (§MACRO, 2026-09-16) ────────────────
  // A volume-confirmed sharp drop on CONTRACTING open interest — the
  // zero-cost Bybit-only substitute for a large exchange-bound whale
  // transfer (Whale Alert has no free API tier; verified 2026-09-15). Runs
  // BEFORE the setup/entry layers, direction-agnostic: this asset should not
  // be traded right now at all, regardless of what setup it would have
  // produced. Missing OI data abstains — see detectSellPressure's own doc.
  // detectSellPressureFromH1 (derivativesRegime.ts) is the single shared
  // definition of this computation — Pro/Path/Bybit call the same function
  // (via simExecution.ts's applySellPressureOverride) since 2026-09-16, so
  // all 4 bots measure sell pressure identically instead of each re-deriving
  // relvol/price-drop slightly differently.
  const sellPressure = detectSellPressureFromH1(input.h1, input.derivativesSnapshot, now);
  if (sellPressure.blocked) {
    logs.push(`[${symbol}] ${sellPressure.reason}`);
    return finalize(symbol, 'MACRO', 'NO_SIGNAL', regime, null, null, null, null, logs, params, now, mkFunnel('MACRO', 'NO_SIGNAL', null, null), null);
  }
  // Advisory only — OI trend + Long/Short crowding, logged against the
  // regime's own bias (the closest thing to a direction known this early).
  // Never blocks; a caller wanting the raw verdict can compute it directly
  // from input.derivativesSnapshot via evaluateDerivativesRegime.
  if (regime.bias !== 'NONE') {
    const derivRegime = evaluateDerivativesRegime(input.derivativesSnapshot, regime.bias);
    for (const note of derivRegime.notes) logs.push(`[${symbol}] MACRO — ${note}`);
  }

  // ── LAYER B: 15M SETUP ──────────────────────────────────────────────────────
  const setup = detectSetup15M(input.m15, regime, params);
  if (setup.setupType === 'NONE') {
    logs.push(`[${symbol}] NO_SETUP — ${setup.blockers[0] ?? 'אין Setup'}`);
    return finalize(symbol, 'NO_SETUP', 'NO_SIGNAL', regime, setup, null, null, null, logs, params, now, mkFunnel('NO_SETUP', 'NO_SIGNAL', setup, null), null);
  }
  logs.push(`[${symbol}] 15M=${setup.setupType} dir=${setup.direction} SetupScore=${setup.setupScore} (strong=${setup.strong})`);

  // ── LAYER C: 5M ENTRY ──
  // The 5M confirmation gate is authoritative. No confidence bypass: a score of
  // 72 does not override an unconfirmed entry (§19/N10). If entry.confirmed is
  // false, the signal is dead — regardless of confidence.
  const entry = confirmEntry5M(input.m5, setup, params);
  const setupScore = setup.setupScore;
  const entryScore = entry.entryScore;
  if (!entry.confirmed) {
    logs.push(`[${symbol}] NO_ENTRY — EntryScore=${entry.entryScore} | ${entry.blockers[0] ?? ''}`);
    return finalize(symbol, 'NO_ENTRY', 'NO_SIGNAL', regime, setup, entry, null, null, logs, params, now, mkFunnel('NO_ENTRY', 'NO_SIGNAL', setup, entry), null);
  }
  const confidence = Math.round((setupScore + entryScore) / 2);
  logs.push(`[${symbol}] 5M=${entry.trigger} EntryScore=${entry.entryScore} confidence=${confidence} price=${formatDynamicPrice(entry.entryPrice)}`);

  // ── TRADE TYPE ROUTING (§19/§34) ────────────────────────────────────────────
  let tradeType: TradeType;
  if (setup.spotOnly) {
    tradeType = 'SPOT';
  } else if (regime.futuresAllowed) {
    tradeType = 'FUTURES';
  } else if (
    params.allowShortDuringHighVolatility &&
    regime.trending &&
    regime.volatility === 'HIGH' &&
    (setup.direction === 'SHORT' || setup.direction === 'LONG')
  ) {
    // Deliberate carve-out for BOTH directions in HIGH volatility:
    // - SHORT: regime.futuresAllowed is direction-agnostic and blocks FUTURES
    //   outright in HIGH volatility, which normally disables the bot's only
    //   tool for profiting from a sharp down-move exactly when the down-move
    //   is sharpest (allowShortDuringHighVolatility, off by default).
    // - LONG: the same blockage in HIGH volatility stops trend-following
    //   longs on sharp up-moves. Symmetric carve-out: a trending market in
    //   HIGH volatility may trade the direction the trend points. EXTREME
    //   volatility stays blocked for both (see below) — liquidation risk at
    //   EXTREME + leverage is judged too high either way.
    tradeType = 'FUTURES';
  } else {
    tradeType = 'SPOT';
  }
  // EXTREME volatility forces spot even for trends (§10) — applies regardless
  // of direction or allowShortDuringHighVolatility: liquidation risk at
  // EXTREME + leverage is judged too high either way.
  if (regime.volatility === 'EXTREME') tradeType = 'SPOT';

  // ── TRANSITIONAL / SOFT_TREND quality gate (§8/§34) ─────────────────────────
  // FUTURES stays blocked here (forced SPOT below — a real risk control). The
  // quality bar used to be `setup.strong && entry.strong && atrPercentile<70`
  // (≈64 && ≈68) — a cliff that made the ADX 20-25 band nearly untradeable.
  // Now a low OR-bar: one decent score carries it, ATR only blocks EXTREME.
  if (transitional || softTrend) {
    tradeType = 'SPOT';
    const isSoftTrend = softTrend;
    const decent = setup.setupScore >= 55 || entry.entryScore >= 58;
    const atrOk = !regime.strictMode; // EXTREME volatility still blocked
    if (!(decent && atrOk)) {
      const reason = !atrOk
        ? `${isSoftTrend ? 'SOFT_TREND' : 'TRANSITIONAL'} + תנודתיות EXTREME — נחסם (§10)`
        : `${isSoftTrend ? 'SOFT_TREND' : 'TRANSITIONAL'} דורש SetupScore≥55 או EntryScore≥58 (נחשב ${setup.setupScore}/${entry.entryScore}) — נחסם (§8)`;
      logs.push(`[${symbol}] NO_REGIME — ${reason}`);
      return finalize(symbol, 'NO_REGIME', 'NO_SIGNAL', regime, setup, entry, null, null, logs, params, now, mkFunnel('NO_REGIME', 'NO_SIGNAL', setup, entry), null);
    }
    logs.push(`[${symbol}] ${isSoftTrend ? 'SOFT_TREND' : 'TRANSITIONAL'} — Spot מאושר (SS=${setup.setupScore} ES=${entry.entryScore})`);
  }

  // ── SPOT cannot express a SHORT (§19) ──────────────────────────────────────
  // Three separate branches above force SPOT without consulting the setup's
  // DIRECTION: the `spotOnly`/no-futures default, the EXTREME-volatility
  // override, and the TRANSITIONAL/SOFT_TREND quality gate. A SHORT that lands
  // in any of them used to continue into buildRiskPlan, whose level formula
  // keys off `tradeType === 'SPOT' || isLong` and therefore built LONG-shaped
  // levels (stop BELOW entry) for a SHORT — caught three steps later by
  // validateLevelDirection as the baffling "SL חייב להיות מעל מחיר הכניסה
  // ב-SHORT" under a RISK gate. Observed live on PUMP / LIT / XRP: a
  // TRANSITIONAL regime (futuresAllowed=false) approved a SHORT "as Spot" and
  // then failed the validator. Refuse it here, by name, where the reason is
  // still legible.
  if (tradeType === 'SPOT' && setup.direction === 'SHORT') {
    const reason = `כיוון SHORT אך המסלול הוא SPOT (futuresAllowed=${regime.futuresAllowed}, vol=${regime.volatility}) — ספוט לא יכול לשרטט`;
    logs.push(`[${symbol}] NO_REGIME — ${reason}`);
    return finalize(symbol, 'NO_REGIME', 'NO_SIGNAL', regime, setup, entry, null, null, logs, params, now, mkFunnel('NO_REGIME', 'NO_SIGNAL', setup, entry), tradeType);
  }

  // ── GATE 6/7: LIQUIDITY + SPREAD (§26/§27) ─────────────────────────────────
  const spreadPercent = input.spreadPercent ?? 0;
  // Gate on the liquidity of the market the trade will actually execute on —
  // a SPOT setup must not be blocked by thin FUTURES turnover and vice versa (§26).
  const quoteVolume = tradeType === 'SPOT' ? (input.quoteVolume24hSpot ?? 0) : (input.quoteVolume24h ?? 0);
  if (quoteVolume > 0 && quoteVolume < params.minQuoteVolume24h) {
    logs.push(`[${symbol}] LIQUIDITY — מחזור 24h ${quoteVolume.toFixed(0)}$ < ${params.minQuoteVolume24h}$`);
    return finalize(symbol, 'LIQUIDITY', 'NO_SIGNAL', regime, setup, entry, null, null, logs, params, now, mkFunnel('LIQUIDITY', 'NO_SIGNAL', setup, entry), tradeType);
  }
  if (spreadPercent > params.maxSpreadPercent) {
    logs.push(`[${symbol}] SPREAD — ${spreadPercent.toFixed(3)}% > ${params.maxSpreadPercent}% (נזילות נמוכה)`);
    return finalize(symbol, 'SPREAD', 'NO_SIGNAL', regime, setup, entry, null, null, logs, params, now, mkFunnel('SPREAD', 'NO_SIGNAL', setup, entry), tradeType);
  }

  // ── GATE 5b: strict bar in EXTREME volatility ──────────────────────────────
  if (strictMode && (!setup.strong || !entry.strong)) {
    logs.push(`[${symbol}] VOLATILITY — EXTREME דורש SetupScore/EntryScore חזקים (strong); נחסם (§10)`);
    return finalize(symbol, 'VOLATILITY', 'NO_SIGNAL', regime, setup, entry, null, null, logs, params, now, mkFunnel('VOLATILITY', 'NO_SIGNAL', setup, entry), tradeType);
  }

  // ── RISK PLAN (§30-§35) — FIRST, because it produces the FINAL executed
  //    entry / SL / TP1. The cost gate and every R:R number below run on these
  //    exact levels (single source of truth), never on the structural
  //    references (telemetry only). ──────────────────────────────────────────
  // Adaptive sizing (DecisionEngine path only): the orchestrator injects
  // `_sizingMultiplier` into params from recent closed-trade performance.
  // The live scan() path passes no multiplier → 1 (base sizing, unchanged).
  const rawSizing = (input.params as Record<string, unknown> | undefined)?._sizingMultiplier;
  const adaptiveSizingMultiplier = typeof rawSizing === 'number' && Number.isFinite(rawSizing)
    ? Math.min(1, Math.max(0, rawSizing))
    : 1;

  // Funding gate (fundingRate.ts) — built and calibrated (3,156-signal A/B
  // study, scripts/fundingOrthogonality.ts) well before this session, but
  // never actually WIRED into a live decision until now (2026-09-16, part of
  // the Macro Layer addition). Direction is known here (setup.direction),
  // unlike at GATE 6 above. Abstains on missing/stale funding — never blocks
  // on absent data.
  const isLongDirection = setup.direction === 'LONG';
  const fundingVerdict = evaluateFundingGate(
    input.fundingSnapshot,
    isLongDirection ? 'LONG' : 'SHORT',
    now
  );
  if (fundingVerdict.kind === 'veto') {
    logs.push(`[${symbol}] ${fundingVerdict.reason}`);
    return finalize(symbol, 'MACRO', 'NO_SIGNAL', regime, setup, entry, null, null, logs, params, now, mkFunnel('MACRO', 'NO_SIGNAL', setup, entry), null);
  }
  if (fundingVerdict.kind === 'trim') logs.push(`[${symbol}] ${fundingVerdict.reason}`);
  const fundingSizeMultiplier = fundingVerdict.kind === 'trim' || fundingVerdict.kind === 'allow'
    ? fundingVerdict.sizeMultiplier
    : 1;
  const sizingMultiplier = adaptiveSizingMultiplier * fundingSizeMultiplier;

  const risk = buildRiskPlan({
    symbol,
    direction: setup.direction as Exclude<Direction, 'NONE'>,
    tradeType,
    setupType: setup.setupType as Exclude<SetupType, 'NONE'>,
    entryPrice: entry.entryPrice,
    // Telemetry only — buildRiskPlan uses the fixed-percentage model.
    stopReference: entry.stopReference,
    targetReference: entry.targetReference,
    atr5: entry.atr5,
    atr15: setup.levels.atr,
    // The two conditions that widen the fixed 2.3% stop — both measured on the
    // 5M series the entry itself was confirmed on, so "a lot of buyers" and "the
    // tape just got wider" both mean at the moment of entry, not on a slower frame.
    buyingSurge: isBuyingSurge(input.m5, SURGE_VOLUME_LOOKBACK, now),
    stopNoise: measureStopNoise(input.m5),
    equity: p.portfolioValue,
    // SIM-ONLY (params.useFixedSizingBase, set in SIM_INTRADAY_PARAMS_OVERRIDE).
    // The live bot leaves it unset and keeps sizing against live equity.
    sizingBase: params.useFixedSizingBase ? p.initialAmount : undefined,
    openPositions: p.openPositionsCount,
    openFutures: p.openFuturesPositionsCount,
    currentLeveragedExposureUsd: p.totalLeveragedExposureUsd,
    existingExposureByAsset: input.existingExposureByAsset ?? p.existingExposureByAsset ?? {},
    confidence,
    sizingMultiplier,
    params
  });

  // RISK gate is authoritative — a rejection from buildRiskPlan is a rejection.
  // No high-confidence bypass: buildRiskPlan enforces per-asset caps, total
  // exposure caps, position count limits, and the MIN_ORDER floor
  // unconditionally. Confidence ≥ 72 does not override any of these (§19/N10).
  const effectiveRisk = risk.approved ? risk : null;

  if (!effectiveRisk) {
    logs.push(`[${symbol}] RISK — ${risk.blockReason ?? 'נפסל'}`);
    return finalize(symbol, 'RISK', 'NO_SIGNAL', regime, setup, entry, null, risk, logs, params, now, mkFunnel('RISK', 'NO_SIGNAL', setup, entry), tradeType);
  }

  // ── COST / EDGE (§25) — on the EXACT levels the order will use ──────────────
  // No confidence bypass: evaluateCostEdge is arithmetic about whether the move
  // covers fees + spread + slippage. A score of 72 does not make a
  // negative-expectancy trade positive.
  const cost = evaluateCostEdge({
    tradeType,
    entryPrice: entry.entryPrice,
    stopLoss: effectiveRisk.stopLoss,
    takeProfit1: effectiveRisk.takeProfit1,
    // Fixed profit-ladder (calmRegimeScalp, sim only): buildRiskPlan's own
    // R:R gate already measured gross R:R against TP2 for this plan (TP1's
    // ratio is deliberately poor — a fast partial, not the thesis) — COST must
    // measure the same target or it re-rejects an already-approved plan on a
    // number the risk gate never used. See CostInput.rewardTarget.
    rewardTarget: params.calmRegimeScalp === true ? effectiveRisk.takeProfit2 : effectiveRisk.takeProfit1,
    spreadPercent,
    atrPercentile: regime.atrPercentile,
    // Default true (live bot + backtest rest limits). A market-fill caller
    // passes false so the gate prices the taker + slippage it actually pays.
    entryIsLimit: input.entryIsLimit ?? true,
    // Already computed by confirmEntry5M for the volume trigger — reused.
    relativeVolume: entry.indicators.relativeVolume,
    params
  });
  if (!cost.approved) {
    // 'RISK_VS_COST' and 'SPREAD' report themselves; anything else is the §25
    // reward-vs-cost gate. SPREAD is also reachable earlier (GATE 6/7) but the
    // share-of-move spread check lives inside evaluateCostEdge, so honour it here.
    const costGate: DecisionGate = cost.blockGate === 'RISK_VS_COST'
      ? 'RISK_VS_COST'
      : cost.blockGate === 'SPREAD' ? 'SPREAD' : 'COST';
    logs.push(`[${symbol}] ${costGate} — ${cost.reason}`);
    return finalize(symbol, costGate, 'NO_SIGNAL', regime, setup, entry, cost, effectiveRisk, logs, params, now, mkFunnel(costGate, 'NO_SIGNAL', setup, entry), tradeType);
  }
  logs.push(`[${symbol}] COST OK — ${cost.reason}`);

  // ── CONSISTENCY (§ single source of truth) ────────────────────────────────
  // The cost analysis MUST have been computed on the risk plan's exact levels.
  // If not, a "shadow levels" bug has been reintroduced upstream — do NOT emit
  // a SIGNAL; report DATA_MISMATCH and log both level sets for diagnosis.
  const LEVEL_TOL = 1e-8;
  const levelMismatch =
    Math.abs(cost.entryPrice - effectiveRisk.entryPrice) > LEVEL_TOL ||
    Math.abs(cost.stopLoss - effectiveRisk.stopLoss) > LEVEL_TOL ||
    Math.abs(cost.takeProfit1 - effectiveRisk.takeProfit1) > LEVEL_TOL;
  if (levelMismatch) {
    logs.push(
      `[${symbol}] DATA_MISMATCH — CostAnalysis levels ` +
      `ENTRY=${cost.entryPrice} SL=${cost.stopLoss} TP1=${cost.takeProfit1} ` +
      `!= RiskPlan levels ENTRY=${effectiveRisk.entryPrice} SL=${effectiveRisk.stopLoss} TP1=${effectiveRisk.takeProfit1} ` +
      `(tolerance ${LEVEL_TOL})`
    );
    return finalize(symbol, 'DATA_MISMATCH', 'NO_SIGNAL', regime, setup, entry, cost, effectiveRisk, logs, params, now, mkFunnel('DATA_MISMATCH', 'NO_SIGNAL', setup, entry), tradeType);
  }

  // ── DIAGNOSTIC — every number below is on the SAME entry / SL / TP1 ────────
  logs.push(
    `[${symbol}] SIGNAL_LEVELS ` +
    `ENTRY=${effectiveRisk.entryPrice} SL=${effectiveRisk.stopLoss} TP1=${effectiveRisk.takeProfit1} ` +
    `RISK%=${effectiveRisk.riskPercent.toFixed(3)} REWARD%=${effectiveRisk.rewardPercent.toFixed(3)} ` +
    `GROSS_RR=${effectiveRisk.grossRewardRisk.toFixed(2)} ` +
    `ENTRY_FEE%=${cost.entryFeePercent.toFixed(3)} EXIT_FEE%=${cost.exitFeePercent.toFixed(3)} ` +
    `SLIPPAGE%=${cost.slippagePercent.toFixed(3)} TOTAL_COST%=${cost.totalCostPercent.toFixed(3)} ` +
    `NET_RR=${cost.netRewardRisk.toFixed(2)}`
  );
   logs.push(
     `[${symbol}] SIGNAL ${tradeType} ${setup.direction} ${setup.setupType} | SL=${formatDynamicPrice(effectiveRisk.stopLoss)} TP1=${formatDynamicPrice(effectiveRisk.takeProfit1)} lev=${effectiveRisk.leverage}x risk=${effectiveRisk.riskPercent}% qty=${effectiveRisk.quantity}`
   );
   logs.push(
     `[${symbol}] SIGNAL_JSON ` +
     JSON.stringify({
       symbol,
       tradeType,
       direction: setup.direction,
       setupType: setup.setupType,
       confidence,
       entryPrice: effectiveRisk.entryPrice,
       stopLoss: effectiveRisk.stopLoss,
       takeProfit1: effectiveRisk.takeProfit1,
       takeProfit2: effectiveRisk.takeProfit2,
       riskPercent: effectiveRisk.riskPercent,
       rewardPercent: effectiveRisk.rewardPercent,
       grossRR: effectiveRisk.grossRewardRisk,
       positionPercentOfEquity: effectiveRisk.positionPercentOfEquity,
       notionalUsd: effectiveRisk.notionalUsd,
       bindingConstraint: effectiveRisk.bindingConstraint,
       leverage: effectiveRisk.leverage,
       quantity: effectiveRisk.quantity,
       netRR: cost.netRewardRisk,
       entryFeePercent: cost.entryFeePercent,
       exitFeePercent: cost.exitFeePercent,
       slippagePercent: cost.slippagePercent,
       totalCostPercent: cost.totalCostPercent,
       regime: regime.regime,
       bias: regime.bias,
       atrPercentile: regime.atrPercentile
     })
   );

  return finalize(symbol, 'RISK', 'SIGNAL', regime, setup, entry, cost, effectiveRisk, logs, params, now, mkFunnel('RISK', 'SIGNAL', setup, entry), tradeType);
}

function finalize(
  symbol: string,
  gate: DecisionGate,
  outcome: DecisionOutcome,
  regime: Regime1H,
  setup: Setup15M | null,
  entry: Entry5M | null,
  cost: CostAnalysis | null,
  risk: RiskPlan | null,
  logs: string[],
  params: IntradayParams,
  now: number,
  funnel: IntradayDecision['funnel'],
  tradeType: TradeType | null
): IntradayDecision {
  const setupScore = setup?.setupScore ?? 0;
  const entryScore = entry?.entryScore ?? 0;
  const direction: Direction = setup?.direction ?? 'NONE';
  const setupType: SetupType = setup?.setupType ?? 'NONE';

  const summary =
    outcome === 'SIGNAL'
      ? `SIGNAL ${tradeType} ${direction} ${setupType} (SS=${setupScore} ES=${entryScore})`
      : outcome === 'NO_DATA'
      ? 'NO_DATA'
      : `NO_SIGNAL [${gate}]`;

  return {
    symbol,
    timestamp: now,
    outcome,
    gate,
    decision: outcome,
    tradeType,
    direction,
    setupType,
    regime,
    setup: setup as Setup15M,
    entry: entry as Entry5M,
    cost,
    risk,
    logs,
    summary,
    metrics: {
      setupScore,
      entryScore,
      edgeRatio: cost?.edgeRatio ?? 0,
      // All R:R numbers come off the final executed levels (RiskPlan / cost on
      // those same levels) — never the structural references.
      netRewardRisk: cost?.netRewardRisk ?? 0,
      grossRewardRisk: cost?.grossRewardRisk ?? risk?.grossRewardRisk ?? 0,
      stopLossDistancePercent: risk?.riskPercent ?? 0,
      rewardDistancePercent: risk?.rewardPercent ?? 0,
       riskPercent: risk?.riskPercent ?? 0,
      atrPercentile: regime?.atrPercentile ?? 0,
      volatility: regime?.volatility ?? 'NONE'
    },
    funnel
  };
}
