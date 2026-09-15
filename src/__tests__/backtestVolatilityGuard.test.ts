/**
 * Backtest — VolatilityBacktestGuard.applyToRisk (2026-09-16)
 * ============================================================================
 * `runPortfolioBacktest`'s guard has two modes:
 *   - default (no guard, or `applyToRisk` unset/false): log-only, byte-for-
 *     byte identical trades/sizing/gating to no guard at all.
 *   - `applyToRisk: true`: feeds a look-ahead-safe, point-in-time profile
 *     (rebuilt from monthlyRows, restricted to months closed strictly before
 *     each decision's timestamp — buildVolatilityProfiles's own asOfMonth
 *     guarantee, already covered by volatilityProfile.test.ts) into
 *     buildRiskPlan the same way sim engines do, so a backtest run measures
 *     what live/sim will actually do.
 *
 * This file only proves the WIRING (off = no-op, on = runs without error) —
 * the profile math itself (regimes, clamps, look-ahead) is covered
 * exhaustively at the unit level in volatilityProfile.test.ts and each bot's
 * own *VolatilityLadder.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { runPortfolioBacktest, type VolatilityBacktestGuard } from '../../server/backtestRunner';
import type { Candle } from '@cde/engine';
import type { MonthlyExcursionRow } from '@cde/engine/volatility';

const T0 = Date.UTC(2025, 0, 1);

function series(n: number, stepMs: number): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  let x = 7;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const open = price;
    price = price * (1 + ((x / 2147483648) - 0.5) * 0.01);
    out.push({
      timestamp: T0 + i * stepMs,
      open, high: Math.max(open, price) * 1.001, low: Math.min(open, price) * 0.999,
      close: price, volume: 1000 + (i % 5) * 50
    });
  }
  return out;
}

const histories = [{
  symbol: 'BTCUSDT',
  candles: series(300, 3_600_000),
  m15: series(400, 900_000),
  m5: series(700, 300_000)
}];

function monthlyRowsCoveringT0(months: number): MonthlyExcursionRow[] {
  const rows: MonthlyExcursionRow[] = [];
  const start = new Date(T0);
  for (let i = 0; i < months; i++) {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - months + i, 1));
    rows.push({
      category: 'spot', symbol: 'BTCUSDT',
      month: d.toISOString().slice(0, 7),
      maxUpsidePct: 3, maxDownsidePct: -3
    });
  }
  return rows;
}

describe('runPortfolioBacktest — VolatilityBacktestGuard.applyToRisk', () => {
  it('is a byte-for-byte no-op when the guard is supplied but applyToRisk is unset', async () => {
    const withoutGuard = await runPortfolioBacktest(histories, 'intraday');
    const guard: VolatilityBacktestGuard = { monthlyRows: monthlyRowsCoveringT0(24), market: 'spot' };
    const withGuardLogOnly = await runPortfolioBacktest(histories, 'intraday', undefined, guard);
    expect(withGuardLogOnly).toEqual(withoutGuard);
  });

  it('is a byte-for-byte no-op when applyToRisk is explicitly false', async () => {
    const withoutGuard = await runPortfolioBacktest(histories, 'intraday');
    const guard: VolatilityBacktestGuard = {
      monthlyRows: monthlyRowsCoveringT0(24), market: 'spot', applyToRisk: false
    };
    const withGuard = await runPortfolioBacktest(histories, 'intraday', undefined, guard);
    expect(withGuard).toEqual(withoutGuard);
  });

  it('applyToRisk: true runs to completion without throwing (wiring smoke test)', async () => {
    const guard: VolatilityBacktestGuard = {
      monthlyRows: monthlyRowsCoveringT0(24), market: 'spot', applyToRisk: true
    };
    const result = await runPortfolioBacktest(histories, 'intraday', undefined, guard);
    expect(Number.isFinite(result.maxDrawdown)).toBe(true);
    expect(result.totalTrades).toBeGreaterThanOrEqual(0);
  });

  it('applyToRisk: true with NO monthly history at all (0 months) still runs — never blocks on a missing profile', async () => {
    const guard: VolatilityBacktestGuard = { monthlyRows: [], market: 'spot', applyToRisk: true };
    const result = await runPortfolioBacktest(histories, 'intraday', undefined, guard);
    expect(Number.isFinite(result.maxDrawdown)).toBe(true);
  });
});
