/**
 * Replay runner — historical backtesting through the REAL execution engine.
 * ============================================================================
 * `backtestRunner.ts` is a second, thinner implementation of the trading loop:
 * it fills at bar close with no execution delay, charges taker fees on both
 * legs regardless of fill mode, applies slippage as a cash cost on the entry
 * only, never rests a limit order, never applies funding, has no liquidity
 * model — and supports exactly ONE of the four bots (`EngineType = 'intraday'`).
 *
 * This driver takes the opposite approach: it feeds stored OHLCV into the SAME
 * `tick()` every live sim bot runs, via the injectable `SimEngineDeps` added
 * for this purpose. Everything the live loop models — maker/taker fees, the
 * random slippage band applied to the PRICE, `executionDelaySec`, the pending
 * queue, resting limits with TTL and the adverse-selection cancel, partial
 * ratchet fills, funding accrual, the exposure caps, the cross-bot symbol cap —
 * is inherited rather than reimplemented, and all four bots work by
 * construction because the driver never mentions any of them by name.
 *
 * WHAT A REPLAY CANNOT REPRODUCE, stated rather than hidden:
 *   · derivatives (Open Interest / long-short ratio) — the exchange endpoints
 *     only serve ~200 rows (≈8 days), so the MACRO gate and the sell-pressure
 *     check ABSTAIN throughout a historical run. They are designed to abstain
 *     on missing data (see derivativesRegime.ts), so this degrades fidelity,
 *     it does not break the run.
 *   · funding — supply it via `fundingBySymbol` if you have a history; absent,
 *     the funding gate abstains and FUTURES positions accrue no funding.
 *   · spread / 24h quote volume — not in the kline data, so the liquidity and
 *     spread gates see zero and skip.
 *
 * Determinism: the only nondeterminism in the live path is the slippage draw
 * (`simulateSlippage` uses Math.random). Pass `slippagePercent: 0` in the
 * config, or accept that two runs differ by the slippage band.
 */
import type { Candle } from '@cde/engine';
import type { CryptoData } from '@cde/engine';
import type { MultiTimeframeSnapshot } from '@cde/engine/market-data';
import type { FundingSnapshot, DerivativesSnapshot } from '@cde/engine/analysis';
import type { SimBotConfig, SimTrade } from '@cde/engine/execution';
import { createGenericSimEngine, type SimEngineStrategy } from './simEngineFactory';

/** The rich snapshot `tick()` actually returns (equity, positionsValue and the
 *  telemetry the UI reads) — a superset of the persisted `SimSnapshot`. */
type TickSnapshot = Awaited<ReturnType<ReturnType<typeof createGenericSimEngine>['tick']>>;

/** One symbol's stored history. `m5` is the replay clock — the engine's own
 *  decision cadence — so it is required; `h1`/`m15` are what the multi-
 *  timeframe bots need on top. */
export interface ReplaySymbolHistory {
  /** Suffixed symbol, e.g. "BTCUSDT" — the same shape the live feed uses. */
  symbol: string;
  h1: Candle[];
  m15: Candle[];
  m5: Candle[];
}

export interface ReplayOptions {
  histories: ReplaySymbolHistory[];
  config: SimBotConfig;
  /** Bars of M5 history to warm up before the first decision. The intraday
   *  engine's own NO_DATA gate needs 500 M5 / 300 M15 / 200 H1, so anything
   *  below that simply produces no trades for that bot. */
  warmupBars?: number;
  /** Optional funding history, keyed by uppercase symbol, resolved per step.
   *  Absent → the funding gate abstains and no funding accrues. */
  fundingAt?: (symbol: string, at: number) => FundingSnapshot | undefined;
  /** Optional derivatives history. Absent → the MACRO gate abstains. */
  derivativesAt?: (symbol: string, at: number) => DerivativesSnapshot | undefined;
  /** Fear & Greed for the step, if the strategy reads it. Default 50. */
  fearGreedAt?: (at: number) => number;
  /** Called after every step — progress reporting for a long run. */
  onStep?: (step: number, total: number, at: number) => void;
}

export interface ReplayResult {
  /** The engine's own final snapshot — same shape the live bots persist. */
  snapshot: TickSnapshot;
  trades: SimTrade[];
  startedAt: number;
  endedAt: number;
  steps: number;
  finalEquity: number;
  initialAmount: number;
  totalPnl: number;
  totalPnlPercent: number;
}

const toBase = (symbol: string): string => symbol.replace(/USDT$|USDC$|BUSD$/i, '').toUpperCase();

/** Bars that had CLOSED at or before `at`. The replay's entire look-ahead
 *  guarantee rests on this one function: a bar whose close timestamp is in the
 *  future has not happened yet and must never be visible. */
function closedBy(bars: Candle[], at: number): Candle[] {
  // Bars are ascending; walk back from the end rather than filtering the whole
  // series on every step of a multi-month run.
  let hi = bars.length;
  while (hi > 0 && bars[hi - 1].timestamp > at) hi--;
  return hi === bars.length ? bars : bars.slice(0, hi);
}

/** Builds the MultiTimeframeSnapshot shape the bots read, from stored candles
 *  as of `at`. Fields the live feed fills from the ticker (liquidity, spread)
 *  are null/zero — see the fidelity note at the top of this file. */
function snapshotAt(history: ReplaySymbolHistory, at: number): MultiTimeframeSnapshot | null {
  const h1 = closedBy(history.h1, at);
  const m15 = closedBy(history.m15, at);
  const m5 = closedBy(history.m5, at);
  if (!m5.length) return null;
  const last = m5[m5.length - 1];
  const counts = { '1h': h1.length, '15m': m15.length, '5m': m5.length } as MultiTimeframeSnapshot['counts'];
  const blank = <T,>(v: T) => ({ '1h': v, '15m': v, '5m': v }) as Record<keyof typeof counts, T>;
  return {
    symbol: history.symbol,
    base: toBase(history.symbol),
    // The per-bot minimum-bar gates do their own checking; marking every
    // snapshot READY lets each bot apply its OWN thresholds rather than having
    // the driver guess which ones matter to it.
    status: 'READY',
    h1,
    m15,
    m5,
    counts,
    // 'cache' is the honest label: these bars came from stored history, which
    // is exactly what that source means to every reader of this field.
    sources: blank('cache' as const) as MultiTimeframeSnapshot['sources'],
    reasons: blank(''),
    telemetry: blank({ received: 0, closed: 0, valid: 0, required: 0, source: 'cache' as const }) as MultiTimeframeSnapshot['telemetry'],
    lastClosedAt: last.timestamp,
    liquidity: null,
    livePrice: last.close,
    issues: [],
    fetchedAt: at
  };
}

/**
 * Replays `histories` through one bot's real engine.
 *
 * The clock steps bar by bar over the merged M5 timeline; at each step the
 * engine sees exactly the candles that had closed by then, and its own
 * `tick()` does the rest — evaluation, order generation, the pending queue,
 * fills, funding, mark-to-market.
 */
export async function runReplay(
  strategy: SimEngineStrategy,
  options: ReplayOptions
): Promise<ReplayResult> {
  const { histories, config } = options;
  if (!histories.length) throw new Error('runReplay: no histories supplied');
  for (const h of histories) {
    if (!h.m5?.length) throw new Error(`runReplay: ${h.symbol} has no M5 series — it is the replay clock`);
  }

  // One merged, de-duplicated, ascending timeline of M5 closes.
  const timeline = [...new Set(histories.flatMap((h) => h.m5.map((c) => c.timestamp)))].sort((a, b) => a - b);
  const warmup = Math.max(0, options.warmupBars ?? 500);
  const steps = timeline.slice(warmup);
  if (!steps.length) {
    throw new Error(
      `runReplay: warmup of ${warmup} bars consumes the whole ${timeline.length}-bar timeline — supply more history`
    );
  }

  // The synthetic clock. Everything inside the engine — order timestamps,
  // TTLs, cooldowns, time stops, funding accrual — reads this.
  let now = steps[0];

  const bySymbol = new Map(histories.map((h) => [h.symbol.toUpperCase(), h]));

  const engine = createGenericSimEngine(
    strategy,
    () => histories.map((h) => h.symbol),
    {
      now: () => now,
      getPrices: async () => {
        const out: CryptoData[] = [];
        for (const h of histories) {
          const bars = closedBy(h.m5, now);
          if (!bars.length) continue;
          const last = bars[bars.length - 1];
          // 24h change from the bar 288 five-minute bars back, when available.
          const dayAgo = bars[Math.max(0, bars.length - 289)];
          const change = dayAgo && dayAgo.close > 0 ? ((last.close - dayAgo.close) / dayAgo.close) * 100 : 0;
          out.push({
            id: toBase(h.symbol).toLowerCase(),
            symbol: toBase(h.symbol).toLowerCase(),
            name: h.symbol,
            current_price: last.close,
            price_change_percentage_24h: change,
            total_volume: bars.slice(-288).reduce((s, c) => s + (c.volume || 0) * c.close, 0),
            market_cap: 0,
            last_updated: new Date(now).toISOString()
          } as CryptoData);
        }
        return out;
      },
      getCandles: async () => {
        const snapshots = new Map<string, MultiTimeframeSnapshot>();
        for (const h of histories) {
          const snap = snapshotAt(h, now);
          if (snap) snapshots.set(h.symbol, snap);
        }
        return { snapshots };
      },
      getFunding: async () => {
        const map = new Map<string, FundingSnapshot>();
        if (!options.fundingAt) return map;
        for (const symbol of bySymbol.keys()) {
          const snap = options.fundingAt(symbol, now);
          if (snap) map.set(symbol, snap);
        }
        return map;
      },
      verbose: false,
      getDerivatives: async () => {
        const map = new Map<string, DerivativesSnapshot>();
        if (!options.derivativesAt) return map;
        for (const symbol of bySymbol.keys()) {
          const snap = options.derivativesAt(symbol, now);
          if (snap) map.set(symbol, snap);
        }
        return map;
      }
    }
  );

  engine.hydrate({
    runId: `replay-${steps[0]}`,
    cash: config.initialAmount,
    initialAmount: config.initialAmount,
    positions: [],
    trades: [],
    history: [],
    hourlyHistory: [],
    pending: []
  } as never);

  let snapshot: TickSnapshot | undefined;
  for (let i = 0; i < steps.length; i++) {
    now = steps[i];
    snapshot = await engine.tick(config, options.fearGreedAt?.(now) ?? 50);
    options.onStep?.(i + 1, steps.length, now);
  }

  const finalEquity = snapshot?.equity ?? config.initialAmount;
  const initialAmount = config.initialAmount;
  const totalPnl = finalEquity - initialAmount;

  return {
    snapshot: snapshot as TickSnapshot,
    trades: snapshot?.trades ?? [],
    startedAt: steps[0],
    endedAt: steps[steps.length - 1],
    steps: steps.length,
    finalEquity,
    initialAmount,
    totalPnl,
    totalPnlPercent: initialAmount > 0 ? (totalPnl / initialAmount) * 100 : 0
  };
}
