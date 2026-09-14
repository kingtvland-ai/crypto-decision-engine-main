/**
 * /live — the public, read-only results board. See src/pages/LiveBoard.tsx:
 * no login, no controls, one endpoint (/api/public/bots-summary).
 */
import { test, expect } from '@playwright/test';
import { installMockWorker, samplePosition, sampleClosedTrade } from './fixtures/mockWorker';

test.describe('/live', () => {
  test('shows all four bots and the portfolio-wide summary, with no controls', async ({ page }) => {
    await installMockWorker(page, {
      sim: { cash: 9000, positions: [samplePosition()] },
      'pro-sim': { trades: [sampleClosedTrade({ pnl: 42, pnlPercent: 4.2 })] }
    });
    await page.goto('/live');

    for (const name of ['Multi-Timeframe', 'Pro · אוסצילטורים', 'Prev-4H Range', 'TrendBreakout']) {
      await expect(page.getByText(name, { exact: true })).toBeVisible();
    }
    await expect(page.getByText('רווח/הפסד כולל')).toBeVisible();
    await expect(page.getByText('שווי כולל')).toBeVisible();

    // Read-only: no start/pause/reset anywhere on this page. `exact: true`
    // matters here — Playwright's default substring match makes 'התחל'
    // match every bot card's own toggle button, whose accessible name
    // includes "...הון התחלתי $X" (a real word sharing the same root, not a
    // hidden start control).
    for (const label of ['התחל', 'השהה', 'איפוס', 'המשך']) {
      await expect(page.getByRole('button', { name: label, exact: true })).toHaveCount(0);
    }
  });

  test('expanding a bot card reveals its trade log', async ({ page }) => {
    await installMockWorker(page, {
      sim: { trades: [sampleClosedTrade({ symbol: 'ADA', reason: 'TP1 הושג ב-0.62 — סגירת 50%' })] }
    });
    await page.goto('/live');

    // The card renders collapsed — the trade log is not in the DOM until
    // expanded, so it must be absent before the click and present after.
    await expect(page.getByText('ADA')).toHaveCount(0);
    await page.getByText('Multi-Timeframe').click();
    await expect(page.getByText('ADA').first()).toBeVisible();
  });

  test('falls back to the production worker when the configured one is unreachable', async ({ page }) => {
    // The exact regression this page shipped a fix for (2026-09-11): a stale
    // localhost URL in localStorage reads as "Failed to fetch" on an https
    // page, even though the worker itself is healthy. getPublicBotsSummary
    // is supposed to fall through to DEFAULT_PUBLIC_WORKER_URL.
    await page.addInitScript(() => {
      window.localStorage.setItem('workerConfig', JSON.stringify({ baseUrl: 'http://localhost:3001' }));
    });
    // The real fallback target is the actual production Render worker — not
    // something this suite should hit. Intercept it too, distinctly, so the
    // test proves the FALLTHROUGH happened rather than a live network call.
    let fellThrough = false;
    await page.route('https://cde-main.onrender.com/**', async (route) => {
      fellThrough = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ serverTime: Date.now(), bots: [] })
      });
    });

    await page.goto('/live');

    await expect(page.getByText('רווח/הפסד כולל')).toBeVisible();
    expect(fellThrough).toBe(true);
  });
});
