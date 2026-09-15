/**
 * Calibration study for derivativesRegime.ts (§Macro Layer, 2026-09-16).
 * ============================================================================
 * Mirrors fundingOrthogonality.ts's spirit — measure the REAL distribution
 * instead of asserting a threshold — but self-contained (no abBacktest.ts
 * snapshot dependency), because Bybit's public OI/Long-Short endpoints only
 * carry a SHORT window of high-resolution history:
 *
 *   intervalTime=1h, limit=200  -> ~8 days of hourly OI / L-S readings
 *   intervalTime=1d, limit=200  -> ~200 days, but too coarse for a 1H-cadence
 *                                  entry-time gate
 *
 * So this fetches live, right now, rather than reading a saved snapshot. Two
 * things get measured:
 *
 *   A. The 6-hour WINDOW |% change| distribution of Open Interest — what
 *      "OI_TREND_THRESHOLD_PCT" is actually being compared against. The
 *      original 3% guess was an hour-over-HOUR intuition; the window the code
 *      actually measures (fetchOpenInterestForSymbol, limit=6) is wider, so
 *      the right percentile to sit at needed checking, not assuming.
 *
 *   B. Whether "OI falling" during a volume+drop candidate bar actually
 *      predicts a WORSE forward 3-hour return than "OI not falling" on the
 *      same kind of bar — the entire empirical claim detectSellPressure
 *      makes. Swept across several candidate thresholds to pick the one with
 *      the clearest separation, not just the first one that produces SOME
 *      gap.
 *
 *   C. The buyRatio (Long/Short) distribution — this is the surprising one.
 *      The original design assumed a threshold symmetric around 0.5 (crowded
 *      at 0.65/0.35). The real distribution is NOT symmetric: Bybit's top-
 *      trader account ratio runs structurally long-biased across most of
 *      this universe (median observed ~0.73, not ~0.50) — a well-known retail
 *      long bias in crypto perps, not a bug in this measurement. A symmetric
 *      0.65/0.35 cutoff would have classified the MAJORITY of all readings as
 *      "crowded_long" and produced a signal that never discriminates
 *      anything. Percentile-based cutoffs from the actual distribution fix
 *      this.
 *
 * HONESTY, same as fundingOrthogonality.ts states for its own study: this is
 * ONE ~8-day window (2026-09-16), 30 symbols. Real, better than a guess, far
 * short of the funding study's 180-day/3,156-signal sample. Re-run
 * periodically as more history accumulates rather than treating this as
 * final.
 *
 * Usage: npx tsx scripts/derivativesCalibration.ts
 */

const SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT',
  'LINKUSDT', 'TRXUSDT', 'LTCUSDT', 'DOTUSDT', 'BCHUSDT', 'NEARUSDT', 'SUIUSDT', 'APTUSDT',
  'ARBUSDT', 'OPUSDT', 'ATOMUSDT', 'UNIUSDT', 'FILUSDT', 'INJUSDT', 'TIAUSDT', 'SEIUSDT',
  'WLDUSDT', 'ENAUSDT', 'HBARUSDT', 'AAVEUSDT', 'ICPUSDT', 'ETCUSDT'
];

const BASE = 'https://api.bybit.com/v5/market';

interface OiPoint { oi: number; ts: number }
interface Kline { ts: number; open: number; high: number; low: number; close: number; volume: number }

async function fetchJson(url: string): Promise<{ list: Record<string, string>[] } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const j = (await res.json()) as { retCode: number; result?: { list?: Record<string, string>[] } };
    return j.retCode === 0 && j.result?.list ? { list: j.result.list } : null;
  } catch {
    return null;
  }
}

async function fetchOiHistory(symbol: string): Promise<OiPoint[]> {
  const r = await fetchJson(`${BASE}/open-interest?category=linear&symbol=${symbol}&intervalTime=1h&limit=200`);
  if (!r) return [];
  return r.list
    .map((x) => ({ oi: Number(x.openInterest), ts: Number(x.timestamp) }))
    .filter((p) => Number.isFinite(p.oi) && Number.isFinite(p.ts))
    .sort((a, b) => a.ts - b.ts);
}

async function fetchLongShortHistory(symbol: string): Promise<number[]> {
  const r = await fetchJson(`${BASE}/account-ratio?category=linear&symbol=${symbol}&period=1h&limit=200`);
  if (!r) return [];
  return r.list.map((x) => Number(x.buyRatio)).filter(Number.isFinite);
}

async function fetchHourlyKlines(symbol: string): Promise<Kline[]> {
  const r = await fetchJson(`${BASE}/kline?category=linear&symbol=${symbol}&interval=60&limit=200`);
  if (!r) return [];
  return (r.list as unknown as string[][])
    .map((x) => ({ ts: Number(x[0]), open: Number(x[1]), high: Number(x[2]), low: Number(x[3]), close: Number(x[4]), volume: Number(x[5]) }))
    .sort((a, b) => a.ts - b.ts);
}

function relativeVolume(candles: Kline[], i: number, lookback = 20): number | undefined {
  if (i < lookback) return undefined;
  const hist = candles.slice(i - lookback, i);
  const avg = hist.reduce((s, c) => s + c.volume, 0) / hist.length;
  if (!(avg > 0)) return undefined;
  return candles[i].volume / avg;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return NaN;
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length))];
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

async function main() {
  const windowOiChanges: number[] = [];
  const buyRatios: number[] = [];
  const candidates: { symbol: string; oiWindowChangePct: number; fwdReturn3h: number }[] = [];

  for (const symbol of SYMBOLS) {
    const [oi, klines, ls] = await Promise.all([
      fetchOiHistory(symbol),
      fetchHourlyKlines(symbol),
      fetchLongShortHistory(symbol)
    ]);
    if (oi.length < 10 || klines.length < 40) {
      console.error(`[skip] ${symbol}: insufficient data (oi=${oi.length}, klines=${klines.length})`);
      continue;
    }
    buyRatios.push(...ls);

    // A. 6-hour window OI % change — matches fetchOpenInterestForSymbol's
    // own limit=6 window in marketDataService.ts.
    for (let i = 6; i < oi.length; i++) {
      const before = oi[i - 6].oi;
      if (before > 0) windowOiChanges.push(((oi[i].oi - before) / before) * 100);
    }

    // B. Candidate sell-pressure bars: relVol >= 2.0 AND drop <= -1.5% (the
    // two non-OI legs of detectSellPressure, held fixed while sweeping the
    // OI threshold below). Nearest-OI-reading-within-40-minutes lookup
    // tolerates the two endpoints' timestamps not landing on the same second.
    const oiAt = (ts: number): OiPoint | null => {
      let best: OiPoint | null = null;
      let bestDiff = Infinity;
      for (const p of oi) {
        const d = Math.abs(p.ts - ts);
        if (d < bestDiff) { bestDiff = d; best = p; }
      }
      return bestDiff < 40 * 60 * 1000 ? best : null;
    };

    for (let i = 21; i < klines.length - 3; i++) {
      const rv = relativeVolume(klines, i, 20);
      if (rv === undefined || rv < 2.0) continue;
      const dropPct = ((klines[i].close - klines[i - 1].close) / klines[i - 1].close) * 100;
      if (dropPct > -1.5) continue;

      const oiNow = oiAt(klines[i].ts);
      const oiBefore = oiAt(klines[Math.max(0, i - 6)].ts);
      if (!oiNow || !oiBefore || oiBefore.oi <= 0) continue;

      candidates.push({
        symbol,
        oiWindowChangePct: ((oiNow.oi - oiBefore.oi) / oiBefore.oi) * 100,
        fwdReturn3h: ((klines[i + 3].close - klines[i].close) / klines[i].close) * 100
      });
    }
  }

  const absOiSorted = windowOiChanges.map(Math.abs).sort((a, b) => a - b);
  console.log(`=== A. OI 6-hour window |% change|, ${SYMBOLS.length} symbols, n=${absOiSorted.length} ===`);
  for (const p of [50, 60, 70, 75, 80, 90, 95, 99]) {
    console.log(`  p${p}  ${percentile(absOiSorted, p).toFixed(3)}%`);
  }

  console.log(`\n=== B. Candidate bars (relVol>=2, drop<=-1.5%), n=${candidates.length} ===`);
  console.log('  threshold | falling n | falling avgFwd3h | rest n | rest avgFwd3h | gap');
  for (const thresh of [1.0, 1.5, 2.0, 3.0]) {
    const falling = candidates.filter((c) => c.oiWindowChangePct <= -thresh);
    const rest = candidates.filter((c) => c.oiWindowChangePct > -thresh);
    const fAvg = mean(falling.map((c) => c.fwdReturn3h));
    const rAvg = mean(rest.map((c) => c.fwdReturn3h));
    console.log(`  -${thresh}%     | ${String(falling.length).padStart(9)} | ${fAvg.toFixed(3).padStart(17)}% | ${String(rest.length).padStart(6)} | ${rAvg.toFixed(3).padStart(13)}% | ${(fAvg - rAvg).toFixed(3)}pp`);
  }

  const brSorted = buyRatios.slice().sort((a, b) => a - b);
  console.log(`\n=== C. buyRatio (Long/Short) distribution, n=${brSorted.length} ===`);
  for (const p of [1, 5, 10, 25, 50, 75, 90, 95, 99]) {
    console.log(`  p${p}  ${percentile(brSorted, p).toFixed(3)}`);
  }
  console.log(`  min ${brSorted[0]?.toFixed(3)}  max ${brSorted[brSorted.length - 1]?.toFixed(3)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
