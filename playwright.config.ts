import { defineConfig, devices } from '@playwright/test';

/**
 * E2E config for the two flows the operator asked for: the simulation page
 * (start/pause/reset per bot, viewing positions) and the public /live board.
 *
 * Every test runs against a MOCKED worker — see e2e/fixtures/mockWorker.ts.
 * This app has no test backend and its real one is a shared Render instance
 * (`server/`) that drives real (simulated) money bots for anyone who opens
 * the page; pointing E2E at it would mean either polluting that shared state
 * or the tests flaking on whatever a real trading run happens to be doing at
 * the moment. Mocking the REST boundary (`/api/<bot>/state|start|stop|reset`,
 * `/api/public/bots-summary`) is what the app itself treats as authoritative
 * (SimulationBotContext polls it and renders exactly what it returns), so
 * this still tests the real UI reacting to real response shapes — just not a
 * live network.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['github']] : [['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:8080',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } }
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:8080',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000
  }
});
