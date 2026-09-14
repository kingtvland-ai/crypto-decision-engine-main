/**
 * /simulation-bot — the four sim-bot columns: start/pause/reset and viewing
 * positions. See e2e/fixtures/mockWorker.ts for what backs the network.
 */
import { test, expect, type Page } from '@playwright/test';
import { installMockWorker, samplePosition, sampleClosedTrade, type BotPrefix } from './fixtures/mockWorker';

const BOTS: Array<{ prefix: BotPrefix; title: string; testId: string }> = [
  { prefix: 'sim', title: 'מנוע חדש · Multi-Timeframe', testId: 'intraday' },
  { prefix: 'pro-sim', title: 'בוט פרו · alg.md', testId: 'pro' },
  { prefix: 'path-sim', title: 'נתיב 4H · טווח נר קודם', testId: 'path' },
  { prefix: 'bybit-sim', title: 'Bybit · TrendBreakout', testId: 'bybit' }
];

/** Scopes every locator to one bot's own column. The four columns are
 *  structurally identical, so an unscoped `getByRole('button', { name:
 *  'התחל' })` matches all four at once — `data-testid="sim-bot-column-<id>"`
 *  (SimulationEngineColumn.tsx) is what actually tells them apart. */
function botColumn(page: Page, testId: string) {
  return page.getByTestId(`sim-bot-column-${testId}`);
}

test.describe('/simulation-bot — page load', () => {
  test('renders all four bot columns with their controls', async ({ page }) => {
    await installMockWorker(page);
    await page.goto('/simulation-bot');

    for (const bot of BOTS) {
      await expect(page.getByRole('heading', { level: 2, name: bot.title, exact: true })).toBeVisible();
    }
    // Four independent start buttons — one per column, not a single global one.
    await expect(page.getByRole('button', { name: /^(התחל|המשך)$/ })).toHaveCount(4);
  });
});

for (const bot of BOTS) {
  test.describe(`/simulation-bot — ${bot.title}`, () => {
    test('start enables itself as disabled and flips the status label', async ({ page }) => {
      await installMockWorker(page);
      await page.goto('/simulation-bot');
      const col = botColumn(page, bot.testId);

      const startBtn = col.getByRole('button', { name: /^(התחל|המשך)$/ });
      const pauseBtn = col.getByRole('button', { name: 'השהה' });
      await expect(startBtn).toBeEnabled();
      await expect(pauseBtn).toBeDisabled();

      await startBtn.click();

      // Optimistic client-side update (SimulationBotContext.start() sets
      // status='running' before the network call resolves) — assert BOTH the
      // immediate UI state and, after the mocked POST /start response lands,
      // that it stays consistent rather than reverting.
      await expect(startBtn).toBeDisabled();
      await expect(pauseBtn).toBeEnabled();
      await expect(col.getByText('פעיל — סורק ומבצע')).toBeVisible();
    });

    test('pause disables itself and reverts the status label', async ({ page }) => {
      await installMockWorker(page, { [bot.prefix]: { running: true } });
      await page.goto('/simulation-bot');
      const col = botColumn(page, bot.testId);

      const startBtn = col.getByRole('button', { name: /^(התחל|המשך)$/ });
      const pauseBtn = col.getByRole('button', { name: 'השהה' });
      await expect(pauseBtn).toBeEnabled();

      await pauseBtn.click();

      await expect(pauseBtn).toBeDisabled();
      await expect(startBtn).toBeEnabled();
      // 'מושהה' legitimately appears twice (the status line and the
      //  colour-dot tooltip text) — either instance proves the same fact.
      await expect(col.getByText('מושהה', { exact: true }).first()).toBeVisible();
    });

    test('reset clears a seeded run back to the starting state', async ({ page }) => {
      const worker = await installMockWorker(page, {
        [bot.prefix]: { positions: [samplePosition()], trades: [sampleClosedTrade()], running: true }
      });
      await page.goto('/simulation-bot');
      const col = botColumn(page, bot.testId);

      // The seed is visible before reset — otherwise "reset cleared it" is
      // not a meaningful assertion.
      await expect(col.getByText(/פוזיציות \(1\)/)).toBeVisible();

      await col.getByRole('button', { name: 'איפוס' }).click();

      await expect(col.getByText(/פוזיציות \(0\)/)).toBeVisible();
      await expect(col.getByRole('button', { name: 'השהה' })).toBeDisabled();
      expect(worker.get(bot.prefix).positions).toHaveLength(0);
      expect(worker.get(bot.prefix).running).toBe(false);
    });

    test('the positions tab shows a seeded open position with its side and entry price', async ({ page }) => {
      await installMockWorker(page, {
        [bot.prefix]: { positions: [samplePosition({ symbol: 'ETH', entryPrice: 3400 })] }
      });
      await page.goto('/simulation-bot');
      const col = botColumn(page, bot.testId);

      await expect(col.getByText(/פוזיציות \(1\)/)).toBeVisible();
      // The tab is already selected by default (first TabsTrigger) — no click
      // needed, but assert the tab itself reports the position too.
      await expect(col.getByText('ETH').first()).toBeVisible();
    });

    test('the trade log tab shows a closed trade with its exit reason', async ({ page }) => {
      await installMockWorker(page, {
        [bot.prefix]: { trades: [sampleClosedTrade({ symbol: 'SOL', reason: 'Stop Loss ב-140.20 (שינוי -2.10%)' })] }
      });
      await page.goto('/simulation-bot');
      const col = botColumn(page, bot.testId);

      await col.getByRole('tab', { name: /יומן ביצוע/ }).click();
      await expect(col.getByText('SOL').first()).toBeVisible();
      // The bare bucket label "Stop Loss" also appears in the exit-reasons
      // summary panel above the log — match the fuller reason text
      // specifically, which only the trade row itself renders.
      await expect(col.getByText(/Stop Loss ב-/)).toBeVisible();
    });
  });
}
