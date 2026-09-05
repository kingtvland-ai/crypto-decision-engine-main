/**
 * Offline path study — builds and VALIDATES the lookup table the 4H Path bot
 * trades from.
 *
 * WHY THIS EXISTS
 * ---------------
 * `server/pathSimEngine.ts` can rebuild a table at runtime from whatever candles
 * are in memory. That table is in-sample: it is scored on the same bars it was
 * built from, so a bucket that looks good there may simply be the best of ~2,400
 * hypotheses (480 state×slot×direction buckets × 5 target multiples). Under a
 * true null of no edge anywhere, about 5% of them clear a 95% Wilson bound on
 * noise alone. Per-bucket statistics cannot see that, because each such bucket
 * looks fine on its own.
 *
 * This script answers the only question that separates a real edge from a filter
 * survivor: does the rule still earn on a period it was not built from. It walks
 * rolling train/test windows, replays each trained bucket on the untouched test
 * slice, and keeps only the buckets that held a positive expectancy across
 * several disjoint windows.
 *
 * It also removes the leak the runtime rebuild carries: Fear & Greed is read
 * from the value PUBLISHED on each bar's own date, not the value showing today.
 *
 * USAGE
 * -----
 *   npx tsx scripts/pathStudy.ts snapshot --from 2024-01-01 --to 2025-07-01
 *   npx tsx scripts/pathStudy.ts build
 *   npx tsx scripts/pathStudy.ts build --min-samples 150 --train-days 120 --test-days 30
 *   npx tsx scripts/pathStudy.ts build --horizon-slots 96      # 24h hold
 *   npx tsx scripts/pathStudy.ts build --use-fng               # re-add the sentiment split
 *   npx tsx scripts/pathStudy.ts build --optimistic            # optimistic ordering bound
 *   npx tsx scripts/pathStudy.ts build --risk-basis 1h --horizon-slots 96
 *   npx tsx scripts/pathStudy.ts show
 *
 * `snapshot` downloads 15-minute candles once and writes them to disk; `build`
 * replays that exact file, so two runs a week apart measure the same yardstick.
 * The output table is written to `path-study/table.json`, then uploaded to the
 * worker with `publish`. It is NOT read off disk by the bot — see cmdPublish. The
 * local file is the build artifact; the worker's KV store is what it trades. It
 * server/pathSimEngine.ts loads in preference to its own runtime rebuild.
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  aggregateToH4
} from '../packages/engine/src/services/pathEngine.js';
import {
  buildValidatedPathTable,
  buildWalkForwardWindows,
  labelBarState,
  DEFAULT_USE_FEAR_GREED,
  DEFAULT_TP_R,
  SLOT_MS,
  type CandleOrdering,
  measureBarPaths,
  riskUnitFor,
  prior15mFor,
  lookbackForBasis,
  type RiskBasis,
  barOpenFor,
  SLOTS_PER_BAR,
  type PathOutcome,
  type ValidatedBucket
} from '../packages/engine/src/services/pathStudy.js';
import {
  fetchFearGreedHistory,
  fearGreedAt,
  buildFearGreedSeries,
  type FearGreedSeries
} from '../packages/engine/src/services/fearGreedHistory.js';
import type { Candle } from '../packages/engine/src/services/tradeEngine.js';
// Monthly archives instead of the paginated REST endpoint — see bulkKlines.ts.
import { fetchBulkKlines } from './bulkKlines';

const OUT_DIR = join(process.cwd(), 'path-study');
const DAY_MS = 86_400_000;

/**
 * The study basket.
 *
 * Buckets pool ACROSS symbols on purpose: the claim under test is about how a
 * regime behaves inside a bar, not about how one coin behaves, and no single
 * symbol has enough 4H bars to say anything about 480 buckets. Pooling is only
 * legitimate because every outcome is measured in R against that symbol's own
 * ATR, so a thin alt and BTC contribute in the same unit.
 *
 * Wider than the A/B basket (which is 6) because this study needs samples, and
 * spans volatility tiers so an effect that only exists in one tier cannot hide
 * inside the average.
 */
const SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT',
  'AVAXUSDT', 'DOGEUSDT', 'LINKUSDT', 'DOTUSDT', 'MATICUSDT', 'LTCUSDT',
  'ATOMUSDT', 'UNIUSDT', 'NEARUSDT', 'APTUSDT'
];

interface SymbolHistory {
  symbol: string;
  m15: Candle[];
}

interface Snapshot {
  from: string;
  to: string;
  builtAt: string;
  histories: SymbolHistory[];
  fearGreed: { at: number; value: number }[];
}

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

function num(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}


async function cmdSnapshot(): Promise<void> {
  const from = arg('from');
  const to = arg('to');
  const startMs = Date.parse(`${from}T00:00:00Z`);
  const endMs = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error('--from/--to must be YYYY-MM-DD with to > from');
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const histories: SymbolHistory[] = [];

  for (const symbol of SYMBOLS) {
    try {
      const m15 = await fetchBulkKlines(symbol, '15m', from, to);
      if (m15.length < 4 * SLOTS_PER_BAR) {
        console.log(`  ${symbol} ... skipped (${m15.length} bars)`);
        continue;
      }
      histories.push({ symbol, m15 });
      console.log(`  ${symbol} ... ${m15.length} bars`);
    } catch (e) {
      console.log(`  ${symbol} ... failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log('fetching Fear & Greed history ...');
  const fng = await fetchFearGreedHistory();
  const fearGreed = [...fng.byDay.entries()].map(([at, value]) => ({ at, value }));
  console.log(`  ${fearGreed.length} daily readings`);
  if (fearGreed.length === 0) {
    console.log('  WARNING: no sentiment history — every bar will be skipped at build time.');
  }

  const snapshot: Snapshot = {
    from, to, builtAt: new Date().toISOString(), histories, fearGreed
  };
  const path = join(OUT_DIR, 'snapshot.json');
  writeFileSync(path, JSON.stringify(snapshot));
  console.log(`\nsnapshot → ${path}`);
  console.log(`${histories.length} symbols, ${histories.reduce((s, h) => s + h.m15.length, 0)} bars, ${from} → ${to}`);
  console.log('\nKeep this file. Re-running `snapshot` changes the yardstick and');
  console.log('invalidates every table already measured against it.');
}

/**
 * Turns one symbol's 15-minute history into path outcomes.
 *
 * Two rules are enforced here and nowhere else, and both are the difference
 * between a study and a story:
 *   · a bar is labelled only from bars that CLOSED BEFORE it;
 *   · the sentiment reading is the one published on that bar's own date. A bar
 *     with no reading available is SKIPPED, not defaulted to a neutral 50 —
 *     inventing a label is worse than losing a sample.
 */
function outcomesForSymbol(
  m15: Candle[],
  fng: FearGreedSeries,
  opts: { useFearGreed: boolean; horizonSlots: number; ordering: CandleOrdering; riskBasis: RiskBasis }
): PathOutcome[] {
  const h4 = aggregateToH4(m15);
  if (h4.length < 62) return [];

  const slotsByBar = new Map<number, Candle[]>();
  for (const candle of m15) {
    const open = barOpenFor(candle.timestamp);
    const group = slotsByBar.get(open);
    if (group) group.push(candle);
    else slotsByBar.set(open, [candle]);
  }
  for (const group of slotsByBar.values()) group.sort((a, b) => a.timestamp - b.timestamp);

  const sorted15m = [...m15].sort((a, b) => a.timestamp - b.timestamp);
  const cursor = { i: 0 };
  const byTimestamp = new Map<number, Candle>();
  for (const c of sorted15m) byTimestamp.set(c.timestamp, c);

  const outcomes: PathOutcome[] = [];
  for (let i = 60; i < h4.length; i++) {
    const bar = h4[i];
    const slots = slotsByBar.get(bar.timestamp);
    if (!slots || slots.length < SLOTS_PER_BAR) continue;

    const sentiment = fearGreedAt(fng, bar.timestamp);
    if (sentiment === undefined) continue;

    const priorBars = h4.slice(0, i);
    const state = labelBarState(priorBars, sentiment, opts.useFearGreed);
    if (!state) continue;

    // Forward window taken from the flat series, not from "the next bar":
    // a horizon longer than one bar needs more than one bar of lookahead, and
    // every slot must get the SAME budget or late slots are scored on less data
    // than early ones.
    const barEnd = bar.timestamp + SLOTS_PER_BAR * SLOT_MS;
    const forwardNeeded = opts.horizonSlots + SLOTS_PER_BAR;
    const forward: Candle[] = [];
    for (let k = 0; k < forwardNeeded; k++) {
      const t = barEnd + k * SLOT_MS;
      const c = byTimestamp.get(t);
      if (!c) break;
      forward.push(c);
    }
    // 1R on the 15M ATR of candles that closed before this bar. Anything wider
    // (the 4H ATR this used to use) is unreachable inside a one-bar hold, which
    // is what made the first run measure nothing — see PATH_RISK_UNIT_ATR_MULT.
    const riskUnit = riskUnitFor(prior15mFor(sorted15m, bar.timestamp, cursor, lookbackForBasis(opts.riskBasis)), opts.riskBasis);
    if (!(riskUnit > 0)) continue;

    outcomes.push(...measureBarPaths(state, bar.timestamp, slots, forward, riskUnit, opts.horizonSlots, opts.ordering));
  }
  return outcomes;
}

function cmdBuild(): void {
  const snapPath = join(OUT_DIR, 'snapshot.json');
  if (!existsSync(snapPath)) {
    throw new Error(`no snapshot at ${snapPath} — run the snapshot command first`);
  }
  const snap = JSON.parse(readFileSync(snapPath, 'utf8')) as Snapshot;
  const fng = buildFearGreedSeries(snap.fearGreed);

  const minSamples = num('min-samples', 200);
  const trainDays = num('train-days', 120);
  const testDays = num('test-days', 30);
  const minWindowsPositive = num('min-windows', 2);
  // Horizon in 15-minute slots. 16 = one 4H bar, the original thesis. Longer
  // horizons widen the reachable move without shrinking R, which is the only
  // lever that relieves the cost/R squeeze while staying on spot.
  const horizonSlots = num('horizon-slots', SLOTS_PER_BAR);
  const useFearGreed = process.argv.includes('--use-fng') ? true : DEFAULT_USE_FEAR_GREED;
  const tpR = num('tp', DEFAULT_TP_R);
  // 'adverse' is the conservative bound and the default. Run 'favourable' to get
  // the optimistic bound: if both agree on the verdict, 15-minute resolution is
  // enough and 1-minute candles would change nothing.
  const ordering: CandleOrdering = process.argv.includes('--optimistic') ? 'favourable' : 'adverse';
  const riskBasis = (arg('risk-basis', '15m') === '1h' ? '1h' : '15m') as RiskBasis;

  console.log(`replaying ${snap.histories.length} symbols (${snap.from} → ${snap.to})`);
  console.log(`sentiment: ${fng.count} daily readings`);

  console.log(`state space: regime × ${useFearGreed ? 'sentiment × ' : ''}16 slots × 2 directions`);
  console.log(`horizon ${horizonSlots} slots (${(horizonSlots * 15 / 60).toFixed(1)}h), single target ${tpR}R`);
  console.log(`intra-candle ordering: ${ordering === 'adverse' ? 'ADVERSE first (conservative bound)' : 'FAVOURABLE first (optimistic bound)'}`);
  console.log(`risk basis: 1R = ATR(${riskBasis.toUpperCase()}) x 2.0`);

  const outcomes: PathOutcome[] = [];
  for (const history of snap.histories) {
    const symbolOutcomes = outcomesForSymbol(history.m15, fng, { useFearGreed, horizonSlots, ordering, riskBasis });
    // A loop, not push(...spread): a full-history symbol contributes hundreds of
    // thousands of outcomes and spreading them as arguments overflows the stack.
    for (const o of symbolOutcomes) outcomes.push(o);
    console.log(`  ${history.symbol} ... ${symbolOutcomes.length} outcomes`);
  }

  if (outcomes.length === 0) {
    console.log('\nno outcomes — nothing to validate.');
    return;
  }

  // A loop, not Math.min(...spread): this study produces over a million outcomes
  // and spreading that many arguments overflows the call stack.
  let from = Number.POSITIVE_INFINITY;
  let to = 0;
  for (const o of outcomes) {
    if (o.at < from) from = o.at;
    if (o.at > to) to = o.at;
  }
  const windows = buildWalkForwardWindows(from, to, trainDays * DAY_MS, testDays * DAY_MS);

  console.log(`\n${outcomes.length} outcomes, ${windows.length} walk-forward windows`);
  console.log(`train ${trainDays}d / test ${testDays}d, min ${minSamples} samples/bucket\n`);

  if (windows.length === 0) {
    console.log('history is too short for even one train+test window — widen the snapshot.');
    return;
  }

  const report = buildValidatedPathTable(outcomes, windows, {
    minSamples,
    minWindowsPositive,
    tpGrid: [tpR]
  });

  const meanCost = outcomes.reduce((a, o) => a + (Number.isFinite(o.costR) ? o.costR : 0), 0) / outcomes.length;
  console.log(`mean round-trip cost: ${meanCost.toFixed(3)}R  (was charged as a flat 0.06R before this pass)
`);

  console.log('── validation ──────────────────────────────────────────────');
  console.log(`  candidates (passed in-sample)      ${report.candidates}`);
  console.log(`  expected under a pure-noise null   ${report.expectedUnderNull}`);
  console.log(`  survivors (held out-of-sample)     ${report.survivors}`);
  console.log('');

  if (report.survivors === 0) {
    console.log('  NOTHING SURVIVED. That is a result, not a failure: it says the');
    console.log('  intra-bar timing effect is not measurable in this data at this');
    console.log('  resolution. Writing an empty table is the correct outcome — the');
    console.log('  bot will abstain rather than trade noise.');
  } else if (report.survivors <= report.expectedUnderNull) {
    console.log('  SURVIVORS DO NOT EXCEED THE NOISE FLOOR. Treat this as nothing');
    console.log('  found. Publishing this table would be trading the look-elsewhere');
    console.log('  effect.');
  } else {
    console.log('  Survivors exceed the noise floor. That is necessary, not');
    console.log('  sufficient — the ratio is the thing to watch across rebuilds.');
    console.log('');
    console.log('  top buckets by out-of-sample expectancy:');
    for (const b of report.table.slice(0, 10)) {
      console.log(
        `    ${b.state.regime.padEnd(14)} ${b.state.fng.padEnd(13)} slot ${String(b.slot).padStart(2)} ` +
        `${b.direction.padEnd(5)} n=${String(b.rawN).padStart(5)} tp=${b.tpR}R cost=${b.costR.toFixed(2)}R ` +
        `oos=${b.oosExpectedR >= 0 ? '+' : ''}${b.oosExpectedR.toFixed(3)}R ` +
        `windows=${b.windows}/${b.windowsTested}`
      );
    }
  }

  // Only buckets that beat the noise floor are published. Below it the table is
  // written empty on purpose: an empty table makes the bot abstain, which is the
  // honest behaviour when the study found nothing.
  const publish: ValidatedBucket[] = report.survivors > report.expectedUnderNull ? report.table : [];

  const outPath = join(OUT_DIR, 'table.json');
  writeFileSync(outPath, JSON.stringify({
    builtAt: new Date().toISOString(),
    snapshotFrom: snap.from,
    snapshotTo: snap.to,
    symbols: snap.histories.length,
    outcomes: outcomes.length,
    windows: report.windows,
    candidates: report.candidates,
    expectedUnderNull: report.expectedUnderNull,
    survivors: report.survivors,
    published: publish.length,
    settings: { minSamples, trainDays, testDays, minWindowsPositive, horizonSlots, useFearGreed, tpR, ordering, riskBasis },
    table: publish
  }, null, 2));

  console.log(`\n→ ${outPath} (${publish.length} buckets published)`);
}

function cmdShow(): void {
  const path = join(OUT_DIR, 'table.json');
  if (!existsSync(path)) throw new Error(`no table at ${path} — run build first`);
  const t = JSON.parse(readFileSync(path, 'utf8'));
  console.log(JSON.stringify({ ...t, table: `${t.table.length} buckets` }, null, 2));
  for (const b of t.table.slice(0, 20)) {
    console.log(`  ${b.state.regime} / ${b.state.fng} slot ${b.slot} ${b.direction} → ${b.oosExpectedR}R (n=${b.rawN})`);
  }
}

/**
 * Uploads the built table to the worker, which stores it durably and installs it.
 *
 * The bot used to read `path-study/table.json` off local disk. That directory is
 * gitignored, so the file never existed on the server: the engine silently fell
 * through to its in-sample rebuild on every deploy, and nothing in the logs or
 * the UI distinguished that from having loaded a validated table. Durable state
 * belongs in the KV store with everything else, and this is how it gets there.
 *
 * Behind the admin token on purpose — unlike the rest of the path-sim
 * namespace, this call changes what the bot trades.
 */
async function cmdPublish(): Promise<void> {
  const path = join(OUT_DIR, 'table.json');
  if (!existsSync(path)) throw new Error(`no table at ${path} — run build first`);

  const base = (process.env.WORKER_URL || '').replace(/\/+$/, '');
  const token = process.env.BOT_ADMIN_TOKEN || '';
  if (!base) throw new Error('set WORKER_URL to the base URL of the worker');
  if (!token) throw new Error('set BOT_ADMIN_TOKEN — publishing changes what the bot trades');

  const body = readFileSync(path, 'utf8');
  const parsed = JSON.parse(body) as { table?: unknown[] };
  const buckets = Array.isArray(parsed.table) ? parsed.table.length : 0;
  if (buckets === 0) {
    console.log('WARNING: publishing an EMPTY table. The bot will abstain —');
    console.log('which is correct when nothing survived validation, but say it out loud.');
  }

  const res = await fetch(`${base}/api/path-sim/table`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`publish failed: ${res.status} ${text}`);
  console.log(`published ${buckets} buckets → ${base}`);
  console.log(text);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === 'snapshot') return cmdSnapshot();
  if (cmd === 'build') return cmdBuild();
  if (cmd === 'show') return cmdShow();
  if (cmd === 'publish') return cmdPublish();
  console.log('usage: pathStudy.ts <snapshot|build|show|publish> [options]');
  console.log('  snapshot --from YYYY-MM-DD --to YYYY-MM-DD');
  console.log('  build [--min-samples 200] [--train-days 120] [--test-days 30] [--min-windows 2]');
  console.log('  show');
  console.log('  publish        (needs WORKER_URL + BOT_ADMIN_TOKEN)');
  process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
