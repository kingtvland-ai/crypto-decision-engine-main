# Graph Report - crypto-decision-engine-main  (2026-09-13)

## Corpus Check
- 249 files · ~340,947 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2780 nodes · 6676 edges · 141 communities (125 shown, 11 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 26 edges (avg confidence: 0.83)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `87c1dd8f`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- backtestSweep.ts
- lucide-react
- backtestRunner.ts
- tradingApiClient.ts
- tradingWorker.ts
- SimulationEngineColumn.tsx
- marketDataService.ts
- marketDataService.test.ts
- execution.ts
- Crypto Decision Engine SPA Entry (index.html)
- hooks/use-toast.ts
- 4. בוט Bybit (TrendBreakout · פריצת מגמה) — סימולציה בלבד
- decisionFunnel.ts
- Tools
- positionSizing.test.ts
- fearGreedApi.ts
- services/pathStudy.ts
- compilerOptions
- Gauge.tsx
- simExecution.ts
- manifest.json
- SimPosition
- market-data.ts
- compilerOptions
- compilerOptions
- DecisionContext
- createGenericSimEngine
- 4. TrendBreakout · Bybit — סימולציה בלבד
- prev4hRange.ts
- threeBotIntegration.test.ts
- components.json
- backtestCompare.ts
- correlation.test.ts
- simDefaults.ts
- compilerOptions
- toBaseAsset
- dependencies
- WorkerAuthContext.tsx
- Fix plan — unblock the four sim bots and cut the redundant gating
- analyzeDecisions.ts
- scan
- אלגוריתם ההחלטה של הבוטים (סימולציה ומסחר אמיתי)
- devDependencies
- main.tsx
- compilerOptions
- scripts
- server/package.json
- פירוט לפי סעיף
- 1. מנוע TrendBreakout המלא (`trendBreakout.ts` + `trendBreakoutExecution.ts`)
- intradayEngine.ts
- BacktestResults.tsx
- errorHandlerSanitizer.test.ts
- LivePositionChart.tsx
- cn
- Candle
- analysis.ts
- src/index.ts
- symbolUniverse.ts
- json
- engine/package.json
- smartRecommendationEngine.ts
- useApiPollingCascade.test.ts
- shutdown
- proConfidenceProfile.ts
- Analyst report — why Pro & "new" over-abstain, and how to make all four sim bots trade more consistently
- tradeEngine.ts
- react
- smoke-test.mjs
- skills-generation-protocol.md
- package.json
- TradingApiClient
- sonner.tsx
- duplicatePositionStacking.test.ts
- backtestLegacyPro.ts
- sanitizeSimConfig
- BotRequest
- מפרט מלא — בוט הסימולציה הרביעי: `TrendBreakout` ("Bybit")
- capacitor.config.ts
- allowScripts
- דוח אימות — האם ההחלטות בוצעו? (בדיקה אמפירית בקוד)
- דוח אימות ממצאים + תוכנית תיקונים
- CI Workflow (GitHub Actions)
- DEPLOYMENT — הגדרת Render + Netlify + Firebase
- render.yaml Render Web Service Config
- vitest
- trendBreakoutExecution.ts
- PortfolioBuilder.tsx
- types.ts
- PathSimulationBotContext.tsx
- fundingOrthogonality.ts
- intradayMandatory.test.ts
- emaSeedingImpact.ts
- מדריך התקנה מלא — כל החיבורים של המערכת
- anthropic_api_in_artifacts
- useSimulationBot.ts
- ProSimulationBotContext.tsx
- LiveBoard.tsx
- AdvancedAnalysis.tsx
- prev4hRangeLossFixes.test.ts
- מפת פרויקט — crypto-decision-engine
- intradayAdapter.ts
- intradayLossFixes.test.ts
- דוח אנליסט — סתירות ובאגים בדף "השוואת ביצועי הבוטים"
- crypto-decision-engine
- claude-fable-5.1.md
- SCOPING — Limit/Market toggle + dynamic Risk Profile, for all 4 sim bots
- 3. נתיב 4H (Prev-4H Range · טווח נר קודם)
- claude_behavior
- exitPolicy.ts
- contentSanitizer
- 2. בוט פרו (Pro · alg.md מדויק)
- computer_use
- 1. בוט חדש (Intraday · Multi-Timeframe)
- search_instructions
- when_to_use_visualizer_for_inline_visuals
- 1. Intraday · Multi-Timeframe
- mcp_app_suggestions
- artifact_usage_criteria
- CRITICAL_COPYRIGHT_COMPLIANCE
- persistent_storage_for_artifacts
- request_evaluation_checklist
- 1. Firebase — Firestore + Service Account
- מבנה האלגוריתם והמתמטיקה — 4 בוטי הסימולציה
- TRASH — קבצים שהוצאו משימוש
- createKVStore
- 5. מתמטיקת העלות והסיכון המשותפת (`simExecution.ts`)
- 2. Pro · alg.md
- 3. Prev-4H Range · נתיב 4H
- trendBreakoutScaleRisk.test.ts
- 3. Render — ה-worker
- binancePublicApi.ts
- binanceUnlistedSymbols.test.ts
- eslint.config.js
- service-worker.js
- tailwindcss
- vite.config.ts

## God Nodes (most connected - your core abstractions)
1. `Tools` - 98 edges
2. `Candle` - 75 edges
3. `cn()` - 65 edges
4. `react` - 61 edges
5. `vitest` - 47 edges
6. `SimPosition` - 47 edges
7. `SignalEvaluation` - 45 edges
8. `PendingOrder` - 44 edges
9. `lucide-react` - 39 edges
10. `generateTrendBreakoutOrders()` - 32 edges

## Surprising Connections (you probably didn't know these)
- `Placeholder Image Icon SVG` --conceptually_related_to--> `Crypto Decision Engine SPA Entry (index.html)`  [INFERRED]
  public/placeholder.svg → index.html
- `toInternalSymbol()` --calls--> `toBaseAsset()`  [EXTRACTED]
  src/services/bybitApi.ts → packages/engine/src/services/assetUniverse.ts
- `tick()` --indirect_call--> `computeAtr5()`  [INFERRED]
  server/simEngineFactory.ts → packages/engine/src/services/intradayBridge.ts
- `useSimulationBot()` --indirect_call--> `computeAtr5()`  [INFERRED]
  src/hooks/useSimulationBot.ts → packages/engine/src/services/intradayBridge.ts
- `ScanResult` --references--> `IntradayDecision`  [EXTRACTED]
  server/tradingWorker.ts → packages/engine/src/services/intradayEngine.ts

## Import Cycles
- None detected.

## Communities (141 total, 11 thin omitted)

### Community 0 - "backtestSweep.ts"
Cohesion: 0.06
Nodes (35): buildGrid(), Combo, ComboResult, CONC, DAYS, ENTRY_MIN, fetchHistory(), fetchKlinesPaged() (+27 more)

### Community 1 - "lucide-react"
Cohesion: 0.13
Nodes (35): CryptoRecommendation, FearGreedIndex, PortfolioAnalysis, lucide-react, AIChatbotProps, Message, AlertsPanelProps, CryptoCard() (+27 more)

### Community 2 - "backtestRunner.ts"
Cohesion: 0.07
Nodes (47): TradeSide, arg(), argNum(), Candle, cmdRun(), cmdSnapshot(), cmdSnapshotMtf(), FIXED_SL (+39 more)

### Community 3 - "tradingApiClient.ts"
Cohesion: 0.09
Nodes (37): SimBotConfig, BybitSimulationBotContext, BybitSimulationBotProvider(), DEFAULT_BYBIT_CONFIG, EMPTY_SNAPSHOT, DEFAULT_CONFIG, SimulationBotContext, SimulationBotProvider() (+29 more)

### Community 4 - "tradingWorker.ts"
Cohesion: 0.03
Nodes (58): BybitSimSnapshot, PathSimSnapshot, ProSimSnapshot, allowedOrigins, archiveStore, BoardSource, botSymbolsRaw, bybitMinConfidenceEnv (+50 more)

### Community 5 - "SimulationEngineColumn.tsx"
Cohesion: 0.08
Nodes (39): AIChatbot(), FloatingActionMenu(), FloatingActionMenuProps, Navigation(), Particle, ParticleBackground(), PersonalizedDashboard(), EmptyPortfolio() (+31 more)

### Community 6 - "marketDataService.ts"
Cohesion: 0.09
Nodes (39): toBybitSymbol(), binanceListsSymbol(), BybitKlineResponse, BybitTickerRow, cacheKey(), CandleSource, clearFundingCache(), dropFormingCandle() (+31 more)

### Community 7 - "marketDataService.test.ts"
Cohesion: 0.12
Nodes (9): clearMarketDataCache(), isAlignedToTimeframe(), TIMEFRAME_SPECS, TARGET_SYMBOLS, BybitKlineData, BybitTicker, toInternalSymbol(), buildBybitRows() (+1 more)

### Community 8 - "execution.ts"
Cohesion: 0.09
Nodes (41): AdaptiveRiskInput, adaptiveRiskPercentFromHistory(), ClosedTradeRecord, computeAdaptiveRiskPercent(), computeDrawdownFactor(), computeSizingMultiplier(), computeStreakFactor(), computeSymbolStreakCooldownUntil() (+33 more)

### Community 9 - "Crypto Decision Engine SPA Entry (index.html)"
Cohesion: 0.67
Nodes (3): Crypto Decision Engine SPA Entry (index.html), Placeholder Image Icon SVG, robots.txt Crawler Allow Policy

### Community 10 - "hooks/use-toast.ts"
Cohesion: 0.10
Nodes (28): @radix-ui/react-toast, AlertsPanel(), Toast, ToastAction, ToastActionElement, ToastClose, ToastDescription, ToastProps (+20 more)

### Community 11 - "4. בוט Bybit (TrendBreakout · פריצת מגמה) — סימולציה בלבד"
Cohesion: 0.14
Nodes (14): 4. בוט Bybit (TrendBreakout · פריצת מגמה) — סימולציה בלבד, Scale-in (§11) — מודל lots, SHORT, אישור כניסה (M5, §5), ביטחון (Score 0–100, §7), גודל פוזיציה (§14 + §15), יציאות (§13), מגמה (H1, §3) (+6 more)

### Community 12 - "decisionFunnel.ts"
Cohesion: 0.10
Nodes (28): Agg, BINANCE_INTERVAL, bump(), BybitApiResponse, BybitKlineResult, BybitTicker, BybitTickerResult, CONC (+20 more)

### Community 13 - "Tools"
Cohesion: 0.02
Nodes (98): ask_user_input_v0, bash_tool, chart_display_v0, comparison_card_display_v0, conversation_search, create_file, end_conversation, featured_card_display_v0 (+90 more)

### Community 14 - "positionSizing.test.ts"
Cohesion: 0.19
Nodes (8): DEFAULT_PREV4H_RANGE_PARAMS, readPrev4hRangePlan(), fillDueOrders(), MIN_ORDER_EXCEEDS_POSITION_TARGET, reanchorLevel(), uid(), calculateTradingFee(), fill()

### Community 15 - "fearGreedApi.ts"
Cohesion: 0.19
Nodes (8): AlternativeMeResponse, fearGreedApi, fetchDirect(), fetchFromWorker(), API_OK_BODY, fresh(), mockWorkerConfig, ValidationError

### Community 16 - "services/pathStudy.ts"
Cohesion: 0.05
Nodes (76): buildFearGreedSeries(), fearGreedAt(), FearGreedPoint, FearGreedSeries, fetchFearGreedHistory(), parseFearGreedPayload(), utcDayStart(), evaluatePathDecision() (+68 more)

### Community 17 - "compilerOptions"
Cohesion: 0.10
Nodes (19): compilerOptions, allowImportingTsExtensions, isolatedModules, jsx, lib, module, moduleDetection, moduleResolution (+11 more)

### Community 18 - "Gauge.tsx"
Cohesion: 0.57
Nodes (6): angleFor(), arcPath(), clamp(), Gauge(), GaugeProps, polarToXY()

### Community 19 - "simExecution.ts"
Cohesion: 0.07
Nodes (31): CAPITAL_FLOOR_PCT, pathEntryBudget(), computeEntryBudget(), DEFAULT_POSITION_PERCENT, ENTRY_COOLDOWN_MS, ENTRY_ORDER_SIDES, ENTRY_TTL_HOLD_FRACTION, EntryBudgetInput (+23 more)

### Community 20 - "manifest.json"
Cohesion: 0.11
Nodes (17): background_color, categories, description, dir, display, features, icons, lang (+9 more)

### Community 21 - "SimPosition"
Cohesion: 0.17
Nodes (30): FundingSnapshot, computeAtr5(), SignalEvaluation, PathOrderGenContext, Prev4hRangeOrderGenContext, ProOrderGenContext, PendingOrder, SimPoint (+22 more)

### Community 22 - "market-data.ts"
Cohesion: 0.23
Nodes (16): ANALYTICS_UNIVERSE, ASSET_REGISTRY, AssetRegistryEntry, EXCLUDED_BASES, EXTENDED_INTRADAY_UNIVERSE, getAssetTier(), INTRADAY_UNIVERSE, isExcludedAsset() (+8 more)

### Community 23 - "compilerOptions"
Cohesion: 0.12
Nodes (16): compilerOptions, allowImportingTsExtensions, esModuleInterop, isolatedModules, lib, module, moduleResolution, noEmit (+8 more)

### Community 24 - "compilerOptions"
Cohesion: 0.12
Nodes (16): compilerOptions, allowImportingTsExtensions, isolatedModules, lib, module, moduleDetection, moduleResolution, noEmit (+8 more)

### Community 25 - "DecisionContext"
Cohesion: 0.19
Nodes (8): IntradayAdapter, PathAdapter, DecisionEngine, DecisionContext, DecisionResult, EngineAdapter, EngineId, useSimulationBot()

### Community 26 - "createGenericSimEngine"
Cohesion: 0.21
Nodes (19): createBybitSimEngine(), createPathSimEngine(), createProSimEngine(), createSimEngine(), createGenericSimEngine(), buildH1CandlesForSymbol(), buildM5CandlesForSymbol(), drawdowns() (+11 more)

### Community 27 - "4. TrendBreakout · Bybit — סימולציה בלבד"
Cohesion: 0.18
Nodes (11): 4. TrendBreakout · Bybit — סימולציה בלבד, Scale-in (§11) — מודל lots, SHORT, יציאות (§13), מצב מילוי — MARKET בלבד (2026-09-10), מתמטיקת ה-TP (§10), מתמטיקת הביטחון (Score 0–100, §7), מתמטיקת הגודל (§14–15) (+3 more)

### Community 28 - "prev4hRange.ts"
Cohesion: 0.07
Nodes (41): FIXED_SL_PCT, FIXED_TP1_PCT, FIXED_TP2_PCT, isBuyingSurge(), LadderPercents, resolveLadderPercents(), SURGE_MAX_SL_PCT, SURGE_MIN_SL_PCT (+33 more)

### Community 29 - "threeBotIntegration.test.ts"
Cohesion: 0.09
Nodes (36): RFC-4180, PathRegime, BYBIT_SIM_BOT_LAST_KNOWN_RUNNING_KEY, PATH_SIM_BOT_LAST_KNOWN_RUNNING_KEY, PRO_SIM_BOT_STORAGE_KEY, SIM_BOT_STORAGE_KEY, AggregatableContext, AggregatedBot (+28 more)

### Community 30 - "components.json"
Cohesion: 0.12
Nodes (16): aliases, components, hooks, lib, ui, utils, rsc, $schema (+8 more)

### Community 31 - "backtestCompare.ts"
Cohesion: 0.16
Nodes (16): BINANCE_INTERVAL, BybitKlineResponse, CONC, fetchBinance(), fetchBybit(), fetchJson(), fetchKlines(), FM_LIMIT (+8 more)

### Community 32 - "correlation.test.ts"
Cohesion: 0.43
Nodes (4): alignCloses(), correlationBetween(), pearsonCorrelation(), toLogReturns()

### Community 33 - "simDefaults.ts"
Cohesion: 0.15
Nodes (18): MAX_TOTAL_EXPOSURE_PERCENT, POSITION_TARGET_PCT, MIN_PATH_CANDLES, PATH_MIN_H4_BARS, ConfidenceScale, riskLevelToMaxPositions(), SIM_BASE_DEFAULTS, SIM_BOT_IDS (+10 more)

### Community 34 - "compilerOptions"
Cohesion: 0.12
Nodes (16): compilerOptions, allowImportingTsExtensions, esModuleInterop, isolatedModules, lib, module, moduleResolution, noEmit (+8 more)

### Community 35 - "toBaseAsset"
Cohesion: 0.20
Nodes (16): toBaseAsset(), CRYPTO_IDS, BinanceKlineRaw, BinanceTicker, CandleCache, coinGeckoPriceCache, fetchBinanceAllTickers(), fetchBybitAllTickers() (+8 more)

### Community 36 - "dependencies"
Cohesion: 0.03
Nodes (59): dependencies, @capacitor/android, @capacitor/cli, @capacitor/core, @capacitor/ios, class-variance-authority, clsx, cmdk (+51 more)

### Community 37 - "WorkerAuthContext.tsx"
Cohesion: 0.18
Nodes (13): WorkerAuthContext, WorkerAuthContextValue, WorkerAuthProvider(), fetchLiveUniverse(), getActiveSymbols(), getPublicBotsSummary(), DEFAULT_PUBLIC_WORKER_URL, resolvePublicBoardUrls() (+5 more)

### Community 38 - "Fix plan — unblock the four sim bots and cut the redundant gating"
Cohesion: 0.04
Nodes (44): Algorithm as it runs today, Algorithm as it runs today, Algorithm today, Algorithm today, BOT 1 — Pro (`proAlgEngine.ts`, `proSimExecution.ts`), BOT 2 — new / intraday (`intradayEngine.ts`, `intradayRegime.ts`, `intradaySetup.ts`, `intradayEntry.ts`, `intradayRisk.ts`, `intradayAdapter.ts`), BOT 3 — Path / prev4hRange (`prev4hRange.ts`, `prev4hRangeExecution.ts`), BOT 4 — Bybit / TrendBreakout (`trendBreakout.ts`, `trendBreakoutExecution.ts`) (+36 more)

### Community 39 - "analyzeDecisions.ts"
Cohesion: 0.21
Nodes (13): BUCKET_BOUNDS, BUCKET_LABELS, BucketStats, computeBuckets(), formatPercent(), getBucketIndex(), getTopReason(), main() (+5 more)

### Community 40 - "scan"
Cohesion: 0.24
Nodes (15): baseCoin(), bybitExec(), checkClosedFuturesPositions(), checkClosedSpotPositions(), confirmSpotEntries(), executeOrder(), fetchWithTimeout(), getAccountContext() (+7 more)

### Community 41 - "אלגוריתם ההחלטה של הבוטים (סימולציה ומסחר אמיתי)"
Cohesion: 0.14
Nodes (13): 10. תרשים זרימה מקוצר, 1. מקורות הנתונים, 2. מנוע ההמלצות — חישוב הביטחון, 3. סף הביצוע של הבוט, 4. שכבת ההערכה (Single Source of Truth), 5. יציאות ניהול סיכון (עצמאיות מההמלצות), 6. מנוע הביצוע — עמלות, החלקה והשהיה, 7. מחזור החיים והרציפות (+5 more)

### Community 42 - "devDependencies"
Cohesion: 0.10
Nodes (20): devDependencies, autoprefixer, eslint, @eslint/js, eslint-plugin-react-hooks, eslint-plugin-react-refresh, globals, lovable-tagger (+12 more)

### Community 43 - "main.tsx"
Cohesion: 0.38
Nodes (4): App(), rootElement, isProduction, initializeProductionOptimizations()

### Community 44 - "compilerOptions"
Cohesion: 0.17
Nodes (11): compilerOptions, allowJs, noImplicitAny, noUnusedLocals, noUnusedParameters, paths, skipLibCheck, strictNullChecks (+3 more)

### Community 45 - "scripts"
Cohesion: 0.15
Nodes (13): scripts, build, build:dev, build:worker, dev, lint, preview, start (+5 more)

### Community 46 - "server/package.json"
Cohesion: 0.10
Nodes (20): dependencies, dotenv, devDependencies, esbuild, tsx, typescript, engines, node (+12 more)

### Community 47 - "פירוט לפי סעיף"
Cohesion: 0.06
Nodes (34): §10 — signalPrice מול actualFillPrice, §11 — Position Target מול Actual Fill, §12 — Parameter Source of Truth, §13 — Closed Candle Consistency, §14 — Prev4hRange Candle Closure, §15 — Backtest מול Sim/Live Economics, §16 — Pro Bot HOLD מול ALREADY_HELD, §17 — Pro Bot Confidence Reproducibility (+26 more)

### Community 48 - "1. מנוע TrendBreakout המלא (`trendBreakout.ts` + `trendBreakoutExecution.ts`)"
Cohesion: 0.07
Nodes (29): 1.1 פרמטרים (spec §23), 1.2 זרימה (state machine — spec §6), 1.3 אינדיקטורים (סעיף 2 — closed candles only), 1.4 חישוב Score (סעיף 7), 1.5 Entry / SL / TP (סעיפים 9/10), 1.6 Stop management (סעיף 12), 1.7 Exits (סעיף 13), 1. מנוע TrendBreakout המלא (`trendBreakout.ts` + `trendBreakoutExecution.ts`) (+21 more)

### Community 49 - "intradayEngine.ts"
Cohesion: 0.08
Nodes (50): BacktestMetrics, BacktestResult, BacktestTrade, computeMetrics(), OpenPosition, PendingOrder, runBacktest(), runRiskVariants() (+42 more)

### Community 50 - "BacktestResults.tsx"
Cohesion: 0.22
Nodes (14): useBybitSimulationBotContext(), usePathSimulationBotContext(), useProSimulationBotContext(), useSimulationBotContext(), BacktestResults(), BotInput, BotKey, BotStats (+6 more)

### Community 51 - "errorHandlerSanitizer.test.ts"
Cohesion: 0.22
Nodes (14): APIError, AppError, fetchJson(), FetchJsonOptions, handleError(), isRetryable(), NetworkError, readJson() (+6 more)

### Community 52 - "LivePositionChart.tsx"
Cohesion: 0.25
Nodes (8): recharts, Candle, fmtClock(), fmtDay(), LivePositionChart(), LivePositionChartProps, Row, formatFullPrice()

### Community 53 - "cn"
Cohesion: 0.08
Nodes (37): class-variance-authority, @radix-ui/react-dropdown-menu, CryptoChart(), CryptoChartProps, Alert, AlertDescription, AlertTitle, alertVariants (+29 more)

### Community 54 - "Candle"
Cohesion: 0.16
Nodes (13): BacktestHistory, CandleValidationResult, FetchTimeframeResult, MultiTimeframeSnapshot, TimeframeCacheEntry, Candle, Snapshot, basePortfolio (+5 more)

### Community 55 - "analysis.ts"
Cohesion: 0.07
Nodes (67): TP2_PERCENT, aggregateProBuckets(), calculateOptimalEntryPrice(), computeProSignal(), evaluateProExit(), MIN_PRO_CANDLES, PRO_CONFIDENCE_BY_RISK, PRO_CORRELATED_CLUSTER (+59 more)

### Community 56 - "src/index.ts"
Cohesion: 0.08
Nodes (48): CORRELATION_LOOKBACK_FLOOR, CorrelationGateInput, CorrelationMatch, MIN_CORRELATION_SAMPLES, PositionDirection, buildExitView(), buildFactorsFromDecisionResult(), buildPortfolioRiskStats() (+40 more)

### Community 57 - "symbolUniverse.ts"
Cohesion: 0.27
Nodes (9): baseAndKind(), BybitTickerRow, computeLiquidUniverse(), EXCLUDE_BASES, fetchTickers(), LiquidUniverseResult, MIN_SPOT_VOLUME_FOR_INCLUSION, MULTIPLIER_PREFIXES (+1 more)

### Community 58 - "json"
Cohesion: 0.22
Nodes (7): BotResponse, currentFearGreed(), fetchFearGreed(), fetchFearGreedFull(), json(), setCors(), startSimTicker()

### Community 59 - "engine/package.json"
Cohesion: 0.22
Nodes (8): exports, ./analysis, ./execution, ./market-data, name, private, type, version

### Community 60 - "smartRecommendationEngine.ts"
Cohesion: 0.16
Nodes (20): analyzeBollingerBands(), analyzeMacd(), analyzeMarketSentiment(), analyzePriceMomentum(), analyzeRSI(), analyzeStochastic(), analyzeSupportResistance(), analyzeVolume() (+12 more)

### Community 61 - "useApiPollingCascade.test.ts"
Cohesion: 0.25
Nodes (4): createHarness(), depsEqual(), Harness, PollFn

### Community 62 - "shutdown"
Cohesion: 0.33
Nodes (6): persistBybitSim(), persistPathSim(), persistProSim(), persistSim(), serializeState(), shutdown()

### Community 63 - "proConfidenceProfile.ts"
Cohesion: 0.52
Nodes (6): arg(), klines(), main(), q(), share(), topSymbols()

### Community 64 - "Analyst report — why Pro & "new" over-abstain, and how to make all four sim bots trade more consistently"
Cohesion: 0.09
Nodes (22): 0. TL;DR, 1.1 The signal is structurally a capitulation-dip buyer, 1.2 …and then `isDowntrend` blocks exactly that, 1.3 The confidence threshold is **not** the bottleneck, 1.4 Risk flaw — flat 4.2% stop against a 3% target, 1.5 Cruft introduced by the last parallel session (`db9e864`/`6c300cd`), 1. Pro — `proAlgEngine.ts` + `proSimExecution.ts`, 2.1 The regime bucket is a cliff (`intradayRegime.ts`) (+14 more)

### Community 65 - "tradeEngine.ts"
Cohesion: 0.11
Nodes (56): confirmEntry5M(), emptyEntry(), atrRegime(), AtrRegimeResult, bollinger(), BollingerResult, candleQuality, clamp() (+48 more)

### Community 66 - "react"
Cohesion: 0.12
Nodes (10): react, react-router-dom, queryClient, ErrorBoundary, TooltipContent, Theme, ThemeContext, ThemeContextType (+2 more)

### Community 68 - "skills-generation-protocol.md"
Cohesion: 0.08
Nodes (25): 10. PROJECT-SPECIFIC SKILLS, 11. SKILL SELECTION MATRIX, 12. PROJECT RULE GENERATION, 13. GLOBAL VS PROJECT RULES, 14. RULE PRIORITY, 15. SKILL UPDATE RULE, 16. SKILL VERSIONING, 17. SKILL VALIDATION (+17 more)

### Community 69 - "package.json"
Cohesion: 0.03
Nodes (59): dotenv, esbuild, tsx, typescript, name, private, type, version (+51 more)

### Community 71 - "sonner.tsx"
Cohesion: 0.40
Nodes (4): next-themes, sonner, Toaster(), ToasterProps

### Community 72 - "duplicatePositionStacking.test.ts"
Cohesion: 0.15
Nodes (7): isLongSide(), generateProOrders(), applySlotPreemptions(), SLOT_PREEMPT_MARGIN, useProSimulationBot(), baseCtx, candlesBySymbol

### Community 73 - "backtestLegacyPro.ts"
Cohesion: 0.40
Nodes (3): CONC, DAYS, SYMS

### Community 74 - "sanitizeSimConfig"
Cohesion: 0.33
Nodes (6): applySimConfigPatch(), hydrateBybitSim(), hydratePathSim(), hydrateProSim(), hydrateSim(), sanitizeSimConfig()

### Community 76 - "מפרט מלא — בוט הסימולציה הרביעי: `TrendBreakout` ("Bybit")"
Cohesion: 0.08
Nodes (26): 10. Take Profit, 11. SCALE — Scale-in מדורג (לא פותחים הכול בבת אחת), 12. Stop Management, 13. Exit Conditions, 14. Risk Management, 15. Exposure Limits, 16. Drawdown Protection, 17. Simulation Execution (+18 more)

### Community 78 - "allowScripts"
Cohesion: 0.40
Nodes (5): allowScripts, esbuild@0.21.5, esbuild@0.25.0, esbuild@0.28.2, @swc/core@1.16.1

### Community 79 - "דוח אימות — האם ההחלטות בוצעו? (בדיקה אמפירית בקוד)"
Cohesion: 0.09
Nodes (21): ⚠️ אזהרה על הטסטים החדשים (`positionSizing.test.ts`), ✅ בוצע ואומת, דוח אימות — האם ההחלטות בוצעו? (בדיקה אמפירית בקוד), 🟡 חלקי, טבלת ההחלטות שלך — מצב בפועל, ❌ לא בוצע, ממצאים חדשים, ❌ נשאר פתוח (deliverables גדולים, 0% קוד) (+13 more)

### Community 80 - "דוח אימות ממצאים + תוכנית תיקונים"
Cohesion: 0.10
Nodes (19): 1. ⚠️ `calculateEMA` — באג seeding בליבה (לא רק Bybit), 2. ✅ Path — שער ה-RR הופך את רכיב ה-breakout לחצי-מת, 3. ✅ Pro — breakeven ב-61.1%, 4. ✅ Pro — רצועות מומנטום דיסקרטיות, 5. ✅ `fillDueOrders` — מילוי מוקטן (מעלה בדירוג ל-P0), 6. ליקויים משניים — כולם מאומתים, דוח אימות ממצאים + תוכנית תיקונים, הערה על `minH1: 200` (+11 more)

### Community 82 - "DEPLOYMENT — הגדרת Render + Netlify + Firebase"
Cohesion: 0.11
Nodes (17): 1.1 יצירת הפרויקט, 1.2 יצירת Service Account, 1.3 המרה לשורה אחת (חובה למשתנה סביבה), 1.4 שני המשתנים ל-Render, 1. Firebase — Firestore + Service Account, 2.1 הגדרות השירות, 2.2 משתני סביבה (Dashboard → Environment), 2.3 בדיקה אחרי deploy (+9 more)

### Community 84 - "vitest"
Cohesion: 0.09
Nodes (17): applyFundingAccrual(), SIM_INTRADAY_PARAMS_OVERRIDE, vitest, heldPosition(), pathCtx(), pathEval(), baseCtx, SW_SOURCE (+9 more)

### Community 85 - "trendBreakoutExecution.ts"
Cohesion: 0.11
Nodes (48): isInStreakCooldown(), portfolioStreakCooldownUntil(), streakCooldownFromHistory(), abstentionBlockReason(), blocksOnAbstention(), clampNum(), CorrelatedHolding, DEFAULT_CORRELATION_LOOKBACK (+40 more)

### Community 86 - "PortfolioBuilder.tsx"
Cohesion: 0.12
Nodes (24): PortfolioItem, @radix-ui/react-label, AddCryptoForm(), AddCryptoFormProps, CurrentPortfolioItems(), CurrentPortfolioItemsProps, PortfolioSummary(), PortfolioSummaryProps (+16 more)

### Community 87 - "types.ts"
Cohesion: 0.22
Nodes (14): CorrelationGateResult, PathEngineParams, DecisionEngineOptions, DecisionOutcome, EngineParams, MarketDataSnapshot, MultiTimeframeCandles, OpenPosition (+6 more)

### Community 88 - "PathSimulationBotContext.tsx"
Cohesion: 0.26
Nodes (10): DEFAULT_PATH_CONFIG, EMPTY_SNAPSHOT, PathSimulationBotContext, PathSimulationBotProvider(), useWorkerAuth(), getPathSimState(), resetPathSim(), setPathSimConfig() (+2 more)

### Community 89 - "fundingOrthogonality.ts"
Cohesion: 0.20
Nodes (13): annualisedFundingPct(), evaluateFundingGate(), FUNDING_CROWDED_ANNUAL_PCT, FUNDING_EXTREME_ANNUAL_PCT, FUNDING_MAX_AGE_MS, FUNDING_MIN_SIZE_MULTIPLIER, FUNDING_PERIODS_PER_YEAR, FundingVerdict (+5 more)

### Community 90 - "intradayMandatory.test.ts"
Cohesion: 0.39
Nodes (6): bullScenario(), candlesFromCloses(), rangePath(), rangeScenario(), TF, trendPath()

### Community 91 - "emaSeedingImpact.ts"
Cohesion: 0.33
Nodes (10): Candle, clamp01(), emaShipped(), emaTextbook(), fetchKlines(), last(), main(), pct() (+2 more)

### Community 92 - "מדריך התקנה מלא — כל החיבורים של המערכת"
Cohesion: 0.12
Nodes (17): 0. ארכיטקטורה — מי מדבר עם מי, 10. טבלת משתני סביבה מלאה, 2.1 מתי צריך מפתחות אמיתיים, 2.2 יצירת מפתח, 2.3 משתנים ל-Render, 2.4 בדיקה, 2. Bybit — מפתחות API, 4.1 הגדרות Build (+9 more)

### Community 93 - "anthropic_api_in_artifacts"
Cohesion: 0.12
Nodes (16): anthropic_api_in_artifacts, api_details, context_window_management, conversation_management, critical_ui_requirements, error_handling, handling_files, handling_tool_responses (+8 more)

### Community 94 - "useSimulationBot.ts"
Cohesion: 0.26
Nodes (10): SIM_MIN_CONFIDENCE, CryptoData, PortfolioBuilderProps, useBackgroundWorker(), UseBackgroundWorkerOptions, loadPersisted(), Params, loadPersisted() (+2 more)

### Community 95 - "ProSimulationBotContext.tsx"
Cohesion: 0.15
Nodes (16): ExecutiveDashboard(), DEFAULT_PRO_CONFIG, ProSimulationBotContext, ProSimulationBotProvider(), useProSimulationBotContextSafe(), useSimulationBotContextSafe(), useApiPolling(), UseApiPollingOptions (+8 more)

### Community 96 - "LiveBoard.tsx"
Cohesion: 0.22
Nodes (14): ACCENT, accentOf(), BotCard(), clock(), LiveBoard(), pct(), price(), SIDE_LABEL (+6 more)

### Community 97 - "AdvancedAnalysis.tsx"
Cohesion: 0.10
Nodes (22): @tanstack/react-query, candles, r, MarketOverview(), MatrixBackground(), MatrixBackgroundProps, SmartTipsPanel(), fromBybitSymbol() (+14 more)

### Community 98 - "prev4hRangeLossFixes.test.ts"
Cohesion: 0.13
Nodes (7): PREV4H_MIN_H1_CANDLES, Prev4hRangePlan, C, C, evalAt(), H1, NOW

### Community 99 - "מפת פרויקט — crypto-decision-engine"
Cohesion: 0.13
Nodes (14): 1. במבט-על, 2. `packages/engine/` — `@cde/engine`, 3. `server/` — ה-worker (Render), 4. `src/` — ה-frontend (Netlify), 4 ה-entry points (barrels), 5. בנייה, טיפוסים, בדיקות, 6. פריסה — מי בונה מה, 7. התיעוד החי (`*.md` בשורש) (+6 more)

### Community 100 - "intradayAdapter.ts"
Cohesion: 0.17
Nodes (12): CircuitBreakerStage, ExposureStage, intradayResultCache, mapDirection(), mapOutcome(), mapRiskPlan(), mapTradeType(), RunEngineStage (+4 more)

### Community 101 - "intradayLossFixes.test.ts"
Cohesion: 0.24
Nodes (6): bullScenario(), candlesFromCloses(), confirmedShort, ExitPos, TF, trendPath()

### Community 102 - "דוח אנליסט — סתירות ובאגים בדף "השוואת ביצועי הבוטים""
Cohesion: 0.14
Nodes (13): 🔴 F-1 — בסיס ההון מקודד קשיח ל-‎$10,000‎ (שורש ה-−90%), 🔴 F-2 — שורת ה-"סה"כ" סובלת מאותו באג, מוכפל פי 4, 🟠 F-3 — שני מדדי P&L שונים מוצגים זה לצד זה בלי הבחנה, 🟠 F-4 — `hasServerData` לא נבדק: בוט מנותק נספר כ-"שטוח, 0%", 🟡 F-5 — הדף מחשב מחדש Win Rate / מספר עסקאות במקום להשתמש בנתוני השרת, 🟡 F-6 — אין בדיקת-שפיות (reconciliation) על המסך, דוח אנליסט — סתירות ובאגים בדף "השוואת ביצועי הבוטים", הערכת אנליסט (+5 more)

### Community 103 - "crypto-decision-engine"
Cohesion: 0.15
Nodes (9): crypto-decision-engine, ארכיטקטורה, בדיקות ו-typecheck (לפני push), הבוטים (`/simulation-bot`), הרצה מקומית, מבנה, סטאק, פריסה (+1 more)

### Community 104 - "claude-fable-5.1.md"
Cohesion: 0.15
Nodes (12): Addressing potential self-harm or violent harm to others, available_skills, end_conversation_tool_info, How to suggest, memory_filesystem, network_configuration, past_chats_tools, preferences_info (+4 more)

### Community 105 - "SCOPING — Limit/Market toggle + dynamic Risk Profile, for all 4 sim bots"
Cohesion: 0.17
Nodes (11): 0. Worker URL — `cde-main.onrender.com` (תיקון קטן), 1. Limit / Market toggle — מצב נוכחי לכל בוט, 2. פרופיל סיכון (low / medium / high) — מצב נוכחי, 3. Intraday → מודל `equity × 10%` (מההודעה הקודמת), 4. סיכום קבצים + הכרעות פתוחות, SCOPING — Limit/Market toggle + dynamic Risk Profile, for all 4 sim bots, ✅ בוצע (2026-09-07), הכרעות שצריך ממך לפני ביצוע (+3 more)

### Community 106 - "3. נתיב 4H (Prev-4H Range · טווח נר קודם)"
Cohesion: 0.18
Nodes (11): 3. נתיב 4H (Prev-4H Range · טווח נר קודם), גודל פוזיציה, חישוב הביטחון (Score 0–100 — לא הסתברות!), חלון וזיהוי, יציאה, מה תוצאה בריאה אמורה להיראות, מעגל שבירה ותקרת נכס, נתוני קלט נדרשים (+3 more)

### Community 107 - "claude_behavior"
Cohesion: 0.18
Nodes (11): anthropic_reminders, claude_behavior, evenhandedness, knowledge_cutoff, legal_and_financial_advice, product_information, refusal_handling, reply_after_tool_calls (+3 more)

### Community 108 - "exitPolicy.ts"
Cohesion: 0.30
Nodes (10): cappedTakeProfitLevels(), capStopLoss(), ExitLevel, MAX_LOSS_PERCENT, maxLossStopLevel(), stopWasCapped(), takeProfitLevels(), TP1_EXIT_FRACTION (+2 more)

### Community 110 - "2. בוט פרו (Pro · alg.md מדויק)"
Cohesion: 0.20
Nodes (10): 2. בוט פרו (Pro · alg.md מדויק), גודל פוזיציה (§4 gate 7), חישוב הביטחון (Score 0–100), יציאה (`evaluateProExit`), כניסה — Market או Limit (§6, `proSimEngine.ts` config `proLimitEntries`), מה תוצאה בריאה אמורה להיראות, מעגל שבירה, נתוני קלט נדרשים (+2 more)

### Community 111 - "computer_use"
Cohesion: 0.20
Nodes (10): additional_skills_reminder, computer_use, file_creation_advice, file_handling_rules, high_level_computer_use_explanation, notes_on_user_uploaded_files, package_management, producing_outputs (+2 more)

### Community 112 - "1. בוט חדש (Intraday · Multi-Timeframe)"
Cohesion: 0.12
Nodes (16): 1. בוט חדש (Intraday · Multi-Timeframe), Funding (נוסף עם בוט 4, חל על כל ארבעתם), אין עוקף high-confidence, גודל פוזיציה וסיכון (`intradayRisk.ts` — `buildRiskPlan`), חישוב הביטחון, יציאה (Stop/Target דינמיים) — `buildRiskPlan` ב-`intradayRisk.ts`, מדרגת Scalp קבועה — `calmRegimeScalp` (2026-09-11, כבוי כברירת מחדל), מדריך ייחוס — ארבעת בוטי הסימולציה (+8 more)

### Community 113 - "search_instructions"
Cohesion: 0.22
Nodes (9): core_search_behaviors, Critical NEVER search for images in following categories (blocked):, critical_reminders, Examples of when **NOT** to use image search:, harmful_content_safety, Many queries benefits from images:, search_examples, search_instructions (+1 more)

### Community 114 - "when_to_use_visualizer_for_inline_visuals"
Cohesion: 0.25
Nodes (8): Content safety, Design guidance, Explicit triggers, Multi-visualization responses, Proactive triggers (no explicit ask needed), Specification triggers (no verb needed), visualizer_examples, when_to_use_visualizer_for_inline_visuals

### Community 115 - "1. Intraday · Multi-Timeframe"
Cohesion: 0.22
Nodes (9): 1. Intraday · Multi-Timeframe, R:R (תמיד מ-3 המספרים של `buildRiskPlan`), יציאות (`intradayExit.ts`, לפי עדיפות), מתמטיקת הביטחון, מתמטיקת הגודל (`buildRiskPlan`), מתמטיקת הסטופ / היעד (`buildRiskPlan`, מודל אחוזים), סדר השערים (§55 — כל שער עוצר את הראשון שנכשל), קלט נדרש (+1 more)

### Community 116 - "mcp_app_suggestions"
Cohesion: 0.29
Nodes (7): After search, Connector directory first, mcp_app_suggestions, [third_party_mcp_app] tools need opt-in, What not to do, What this should feel like, When to call an [third_party_mcp_app] tool directly

### Community 117 - "artifact_usage_criteria"
Cohesion: 0.29
Nodes (7): artifact_usage_criteria, CRITICAL BROWSER STORAGE RESTRICTION, Do NOT use artifacts for, HTML, Markdown, React, Use artifacts for

### Community 118 - "CRITICAL_COPYRIGHT_COMPLIANCE"
Cohesion: 0.29
Nodes (7): consequences_reminder, copyright_examples, core_copyright_principle, CRITICAL_COPYRIGHT_COMPLIANCE, hard_limits, mandatory_copyright_requirements, self_check_before_responding

### Community 119 - "persistent_storage_for_artifacts"
Cohesion: 0.29
Nodes (7): Data Scope, Error Handling, Key Design Pattern, Limitations, persistent_storage_for_artifacts, Storage API, Usage Examples

### Community 120 - "request_evaluation_checklist"
Cohesion: 0.40
Nodes (5): request_evaluation_checklist, Step 0 — Does the request need a visual at all?, Step 1 — Is a connected MCP tool a fit?, Step 2 — Did the person ask for a file?, Step 3 — Visualizer (default inline visual)

### Community 121 - "1. Firebase — Firestore + Service Account"
Cohesion: 0.40
Nodes (5): 1.1 יצירת הפרויקט, 1.2 יצירת Service Account, 1.3 המרה לשורה אחת (חובה למשתנה סביבה), 1.4 שני המשתנים ל-Render, 1. Firebase — Firestore + Service Account

### Community 122 - "מבנה האלגוריתם והמתמטיקה — 4 בוטי הסימולציה"
Cohesion: 0.25
Nodes (8): 0.1 שלושת השערים הקשיחים המשותפים, 0.2 מעגל שבירה (משותף, קבוע יחיד), 0.3 שער הקורלציה (Intraday · Path · TrendBreakout), 0.4 slot preemption (משותף, כל 4 הבוטים), 0. הצינור המשותף (כל טיק, כל בוט), 6. איך "תוצאה בריאה" נראית, 7. פערים ידועים (לתעד, לא לתקן), מבנה האלגוריתם והמתמטיקה — 4 בוטי הסימולציה

### Community 123 - "TRASH — קבצים שהוצאו משימוש"
Cohesion: 0.40
Nodes (4): `analyst-reports/`, `scratch/`, `superseded-docs/`, TRASH — קבצים שהוצאו משימוש

### Community 128 - "5. מתמטיקת העלות והסיכון המשותפת (`simExecution.ts`)"
Cohesion: 0.25
Nodes (8): 5. מתמטיקת העלות והסיכון המשותפת (`simExecution.ts`), Funding (FUTURES פתוחות בלבד, כל 4 הבוטים), מדרגת Scalp קבועה (`calmRegime.ts`, opt-in, 2026-09-11), מילוי, מכפיל סיכון אדפטיבי (`adaptiveRisk.ts`), עמלות, קבועים משותפים (מקור יחיד — `intradayParams.ts`), רצפת גודל בפחד שוק (`fearGreedSizeBoost`, opt-in, Intraday בלבד)

### Community 129 - "2. Pro · alg.md"
Cohesion: 0.29
Nodes (7): 2. Pro · alg.md, יציאה, כניסה — Market / Limit (`proLimitEntries`), מתמטיקת הביטחון (Score 0–100), מתמטיקת הגודל, סף כניסה, שערי כניסה (`applyProEntryGates`, אצווה ממוינת ביטחון-יורד)

### Community 130 - "3. Prev-4H Range · נתיב 4H"
Cohesion: 0.29
Nodes (7): 3. Prev-4H Range · נתיב 4H, חלון וזיהוי, יציאה, מתמטיקת הביטחון (Score 0–100 — לא הסתברות), מתמטיקת הגודל, פילטרים, קלט נדרש

### Community 131 - "trendBreakoutScaleRisk.test.ts"
Cohesion: 0.52
Nodes (6): ctx(), h1Uptrend(), lot(), lot0(), m15Flat(), scaleLotAtHalfR()

### Community 132 - "3. Render — ה-worker"
Cohesion: 0.40
Nodes (5): 3.1 הגדרות השירות, 3.2 משתני סביבה, 3.3 ⚠️ אי-עקביות ידועה ב-hostname, 3.4 בדיקה אחרי deploy, 3. Render — ה-worker

### Community 133 - "binancePublicApi.ts"
Cohesion: 0.40
Nodes (3): Binance24hTicker, BinanceKline, binancePublicApi

### Community 141 - "eslint.config.js"
Cohesion: 0.33
Nodes (5): @eslint/js, eslint-plugin-react-hooks, eslint-plugin-react-refresh, globals, typescript-eslint

### Community 148 - "vite.config.ts"
Cohesion: 0.50
Nodes (3): lovable-tagger, vite, @vitejs/plugin-react-swc

## Ambiguous Edges - Review These
- `CI Workflow (GitHub Actions)` → `CI Workflow (GitHub Actions)`  [AMBIGUOUS]
  .github/workflows/ci.yml · relation: references

## Knowledge Gaps
- **1099 isolated node(s):** `config`, `$schema`, `style`, `rsc`, `tsx` (+1094 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 1252 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **11 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `CI Workflow (GitHub Actions)` and `CI Workflow (GitHub Actions)`?**
  _Edge tagged AMBIGUOUS (relation: references) - confidence is low._
- **Why does `vitest` connect `vitest` to `backtestRunner.ts`, `trendBreakoutScaleRisk.test.ts`, `binanceUnlistedSymbols.test.ts`, `marketDataService.test.ts`, `execution.ts`, `positionSizing.test.ts`, `fearGreedApi.ts`, `services/pathStudy.ts`, `simExecution.ts`, `prev4hRange.ts`, `threeBotIntegration.test.ts`, `correlation.test.ts`, `simDefaults.ts`, `WorkerAuthContext.tsx`, `intradayEngine.ts`, `errorHandlerSanitizer.test.ts`, `Candle`, `analysis.ts`, `useApiPollingCascade.test.ts`, `package.json`, `duplicatePositionStacking.test.ts`, `trendBreakoutExecution.ts`, `intradayMandatory.test.ts`, `ProSimulationBotContext.tsx`, `prev4hRangeLossFixes.test.ts`, `intradayLossFixes.test.ts`, `exitPolicy.ts`?**
  _High betweenness centrality (0.065) - this node is a cross-community bridge._
- **Why does `dependencies` connect `dependencies` to `package.json`?**
  _High betweenness centrality (0.040) - this node is a cross-community bridge._
- **Why does `Candle` connect `Candle` to `backtestSweep.ts`, `backtestRunner.ts`, `trendBreakoutScaleRisk.test.ts`, `marketDataService.ts`, `marketDataService.test.ts`, `execution.ts`, `positionSizing.test.ts`, `services/pathStudy.ts`, `simExecution.ts`, `SimPosition`, `market-data.ts`, `prev4hRange.ts`, `threeBotIntegration.test.ts`, `correlation.test.ts`, `toBaseAsset`, `intradayEngine.ts`, `analysis.ts`, `src/index.ts`, `proConfidenceProfile.ts`, `tradeEngine.ts`, `duplicatePositionStacking.test.ts`, `vitest`, `trendBreakoutExecution.ts`, `types.ts`, `fundingOrthogonality.ts`, `intradayMandatory.test.ts`, `useSimulationBot.ts`, `intradayLossFixes.test.ts`?**
  _High betweenness centrality (0.040) - this node is a cross-community bridge._
- **What connects `config`, `$schema`, `style` to the rest of the system?**
  _1099 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `backtestSweep.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.06015037593984962 - nodes in this community are weakly interconnected._
- **Should `lucide-react` be split into smaller, more focused modules?**
  _Cohesion score 0.1320754716981132 - nodes in this community are weakly interconnected._