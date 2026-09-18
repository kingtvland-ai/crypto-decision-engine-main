/**
 * Logical trades — group SimTrade exit rows by the position they belong to
 * ============================================================================
 * Operator decision 2026-09-18. Every partial fill (TP1, a ratchet partial, a
 * Time-Stop half-close) and every full close was being counted in the UI/stats
 * as its OWN independent win or loss. A position that took +$12.89 on a TP1
 * partial and then gave back -$2.91 on the break-even close that followed it
 * — net +$9.98, a WIN — was counted as one win AND one loss, and the "win
 * rate" denominator was inflated by every partial fill a position ever took.
 *
 * A logical trade is every SimTrade row (entry + every exit leg) that shares
 * one SimPosition.id. Its realized PnL is the SUM of its exit legs' pnl; its
 * win/loss is decided by that sum, never by an individual leg's sign.
 *
 * `positionId` was added to SimTrade on 2026-09-18 (simExecution.ts) — rows
 * recorded before that carry no positionId, and each becomes its OWN
 * singleton logical trade here (the same count/behavior they had before this
 * module existed), so old persisted state does not retroactively misreport.
 *
 * This module only GROUPS AND SUMS numbers `simExecution.ts` already computed
 * correctly per leg (see that file's comments on per-partial pnl/pnlPercent)
 * — it does not change entry/exit strategy, TP/SL levels, or any decision
 * logic anywhere.
 */

import type { SimTrade } from './simExecution';

const CLOSE_SIDES = new Set(['close_long', 'close_short']);
const ENTRY_SIDES = new Set(['buy', 'sell', 'long', 'short']);

/** The minimal shape this module actually reads. `SimTrade` satisfies this
 *  structurally, but a caller with a lighter local trade type (e.g. a UI
 *  card that only kept `{ at, pnl }` before) only needs to widen that type
 *  by these fields, not switch to the full engine `SimTrade`. */
export interface LogicalTradeLeg {
  id?: string;
  symbol?: string;
  /** Optional so a caller whose type declares it optional (e.g.
   *  StrategyTickInput.closedTradeMetrics) can pass its array as-is —
   *  `CLOSE_SIDES.has(undefined)`/`ENTRY_SIDES.has(undefined)` are both
   *  false, same as never matching either, so an absent side just means
   *  this leg contributes to isClosed/pnl exactly like an unrecognized side
   *  string would. */
  side?: string;
  at: number;
  /** Risk-at-entry (SimPosition.initialRiskUsd, prorated) — not read by this
   *  module, kept only so a caller's own richer per-leg type (SimTrade,
   *  ClosedTradeRecord) round-trips through `legs`/`exitLegs` without a cast. */
  riskUsd?: number;
  pnl?: number;
  pnlPercent?: number;
  positionId?: string;
}

export interface LogicalTrade<T extends LogicalTradeLeg = SimTrade> {
  /** SimPosition.id, or the single leg's own id when positionId is absent
   *  (pre-2026-09-18 data — see this module's own doc comment). */
  positionId: string;
  symbol: string;
  /** Every leg for this position, in the order they were recorded (entry
   *  first, if present in this slice, then each exit leg). */
  legs: T[];
  /** Exit legs only (typeof pnl === 'number') — what netPnl/netPnlPercent are
   *  computed from. */
  exitLegs: T[];
  /** True once a close_long/close_short leg is present — the position is
   *  fully exited. A position that has only taken a partial so far is NOT
   *  closed yet and must not be counted toward win/loss stats. */
  isClosed: boolean;
  /** Sum of every exit leg's pnl. Present only when isClosed (an open
   *  position's "PnL so far" is not a realized result). */
  netPnl?: number;
  /** Weighted-average PnL%, reconstructed from each leg's own pnl/pnlPercent
   *  (basis_i = pnl_i / (pnlPercent_i/100)) so it is exactly the % that
   *  netPnl represents against the total capital that moved through this
   *  trade — NOT a copy of any single leg's own pnlPercent (requirement: a
   *  logical trade's % must never be one exit event's % standing in for the
   *  whole trade). Undefined when it cannot be reconstructed (e.g. every leg
   *  has pnlPercent 0). */
  netPnlPercent?: number;
  /** netPnl > 0. Only meaningful when isClosed. */
  isWin?: boolean;
  openedAt?: number;
  closedAt?: number;
}

/**
 * Groups a bot's trades[] into logical trades. Pure — no side effects, no
 * strategy/decision logic. Order of the returned array follows first
 * appearance of each position in `trades`.
 */
export function aggregateLogicalTrades<T extends LogicalTradeLeg>(trades: T[]): LogicalTrade<T>[] {
  const order: string[] = [];
  const byKey = new Map<string, LogicalTrade<T>>();
  let anonymousCounter = 0;

  for (const t of trades) {
    // Legacy rows (no positionId): each is its own logical trade, keyed by
    // its own id so two legacy rows never accidentally merge.
    const key = t.positionId ?? `__legacy_${t.id ?? anonymousCounter++}`;
    let lt = byKey.get(key);
    if (!lt) {
      lt = { positionId: t.positionId ?? key, symbol: t.symbol ?? '', legs: [], exitLegs: [], isClosed: false };
      byKey.set(key, lt);
      order.push(key);
    }
    lt.legs.push(t);
    if (typeof t.pnl === 'number') lt.exitLegs.push(t);
    if (t.side !== undefined && CLOSE_SIDES.has(t.side)) lt.isClosed = true;
    if (t.side !== undefined && ENTRY_SIDES.has(t.side)) lt.openedAt = t.at;
  }

  for (const lt of byKey.values()) {
    if (!lt.isClosed) continue;
    let netPnl = 0;
    let basisSum = 0;
    let weightedPctSum = 0;
    for (const leg of lt.exitLegs) {
      netPnl += leg.pnl ?? 0;
      if (typeof leg.pnlPercent === 'number' && leg.pnlPercent !== 0) {
        const basis = (leg.pnl ?? 0) / (leg.pnlPercent / 100);
        basisSum += basis;
        weightedPctSum += leg.pnl ?? 0;
      }
    }
    lt.netPnl = Number(netPnl.toFixed(8));
    lt.netPnlPercent = basisSum !== 0 ? Number(((weightedPctSum / basisSum) * 100).toFixed(4)) : undefined;
    lt.isWin = netPnl > 0;
    lt.closedAt = lt.exitLegs.length ? lt.exitLegs[lt.exitLegs.length - 1].at : undefined;
  }

  return order.map((k) => byKey.get(k)!);
}

export interface LogicalTradeStats {
  logicalTradeCount: number;
  closedLogicalTradeCount: number;
  exitEventCount: number;
  wins: number;
  losses: number;
  winRate: number;
  grossProfit: number;
  grossLoss: number;
  netRealizedPnl: number;
  avgPnlPerLogicalTrade: number;
}

/** The 6-requirement stats block, computed from CLOSED logical trades only —
 *  an open position (partial fill, not yet fully exited) contributes to none
 *  of these. */
export function summarizeLogicalTrades<T extends LogicalTradeLeg>(trades: T[]): LogicalTradeStats {
  const logical = aggregateLogicalTrades(trades);
  const closed = logical.filter((lt) => lt.isClosed);
  const wins = closed.filter((lt) => lt.isWin === true);
  const losses = closed.filter((lt) => lt.isWin === false);
  const grossProfit = wins.reduce((s, lt) => s + (lt.netPnl ?? 0), 0);
  const grossLoss = losses.reduce((s, lt) => s + (lt.netPnl ?? 0), 0);
  const netRealizedPnl = grossProfit + grossLoss;
  return {
    logicalTradeCount: logical.length,
    closedLogicalTradeCount: closed.length,
    exitEventCount: trades.filter((t) => typeof t.pnl === 'number').length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length > 0 ? Number(((wins.length / closed.length) * 100).toFixed(2)) : 0,
    grossProfit: Number(grossProfit.toFixed(2)),
    grossLoss: Number(grossLoss.toFixed(2)),
    netRealizedPnl: Number(netRealizedPnl.toFixed(2)),
    avgPnlPerLogicalTrade: closed.length > 0 ? Number((netRealizedPnl / closed.length).toFixed(2)) : 0
  };
}
