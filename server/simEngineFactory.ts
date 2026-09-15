// Shared server-side simulation engine — the tick/market-data/persistence
// plumbing used by all FOUR sim bots (intraday multi-timeframe, pro/alg.md,
// 4H Path/Empirical, Bybit/TrendBreakout). A fifth bot, "Legacy"
// (single-timeframe), existed early on and was deleted along with
// legacySimEngine.ts/legacySimExecution.ts — this factory itself was written
// to end three separate copy-pastes of this plumbing (server/simEngine.ts,
// legacySimEngine.ts, proSimEngine.ts) down to one, and now backs
// simEngine.ts / proSimEngine.ts / pathSimEngine.ts / bybitSimEngine.ts, each
// supplying a small `SimEngineStrategy` that plugs its own
// evaluation/order-generation functions — from simExecution.ts /
// proSimExecution.ts / prev4hRangeExecution.ts / trendBreakoutExecution.ts —
// into this shared loop. Because all four run in this one loop, this file is
// also the single place that can see every bot at once — see
// crossBotExposure.ts for the one thing that actually needs that.
import { formatDynamicPrice, validateExposureModel, POSITION_TARGET_PCT, MAX_TOTAL_EXPOSURE_PERCENT, SIM_BASE_DEFAULTS } from '@cde/engine/execution';
import type { Candle } from '@cde/engine';
import { getAggregatedPrices } from '@cde/engine/market-data';
import type { CryptoData } from '@cde/engine';
import { computeAtr5, SignalEvaluation } from '@cde/engine';
import type { MultiTimeframeSnapshot } from '@cde/engine/market-data';
import { getUniverseMarketData, fetchFundingRates } from '@cde/engine/market-data';
import type { FundingSnapshot } from '@cde/engine/analysis';
import { toBaseAsset } from '@cde/engine/market-data';
import {
  fillDueOrders,
  selectFillableOrders,
  applyFundingAccrual,
  applySlotPreemptions,
  SimPosition,
  SimTrade,
  SimPoint,
  PendingOrder,
  SimBotConfig
} from '@cde/engine/execution';
import { registerBotHoldings, wouldExceedCrossBotCap, otherBotsHolding } from './crossBotExposure';

export type { SimPosition, SimTrade, SimPoint, PendingOrder, SimBotConfig };

export interface SimSnapshot {
  runId: string;
  cash: number;
  /** Capital the CURRENT run started with. Carried in the snapshot because it
   *  is the denominator of every P&L figure the UI shows, and it cannot be
   *  recovered from anything else once the run has traded. */
  initialAmount: number;
  positions: SimPosition[];
  trades: SimTrade[];
  history: SimPoint[];
  hourlyHistory: SimPoint[];
  pending: PendingOrder[];
  totalFees: number;
  totalSlippageCost: number;
  /** Cumulative perpetual funding paid on FUTURES positions (USD, positive =
   *  cost). Applied to every sim bot alike; spot-only bots stay at 0. Optional
   *  because snapshots persisted before funding accrual existed lack it. */
  totalFunding?: number;
  /** When funding was last accrued (ms). Absent on old snapshots — the engine
   *  then starts accruing from the next tick rather than billing a backlog. */
  lastFundingAppliedAt?: number;
  lastEvaluation?: string;
}

/** A finished run, captured at reset() before the engine's state is wiped
 *  (§9/#4). Persisted to the archive KV store by the worker so BacktestResults
 *  can show historical trades that a "Reset All Bots" would otherwise destroy.
 *  A "Clear Cache + Server" wipe deletes these; a plain reset does not. */
export interface ArchivedRun {
  runId: string;
  botId?: string;
  initialAmount: number;
  finalEquity: number;
  totalPnl: number;
  totalPnlPercent: number;
  finalCash: number;
  /** Closed + open trade log of the run (same shape the live snapshot carries). */
  trades: SimTrade[];
  /** Positions still open at reset, marked to market. */
  openPositions: Array<{
    symbol: string;
    type: 'SPOT' | 'FUTURES';
    side: string;
    quantity: number;
    entryPrice: number;
    mark: number;
    pnl: number;
    reason: string;
  }>;
  tradeCount: number;
  feeTotal: number;
  slippageTotal: number;
  fundingTotal: number;
  startedAt?: number;
  archivedAt: number;
}

// 2.5s (2026-09-15, down from 4s), matched to LIVE_PRICE_FRESHNESS_MS below.
const TICK_MS = 2500;
// Bulk price refresh — one call for the whole traded universe via
// getAggregatedPrices() → fetchBybitAllTickers(), which itself caches for
// BYBIT_TICKER_TTL (2.5s, cryptoPriceAggregator.ts) shared across all four
// sim bots. Matching that here means every tick asks, but the exchange is
// only actually hit once per ~2.5s total, not once per bot per tick.
// 2.5s (2026-09-15, down from 60s) — the 60s value throttled the LOCAL copy
// of the price (`lastPrices`, read by every stop-loss/ratchet/PnL check via
// priceFor()) far below what the aggregator itself could already provide,
// which is what LIVE_PRICE_FRESHNESS_MS below now exists to catch when it
// still happens (a slow tick, a failed fetch).
const CRYPTO_REFRESH_MS = 2_500;
// Candle refresh — same bug shape as CRYPTO_REFRESH_MS above, found and fixed
// 2026-09-15. marketDataService.ts (TIMEFRAME_SPECS) is ALREADY designed with
// its own per-timeframe cadence — 5m every 45s, 15m every 90s, 1h every 5min —
// checked inside getMultiTimeframeData every time it's called. But this outer
// gate controlled whether it was called AT ALL, and 5 minutes sat well above
// even the slowest inner cadence, so none of those inner numbers ever
// mattered: `liveCandles` (the only place buildM5CandlesForSymbol /
// buildH1CandlesForSymbol read from) went up to ~10 minutes stale (5min gate
// + one dropped forming-candle period) while confirmEntry5M's chase-penalty
// and trigger-confirmation logic — meant to react to what the tape is doing
// RIGHT NOW — evaluated candles from up to 10 minutes ago, alongside a live
// PRICE (post the CRYPTO_REFRESH_MS fix) fresh to ~3 seconds. 15s — comfortably
// under the fastest inner TTL (45s for 5m) — makes that inner TTL the real
// limiter again, the same relationship CRYPTO_REFRESH_MS now has with
// BYBIT_TICKER_TTL. No rate-limit rationale ever justified 5 minutes here
// (unlike the removed CRYPTO_REFRESH_MS comment, which had one for CoinGecko);
// the curated per-bot symbol universe (not the 400+-pair full Bybit universe)
// is what keeps this cheap either way — see the comment on refreshCryptoPrices.
const CANDLE_REFRESH_MS = 15_000;
// Live Freshness Guarantee (2026-09-15): stop-loss, take-profit and the
// profit ratchet must never be evaluated against a price older than this.
// Under normal conditions CRYPTO_REFRESH_MS already keeps `lastPrices` this
// fresh every tick; this is the hard backstop for when it doesn't — a slow
// tick (candle refresh, GC pause) or a failed fetch that left cryptoRefreshAt
// stale. See the forced re-fetch in tick(), right before positions mark to
// market and generateNewOrders evaluates exits.
const LIVE_PRICE_FRESHNESS_MS = 3_000;

/** Pure predicate behind the Live Freshness Guarantee — pulled out of tick()
 *  so the 3-second boundary is unit-testable without spinning up an engine,
 *  mocking fetch, or faking timers. `lastRefreshAt` is the engine's
 *  `cryptoRefreshAt`; `hasOpenPositions` skips the check entirely when there
 *  is nothing to mark-to-market or exit-evaluate this tick. */
export function needsForcedPriceRefresh(
  lastRefreshAt: number,
  now: number,
  hasOpenPositions: boolean,
  freshnessMs: number = LIVE_PRICE_FRESHNESS_MS
): boolean {
  return hasOpenPositions && now - lastRefreshAt > freshnessMs;
}

/**
 * Everything a strategy's buildEvaluations/generateOrders might need for one
 * tick. A given strategy only reads the fields its own decision logic
 * actually uses (e.g. the intraday strategy ignores `candlesBySymbol`, the
 * legacy/pro strategies ignore `buildCandlesForSymbol`/`correlationCandles`)
 * — the unused fields cost only the (trivial, O(numSymbols)) computation to
 * build them, which is far cheaper than the three-engine duplication this
 * factory replaces.
 */
export interface StrategyTickInput {
  cryptoData: CryptoData[];
  liveCandles: Record<string, MultiTimeframeSnapshot>;
  /** H1 candles per symbol (keyed by BASE asset), gated by
   *  strategy.minCandlesForH1View. Used by the legacy/pro (single-timeframe)
   *  strategies. */
  candlesBySymbol: Record<string, Candle[]>;
  /** M5 candles for one symbol (empty array if not ready). Used by the
   *  intraday (multi-timeframe) strategy's order generation. */
  buildCandlesForSymbol: (symbol: string) => Candle[];
  /** H1 series per symbol (undefined if not available), keyed by BASE asset
   *  — used by the intraday strategy for the within-batch correlation gate. */
  correlationCandles: Record<string, Candle[] | undefined>;
  positions: SimPosition[];
  pending: PendingOrder[];
  config: SimBotConfig;
  equity: number;
  initialAmount: number;
  dailyDrawdownPercent: number;
  weeklyDrawdownPercent: number;
  totalLeveragedExposureUsd: number;
  /** {pnl, at, symbol} — what the intraday strategy's evaluation/order-gen consume.
   *  `riskUsd` is the risk-at-entry that turns Kelly's payoff ratio into
   *  R-multiples; absent on trades closed before the field existed. */
  closedTrades: { pnl: number; at: number; symbol?: string; riskUsd?: number }[];
  /** {pnl, pnlPercent, at, symbol} — what the legacy/pro strategies consume. */
  closedTradeMetrics: { pnl: number; pnlPercent: number; at: number; symbol?: string; riskUsd?: number }[];
  fearGreedIndex: number;
  /** Current perpetual funding, keyed by Binance futures pair (e.g. "BTCUSDT").
   *  Empty when the feed is unavailable — the funding gate abstains, so an
   *  outage costs an opinion rather than the ability to trade. */
  fundingBySymbol: Map<string, FundingSnapshot>;
  cash: number;
  exitCooldown: Record<string, number>;
  priceFor: (symbol: string) => number | undefined;
  toBase: (symbol: string) => string;
  computeAtr5: typeof computeAtr5;
  maxPositions: number;
  maxFuturesPositions: number;
}

export interface SimEngineStrategy {
  /** Short id, used only for readability in this factory's own code. */
  id: string;
  /** Console log line prefix, e.g. "[sim-engine]". */
  logPrefix: string;
  /** Tag used in the telegram-failure warning, e.g. "sim". */
  telegramTag: string;
  /** Telegram message header for this bot's fill notifications. */
  telegramTitle: string;
  /** Hebrew label inserted into the "overall bot status" footer. */
  statusFooterLabel: string;
  /** Reported in getSnapshot() — the bot's configured confidence floor. */
  minConfidence: number;
  /** Minimum H1 candles required before candlesBySymbol exposes a symbol
   *  (MIN_LEGACY_CANDLES / MIN_PRO_CANDLES). Strategies that never read
   *  candlesBySymbol (the intraday one) can pass 0. */
  minCandlesForH1View: number;
  /** Passed to getUniverseMarketData({ log }) — only the intraday engine
   *  originally logged candle-fetch telemetry. */
  logCandleFetch: boolean;
  buildEvaluations: (input: StrategyTickInput) => SignalEvaluation[];
  generateOrders: (input: StrategyTickInput, evaluations: SignalEvaluation[]) => PendingOrder[];
}

async function sendSimTelegramMessage(tag: string, message: string): Promise<void> {
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || '';
  const telegramChatId = process.env.TELEGRAM_CHAT_ID || '';
  if (!telegramBotToken || !telegramChatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: telegramChatId, text: message })
    });
    // fetch() only rejects on network failure — a bad token/chat-id comes
    // back as a normal (non-2xx) response, which must still be inspected, or
    // a misconfigured bot fails 100% silently.
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[telegram] ${tag} sendMessage failed: HTTP ${res.status} ${body.slice(0, 300)}`);
    }
  } catch (e) {
    // Never throw — a Telegram failure must not affect the simulation.
    console.warn(`[telegram] ${tag} sendMessage threw:`, e instanceof Error ? e.message : String(e));
  }
}

export function createGenericSimEngine(strategy: SimEngineStrategy, getSymbols?: () => string[]) {
  let cash = 10000;
  let positions: SimPosition[] = [];
  let trades: SimTrade[] = [];
  let history: SimPoint[] = [];
  let hourlyHistory: SimPoint[] = [];
  let pending: PendingOrder[] = [];
  let totalFees = 0;
  let totalSlippageCost = 0;
  let totalFunding = 0;
  let lastFundingAppliedAt = 0;
  let lastEvaluation = '';
  let lastEvaluations: SignalEvaluation[] = [];
  // Safety net against rapid re-entry churn: after a LOSING full exit, skip new
  // entries on that symbol for a cooldown window even if the signal still fires.
  const exitCooldown: Record<string, number> = {};

  let liveCandles: Record<string, MultiTimeframeSnapshot> = {};
  let cryptoData: CryptoData[] = [];
  const lastPrices: Record<string, number> = {};
  let cryptoRefreshAt = 0;
  let candleRefreshAt = 0;
  let candleRefreshing = false;
  let initialAmount = 10000;
  let runId: string | null = null;

  // Positions/orders always carry the SUFFIXED symbol ("LITUSDT", from the MTF
  // snapshot), but cryptoData/lastPrices are keyed by the BARE ticker symbol
  // ("lit", from the price aggregator) — comparing them directly never matched,
  // so priceFor() silently returned undefined for every open position and mark-
  // to-market prices (and therefore chart currentPrice) froze at the entry fill
  // price forever. Normalize both sides to the base asset before comparing.
  function priceFor(symbol: string): number | undefined {
    const base = toBaseAsset(symbol);
    if (typeof lastPrices[base] === 'number') return lastPrices[base];
    const c = cryptoData.find((x) => toBaseAsset(x.symbol) === base);
    return c?.current_price;
  }

  function buildM5CandlesForSymbol(symbol: string): Candle[] {
    const snap = liveCandles[toBaseAsset(symbol)];
    return snap && snap.m5 && snap.m5.length ? snap.m5 : [];
  }

  function buildH1CandlesForSymbol(symbol: string): Candle[] {
    const snap = liveCandles[toBaseAsset(symbol)];
    return snap && snap.h1 && snap.h1.length >= strategy.minCandlesForH1View ? snap.h1 : [];
  }

  function positionsValue(): number {
    return positions.reduce((sum, p) => {
      const live = priceFor(p.symbol) ?? p.currentPrice;
      if (p.type === 'SPOT') return sum + p.quantity * live;
      // Futures PnL: quantity already includes leverage (quantity = budget * leverage / fillPrice),
      // so we must NOT multiply by leverage again — doing so overstates PnL by leverage times.
      const pnl = p.side === 'LONG'
        ? (live - p.entryPrice) * p.quantity
        : (p.entryPrice - live) * p.quantity;
      // Report mark-to-market value honestly: margin + PnL. An underwater
      // futures position must show a negative contribution so drawdown and
      // circuit-breaker logic see the true equity — clamping to 0 here masked
      // that damage and let those safety nets miss a real loss.
      const value = p.marginUsd + pnl;
      return sum + value;
    }, 0);
  }

  function equity(): number {
    return cash + positionsValue();
  }

  function drawdowns(eq: number): { dailyDrawdownPercent: number; weeklyDrawdownPercent: number } {
    const now = Date.now();
    const oneDay = now - 24 * 60 * 60 * 1000;
    const oneWeek = now - 7 * 24 * 60 * 60 * 1000;
    // Start from initialAmount, not current equity — drawdown against starting
    // capital, so a run that opened at 10k, peaked at 10.5k, and sits at 10.1k
    // shows 0% drawdown (above the waterline). This is the correct semantics for
    // a circuit breaker (protection against losses, not against winning moves
    // that briefly retrace).
    let peakDay = initialAmount;
    let peakWeek = initialAmount;
    // Use hourlyHistory for longer time windows (up to 30 days) — history only
    // covers ~48 minutes (720 points × 4s), which is insufficient for daily/weekly
    // drawdown calculation. Without this, circuit breakers only react to drawdowns
    // occurring within the last hour.
    const dayPoints = hourlyHistory.filter((pt) => pt.at >= oneDay);
    const weekPoints = hourlyHistory.filter((pt) => pt.at >= oneWeek);
    for (const pt of dayPoints) {
      if (pt.portfolio > peakDay) peakDay = pt.portfolio;
    }
    for (const pt of weekPoints) {
      if (pt.portfolio > peakWeek) peakWeek = pt.portfolio;
    }
    // Also check the most recent tick history for intra-hour precision
    for (const pt of history) {
      if (pt.at >= oneDay && pt.portfolio > peakDay) peakDay = pt.portfolio;
      if (pt.at >= oneWeek && pt.portfolio > peakWeek) peakWeek = pt.portfolio;
    }
    const daily = peakDay > 0 ? Math.max(0, ((peakDay - eq) / peakDay) * 100) : 0;
    const weekly = peakWeek > 0 ? Math.max(0, ((peakWeek - eq) / peakWeek) * 100) : 0;
    return {
      dailyDrawdownPercent: Number(daily.toFixed(2)),
      weeklyDrawdownPercent: Number(weekly.toFixed(2))
    };
  }

  function leveragedExposure(): number {
    return positions.reduce((sum, p) => {
      const live = priceFor(p.symbol) ?? p.currentPrice;
      // quantity already includes leverage for Futures, so notional = quantity * live
      if (p.type === 'FUTURES') return sum + p.quantity * live;
      return sum;
    }, 0);
  }

  // Bulk Spot Ticker Sync — one call for every symbol this bot trades
  // (`getSymbols()`, the bot's own configured universe: portfolio + candidate
  // watchlist), not one call per symbol. `force` bypasses CRYPTO_REFRESH_MS
  // for the Live Freshness Guarantee below; the normal per-tick path still
  // gates on it so a healthy run makes exactly one aggregator call per tick,
  // and the aggregator's own BYBIT_TICKER_TTL (2.5s) dedupes the ACTUAL
  // exchange request across all four bots regardless of how often any one of
  // them asks.
  async function refreshCryptoPrices(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - cryptoRefreshAt <= CRYPTO_REFRESH_MS && cryptoData.length > 0) return;
    try {
      // Use multi-source aggregator: Bybit → Binance → CoinGecko (rate-gated).
      // Restrict to the SAME curated liquid universe the real bot trades —
      // without this filter, getAggregatedPrices() returns EVERY Bybit USDT
      // pair (400+), and refreshCandles() below then has to fetch 1H/15M/5M
      // klines for all of them every cycle. That starves the pipeline under
      // rate limits so only a handful of symbols ever reach READY status,
      // meaning most SIGNAL evaluations never get a chance to actually fill.
      const data = await getAggregatedPrices(getSymbols?.());
      if (data && data.length) {
        cryptoData = data;
        cryptoRefreshAt = Date.now();
        for (const c of data) lastPrices[toBaseAsset(c.symbol)] = c.current_price;
      }
    } catch {
      /* keep last-known-good prices */
    }
  }

  async function refreshMarketData() {
    const now = Date.now();
    await refreshCryptoPrices();
    // Candle refresh is NON-BLOCKING: the tick must return a snapshot immediately
    // (so the bot shows as running and history grows) even before candles load.
    // Candles fill in the background; trading begins once they are available.
    if ((now - candleRefreshAt > CANDLE_REFRESH_MS || Object.keys(liveCandles).length === 0) && !candleRefreshing) {
      candleRefreshing = true;
      refreshCandles()
        .catch(() => {})
        .finally(() => {
          candleRefreshing = false;
          candleRefreshAt = Date.now();
        });
    }
  }

  async function refreshCandles() {
    if (!cryptoData.length) return;
    const symbols = cryptoData.map((c) => c.symbol.toUpperCase());
    try {
      const { snapshots } = await getUniverseMarketData(symbols, { log: strategy.logCandleFetch });
      const next: Record<string, MultiTimeframeSnapshot> = {};
      // getUniverseMarketData keys its Map by the SUFFIXED symbol (snap.symbol,
      // e.g. "LITUSDT"); liveCandles is looked up elsewhere with the bare ticker
      // symbol from cryptoData ("LIT"). Normalize to base-asset form here so
      // every reader/writer of liveCandles agrees on one key format.
      for (const [sym, snap] of snapshots) next[toBaseAsset(sym)] = snap;
      liveCandles = next;
    } catch {
      /* keep last-known-good MTF data on failure */
    }
  }

  // TICK_MS is the interval the worker POLLS on, not the cadence snapshots
  // actually land at: a tick whose market-data refresh takes ~16s makes the
  // caller's `tickInProgress` guard skip several intervals, so snapshots
  // arrive ~20s apart. Advertising `now + TICK_MS` therefore promised a tick
  // in 2.5s that took 20s, and the client's countdown sat pinned at its floor
  // for the remaining time — which reads as a frozen page. Measure the real
  // thing.
  let lastTickDurationMs = 0;

  // Confidence floor this engine is gating on right now — config override when
  // one is set, the strategy's own default otherwise.
  let activeMinConfidence = strategy.minConfidence;

  // Last-seen config, retained so hydrate() can validate on server restart.
  let lastConfig: SimBotConfig | null = null;

  function validateConfig(config: SimBotConfig): void {
    validateExposureModel({
      maxPositions: config.maxPositions ?? SIM_BASE_DEFAULTS.maxPositions,
      positionTargetPct: POSITION_TARGET_PCT,
      totalExposureCapPct: MAX_TOTAL_EXPOSURE_PERCENT / 100
    });
  }

  async function tick(config: SimBotConfig, fearGreed = 50) {
    lastConfig = config;
    validateConfig(config);
    const tickStartedAt = Date.now();
    activeMinConfidence = typeof config.minConfidenceOverride === 'number' && config.minConfidenceOverride > 0
      ? config.minConfidenceOverride
      : strategy.minConfidence;
    // initialAmount is the capital THIS RUN opened with, so it moves only on
    // reset — never from the live config. Reassigning it every tick meant that
    // editing the capital field mid-run repointed the P&L denominator while
    // `cash` kept the old balance: a bot holding $10,000 against a freshly
    // typed $1,000 reported +$9,000 (+900%) and went on trading the old
    // balance. Changing the capital of a run in progress is not a thing that
    // can be done retroactively, so the config endpoints reset the run instead.
    if ((cash === 0 || !Number.isFinite(cash)) && positions.length === 0 && trades.length === 0) {
      initialAmount = config.initialAmount || 10000;
      cash = initialAmount;
    }
    await refreshMarketData();
    for (const c of cryptoData) lastPrices[toBaseAsset(c.symbol)] = c.current_price;

    // Live Freshness Guarantee: nothing below this point — mark-to-market,
    // stop-loss, take-profit, or the profit ratchet — may run against a price
    // older than LIVE_PRICE_FRESHNESS_MS (3s). refreshMarketData() above
    // already refreshes every tick under normal conditions; this is what
    // fires when it didn't (a slow tick — candle refresh, GC pause — or the
    // fetch inside it failed and fell through to "keep last-known-good"). A
    // forced call here bypasses CRYPTO_REFRESH_MS entirely and blocks this
    // tick's exit evaluation on a genuinely fresh bulk fetch rather than
    // computing SL/ratchet against however old `lastPrices` happens to be.
    if (needsForcedPriceRefresh(cryptoRefreshAt, Date.now(), positions.length > 0)) {
      await refreshCryptoPrices(true);
    }

    // Perpetual funding — one request for the whole universe, cached 30 min.
    // Never throws: returns an empty map on any failure.
    const fundingBySymbol = await fetchFundingRates();

    // Mark-to-market live price updates on each tick for open positions
    positions = positions.map((p) => {
      const live = priceFor(p.symbol) ?? p.currentPrice;
      return {
        ...p,
        currentPrice: live,
        highestPrice: Math.max(p.highestPrice || p.entryPrice, live),
        lowestPrice: Math.min(p.lowestPrice || p.entryPrice, live),
        highestPriceSinceTP1: p.tp1Hit ? Math.max(p.highestPriceSinceTP1 || live, live) : undefined,
        lowestPriceSinceTP1: p.tp1Hit ? Math.min(p.lowestPriceSinceTP1 || live, live) : undefined
      };
    });

    // Perpetual funding on open FUTURES positions — applied before equity is
    // read so drawdown / circuit-breaker see the funding-adjusted balance. The
    // same helper runs for every bot; spot-only bots have no futures leg and
    // stay at totalFunding = 0.
    if (!lastFundingAppliedAt) lastFundingAppliedAt = Date.now();
    const funding = applyFundingAccrual(positions, cash, fundingBySymbol, lastFundingAppliedAt, Date.now());
    if (funding.fundingPaid !== 0) {
      cash = funding.cash;
      totalFunding += funding.fundingPaid;
    }
    lastFundingAppliedAt = funding.lastAppliedAt;

    const eq = equity();
    const { dailyDrawdownPercent, weeklyDrawdownPercent } = drawdowns(eq);
    const totalLeveragedExposureUsd = leveragedExposure();

    // Closed-trade history drives adaptive sizing and the losing-streak
    // cooldown; `at` is what orders it (trades are kept newest-first).
    // `symbol` is the base asset — used for per-symbol cooldown tracking.
    const closedTrades = trades
      .filter((t) => typeof t.pnl === 'number')
      .map((t) => ({ pnl: t.pnl ?? 0, at: t.at, symbol: t.symbol, riskUsd: t.riskUsd }));
    const closedTradeMetrics = trades
      .filter((t) => typeof t.pnl === 'number')
      .map((t) => ({ pnl: t.pnl ?? 0, pnlPercent: t.pnlPercent ?? 0, at: t.at, symbol: t.symbol, riskUsd: t.riskUsd }));

    const candlesBySymbol: Record<string, Candle[]> = {};
    for (const key of Object.keys(liveCandles)) candlesBySymbol[key] = buildH1CandlesForSymbol(key);

    const correlationCandles: Record<string, Candle[] | undefined> = {};
    for (const key of Object.keys(liveCandles)) correlationCandles[key] = liveCandles[key]?.h1;

    const input: StrategyTickInput = {
      cryptoData,
      liveCandles,
      candlesBySymbol,
      buildCandlesForSymbol: buildM5CandlesForSymbol,
      correlationCandles,
      positions,
      pending,
      config,
      equity: eq,
      initialAmount,
      dailyDrawdownPercent,
      weeklyDrawdownPercent,
      totalLeveragedExposureUsd,
      closedTrades,
      closedTradeMetrics,
      fearGreedIndex: fearGreed,
      fundingBySymbol,
      cash,
      exitCooldown,
      priceFor,
      toBase: (s: string) => toBaseAsset(s),
      computeAtr5,
       maxPositions: config.maxPositions ?? 2, // 2 × 10% = 20% = totalExposureCap
      maxFuturesPositions: config.maxFuturesPositions || 2
    };

    const evaluations = strategy.buildEvaluations(input);
    lastEvaluations = evaluations;
    const we = evaluations.filter((r) => r.willExecute).length;
    console.log(`${strategy.logPrefix} evals=${evaluations.length} willExecute=${we} pending=${pending.length} pos=${positions.length} cash=${cash.toFixed(2)}`);

    // Publish this bot's currently open symbols BEFORE asking it for new
    // entries, so the cross-bot check below sees this tick's true starting
    // state — not last tick's, and not polluted by orders this tick is about
    // to place. See crossBotExposure.ts.
    registerBotHoldings(strategy.id, positions.map((p) => p.symbol));

    const generatedOrders = strategy.generateOrders(input, evaluations);
    // Cross-bot symbol concentration cap (2026-09-15): every one of the four
    // sim bots independently approved a 10%-of-equity LA position on
    // 2026-09-15 — three bots, one symbol, a combined bet the per-bot risk
    // model never saw as single. `generateOrders` returns entries only (exits
    // are handled elsewhere, in fillDueOrders/evaluatePositionExit), so every
    // order here is a NEW position candidate and safe to gate on.
    const newOrders = generatedOrders.filter((o) => {
      if (!wouldExceedCrossBotCap(o.symbol, strategy.id)) return true;
      const holders = otherBotsHolding(o.symbol, strategy.id);
      console.log(`${strategy.logPrefix} cross-bot cap — ${o.symbol} already held by ${holders.join(', ')}, skipping new entry`);
      return false;
    });
    // Slot preemption: an evaluation that claimed a full slot by evicting the
    // weakest resting entry carries its id — cancel that incumbent, but only now
    // that its replacement actually placed (a downstream budget refusal leaves
    // the incumbent alone).
    const placedSymbols = new Set(newOrders.map((o) => o.symbol));
    const preempt = applySlotPreemptions(pending, evaluations, placedSymbols);
    if (preempt.cancelledIds.length) {
      pending = preempt.pending;
      for (const id of preempt.cancelledIds) console.log(`${strategy.logPrefix} slot preempted — cancelled resting entry ${id}`);
    }
    if (newOrders.length) pending = [...pending, ...newOrders];

    const { due, expired } = selectFillableOrders(pending, Date.now(), priceFor);
    if (expired.length) {
      const expiredIds = new Set(expired.map((o) => o.id));
      pending = pending.filter((o) => !expiredIds.has(o.id));
      for (const o of expired) console.log(`${strategy.logPrefix} limit order expired unfilled: ${o.symbol} @ ${o.signalPrice}`);
    }
    if (due.length) {
      const result = fillDueOrders(due, cash, positions, priceFor, formatDynamicPrice, {
        feePercent: config.feePercent,
        slippagePercent: config.slippagePercent,
        equity: eq,
        // The fill-time exposure caps must read the same base the order was
        // sized against, or a fill-time recheck against shrinking equity would
        // reject orders the generator legitimately approved.
        initialAmount: config.initialAmount
      });
      const dueIds = new Set(due.map((o) => o.id));
      pending = pending.filter((o) => !dueIds.has(o.id));
      if (result.newTrades.length) {
        cash = result.cash;
        positions = result.positions;
        trades = [...result.newTrades.reverse(), ...trades].slice(0, 100);
        totalFees += result.feesAdded;
        totalSlippageCost += result.slipAdded;
        Object.assign(exitCooldown, result.newCooldowns);
        // Overall bot status, computed AFTER applying this fill — appended
        // only to exit/partial-exit messages (not entries), per the ask that
        // a "position finished" notification show where the bot stands
        // overall, not just the one trade.
        const totalEq = equity();
        const totalPnl = totalEq - initialAmount;
        const totalPnlPercent = initialAmount > 0 ? (totalPnl / initialAmount) * 100 : 0;
        const statusFooter =
          `\n\n📊 ${strategy.statusFooterLabel}\n` +
          `שווי נוכחי: $${totalEq.toFixed(2)}\n` +
          `רווח/הפסד כולל: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)} (${totalPnlPercent >= 0 ? '+' : ''}${totalPnlPercent.toFixed(2)}%)\n` +
          `פוזיציות פתוחות: ${positions.length}`;
        // Only notify on close — the exit text already carries entry price,
        // exit price and P&L (see fillDueOrders in simExecution.ts), so a
        // single message on close already has the full picture. An entry-
        // time message is deliberately no longer sent.
        for (const ev of result.events) {
          if (ev.kind === 'entry') continue;
          void sendSimTelegramMessage(strategy.telegramTag, `${strategy.telegramTitle}\n\n${ev.text}${statusFooter}`);
        }
      }
    }

    const now = Date.now();
    // Explicit timeZone: this runs on the server (Render defaults to UTC),
    // not in the user's browser — see the same fix in simExecution.ts.
    const timeStr = new Date(now).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' });
    history = [...history, { timestamp: timeStr, at: now, portfolio: equity() }].slice(-720);
    const lastHourPt = hourlyHistory[hourlyHistory.length - 1];
    const lastHour = lastHourPt ? Math.floor(lastHourPt.at / (60 * 60 * 1000)) : -1;
    const currentHour = Math.floor(now / (60 * 60 * 1000));
    if (currentHour > lastHour) {
      hourlyHistory = [...hourlyHistory, { timestamp: timeStr, at: now, portfolio: equity() }].slice(-720);
    }

    lastEvaluation = new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' });
    lastTickDurationMs = Date.now() - tickStartedAt;
    return getSnapshot();
  }

  function getSnapshot() {
    const eq = equity();
    const { dailyDrawdownPercent, weeklyDrawdownPercent } = drawdowns(eq);
    const closedTrades = trades.filter((t) => typeof t.pnl === 'number');
    const wins = closedTrades.filter((t) => (t.pnl ?? 0) > 0).length;
    const winRate = closedTrades.length ? (wins / closedTrades.length) * 100 : 0;
    return {
      runId: runId ?? `run-${Date.now()}`,
      cash,
      initialAmount,
      positions,
      positionsValue: positionsValue(),
      equity: eq,
      trades,
      history,
      hourlyHistory,
      pending,
      totalFees,
      totalSlippageCost,
      totalFunding,
      lastFundingAppliedAt,
      winRate,
      totalTrades: trades.length,
      closedTrades: closedTrades.length,
      lastEvaluation,
      evaluations: lastEvaluations.map((e) => ({
        symbol: e.symbol,
        action: e.action,
        tradeType: e.tradeType,
        tradeSide: e.tradeSide,
        confidence: e.confidence,
        price: e.price,
        priceChange24h: e.priceChange24h,
        reasoning: e.reasoning,
        status: e.status,
        willExecute: e.willExecute,
        factors: e.factors,
        regime: e.regime,
        leverage: e.leverage,
        stopLoss: e.stopLoss,
        takeProfit1: e.takeProfit1,
        takeProfit2: e.takeProfit2,
        takeProfit: e.takeProfit
      })),
      // The threshold ACTUALLY in force, not the strategy's compiled-in default.
      // These are two different numbers whenever an operator sets
      // minConfidenceOverride (or BOT_MIN_CONFIDENCE), and the panel was
      // showing the one the engine does not gate on.
      minConfidence: activeMinConfidence,
      hasSavedSession: trades.length > 0 || positions.length > 0,
      // The next snapshot lands at most one poll interval from now, plus however
      // long the tick itself takes — measured, not assumed. See lastTickDurationMs.
      nextTickAt: Date.now() + TICK_MS + lastTickDurationMs,
      totalLeveragedExposureUsd: leveragedExposure(),
      dailyDrawdownPercent,
      weeklyDrawdownPercent,
      candleCount: Object.keys(liveCandles).length
    };
  }

  function hydrate(snapshot: SimSnapshot) {
    if (!snapshot || typeof snapshot.cash !== 'number') return;
    if (lastConfig) validateConfig(lastConfig);
    cash = snapshot.cash;
    positions = snapshot.positions ?? [];
    trades = snapshot.trades ?? [];
    history = snapshot.history ?? [];
    hourlyHistory = snapshot.hourlyHistory ?? [];
    pending = snapshot.pending ?? [];
    totalFees = snapshot.totalFees ?? 0;
    totalSlippageCost = snapshot.totalSlippageCost ?? 0;
    totalFunding = snapshot.totalFunding ?? 0;
    lastFundingAppliedAt = 0;
    lastEvaluation = snapshot.lastEvaluation ?? '';
    initialAmount = snapshot.initialAmount || snapshot.cash || 10000;
    // Restore the run's identity so the new snapshot carries the same runId
    // until the next reset (§9/#4).
    runId = snapshot.runId ?? null;
  }

  function reset(config: SimBotConfig): ArchivedRun | null {
    lastConfig = config;
    validateConfig(config);
    // §9/#4: Archive the run before wiping state. We capture mark-to-market
    // positions and a snapshot of the final equity so the archive reflects the
    // actual economic position, not the stale cash figure. The worker persists
    // the returned object to the archive KV store (Firestore) so a plain
    // "Reset All Bots" keeps the history for BacktestResults; only a
    // "Clear Cache + Server" wipe deletes it.
    let archived: ArchivedRun | null = null;
    if (positions.length > 0 || trades.length > 0) {
      const finalEquity = equity();
      archived = {
        runId: runId ?? `run-${Date.now()}`,
        initialAmount,
        finalEquity,
        totalPnl: finalEquity - initialAmount,
        totalPnlPercent: initialAmount > 0 ? ((finalEquity - initialAmount) / initialAmount) * 100 : 0,
        finalCash: cash,
        trades: [...trades],
        openPositions: positions.map((p) => ({
          symbol: p.symbol,
          type: p.type,
          side: p.side,
          quantity: p.quantity,
          entryPrice: p.entryPrice,
          mark: priceFor(p.symbol) ?? p.currentPrice,
          pnl: p.type === 'SPOT'
            ? ((priceFor(p.symbol) ?? p.currentPrice) - p.entryPrice) * p.quantity
            : p.side === 'LONG'
            ? ((priceFor(p.symbol) ?? p.currentPrice) - p.entryPrice) * p.quantity * (p.leverage || 1)
            : (p.entryPrice - (priceFor(p.symbol) ?? p.currentPrice)) * p.quantity * (p.leverage || 1),
          reason: p.reason
        })),
        tradeCount: trades.length,
        feeTotal: totalFees,
        slippageTotal: totalSlippageCost,
        fundingTotal: totalFunding,
        startedAt: history[0]?.at,
        archivedAt: Date.now()
      };
      console.log(`[archive] run ${archived.runId} | equity $${archived.finalEquity.toFixed(2)} | P&L ${archived.totalPnl >= 0 ? '+' : ''}${archived.totalPnl.toFixed(2)} (${archived.totalPnlPercent >= 0 ? '+' : ''}${archived.totalPnlPercent.toFixed(2)}%) | ${archived.tradeCount} trades`);
    }

    cash = config.initialAmount;
    initialAmount = config.initialAmount;
    // Start a fresh run — new runId so the snapshot marks this as a different session.
    runId = `run-${Date.now()}`;
    positions = [];
    trades = [];
    history = [];
    hourlyHistory = [];
    pending = [];
    totalFees = 0;
    totalSlippageCost = 0;
    totalFunding = 0;
    lastFundingAppliedAt = 0;
    lastEvaluation = '';
    lastEvaluations = [];
    return archived;
  }

  /** The capital the current run opened with — lets a caller detect that a
   *  config edit changed it and reset the run rather than corrupt its P&L. */
  function getInitialAmount() {
    return initialAmount;
  }

  return { tick, getSnapshot, hydrate, reset, getInitialAmount };
}

