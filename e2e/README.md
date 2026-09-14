# E2E tests

Playwright, Chromium only. Covers the two flows the operator asked for:

- `simulation-bot.spec.ts` — the four sim-bot columns on `/simulation-bot`:
  start/pause/reset per bot, and viewing the positions / trade-log tabs.
- `live-board.spec.ts` — the public read-only `/live` board: all four bots
  shown, no controls anywhere, a card expands to its trade log, and the
  worker-URL fallback (localhost → production) actually falls through.

## Running

```bash
npm run test:e2e          # headless, once (starts the dev server itself)
npm run test:e2e:ui       # Playwright's interactive UI runner
npm run test:e2e:report   # open the last HTML report
npm run typecheck:e2e     # tsc --noEmit over this folder
```

First run on a machine needs the browser binary once: `npx playwright install
chromium`.

## Why everything is mocked

There is no test backend. The real one (`server/`) is a single shared Render
instance driving actual (simulated-money) trading bots for anyone who opens
the page — pointing E2E at it would mean polluting that shared state, or
flaking on whatever a live run happens to be doing. `fixtures/mockWorker.ts`
stubs the REST boundary the app itself treats as authoritative
(`SimulationBotContext` polls `/api/<bot>/state` and renders exactly what it
returns — see `applyServerState`), so this still tests the real UI reacting
to real response shapes, just not a live network. It also aborts the
third-party price feeds the app calls directly from the browser (Bybit,
Binance, CoinGecko, alternative.me) — the app already treats a failed fetch
from any one of them as "source unavailable" and falls through, so this is a
real handled path, not a special case invented for tests.

## Locating one bot's column

The four columns are structurally identical (`SimulationEngineColumn.tsx`
rendered four times). `data-testid="sim-bot-column-<id>"` on each column's
root (`<id>` ∈ `intraday | pro | path | bybit`, wired from `SimulationBot.tsx`)
is what actually tells them apart — an unscoped `getByRole('button', { name:
'התחל' })` matches all four at once.

## A Hebrew-specific gotcha that bit this suite once

`getByRole(..., { name: 'X' })` without `exact: true` does a substring match.
`'התחל'` (start) matched `/live`'s bot-card toggle buttons, because their
accessible name includes "...הון **התחל**תי $10,000" (starting capital) — a
real word sharing the root, not a hidden control. Any assertion that a
control is ABSENT needs `exact: true`, or a word that shares no root with
something else on the page.
