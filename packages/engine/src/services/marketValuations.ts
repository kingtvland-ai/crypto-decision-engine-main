/**
 * Inter-tick market valuation sync — `updateMarketValuations`.
 * ============================================================================
 * The problem this solves: every bot values its book, tracks its peak and
 * tests its levels against ONE point-in-time price per tick (`priceFor()`),
 * sampled every ~2.5-4 seconds. A 5-minute bar is 300 seconds. Anything that
 * happened BETWEEN two samples — a wick through the stop, a spike through a
 * ratchet rung, a dip that filled a resting limit — was invisible:
 *
 *   - `highestPrice`/`lowestPrice` (simEngineFactory's mark-to-market loop)
 *     only ever saw sampled prices, so the profit ratchet's peak tracking
 *     UNDERSTATED the real excursion and a rung crossed inside a bar was
 *     never marked.
 *   - a resting limit's crossing test (`selectFillableOrders`) compared the
 *     same single price against the limit, so a touch-and-reverse never
 *     filled.
 *
 * Meanwhile the true OHLC of every symbol is already sitting in
 * `liveCandles[base].m5` — fetched, cached and unused for this purpose. This
 * module reconciles the book against those bar RANGES.
 *
 * Deliberately NOT an exit engine: it reports what the tape touched and
 * returns positions with honest extremes. Each bot keeps owning its own exit
 * rules — this only stops feeding them a price series with holes in it.
 *
 * Conservative by construction, mirroring the backtest's `intrabarExit`
 * (server/backtestRunner.ts): within one bar the STOP is assumed to have been
 * reached before any target, and a bar that GAPPED past a level fills at the
 * bar's open (worse than the level for a stop, better for a target) rather
 * than pretending the level itself traded.
 */
import type { Candle } from './tradeEngine';
import type { SimPosition, PendingOrder } from './simExecution';

/** What the tape did for one symbol across the bars consumed this tick. */
export interface BarRange {
  high: number;
  low: number;
  /** Open of the FIRST bar in the window — the gap-through reference. */
  open: number;
  /** Timestamp of the newest bar consumed. */
  lastTimestamp: number;
}

export type IntrabarTouchKind = 'stop' | 'tp1' | 'tp2' | 'limit';

/** A level the tape reached between two ticks, that the point-price sampling
 *  did not see. `price` is the conservative fill: the level itself, or the
 *  bar open when the window gapped straight past it. */
export interface IntrabarTouch {
  kind: IntrabarTouchKind;
  symbol: string;
  positionId?: string;
  orderId?: string;
  level: number;
  price: number;
  at: number;
}

export interface MarketValuationInput {
  positions: SimPosition[];
  pending: PendingOrder[];
  /** Closed bars for a symbol, oldest first (M5 in the live loop). Only bars
   *  newer than `lastReconciledAt` are consumed. */
  barsFor: (symbol: string) => Candle[];
  /** Exclusive lower bound — bars at or before this were already reconciled
   *  on an earlier tick. 0 on the first tick of a run. */
  lastReconciledAt: number;
}

export interface MarketValuationResult {
  /** Same positions with `highestPrice`/`lowestPrice` (and the post-TP1
   *  variants) widened to the real bar extremes. */
  positions: SimPosition[];
  /** Levels the tape reached inside a bar. Telemetry + input for callers
   *  that want to act on them; this module never closes anything itself. */
  touches: IntrabarTouch[];
  /** Newest bar timestamp consumed — pass back as `lastReconciledAt` next
   *  tick. Unchanged when no new bars were available, so a stalled candle
   *  feed can never make the window slide forward over unseen bars. */
  reconciledAt: number;
}

const isLongSide = (side: SimPosition['side']): boolean => side === 'LONG' || side === 'BUY';

/**
 * Collapses every bar newer than `after` into one range. Returns null when
 * the symbol has no new bars — the caller then leaves that position exactly
 * as the point-price mark-to-market left it.
 */
export function rangeSince(bars: Candle[] | undefined, after: number): BarRange | null {
  if (!bars || !bars.length) return null;
  let high = -Infinity;
  let low = Infinity;
  let open = NaN;
  let lastTimestamp = 0;
  for (const bar of bars) {
    if (!(bar.timestamp > after)) continue;
    if (!Number.isFinite(bar.high) || !Number.isFinite(bar.low)) continue;
    if (Number.isNaN(open)) open = bar.open;
    if (bar.high > high) high = bar.high;
    if (bar.low < low) low = bar.low;
    if (bar.timestamp > lastTimestamp) lastTimestamp = bar.timestamp;
  }
  if (!Number.isFinite(high) || !Number.isFinite(low) || Number.isNaN(open)) return null;
  return { high, low, open, lastTimestamp };
}

/** Conservative fill for a level the window reached: the level itself, unless
 *  the window OPENED already past it, in which case the open is the first
 *  price that actually traded. */
function fillPriceFor(level: number, open: number, crossedDownward: boolean): number {
  return crossedDownward ? Math.min(level, open) : Math.max(level, open);
}

/**
 * Reconciles open positions and resting orders against what the tape actually
 * did since the last tick. Pure: no I/O, no clock, no mutation of its inputs.
 */
export function updateMarketValuations(input: MarketValuationInput): MarketValuationResult {
  const { positions, pending, barsFor, lastReconciledAt } = input;
  const touches: IntrabarTouch[] = [];
  let reconciledAt = lastReconciledAt;

  // Bars are cached per symbol (several positions/orders can share one), but
  // the CURSOR is per entity: a position must never inherit extremes from
  // bars that closed before it existed. That matters on a worker restart,
  // where `lastReconciledAt` comes back as 0 and the M5 window holds hundreds
  // of bars — without the per-entity floor, a position opened two minutes ago
  // would adopt the whole window's high as its peak and hand the profit
  // ratchet a rung it never actually reached.
  const barsCache = new Map<string, Candle[]>();
  const barsOf = (symbol: string): Candle[] => {
    let bars = barsCache.get(symbol);
    if (!bars) {
      bars = barsFor(symbol) ?? [];
      barsCache.set(symbol, bars);
      for (const b of bars) {
        if (b.timestamp > reconciledAt) reconciledAt = b.timestamp;
      }
    }
    return bars;
  };
  const rangeOf = (symbol: string, since: number): BarRange | null =>
    rangeSince(barsOf(symbol), Math.max(lastReconciledAt, since));

  const nextPositions = positions.map((pos) => {
    const range = rangeOf(pos.symbol, pos.openTimestamp ?? 0);
    if (!range) return pos;

    const long = isLongSide(pos.side);
    const at = range.lastTimestamp;

    // ── Honest extremes. Only ever widen: the sampled price may have caught
    // something outside this window's bars (a price printed after the last
    // bar closed), and that reading is just as real as the bar's.
    const highestPrice = Math.max(pos.highestPrice ?? pos.entryPrice, range.high);
    const lowestPrice = Math.min(pos.lowestPrice ?? pos.entryPrice, range.low);
    const highestPriceSinceTP1 = pos.tp1Hit
      ? Math.max(pos.highestPriceSinceTP1 ?? range.high, range.high)
      : pos.highestPriceSinceTP1;
    const lowestPriceSinceTP1 = pos.tp1Hit
      ? Math.min(pos.lowestPriceSinceTP1 ?? range.low, range.low)
      : pos.lowestPriceSinceTP1;

    // ── Level touches, stop first (same precedence the backtest's
    // intrabarExit uses: within one bar the adverse move is assumed first).
    const stopReached = long ? range.low <= pos.stopLoss : range.high >= pos.stopLoss;
    if (stopReached) {
      touches.push({
        kind: 'stop',
        symbol: pos.symbol,
        positionId: pos.id,
        level: pos.stopLoss,
        price: fillPriceFor(pos.stopLoss, range.open, long),
        at
      });
    } else {
      const tp1 = pos.takeProfit1;
      const tp2 = pos.takeProfit2;
      if (!pos.tp1Hit && typeof tp1 === 'number' && (long ? range.high >= tp1 : range.low <= tp1)) {
        touches.push({
          kind: 'tp1', symbol: pos.symbol, positionId: pos.id,
          level: tp1, price: fillPriceFor(tp1, range.open, !long), at
        });
      } else if (pos.tp1Hit && typeof tp2 === 'number' && (long ? range.high >= tp2 : range.low <= tp2)) {
        touches.push({
          kind: 'tp2', symbol: pos.symbol, positionId: pos.id,
          level: tp2, price: fillPriceFor(tp2, range.open, !long), at
        });
      }
    }

    return { ...pos, highestPrice, lowestPrice, highestPriceSinceTP1, lowestPriceSinceTP1 };
  });

  // ── Resting ENTRY limits: did the window cross the limit price?
  for (const order of pending) {
    const isEntry = order.side === 'buy' || order.side === 'long' || order.side === 'short';
    if (!isEntry || order.fill === 'market') continue;
    // Same per-entity floor as positions: an order cannot be filled by a bar
    // that closed before it was placed.
    const range = rangeOf(order.symbol, order.createdAt ?? 0);
    if (!range) continue;
    const buySide = order.side === 'buy' || order.side === 'long';
    const crossed = buySide ? range.low <= order.signalPrice : range.high >= order.signalPrice;
    if (!crossed) continue;
    touches.push({
      kind: 'limit',
      symbol: order.symbol,
      orderId: order.id,
      level: order.signalPrice,
      price: fillPriceFor(order.signalPrice, range.open, buySide),
      at: range.lastTimestamp
    });
  }

  return { positions: nextPositions, touches, reconciledAt };
}

/** The extreme a resting limit needs to be tested against, for callers that
 *  already hold a range (see selectFillableOrders' `rangeFor`). */
export function limitTouchPrice(range: BarRange, buySide: boolean): number {
  return buySide ? range.low : range.high;
}
