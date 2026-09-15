/**
 * Limit-entry verification across bots (2026-09-16, operator investigation)
 * ============================================================================
 * Operator observed a bot entering immediately after starting even with
 * "כניסה לפי שער (לימיט)" checked in the settings panel, as if the limit
 * price had no effect. This is a DIAGNOSTIC file, not a fix — it exercises
 * each bot's actual order-generation + fill-eligibility path end-to-end to
 * find out whether the mechanism itself is sound.
 *
 * Findings (see each describe block) and fixes (2026-09-16):
 *   1. Pro: mechanism is sound, no fix needed. calculateOptimalEntryPrice
 *      always rests strictly below market (proEntryDiscount.test.ts already
 *      covers the price math); this file additionally proves the ORDER is
 *      tagged 'limit' and selectFillableOrders does NOT fire it at the
 *      unchanged market price, only once price actually reaches the limit.
 *   2. Path: breakoutLimitPrice CAN degenerate to exactly (or negligibly
 *      near) the market price on a fresh, tight breakout — that clamp is
 *      itself correct and unchanged (a breakout that fresh has no level to
 *      rest a retest below without buying back inside the broken range).
 *      What WAS wrong: the resulting order kept `fill: 'limit'` regardless,
 *      which fillDueOrders treats as a Maker fill — zero slippage, the
 *      cheaper fee — for something that fires exactly as fast as a market
 *      order. FIXED in prev4hRangeExecution.ts: a limit order is now only
 *      tagged 'limit' when the discount from entryRef genuinely exceeds
 *      MIN_GENUINE_LIMIT_DISCOUNT_FRACTION (0.05%); otherwise it's honestly
 *      'market' — same fill timing as before, correct fee/slippage now.
 *   3. Bybit: `ctx.limitEntries` is DELIBERATELY never read for entries
 *      (trendBreakoutExecution.ts, by design — a breakout strategy resting
 *      below market is adverse selection). This was a documentation gap, not
 *      a logic bug: the settings-panel checkbox said "חל על כל 4 הבוטים"
 *      (applies to all 4 bots), which was false for this one. FIXED in
 *      SimulationEngineColumn.tsx — the checkbox no longer renders for the
 *      Bybit column.
 */

import { describe, it, expect } from 'vitest';
import {
  generateProOrders, selectFillableOrders,
  type SimPosition, type PendingOrder
} from '@cde/engine/execution';
import type { SignalEvaluation } from '@cde/engine';

// ── 1. Pro ────────────────────────────────────────────────────────────────

const MARKET = 100;
const LIMIT_PRICE = 99.4; // a realistic ~0.6% discount, well inside the ceiling

function proEvaluationWithLimit(): SignalEvaluation {
  return {
    symbol: 'B3', action: 'buy', tradeType: 'SPOT', tradeSide: 'BUY', confidence: 96,
    price: MARKET, optimalEntryPrice: LIMIT_PRICE, priceChange24h: 1, reasoning: 'test',
    status: 'ready', willExecute: true, factors: [], confidenceGap: 0, leverage: 1,
    stopLoss: 90, takeProfit: 130, budgetUsd: 1000
  } as unknown as SignalEvaluation;
}

const proCtx = {
  positions: [] as SimPosition[],
  pending: [] as PendingOrder[],
  signalsBySymbol: {},
  minConfidence: 85,
  executionDelaySec: 0,
  priceFor: () => MARKET,
  cash: 100_000,
  equity: 100_000,
  dailyDrawdownPercent: 0,
  weeklyDrawdownPercent: 0,
  maxPositions: 7,
  candlesBySymbol: {},
  exitCooldown: {}
};

describe('Pro — limit entry mechanism', () => {
  it('with limitEntries ON, the order rests at optimalEntryPrice, tagged fill:"limit" — NOT at market', () => {
    const orders = generateProOrders({
      ...proCtx, evaluations: [proEvaluationWithLimit()], limitEntries: true
    } as never).filter((o) => o.side === 'buy');
    expect(orders).toHaveLength(1);
    expect(orders[0].fill).toBe('limit');
    expect(orders[0].signalPrice).toBe(LIMIT_PRICE);
    expect(orders[0].signalPrice).toBeLessThan(MARKET);
  });

  it('with limitEntries OFF, the order rests at the live market price, tagged fill:"market"', () => {
    const orders = generateProOrders({
      ...proCtx, evaluations: [proEvaluationWithLimit()], limitEntries: false
    } as never).filter((o) => o.side === 'buy');
    expect(orders[0].fill).toBe('market');
    expect(orders[0].signalPrice).toBe(MARKET);
  });

  it('a limit order does NOT fire while price sits at the unchanged market level (this is the "enters immediately" complaint — it should NOT happen)', () => {
    const orders = generateProOrders({
      ...proCtx, evaluations: [proEvaluationWithLimit()], limitEntries: true
    } as never).filter((o) => o.side === 'buy');
    // Delay already elapsed, but createdAt stays "now" so the 2h TTL isn't
    // also exceeded — isolates the price-crossing check from expiry.
    const now = Date.now();
    const order = { ...orders[0], executeAt: now - 1000, createdAt: now };
    const { due, expired } = selectFillableOrders([order], now, () => MARKET);
    expect(due).toHaveLength(0);
    expect(expired).toHaveLength(0); // still resting, not expired either
  });

  it('the SAME limit order DOES fire once price actually reaches the limit', () => {
    const orders = generateProOrders({
      ...proCtx, evaluations: [proEvaluationWithLimit()], limitEntries: true
    } as never).filter((o) => o.side === 'buy');
    const now = Date.now();
    const order = { ...orders[0], executeAt: now - 1000, createdAt: now };
    const { due } = selectFillableOrders([order], now, () => LIMIT_PRICE);
    expect(due).toHaveLength(1);
  });
});

// ── 2. Path (Prev4H Range) ───────────────────────────────────────────────

import { breakoutLimitPrice } from '@cde/engine/execution';

describe('Path — breakoutLimitPrice can degenerate to exactly market on a fresh, tight breakout', () => {
  it('a typical breakout (price well past the level) rests genuinely below market', () => {
    const market = 100;
    const brokenLevel = 98; // broken 2% below current price — room to rest
    const limit = breakoutLimitPrice(market, true, 0.10 * 2 /* entryLimitOffsetRangeMult × range */, brokenLevel, 0.02 * 2);
    expect(limit).toBeLessThan(market);
  });

  it('a FRESH breakout (price only just above the level) can produce a limit price equal to market — no real discount', () => {
    // range = 2 (H-L), just broken: current price sits only 0.1 above H.
    const H = 100;
    const market = H + 0.1;
    const range = 2;
    const offset = 0.10 * range; // entryLimitOffsetRangeMult default = 0.10
    const levelBuffer = 0.02 * range;
    const limit = breakoutLimitPrice(market, true, offset, H, levelBuffer);
    // discounted = market - offset = 100.1 - 0.2 = 99.9 (below H+buffer=100.04)
    // justPastLevel = H + levelBuffer = 100.04
    // floored = max(99.9, 100.04) = 100.04, then min(100.04, market=100.1) = 100.04
    // Still below market here, but only by 0.06 — a near-zero discount.
    const discountPct = ((market - limit) / market) * 100;
    expect(discountPct).toBeLessThan(0.1); // effectively no real wait required
  });

  it('an EXTREMELY fresh breakout (price at the level + tiny epsilon) produces a limit AT exactly market', () => {
    const H = 100;
    const market = H + 0.01; // just ticked past the level
    const range = 2;
    const offset = 0.10 * range;
    const levelBuffer = 0.02 * range; // 0.04, bigger than the 0.01 excess above H
    const limit = breakoutLimitPrice(market, true, offset, H, levelBuffer);
    // justPastLevel = 100.04 > market (100.01) → floored clamps to justPastLevel,
    // then the final Math.min(floored, market) clamps back DOWN to market itself.
    expect(limit).toBe(market);
  });
});

// ── Fix verification: Path now labels a no-discount "limit" honestly ───────

import { generatePrev4hRangeOrders } from '@cde/engine/execution';

describe('Path — a razor-fresh breakout is now honestly tagged fill:"market" (fee/slippage accuracy fix)', () => {
  const pathCommon = (limitEntryPrice: number, entryRef: number) => ({
    positions: [],
    pending: [],
    evaluations: [{
      symbol: 'NEAR', action: 'buy', tradeType: 'SPOT', tradeSide: 'BUY', confidence: 93,
      price: entryRef, priceChange24h: 1, reasoning: '', status: 'SIGNAL SPOT LONG', willExecute: true,
      factors: [], confidenceGap: 0,
      decision: {
        direction: 'LONG',
        windowStart: Date.now() - 60_000,
        windowEnd: Date.now() + 3 * 60 * 60 * 1000,
        entryRef, limitEntryPrice, stopLoss: entryRef * 0.95, takeProfit: entryRef * 1.05, riskPerUnit: entryRef * 0.05
      } as never
    }] as unknown as SignalEvaluation[],
    executionDelaySec: 0,
    dailyDrawdownPercent: 0,
    weeklyDrawdownPercent: 0,
    cash: 10_000,
    equity: 10_000,
    initialAmount: 10_000,
    totalLeveragedExposureUsd: 0,
    exitCooldown: {},
    priceFor: (s: string) => (s === 'NEAR' ? entryRef : undefined),
    candlesBySymbol: {},
    maxPositions: 7,
    maxFuturesPositions: 2,
    limitEntries: true
  });

  it('a genuine ~2% discount stays tagged "limit"', () => {
    const [order] = generatePrev4hRangeOrders(pathCommon(4.70, 4.795) as never);
    expect(order.fill).toBe('limit');
    expect(order.signalPrice).toBeCloseTo(4.70, 6);
  });

  it('a razor-thin (<0.05%) discount is now tagged "market" — same price, honest fee treatment', () => {
    const entryRef = 100;
    const limitEntryPrice = 100 - 0.02; // 0.02% below — under the genuine-discount bar
    const [order] = generatePrev4hRangeOrders(pathCommon(limitEntryPrice, entryRef) as never);
    expect(order.fill).toBe('market');
    expect(order.signalPrice).toBeCloseTo(limitEntryPrice, 6); // price unchanged, only the label/fee treatment
  });

  it('an exact-equality discount (the fully degenerate case) is tagged "market"', () => {
    const entryRef = 100;
    const [order] = generatePrev4hRangeOrders(pathCommon(entryRef, entryRef) as never);
    expect(order.fill).toBe('market');
  });
});
