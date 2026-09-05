/**
 * Stop-test for the funding gate. See SIM_BOTS.md.
 *
 * The whole case for adding funding is that it is ORTHOGONAL to the seven
 * price indicators the engines already weight. If it correlates with the
 * existing SignalScore, it is a redundant eighth copy of the same information
 * and the stage is not worth its complexity.
 *
 * This measures that directly: at every historical funding settlement, compute
 * what Pro's own Layer 1 would have said, and correlate the two series.
 *
 *   |rho| <= 0.3  -> orthogonal enough to keep
 *   |rho| >  0.3  -> the gate does not earn its place; remove it
 *
 * Usage (after scripts/abBacktest.ts snapshot):
 *   npx tsx scripts/fundingOrthogonality.ts
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { detectProRegime, evaluateProSignals } from '@cde/engine/analysis';
import { annualisedFundingPct, evaluateFundingGate, FUNDING_PERIODS_PER_YEAR } from '@cde/engine/analysis';
import type { Candle } from '@cde/engine/execution';

const OUT_DIR = join(process.cwd(), 'backtest-ab');
const FUTURES = 'https://fapi.binance.com/fapi/v1';

interface Snapshot {
  from: string; to: string;
  histories: { symbol: string; candles: Candle[] }[];
}

interface FundingPoint { fundingTime: number; fundingRate: number }

async function fetchFundingHistory(symbol: string, startMs: number, endMs: number): Promise<FundingPoint[]> {
  const out: FundingPoint[] = [];
  let cursor = startMs;
  let guard = 0;
  while (cursor < endMs && guard++ < 100) {
    const url = `${FUTURES}/fundingRate?symbol=${symbol}&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
    const rows = (await res.json()) as { fundingTime: number; fundingRate: string }[];
    if (!Array.isArray(rows) || !rows.length) break;
    for (const r of rows) {
      const rate = Number(r.fundingRate);
      if (Number.isFinite(rate)) out.push({ fundingTime: Number(r.fundingTime), fundingRate: rate });
    }
    const last = out[out.length - 1].fundingTime;
    if (last <= cursor) break;
    cursor = last + 1;
    await new Promise((r) => setTimeout(r, 200));
  }
  return out;
}

function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : NaN;
}

async function main() {
  const snapPath = join(OUT_DIR, 'snapshot.json');
  if (!existsSync(snapPath)) throw new Error(`no snapshot at ${snapPath} — run abBacktest.ts snapshot first`);
  const snap = JSON.parse(readFileSync(snapPath, 'utf8')) as Snapshot;

  const allSignal: number[] = [];
  const allFunding: number[] = [];

  console.log(`window ${snap.from} → ${snap.to}\n`);
  console.log(`  ${'symbol'.padEnd(10)}${'n'.padStart(6)}${'rho'.padStart(9)}`);

  for (const h of snap.histories) {
    const startMs = h.candles[0].timestamp;
    const endMs = h.candles[h.candles.length - 1].timestamp;
    const funding = await fetchFundingHistory(h.symbol, startMs, endMs);
    if (!funding.length) { console.log(`  ${h.symbol.padEnd(10)} no funding history`); continue; }

    const sig: number[] = [];
    const fund: number[] = [];

    for (const f of funding) {
      // Index of the last candle at or before this settlement.
      let idx = -1;
      for (let i = 0; i < h.candles.length; i++) {
        if (h.candles[i].timestamp <= f.fundingTime) idx = i; else break;
      }
      if (idx < 60) continue;

      const slice = h.candles.slice(0, idx + 1);
      const price = h.candles[idx].close;
      const regime = detectProRegime(slice, price);
      const ev = evaluateProSignals(slice, price, 0, regime, 50);

      // Signed conviction: +confidence for BUY, -confidence for SELL, 0 for
      // HOLD. This is the quantity the funding gate would have to be redundant
      // WITH for the stage to be pointless.
      const signed = ev.action === 'BUY' ? ev.confidence : ev.action === 'SELL' ? -ev.confidence : 0;
      sig.push(signed);
      fund.push(annualisedFundingPct(f.fundingRate));
    }

    const rho = pearson(sig, fund);
    console.log(`  ${h.symbol.padEnd(10)}${String(sig.length).padStart(6)}${rho.toFixed(3).padStart(9)}`);
    allSignal.push(...sig);
    allFunding.push(...fund);
  }

  const pooled = pearson(allSignal, allFunding);
  console.log(`\n  pooled n=${allSignal.length}  rho=${pooled.toFixed(4)}`);
  const verdict = Math.abs(pooled) <= 0.3
    ? 'ORTHOGONAL — the funding gate adds information the price indicators do not carry.'
    : 'REDUNDANT — |rho| > 0.3. The gate does not earn its complexity; remove it.';
  console.log(`\n  ${verdict}`);

  // How often would the gate actually bite? A gate that never fires is dead
  // weight; one that fires constantly is a de-facto ban on a whole direction.
  // Counted only where Layer 1 actually wanted the crowded side, since that is
  // the only situation in which the gate is consulted.
  let considered = 0, trimmed = 0, vetoed = 0;
  for (let i = 0; i < allSignal.length; i++) {
    if (allSignal[i] === 0) continue;
    const direction = allSignal[i] > 0 ? 'LONG' : 'SHORT';
    const v = evaluateFundingGate({ lastFundingRate: allFunding[i] / 100 / FUNDING_PERIODS_PER_YEAR, at: 0 }, direction, 0);
    considered++;
    if (v.kind === 'veto') vetoed++;
    else if (v.kind === 'trim') trimmed++;
  }
  const pct = (n: number) => considered ? ((n / considered) * 100).toFixed(1) : '0.0';
  console.log(`\n  firing rate over ${considered} directional signals:`);
  console.log(`    trimmed ${trimmed} (${pct(trimmed)}%)   vetoed ${vetoed} (${pct(vetoed)}%)`);

  // The distribution the thresholds have to be calibrated against. Reported as
  // the funding FACED by the signalled side (positive = paying to hold), which
  // is exactly the quantity the gate tests.
  const faced = allSignal
    .map((s, i) => (s === 0 ? null : s > 0 ? allFunding[i] : -allFunding[i]))
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  const q = (p: number) => faced[Math.min(faced.length - 1, Math.floor((faced.length - 1) * p))];
  console.log(`\n  annualised funding FACED by the signalled side (%/yr):`);
  console.log(
    `    p50 ${q(0.5).toFixed(1)}   p75 ${q(0.75).toFixed(1)}   p90 ${q(0.9).toFixed(1)}` +
    `   p95 ${q(0.95).toFixed(1)}   p99 ${q(0.99).toFixed(1)}   max ${q(1).toFixed(1)}\n`
  );
}

main().catch((e) => { console.error(`\n${e instanceof Error ? e.message : e}`); process.exit(1); });

