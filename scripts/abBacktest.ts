/**
 * A/B measurement harness for engine changes. See SIM_BOTS.md.
 *
 * WHY THIS EXISTS
 * ---------------
 * `runBacktestSweep()` is a *calibration* tool: it fetches a window relative to
 * `Date.now()` and sweeps an SL grid. Neither property is acceptable for A/B
 * work — two runs a day apart see different data, and a grid confounds "the
 * change helped" with "a different grid point won". This harness fixes both:
 *
 *   1. `snapshot` downloads candles for an EXPLICIT absolute date range once
 *      and writes them to disk. Every later run replays that exact file.
 *   2. `run` uses ONE fixed SlConfig, so the only thing that differs between
 *      a baseline run and a post-change run is the engine code itself.
 *
 * USAGE
 * -----
 *   npx tsx scripts/abBacktest.ts snapshot --from 2025-01-01 --to 2025-07-01
 *   npx tsx scripts/abBacktest.ts run --label baseline --engine pro
 *   # ... apply an engine change ...
 *   npx tsx scripts/abBacktest.ts run --label kelly-r --engine pro
 *   npx tsx scripts/abBacktest.ts compare baseline kelly-r
 *
 * Snapshots and results live in `backtest-ab/` (gitignored). A snapshot is
 * meant to be kept for the life of the comparison: re-downloading it changes
 * the yardstick and invalidates every earlier run measured against it.
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runPortfolioBacktest, runBacktest, type SlConfig, type EngineType, type IntradayOverrides } from '../server/backtestRunner.js';
import { DEFAULT_INTRADAY_PARAMS } from '@cde/engine';
// History comes from Binance's monthly archives, not the paginated REST
// endpoint: one request per symbol-month instead of thousands, which is what
// turned "just measure it over a longer window" from an hour into a minute.
import { fetchBulkKlines } from './bulkKlines';

const OUT_DIR = join(process.cwd(), 'backtest-ab');

// The fixed comparison basket. Chosen for liquidity and for spanning a range
// of volatility regimes (BTC/ETH low, SOL/AVAX mid, DOGE high) so a change
// that only helps one volatility bucket cannot hide inside the average.
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'AVAXUSDT', 'DOGEUSDT', 'LINKUSDT'];

// One fixed point, NOT a grid. These are the runner's own mid-grid defaults;
// what matters is only that every run uses the identical value.
const FIXED_SL: SlConfig = { minStop: 1.5, maxStop: 4.0, softTrendBase: 60 };

interface Candle {
  timestamp: number; open: number; high: number; low: number; close: number; volume: number;
}

interface Snapshot {
  createdAt: string;
  from: string;
  to: string;
  symbols: string[];
  /** `candles` is H1. `m15`/`m5` are present only in an MTF snapshot and are
   *  what the Intraday engine needs; Legacy and Pro ignore them. */
  histories: { symbol: string; candles: Candle[]; m15?: Candle[]; m5?: Candle[] }[];
}

/**
 * Where each engine reads its history from.
 *
 * TWO FILES, deliberately. The Intraday engine needs 15M and 5M series, which
 * the original H1-only snapshot does not carry — but re-fetching `snapshot.json`
 * to add them would change the yardstick and silently invalidate every
 * legacy/pro run already recorded against it. A second file leaves those runs
 * exactly as comparable as they were.
 */
const SNAPSHOT_FILE: Record<EngineType, string> = {
  legacy: 'snapshot.json',
  pro: 'snapshot.json',
  intraday: 'snapshot-mtf.json'
};

/** `--snapshot <name>` writes/reads snapshot-<name>.json instead of the default.
 *  A second, longer window therefore never overwrites the yardstick every
 *  earlier run was measured against. */
function snapshotPathFor(engine: EngineType): string {
  const named = process.argv.includes('--snapshot') ? arg('snapshot') : '';
  return join(OUT_DIR, named ? `snapshot-${named}.json` : SNAPSHOT_FILE[engine]);
}

interface Metrics {
  label: string;
  engine: EngineType;
  snapshotFrom: string;
  snapshotTo: string;
  ranAt: string;
  gitCommit: string;
  totalTrades: number;
  winRate: number;
  netProfit: number;
  profitFactor: number;
  expectancy: number;
  maxDrawdown: number;
  /** mean(pnl) / stdev(pnl) across trades. NOT an annualised time-series
   *  Sharpe — there is no equity time axis here, only a trade sequence.
   *  Comparable between runs on the same snapshot, which is all we need. */
  sharpePerTrade: number;
  pnlStdev: number;
  largestWin: number;
  largestLoss: number;
  /** Populated only once ClosedTradeRecord carries riskUsd (PLAN שלב 1).
   *  Until then this is null and the R-multiple row reports "unavailable" —
   *  which is honest: R-multiples cannot be reconstructed after the fact. */
  rMultiples: RMultipleStats | null;
}

interface RMultipleStats {
  mean: number; median: number; stdev: number; p25: number; p75: number;
  best: number; worst: number; sampleSize: number;
}

// ── helpers ────────────────────────────────────────────────────────────────

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required argument --${name}`);
}

/** An optional numeric flag. Absent means "leave the engine's default alone",
 *  which is why this returns undefined rather than a fallback number. */
function argNum(name: string): number | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) return undefined;
  const value = Number(process.argv[i + 1]);
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a number`);
  return value;
}

function gitCommit(): string {
  try {
    // Read HEAD directly rather than shelling out — keeps the harness usable
    // in environments where spawning git is restricted.
    const head = readFileSync(join(process.cwd(), '.git', 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref: ')) {
      return readFileSync(join(process.cwd(), '.git', head.slice(5)), 'utf8').trim().slice(0, 7);
    }
    return head.slice(0, 7);
  } catch {
    return 'unknown';
  }
}

// ── snapshot ───────────────────────────────────────────────────────────────

async function cmdSnapshotMtf() {
  const from = arg('from');
  const to = arg('to');
  const startMs = Date.parse(`${from}T00:00:00Z`);
  const endMs = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) throw new Error('--from/--to must be YYYY-MM-DD');
  if (endMs <= startMs) throw new Error('--to must be after --from');

  const histories: { symbol: string; candles: Candle[]; m15: Candle[]; m5: Candle[] }[] = [];
  for (const symbol of SYMBOLS) {
    process.stdout.write(`  ${symbol} 1h ... `);
    const candles = await fetchBulkKlines(symbol, '1h', from, to);
    process.stdout.write(`${candles.length}  15m ... `);
    const m15 = await fetchBulkKlines(symbol, '15m', from, to);
    process.stdout.write(`${m15.length}  5m ... `);
    const m5 = await fetchBulkKlines(symbol, '5m', from, to);
    console.log(`${m5.length}`);
    // The engine's own NO_DATA gate, checked here so a thin window fails at
    // download time rather than as a silent zero-trade result.
    if (candles.length < 200 || m15.length < 300 || m5.length < 500) {
      console.log(`    skipped — below the engine's minimum (200/300/500)`);
      continue;
    }
    histories.push({ symbol, candles, m15, m5 });
  }
  if (!histories.length) throw new Error('no symbol had enough data across all three timeframes');

  const snap: Snapshot = { createdAt: new Date().toISOString(), from, to, symbols: histories.map((h) => h.symbol), histories };
  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, 'snapshot-mtf.json');
  writeFileSync(path, JSON.stringify(snap));
  const bars = histories.reduce((sum, h) => sum + h.candles.length + h.m15.length + h.m5.length, 0);
  console.log(`\nMTF snapshot → ${path}`);
  console.log(`${histories.length} symbols, ${bars} bars across 1h/15m/5m, ${from} → ${to}`);
  console.log('\nKeep this file. Re-running `snapshot-mtf` changes the yardstick for');
  console.log('every intraday run measured against it.');
}

async function cmdSnapshot() {
  const from = arg('from');
  const to = arg('to');
  const startMs = Date.parse(`${from}T00:00:00Z`);
  const endMs = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) throw new Error('--from/--to must be YYYY-MM-DD');
  if (endMs <= startMs) throw new Error('--to must be after --from');

  const basket = process.argv.includes('--symbols') ? arg('symbols').split(',') : SYMBOLS;
  const histories: { symbol: string; candles: Candle[] }[] = [];
  for (const symbol of basket) {
    process.stdout.write(`  ${symbol} ... `);
    const candles = await fetchBulkKlines(symbol, '1h', from, to);
    if (candles.length < 200) {
      console.log(`skipped (${candles.length} bars, need 200+)`);
      continue;
    }
    histories.push({ symbol, candles });
    console.log(`${candles.length} bars`);
  }
  if (!histories.length) throw new Error('no symbol had enough data');

  const snap: Snapshot = { createdAt: new Date().toISOString(), from, to, symbols: histories.map((h) => h.symbol), histories };
  mkdirSync(OUT_DIR, { recursive: true });
  const named = process.argv.includes('--snapshot') ? arg('snapshot') : '';
  const path = join(OUT_DIR, named ? `snapshot-${named}.json` : 'snapshot.json');
  writeFileSync(path, JSON.stringify(snap));
  console.log(`\nsnapshot → ${path}`);
  console.log(`${histories.length} symbols, ${histories.reduce((s, h) => s + h.candles.length, 0)} bars, ${from} → ${to}`);
  console.log('\nKeep this file. Re-running `snapshot` changes the yardstick and');
  console.log('invalidates every result already measured against it.');
}

// ── run ────────────────────────────────────────────────────────────────────

/**
 * Splits a snapshot's histories at a fraction of the calendar span.
 *
 * A candidate chosen on the same window it is scored on is fitted, not
 * measured — and with a handful of candidates tried per engine, one of them
 * looking good is the expected outcome under a null. Train picks; test decides.
 * This is the same discipline the 4H Path study already runs (walk-forward
 * windows plus an explicit noise floor); the difference is only that these
 * engines have few enough knobs for a single hold-out to be honest.
 */
function splitHistories<T extends { candles: Candle[]; m15?: Candle[]; m5?: Candle[] }>(
  histories: T[], trainFraction: number
): { train: T[]; test: T[]; cutoff: number } {
  let lo = Infinity, hi = -Infinity;
  for (const h of histories) {
    lo = Math.min(lo, h.candles[0].timestamp);
    hi = Math.max(hi, h.candles[h.candles.length - 1].timestamp);
  }
  const cutoff = lo + (hi - lo) * trainFraction;
  const slice = (h: T, keep: (ts: number) => boolean): T => ({
    ...h,
    candles: h.candles.filter((c) => keep(c.timestamp)),
    ...(h.m15 ? { m15: h.m15.filter((c) => keep(c.timestamp)) } : {}),
    ...(h.m5 ? { m5: h.m5.filter((c) => keep(c.timestamp)) } : {})
  });
  return {
    train: histories.map((h) => slice(h, (ts) => ts < cutoff)),
    test: histories.map((h) => slice(h, (ts) => ts >= cutoff)),
    cutoff
  };
}

async function cmdRun() {
  const label = arg('label');
  const engine = arg('engine', 'pro') as EngineType;
  if (engine !== 'pro' && engine !== 'legacy' && engine !== 'intraday') {
    throw new Error('--engine must be pro, legacy or intraday');
  }

  // 'train' | 'test' | omitted (the whole window). A candidate is picked on
  // train and only believed if it survives test.
  const split = process.argv.includes('--split') ? arg('split') : '';
  if (split && split !== 'train' && split !== 'test') throw new Error('--split must be train or test');

  const snapPath = snapshotPathFor(engine);
  if (!existsSync(snapPath)) {
    throw new Error(
      `no snapshot at ${snapPath} — run ` +
      `\`abBacktest.ts ${engine === 'intraday' ? 'snapshot-mtf' : 'snapshot'} --from <date> --to <date>\` first`
    );
  }
  const snap = JSON.parse(readFileSync(snapPath, 'utf8')) as Snapshot;

  let histories = snap.histories;
  if (split) {
    const parts = splitHistories(histories, 0.6);
    histories = split === 'train' ? parts.train : parts.test;
    console.log(`  split=${split} (60/40 at ${new Date(parts.cutoff).toISOString().slice(0, 10)})`);
  }

  console.log(`replaying ${histories.length} symbols (${snap.from} → ${snap.to}), engine=${engine}`);
  const t0 = Date.now();
  // Intraday parameter overrides. Omitting all three reproduces
  // DEFAULT_INTRADAY_PARAMS exactly, so an unflagged run is the unmodified
  // strategy and stays comparable to every earlier one.
  //
  // These three specifically because the measured exit mix says so: 89% of
  // intraday trades close on the clock (TIME_STOP 79%, MAX_DURATION 11%) and
  // only 10% ever reach a stop or a target. The clock, not price, is deciding
  // the outcomes — so the clock is what a candidate has to move.
  const intradayOverrides: IntradayOverrides = {};
  const timeStopProgress = argNum('time-stop-progress');
  const timeStopFraction = argNum('time-stop-fraction');
  const holdMult = argNum('hold-mult');
  if (timeStopProgress !== undefined) intradayOverrides.timeStopMinProgressR = timeStopProgress;
  if (timeStopFraction !== undefined) intradayOverrides.timeStopFraction = timeStopFraction;
  if (holdMult !== undefined) {
    const base = DEFAULT_INTRADAY_PARAMS.maxHoldMinutes;
    intradayOverrides.maxHoldMinutes = {
      TREND_PULLBACK: Math.round(base.TREND_PULLBACK * holdMult),
      BREAKOUT_RETEST: Math.round(base.BREAKOUT_RETEST * holdMult),
      MEAN_REVERSION: Math.round(base.MEAN_REVERSION * holdMult)
    };
  }
  const hasOverrides = Object.keys(intradayOverrides).length > 0;
  if (hasOverrides && engine !== 'intraday') {
    throw new Error('--time-stop-* and --hold-mult apply to --engine intraday only');
  }
  if (hasOverrides) console.log(`  overrides: ${JSON.stringify(intradayOverrides)}`);

  // Intraday always goes through the portfolio path: the single-symbol runner
  // walks an H1 array and has no way to carry the other two timeframes, and
  // giving it a degraded second implementation is how the two paths drift.
  const result = histories.length > 1 || engine === 'intraday'
    ? await runPortfolioBacktest(histories, FIXED_SL, engine, hasOverrides ? intradayOverrides : undefined)
    : await runBacktest(histories[0].symbol, histories[0].candles, FIXED_SL, engine);
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // How the trades ended. A run whose exits are mostly time-based is paying a
  // full round-trip cost per trade to close positions that never resolved,
  // which reads as a broken edge in the aggregates and is not one.
  const gates = Object.entries(result.gateReasons ?? {}).sort((a, b) => b[1] - a[1]);
  if (gates.length) {
    const total = gates.reduce((sum, [, n]) => sum + n, 0);
    console.log('');
    console.log('  why no trade');
    for (const [gate, n] of gates) {
      console.log(`    ${gate.padEnd(24)} ${String(n).padStart(7)}  ${((n / total) * 100).toFixed(1)}%`);
    }
  }

  const reasons = Object.entries(result.exitReasons ?? {}).sort((a, b) => b[1] - a[1]);
  if (reasons.length) {
    const total = reasons.reduce((sum, [, n]) => sum + n, 0);
    console.log('');
    console.log('  exits');
    for (const [reason, n] of reasons) {
      console.log(`    ${reason.padEnd(24)} ${String(n).padStart(4)}  ${((n / total) * 100).toFixed(1)}%`);
    }
  }

  const pnls = result.closedTrades.map((t) => t.pnl);
  const sd = stdev(pnls);

  // R-multiples need risk-at-entry, which ClosedTradeRecord does not carry yet
  // (PLAN שלב 1 adds it). Detect rather than assume: the field is optional.
  const withRisk = result.closedTrades.filter(
    (t) => typeof (t as { riskUsd?: number }).riskUsd === 'number' && (t as { riskUsd?: number }).riskUsd! > 0
  );
  let rStats: RMultipleStats | null = null;
  if (withRisk.length === result.closedTrades.length && withRisk.length > 0) {
    const rs = withRisk.map((t) => t.pnl / (t as { riskUsd: number }).riskUsd).sort((a, b) => a - b);
    rStats = {
      mean: mean(rs), median: quantile(rs, 0.5), stdev: stdev(rs),
      p25: quantile(rs, 0.25), p75: quantile(rs, 0.75),
      best: rs[rs.length - 1], worst: rs[0], sampleSize: rs.length
    };
  }

  const metrics: Metrics = {
    label, engine,
    snapshotFrom: snap.from, snapshotTo: snap.to,
    ranAt: new Date().toISOString(), gitCommit: gitCommit(),
    totalTrades: result.totalTrades,
    winRate: result.winRate,
    netProfit: result.netProfit,
    profitFactor: Number.isFinite(result.profitFactor) ? result.profitFactor : 0,
    expectancy: result.expectancy,
    maxDrawdown: result.maxDrawdown,
    sharpePerTrade: sd > 0 ? mean(pnls) / sd : 0,
    pnlStdev: sd,
    largestWin: pnls.length ? Math.max(...pnls) : 0,
    largestLoss: pnls.length ? Math.min(...pnls) : 0,
    rMultiples: rStats
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, `run-${label}.json`);
  writeFileSync(path, JSON.stringify(metrics, null, 2));

  console.log(`\n${label} (${engine}, commit ${metrics.gitCommit})`);
  console.log(`  trades         ${metrics.totalTrades}`);
  console.log(`  win rate       ${metrics.winRate.toFixed(1)}%`);
  console.log(`  net profit     $${metrics.netProfit.toFixed(2)}`);
  console.log(`  profit factor  ${metrics.profitFactor.toFixed(3)}`);
  console.log(`  expectancy     $${metrics.expectancy.toFixed(2)}`);
  console.log(`  max drawdown   ${metrics.maxDrawdown.toFixed(2)}%`);
  console.log(`  sharpe/trade   ${metrics.sharpePerTrade.toFixed(3)}`);
  console.log(`  R-multiples    ${rStats ? `mean ${rStats.mean.toFixed(2)}R, median ${rStats.median.toFixed(2)}R, sd ${rStats.stdev.toFixed(2)}` : 'unavailable (riskUsd not recorded — see PLAN שלב 1)'}`);
  console.log(`\n→ ${path}`);
}

// ── compare ────────────────────────────────────────────────────────────────

// Direction each metric should move for the change to count as an improvement.
const HIGHER_IS_BETTER: Record<string, boolean> = {
  winRate: true, netProfit: true, profitFactor: true, expectancy: true,
  maxDrawdown: false, sharpePerTrade: true
};

function cmdCompare() {
  const [, , , aLabel, bLabel] = process.argv;
  if (!aLabel || !bLabel) throw new Error('usage: compare <baseline-label> <candidate-label>');

  const load = (l: string): Metrics => {
    const p = join(OUT_DIR, `run-${l}.json`);
    if (!existsSync(p)) throw new Error(`no run at ${p}`);
    return JSON.parse(readFileSync(p, 'utf8')) as Metrics;
  };
  const a = load(aLabel);
  const b = load(bLabel);

  if (a.snapshotFrom !== b.snapshotFrom || a.snapshotTo !== b.snapshotTo) {
    console.error('REFUSING TO COMPARE: the two runs used different snapshot windows.');
    console.error(`  ${a.label}: ${a.snapshotFrom} → ${a.snapshotTo}`);
    console.error(`  ${b.label}: ${b.snapshotFrom} → ${b.snapshotTo}`);
    process.exit(1);
  }
  if (a.engine !== b.engine) {
    console.error(`REFUSING TO COMPARE: different engines (${a.engine} vs ${b.engine}).`);
    process.exit(1);
  }

  console.log(`\n${a.engine}   ${a.snapshotFrom} → ${a.snapshotTo}`);
  console.log(`baseline  ${a.label} @ ${a.gitCommit}`);
  console.log(`candidate ${b.label} @ ${b.gitCommit}\n`);

  const row = (name: string, av: number, bv: number, digits = 2, suffix = '') => {
    const delta = bv - av;
    const better = HIGHER_IS_BETTER[name];
    const mark = delta === 0 ? ' ' : better === undefined ? '·' : (delta > 0) === better ? '+' : '-';
    console.log(
      `  ${mark} ${name.padEnd(15)}${av.toFixed(digits).padStart(11)}${suffix}` +
      `${bv.toFixed(digits).padStart(13)}${suffix}` +
      `${(delta >= 0 ? '+' : '') + delta.toFixed(digits)}`.padStart(12)
    );
  };

  console.log(`    ${'metric'.padEnd(15)}${'baseline'.padStart(11)}${'candidate'.padStart(14)}${'delta'.padStart(12)}`);
  row('totalTrades', a.totalTrades, b.totalTrades, 0);
  row('winRate', a.winRate, b.winRate, 1, '%');
  row('netProfit', a.netProfit, b.netProfit, 2);
  row('profitFactor', a.profitFactor, b.profitFactor, 3);
  row('expectancy', a.expectancy, b.expectancy, 2);
  row('maxDrawdown', a.maxDrawdown, b.maxDrawdown, 2, '%');
  row('sharpePerTrade', a.sharpePerTrade, b.sharpePerTrade, 3);

  if (a.rMultiples && b.rMultiples) {
    console.log('');
    row('R mean', a.rMultiples.mean, b.rMultiples.mean, 3);
    row('R median', a.rMultiples.median, b.rMultiples.median, 3);
    row('R stdev', a.rMultiples.stdev, b.rMultiples.stdev, 3);
  } else {
    console.log('\n  R-multiples unavailable in at least one run (riskUsd not recorded).');
  }

  // A change in trade count means the change altered WHICH trades were taken,
  // not just how they were sized. PnL deltas then compare two different
  // strategies, not two versions of one — worth saying out loud.
  const tradeDelta = a.totalTrades ? Math.abs(b.totalTrades - a.totalTrades) / a.totalTrades : 0;
  if (tradeDelta > 0.1) {
    console.log(`\n  ⚠ trade count moved ${(tradeDelta * 100).toFixed(0)}% — the change altered which`);
    console.log('    trades were taken, not only their size. PnL deltas below compare two');
    console.log('    different strategies; judge on expectancy and R, not net profit.');
  }
  console.log('');
}

// ── main ───────────────────────────────────────────────────────────────────

const cmd = process.argv[2];
const run =
  cmd === 'snapshot' ? cmdSnapshot :
  cmd === 'snapshot-mtf' ? cmdSnapshotMtf :
  cmd === 'run' ? cmdRun :
  cmd === 'compare' ? async () => cmdCompare() :
  null;

if (!run) {
  console.error('usage: abBacktest.ts <snapshot|snapshot-mtf|run|compare> [...]');
  console.error('  snapshot     --from YYYY-MM-DD --to YYYY-MM-DD   (1h — legacy/pro)');
  console.error('  snapshot-mtf --from YYYY-MM-DD --to YYYY-MM-DD   (1h+15m+5m — intraday)');
  console.error('  run --label <name> [--engine pro|legacy|intraday]');
  console.error('      intraday only: [--time-stop-progress N] [--time-stop-fraction N] [--hold-mult N]');
  console.error('      [--split train|test]  60/40 hold-out; pick on train, believe only if test agrees');
  console.error('  compare <baseline-label> <candidate-label>');
  process.exit(1);
}
run().catch((e) => { console.error(`\n${e instanceof Error ? e.message : e}`); process.exit(1); });
