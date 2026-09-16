/**
 * Spread + liquidity in the shared fill core (2026-09-16)
 * ============================================================================
 * Two of the eight execution dimensions were missing from BOTH the live sim
 * and the backtest:
 *
 *   · SPREAD — never modelled anywhere. It existed only as an INPUT to the
 *     planning-time cost gate; no fill ever paid it. Now every MARKET leg
 *     crosses half of it, always against the bot. It is a MODEL, not a
 *     measurement — no historical bid/ask series exists in this project — but
 *     zero was also a model, and a worse one.
 *   · LIQUIDITY — no size cap of any kind. A market order for more than a
 *     slice of what actually trades in a bar does not fill at one price. This
 *     one IS measured: quote volume is in every kline.
 *
 * Per the operator's decision both are ON in the live sim as well as the
 * replay, so these tests exercise the shared core directly.
 */
import { describe, it, expect } from 'vitest';
import {
  fillDueOrders,
  DEFAULT_SPREAD_PERCENT,
  DEFAULT_LIQUIDITY_CAP_FRACTION,
  MIN_SIM_ENTRY_USD,
  type PendingOrder,
  type SimPosition
} from '@cde/engine/execution';

const PRICE = 100;

function entryOrder(over: Partial<PendingOrder> = {}): PendingOrder {
  return {
    id: 'e1', symbol: 'TEST', type: 'SPOT', side: 'buy',
    signalPrice: PRICE, quantity: 10, budgetUsd: 1000,
    // 'market' so it crosses the spread — a resting limit does not.
    fill: 'market',
    reason: 'test', confidence: 80, executeAt: 0, createdAt: 0,
    ...over
  } as PendingOrder;
}

function longPosition(over: Partial<SimPosition> = {}): SimPosition {
  return {
    id: 'p1', symbol: 'TEST', type: 'SPOT', side: 'LONG',
    quantity: 10, entryPrice: PRICE, avgPrice: PRICE, currentPrice: PRICE,
    leverage: 1, marginUsd: 0, notionalUsd: 1000,
    stopLoss: 95, tp1Hit: false, highestPrice: PRICE, lowestPrice: PRICE,
    openedAt: '', openTimestamp: 0, reason: '', confidence: 80, entryFee: 0,
    ...over
  } as SimPosition;
}

const closeOrder = (over: Partial<PendingOrder> = {}): PendingOrder => ({
  id: 'c1', symbol: 'TEST', positionId: 'p1', type: 'SPOT', side: 'close_long',
  signalPrice: PRICE, quantity: 10, reason: 'test', confidence: 80,
  executeAt: 0, createdAt: 0, ...over
} as PendingOrder);

/** No slippage, so the ONLY difference from mid is the spread. */
const baseCosts = { feePercent: 0.1, slippagePercent: 0, equity: 100_000, initialAmount: 100_000 };

describe('spread — every market leg crosses half of it, against the bot', () => {
  it('a market BUY fills ABOVE the mid', () => {
    const res = fillDueOrders([entryOrder()], 100_000, [], () => PRICE, String, baseCosts);
    const fillPrice = res.positions[0].entryPrice;
    expect(fillPrice).toBeCloseTo(PRICE * (1 + DEFAULT_SPREAD_PERCENT / 200), 8);
    expect(fillPrice).toBeGreaterThan(PRICE);
  });

  it('a market SELL fills BELOW the mid', () => {
    const res = fillDueOrders([closeOrder()], 1000, [longPosition()], () => PRICE, String, baseCosts);
    expect(res.newTrades[0].price).toBeCloseTo(PRICE * (1 - DEFAULT_SPREAD_PERCENT / 200), 8);
    expect(res.newTrades[0].price).toBeLessThan(PRICE);
  });

  it('a RESTING LIMIT entry does not cross it — that is what resting means', () => {
    const resting = entryOrder({ fill: 'limit', signalPrice: PRICE });
    const res = fillDueOrders([resting], 100_000, [], () => PRICE, String, baseCosts);
    expect(res.positions[0].entryPrice).toBeCloseTo(PRICE, 8);
  });

  it('is configurable, and zero restores the old behaviour exactly', () => {
    const res = fillDueOrders([entryOrder()], 100_000, [], () => PRICE, String,
      { ...baseCosts, spreadPercent: 0 });
    expect(res.positions[0].entryPrice).toBeCloseTo(PRICE, 8);
  });

  it('a wider spread costs more — the round trip is spread + fees', () => {
    const tight = fillDueOrders([entryOrder()], 100_000, [], () => PRICE, String,
      { ...baseCosts, spreadPercent: 0.02 });
    const wide = fillDueOrders([entryOrder()], 100_000, [], () => PRICE, String,
      { ...baseCosts, spreadPercent: 0.50 });
    expect(wide.positions[0].entryPrice).toBeGreaterThan(tight.positions[0].entryPrice);
  });
});

describe('liquidity — a fill cannot take more than a slice of the bar', () => {
  it('trims an oversized entry to the cap instead of filling it whole', () => {
    // Bar traded $10,000; the 5% cap allows $500 of a $1,000 order.
    const res = fillDueOrders([entryOrder()], 100_000, [], () => PRICE, String, {
      ...baseCosts,
      quoteVolumeFor: () => 10_000
    });
    expect(res.positions).toHaveLength(1);
    const notional = res.positions[0].notionalUsd;
    expect(notional).toBeCloseTo(10_000 * DEFAULT_LIQUIDITY_CAP_FRACTION, 6);
    expect(notional).toBeLessThan(1000);
  });

  it('leaves an order the bar can absorb untouched', () => {
    const res = fillDueOrders([entryOrder()], 100_000, [], () => PRICE, String, {
      ...baseCosts,
      quoteVolumeFor: () => 10_000_000
    });
    expect(res.positions[0].notionalUsd).toBeCloseTo(1000, 6);
  });

  it('skips entirely when the cap falls under the $100 order floor', () => {
    // Bar traded $500 → the 5% cap is $25, below MIN_SIM_ENTRY_USD.
    const res = fillDueOrders([entryOrder()], 100_000, [], () => PRICE, String, {
      ...baseCosts,
      quoteVolumeFor: () => 500
    });
    expect(res.positions).toHaveLength(0);
    expect(MIN_SIM_ENTRY_USD).toBeGreaterThan(500 * DEFAULT_LIQUIDITY_CAP_FRACTION);
  });

  it('is skipped when no volume is known — never invents a constraint', () => {
    const res = fillDueOrders([entryOrder()], 100_000, [], () => PRICE, String, {
      ...baseCosts,
      quoteVolumeFor: () => undefined
    });
    expect(res.positions[0].notionalUsd).toBeCloseTo(1000, 6);
  });

  it('honours a custom cap fraction', () => {
    const res = fillDueOrders([entryOrder()], 100_000, [], () => PRICE, String, {
      ...baseCosts,
      quoteVolumeFor: () => 10_000,
      liquidityCapFraction: 0.02
    });
    expect(res.positions[0].notionalUsd).toBeCloseTo(200, 6);
  });
});
