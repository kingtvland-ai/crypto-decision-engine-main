/**
 * Derivatives regime — Open Interest, Long/Short ratio, and a sell-pressure
 * proxy built entirely from Bybit's own free public data.
 * ============================================================================
 * Added 2026-09-16 (operator request) as the Macro Layer's derivatives leg,
 * alongside the pre-existing funding-rate gate (fundingRate.ts) — this module
 * completes the three free Bybit V5 signals the operator asked for:
 * Open Interest, Funding Rate (already existed, was fetched but never WIRED
 * into a live decision — see intradayEngine.ts), and the top-trader
 * Long/Short account ratio.
 *
 * SELL-PRESSURE PROXY. The operator's original ask included a Whale Alert
 * integration ("large wallet → exchange transfer = block the asset"). Verified
 * 2026-09-15: Whale Alert has NO free API tier ($29.95-$699/mo), so this is a
 * same-signal, zero-cost substitute built from data we already fetch:
 *
 *   a big volume spike + a sharp price drop + Open Interest FALLING
 *
 * The OI direction is what disambiguates a real distribution event from a
 * healthy dip-buy: a red candle with volume on RISING OI is fresh leveraged
 * selling meeting fresh buying (a normal, tradeable move) — the same red
 * candle on FALLING OI is capital actually leaving the contract, which is the
 * signature a large exchange-bound transfer would also produce (dump →
 * unwind → OI contracts). It will not catch every Whale Alert case (an
 * over-the-counter dump that never touches the derivatives book at all is
 * invisible here), but it catches the shape that actually hurt this system:
 * LA and FLOCK both broke down with a volume spike and OI contraction before
 * their SL/emergency-exit fired (2026-09-15 session).
 *
 * CALIBRATION (2026-09-16, scripts/derivativesCalibration.ts). Bybit's OI/L-S
 * public endpoints only carry ~8 days of hourly history (vs funding's much
 * deeper feed), so this is a smaller, live-fetched study — 30 symbols, real
 * data, but nowhere near fundingRate.ts's 180-day/3,156-signal sample. Two
 * findings from it corrected the original launch-day guesses:
 *
 *   1. OI_TREND_THRESHOLD_PCT was guessed at 3% (an hour-over-hour intuition)
 *      but the code actually measures a 6-HOUR WINDOW change. Measured
 *      distribution of that window's |% change| (n=5,820): p50 0.88%, p75
 *      1.77%, p90 3.18% — so 3% was sitting at ~p90, far rarer than intended.
 *      Swept 1/1.5/2/3% as the sell-pressure OI-falling cutoff against 91
 *      volume+drop candidate bars' forward 3h return: -1.5% gave the widest
 *      separation (falling n=15, avg −0.65% vs not-falling n=76, avg +0.14%
 *      — a 0.80pp gap, the largest of the four tested) while still firing
 *      often enough to matter. Set to 1.5%.
 *
 *   2. LONG_SHORT_CROWDED_RATIO was guessed as a single threshold symmetric
 *      around 0.5 (crowded at 0.65/0.35). The REAL buyRatio distribution
 *      across this universe is NOT symmetric — median ~0.73, p5 0.62, p95
 *      0.78 (n=6,000). Bybit's top-trader account ratio runs structurally
 *      long-biased on most of this universe (a documented retail long-bias
 *      in crypto perps, not a measurement bug — sanity-checked against a
 *      live curl on BTCUSDT alone, which read ~0.57-0.58, consistent with
 *      the broader set running hotter). A symmetric 0.65 cutoff would have
 *      classified the MAJORITY of all readings as "crowded_long" and never
 *      discriminated anything. Replaced with two independent, distribution-
 *      derived thresholds (~p95 / ~p5) instead of one symmetric split.
 *
 * Re-run the script periodically as more history accumulates; do not treat
 * these as final the way the funding study's are.
 *
 * NO NETWORK CALLS LIVE HERE, matching fundingRate.ts's separation — fetching
 * belongs to the caller (see fetchOpenInterest / fetchLongShortRatio in
 * marketDataService.ts) so this module stays pure, synchronous and testable.
 */

import { Candle, computeRelativeVolume } from './tradeEngine';

/** One Open Interest reading, oldest-to-newest is NOT assumed — callers pass
 *  whatever order Bybit returned (newest-first) and this module sorts. */
export interface OpenInterestPoint {
  timestamp: number;
  /** Contracts (or base-asset units) held open, Bybit's raw `openInterest`. */
  openInterest: number;
}

/** Bybit's top-trader account Long/Short ratio for one snapshot. buyRatio +
 *  sellRatio == 1.0 by construction (Bybit's own invariant, not enforced
 *  here). */
export interface LongShortPoint {
  timestamp: number;
  buyRatio: number;
  sellRatio: number;
}

export type OpenInterestTrend = 'rising' | 'falling' | 'flat' | 'unknown';

/** Open Interest must move at least this much over the supplied window
 *  (typically 6 hours — fetchOpenInterestForSymbol's own window) to count as
 *  a real trend rather than noise. CALIBRATED 2026-09-16
 *  (scripts/derivativesCalibration.ts): the 6h-window |% change| distribution
 *  runs p50 0.88% / p75 1.77% / p90 3.18% (n=5,820, 30 symbols); swept as the
 *  sell-pressure OI-falling cutoff against 91 candidate bars, 1.5% gave the
 *  widest forward-3h-return separation (falling avg −0.65% vs not-falling
 *  avg +0.14%, a 0.80pp gap — the largest of {1, 1.5, 2, 3}%) while still
 *  firing often enough (n=15/91) to be a usable signal, not a rare tail. */
export const OI_TREND_THRESHOLD_PCT = 1.5;

/** buyRatio at/above this = crowded long. CALIBRATED 2026-09-16
 *  (scripts/derivativesCalibration.ts): the ORIGINAL design assumed a
 *  threshold symmetric around 0.5. The real distribution is not symmetric —
 *  Bybit's top-trader account ratio runs structurally long-biased across
 *  most of this universe (median ~0.73, n=6,000) — a known retail long-bias
 *  in crypto perps, not a measurement error. This is pinned near the
 *  measured p95 (0.78), a genuine upper tail rather than "above the
 *  (skewed) middle". */
export const LONG_SHORT_CROWDED_LONG_RATIO = 0.78;

/** buyRatio at/below this = crowded short. CALIBRATED 2026-09-16, pinned near
 *  the measured p5 (0.62) — NOT the mirror of
 *  LONG_SHORT_CROWDED_LONG_RATIO (1 - 0.78 = 0.22 would almost never fire,
 *  since buyRatio's observed minimum in this sample was 0.54). See
 *  LONG_SHORT_CROWDED_LONG_RATIO's doc comment for why the distribution
 *  isn't symmetric in the first place. */
export const LONG_SHORT_CROWDED_SHORT_RATIO = 0.62;

/** classifyOpenInterestTrend's verdict, plus the % change that produced it —
 *  carried through so callers can log/display the actual number, not just
 *  the bucket. */
export interface OpenInterestVerdict {
  trend: OpenInterestTrend;
  /** (newest - oldest) / oldest * 100 over the supplied window. 0 when there
   *  is not enough history to compute a trend. */
  changePercent: number;
}

/**
 * Reads OI direction over whatever window the caller fetched (typically a
 * handful of hourly points — see fetchOpenInterest's default). Sorts
 * defensively since Bybit returns newest-first and a caller could pass either
 * order. Fewer than 2 points, or a starting reading of 0/invalid, is
 * 'unknown' — an unmeasured trend is not evidence either way.
 */
export function classifyOpenInterestTrend(
  history: OpenInterestPoint[],
  thresholdPct: number = OI_TREND_THRESHOLD_PCT
): OpenInterestVerdict {
  const sorted = history
    .filter((p) => Number.isFinite(p.openInterest) && p.openInterest >= 0)
    .slice()
    .sort((a, b) => a.timestamp - b.timestamp);

  if (sorted.length < 2) return { trend: 'unknown', changePercent: 0 };

  const oldest = sorted[0].openInterest;
  const newest = sorted[sorted.length - 1].openInterest;
  if (!(oldest > 0)) return { trend: 'unknown', changePercent: 0 };

  const changePercent = ((newest - oldest) / oldest) * 100;
  if (changePercent >= thresholdPct) return { trend: 'rising', changePercent };
  if (changePercent <= -thresholdPct) return { trend: 'falling', changePercent };
  return { trend: 'flat', changePercent };
}

export type LongShortSentiment = 'crowded_long' | 'crowded_short' | 'balanced' | 'unknown';

/** Classifies the most recent Long/Short reading only — this is a snapshot of
 *  current crowding, not a trend (unlike OI, where the DIRECTION of change is
 *  the informative part). Two independent thresholds, not a symmetric split
 *  — see LONG_SHORT_CROWDED_LONG_RATIO's doc comment for why. */
export function classifyLongShortSentiment(
  point: LongShortPoint | undefined,
  crowdedLongRatio: number = LONG_SHORT_CROWDED_LONG_RATIO,
  crowdedShortRatio: number = LONG_SHORT_CROWDED_SHORT_RATIO
): LongShortSentiment {
  if (!point || !Number.isFinite(point.buyRatio)) return 'unknown';
  if (point.buyRatio >= crowdedLongRatio) return 'crowded_long';
  if (point.buyRatio <= crowdedShortRatio) return 'crowded_short';
  return 'balanced';
}

/** One symbol's derivatives snapshot — what a caller assembles from the two
 *  new fetchers plus the funding data this codebase already fetches
 *  (fetchFundingRates, marketDataService.ts). All optional: a partial or
 *  missing snapshot degrades to 'unknown'/no-veto everywhere, matching
 *  fundingRate.ts's own "abstain, never block on missing data" rule — a feed
 *  outage on a NEW macro layer must not be able to stop the bots trading. */
export interface DerivativesSnapshot {
  symbol: string;
  openInterestHistory?: OpenInterestPoint[];
  longShort?: LongShortPoint;
  /** Same shape fundingRate.ts already defines; re-imported by the caller,
   *  not re-declared here, to keep one definition. */
  fundingRate?: number;
  /** Relative volume (current bar / recent average) on the SPOT market
   *  specifically — 2026-09-16, the partial fix for detectSellPressure's
   *  documented blind spot. `input.h1` (and therefore this module's usual
   *  `relativeVolume` input) is LINEAR/futures volume by default
   *  (getMultiTimeframeData's own default category) — an OTC or
   *  exchange-to-exchange dump that never touches the derivatives book can
   *  still show up here even when Open Interest never contracts. See
   *  detectSellPressure's doc comment for how this is used (an OR
   *  alternative to falling OI, not a replacement for it). */
  spotRelativeVolume?: number;
  /** Relative volume on BINANCE for the same symbol/window — 2026-09-16,
   *  second round of the OTC blind-spot fix. Measured live across this
   *  repo's traded universe: Binance's spot book runs 2-8x deeper than
   *  Bybit's on every symbol checked (LA specifically: 7.6x — one of the two
   *  symbols in the 2026-09-15 incident this whole layer answers). A large
   *  seller routes through the deeper venue first, and on a THIN Bybit
   *  symbol, Bybit's own volume can be too noisy to clearly show a move that
   *  Binance's cleaner book already reflects. Undefined when the symbol
   *  isn't listed on Binance (~11 of this repo's 61 traded symbols, mostly
   *  newer/smaller listings) — abstains like any other missing leg. */
  crossExchangeRelativeVolume?: number;
  fetchedAt: number;
}

export interface DerivativesRegimeVerdict {
  oi: OpenInterestVerdict;
  longShort: LongShortSentiment;
  /** Human-readable notes for the decision log — same convention as
   *  Regime1H.notes / the rest of the engine's Hebrew log lines. */
  notes: string[];
  /** True when OI and L/S sentiment AGREE with the trade direction (OI
   *  rising + sentiment not crowded against it) — informational only, not a
   *  gate. A caller may use this to nudge confidence; nothing in this module
   *  requires that. */
  supportive: boolean;
}

/**
 * The advisory (non-blocking) half of the derivatives layer — OI trend +
 * L/S crowding, contextualised for a direction. Blocking behaviour (funding
 * veto, sell-pressure) is separate: evaluateFundingGate (fundingRate.ts,
 * already existed) and detectSellPressure (below) are the two things that can
 * actually refuse a trade. This function only narrates.
 */
export function evaluateDerivativesRegime(
  snapshot: DerivativesSnapshot | undefined,
  direction: 'LONG' | 'SHORT'
): DerivativesRegimeVerdict {
  const oi = snapshot?.openInterestHistory
    ? classifyOpenInterestTrend(snapshot.openInterestHistory)
    : { trend: 'unknown' as const, changePercent: 0 };
  const longShort = classifyLongShortSentiment(snapshot?.longShort);

  const notes: string[] = [];
  if (oi.trend === 'rising') notes.push(`OI עולה (${oi.changePercent.toFixed(1)}%) — הון זורם לחוזה`);
  else if (oi.trend === 'falling') notes.push(`OI יורד (${oi.changePercent.toFixed(1)}%) — פוזיציות נסגרות`);

  const crowdedAgainst =
    (direction === 'LONG' && longShort === 'crowded_long') ||
    (direction === 'SHORT' && longShort === 'crowded_short');
  if (crowdedAgainst) notes.push(`יחס Long/Short צפוף לכיוון ${direction === 'LONG' ? 'לונג' : 'שורט'} — סיכון contrarian`);

  const supportive = oi.trend === 'rising' && !crowdedAgainst;

  return { oi, longShort, notes, supportive };
}

export interface SellPressureInput {
  /** Current bar's volume relative to its own recent average — the same
   *  quantity isBuyingSurge (calmRegime.ts) reads, just evaluated on a RED
   *  bar here instead of a green one. Whatever venue the caller's candles
   *  come from (LINEAR by default — see intradayEngine.ts's GATE 6). */
  relativeVolume: number;
  /** This bar's close-over-close move, signed (negative = down). */
  priceChangePercent: number;
  openInterestHistory?: OpenInterestPoint[];
  /** SPOT-market relative volume for the same window, 2026-09-16 — the
   *  partial fix for the OTC blind spot (see DerivativesSnapshot's doc
   *  comment). An independent OR alternative to falling OI: a dump that
   *  never touches the derivatives book still often shows up as unusual
   *  spot volume, even when OI itself never contracts. Optional; omitting it
   *  leaves the original OI-only behavior exactly as it was. */
  spotRelativeVolume?: number;
  /** Binance relative volume for the same window, 2026-09-16 second round —
   *  see DerivativesSnapshot.crossExchangeRelativeVolume for why a deeper
   *  cross-exchange read catches what a thin Bybit-only symbol's own volume
   *  can miss. A third independent OR leg, same abstain-on-missing rule. */
  crossExchangeRelativeVolume?: number;
}

export interface SellPressureVerdict {
  blocked: boolean;
  reason: string;
  oiTrend: OpenInterestTrend;
  /** Which leg(s) actually confirmed distribution — useful for logs/tests to
   *  tell an OI-driven block apart from a volume-driven one. */
  confirmedBy: ('oi' | 'spot_volume' | 'cross_exchange_volume')[];
}

/** A big red bar needs at least this much relative volume to count as
 *  distribution rather than ordinary noise. Mirrors calmRegime.ts's
 *  SURGE_REL_VOLUME (2.0) — the same "a lot of participants showed up at
 *  once" bar, applied to the sell side. */
export const SELL_PRESSURE_REL_VOLUME = 2.0;

/** Minimum single-bar drop, in percent, to be a candidate at all. Below this
 *  a volume spike is just an active but unremarkable bar. */
export const SELL_PRESSURE_MIN_DROP_PCT = 1.5;

/**
 * The whale-dump proxy: a volume-confirmed sharp drop, distinguished from a
 * leveraged dip-buy on the SAME red candle by ANY of three independent
 * distribution signatures:
 *
 *   - Open Interest CONTRACTING (see the module header for why OI direction
 *     is what separates real distribution from fresh leveraged buying), OR
 *   - unusual SPOT volume on the same window (2026-09-16, round 1) — a dump
 *     that never touches the derivatives book still often prints as spot
 *     volume once it hits the open market, even when linear OI never moves,
 *     OR
 *   - unusual volume on BINANCE for the same window (2026-09-16, round 2) —
 *     Binance's book runs 2-8x deeper than Bybit's across this repo's
 *     traded universe (measured live), so a seller routing through the
 *     deeper venue first can show up clearly there while Bybit's own,
 *     thinner-volume read stays too noisy to confirm anything on its own.
 *
 * Any one leg is sufficient once volume + drop are confirmed — this is an
 * OR across all three, not a chain of ANDs, so each round only ever WIDENS
 * coverage versus the previous version, never narrows it. All three legs
 * missing still abstains (does not block) — same "unknown is not evidence"
 * rule as everywhere else in this codebase's macro gates.
 */
export function detectSellPressure(input: SellPressureInput): SellPressureVerdict {
  const oi = input.openInterestHistory
    ? classifyOpenInterestTrend(input.openInterestHistory)
    : { trend: 'unknown' as const, changePercent: 0 };

  const volumeConfirmed = input.relativeVolume >= SELL_PRESSURE_REL_VOLUME;
  const dropConfirmed = input.priceChangePercent <= -SELL_PRESSURE_MIN_DROP_PCT;
  const oiConfirmsDistribution = oi.trend === 'falling';
  const spotConfirmsDistribution =
    typeof input.spotRelativeVolume === 'number' && input.spotRelativeVolume >= SELL_PRESSURE_REL_VOLUME;
  const crossExchangeConfirmsDistribution =
    typeof input.crossExchangeRelativeVolume === 'number' &&
    input.crossExchangeRelativeVolume >= SELL_PRESSURE_REL_VOLUME;

  if (
    volumeConfirmed &&
    dropConfirmed &&
    (oiConfirmsDistribution || spotConfirmsDistribution || crossExchangeConfirmsDistribution)
  ) {
    const confirmedBy: ('oi' | 'spot_volume' | 'cross_exchange_volume')[] = [
      ...(oiConfirmsDistribution ? ['oi' as const] : []),
      ...(spotConfirmsDistribution ? ['spot_volume' as const] : []),
      ...(crossExchangeConfirmsDistribution ? ['cross_exchange_volume' as const] : [])
    ];
    const oiPart = oiConfirmsDistribution ? `OI יורד (${oi.changePercent.toFixed(1)}%)` : null;
    const spotPart = spotConfirmsDistribution
      ? `נפח ספוט חריג (${(input.spotRelativeVolume as number).toFixed(1)}x)`
      : null;
    const crossPart = crossExchangeConfirmsDistribution
      ? `נפח Binance חריג (${(input.crossExchangeRelativeVolume as number).toFixed(1)}x)`
      : null;
    const confirmationText = [oiPart, spotPart, crossPart].filter(Boolean).join(' + ');
    return {
      blocked: true,
      reason:
        `MACRO: לחץ מכירה — נפח ${input.relativeVolume.toFixed(1)}x + ירידה ` +
        `${input.priceChangePercent.toFixed(2)}% + ${confirmationText} — ` +
        `סימן להפצה/סגירת פוזיציות, לא לקנייה ממונפת בדיפ`,
      oiTrend: oi.trend,
      confirmedBy
    };
  }

  return { blocked: false, reason: '', oiTrend: oi.trend, confirmedBy: [] };
}

/**
 * Convenience wrapper around detectSellPressure: derives relativeVolume and
 * priceChangePercent from an H1 candle series the same way Intraday's own
 * GATE 6 (intradayEngine.ts) always has, so every caller measures the same
 * two numbers off the same 20-bar lookback instead of each re-deriving it
 * slightly differently. Added 2026-09-16 when the sell-pressure check was
 * extended from Intraday-only to all 4 sim bots (Pro/Path/Bybit read it via
 * simExecution.ts's applySellPressureOverride; Intraday's GATE 6 calls this
 * directly) — a shared source for the SAME computation, not a second one.
 */
export function detectSellPressureFromH1(
  h1: Candle[],
  derivativesSnapshot: DerivativesSnapshot | undefined,
  now: number
): SellPressureVerdict {
  const relativeVolume = computeRelativeVolume(h1, 20, now);
  const last = h1[h1.length - 1];
  const prev = h1[h1.length - 2];
  const priceChangePercent = last && prev && prev.close > 0 ? ((last.close - prev.close) / prev.close) * 100 : 0;
  return detectSellPressure({
    relativeVolume: relativeVolume ?? 0,
    priceChangePercent,
    openInterestHistory: derivativesSnapshot?.openInterestHistory,
    spotRelativeVolume: derivativesSnapshot?.spotRelativeVolume,
    crossExchangeRelativeVolume: derivativesSnapshot?.crossExchangeRelativeVolume
  });
}
