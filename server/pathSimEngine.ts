// Server-side simulation engine for the 4H PATH algorithm — the fourth bot.
//
// What makes it different from the other three: it does not score charts. It
// carries a lookup table of measured intra-bar outcomes and trades only the
// 15-minute slot that table nominates for the state the current 4H bar opened
// in. Everything downstream — fills, fees, slippage, exits, the position cap —
// is the shared machinery, so a difference in results is a difference in
// decisions.
//
// The table is rebuilt from the universe's own candle history on a fixed
// interval (see TABLE_REBUILD_MS). That makes the bot self-contained and honest
// about what it knows: with no table, or a table where no bucket clears its
// bar, it abstains rather than guesses.
//
// One limitation stated plainly: a table built from the history currently in
// memory is IN-SAMPLE. It is enough to run the bot and to see whether the shape
// of the edge is stable; it is not enough to conclude the edge is real. That is
// what scripts/pathStudy.ts is for — a walk-forward build over cached history,
// whose output can be loaded here in place of the live one.

import {
  createGenericSimEngine,
  SimEngineStrategy,
  StrategyTickInput,
  SimSnapshot
} from './simEngineFactory';
import { SIM_MIN_CONFIDENCE } from '@cde/engine/execution';
import { generatePathOrders, MIN_PATH_CANDLES, PATH_MIN_H4_BARS } from '@cde/engine/execution';
import type { SignalEvaluation, DecisionFactor, Candle } from '@cde/engine';
import {
  aggregateToH4,
  evaluatePathDecision,
  buildPathTable,
  measureBarPaths,
  labelBarState,
  riskUnitFrom15M,
  prior15mFor,
  barOpenFor,
  SLOTS_PER_BAR,
  PathBucket,
  PathOutcome,
  PathDecision
} from '@cde/engine/analysis';

export type { SimPosition, SimTrade, SimPoint, PendingOrder, SimBotConfig } from '@cde/engine/execution';
export type PathSimSnapshot = SimSnapshot;

/** How often the lookup table is rebuilt from the candle history in memory.
 *  The inputs only change as new 4H bars close, so anything more frequent is
 *  recomputation for its own sake. */
const TABLE_REBUILD_MS = 30 * 60_000;

/** Sample floor for the live table. Deliberately below pathStudy's 200: the
 *  window available in memory is shorter than an offline study's, and the
 *  Wilson lower bound already charges a thin bucket for being thin. Raise it,
 *  do not lower it, if the bot proves noisy. */
const LIVE_MIN_SAMPLES = 120;

/** A bucket must clear this expectancy, in R and net of costs, to be traded. */
const MIN_EXPECTED_R = 0.05;

let pathTable: PathBucket[] = [];
let tableBuiltAt = 0;
let tableSourceBars = 0;
/** Symbols the last rebuild skipped for want of history, and how many it saw. */
let lastSkippedForHistory = 0;
let lastSymbolsSeen = 0;
/** Where the table in memory came from. The two are not interchangeable and the
 *  difference decides how much the bot's results are worth. */
let tableSource: 'validated' | 'live-in-sample' | 'none' = 'none';
let validatedMeta: { builtAt?: string; snapshotFrom?: string; snapshotTo?: string; survivors?: number } | null = null;

export function getPathTable(): PathBucket[] {
  return pathTable;
}

/** The serialised form scripts/pathStudy.ts publishes. */
export interface ValidatedPathTable {
  builtAt?: string;
  snapshotFrom?: string;
  snapshotTo?: string;
  survivors?: number;
  table?: PathBucket[];
}

/**
 * Installs the walk-forward table produced by scripts/pathStudy.ts.
 *
 * This is the table the bot SHOULD trade: every bucket in it held a positive
 * expectancy on periods it was not built from, across several disjoint windows.
 * The runtime rebuild below is the fallback, and it is in-sample — good enough
 * to exercise the machinery, not good enough to believe.
 *
 * The worker calls this at boot with whatever it read from durable storage. It
 * used to read a local file itself, from a path inside a gitignored directory,
 * which meant the file never existed on the server: the bot fell through to the
 * in-sample rebuild on every deploy and nothing in the logs or the UI
 * distinguished that from "a validated table was loaded". Durable state belongs
 * in the KV store with the rest of it.
 */
export function installValidatedTable(parsed: ValidatedPathTable | null): boolean {
  if (!parsed || !Array.isArray(parsed.table)) return false;
  pathTable = parsed.table;
  tableSource = 'validated';
  tableBuiltAt = Date.now();
  validatedMeta = {
    builtAt: parsed.builtAt,
    snapshotFrom: parsed.snapshotFrom,
    snapshotTo: parsed.snapshotTo,
    survivors: parsed.survivors
  };
  console.log(`[path-sim-engine] loaded VALIDATED table: ${pathTable.length} buckets (study ${parsed.snapshotFrom} → ${parsed.snapshotTo})`);
  return true;
}

/**
 * Rebuilds the table from every symbol's H1 + 15M history.
 *
 * Buckets are pooled ACROSS symbols on purpose. The claim under test is about
 * how a regime behaves inside a bar, not about how one coin behaves, and no
 * single symbol has enough 4H bars in a live window to say anything. Pooling is
 * only legitimate because every outcome is measured in R against that symbol's
 * own ATR, so a thin alt and BTC contribute in the same units.
 */
function rebuildTable(input: StrategyTickInput): void {
  const outcomes: PathOutcome[] = [];
  let barsUsed = 0;
  // Counted so an empty table can say WHY it is empty. "0 buckets because no
  // symbol had enough history yet" and "0 buckets because nothing cleared the
  // expectancy bar" are the same number and completely different situations,
  // and for months the status endpoint reported only the number.
  let skippedForHistory = 0;

  for (const symbol of Object.keys(input.liveCandles)) {
    const snap = input.liveCandles[symbol];
    const h1 = snap?.h1;
    const m15 = snap?.m15;
    if (!h1 || h1.length < MIN_PATH_CANDLES || !m15 || m15.length < 64) { skippedForHistory++; continue; }

    const h4 = aggregateToH4(h1);
    if (h4.length < PATH_MIN_H4_BARS) { skippedForHistory++; continue; }

    // Index the 15M candles by the 4H bar they belong to.
    const slotsByBar = new Map<number, Candle[]>();
    for (const candle of m15) {
      const open = barOpenFor(candle.timestamp);
      const group = slotsByBar.get(open);
      if (group) group.push(candle);
      else slotsByBar.set(open, [candle]);
    }

    // Sorted once, then walked with a cursor: prior15mFor advances through the
    // series instead of rescanning it per bar.
    const sorted15m = [...m15].sort((a, b) => a.timestamp - b.timestamp);
    const cursor = { i: 0 };

    for (let i = 60; i < h4.length; i++) {
      const bar = h4[i];
      const slots = slotsByBar.get(bar.timestamp);
      if (!slots || slots.length < SLOTS_PER_BAR) continue;
      slots.sort((a, b) => a.timestamp - b.timestamp);

      // Label from bars that closed BEFORE this one.
      //
      // The sentiment value here is TODAY'S, applied to every bar in the window.
      // That is a real leak of present information into a past label, and it is
      // why this table is only ever a fallback: scripts/pathStudy.ts reads the
      // value published on each bar's own date (fearGreedHistory.ts) and is the
      // one whose output should be traded. Fixing it here would mean carrying a
      // full sentiment history in the worker's memory to build a table that is
      // still in-sample and therefore still not tradeable evidence — the leak is
      // not the binding limitation of this path, the missing out-of-sample test
      // is.
      const priorBars = h4.slice(0, i);
      // Sentiment split OFF by default, matching the study (DEFAULT_USE_FEAR_GREED).
      // The two MUST agree: labelling with a different state space here would
      // build keys the validated table cannot contain, and the bot would abstain
      // forever while looking like it was working.
      const state = labelBarState(priorBars, input.fearGreedIndex ?? 50);
      if (!state) continue;

      const nextBar = h4[i + 1];
      const forward = nextBar ? (slotsByBar.get(nextBar.timestamp) ?? []) : [];
      forward.sort((a, b) => a.timestamp - b.timestamp);

      // 1R on the 15M ATR of the candles that closed before this bar — same
      // basis the live decision uses, so the table and the trades agree.
      const riskUnit = riskUnitFrom15M(prior15mFor(sorted15m, bar.timestamp, cursor));
      if (!(riskUnit > 0)) continue;
      outcomes.push(...measureBarPaths(state, bar.timestamp, slots, forward, riskUnit));
      barsUsed++;
    }
  }

  pathTable = buildPathTable(outcomes, { minSamples: LIVE_MIN_SAMPLES });
  tableBuiltAt = Date.now();
  tableSourceBars = barsUsed;
  lastSkippedForHistory = skippedForHistory;
  lastSymbolsSeen = Object.keys(input.liveCandles).length;
  tableSource = 'live-in-sample';
  console.log(`[path-sim-engine] IN-SAMPLE table rebuilt: ${pathTable.length} buckets from ${barsUsed} bars (${outcomes.length} outcomes)`);
}

function toSignalEvaluation(decision: PathDecision, price: number, priceChange24h: number): SignalEvaluation {
  const isSignal = decision.outcome === 'SIGNAL';
  const factors: DecisionFactor[] = [{
    label: 'יומן החלטה',
    value: decision.reasoning[decision.reasoning.length - 1] ?? decision.gate,
    impact: isSignal ? 'positive' : 'neutral',
    note: decision.reasoning.join(' | ')
  }];

  return {
    symbol: decision.symbol,
    action: isSignal ? 'buy' : 'hold',
    tradeType: isSignal ? 'SPOT' : 'HOLD',
    tradeSide: isSignal ? 'BUY' : 'NONE',
    confidence: decision.confidence,
    price,
    priceChange24h,
    reasoning: decision.reasoning.join('\n'),
    status: isSignal
      ? `SIGNAL SPOT ${decision.direction} · נתח ${decision.armedSlot}`
      : `NO_SIGNAL [${decision.gate}]`,
    willExecute: isSignal,
    factors,
    confidenceGap: 0,
    leverage: 1,
    stopLoss: decision.stopLoss,
    takeProfit: decision.takeProfit,
    takeProfit1: decision.takeProfit,
    decision: decision as never
  } as SignalEvaluation;
}

/**
 * This engine's confidence floor, defined once.
 *
 * A probability, not a score — see PathDecisionInput.minConfidence. An operator
 * override replaces it; this is the value in force when nobody set one.
 */
const PATH_MIN_CONFIDENCE = SIM_MIN_CONFIDENCE.path;

const pathStrategy: SimEngineStrategy = {
  id: 'path',
  logPrefix: '[path-sim-engine]',
  telegramTag: 'path-sim',
  telegramTitle: '🕓 מנוע נתיב 4H · Empirical Path',
  statusFooterLabel: 'מצב כולל של הבוט (נתיב 4H)',
  // The confidence a path signal reports IS the bucket's lower-bound hit rate,
  // so the floor here is a probability, not a score: a 2R target only needs to
  // land ~36% of the time to be profitable, and demanding 58 the way the H1
  // bots do would reject every genuinely good asymmetric bet.
  minConfidence: PATH_MIN_CONFIDENCE,
  minCandlesForH1View: MIN_PATH_CANDLES,
  logCandleFetch: false,

  buildEvaluations(input: StrategyTickInput): SignalEvaluation[] {
    // A validated table is loaded once and never overwritten by the live
    // rebuild. Letting a 30-minute in-sample refresh clobber a walk-forward
    // result would silently downgrade the bot from "trading a tested rule" to
    // "trading whatever the last few weeks happened to look like", and nothing
    // in the trade list would show it.
    // A validated table is installed once at boot and never overwritten by the
    // live rebuild. Letting a 30-minute in-sample refresh clobber a walk-forward
    // result would silently downgrade the bot from "trading a tested rule" to
    // "trading whatever the last few weeks happened to look like", and nothing
    // in the trade list would show it.
    if (tableSource === 'none' || (tableSource === 'live-in-sample' && Date.now() - tableBuiltAt > TABLE_REBUILD_MS)) {
      rebuildTable(input);
    }

    const results: SignalEvaluation[] = [];
    const now = Date.now();

    for (const crypto of input.cryptoData) {
      const symbol = crypto.symbol.toUpperCase();
      const snap = input.liveCandles[symbol];
      if (!snap?.h1 || !snap.m5) continue;

      const decision = evaluatePathDecision({
        symbol,
        h1: snap.h1,
        m15: snap.m15 ?? [],
        m5: snap.m5,
        livePrice: crypto.current_price,
        fearGreedIndex: input.fearGreedIndex ?? 50,
        table: pathTable,
        now,
        minExpectedR: MIN_EXPECTED_R,
        // The operator's floor, forwarded so the panel's control is real. The
        // other three engines carry theirs in DecisionContext.config; this bot
        // calls its engine directly, which is how the field ended up displayed
        // but never read.
        minConfidence: typeof input.config.minConfidenceOverride === 'number' && input.config.minConfidenceOverride > 0
          ? input.config.minConfidenceOverride
          : PATH_MIN_CONFIDENCE
      });

      results.push(toSignalEvaluation(decision, crypto.current_price, crypto.price_change_percentage_24h || 0));
    }

    return results;
  },

  generateOrders(input: StrategyTickInput, evaluations: SignalEvaluation[]) {
    return generatePathOrders({
      positions: input.positions,
      pending: input.pending,
      evaluations,
      equity: input.equity,
      executionDelaySec: input.config.executionDelaySec,
      dailyDrawdownPercent: input.dailyDrawdownPercent,
      weeklyDrawdownPercent: input.weeklyDrawdownPercent,
      cash: input.cash,
      positionPercent: input.config.positionPercent,
      riskLevel: input.config.riskLevel,
      exitCooldown: input.exitCooldown,
      priceFor: input.priceFor,
      candlesBySymbol: input.candlesBySymbol,
      maxPositions: input.maxPositions,
      maxFuturesPositions: input.maxFuturesPositions,
      closedTradeMetrics: input.closedTradeMetrics
    });
  }
};

/** Table telemetry for the status endpoint — how many buckets survived, how
 *  much history they came from, and when. A bot that abstains because its table
 *  is empty must be distinguishable from one that abstains because the market
 *  offered nothing. */
export function getPathTableStatus() {
  return {
    buckets: pathTable.length,
    // 'validated' = walk-forward tested, tradeable evidence.
    // 'live-in-sample' = the fallback rebuild; exercises the machinery, proves
    // nothing. 'none' = no table at all, the bot abstains.
    source: tableSource,
    validated: validatedMeta,
    builtAt: tableBuiltAt,
    sourceBars: tableSourceBars,
    /**
     * Why the table is the size it is.
     *
     * 'ok'                — the rebuild ran on real history.
     * 'warming-up'        — every symbol was skipped for want of candles. The
     *                       series grows one bar an hour after a cold start, so
     *                       this clears itself; it is not a strategy result and
     *                       must never be read as one.
     * 'no-validated-table' — running the in-sample fallback because nothing has
     *                       been published to the store.
     */
    readiness: tableSource === 'validated'
      ? 'ok'
      : lastSymbolsSeen > 0 && lastSkippedForHistory >= lastSymbolsSeen
        ? 'warming-up'
        : tableSource === 'none' ? 'no-validated-table' : 'ok',
    skippedForHistory: lastSkippedForHistory,
    symbolsSeen: lastSymbolsSeen,
    minCandlesRequired: MIN_PATH_CANDLES,
    minSamples: LIVE_MIN_SAMPLES,
    minExpectedR: MIN_EXPECTED_R,
    top: pathTable.slice(0, 5).map((b) => ({
      regime: b.state.regime,
      fng: b.state.fng,
      slot: b.slot,
      direction: b.direction,
      n: b.rawN,
      tpR: b.tpR,
      pLow: b.pLow,
      expectedR: b.expectedR
    }))
  };
}

export function createPathSimEngine(getSymbols?: () => string[]) {
  return createGenericSimEngine(pathStrategy, getSymbols);
}
