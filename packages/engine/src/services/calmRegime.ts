/**
 * The fixed scalp ladder — SL 2.3% / TP1 1.8% / TP2 3.5% — and its two
 * independent widening conditions.
 * ============================================================================
 * Operator decision (2026-09-11): every sim bot trades ONE fixed ladder, so
 * small moves get taken instead of chased:
 *
 *     SL = 2.3%      TP1 = 1.8% (fast 50% partial)      TP2 = 3.5%
 *
 * TP1 is FIXED at 1.8% — it is never widened AND never narrowed to a bot's own
 * dynamic target. A previous revision floored it at `min(1.8, dynamicTp1)`,
 * which quietly gave Path and Bybit a 1.5% target; the operator wants 1.8
 * everywhere. TP1 stays 1.8% under BOTH widening conditions below — the whole
 * point is a fast small profit. That makes TP1's own reward:risk deliberately
 * poor (1.8/4.2 = 0.43 at the widest stop), which is why the R:R gate in every
 * bot is measured against TP2, not TP1 — and why TP2 scales with the stop
 * (`max(3.5%, 1.2 × SL)`) so the gate stays satisfiable instead of silently
 * rejecting every widened-stop trade.
 *
 * WIDENING CONDITION 1 — a buying surge (2026-09-11). When a lot of buyers
 * show up at once, a flat 2.3% stop is inside the noise of the move and gets
 * wicked out of a trade that was right. Only then does the stop widen, to the
 * bot's OWN dynamic (ATR / structure) stop — the number that already
 * reflects that symbol's real volatility — clamped to [2.3%, MAX_LOSS_PERCENT].
 *
 * WIDENING CONDITION 2 — the noise floor (2026-09-14, opt-in via
 * `noiseFloorStop`). Independent of any surge: some symbols' ORDINARY bars
 * are simply wider than 2.3% (a fat-tailed micro-cap), so a flat stop there
 * is inside the noise on EVERY trade, not just surges. The floor is the wider
 * of 1.6 × ATR and the symbol's own 90th-percentile bar width
 * (`measureStopNoise`, `NOISE_PERCENTILE`) — see that function's doc comment
 * for why ATR alone underestimates the bad bar by ~1.8× on every symbol
 * measured. When even the 4.2% ceiling sits inside that noise, the trade is
 * refused outright (`tooVolatile`) rather than opened with a coin-flip stop.
 * The wider of the two conditions' results wins when both apply.
 */

import type { Candle } from './tradeEngine';
import { computeRelativeVolume, calculateATR } from './tradeEngine';
import { MAX_LOSS_PERCENT } from './exitPolicy';

/** The fixed ladder, as percentages of entry. */
export const FIXED_SL_PCT = 2.3;
export const FIXED_TP1_PCT = 1.8;
export const FIXED_TP2_PCT = 3.5;

/** Last bar's volume must be at least this multiple of its own 20-bar average
 *  to count as "a lot of buyers". Volume alone is direction-blind — a spike can
 *  just as easily be a wave of SELLERS — so `isBuyingSurge` also requires the
 *  bar to close green. */
export const SURGE_REL_VOLUME = 2.0;
export const SURGE_VOLUME_LOOKBACK = 20;

/** The stop may widen only within these bounds during a surge. */
export const SURGE_MIN_SL_PCT = FIXED_SL_PCT;
export const SURGE_MAX_SL_PCT = MAX_LOSS_PERCENT;

/** TP2 must keep this reward:risk against the (possibly widened) stop, because
 *  TP2 is what every bot's R:R gate is measured on in this ladder. Matches the
 *  bots' own `minRewardRisk` / `minRR`. */
export const TP2_MIN_REWARD_RISK = 1.2;

/**
 * "A lot of buyers": the last closed bar traded at least SURGE_REL_VOLUME times
 * its own recent average volume AND closed up. Returns false when there is not
 * enough history to judge — an unknown surge is not a surge.
 */
export function isBuyingSurge(
  candles: Candle[] | undefined,
  lookback: number = SURGE_VOLUME_LOOKBACK,
  now: number = Date.now()
): boolean {
  if (!candles || candles.length < 2) return false;
  const relVolume = computeRelativeVolume(candles, lookback, now);
  if (relVolume === undefined || relVolume < SURGE_REL_VOLUME) return false;
  const last = candles[candles.length - 1];
  return last.close > last.open;
}

/**
 * THE SECOND EXCEPTION — a stop inside the bar's own noise.
 * ----------------------------------------------------------------------------
 * The surge rule above widens the stop when a lot of buyers show up at once.
 * It does NOT cover the quieter, more common version of the same failure: a
 * symbol whose ordinary 5M/15M bar is simply bigger than 2.3%.
 *
 * ATR is the average true range of one bar. A stop placed at 1.0 × ATR is
 * taken out by a perfectly ordinary candle roughly a third of the time — not
 * because the thesis was wrong, but because that is what a bar of that symbol
 * looks like. The observed case: a micro-cap entered at 94% confidence and
 * stopped out 9 minutes later (two 5M bars), having never moved against the
 * thesis by more than one bar's normal range.
 *
 * `PRO_STOP_ATR_MULT` in proAlgEngine.ts already encodes the answer — Pro
 * derives its stop as `atrPercent × 1.6` — and then the fixed ladder overwrites
 * it with 2.3%. This constant is that same 1.6, applied as a FLOOR under the
 * ladder for every bot instead of a number one bot computes and discards.
 *
 * At 1.6 × ATR a routine bar clears the stop ~10-15% of the time; at 1.0 × ATR
 * it is ~35-40%. The gap between those two numbers is the churn.
 */
export const MIN_STOP_ATR_MULT = 1.6;

/**
 * ...and why the mean alone is not enough.
 * ----------------------------------------------------------------------------
 * ATR is a MEAN, and bar ranges are fat-tailed, so the mean systematically
 * understates the bar that actually takes a stop out. Measured on live 5M data
 * (2026-09-14, 200 bars each):
 *
 *   symbol     ATR%    p90%    p90/ATR
 *   BTCUSDT    0.17    0.30      1.82
 *   ETHUSDT    0.21    0.38      1.78
 *   SOLUSDT    0.23    0.40      1.78
 *   DOGEUSDT   0.23    0.39      1.70
 *   FLOCKUSDT  1.42    2.74      1.92
 *
 * The ratio is ~1.8 everywhere — majors and micro-caps alike — so a 1.6 × ATR
 * floor lands just UNDER the bad bar on every symbol, which is the wrong side
 * of it. On FLOCK, 1.6 × ATR = 2.28%: indistinguishable from the flat 2.3% it
 * was meant to replace, while 14% of that symbol's bars were wider than 2.3%
 * (25% odds of a stop-out within two bars — the observed trade stopped out in
 * nine minutes).
 *
 * So the floor is the WIDER of the two readings: `1.6 × ATR` for the general
 * level, and the 90th percentile of true range for the tail. On a
 * normally-shaped symbol they agree; on a fat-tailed one the percentile wins,
 * which is exactly where the flat ladder was losing money.
 */
export const NOISE_PERCENTILE = 90;

/** True range of each bar as a percent of its own close. */
function trueRangePercents(candles: Candle[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    if (!(c.close > 0)) continue;
    out.push((Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)) / c.close) * 100);
  }
  return out;
}

/**
 * The width of a bad-but-entirely-ordinary bar: the `percentile`-th true range
 * in the window. This is the number a stop has to sit outside of — not the
 * mean, which every symbol measured overstates its own calm by ~1.8×.
 */
export function badBarPercent(candles: Candle[] | undefined, percentile: number = NOISE_PERCENTILE): number {
  if (!candles || candles.length < 2) return 0;
  const tr = trueRangePercents(candles).sort((a, b) => a - b);
  if (tr.length === 0) return 0;
  return tr[Math.min(tr.length - 1, Math.floor((percentile / 100) * tr.length))];
}

/**
 * ATR as a percent of the last close, on whatever timeframe the candles are.
 * This is the number every bot already has in some private local; exposing one
 * spelling of it here keeps the four call sites honest.
 */
export function atrPercentOf(candles: Candle[] | undefined, period: number = 14): number {
  if (!candles || candles.length < 2) return 0;
  const close = candles[candles.length - 1].close;
  if (!(close > 0)) return 0;
  const { atr } = calculateATR(candles, period);
  return atr > 0 ? (atr / close) * 100 : 0;
}

/**
 * The smallest stop that survives one ordinary bar, as a percent of entry —
 * the wider of `MIN_STOP_ATR_MULT × atrPercent` and the bad-bar percentile.
 * Returns 0 when volatility is unknown, which makes every caller a no-op: an
 * unmeasured symbol keeps the flat ladder exactly as before.
 */
export function noiseFloorStopPct(atrPercent: number | undefined, badBarPct: number = 0): number {
  const fromAtr = typeof atrPercent === 'number' && Number.isFinite(atrPercent) && atrPercent > 0
    ? atrPercent * MIN_STOP_ATR_MULT
    : 0;
  const fromTail = Number.isFinite(badBarPct) && badBarPct > 0 ? badBarPct : 0;
  return Math.max(fromAtr, fromTail);
}

/**
 * Everything the noise floor needs, measured off one candle series: the steady
 * ATR, the fat tail, and whether the tape is expanding right now. This is what
 * the four bots call — one function so the three readings cannot drift apart
 * between them.
 */
export interface StopNoise {
  /** Steady ATR on the measured timeframe, as a percent of close. */
  atrPercent: number;
  /** The `NOISE_PERCENTILE`-th true range — the bad-but-ordinary bar. */
  badBarPercent: number;
  expansion: VolatilityExpansion;
  /** The stop floor these three imply. 0 = nothing measurable. */
  floorPct: number;
}

export function measureStopNoise(candles: Candle[] | undefined, atrPeriod: number = 14): StopNoise {
  const atrPercent = atrPercentOf(candles, atrPeriod);
  const badBar = badBarPercent(candles);
  const expansion = detectVolatilityExpansion(candles);
  return {
    atrPercent,
    badBarPercent: badBar,
    expansion,
    floorPct: noiseFloorStopPct(effectiveAtrPercent(atrPercent, expansion), badBar)
  };
}

/**
 * Volatility that is expanding RIGHT NOW, which a 14-bar ATR cannot see yet.
 * ----------------------------------------------------------------------------
 * `noiseFloorStopPct` answers "how big is a normal bar on this symbol". It
 * cannot answer "did the tape just change", because ATR(14) is an average: two
 * violent bars inside a window of twelve quiet ones barely move it. That is
 * exactly the shape of the entry that hurts — a cascade begins, the fresh bars
 * are 3× normal, ATR(14) still reads calm, the bot sizes a 2.3% stop against a
 * tape that is now printing 2% bars, and the next candle takes it.
 *
 * So compare the last few bars against the longer average directly. A ratio of
 * 2.0 means the current tape is twice its own recent normal.
 */
export const VOLATILITY_EXPANSION_RATIO = 2.0;
export const EXPANSION_FAST_BARS = 3;
export const EXPANSION_SLOW_BARS = 20;

export interface VolatilityExpansion {
  /** Mean true range of the last `EXPANSION_FAST_BARS`, as a percent of close. */
  fastAtrPercent: number;
  /** Mean true range of the last `EXPANSION_SLOW_BARS`, as a percent of close. */
  slowAtrPercent: number;
  /** fast / slow. 1.0 = steady tape. Returns 0 when there is not enough history. */
  ratio: number;
  /** True once `ratio` clears VOLATILITY_EXPANSION_RATIO — the tape just changed. */
  expanding: boolean;
}

function trueRangePercentSeries(candles: Candle[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    if (!(c.close > 0)) continue;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
    out.push((tr / c.close) * 100);
  }
  return out;
}

/**
 * Measures whether the newest bars are materially wider than the symbol's own
 * recent normal. Unknown (too little history) reads as "not expanding" — an
 * unmeasured tape is not evidence of a cascade.
 */
export function detectVolatilityExpansion(
  candles: Candle[] | undefined,
  fastBars: number = EXPANSION_FAST_BARS,
  slowBars: number = EXPANSION_SLOW_BARS
): VolatilityExpansion {
  const idle: VolatilityExpansion = { fastAtrPercent: 0, slowAtrPercent: 0, ratio: 0, expanding: false };
  if (!candles || candles.length < slowBars + 1) return idle;

  const tr = trueRangePercentSeries(candles);
  if (tr.length < slowBars) return idle;

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const fastAtrPercent = mean(tr.slice(-fastBars));
  const slowAtrPercent = mean(tr.slice(-slowBars));
  if (!(slowAtrPercent > 0)) return idle;

  const ratio = fastAtrPercent / slowAtrPercent;
  return {
    fastAtrPercent,
    slowAtrPercent,
    ratio,
    expanding: ratio >= VOLATILITY_EXPANSION_RATIO
  };
}

/**
 * The volatility a stop must actually survive: the WIDER of the symbol's steady
 * ATR and its current expanding tape. During an expansion the fresh bars are
 * what the next candle will look like, so they — not the lagging average — set
 * the floor.
 */
export function effectiveAtrPercent(steadyAtrPercent: number | undefined, expansion?: VolatilityExpansion): number {
  const steady = typeof steadyAtrPercent === 'number' && Number.isFinite(steadyAtrPercent) && steadyAtrPercent > 0
    ? steadyAtrPercent
    : 0;
  if (!expansion?.expanding) return steady;
  return Math.max(steady, expansion.fastAtrPercent);
}

export interface LadderPercents {
  slPct: number;
  tp1Pct: number;
  tp2Pct: number;
  /** True when the stop was widened by a buying surge — for telemetry/logging. */
  surged: boolean;
  /** True when the stop was widened off the flat 2.3% because that sat inside
   *  one bar's ATR. Independent of `surged`; either can widen alone. */
  noiseWidened: boolean;
  /** True when even MAX_LOSS_PERCENT sits inside one bar's noise — the symbol is
   *  too volatile for this ladder at all, and the caller should refuse the
   *  trade rather than open one whose stop is a coin flip. */
  tooVolatile: boolean;
  /** The noise floor that produced the two flags above, for the reject message. */
  noiseFloorPct: number;
}

/**
 * The ladder for one trade. `dynamicSlPct` is the stop the bot would have used
 * on its own (ATR / structure / range), as a percent of entry — read ONLY
 * during a surge. `noiseFloorPct` comes from `measureStopNoise` on the bot's
 * own entry timeframe; omitting it disables the noise floor.
 */
export function resolveLadderPercents(input: {
  dynamicSlPct?: number;
  buyingSurge?: boolean;
  /** The already-measured noise floor from `measureStopNoise().floorPct`.
   *  Omitted (or 0) disables the floor entirely and the flat ladder stands. */
  noiseFloorPct?: number;
  /** Direction of the trade this ladder is for (operator decision
   *  2026-09-18: "sell-side noise must stop at 2.3%"). SHORT (`false`) is
   *  hard-locked to FIXED_SL_PCT — neither a buying surge NOR the noise
   *  floor may widen a SHORT's stop past it; both mechanisms stay exactly as
   *  they were for LONG (up to SURGE_MAX_SL_PCT/4.2%). Omitted → LONG, so
   *  every pre-existing caller not yet updated to pass direction keeps its
   *  current behavior unchanged. */
  isLong?: boolean;
}): LadderPercents {
  const isLong = input.isLong !== false;
  const maxSlPct = isLong ? SURGE_MAX_SL_PCT : FIXED_SL_PCT;

  const noiseFloorPct = typeof input.noiseFloorPct === 'number' && Number.isFinite(input.noiseFloorPct) && input.noiseFloorPct > 0
    ? input.noiseFloorPct
    : 0;

  let slPct = FIXED_SL_PCT;

  if (input.buyingSurge) {
    const dyn = typeof input.dynamicSlPct === 'number' && Number.isFinite(input.dynamicSlPct)
      ? input.dynamicSlPct
      : FIXED_SL_PCT;
    slPct = Math.min(maxSlPct, Math.max(SURGE_MIN_SL_PCT, dyn));
  }
  // Reflects whether the stop ACTUALLY widened, not just whether a surge was
  // detected — for a SHORT, maxSlPct === FIXED_SL_PCT, so the line above can
  // never move slPct past 2.3% regardless of the surge input.
  const surged = slPct > FIXED_SL_PCT;

  // The noise floor applies on top of whatever the surge rule decided: a surge
  // stop that still sits inside one bar's range is not a stop either. Same
  // asymmetric cap — a SHORT's noise floor can widen only up to FIXED_SL_PCT.
  const preNoiseSlPct = slPct;
  if (noiseFloorPct > slPct) slPct = Math.min(maxSlPct, noiseFloorPct);
  const noiseWidened = slPct > preNoiseSlPct;

  const widened = surged || noiseWidened;
  return {
    slPct,
    tp1Pct: FIXED_TP1_PCT,
    tp2Pct: widened ? Math.max(FIXED_TP2_PCT, slPct * TP2_MIN_REWARD_RISK) : FIXED_TP2_PCT,
    surged,
    noiseWidened,
    // A SHORT's effective ceiling is FIXED_SL_PCT now, not SURGE_MAX_SL_PCT —
    // noise that would have been an acceptable (if wide) LONG stop can be too
    // volatile for a SHORT's tighter cap, and the trade is correctly refused
    // rather than given a stop the noise floor says is too tight to be real.
    tooVolatile: noiseFloorPct > maxSlPct,
    noiseFloorPct
  };
}
