/**
 * Walk-forward driver — TRAIN → VALIDATION → OUT-OF-SAMPLE, any of the 4 bots.
 * ============================================================================
 * Ties `server/replayRunner.ts` (the real execution engine over stored data)
 * to `walkForward.ts` (the split, the scoring, the survivor rule and the
 * out-of-sample budget).
 *
 *   npx tsx scripts/walkForward.ts --bot pro --snapshot snapshot-mtf
 *   npx tsx scripts/walkForward.ts --bot intraday --windows 4 --window-days 60
 *   npx tsx scripts/walkForward.ts --bot path --oos            # spend the OOS budget
 *
 * Reads the snapshots `scripts/abBacktest.ts snapshot-mtf` already writes to
 * `backtest-ab/`, so no new data pipeline is needed to start.
 *
 * WHAT THIS DOES NOT DO: it does not tune anything. There is no parameter grid
 * here, because this project has no parameter worth sweeping until the replay
 * numbers have been sanity-checked against the live sim — and a sweep is
 * exactly how an out-of-sample window gets burned. Add the grid once the
 * TRAIN/VALIDATION numbers are trusted; the OOS budget below is already in
 * place to protect the last window when you do.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  splitWalkForward,
  rollingWalkForward,
  scoreRun,
  judgeSurvivor,
  assertOosUnspent,
  hashConfig,
  type OosLedgerEntry,
  type RunScore,
  type WalkForwardWindow
} from '@cde/engine/volatility';
import type { SimBotConfig } from '@cde/engine/execution';
import { runReplay, type ReplaySymbolHistory } from '../server/replayRunner';
import { intradayStrategy } from '../server/simEngine';
import { proStrategy } from '../server/proSimEngine';
import { pathStrategy } from '../server/pathSimEngine';
import { bybitStrategy } from '../server/bybitSimEngine';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SNAPSHOT_DIR = path.join(ROOT, 'backtest-ab');
const LEDGER_PATH = path.join(SNAPSHOT_DIR, 'oos-ledger.json');

const STRATEGIES = {
  intraday: intradayStrategy,
  pro: proStrategy,
  path: pathStrategy,
  bybit: bybitStrategy
} as const;
type BotId = keyof typeof STRATEGIES;

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);
const argNum = (name: string): number | undefined => {
  const v = arg(name);
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

interface SnapshotFile {
  from: string;
  to: string;
  symbols: string[];
  histories: { symbol: string; candles: unknown[]; m15?: unknown[]; m5?: unknown[] }[];
}

function loadHistories(name: string): ReplaySymbolHistory[] {
  const file = path.join(SNAPSHOT_DIR, `${name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(
      `Snapshot not found: ${file}\n` +
      `Build one first:  npx tsx scripts/abBacktest.ts snapshot-mtf --from 2025-01-01 --to 2025-07-01`
    );
  }
  const snap = JSON.parse(fs.readFileSync(file, 'utf8')) as SnapshotFile;
  const out: ReplaySymbolHistory[] = [];
  for (const h of snap.histories) {
    if (!h.m5?.length || !h.m15?.length || !h.candles?.length) {
      console.warn(`  skipping ${h.symbol}: needs 1h + 15m + 5m series (snapshot-mtf, not snapshot)`);
      continue;
    }
    out.push({
      symbol: h.symbol,
      h1: h.candles as ReplaySymbolHistory['h1'],
      m15: h.m15 as ReplaySymbolHistory['m15'],
      m5: h.m5 as ReplaySymbolHistory['m5']
    });
  }
  if (!out.length) throw new Error(`${file} contains no symbol with all three timeframes`);
  return out;
}

/** Clips every series to a window, so a replay of TRAIN cannot see VALIDATION
 *  or OOS data at all — the strongest form of the guarantee, since the engine
 *  is then physically unable to read past the boundary. */
function clip(histories: ReplaySymbolHistory[], w: WalkForwardWindow): ReplaySymbolHistory[] {
  const within = <T extends { timestamp: number }>(bars: T[]) =>
    bars.filter((b) => b.timestamp >= w.from && b.timestamp < w.to);
  return histories
    .map((h) => ({ symbol: h.symbol, h1: within(h.h1), m15: within(h.m15), m5: within(h.m5) }))
    .filter((h) => h.m5.length > 0);
}

function loadLedger(): OosLedgerEntry[] {
  if (!fs.existsSync(LEDGER_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8')) as OosLedgerEntry[];
  } catch {
    console.warn(`[walk-forward] ledger at ${LEDGER_PATH} is unreadable — treating as empty`);
    return [];
  }
}

function appendLedger(entry: OosLedgerEntry): void {
  const ledger = loadLedger();
  ledger.push(entry);
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
}

function report(label: string, score: RunScore, equity: number): void {
  const pf = score.profitFactor === Infinity ? '∞' : score.profitFactor.toFixed(3);
  console.log(
    `  ${label.padEnd(11)} trades ${String(score.trades).padStart(4)} · ` +
    `win ${score.winRate.toFixed(1).padStart(5)}% · PF ${pf.padStart(6)} · ` +
    `net $${score.netProfit.toFixed(2).padStart(10)} · ` +
    `exp $${score.expectancy.toFixed(2).padStart(8)} · ` +
    `equity $${equity.toFixed(2)}`
  );
}

async function main(): Promise<void> {
  const bot = (arg('bot') ?? 'pro') as BotId;
  if (!STRATEGIES[bot]) {
    throw new Error(`--bot must be one of ${Object.keys(STRATEGIES).join(' | ')} (got "${bot}")`);
  }
  const snapshotName = arg('snapshot') ?? 'snapshot-mtf';
  const spendOos = flag('oos');
  const windows = argNum('windows') ?? 1;
  const windowDays = argNum('window-days');
  const warmupBars = argNum('warmup') ?? 500;

  const config: SimBotConfig = {
    riskLevel: 'medium',
    initialAmount: argNum('capital') ?? 10_000,
    maxPositions: argNum('max-positions') ?? 7,
    feePercent: 0.1,
    // Deterministic by default: the live slippage draw is random, and a
    // walk-forward result that moves between runs cannot be compared.
    slippagePercent: argNum('slippage') ?? 0,
    executionDelaySec: argNum('delay') ?? 3
  };

  const histories = loadHistories(snapshotName);
  // Loops, not `Math.min(...array)`: a multi-month 5M snapshot is hundreds of
  // thousands of bars, and spreading that many arguments blows the stack.
  let from = Infinity;
  let to = -Infinity;
  for (const h of histories) {
    for (const c of h.m5) {
      if (c.timestamp < from) from = c.timestamp;
      if (c.timestamp > to) to = c.timestamp;
    }
  }
  to += 1;

  const splits = windows > 1
    ? rollingWalkForward(
        from, to,
        windowDays !== undefined ? windowDays * 86_400_000 : Math.floor((to - from) / windows) * 2,
        Math.floor((to - from - (windowDays !== undefined ? windowDays * 86_400_000 : 0)) / Math.max(1, windows - 1)) || 1
      ).slice(0, windows)
    : [splitWalkForward(from, to)];

  const datasetKey = `${bot}:${snapshotName}:${new Date(from).toISOString().slice(0, 10)}..${new Date(to).toISOString().slice(0, 10)}`;
  const configHash = hashConfig({ ...config, bot, warmupBars });

  console.log(`\nWalk-forward · bot=${bot} · snapshot=${snapshotName} · ${histories.length} symbols`);
  console.log(`  range ${new Date(from).toISOString()} → ${new Date(to).toISOString()}`);
  console.log(`  config ${configHash} · capital $${config.initialAmount} · delay ${config.executionDelaySec}s · slippage ${config.slippagePercent}%\n`);

  const oosScores: RunScore[] = [];

  for (const [i, split] of splits.entries()) {
    console.log(`Window ${i + 1}/${splits.length}`);
    for (const w of [split.train, split.validation] as WalkForwardWindow[]) {
      const clipped = clip(histories, w);
      if (!clipped.length) {
        console.log(`  ${w.label.padEnd(11)} (no data in window)`);
        continue;
      }
      try {
        const result = await runReplay(STRATEGIES[bot], { histories: clipped, config, warmupBars });
        report(w.label, scoreRun(result.trades), result.finalEquity);
      } catch (e) {
        console.log(`  ${w.label.padEnd(11)} skipped: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (!spendOos) {
      console.log(`  ${'OOS'.padEnd(11)} NOT RUN — pass --oos to spend the out-of-sample budget`);
      continue;
    }

    // The budget guard. Throws when a DIFFERENT configuration has already
    // consumed this window — see assertOosUnspent for why that matters.
    assertOosUnspent(loadLedger(), `${datasetKey}#${i}`, configHash);

    const clipped = clip(histories, split.oos);
    if (!clipped.length) {
      console.log(`  ${'OOS'.padEnd(11)} (no data in window)`);
      continue;
    }
    const result = await runReplay(STRATEGIES[bot], { histories: clipped, config, warmupBars });
    const score = scoreRun(result.trades);
    report('OOS', score, result.finalEquity);
    oosScores.push(score);
    appendLedger({
      datasetKey: `${datasetKey}#${i}`,
      configHash,
      at: Date.now(),
      netProfit: score.netProfit
    });
  }

  if (oosScores.length) {
    const verdict = judgeSurvivor(oosScores);
    console.log(`\nSurvivor rule: ${verdict.survived ? 'PASS' : 'FAIL'} — ${verdict.reason}`);
    if (verdict.windowsSkipped) console.log(`  (${verdict.windowsSkipped} window(s) too thin to judge)`);
  }

  console.log(
    '\nFidelity notes: derivatives (OI / long-short) abstain in replay — no history exists;\n' +
    'spread is MODELLED, not measured; funding is absent unless a history is supplied.\n'
  );
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
