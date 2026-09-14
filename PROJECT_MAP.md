# מפת פרויקט — crypto-decision-engine

> נכון ל-2026-09-10. מפה ניווטית: מה כל תיקייה, מי קורא למי, ואיפה לגעת
> לכל סוג שינוי.

---

## 1. במבט-על

```
crypto-decision-engine/
├── src/                  React + Vite + Tailwind  →  Netlify (dist/)
├── server/               Node worker (esbuild bundle) →  Render (server/dist/worker.js)
├── packages/engine/      @cde/engine — כל לוגיקת ההחלטה, משותפת ל-src ול-server
├── scripts/              כלי backtest / ניתוח חד-פעמיים (tsx, לא נפרס)
├── public/               נכסים סטטיים של ה-frontend
├── .github/workflows/    CI (ci.yml) + keepalive ל-Render (keepalive.yml)
├── TRASH/                תיעוד ישן + סקריפטים חד-פעמיים שהוצאו משימוש
└── *.md                  התיעוד החי (ראה §7)
```

**npm workspaces:** `packages/*` + `server`. `npm install` בשורש מתקין את שלושתם.

---

## 2. `packages/engine/` — `@cde/engine`

לב המערכת. **כל** החלטת מסחר מחושבת כאן — לא ב-`src/` ולא ב-`server/`.
המשמעות: תיקון כאן דורש **גם build של Netlify וגם build של Render**.

### 4 ה-entry points (barrels)
| import | תוכן |
|---|---|
| `@cde/engine` | `DecisionEngine` + 3 adapters + כל טיפוסי ה-DecisionEngine + טיפוסי הדומיין (`Candle`, `CryptoData`, …) + הגשר decision→UI + `intradayParams` + שער הקורלציה |
| `@cde/engine/analysis` | מנוע Pro (`computeProSignal`, משקלים, ספים), מנוע ה-Intraday MTF ו-internals שלו, כלי TA כלליים, `prev4hRange` |
| `@cde/engine/execution` | primitives של candle-math + fee/slippage, יצירת פקודות, מילויים, sizing לכל מנוע, `simExecution`, `slot preemption` |
| `@cde/engine/market-data` | שליפת OHLCV (Bybit → Binance → skip), יקום הנכסים, feeds של מחיר |

> מה שלא מיוצא מאחד מהארבעה — **internal**. אסור deep-import.

### `src/services/` (בתוך engine) — הקבצים המרכזיים
| קובץ | תפקיד |
|---|---|
| `decisionEngine/` | אורקסטרטור + `orchestrator.ts` + `adapters/{intraday,path}Adapter.ts` + `types.ts` (`DecisionContext`) |
| `intradayEngine.ts` + `intradayRegime/Setup/Entry/Exit/Risk/Indicators.ts` + `intradayParams.ts` | בוט **Intraday** — מנוע MTF מלא + כל הספים |
| `proAlgEngine.ts` | בוט **Pro** — 8 אינדיקטורים משוקללים → confidence |
| `prev4hRange.ts` + `prev4hRangeExecution.ts` | בוט **Prev-4H Range** (נתיב 4H) |
| `trendBreakout.ts` + `trendBreakoutExecution.ts` | בוט **TrendBreakout** (Bybit) — סיגנל + scale-in + ניהול סטופ |
| `simExecution.ts` | מנוע המילוי/עמלות/slippage/funding המשותף + `slot preemption` |
| `proSimExecution.ts` | שערי כניסה + יצירת פקודות ל-Pro (`pathSimExecution.ts` הוסר 2026-09-14 — היה קוד מת, ראה BOTS_REFERENCE.md §3) |
| `tradeEngine.ts` | primitives: `calculateEMA/ATR/ADX/Supertrend`, `BYBIT_FEES`, `simulateSlippage`, `roundToPriceScale` |
| `exitPolicy.ts` | מדיניות יציאה משותפת: תקרת 4.2%, TP1 3% (50% החוצה), TP2 |
| `adaptiveRisk.ts` | מכפיל סיכון לפי streak |
| `marketDataService.ts` | pipeline של OHLCV רב-טיימפריים + ולידציה + cache |
| `intradayBridge.ts` | `SignalEvaluation` — הגשר בין decision ל-UI/ביצוע |
| `pathEngine.ts` / `pathStudy.ts` | **קוד מת מסחרית** — נשאר רק בשביל `aggregateToH4` לבקטסטים |

---

## 3. `server/` — ה-worker (Render)

Node HTTP server (`node:http` גולמי, ניתוב לפי `url.pathname`). מקומפל
ע"י esbuild ל-bundle יחיד `server/dist/worker.js`.

| קובץ | תפקיד |
|---|---|
| `tradingWorker.ts` | **entry point.** `createServer`, ~35 routes, auth, CORS, לולאת הטיקים (כל 4 שניות) |
| `index.mjs` | shim — `import './tradingWorker.ts'` (dev: `npx tsx`) |
| `simEngineFactory.ts` | `createGenericSimEngine` — יוצר את 4 מופעי הבוטים, מריץ `buildEvaluations`/`generateOrders`, מחיל `applySlotPreemptions`, funding, mark-to-market |
| `simEngine.ts` | ה-`SimEngineStrategy` של **Intraday** |
| `proSimEngine.ts` / `pathSimEngine.ts` / `bybitSimEngine.ts` | ה-strategy plugs של Pro / Path / TrendBreakout |
| `backtestRunner.ts` | מריץ בקטסט על נתונים היסטוריים |
| `kvStore.ts` | Firestore (prod) / `server/.data/` (dev). state, ארכיון ריצות, warm-cache נרות |
| `historicalCandleCache.ts` | warm-cache דחוס של נרות |

### API (עיקרי)
```
GET  /health
GET  /api/public/{universe,sim-defaults,backtest-archive,bots-summary}
GET  /api/fear-greed
GET  /api/{sim,pro-sim,path-sim,bybit-sim}/state
POST /api/{sim,pro-sim,path-sim,bybit-sim}/{start,stop,reset,config}
POST /api/public/backtest-archive/clear
--- מאחורי BOT_ADMIN_TOKEN (כסף אמיתי): ---
GET  /api/bot/state · /api/account/summary · /api/decisions
POST /api/bot/{start,stop}
```
endpoints של סימולציה **חסרי טוקן** בכוונה.

---

## 4. `src/` — ה-frontend (Netlify)

React 18 + Vite + Tailwind + shadcn/ui (Radix) + recharts + react-router.

| נתיב | דף | קובץ |
|---|---|---|
| `/` | לוח ראשי | `pages/Index.tsx` |
| `/simulation-bot` | **דף 4 הבוטים** | `pages/SimulationBot.tsx` |
| `/real-trading` | בוט אמיתי | `pages/RealTradingBot.tsx` |
| `/backtest-results` | ארכיון ריצות | `pages/BacktestResults.tsx` |
| `/portfolio` · `/alerts` · `/advanced-analysis` · `/live` | תיק / התראות / ניתוח / לוח חי | בהתאמה |

### הזרימה בדף הסימולציה
```
SimulationBot.tsx
 ├── 4× Context (SimulationBotContext / Pro / Path / Bybit)
 │     └── hook (useSimulationBot / useProSimulationBot / ...)
 │           ├── polling ל-/api/<bot>-sim/state  (tradingApiClient.ts)
 │           ├── מריץ מקומית buildEvaluations/generateOrders מ-@cde/engine
 │           │   (mirror של ה-worker — כולל applySlotPreemptions)
 │           └── setPending / setPositions
 └── SimulationEngineColumn.tsx   ← כרטיסי הערכה + כרטיסי פוזיציה
       └── LivePositionChart.tsx  ← גרף 5-דק', סימון BUY, ביטחון הולוגרפי
```

| תיקייה | תוכן |
|---|---|
| `src/components/trading/` | `SimulationEngineColumn`, `LivePositionChart`, `PortfolioPulseCard`, `PortfolioRiskMeter`, `ProfitScale` |
| `src/hooks/` | `useSimulationBot`, `useProSimulationBot`, `useServerSimDefaults`, `useCryptoData`, `usePortfolio`, ... |
| `src/contexts/` | 4× SimulationBot context + `ThemeContext` + `WorkerAuthContext` |
| `src/services/` | `tradingApiClient` (→ worker), `bybitApi`, `binancePublicApi`, `coinGeckoApi`, `fearGreedApi`, `workerConfig` |
| `src/lib/` | `botAggregation`, `utils` |

---

## 5. בנייה, טיפוסים, בדיקות

| פקודה | מה |
|---|---|
| `npm run dev` | frontend → `:8080` |
| `npm --prefix server run dev` | worker → `:3001` (`npx tsx`) |
| `npm run build` | `vite build` → `dist/` (Netlify) |
| `npm run build:worker` | `npm --prefix server install && ... run build` → esbuild → `server/dist/worker.js` (Render) |
| `npm test` | vitest — כל החבילה (`src/__tests__/`) |
| `npm run typecheck` | `tsconfig.app.json` — ה-frontend |
| `npm run typecheck:worker` | `tsconfig.worker.json` — `server` + `packages/engine` |
| `cd packages/engine && npx tsc --noEmit` | טיפוסי ה-engine לבד |
| `npx tsc --noEmit -p tsconfig.node.json` | `vite.config` + `capacitor.config` + `server` + `scripts` |

**CI (`.github/workflows/ci.yml`)** מריץ: node typecheck → app typecheck →
`build:worker` → `build` → `test`. חייב לעבור לפני merge ל-`main`.

### tsconfig
| קובץ | מכסה | strict |
|---|---|---|
| `tsconfig.app.json` | `src/` | כן |
| `tsconfig.worker.json` | `server`, `packages/engine` | לא |
| `tsconfig.node.json` | `vite.config`, `capacitor.config`, `server`, `scripts` | כן |

---

## 6. פריסה — מי בונה מה

```
שינוי ב...                         →  צריך build של...
────────────────────────────────────────────────────────
src/**                             →  Netlify
packages/engine/**  או  server/**  →  Render  (וגם Netlify אם src משתמש בזה)
VITE_* (Netlify env)               →  Netlify — Clear cache and deploy
משתני Render env                   →  Render redeploy
```
מדריך מלא: `INSTALL_GUIDE.md`. הרקע (Netlify קורא את ה-worker של Render):
`C:\Users\meny\.claude\...\memory\netlify-reads-render-worker.md`.

---

## 7. התיעוד החי (`*.md` בשורש)

| קובץ | מה |
|---|---|
| `README.md` | נקודת כניסה |
| `INSTALL_GUIDE.md` | התקנת כל החיבורים (Firebase / Bybit / Render / Netlify / Telegram / Actions / מקומי) |
| `ALGO_MATH.md` | מבנה + מתמטיקה של 4 הבוטים (תצוגת נוסחאות) |
| `PROJECT_MAP.md` | קובץ זה |
| `BOTS_REFERENCE.md` | ייחוס 4 הבוטים עם הפניות-שורה מדויקות לקוד — **מקור האמת**, מתעדכן כשחישוב משתנה |
| `TRENDBREAKOUT_SPEC.md` | המפרט המלא של בוט TrendBreakout כפי שנמסר |

`TRASH/` — תיעוד ישן (analyst reports, fix plans, scoping), `ASTRAT.MD`,
`DEPLOYMENT.md` הישן, וסקריפטים חד-פעמיים. ראה `TRASH/README.md`.

### תיקיות נתונים (gitignored, נשארות על הדיסק)
`ASSETS/` (dumps ידניים + `alg.md` — מפרט Pro), `backtest-ab/`,
`path-study/` (`snapshot.json` ~208MB), `graphify-out/` (פלט כלי code-graph),
`server/.data/` (KV מקומי), `dist/`, `node_modules/`.
