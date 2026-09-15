# מבנה האלגוריתם והמתמטיקה — 4 בוטי הסימולציה

> תצוגת **מבנה + נוסחאות**. הגרסה עם הפניות-שורה מדויקות לקוד היא
> `BOTS_REFERENCE.md` — עדכן אותה כשחישוב משתנה. כאן: איך הצינור בנוי ומה
> המתמטיקה בכל שלב.
> נכון ל-2026-09-10 (+תוספת Volatility Profile ב-2026-09-16, §8). סימולציה
> בלבד — אף בוט לא שולח פקודה אמיתית.

הבוטים בדף `/simulation-bot`:

| מזהה | שם בממשק | קובץ סיגנל | קובץ ביצוע |
|---|---|---|---|
| `intraday` | מנוע חדש · Multi-Timeframe | `intradayEngine.ts` (+ regime/setup/entry/risk) | `simExecution.ts` |
| `pro` | Pro · alg.md | `proAlgEngine.ts` | `proSimExecution.ts` |
| `path` | נתיב 4H · טווח נר קודם | `prev4hRange.ts` | `prev4hRangeExecution.ts` |
| `bybit` | Bybit · TrendBreakout | `trendBreakout.ts` | `trendBreakoutExecution.ts` |

ארבעתם רצים כ-4 מופעים **נפרדים לחלוטין** של אותה תשתית
(`server/simEngineFactory.ts` → `createGenericSimEngine`): לכל אחד `cash`,
`positions`, `history` ו-KV נפרדים. משותפים רק **קבועים** (ספי drawdown, תקרת
נכס) ו**נתוני שוק** (נרות) — לא state.

---

## 0. הצינור המשותף (כל טיק, כל בוט)

```
נרות (Bybit/Binance/CoinGecko)
   │
   ▼
buildEvaluations()  ──► לכל סימבול: SignalEvaluation { willExecute, confidence, status, price, stopLoss, takeProfit1/2, optimalEntryPrice, ... }
   │                     ממויין לפי confidence יורד
   ▼
generateOrders()    ──► שערים קשיחים → פקודות entry/exit
   │                     (מקצה סלוטים/מזומן לאיתות החזק קודם)
   ▼
pending[]  ──► selectFillableOrders()  ──► fillDueOrders()
   │            limit: מילוי רק בחציית מחיר, TTL 2h    market: מילוי אחרי executionDelaySec
   ▼
positions[]  ──► applyFundingAccrual() → mark-to-market → equity
```

**מקור אמת יחיד:** אותו `SignalEvaluation` מזין גם את פאנל ההמלצות ב-UI וגם
את מנוע הביצוע — אין פער בין מה שמוצג למה שמבוצע.

### 0.1 שלושת השערים הקשיחים המשותפים
לכל בוט מותר **בדיוק שלושה** וטו קשיח; כל השאר נכנס לתוך מספר ביטחון אחד
שמושווה לסף אחד:
1. **NO_DATA** — אין מספיק נרות לחישוב.
2. **CIRCUIT_BREAKER / CAPITAL_FLOOR** — הגנת equity ברמת התיק.
3. **NO_ROOM** — אין סלוט פנוי או אין מזומן פנוי.

### 0.2 מעגל שבירה (משותף, קבוע יחיד)
```
dailyDrawdownPercent  ≥ 8%   → חסימת כניסות חדשות   (DAILY_DRAWDOWN_BLOCK_PERCENT)
weeklyDrawdownPercent ≥ 15%  → נעילה                (WEEKLY_DRAWDOWN_LOCK_PERCENT)
```
נמדד על ה-equity של כל בוט בנפרד. חוסם **פתיחה** בלבד — לא סוגר קיים.

### 0.3 שער הקורלציה (Intraday · Path · TrendBreakout)
```
ρ = Pearson על log-returns של 72 נרות H1 (רצפה 36, מתכווץ לפי atrPercentile)
effective = (אותו כיוון) ? ρ : −ρ
נחסם כאשר   |{מוחזקים עם effective ≥ 0.7}| ≥ DEFAULT_MAX_CORRELATED (3)
```
**כשאי-אפשר למדוד (2026-09-10):** `evaluateCorrelationGate` מחזיר
`allowed: true, abstained: true` כשאין היסטוריית נרות חופפת. עד לתאריך הזה כל
הקוראים קראו רק ב-`allowed` והתעלמו מ-`abstained` — כלומר "לא הצלחתי לבדוק"
בוצע כ-"אלה בלתי-תלויים". הגרוע: השער נמנע הכי הרבה ב-**cold start**, בדיוק
כשכל הסלוטים פנויים והגודל בתקרה. בפועל: intraday פתח 6 long בגודל מלא תוך 4
דקות (60% מההון), כולם נסגרו יחד → -$102 מתוך ריצה של -$107.
עכשיו `blocksOnAbstention` חוסם ערימה **לא-מאומתת** מעבר לאותו קאפ (3);
הכניסות הראשונות עדיין עוברות, אחרת cold start היה נתקע לנצח.
**`prev4hRangeExecution` לא היה בו שער קורלציה בכלל** עד 2026-09-10 (למרות
הערה ב-TrendBreakout שטענה אחרת). `proSimExecution` עדיין ללא — הוא לא מקבץ
כניסות בפועל.

### 0.4 slot preemption (משותף, כל 4 הבוטים)
פקודת entry שמחכה למחיר (limit נח, טרם מולאה) **אינה** תופסת סלוט באופן
מוחלט: איתות טרי חזק יותר במטבע אחר **מפנה** אותה אם
`confidence_חדש ≥ confidence_נח + SLOT_PREEMPT_MARGIN (5)`. לעולם לא מפנה
פוזיציה מלאה. `pickPreemptibleEntryOrder()` בוחר את הפקודה הנחה החלשה ביותר.

---

## 1. Intraday · Multi-Timeframe

מנוע רב-טיימפריים: **1H** רג'ים → **15M** setup → **5M** אישור כניסה.

### קלט נדרש
| TF | מינימום נרות |
|---|---|
| H1 | 200 |
| M15 | 300 |
| M5 | 500 |

מתחת לזה → `NO_DATA`.

### סדר השערים (§55 — כל שער עוצר את הראשון שנכשל)
```
NO_DATA → CIRCUIT_BREAKER → EXPOSURE → NO_REGIME → VOLATILITY →
LIQUIDITY → SPREAD → NO_SETUP → NO_ENTRY → RISK → COST → DATA_MISMATCH
```
**RISK לפני COST:** `buildRiskPlan` מייצר Entry/SL/TP1 סופיים, ו-`evaluateCostEdge`
+ כל מספרי ה-R:R מחושבים על אותם ה-levels בדיוק. `DATA_MISMATCH` = שער
שעוצר SIGNAL אם ניתוח העלות רץ על levels שונים מהפקודה (סטייה > `1e-8`).

⚠️ תוקן 2026-09-14: כש-הסולם הקבוע פעיל, `evaluateCostEdge` היה מודד רווח מול
TP1 בלבד (יחס 0.78, מתחת לסף בכוונה) במקום מול TP2 (יחס 1.52) — RISK אישר
לפי TP2, COST דחה שוב לפי TP1. `CostInput.rewardTarget` מעביר עכשיו את TP2
מ-`intradayEngine.ts` כש-`calmRegimeScalp` פעיל. ראה BOTS_REFERENCE.md §1.

### מתמטיקת הביטחון
```
setupScore  = 100 · Σ wᵢ·factorᵢ      wᵢ: trend .25, momentum .20, location .20, participation .15, structure .20
entryScore  = ציון אישור 5M (0–100)
confidence  = round( (setupScore + entryScore) / 2 )
```
ספים: `setupScoreMin = 46`, `entryScoreMin = 50`. סף תפעולי מעליהם:
`BOT_MIN_CONFIDENCE` (כרגע 60) — נבדק **אחרי** אישור SIGNAL; דחייה = `MIN_CONFIDENCE`.

### מתמטיקת הסטופ / היעד (`buildRiskPlan`, מודל אחוזים)
```
SL  = ההדוק מבין:  atr5 · maxStopAtrMult
                   |entry − (stopReference ∓ buffer)|          ← ענף מבני
      ואז clamp ל-[minStopPercent 0.12% , maxStopPercent 1.5%] ואז תקרת MAX_LOSS_PERCENT 4.2%
      MEAN_REVERSION: רצפה נוספת meanReversionMinStop{AtrMult,Percent}

TP1 = הרחוק מבין:  |entry − SL| · tp1RewardRisk
                   |targetReference − entry|
                   tp1FloorDistance = max(1.5%·entry, 1.5·|entry−SL|)   ← הרצפה, לכל setup פרט ל-MEAN_REVERSION (שם 0; היעד = VWAP)

TP2 = TP1 · (tp2RewardRisk / tp1RewardRisk)      [SIM: tp2RewardRisk 2.5→2.2]
```
`TP1_EXIT_FRACTION = 0.5` — חצי נסגר ב-TP1, השאר רץ. **בסימולציה זה מוחלף
ע"י סולם הרווח** (30% בכל חזרה למדרגה) — ראה "סולם רווח" בהמשך.

### מתמטיקת הגודל (`buildRiskPlan`)
```
targetNotional = sizingBase · positionTargetPct (10%)         ← ללא תלות במרחק הסטופ
riskUsd        = targetNotional · riskPercent
```
`sizingBase` = ההון ההתחלתי בסימולציה (`useFixedSizingBase`).
תקרות: FUTURES margin ≤ `sizingBase·4%`, מינוף ≤ 5x · נכס בודד ≤ `sizingBase·10%`
· חשיפה כוללת ≤ `sizingBase·80%` (סימולציה; 20% בבוט האמיתי) · הזמנה
מינימלית **$100** (סימולציה) / $5 (בוט אמיתי).

### שער `RISK_VS_COST` (מתוך `evaluateCostEdge`)
```
נדחה כאשר   riskPercent < minStopCostMultiple · totalCostPercent
```
סטופ צר מכדי לשרוד את סבב העמלות+slippage שלו. מכפיל: **2.0 בוט אמיתי · 2.5 סימולציה**.
`entryIsLimit` מוברר → MARKET (ברירת מחדל בסימולציה) מתומחר taker + slippage מלא,
לא כמו limit נח.

### R:R (תמיד מ-3 המספרים של `buildRiskPlan`)
```
riskPercent   = |entry − SL|  / entry · 100
rewardPercent = |TP1 − entry| / entry · 100
grossRR       = rewardPercent / riskPercent
netRR         = (rewardPercent − totalCostPercent) / riskPercent      ← נדרש ≥ minRewardRisk 1.2
```

### יציאות (`intradayExit.ts`, לפי עדיפות)
> ⚠️ **מוחלף ע"י סולם הרווח (2026-09-14).** בסימולציה כל יציאת **רווח** המתוארת כאן כבר לא פעילה — TP1/TP2 והטריילינג מדולגים, והסולם (1.8→3→4→5…, 30% בחזרה למדרגה, סגירה מלאה ברצפת 1.8%) הוא היציאה היחידה. ראה "סולם רווח" בהמשך. ה-SL, תקרת 4.2% והיפוכים עדיין גוברים.

- **Stop / TP1 / TP2** לפי הרמות למעלה.
- **Trailing** אחרי שהעסקה הוכיחה TP1: `trailDistance = min(trailingAtrMult·atr5,
  trailingMaxRMult·|entry−SL|)`, `trailStop = anchor ∓ trailDistance` (R-capped — לא
  מתרחב מעבר ל-1R). **"הוכיחה TP1" = `tp1Hit` או `mfeR ≥ tp1RewardRisk`** — לא
  "המחיר החי מעל TP1". קודם השער בדק מחיר חי; רץ שנסוג מתחת ל-TP1 כיבה את
  ה-trailing בדיוק כשצריך אותו (נצפה: רץ ENA ב-+2.0R נסוג מתחת ל-TP1 והמשיך
  לרדת עם SL קשיח בלבד). התיקון רק מוסיף הגנה → בטוח גם ל-live.
- **Reversal:** רק אם `progressR ≥ tp1RewardRisk` **או** `progressR ≤ reversalMaxLossR (−0.7)`,
  ובנוסף `reversalSignal` + `entryConfirmed` + `setupScore ≥ 70`.
- **Time stop:** `heldMs ≥ timeStopMs` **וגם** `progressR < timeStopMinProgressR`
  **וגם** `mfeR < timeStopStagnantMfeR (0.7)` — נסגר רק אם גם עומד וגם לא נגע ברווח.

---

## 2. Pro · alg.md

מנוע אינדיקטורים חד-טיימפריים. `MIN_PRO_CANDLES = 40`.

### מתמטיקת הביטחון (Score 0–100)
8 אינדיקטורים, כל אחד פולט אות (buy/sell/hold) + ביטחון פנימי 0–100 + משקל:

| אינדיקטור | משקל |
|---|---|
| RSI(14) | 15 |
| MA(20) | 15 |
| MACD | 18 |
| Bollinger | 12 |
| Stochastic | 8 |
| Volume Profile | 15 |
| מגמת נפח | 10 |
| שינוי 24h / מומנטום | 12 |
| **Σ** | **105** |

```
weighted     = weight · (signalConfidence / 100)
totalWeight += weight                             ← סכום גולמי של כל 8 המשקלים (105)

# עונש קורלציה (aggregateProBuckets):
#   אשכול = { RSI(14), MA(20), Bollinger(20,2), Stochastic(14,3) }  — כולם מודדים מתיחות מהממוצע
#   לכל דלי dir:  bucket[dir] += Σ(weighted של non-cluster)  +  Σ(weighted של cluster ב-dir) / √n
#                 n = כמה חברי אשכול הצביעו dir
#   → 4 אוסילטורים מסכימים = 2 קולות אפקטיביים, לא 4.  MACD/VP/VolTrend/Mom — משקל מלא.

maxScore    = max(buyScore, sellScore, holdScore)
secondScore = הגבוה הבא

dominance = maxScore / totalWeight
margin    = (maxScore − secondScore) / maxScore
coverage  = min(1, totalWeight / 88)              ← totalWeight = 105 תמיד → coverage ≈ 1 אחרי חימום

confidence = 50 + (dominance·45 + margin·25)·coverage − (1 − coverage)·10
```
תוצאה שאינה BUY חסומה ב-50 (`action !== 'BUY' → min(conf, 50)`). **זה Score,
לא הסתברות.** לפני עונש הקורלציה (2026-09-11): קריאת אוסילטור בודדת עברה 70,
ובאמצע-טווח 4 הדי-HOLD קברו נטיית MACD/נפח אמיתית.

**נתיב trend-participation:** `EMA50>EMA200` + מחיר מעל EMA50 + לא-מתוח (≤3×ATR) →
כל תוצאה שאינה BUY (כולל SELL חלש) מקודמת ל-BUY. SELL של פרו חסום ב-50 ולא
סוגר כלום בפועל, אז הקידום ללא עלות.

### סף כניסה
**שטוח 70** (`PRO_DEFAULT_ENTRY_CONFIDENCE`), ללא תלות ב-`riskLevel`.
`PRO_CONFIDENCE_BY_RISK` (55/40/25) קיים כרפרנס בלבד — `proMinConfidence()`
מתעלם. `minConfidenceOverride > 0` דורס את ה-70.

### שערי כניסה (`applyProEntryGates`, אצווה ממוינת ביטחון-יורד)
```
1. בוט פעיל?  2. ORDER_QUEUED  3. ALREADY_HELD  4. BELOW_THRESHOLD
5. NO_SLOTS (occupiedSlots ≥ maxPositions — עם slot preemption §0.3)
6. NO_PRICE  7. NO_BUDGET
```

### מתמטיקת הגודל
```
budget = min(
  initialAmount · (confidence > 80 ? 15% : 10%),      ← proAllocationPercent()
  projectedCash,
  equity · 8%                                          ← PER_ASSET_EXPOSURE_CAP_PERCENT
)
```
מתחת ל-$100 → מעוגל כלפי מעלה ל-$100 אם יש מזומן ו-equity ≥ $100.

### כניסה — Market / Limit (`proLimitEntries`)
- **Market (ברירת מחדל):** מילוי מיידי, `market · (1 ± slippage%)` (תמיד לרעת הבוט).
- **Limit:** מנוחה במחיר "אופטימלי" =
  ממוצע משוקלל של `Bollinger_lower, MA20, VAL, POC, price·0.99`
  (`calculateOptimalEntryPrice`), מעוגל ב-`roundToPriceScale`. TTL 2h.

### יציאה
> ⚠️ **מוחלף ע"י סולם הרווח (2026-09-14).** בסימולציה כל יציאת **רווח** המתוארת כאן כבר לא פעילה — TP1/TP2 והטריילינג מדולגים, והסולם (1.8→3→4→5…, 30% בחזרה למדרגה, סגירה מלאה ברצפת 1.8%) הוא היציאה היחידה. ראה "סולם רווח" בהמשך. ה-SL, תקרת 4.2% והיפוכים עדיין גוברים.

```
Stop Loss   = −4.2%   (PRO_STOP_LOSS_PERCENT)
Take Profit = +3.0%   (PRO_TAKE_PROFIT_PERCENT)
Flip-to-SELL: איתות SELL בביטחון ≥ סף → סוגר את כל הפוזיציה
```
Spot בלבד — אין שורט.

---

## 3. Prev-4H Range · נתיב 4H

פורץ את הטווח של **נר ה-4H הקודם שנסגר לגמרי** (אין lookahead), בכיוון מגמת EMA20(4H).

### קלט נדרש
```
PREV4H_MIN_H4_BARS    = 24
PREV4H_MIN_H1_CANDLES = 96   (= 24·4; aggregateToH4 פולט בר רק כשכל 4 ה-H1 נסגרו)
```

### חלון וזיהוי
```
prev = h4[last]
H = prev.high · L = prev.low · mid = (H+L)/2 · range = H−L · rangePct = range / prev.close
```
פועל רק כש-`barOpenFor(now) === prev.timestamp + BAR_MS` (החלון שמיד אחרי `prev`).
H1 לא עדכני → `STALE_BAR`. פוזיציה אחת לסימבול לכל חלון.

### פילטרים
```
מגמה:  ema = EMA20(4H closes)
       trendUp  = ema > emaPrev  AND  prev.close > ema        (trendDown = מראה)
       אף אחד → AGAINST_TREND
טווח:  rangePct ∈ [minRangePct 0.005 , maxRangePct 0.08]      אחרת RANGE_TOO_TIGHT / RANGE_TOO_WIDE
פריצה: trendUp AND live > H  → LONG (SPOT)
       trendDown AND live < L → SHORT (FUTURES 1x)
       אחרת → NO_BREAKOUT (מצב ARMED)
```

### מתמטיקת הביטחון (Score 0–100 — לא הסתברות)
```
breakoutDist = מרחק המחיר החי מעבר ל-H (או מתחת ל-L)
maxExtension ≈ 0.1818 · range
bandPos      = מיקום יחסי של rangePct בטווח [minRangePct, maxRangePct]  (0 = צר, 1 = רחב)

confidence = 40
           + 30 · clamp01(1 − breakoutDist / (range · maxExtension))    ← מגע נקי גבוה, כניסה מתוחה נמוך
           + 20 · trendStrength
           + 10 · clamp01(1 − bandPos)                                  ← טווח צר גבוה
```
**הרכיבים `breakout` ו-`range` הופכו 2026-09-10.** קודם הם תגמלו את
ה-setups הגרועים (פריצה מתוחה, טווח בינוני), ומכיוון שההזמנות נוצרות לפי
ביטחון יורד — הבוט מילא קודם את הגרועים. עכשיו: מגע נקי + טווח צר = ביטחון
גבוה. `ENTRY_TOO_EXTENDED` (`breakoutDist > range·maxExtension`) נשאר החסם
הקשה. סף כניסה `minConfidence = 55`.

### מתמטיקת הגודל (לא risk-based, למרות המראה — התיעוד הישן כאן היה שגוי)
```
sizingBase = resolveSizingBase(initialAmount, equity)   ← ההון ההתחלתי, לא equity חי
notional   = sizingBase · positionTargetPct (10%)        ← ללא תלות במרחק ה-SL
```
נחתך: נכס בודד 10% (לא 8%) · חשיפה כוללת 80% (לא 20%) · מזומן פנוי · רצפת
$100. בלי scale-in. `R = |entry − mid|` עדיין קיים — הוא רק מודד כמה סיכון
בדולרים יוצא מהגודל הקבוע, הוא לא קובע אותו.

### יציאה
> ⚠️ **מוחלף ע"י סולם הרווח (2026-09-14).** כל יציאת **רווח** המתוארת כאן
> (TP1 חצי, TP2, הרץ ב-break-even) כבר לא פעילה — הסולם
> (1.8→3→4→5…, 30% בחזרה למדרגה, סגירה מלאה ברצפת 1.8%) הוא היציאה היחידה.
> ה-SL, תקרת 4.2%, סטופ הזמן והיפוך ה-EMA עדיין גוברים; סטופ הזמן מושהה
> ברגע שנחצתה מדרגה. **תיקון (2026-09-14):** הקטע הזה תיאר את מה שהיה
> *אמור* לקרות — בפועל הסולם חוּוט בטעות לקובץ מת (`pathSimExecution.ts`,
> הוסר) והבוט החי בסימולציה המשיך להריץ בדיוק את הענף שמתואר מתחת עד
> שהתגלה ותוקן. ראה `BOTS_REFERENCE.md` §3 להסבר המלא.

```
SL   = mid, נחתך לתקרת 4.2%
רווח = סולם רווח (profitRatchet.ts) — ראה "סולם רווח" למעלה
Time stop: now ≥ pos.openTimestamp + BAR_MS  (4 שעות)  — מושהה אם נחצתה מדרגה
היפוך:     EMA20(4H) התהפך לכיוון הנגדי (רק היפוך מובהק, לא בר שטוח) — גובר
           גם על סולם פעיל
```
TP1/TP2 של תוכנית הכניסה עדיין נשמרים על הפוזיציה, אבל לטלמטריה בלבד.

---

## 4. TrendBreakout · Bybit — סימולציה בלבד

אסטרטגיה עצמאית לחלוטין (לא קונצנזוס, לא משתמשת בסיגנלים של האחרים).
מפרט מלא: `TRENDBREAKOUT_SPEC.md`.

### קלט
H1 ≥ 200 · M15 ≥ 300 · M5 ≥ 30. רק נרות **סגורים**.

### שלבים
```
מגמה (H1):   LONG רק אם Supertrend(10,3)=BULL  AND  EMA50>EMA200  AND  close>EMA50   (SHORT = מראה; אחרת NEUTRAL)
פריצה (M15): close > Donchian-High(20) הקודם  AND  volume ≥ VolumeSMA(20)·1.2  AND  כיוון = מגמת H1
אישור (M5):  LONG: EMA9>EMA21  AND  close>EMA9  AND  |מחיר − מחיר-פריצה| ≤ 1.0·ATR(M5)   אחרת ENTRY_TOO_EXTENDED
```

### מתמטיקת הביטחון (Score 0–100, §7)
```
confidence = 25·[H1 Supertrend]  + 20·[H1 EMA]  + 25·[פריצת M15]  + 15·[אישור נפח]  + 15·[אישור M5]
```
כל רכיב 0/חלקי/מלא. סף כניסה `MIN_CONFIDENCE = 70`.

### מצב מילוי — MARKET בלבד (2026-09-10)
TrendBreakout **לא קורא** ב-`proLimitEntries`. לימיט נח **מתחת** לשוק הוא בחירה
שלילית לפריצה: הוא מתמלא רק כשהפריצה חוזרת דרך הרמה (כלומר נכשלת), וכל פריצה
שרצה — בדיוק מה שהאסטרטגיה קיימת בשבילו — לא מתמלאת כלל. בפועל: 5 כניסות,
**0 TP**, 3 יציאות היפוך מגמה. מנועי pullback/mean-reversion (Intraday, Pro)
כן נחים מתחת לשוק בלגיטימיות; פריצת Donchian לא יכולה. `ENTRY_TOO_EXTENDED`
(§5) הוא מה ששומר על הכניסה, לא מצב המילוי.

### מתמטיקת הגודל (§14–15)
```
riskUsd      = equity · 0.5%
fullNotional = riskUsd / (|entry − SL| / entry)          SL = entry ∓ 1.5·ATR(M15)
```
נחתך: נכס בודד ≤ 8% · חשיפה כוללת ≤ 20%. **בגלל ה-SL ההדוק, תקרת ה-8% היא
לרוב האילוץ הכובל — מכוון.**

### Scale-in (§11) — מודל lots
`fillDueOrders` לא יודע להוסיף לפוזיציה → כל scale הוא `SimPosition` נפרד.
עסקה לוגית אחת = כל ה-lots עם אותו נכס-בסיס + כיוון, אותו SL/TP לוגי, נסגרים יחד.
```
lots:   50% / 30% / 20% מ-fullNotional
SCALE_2: רק מעל +1.0R  + מגמה תקפה
SCALE_3: רק מעל +1.5R  + Supertrend עדיין בכיוון
לעולם לא מוסיפים בהפסד (אין מרטינגייל).
SCALE_1 מעוגל כלפי מעלה ל-$100; SCALE_2/3 שנחתכים מתחת ל-$100 → מדולגים.
```

### מתמטיקת ניהול הסטופ (§12 — מחושב מחדש בכל tick)
```
מ-entry קבוע + highest/lowest ש-factory עוקב אחריו (הקוד לא נוגע ב-pos.stopLoss):
   +1.0R  → סטופ אפקטיבי = entry (break-even)
   +1.5R  → טריילינג  extreme ∓ 1.5·ATR(M15)   (מונוטוני בכיוון הרווח, לא מתרופף)

הגבלת סיכון ל-scale-in (2026-09-09):
   worstEntry = max(entryⁱ)  ל-long / min ל-short
   scaleFloor = worstEntry ∓ R
   stop       = max(stop, scaleFloor)  ל-long        ← אף לוט לא מסתכן > 1R

בלם חירום per-lot:
   worstLotLossPct = max( −pnl%(entryⁱ, live) )
   אם reachedStop(capLevel)  OR  worstLotLossPct ≥ MAX_LOSS_PERCENT (4.2%)  → יציאת חירום
```

### מתמטיקת ה-TP (§10)
```
cappedR         = |entryRef − SL|
minTp1Distance  = tp1FloorDistance(entryRef, cappedR)
atrTp1Distance  = cappedR · tpRMultiplier
TP1 = הרחוק מבין minTp1Distance ו-atrTp1Distance
```
(לפני 2026-09-06: השתמש ב-`rUnit` לא-חתוך → יעד רחוק מדי כשה-ATR התרחב.)

### יציאות (§13)
> ⚠️ **מוחלף ע"י סולם הרווח (2026-09-14).** בסימולציה כל יציאת **רווח** המתוארת כאן כבר לא פעילה — TP1/TP2 והטריילינג מדולגים, והסולם (1.8→3→4→5…, 30% בחזרה למדרגה, סגירה מלאה ברצפת 1.8%) הוא היציאה היחידה. ראה "סולם רווח" בהמשך. ה-SL, תקרת 4.2% והיפוכים עדיין גוברים.

סטופ אפקטיבי נחצה · TP (2R) · היפוך H1 Supertrend נגד הפוזיציה · Time Stop
אחרי 24 נרות H1. setup שהתבטל → חוסם scale-in נוסף, לא סוגר.

### SHORT
אי-אפשר לשרטט ב-SPOT → SHORT = `FUTURES` מינוף **1x**. `maxFuturesPositions`:
bybit = 3, path = 2, pro = 0.

---

## 5. מתמטיקת העלות והסיכון המשותפת (`simExecution.ts`)

### מילוי
```
fillPrice(buy)  = market · (1 + slippagePercent/100)      ← תמיד לרעת הבוט
fillPrice(sell) = market · (1 − slippagePercent/100)
```
פקודה נכנסת ל-`pending` עם `executeAt = now + executionDelaySec`. limit:
מילוי רק כשהמחיר חוצה את ה-signalPrice.

**TTL נגזר-חלון (2026-09-10).** `LIMIT_ORDER_TTL_MS` (2h) היה שטוח לכל ארבעת
הבוטים — ופקודה נחה לא יכולה לחיות יותר מהתזה שיצרה אותה. עכשיו
`orderExpiryAt(o) = o.expiresAt ?? o.createdAt + LIMIT_ORDER_TTL_MS`:

| בוט | `expiresAt` | למה |
|---|---|---|
| **Intraday** | `now + maxHoldMs · ENTRY_TTL_HOLD_FRACTION (0.5)` → 45–60 דק' | ה-max hold הוא 45–120 דק'; ב-TTL של 2h הפקודה יכלה לנוח **יותר זמן מכל חיי העסקה**, ולהתמלא על אישור M5 בן שעתיים |
| **Prev-4H** | `min(plan.windowEnd, now + 2h)` | הפוזיציה נעצרת בסוף אותו נר 4H; מילוי ב-3:50 פותח עסקה עם 10 דקות לחיות |
| **Pro** | ברירת מחדל (2h) | אין time stop — 2h נכון |
| **TrendBreakout** | לא רלוונטי | כניסות MARKET |

**מצב המילוי לפי בוט:** MARKET רק ל-TrendBreakout (הסטופ שלו `entry ∓ 1.5·ATR`
נע עם הכניסה → מחיר הכניסה לא משנה R:R, והאישור M5 מתכלה מהר). LIMIT לשלושת
האחרים — חזק במיוחד ל-Prev-4H, ששם `R = |entry − mid|` והסטופ נשאר ב-`mid`,
כך שכניסה גרועה מנפחת את R ישירות.

### עמלות
`entryFee` + `exitFee` על הנוציונל (taker לשוק). `totalCostPercent` = סכום
כל הרגליים כאחוז מ-entry, ונכנס ל-`netRR`.

### Funding (FUTURES פתוחות בלבד, כל 4 הבוטים)
```
funding = notional · lastFundingRate · (elapsed / 8h)
```
מנוכה בכל tick לפני חישוב ה-equity. LONG משלם כשהריבית חיובית, SHORT מקבל.
חלון הצבירה חסום ל-8h (השבתת worker ארוכה לא מחייבת סכום חד-פעמי). Pro/Path
spot בלבד → 0 בפועל.

### מכפיל סיכון אדפטיבי (`adaptiveRisk.ts`)
מכפיל את ה-`riskPercent` לפי streak הפסדים/רווחים אחרון — מקטין גודל אחרי
רצף הפסדים, מחזיר בהדרגה אחרי רווח. חסום ל-`[0,1]` — **רק מקטין**. משותף
לכל 4 הבוטים (בפועל רק Intraday מיישם אותו; Pro/Path/Bybit לא נושאים throttle).

### רצפת גודל בפחד שוק (`fearGreedSizeBoost`, opt-in, Intraday בלבד)
```
אם  fearGreedSizeBoost = true
    AND  FEAR_BAND_LOW (20) ≤ fearGreedIndex ≤ FEAR_BAND_HIGH (35)
    AND  orderSide = 'buy'  AND  setupType = 'MEAN_REVERSION'
→   sizingMultiplier = max(streakMult, FEAR_BAND_SIZING_FLOOR (0.9))
```
"פחד אבל לא קפיטולציה" (מתחת ל-20 = נפילה חופשית, מעל 35 = ניטרלי). כשהמנוע
**כבר אישר** קניית MEAN_REVERSION ורצף הפסדים כיווץ את הגודל — הרצפה מחזירה
אותו לכיוון 10% המלאים. **הרצפה < 1**, כך שזה רק מבטל de-risking — לעולם לא
דוחף מעל תקרת ה-10% מ-equity. כבוי כברירת מחדל. Pro/Path/Bybit: no-op
(אין להם streak throttle להרים; Pro spot-BUY מבני, Path/Bybit מיושרי-מגמה).

### קבועים משותפים (מקור יחיד — `intradayParams.ts`)
| נושא | ערך | קבוע |
|---|---|---|
| Drawdown יומי | 8% | `DAILY_DRAWDOWN_BLOCK_PERCENT` |
| Drawdown שבועי | 15% | `WEEKLY_DRAWDOWN_LOCK_PERCENT` |
| תקרת נכס בודד | 10% | `PER_ASSET_EXPOSURE_CAP_PERCENT` (התיעוד ציין 8% — שגוי, תוקן 2026-09-14) |
| תקרת חשיפה כוללת | 80% | `MAX_TOTAL_EXPOSURE_PERCENT` |
| תקרת הפסד לעסקה | 4.2% | `MAX_LOSS_PERCENT` |
| רצפת הזמנה (סימולציה) | $100 | `MIN_SIM_ENTRY_USD` |
| מרווח preemption | 5 נק' ביטחון | `SLOT_PREEMPT_MARGIN` |
| טווח פחד (רצפת גודל) | 20–35 | `FEAR_BAND_LOW` / `FEAR_BAND_HIGH` |
| רצפת מכפיל גודל בפחד | 0.9 | `FEAR_BAND_SIZING_FLOOR` |
| מדרגת Scalp קבועה | SL 2.3 / TP1 1.8 / TP2 3.5 | `calmRegime.ts` — כל 4 הבוטים |
| סף גל קונים | relVolume ≥ 2 + נר ירוק | `SURGE_REL_VOLUME` / `isBuyingSurge` |
| סולם רווח (יציאה) | 1.8 → 3 → 4 → 5 … · מימוש 30% | `profitRatchet.ts` — כל 4 הבוטים |

### סולם רווח — `profitRatchet.ts` (2026-09-14)
החלטת מפעיל, מחליפה את **כל** יציאות הרווח: TP1/TP2 והטריילינג-סטופ של כל בוט.
הבעיה שזה פותר: הבוטים החזירו רווח פתוח ונסגרו באדום בשוק עולה.

```
מדרגות רווח מהכניסה:   1.8%  →  3%  →  4%  →  5%  →  6%  …  (+1% לנצח)

חצייה כלפי מעלה   →  המדרגה מסומנת בלבד. אין מכירה. הפוזיציה ממשיכה לרוץ.

ירידה חזרה למדרגה ≥3%  →  מכירת 30% מהיתרה, והמדרגה **נצרכת** ולא תפעל שוב
ירידה חזרה למדרגה 1.8% →  סגירה מלאה. פוזיציה שנגעה ב-+1.8% לא תהפוך לאדומה
מתחת ל-1.8% ללא חצייה  →  SL 2.3% כרגיל, הסולם מעולם לא נדרך
```

הצריכה החד-פעמית היא מה שמונע שחיקה: בלעדיה מחיר שמתנדנד סביב מדרגה היה מוכר
30% בכל טיק. הצריכה **אינה** מונוטונית — צריכת מדרגה 4 לא מבטלת את מדרגה 5,
שנדרכת מאוחר יותר אם שיא חדש חוצה אותה. לכן המצב הוא **קבוצה** של מדרגות
שנצרכו (`ratchetConsumed` על הפוזיציה), ולא סמן יחיד.

השיא נמדד מ-`highestPrice`/`lowestPrice` שכבר מתוחזקים בכל טיק
(`server/simEngineFactory.ts`). קפיצה שחוצה כמה מדרגות בבת אחת צורכת את כולן
אך משלמת **פעם אחת** — 30% למדרגה שנחצתה היה מחסל פוזיציה בנר רע אחד.

דוגמת המפעיל (שיא +4.2%): מדרגות 1.8/3/4 נחצו. ירידה ל-4.0% → 30%. ירידה
ל-3.0% → 30% מהיתרה. ירידה ל-1.8% → סגירת השאר. סה"כ ~+2.72% ממוצע משוקלל.

**סטופ זמן מושהה ברגע שנחצתה מדרגה** — פוזיציה שכבר מטפסת בסולם רצה עד להכרעת
הסולם. פוזיציה שלא הגיעה ל-1.8% נסגרת בזמן כרגיל.

**כבוי כברירת מחדל ב-LIVE**: Intraday דרך `params.profitRatchet`
(`SIM_INTRADAY_PARAMS_OVERRIDE` מדליק), Pro דרך `opts.profitRatchet`
ב-`evaluateProExit`. Path ו-Bybit הם סימולציה בלבד ממילא.


### מדרגת Scalp קבועה (`calmRegime.ts`, opt-in, 2026-09-11)
החלטת מפעיל: לסחור **תמיד** מדרגה קבועה — SL 2.3% / TP1 1.8% (50%) / TP2 3.5%
— במקום המדרגה הדינמית (בד"כ רחבה יותר) של כל בוט, כדי לתפוס תנודות קטנות
במקום לרדוף. היוצא-מן-הכלל היחיד הוא **גל קונים**, ורק אז הסטופ מתרחב.
```
ברירת מחדל (תמיד)          →  SL = 2.3%   TP1 = 1.8%   TP2 = 3.5%

גל קונים  =  relVolume ≥ 2  AND  נר אחרון ירוק (close > open)   ← isBuyingSurge
             relVolume = ווליום הנר האחרון / ממוצע 20 הנרות שלפניו
             מסגרת זמן: Intraday=M5 · Pro=נרות הסיגנל · Path=H1 · Bybit=M15

אם גל קונים               →  SL  = clamp(dynSlPct, 2.3%, 4.2%)   ← הסטופ הדינמי של הבוט עצמו
                              TP1 = 1.8%                          ← קבוע תמיד, ללא יוצא מן הכלל
                              TP2 = max(3.5%, 1.2 × SL)           ← גדל עם הסטופ כדי שהשער יישאר עביר

שער R:R נמדד מול TP2 (3.5/2.3=1.52 ≥ 1.2), לא TP1 (1.8/2.3=0.78)
```
TP1 הקבוע 1.8% הוא **הלב של האסטרטגיה**: יחס-סיכוי-סיכון 0.78 שלו הוא כוונה —
פרטיישל מהיר של 50%, לא כל התזה; הקצה יושב ברץ ל-TP2. תנודתיות לבדה **כבר לא**
מרחיבה את הסטופ — רק גל קונים ממשי (ווליום + כיוון) עושה זאת, כי אז 2.3% שטוח
יושב בתוך הרעש של התנועה. Pro חסר שער R:R לכן no-op בהיבט הזה (רק המדרגה משתנה).

**כבוי כברירת מחדל בכל מקום שחשוב** — LIVE (`DEFAULT_INTRADAY_PARAMS`) ובדיקות
לא מגדירים את הדגל. הזרקה: Intraday דרך `SIM_INTRADAY_PARAMS_OVERRIDE`; Pro
כ-`opts` ל-`proStopTpLevels` מ-`proSimExecution.ts`; Path/Bybit דרך
`overrideParams` ב-`pathSimEngine.ts`/`bybitSimEngine.ts`.

---

## 6. איך "תוצאה בריאה" נראית

| בוט | הרוב המכריע של הסימבולים | SIGNAL רק כאשר |
|---|---|---|
| Intraday | `NO_SETUP` / `NO_ENTRY` | 12 השערים עברו + `confidence ≥ 60` |
| Pro | `HOLD` (7 מ-8 האינדיקטורים mean-reversion) | אות דומיננטי + `confidence ≥ 70` |
| Prev-4H | `AGAINST_TREND` / `NO_BREAKOUT` | מגמה + פריצה + טווח בתחום + `confidence ≥ 55` |
| TrendBreakout | `H1_TREND_NEUTRAL` / `BREAKOUT_NOT_CONFIRMED` | מגמה + פריצה + נפח + אישור M5 + `confidence ≥ 70` |

כל `NO_SIGNAL` **חייב** לשאת סיבה מפורשת. Drawdown חורג → הבוט חייב להפסיק
לפתוח (לא לסגור קיים).

---

## 7. פערים ידועים (לתעד, לא לתקן)
- **Pro `PRO_COVERAGE_FULL_WEIGHT = 88`** מול Σמשקלות בפועל **105** — לא
  נבדק אם זה מקדים `coverage = 1` בחימום.
- **`pathEngine.ts` / `pathStudy.ts` / `scripts/pathStudy.ts`** — נשארו בקוד
  (מספקים `aggregateToH4` לבקטסטים) אבל **אף בוט לא סוחר לפיהם** מאז המעבר
  ל-Prev-4H Range.
- **Prev-4H Range** — פילטר EMA20 בלבד; אין הוכחה לקצה אחרי עלויות (פריצות
  4H מאובררות היטב). נוסף כעמית השוואה, לא כהמלצה.
- **`scripts/abBacktest.ts:335`** — קורא ל-`runPortfolioBacktest` עם סדר
  ארגומנטים שגוי (`FIXED_SL` איפה ש-`engine: EngineType` מצופה, ולהפך).
  קיים כך לפחות מ-2026-09-06 (`git blame`); `scripts/` לא נכלל באף אחד
  מפרויקטי ה-typecheck (`tsconfig.app.json`/`tsconfig.worker.json`) ולכן
  אף פעם לא נתפס. לא תוקן כחלק מעבודת §8 — תועד כדי שלא יבולבל עם רגרסיה
  חדשה.

---

## 8. Volatility Profile — מודול נפרד, **לא מחובר לאף בוט** (2026-09-16)

מודל סטטיסטי-דטרמיניסטי (**לא** ML, **לא** LLM) של "חתימת התנודתיות"
ההיסטורית של סימבול, מבוסס Median/P25/P75 על 24 חודשי excursion מקסימלי
(High/Low מול Open) בנרות 1H. נוסף כ**יכולת עצמאית** — אף אחד מ-4 בוטי
הסימולציה (Intraday / Pro / Path / Bybit) לא קורא לו כרגע, ולכן שום מתמטיקה
בסעיפים 1–5 למעלה לא השתנתה.

### קבצים
```
packages/engine/src/types/volatilityProfile.ts        ← טיפוסים (VolatilityProfile, VolatilityRegime, ...)
packages/engine/src/services/volatilityCalibration.ts  ← סטטיסטיקה טהורה (mean/median/percentile, buildVolatilityProfiles)
packages/engine/src/services/volatilityProfile.ts      ← שירות runtime (load/get/classify/calculate...)
packages/engine/src/volatility.ts                      ← ברזל ייצוא — @cde/engine/volatility
scripts/generateVolatilityProfiles.ts                  ← סקריפט כיול (CSV → JSON), דטרמיניסטי
data/volatility-profiles/monthly-results.csv           ← מקור (24 חודשים, per category+symbol)
data/volatility-profiles/volatility-profiles.json      ← קומפילציה, ה-runtime קורא **רק** אותו
src/__tests__/volatilityProfile.test.ts                ← 36 טסטים
```
`data/` (לא `ASSETS/`) כי `ASSETS/` מוחרג לגמרי מ-git (`.gitignore`) — נועד
לדאמפים גולמיים לניתוח, לא לקוד/קונפיג שאמורים להיכנס לריפו.

### נוסחאות
```
currentUp   = (High−Open)/Open·100     currentDown = (Open−Low)/Open·100
volatilityFactor = currentRange / baselineRange     (baselineRange = medianUp+medianDown)
regime: <0.75 CONTRACTED · 0.75–1.25 NORMAL · >1.25 EXPANDED · >1.75 EXTREME
regimeMultiplier   = clamp(volatilityFactor, 0.75, 1.75)
dynamicRiskPct     = (LONG→medianDown : SHORT→medianUp) · regimeMultiplier
dynamicOpportunityPct = (LONG→medianUp : SHORT→medianDown) · regimeMultiplier
```
כל שגיאה (`PROFILE_NOT_FOUND` / `PROFILE_INSUFFICIENT_HISTORY` / `INVALID_PROFILE`)
מוחזרת כערך מפורש (`VolatilityResult<T>`) — אין fallback מזויף, אין ניחוש.

### חיבור ל-Backtest — opt-in בלבד, לא משפיע כברירת מחדל
`runPortfolioBacktest` (`server/backtestRunner.ts`) קיבל פרמטר **רביעי,
אופציונלי**, `volatilityGuard?: VolatilityBacktestGuard`. אף קורא קיים
(לא `abBacktest.ts`, לא הטסטים) לא מעביר אותו → `undefined` בכל מקום →
**אפס שינוי התנהגות**. כשכן מועבר: בכל פתיחת פוזיציה מודפס `[volatility-profile]`/
`[volatility-risk]` (§28-style), ותו לא — לא נוגע בגודל/כניסה/סטופ/יציאה.

**הגנת look-ahead:** הפרופיל **לא** נלקח מ-`volatility-profiles.json` המקומפל
(שנבנה מכל 24 החודשים — היה look-ahead בתוך אותו חלון). הוא נבנה מחדש
בכל כניסה מ-`monthlyRows` הגולמי, מוגבל לחודשים שנסגרו **לפני** חודש
הכניסה בלבד (`buildVolatilityProfileAsOf`), ומחושב על ה-H1 האחרון שכבר
נסגר — אותו מצביע `cursors.h1` שהמנוע עצמו כבר משתמש בו למניעת look-ahead.

### מה עדיין לא קיים
אף לא אחד מ-4 הבוטים קורא ל-`buildDynamicRiskReference`/`buildVolatilityContext`
בזמן החלטה חיה — הפונקציות טהורות, בדוקות (36/36) ומוכנות לצריכה ע"י Risk
Engine עתידי, אך אף מנוע סיגנל/סיכון קיים (`intradayRisk.ts`, `proAlgEngine.ts`,
`prev4hRangeExecution.ts`, `trendBreakoutExecution.ts`) לא נוגע בהן. שילוב חי
הוא עבודה עתידית נפרדת.
