# מדריך ייחוס — ארבעת בוטי הסימולציה

> קובץ זה נבנה ע"י קריאת הקוד עצמו (לא תיעוד קודם). כל שורה כאן מצוינת עם
> הקובץ שבו היא באמת קורית. עדכן אותו כשהחישוב עצמו משתנה — לא לפני.
> נכון לתאריך: 2026-09-07, מסביב לקומיטים עד `e1ca516` + תוספת בוט 4 (Bybit)
> + חיבור מודול Volatility Profile לכל 4 הבוטים ב-2026-09-16 (§5, סימולציה בלבד)
> + תיקון `PRO_COVERAGE_FULL_WEIGHT` (88→105) ב-2026-09-16 (§2, "פערים ידועים")
> + חצי-סגירה ב-Time Stop תחת הסולם, ב-2026-09-16, בכל שלושת הבוטים שיש להם
> Time Stop — Intraday (§1, מבוסס נתוני סימולציה חיים), Path (§3) ו-Bybit
> (§4, מניעתי — אותו מנגנון, עוד לא נצפה נזק)
> + 2026-09-17: כלל "פינוי סלוט" בסולם הרווח (§ סולם רווח) הוחלף מרצפה
> דולרית קבועה ($10) לאחוז מהכמות המקורית (25%), בכל 4 הבוטים.
> + 2026-09-17: יכולת SHORT (FUTURES 1x) ל-Pro + מסנן כיווני קשיח נגד שורט
> במגמה עולה, Time Stop חדש של 240 דק' שמחליף את הסולם עבור Pro בלבד, ו-
> תקרת drawdown יומית של 10% ל-Pro בלבד (§2).

ארבעת הבוטים רצים כ-4 מופעים נפרדים לגמרי של אותה תשתית
(`server/simEngineFactory.ts` → `createGenericSimEngine`) — לכל אחד `cash`,
`positions`, `history` ו-KV store נפרדים ב-Firestore. **תוצאה של בוט אחד
לעולם לא יכולה להשפיע על בוט אחר** — הם חולקים רק קבועים (סף drawdown, תקרת
נכס בודד) ונתוני שוק (נרות), לא state.

> **בוט 4 (Bybit · TrendBreakout) הוא סימולציה בלבד.** הוא לא מיועד לכסף אמיתי
> עד להחלטה נפרדת. נוסף כדי להשוות אותו מול שלושת האחרים ולבחור מי ראוי
> לקידום לבוט אמיתי.

---

## 1. בוט חדש (Intraday · Multi-Timeframe)

**קבצי מפתח:** `packages/engine/src/services/intradayEngine.ts` (אורקסטרטור),
`intradayRegime.ts` (1H), `intradaySetup.ts` (15M), `intradayEntry.ts` (5M),
`intradayRisk.ts` (עלות + גודל), `intradayParams.ts` (כל הספים).

### נתוני קלט נדרשים
| טיימפריים | מינימום | קובץ |
|---|---|---|
| H1 | 200 נרות | `intradayEngine.ts:142` |
| M15 | 300 נרות | `intradayEngine.ts:143` |
| M5 | 500 נרות | `intradayEngine.ts:144` |

מתחת לזה → `NO_DATA`, בלי חישוב בכלל.

**SPOT לא יכול לשרטט (2026-09-11):** שלושה ענפים ב-`evaluateIntradayDecision`
כופים `tradeType='SPOT'` בלי לבדוק את **כיוון** ה-setup — ברירת המחדל ללא
futures, דריסת EXTREME, ושער האיכות של TRANSITIONAL/SOFT_TREND. אות SHORT
שנחת באחד מהם המשיך ל-`buildRiskPlan`, שנוסחת הרמות שלו נקבעת לפי
`tradeType === 'SPOT' || isLong` — ולכן בנתה רמות בצורת LONG (סטופ **מתחת**
לכניסה) ל-SHORT, ונתפסה רק שלושה שלבים אחר כך ע"י `validateLevelDirection`
כדחיית `RISK` בלתי-קריאה. נצפה חי על PUMP/LIT/XRP. עכשיו יש שער בשם
`NO_REGIME` מיד אחרי הניתוב שדוחה את זה במפורש.

### סדר השערים (§55, כל שער עוצר את הראשון שנכשל)
```
NO_DATA → CIRCUIT_BREAKER → EXPOSURE → NO_REGIME → VOLATILITY →
LIQUIDITY → SPREAD → NO_SETUP → NO_ENTRY → RISK → COST → DATA_MISMATCH
```
מיושם ב-`intradayEngine.ts:126` (`evaluateIntradayDecision`).

**RISK לפני COST** (שונה, 2026-09-07): `buildRiskPlan` מייצר את ה-Entry/SL/TP1
**הסופיים** (מודל אחוזים קבוע), ו-`evaluateCostEdge` + כל מספרי ה-R:R מחושבים
על אותם ה-levels בדיוק — **מקור אמת יחיד**. `DATA_MISMATCH` = שער חדש שעוצר
SIGNAL אם ניתוח העלות רץ על levels שונים מהפקודה (סטייה > `1e-8`), ומדפיס את שני
הסטים ללוג. אין fallback שמסתיר את זה.

**⚠️ תקלה שתוקנה (2026-09-14) — COST מדד רווח מול TP1 גם כשהסולם הקבוע פעיל.**
`buildRiskPlan` השער הפנימי שלו, כשהסולם (`calmRegimeScalp`) פעיל, מודד R:R
גולמי מול **TP2** (3.5/2.3≈1.52 — TP1 הוא 1.8/2.3≈0.78 בכוונה, ראה "סולם רווח").
אך `evaluateCostEdge` — שער נפרד, במורד הזרם — תמיד מדד את `expectedMovePercent`
מול `takeProfit1` בלבד, בלי מודעות לסולם. תוכנית שעברה את שער ה-RISK (מול TP2)
הגיעה ל-COST ונדחתה **שוב**, על מספר ש-RISK כבר אישר תחת יעד אחר. נצפה חי:
Intraday לא ביצע עסקה אחת ב-3+ שעות; כל האיתותים שהגיעו ל-COST נדחו ב-R:R נטו
**0.67–0.73** בדיוק — קלאסטר צר וחשוד לחלוטין (זה בדיוק 1.8/2.3 פחות עלויות),
בלי קשר לסימבול או סוג ה-setup. תוקן: `CostInput.rewardTarget` — ברירת מחדל
`takeProfit1` (הבוט האמיתי ללא שינוי), אך `intradayEngine.ts` מעביר `takeProfit2`
כש-`calmRegimeScalp` פעיל. ראה `costGateLadderMismatch.test.ts`.

### חישוב הביטחון
`confidence = round((setupScore + entryScore) / 2)` — ממוצע של שני ציונים
0–100 (`decisionEngine/adapters/intradayAdapter.ts:355`):
- **setupScore** — נבנה ב-`intradaySetup.ts` משקלול 5 גורמים: trend 0.25,
  momentum 0.20, location 0.20, participation 0.15, structure 0.20
  (`intradayParams.ts:209`). סף מינימלי: **46** (`setupScoreMin`).
- **entryScore** — נבנה ב-`intradayEntry.ts` (אישור 5M). סף מינימלי: **50**
  (`entryScoreMin`).

**סף תפעולי נוסף**, מעל שני אלה: `BOT_MIN_CONFIDENCE` (env, כרגע **60**) —
נבדק **אחרי** שהמנוע כבר אישר SIGNAL; אם `confidence < 60` הדחייה מתויגת
`MIN_CONFIDENCE` (`intradayAdapter.ts:361-368`). זהו **ציון (Score)** 0–100 —
קנה מידה משותף לכל ארבעת הבוטים (מאז שמנוע ה-probability של נתיב 4H הוחלף).

### מעגל שבירה (Circuit Breaker) — שער 2
```
p.dailyDrawdownPercent  >= 8   → NO_SIGNAL (חסימת כניסות חדשות)
p.weeklyDrawdownPercent >= 15  → NO_SIGNAL (נעילה)
```
קבועים יחידים: `DAILY_DRAWDOWN_BLOCK_PERCENT` / `WEEKLY_DRAWDOWN_LOCK_PERCENT`
ב-`intradayParams.ts:195-196` — משותפים ל-3 הבוטים כולם (מיובאים, לא
מוקלדים מחדש).

### גודל פוזיציה וסיכון (`intradayRisk.ts` — `buildRiskPlan`)
- **גודל:** נוציונל יעד = `sizingBase × positionTargetPct (10%)`, ללא תלות
  במרחק הסטופ. `sizingBase` = ההון ההתחלתי בסימולציה (`useFixedSizingBase`),
  ה-equity החי בבוט האמיתי. `riskUsd` נגזר מזה × riskPercent. **הערה:**
  `sizingMultiplier` מוחזר לטלמטריה אך **לא** מוכפל בנוציונל ב-`buildRiskPlan`
  (ה-sim מחיל אותו ב-`resolveEntryBudget`).
- **תקרת FUTURES:** מרג'ין ≤ `sizingBase × 4%`, מינוף ≤ **5x**.
- **תקרת נכס בודד (SPOT ו-FUTURES כאחד):** `sizingBase × 10%` —
  `PER_ASSET_EXPOSURE_CAP_PERCENT` ב-`intradayParams.ts`. `maxSpotNotionalPercent`
  גם הוא 10% (מאוחד).
- **תקרת חשיפה כוללת:** `sizingBase × maxLeveragedExposurePercent` (20% בבוט
  האמיתי, 80% בסימולציה דרך `SIM_INTRADAY_PARAMS_OVERRIDE`).
- **הזמנה מינימלית:** בסימולציה **$100** — `SIM_INTRADAY_PARAMS_OVERRIDE.minOrderUsd`
  ב-`simExecution.ts` (בקשת מפעיל). `buildRiskPlan` מעגל פוזיציה קטנה מ-$100
  כלפי מעלה לסף; `generateNewOrders` הוא backstop שמעגל שוב אם צריך (מזומן +
  equity ≥ $100). (לבוט האמיתי הסף נשאר $5 — `DEFAULT_INTRADAY_PARAMS.minOrderUsd`.)

### יציאה (Stop/Target דינמיים) — `buildRiskPlan` ב-`intradayRisk.ts`
```
SL  = ההדוק מבין: atr5 × maxStopAtrMult  |  |entry - (stopReference ∓ buffer)|
      clamp ל-[minStopPercent 0.12% , maxStopPercent 1.5%] ואז תקרת 4.2%
      MEAN_REVERSION: רצפה נוספת — meanReversionMinStop{AtrMult,Percent}
TP1 = הרחוק מבין: SL × tp1RewardRisk  |  |targetReference - entry|  |  רצפת tp1FloorDistance
TP2 = TP1 × (tp2RewardRisk / tp1RewardRisk)   [SIM: tp2RewardRisk 2.5→2.2, 2026-09-10]
```
**רצפת ה-TP1 היא `tp1FloorDistance` = `max(1.5%·entry, 1.5·|entry−SL|)` — לא
3% שטוח.** `FIXED_TP_PERCENT = 3.0` עדיין מוגדר ומיוצא (ובדיקות קוראות בו), אבל
`buildRiskPlan` **לא משתמש בו** — ראה ההערה ב-`intradayRisk.ts:440`: "A 3%
target is unreachable in-horizon on a low-volatility major, so those trades used
to time-stop out flat." MEAN_REVERSION פטור לגמרי (`minTp1Distance = 0`; היעד
שלו הוא ה-VWAP). ענף ה-ATR עדיין שומר `grossRR ≥ tp1RewardRisk`.
(`FIXED_SL_PERCENT` נמחק; הסטופ דינמי מאז `ecfd37b`.) תקרת ההפסד היא
`MAX_LOSS_PERCENT = 4.2%`.

`RiskPlanInput.stopReference` / `targetReference` — `stopReference` **נכנס**
לחישוב ה-SL (הענף המבני); `targetReference` נכנס לחישוב ה-TP1. שניהם גם
בטלמטריה. `validateLevelDirection` תופס סטופ/TP בצד הלא נכון.

**Trailing runner (`intradayExit.ts` §4, תוקן 2026-09-11):** אחרי TP1, 50% רצים
עם סטופ נגרר `anchor ∓ min(trailingAtrMult·atr5, trailingMaxRMult·|entry−SL|)`.
תנאי ההפעלה הוא **"העסקה הוכיחה TP1"** = `tp1Hit || mfeR ≥ tp1RewardRisk` — **לא**
"המחיר החי ≥ TP1". קודם השער נבדק מול המחיר החי, כך שרץ שנסוג מתחת ל-TP1 **כיבה
את ה-trailing** בדיוק ברגע שהוא נחוץ (נצפה ב-worker: רץ ENA MEAN_REVERSION ב-+2.0R
נסוג מתחת ל-TP1 והמשיך לרדת עם ה-SL הקשיח בלבד). התיקון רק **מוסיף** יציאה
מוקדמת של רץ דועך → בטוח גם לבוט האמיתי. **זהו תיאור הבוט האמיתי** —
`DEFAULT_INTRADAY_PARAMS` משאיר את `profitRatchet` לא מוגדר, כך שה-TP1/TP2/
trailing שלמעלה עדיין פעילים שם במלואם.

> ⚠️ **בסימולציה מוחלף ע"י סולם הרווח (`profitRatchet.ts`, 2026-09-14).**
> `SIM_INTRADAY_PARAMS_OVERRIDE.profitRatchet = true` מדליק אותו, ואז TP1
> החצי/TP2/הטריילינג שלמעלה מדולגים לגמרי (`intradayExit.ts`: `ratchet &&
> ...` חוסם את כל שלושת הענפים) — היציאה היחידה מעל ה-SL היא הסולם
> (מימוש 30% על החזרת 15% מהשיא, סגירה מלאה בברייק-אבן). ה-SL, ה-Reversal
> וסטופי הזמן עדיין גוברים; סטופי הזמן מושהים ברגע שנחצתה מדרגה. רמות
> ה-SL/TP1/TP2 שלמעלה עדיין מחושבות ונשמרות על הפוזיציה — הן קובעות את
> ה-R:R לשערי הכניסה, פשוט לא את היציאה בפועל. ראה "סולם רווח" ב-ALGO_MATH.md.

**Time Stop — חצי-סגירה תחת הסולם (`intradayExit.ts`, 2026-09-16).** נתוני
סימולציה חיים (`cde-engine.onrender.com`, 16.9): 14 יציאות Time Stop/
Max Duration ב-Intraday, ממוצע **‑$8.05** כל אחת, מול מימוש חלקי ממוצע של
הסולם עצמו של רק **+$2.29** — net ‑$69.23 על הבוט הזה לבדו, כש-Pro (אותו
sizing, אותה מדרגה, אותו סולם) היה רווחי (+$20.20). הבעיה: סגירה **מלאה**
של פוזיציה שרק "לא זזה" ממחירה **הנוכחי**, בלי הזדמנות נוספת, לעומת הסולם
שכבר מתייחס למימוש רווח כתהליך הדרגתי (30% בכל מדרגה). התיקון: כש-
`params.profitRatchet === true`, הפגיעה **הראשונה** בתנאי ה-Time Stop
(`heldMs ≥ timeStopMs && progressNaturalR < timeStopMinProgressR &&
mfeNaturalR < timeStopStagnantMfeR`) סוגרת רק **50%** (`exitType:
'PARTIAL_50'`) והשארית ממשיכה תחת ה-SL/הסולם/`MAX_DURATION` הרגילים; פגיעה
**שנייה** (מזוהה ע"י `pos.tp1Hit` שכבר `true` מהפגיעה הראשונה — אותו
mechanism המשותף ש-`partial_tp1` כבר משתמש בו גם לסולם עצמו) סוגרת את מה
שנשאר **במלואו**, כדי שלא תיווצר דעיכה גיאומטרית כמו בסולם הישן (§5 ב-
ALGO_MATH.md). **הבוט האמיתי** משאיר `profitRatchet` לא מוגדר → סגירה מלאה
תמיד, בלי שינוי כלל (74 טסטים קיימים על Time Stop נשארו ירוקים בלי שינוי).
`MAX_DURATION` (§28/§29, "משך החזקה מקסימלי") נשאר עוצר סופי בסגירה מלאה
תמיד — הוא ה-backstop, לא נועד לדחות עוד. טסט: `src/__tests__/timeStopPartialClose.test.ts`.

**שער `RISK_VS_COST`** (`evaluateCostEdge`): נדחה כש-`riskPercent <
minStopCostMultiple × totalCostPercent` — סטופ צר מכדי לשרוד את סבב
העמלות+slippage שלו, מקרה ש-`netRewardRisk` (שמחלק ב-risk) עיוור אליו.
בבוט האמיתי המכפיל 2.0; **בסימולציה 2.5** (2026-09-10) — ראה למטה.

**תמחור העלות תואם את מצב המילוי (2026-09-10):** `entryIsLimit` מוברר עכשיו
`DecisionContext.config` → `intradayAdapter` → `evaluateIntradayDecision`. הסימולציה
מבצעת MARKET כברירת מחדל (`proLimitEntries` כבוי), אבל `evaluateCostEdge` תמחר את
המילוי הזול (LIMIT נח) — כל עסקה נבחנה עם עלות סבב אופטימית, ושני השערים
(`netRR ≥ 1.2` וגם `RISK_VS_COST`) קיבלו מספר מוטה. עכשיו `config.proLimitEntries
=== true` עובר פנימה; MARKET → taker + slippage מלא. הבוט האמיתי / backtest
(שמניחים LIMIT נח) — ללא שינוי (ברירת מחדל `entryIsLimit = true`).

**R:R** מחושב תמיד מ-3 המספרים של `buildRiskPlan`:
```
riskPercent   = |entry - stopLoss|   / entry * 100
rewardPercent = |takeProfit1 - entry| / entry * 100
grossRR       = rewardPercent / riskPercent
netRR         = (rewardPercent - totalCostPercent) / riskPercent
```
כל SIGNAL מדפיס שורת `SIGNAL_LEVELS ENTRY=.. SL=.. TP1=.. RISK%=.. REWARD%=..
GROSS_RR=.. ENTRY_FEE%=.. EXIT_FEE%=.. SLIPPAGE%=.. TOTAL_COST%=.. NET_RR=..`
לאימות ידני.

### אין עוקף high-confidence
היה fallback ב-`confidence >= 72` שעקף caps/מינימום/כיוון-סטופ — **נמחק**.
דחייה מ-`buildRiskPlan` או מ-`evaluateCostEdge` היא דחייה, ללא קשר לציון.

### מה תוצאה בריאה אמורה להיראות
- רוב הסימבולים: `NO_SETUP`/`NO_ENTRY` (זה תקין — הגנה נגד רעש).
- SIGNAL רק כשכל 12 השערים עברו + `confidence >= 60`.
- Drawdown יומי/שבועי אף פעם לא אמור לחרוג מ-8%/15% — אם קורה, הבוט **חייב**
  להפסיק לפתוח (לא לסגור פוזיציות קיימות).
- אין פוזיציה שחורגת מ-8% מההון בנכס בודד (futures) או 15% (spot).

---

## 2. בוט פרו (Pro · alg.md מדויק)

**קבצי מפתח:** `packages/engine/src/services/proAlgEngine.ts` (סיגנל + סף +
הקצאה), `proSimExecution.ts` (שערים + הזמנות).

### נתוני קלט נדרשים
`MIN_PRO_CANDLES = 40` (`proAlgEngine.ts:465`) — נמוך משמעותית מ-Intraday,
כי Pro לא בונה רג'ים רב-טיימפריים.

### חישוב הביטחון (Score 0–100)
8 אינדיקטורים משוקללים (`§2`, `proAlgEngine.ts`):
```
RSI 15 · MA 15 · MACD 18 · Bollinger 12 · Stochastic 8 ·
Volume Profile 15 · Volume Trend 10 · שינוי 24h 12   (סה"כ משקל = 105)
```
`confidence = 50 + (dominance·45 + margin·25)·coverage − (1−coverage)·10`, כאשר
`coverage = min(1, totalWeight / 105)`. **תוקן 2026-09-16** (היה `/88`, מול
Σמשקלות בפועל 105 — ראה "פערים ידועים" למטה).

**עונש קורלציה (2026-09-11, `aggregateProBuckets`):** RSI, מרחק-מ-MA20,
Bollinger %B ו-Stochastic %K מודדים את **אותו דבר** (כמה המחיר מתוח מהממוצע) —
בכל דיפ הם מצביעים יחד. `dominance/margin` נבנו לתגמל הסכמה **בלתי-תלויה**, אז
4 הדים של קריאה אחת ניפחו אותם: סיגנל אוסילטור בודד עבר את 70, ובאמצע-טווח
4 הדי-HOLD קברו נטייה אמיתית של MACD/נפח. עכשיו תרומת האשכול לכל דלי מחולקת
ב-`√n` (n = כמה חברי אשכול הצביעו כך) — 4 אוסילטורים מסכימים = 2 קולות
אפקטיביים, לא 4. `totalWeight` נשאר הסכום הגולמי (coverage לא מושפע). MACD /
Volume Profile / מגמת נפח / שינוי 24h נשארים עצמאיים במשקל מלא.

**נתיב trend-participation** (`computeProSignal`): כש-`EMA50>EMA200` והמחיר מעל
EMA50 ולא מתוח (≤3×ATR ממנו) — כל תוצאה **שאינה BUY** (כולל SELL חלש) מקודמת
ל-BUY, עם בונוס ביטחון (58 + עוצמת מגמה + איכות פולבאק). סימטרי מ-2026-09-17:
כש-`EMA50<EMA200` והמחיר מתחת ל-EMA50 ולא מתוח — HOLD מקודם ל-SELL, עם אותו
בונוס ביטחון (לפני 2026-09-17 SELL היה חסום ב-50 בקוד, אז הבונוס לא היה
משנה כלום בפועל — עכשיו SELL הוא מועמד שורט אמיתי, ראה למטה).

### סף כניסה
**שטוח, 70**, בלי קשר ל-riskLevel (`PRO_DEFAULT_ENTRY_CONFIDENCE`,
`proAlgEngine.ts:419`). טבלת `PRO_CONFIDENCE_BY_RISK` (55/40/25 לפי
low/medium/high) קיימת כ**רפרנס בלבד** — `proMinConfidence()` מתעלמת ממנה
במפורש (`void riskLevel`). `minConfidenceOverride > 0` (הגדרת מפעיל/env)
מחליף את ה-70 לגמרי.

### שערי כניסה (§4, `applyProEntryGates` ב-`proSimExecution.ts:161`)
```
1. הבוט פעיל?  2. ORDER_QUEUED  3. ALREADY_HELD  4. BELOW_THRESHOLD
5. NO_SLOTS (occupiedSlots >= maxPositions)  6. NO_PRICE  7. NO_BUDGET
```
מוערך פעם אחת, על אצווה ממוינת ביטחון-יורד — כך שהסלוטים/המזומן מוקצים
לאיתותים החזקים קודם.

### גודל פוזיציה (§4 gate 7) — `applyProEntryGates` ב-`proSimExecution.ts`
```
sizingBase     = resolveSizingBase(initialAmount, equity)   ← ההון ההתחלתי, לא equity חי
targetNotional = sizingBase × PRO_ENTRY_ALLOCATION_PERCENT (10%)
perAssetCap    = sizingBase × PER_ASSET_EXPOSURE_CAP_PERCENT (10%)
budget         = min(targetNotional, projectedCash, perAssetCap)
```
**תיקון תיעוד (2026-09-14):** הגרסה הישנה של הקטע הזה תיארה טבלת הקצאה
לפי ביטחון (`confidence > 80 ? 15% : 10%`, `proAllocationPercent()`) ותקרת
נכס בודד של 8%. שני הדברים שגויים בפועל: `proAllocationPercent()` **וטבלת
`PRO_ALLOCATION_BY_RISK`** הוסרו — היו קוד מת שהפאנל הציג כאילו הוא חי, בעוד
`applyProEntryGates` תמיד תיזמן לפי ביטחון בלבד, לא לפי `riskLevel`. הגודל
היום הוא **מספר אחד קבוע (10%), בלי תלות בביטחון** — ראה
`PRO_ENTRY_ALLOCATION_PERCENT`. תקרת הנכס הבודד היא **10%**, לא 8%
(`PER_ASSET_EXPOSURE_CAP_PERCENT`), זהה לשלושת הבוטים האחרים.

מינימום הזמנה בסימולציה: **$100** (`MIN_SIM_ENTRY_USD`) — budget מתחת לזה
נדחה כ-`NO_SIGNAL [MIN_ORDER_EXCEEDS_POSITION_TARGET]`. חל על כל ארבעת
בוטי הסימולציה.

**תקרת מרחק ללימיט (2026-09-11):** `calculateOptimalEntryPrice` משקלל
Bollinger-lower / MA20 / VAL / POC — מחיר "איפה התמיכה הקרובה", בלי שום קשר
לתקציב הסיכון של העסקה — והרצפה היחידה שלו הייתה `currentPrice × 0.90`, כלומר
**עד 10% מתחת לשוק**. נצפה חי על NEAR: שוק $2.4540, כניסה מתוכננת $2.2902 =
**-6.67%**, על סולם שמכוון ל-TP1 1.8% / SL 2.3% — דורש תנועה גדולה יותר *לפני*
העסקה ממה שהעסקה מנסה לתפוס, וה-TTL של שעתיים פשוט מפקיע אותה. עכשיו:
`maxDiscount = min(PRO_MAX_ENTRY_DISCOUNT_PCT 1.0%, stopPct × 0.30)` — סטופ
רגוע 2.3% → 0.69%; סטופ רחב 4.2% → נחתך ל-1.0%. Intraday (offset של ATR עם רצפה
ברמת הטריגר) ו-Path/Bybit (`breakoutLimitPrice` עם רצפה ברמה שנפרצה) היו חסומים
ממילא — פרו היה היחיד בלי רסן.

### כניסה — Market או Limit (§6, `proSimEngine.ts` config `proLimitEntries`)
- **Market (ברירת מחדל §6):** מילוי מיידי ב-`executeAt`, במחיר שוק + slippage.
- **Limit (כשמופעל):** מנוחה במחיר "אופטימלי" (`calculateOptimalEntryPrice`
  — ממוצע משוקלל של Bollinger lower/MA20/VAL/POC/מחיר×0.99), ממתין שהשוק
  יגיע אליו או טוב יותר. פג תוקף אחרי `LIMIT_ORDER_TTL_MS` (2 שעות בסימולציה)
  אם אף פעם לא נחצה. **מעוגל לפי סדר גודל המחיר** (`roundToPriceScale`,
  `tradeEngine.ts`) — לא `.toFixed(2)` קבוע, אחרת נכס תת-סנט מתעגל לשגיאה.

### יציאה (`evaluateProExit`)
```
SL   = ATR-scaled: clamp(atr%·1.6, 1.8%, 4.2%)   ·   תקרה PRO_STOP_LOSS_PERCENT 4.2%
רווח = Time Stop של Pro (ראה למטה, 2026-09-17) — `proSimExecution.ts` מדליק
       `timeStopPeakTrail: true` ללא תנאי בכל קריאה ל-`evaluateProExit`
       (מחליף את `profitRatchet: true` הישן — הסולם לא רץ יותר ל-Pro).
       TP1 חצי/TP2/break-even runner עדיין קוד חי, אבל **לעולם לא רצים
       בסימולציה** — נשארים כברירת מחדל ל-opts ריק (קריאה ישירה בלי opts,
       למשל מטסט).
Flip:  SELL בביטחון ≥ סף סוגר LONG; BUY בביטחון ≥ סף סוגר SHORT (סימטרי,
       2026-09-17 — לפני כן SELL בלבד, כי כל פוזיציה הייתה LONG).
```

**SHORT (FUTURES 1x) — יכולת חדשה, 2026-09-17 (החלטת מפעיל).** עד כאן Pro
היה spot-בלבד ("the system does not open shorts", §4). עכשיו SELL בביטחון
מספיק על סימבול לא-מוחזק פותח שורט 1x FUTURES — אותה מוסכמה בדיוק שPath/Bybit
כבר משתמשים בה. שני שינויים נדרשו כדי שזה יעבוד בכלל:
- **הסרת ה-cap הישן** שדחס כל תוצאה שאינה BUY ל-confidence≤50 (היה קיים כדי
  ש"confidence≥70 ⟹ BUY נורה" — עכשיו מוכלל ל-BUY **או** SELL, ורק HOLD נשאר
  כפוף לרצפה). בלי זה SELL לא יכול היה לעולם לחצות סף כניסה.
- **`maxFuturesPositions`** עבור Pro עבר מ-0 (חסימה מוחלטת) ל-2
  (`simDefaults.ts`, כמו Path).

**מסנן כיווני קשיח — "לא שורטים כנגד מגמה עולה" (`PRO_SHORT_TREND_VETO_1H_
RETURN_PCT = 0.2`).** וטו מוחלט, נבדק בשתי שכבות עצמאיות (הגנת-כפולה, לא
הישענות על מנגנון אחד):
1. **בתוך `computeProSignal`** — SELL מודח ל-HOLD (ו-confidence חוזר לרצפת
   50) אם תשואת נר ה-H1 האחרון > 0.2% **או** `ema50 > ema200`. זה קורה
   *לפני* שה-SELL אי-פעם מגיע לקובץ הביצוע.
2. **שוב ב-`applyProEntryGates`** — אותה בדיקה, קוראת את `oneHourReturnPct`/
   `trendUp` שנחשפו על `SignalEvaluation.indicators` — כדי שגם אם משהו
   אחר יאפשר ל-SELL להגיע לכאן (למשל שינוי עתידי בסיגנל), השורט עדיין
   נחסם ברמת השער.
נבדק ב-`src/__tests__/proShortAndTimeStop.test.ts`.

**Time Stop — מחליף את הסולם עבור Pro בלבד (2026-09-17, החלטת מפעיל).**
`PRO_TIME_STOP_MINUTES = 240` (4 שעות), `PRO_TIME_STOP_TRAIL_PCT = 0.6`.
```
heldMs < 240 דק'                    → כלום לא משתנה, TP1/TP2/SL רגילים
heldMs >= 240 דק' וגם לא ברווח       → סגירה מלאה מיידית
heldMs >= 240 דק' וגם ברווח          → TP1/TP2/break-even runner מדולגים;
                                       רץ חופשי עד שהמחיר יורד (LONG) /
                                       עולה (SHORT) 0.6% **ממחיר** השיא —
                                       לא 0.6% מהשיא כאחוז-רווח, ולא שבר
                                       מהשיא כמו הסולם — טריילינג-סטופ פשוט
                                       על המחיר. ה-SL המקורי עדיין גובר מתחת.
```
שונה במתכוון מהסולם (`profitRatchet.ts`): אין מימוש חלקי בדרך, ואין נוסחת
giveback-of-peak — "תן לרוץ, נעל ב-0.6% מהשיא" בלבד. `PRO_DAILY_DRAWDOWN_
BLOCK_PERCENT = 10` (במקום ה-`DAILY_DRAWDOWN_BLOCK_PERCENT` המשותף 8%, ראה
`server/proSimEngine.ts`) — Pro בלבד, שלושת הבוטים האחרים נשארים ב-8%.

### מעגל שבירה
זהה ל-Intraday (8%/15%), אבל **מיושם בקובץ שונה** — `proSimEngine.ts`
(לפני שהאיתותים מגיעים ל-gates), ולא בתוך `proAlgEngine.ts` עצמו. הקבועים
משותפים (`intradayParams.ts`), המימוש נפרד.

### מה תוצאה בריאה אמורה להיראות
- ביטחון מוצג הוא **Score**, לא הסתברות — 70% אומר "70 מתוך 100 בציון
  משוקלל", לא "70% סיכוי להצליח".
- אם `proLimitEntries=true`: לצפות להרבה `ORDER_QUEUED` שלא ממלאים מיד —
  זה תקין, לא תקוע, כל עוד לא עברו 2 שעות.
- שינוי `riskLevel` בממשק **לא אמור** לשנות תדירות כניסה או גודל פוזיציה —
  זו החלטת מוצר מתועדת, לא באג.

---

## 3. נתיב 4H (Prev-4H Range · טווח נר קודם)

> **החליף את מנוע ה-Empirical Path.** הבקטסט של המשתמש
> (`ASSETS/path-slot-study33/diagnostic.json`, 4.9M תוצאות) הראה **0 דליים עם
> תוחלת חיובית אחרי עלויות** בכל regime — הקצה (~0.05R) קטן פי 5–10 מעלות
> ה-round-trip (~0.28R). מודל הדליים, הטבלה, `/api/path-sim/table`
> ו-`installValidatedTable` הוסרו. `pathStudy.ts`/`scripts/pathStudy.ts`
> נשארו על הדיסק. `pathEngine.ts` עצמו **כן** עדיין חי — לא לסימולציה, אלא
> כאסטרטגיה בתוך ה-DecisionEngine של הבוט האמיתי (`PathAdapter`,
> `evaluatePathDecision`/`pathKellyFraction`). סימולציה בלבד.
>
> **⚠️ `pathSimExecution.ts` הוסר לגמרי (2026-09-14) — היה קוד מת.** זה היה
> ה-order-generator **הקודם** של בוט הסימולציה (`generatePathOrders`),
> ששימש את המנוע האמפירי הישן. כשהבוט עבר ל-Prev-4H Range,
> `server/pathSimEngine.ts` עבר לקרוא ל-`generatePrev4hRangeOrders`
> (`prev4hRangeExecution.ts`) **בלבד** — אבל `pathSimExecution.ts` נשאר על
> הדיסק, מיוצא מה-barrel, בלי אף קורא אמיתי. תיקון סולם הרווח (ראה למטה)
> חוּוט בטעות לתוכו בסבב עבודה קודם — הקוד עבר טסטים, טיפצ'ק ובנייה, כי שום
> דבר לא בדק אינטגרציה מול השרת בפועל, ונשאר **לא פעיל בפועל על הבוט החי
> בסימולציה** עד שאותרה ותוקנה כאן. `MIN_PATH_CANDLES`/`PATH_MIN_H4_BARS`
> ממשיכים להתקיים — יוצאים עכשיו ישירות מ-`pathEngine.ts`, מקורם האמיתי.

**קבצי מפתח:** `packages/engine/src/services/prev4hRange.ts` (הסיגנל),
`prev4hRangeExecution.ts` (גודל + יציאות), `server/pathSimEngine.ts` (חיבור).

### נתוני קלט נדרשים
```
PREV4H_MIN_H4_BARS   = 24   (ברי 4H מלאים — ל-EMA20 + מרווח)
PREV4H_MIN_H1_CANDLES = 96  (= 24 × 4; aggregateToH4 פולט בר רק כשכל 4 ה-H1 נסגרו)
```
`prev = h4[last]` הוא הבר ה-4H ה**אחרון שנסגר לגמרי** — אין lookahead.

### חלון וזיהוי
```
H = prev.high · L = prev.low · mid = (H+L)/2 · range = H−L · rangePct = range/prev.close
```
פועלים רק כש-`barOpenFor(now) === prev.timestamp + BAR_MS` (החלון שמיד אחרי
`prev`). נתוני H1 לא עדכניים → `STALE_BAR`. פוזיציה אחת לסימבול לכל חלון.

### פילטר מגמה (§4)
`ema = EMA(20)` על סגירות ה-4H (`calculateEMA`, `tradeEngine.ts`).
`trendUp = ema>emaPrev AND prev.close>ema` · `trendDown` = המראה. אף אחד →
`AGAINST_TREND` (אין עסקה).

### פילטר טווח
`rangePct` חייב להיות ב-`[minRangePct 0.010, maxRangePct 0.08]` (התיעוד ציין
0.005 — שגוי, תוקן 2026-09-14) — אחרת `RANGE_TOO_TIGHT` / `RANGE_TOO_WIDE`.

### שער `RISK_VS_COST`
```
stopDistancePct  = |entryRef − stopLoss| / entryRef × 100     ← הסטופ הסופי
estimatedRoundTripCost = מודל עלות משותף (~0.3% ב-SPOT, entryIsLimit=false)
נדחה כש  stopDistancePct < costSafetyMultiplier (2.0) × estimatedRoundTripCost
```
**⚠️ תוקן 2026-09-14** — אותה תבנית תקלה כמו COST ב-Intraday (ראה §1): השער
היה נבדק מול `structuralStop` (אמצע הטווח) **לפני** בלוק הסולם, שיכול לדרוס
אותו לרצפה קבועה של 2.3%. טווח צר (בדיוק הסוג שהציון של הבוט מעדיף — "מגע נקי
+ טווח צר = ביטחון גבוה") נדחה על סטופ שלא יסחר בפועל. הועבר עכשיו **אחרי**
בלוק הסולם, נבדק מול `riskPerUnit` הסופי. ראה `pathRiskVsCostLadderMismatch.test.ts`.

### סיגנל (פריצה)
`trendUp AND live > H` → **LONG** (`SPOT`). `trendDown AND live < L` → **SHORT**
(`FUTURES` מינוף 1x — spot לא יכול לשרטט). אחרת `NO_BREAKOUT` (מצב `ARMED`).

### חישוב הביטחון (Score 0–100 — לא הסתברות!)
```
40 + 30·clamp(1 − breakoutDist/(range·maxExtension)) + 20·trendStrength + 10·(1−bandPos)
```
**הרכיבים הופכו 2026-09-10** (משיכה לעסקאות גרועות): פעם `breakout` תגמל
פריצה **מתוחה** (30 נק' ל-d ליד הקצה, 0 למגע נקי) ו-`rangeScore` תגמל טווח
בינוני (~3.9%). מכיוון שההזמנות נוצרות לפי ביטחון יורד תחת סלוטים/מזומן
מוגבלים — הבוט מילא קודם את ה-setups הכי גרועים (סטופ `mid` רחב, מהלך שכבר
נעשה), וליד סף ה-55 אף דחה מגעים נקיים. עכשיו: **מגע נקי → ביטחון גבוה**,
טווח צר (סטופ צר → TP1 מושג בחלון 4H) → ביטחון גבוה. `ENTRY_TOO_EXTENDED`
(`breakoutDist > range·maxExtension`, ≈0.1818·range) נשאר החסם הקשה.

סף כניסה `minConfidence = 55` (`SIM_BOTS.path.minConfidence`). **קנה מידה
משותף ל-Intraday/Pro/Bybit** — `BOT_MIN_CONFIDENCE` מגיע אליו עכשיו כמו לשאר
(מנוע ה-Wilson/probability הישן נעלם).

### גודל פוזיציה (`prev4hRangeExecution.ts` — לא risk-based, למרות שנראה כך)
```
notional = sizingBase × positionTargetPct (10%)     ← ללא תלות במרחק ה-SL כלל
sizingBase = resolveSizingBase(initialAmount, equity)  ← ההון ההתחלתי, לא ה-equity החי
נחתך ב: נכס בודד 10% (PER_ASSET_EXPOSURE_CAP_PERCENT) · חשיפה כוללת 80%
        (MAX_TOTAL_EXPOSURE_PERCENT) · מזומן פנוי · רצפת $100 (MIN_SIM_ENTRY_USD)
```
פוזיציה אחת לסימבול, בלי scale-in. ה-SL (`mid`) קובע רק כמה סיכון בדולרים
נגזר מהגודל הקבוע — לא להפך. (התיעוד הישן כאן תיאר מודל risk-based ישן —
נמחק מהקוד עצמו, הערת הכותרת של `prev4hRangeExecution.ts` מציינת זאת
במפורש.)

### יציאה (`prev4hRangeExecution.ts`)
```
SL     = mid (אמצע הטווח), נחתך לתקרת MAX_LOSS_PERCENT 4.2%
רווח   = סולם רווח (profitRatchet.ts) — היציאה היחידה מעל SL, זהה לשאר 3
         הבוטים: חימוש +1.8%, החזרת 15% מהשיא = מימוש 30%, ברייק-אבן =
         סגירה מלאה. TP1/TP2 של תוכנית הכניסה נשארים על הפוזיציה לטלמטריה
         בלבד — הם לא קובעים יציאה יותר. ראה "סולם רווח" למעלה.
Time stop: now >= pos.openTimestamp + BAR_MS (4 שעות)  — מושהה ברגע שנחצתה מדרגה
היפוך: EMA20 (4H) התהפך לכיוון הנגדי — גובר גם על סולם פעיל (הבוט קיים רק כל
       עוד המגמה מחזיקה)
```
עד 2026-09-14 תיאר הקטע הזה TP1 חצי + break-even + TP2 — זו הייתה ההתנהגות
**המתועדת**, לא זו שרצה בפועל (ראה אזהרת `pathSimExecution.ts` למעלה).

**Time Stop — חצי-סגירה תחת הסולם (2026-09-16, אותו תיקון כמו Intraday, §1).**
פגיעה **ראשונה** בתנאי `!ratchet.armed && now >= openTimestamp + BAR_MS` סוגרת
רק 50% (`exitType: 'partial_tp1'`, `exitFraction: 0.5`) והשארית ממשיכה תחת
SL/סולם/היפוך EMA20; פגיעה **שנייה** (מזוהה ע"י `pos.tp1Hit` שכבר `true`
מהפגיעה הראשונה) סוגרת את השארית **במלואה**. לא הופעל על סמך נזק כספי שנצפה
בפועל ב-Path — המדגם החי (16.9.26) הראה רק 1 SL + 7 מימושי סולם, אפס יציאות
Time Stop עד כה — אלא כי המנגנון זהה מבנית לבאג שתוקן ב-Intraday (סגירה מלאה
של פוזיציה קפואה מול מימוש הדרגתי בסולם) והסיכון קיים גם אם עוד לא התממש.
טסטים: `src/__tests__/prev4hRange.test.ts`, `prev4hRangeLossFixes.test.ts`.

### מעגל שבירה ותקרת נכס
זהה לשאר 3 הבוטים (8%/15% drawdown, 10% תקרת נכס בודד, 80% חשיפה כוללת) —
ב-`generatePrev4hRangeOrders`.

### מה תוצאה בריאה אמורה להיראות
- רוב הסימבולים: `NO_SIGNAL [AGAINST_TREND]` או `[NO_BREAKOUT]` — תקין,
  צריך מגמה **וגם** פריצה **וגם** טווח בתחום.
- כל `NO_SIGNAL` נושא סיבה: `STALE_BAR`, `AGAINST_TREND`, `RANGE_TOO_TIGHT`,
  `RANGE_TOO_WIDE`, `NO_BREAKOUT`, `CONFIDENCE_BELOW_MIN`.
- כל פוזיציה נסגרת לכל המאוחר בסוף נר ה-4H שבו נפתחה.

---

## 4. בוט Bybit (TrendBreakout · פריצת מגמה) — סימולציה בלבד

**קבצי מפתח:** `packages/engine/src/services/trendBreakout.ts` (הסיגנל),
`packages/engine/src/services/trendBreakoutExecution.ts` (גודל, scale-in,
ניהול סטופ, יציאות), `server/bybitSimEngine.ts` (חיבור לתשתית),
`TRENDBREAKOUT_SPEC.md` (המפרט המלא של המשתמש).

**אסטרטגיה עצמאית לחלוטין** — לא קונצנזוס של Intraday/Pro/Path ולא משתמשת
בסיגנלים שלהם. חולקת רק נתוני שוק, מנוע המילוי, הקבועים המשותפים ותשתית
הסימולציה.

### נתוני קלט
H1 ≥ 200 · M15 ≥ 300 · M5 ≥ 30 (מובטח ע"י ה-READY של ה-MTF snapshot). רק נרות
**סגורים** — אין lookahead.

### מגמה (H1, §3)
LONG רק אם: Supertrend(10,3) = BULL **וגם** EMA50 > EMA200 **וגם** close > EMA50.
SHORT = המראה. אחרת NEUTRAL → אין עסקה.

### פריצה (M15, §4)
close > Donchian-High(20) הקודם (LONG) / < Donchian-Low(20) (SHORT), **וגם**
נפח ≥ VolumeSMA(20) × 1.2, **וגם** כיוון = מגמת H1.

### אישור כניסה (M5, §5)
LONG: EMA9 > EMA21 **וגם** close > EMA9 **וגם** המחיר במרחק ≤ 1.0×ATR(M5)
ממחיר הפריצה (אחרת `ENTRY_TOO_EXTENDED` — לא רודפים).

### ביטחון (Score 0–100, §7)
H1 Supertrend 25 · H1 EMA 20 · פריצת M15 25 · אישור נפח 15 · אישור M5 15.
סף כניסה `MIN_CONFIDENCE = 70`. זהו **Score**, לא הסתברות — קנה מידה משותף
ל-Intraday/Pro, שונה מ-Path.

### גודל פוזיציה (§14 + §15) — לא risk-based, זהה למודל של שאר 3 הבוטים
```
sizingBase   = resolveSizingBase(initialAmount, equity)
fullNotional = sizingBase × positionTargetPct (10%)
```
**תיקון תיעוד (2026-09-14):** הגרסה הישנה תיארה `riskUsd = equity × 0.5%`
(מודל risk-based) — לא כך זה עובד בפועל; `trendBreakoutExecution.ts` קורא
ל-`sizingBase × p.positionTargetPct` בדיוק כמו Path/Pro/Intraday. ה-SL
(1.5×ATR(M15)) קובע רק כמה סיכון בדולרים יוצא מהגודל הקבוע.

נחתך קשיח ע"י התקרות המשותפות: נכס בודד ≤ 10% מ-equity
(`PER_ASSET_EXPOSURE_CAP_PERCENT`, לא 8%), חשיפה כוללת ≤ 80%
(`MAX_TOTAL_EXPOSURE_PERCENT`, לא 20%).

### Scale-in (§11) — מודל lots
`fillDueOrders` לא יודע להוסיף לפוזיציה, לכן כל scale הוא `SimPosition` נפרד.
עסקה לוגית אחת = כל ה-lots עם אותו נכס-בסיס + כיוון, אותו SL/TP לוגי, נסגרים
יחד. לוטים 50/30/20% מ-`fullNotional`. SCALE_2 רק מעל **+1.0R** + מגמה תקפה;
SCALE_3 רק מעל **+1.5R** + Supertrend עדיין בכיוון (הועבר מ-+0.5R/+1.0R
ב-2026-09-09 — ראה TRENDBREAKOUT_SPEC.md §11). אף פעם לא מוסיפים בהפסד
(אין מרטינגייל / averaging-down). SCALE_1 מעוגל כלפי מעלה ל-`MIN_SIM_ENTRY_USD`
($100) אם צריך; SCALE_2/3 שנחתכים מתחת ל-$100 פשוט מדולגים (עיגול היה שובר
את יחס ה-50/30/20).

### ניהול סטופ (§12) — מחושב מחדש בכל tick
מ-entry קבוע + ה-highest/lowest ש-factory כבר עוקב אחריו (הקוד אף פעם לא
משנה את `pos.stopLoss`). ב-+1R → סטופ אפקטיבי = entry (break-even). ב-+1.5R →
טריילינג `extreme ∓ 1.5×ATR(M15)`, מונוטוני בכיוון הרווח, לעולם לא מתרופף.
**הגבלת סיכון ל-scale-in (2026-09-09):** הסטופ המשותף לעולם לא רופף מ-`(entry
של הלוט הכי גרוע) ∓ R` — אף לוט לא מסתכן ביותר מ-1R. בלם חירום per-lot: לוט
כלשהו יותר מ-4.2% בהפסד מהכניסה שלו → יציאת חירום. ליחיד-לוט אין שינוי.

### יציאות (§13)
```
סטופ אפקטיבי נחצה  ·  סולם רווח (profitRatchet.ts, ללא תנאי — לא מאחורי
    calmRegimeScalp)  ·  היפוך H1 Supertrend נגד הפוזיציה (גובר גם על סולם
    פעיל — הבוט קיים רק כל עוד המגמה מחזיקה)  ·  Time Stop אחרי 24 נרות H1
    (מושהה אם נחצתה מדרגה)
```
setup שהתבטל → חוסם scale-in נוסף, לא סוגר. **TP הישן (2R)** מחושב ונשמר
על הפוזיציה לטלמטריה/R:R, אבל הסולם — לא נגיעה ב-TP — הוא שקובע יציאת רווח
בפועל, מ-2026-09-14.

**Time Stop — חצי-סגירה תחת הסולם (2026-09-16, אותו תיקון כמו Intraday/Path).**
פגיעה **ראשונה** ב-`!ratchet.armed && heldTime >= maxHoldHours×H1` סוגרת רק
50% מכל לוט פתוח (`exitFraction: 0.5`) והשארית ממשיכה תחת סטופ/סולם/היפוך
Supertrend; פגיעה **שנייה** (מזוהה ע"י `first.tp1Hit` שכבר `true` מהפגיעה
הראשונה — אותו לוט מתעדכן ביחד, כי מימוש חלקי של הסולם עצמו כבר מעדכן את
כל הלוטים הפתוחים יחד) סוגרת את כל מה שנשאר **במלואו**. בניגוד ל-Time Stop
של Intraday, לגרסה הזו **אין** שער התקדמות/MFE כלל — היא נורית על הזמן
בלבד, כך שהמנגנון הישן (סגירה מלאה) היה אפילו פחות בררני. לא הופעל על סמך
נזק כספי שנצפה — המדגם החי (16.9.26) הראה רק 1 SL + 2 היפוך, אפס יציאות
Time Stop עד כה — אלא כי המנגנון זהה מבנית לבאג ב-Intraday. טסט:
`src/__tests__/trendBreakoutTimeStopPartial.test.ts`.

### מצב מילוי — MARKET בלבד (2026-09-10)
הבוט **לא קורא** ב-`proLimitEntries`. לימיט נח מתחת לשוק הוא בחירה שלילית
לפריצה — מתמלא רק כשהפריצה נכשלת וחוזרת דרך הרמה, בעוד שכל פריצה שרצה לא
מתמלאת בכלל. נמדד על ה-worker: 5 כניסות, **0 TP**, 3 יציאות "היפוך מגמה".
`ENTRY_TOO_EXTENDED` (§5) הוא חסם ה-chase, לא מצב המילוי.

### SHORT
בסימולציה אי-אפשר לשרטט ב-SPOT, לכן SHORT = `FUTURES` במינוף **1x**
(מתנהג כמו ספוט הפוך; כל התקרות חלות). `SIM_BOTS.bybit.maxFuturesPositions = 3`
(ו-`path` = 2) — בניגוד ל-Pro שהוא 0.

### מעגל שבירה
זהה לשלושת האחרים (8%/15% על ה-equity של הבוט עצמו), מיושם ב-
`generateTrendBreakoutOrders` (יציאות בלבד כשמופעל).

### מה תוצאה בריאה אמורה להיראות
- רוב הסימבולים: `NO_SIGNAL [H1_TREND_NEUTRAL]` או `[BREAKOUT_NOT_CONFIRMED]` —
  תקין, המנוע דורש מגמה **וגם** פריצה **וגם** נפח **וגם** אישור M5.
- כל `NO_SIGNAL` נושא סיבה מפורשת (§22): `VOLUME_TOO_LOW`,
  `M5_CONFIRMATION_FAILED`, `ENTRY_TOO_EXTENDED`, `CONFIDENCE_BELOW_MIN`.
- פוזיציה יחידה עשויה להופיע כ-1–3 lots (scale-in) — לא באג.

---

## מה משותף בין ארבעתם (ולמה אסור להתערבב)

| נושא | קבוע יחיד | קובץ מקור |
|---|---|---|
| Drawdown יומי | 8% | `intradayParams.ts` → `DAILY_DRAWDOWN_BLOCK_PERCENT` |
| Drawdown שבועי | 15% | `intradayParams.ts` → `WEEKLY_DRAWDOWN_LOCK_PERCENT` |
| תקרת נכס בודד | 8% | `intradayParams.ts` → `PER_ASSET_EXPOSURE_CAP_PERCENT` |
| מכפיל סיכון אדפטיבי | לפי streak הפסדים (חסום `[0,1]` — רק מקטין) | `adaptiveRisk.ts` |
| Fill/Fee/Slippage/Funding | מנוע אחד | `simExecution.ts` |
| שער קורלציה | ρ ≥ 0.7 על 72 נרות H1, מקס' 3 | `correlation.ts` — Intraday · Path · Bybit (**לא** Pro) |
| רצפת גודל בפחד (opt-in) | F&G 20–35 + MEAN_REVERSION BUY → מכפיל ≥ 0.9 | `simExecution.ts` — **Intraday בלבד** |
| מדרגת Scalp קבועה (opt-in) | תמיד SL 2.3/TP1 1.8/TP2 3.5; גל קונים → סטופ רחב | `calmRegime.ts` — **כל 4 הבוטים** |
| Volatility Profile (sim-default) | SL/TP1 מ-`dynamicRiskPct`/`dynamicOpportunityPct` (עוקף calmRegimeScalp) | `volatilityProfile.ts` — **כל 4 הבוטים, §5** |
| סולם רווח (opt-in) | חימוש +1.8%; החזרת 15% מהשיא = מימוש 30%; ברייק-אבן = סגירה | `profitRatchet.ts` — **כל 4 הבוטים** |
| צינון כניסה חוזרת | 60 דק' אחרי **כל** יציאה מלאה | `ENTRY_COOLDOWN_MS` — **כל 4 הבוטים** |

### צינון כניסה חוזרת — `ENTRY_COOLDOWN_MS` (2026-09-14)
אחרי **כל** יציאה מלאה מסימבול, כניסה חדשה בו חסומה למשך **60 דקות** — גם אם
האות ממשיך לירות. מימוש חלקי (רגל 30% של הסולם) **לא** רושם צינון: הפוזיציה
עדיין פתוחה וזו לא כניסה חוזרת.

שני באגים תוקנו כאן יחד, אחרי דיווח מריצה חיה של Pro:
1. **`generateProOrders` מעולם לא קיבל את `exitCooldown`.** Pro היה הבוט היחיד
   ללא צינון כניסה חוזרת בכלל. נצפה: B3 נסגר ב-+$12.23 ב-13:45, נקנה מחדש
   ב-13:56, ונחתך ב--$20.59 ב-14:05 — ארבע עסקאות על סימבול אחד ב-65 דקות.
2. **הליבה רשמה צינון רק על סגירה מפסידה** (`if (pnl < 0)`). יציאה **מרוויחה**
   — הסיבה הטובה ביותר להניח לסימבול, כי התנועה כבר נגבתה — הייתה המקרה
   היחיד שאיפשר כניסה מיידית. אסימטריה שאיש לא בחר בה.

הצינון עלה 2 → 30 → **60** דקות. סימולציה בלבד: לבוט החי מנגנון נפרד
(`REENTRY_COOLDOWN_MS` ב-`tradingWorker.ts`, ברירת מחדל 24 שעות) שלא הושפע.


### סולם רווח — `profitRatchet.ts` (2026-09-14, נכתב מחדש 2026-09-16, "פינוי סלוט" עודכן 2026-09-17)
מחליף את **כל** יציאות הרווח בארבעת הבוטים: TP1 חלקי 50%, TP2, הטריילינג של
Intraday, טריילינג ה-ATR של Bybit, ה-break-even runner של Pro וה-TP היחיד של
Path. הסיבה: הבוטים החזירו רווח פתוח ונסגרו באדום בשוק עולה.

```
חימוש:           שיא הרווח ≥ RATCHET_ARM_PCT (1.8%)
מימוש חלקי:      הרווח החזיר RATCHET_GIVEBACK_FRACTION (15%) מ*שיא הרווח*
                 →  מכירת RATCHET_PARTIAL_FRACTION (30%) מהיתרה
חימוש מחדש:      רק אחרי שיא חדש — ירידה אחת = מכירה אחת, ללא תלות בטיקים
סגירה מלאה:      חזרה למחיר הכניסה (ברייק-אבן), או יתרה <
                 RATCHET_MIN_REMAINING_FRACTION (25% מהכמות המקורית בכניסה —
                 SimPosition.initialQuantity, קפוא כמו initialCostUsd)
לא מחומש:        SL + סטופ זמן, כרגיל
```

**"פינוי סלוט" — עדכון 2026-09-17.** הכלל הישן (`RATCHET_DUST_NOTIONAL_USD`,
$10 קבוע על הערך הדולרי הנוכחי) הוחלף באחוז מהכמות **המקורית** ביחידות
(לא דולרים — המחיר זז, וכמות היא מה שהמדרגות עצמן מוכרות ממנו). נבדק בכל
טיק ברגע שהסולם חמוש, **לפני** בדיקת ה-giveback ואחרי הבדיקה של ברייק-אבן —
כלומר יורה גם בלי שמדרגת giveback חדשה הופעלה, ברגע שהיתרה כבר מתחת ל-25%
מהכמות שנכנסה איתה הפוזיציה. `SimPosition.initialQuantity` נקבע פעם אחת
בכניסה (`simExecution.ts`, אותו מקום ש-`initialCostUsd` נקבע) ולעולם לא
מתעדכן ע"י מכירה חלקית — בדיוק כמו `initialCostUsd`. משותף לכל 4 הבוטים
(אותה `evaluateRatchet` יחידה); ב-Bybit (מודל lots) הכמות מסוכמת על כל
הלוטים הפתוחים של אותה עסקה לוגית. חסר `initialQuantity` (פוזיציה משוחזרת
ממצב ישן) → הכלל מדולג (מתייחס כאל 100% נותר), לא זורק שגיאה.

**הרקע לכתיבה מחדש** (כשל חי על BR): הסולם הישן של מדרגות קבועות +1% ייצר 38
מימושים על מהלך של +69%, מכר 83% מהפוזיציה מתחת ל-+12% (יציאה ממוצעת משוקללת
+8.82%), והמשיך לפלוט פקודות "+$0.00" מתחת למינימום של הבורסה. הניתוח המלא,
כולל טבלת הדעיכה, ב-`ALGO_MATH.md` §5 "סולם רווח".

מה שעדיין **גובר** על הסולם: ה-SL, תקרת ההפסד 4.2%, היפוך מגמה מאושר (Bybit),
היפוך אות SELL בביטחון (Pro), והגנת התיק השבועית. סטופי הזמן מושהים ברגע
שהסולם מחומש (`ratchet.armed`). הטריילינג של Bybit עדיין שולט **לפני** החימוש.

מצב הסולם נשמר ב-`ratchetPeakPct` על הפוזיציה (שיא הרווח בעת המימוש האחרון)
ועובר לשארית בכל מימוש חלקי — זה מה שאוכף את דרישת השיא החדש. היציאה החלקית
בליבה (`fillDueOrders`) קוראת את `order.exitFraction`, עם נפילה חזרה
ל-`TP1_EXIT_FRACTION` עבור הזמנות ישנות.

**LIVE לא מושפע**: `DEFAULT_INTRADAY_PARAMS` משאיר את `profitRatchet` לא מוגדר,
ונתיב ה-Pro החי לא מעביר את ה-opt-in.


### מדרגת Scalp קבועה — `calmRegimeScalp` (2026-09-11, כבוי כברירת מחדל)
החלטת מפעיל: לסחור **תמיד** מדרגה קבועה — SL 2.3% / TP1 1.8% (50%) / TP2 3.5%
— במקום המדרגה הדינמית הרגילה של כל בוט. תנודתיות לבדה **כבר לא** מרחיבה את
הסטופ; היוצא-מן-הכלל היחיד הוא **גל קונים**:

```
גל קונים = relVolume ≥ 2 (ווליום הנר האחרון / ממוצע 20 שלפניו)  AND  נר ירוק
           Intraday=M5 · Pro=נרות הסיגנל · Path=H1 · Bybit=M15
        →  SL  = clamp(הסטופ הדינמי של הבוט, 2.3%, 4.2%)
           TP1 = 1.8%              ← קבוע תמיד
           TP2 = max(3.5%, 1.2×SL) ← גדל עם הסטופ, כדי שהשער יישאר עביר
```

TP1 ביחס-סיכון 0.78 מתחת ל-`minRewardRisk` **בכוונה** — פרטיישל מהיר, לא כל
התזה; שער ה-R:R בענף הזה נמדד מול **TP2** (3.5/2.3=1.52), לא TP1.
Intraday (`intradayRisk.ts`) / Path (`prev4hRange.ts`) / Bybit (`trendBreakout.ts`)
משתמשים בשער R:R הקיים שלהם, מוסט ל-TP2. Pro (`proStopTpLevels`) אין לו שער
R:R — רק המדרגה עצמה משתנה. הזרקה: `SIM_INTRADAY_PARAMS_OVERRIDE` (Intraday),
`opts` ל-`proStopTpLevels` (Pro), `overrideParams` ב-`pathSimEngine.ts` /
`bybitSimEngine.ts`. LIVE (`DEFAULT_INTRADAY_PARAMS`) לא מגדיר את הדגל — ללא
שינוי.

### רצפת גודל בפחד שוק — `fearGreedSizeBoost` (2026-09-10, כבוי כברירת מחדל)
כש-`fearGreedSizeBoost=true` ומדד הפחד ב-`[20,35]` ("פחד, לא קפיטולציה")
וה-Intraday **כבר אישר** קניית `MEAN_REVERSION` — רצף הפסדים **לא** מקטין את
הפוזיציה: `sizingMultiplier = max(streakMult, 0.9)`. הרצפה < 1, כך שזה רק מבטל
de-risking — **לעולם לא חורג מ-10% מ-equity**. Pro/Path/Bybit: no-op (Pro אין לו
throttle; Path/Bybit מיושרי-מגמה — פחד נלחם בתזה שלהם). `FEAR_BAND_LOW/HIGH`,
`FEAR_BAND_SIZING_FLOOR` ב-`simExecution.ts`.

### שער הקורלציה — כשל-פתוח שתוקן (2026-09-10)
`evaluateCorrelationGate` מחזיר `allowed: true, abstained: true` כשאין
היסטוריית נרות לאימות. **כל הקוראים התעלמו מ-`abstained`**, כלומר "לא הצלחתי
לבדוק" בוצע כ-"בלתי-תלויים" — והשער נמנע הכי הרבה ב-cold start, כשכל הסלוטים
פנויים והגודל בתקרה. נמדד: intraday פתח **6 long בגודל מלא תוך 4 דקות** ($6,000
= 60% מההון), כולם נסגרו יחד בדקות 16–36 → **-$102.22 מתוך ריצה של -$107.25**.
`blocksOnAbstention` חוסם עכשיו ערימה לא-מאומתת מעבר ל-3; הראשונות עוברות,
אחרת cold start ננעל לצמיתות (היסטוריה נצברת רק אחרי שיש פוזיציות).
`prev4hRangeExecution` **לא היה בו שער כלל** עד לתאריך הזה — נוסף.

כל אחד מהם **נמדד בנפרד** על ה-equity/positions/history של הבוט שלו בלבד
(`server/simEngineFactory.ts`) — משותף הוא רק הסף, לא המדידה.

### Funding (נוסף עם בוט 4, חל על כל ארבעתם)
`applyFundingAccrual` (`simExecution.ts`) מנוכה בכל tick ב-`simEngineFactory.ts`
לפני חישוב ה-equity, על פוזיציות **FUTURES** פתוחות בלבד:
`notional × lastFundingRate × (elapsed / 8h)`. LONG משלם כשהריבית חיובית,
SHORT מקבל. חלון הצבירה חסום ל-8 שעות כדי שהשבתת worker ארוכה לא תחייב סכום
חד-פעמי. Pro ו-Path הם spot בלבד → `totalFunding = 0` בפועל; רק פוזיציות
ה-futures של Intraday והשורטים של Bybit מרגישים את זה. זהו תיקון מודל-עלויות
אחיד — לא שינוי באלגוריתם של אף מנוע.

## 5. Volatility Profile — מחובר לכל 4 הבוטים, סימולציה בלבד (2026-09-16)

מודל סטטיסטי-דטרמיניסטי (Median/P25/P75 על 24 חודשי excursion מקסימלי בנרות
1H) — **לא** ML, **לא** LLM. **מחליף, לא מכפיל:** כש-profile תקף נמצא, ה-SL/
TP1 של העסקה מגיעים ישירות מ-`dynamicRiskPct`/`dynamicOpportunityPct` —
עוקף גם את הסולם הדינמי של הבוט וגם את `calmRegimeScalp`. עדיפות: volatility-
profile ← calmRegimeScalp ← הסולם המקורי. דלוק כברירת מחדל **בסימולציה בלבד**
בכל 4 הבוטים; LIVE לא נוגע בדגל בכלל (אותו דפוס כמו `profitRatchet`/
`calmRegimeScalp`). `MAX_LOSS_PERCENT`/`PRO_STOP_LOSS_PERCENT` עדיין חותכים
את הסטופ הסופי — לא פטור מהתקרה.

**קבצים:**
```
packages/engine/src/types/volatilityProfile.ts        ← טיפוסים
packages/engine/src/services/volatilityCalibration.ts ← סטטיסטיקה טהורה (mean/median/percentile, buildVolatilityProfiles)
packages/engine/src/services/volatilityProfile.ts      ← שירות runtime + resolveVolatilityLadder (הכניסה היחידה לכל 4 הבוטים)
packages/engine/src/volatility.ts                      ← ברזל ייצוא, @cde/engine/volatility
scripts/generateVolatilityProfiles.ts                  ← כיול CSV→JSON, דטרמיניסטי
data/volatility-profiles/monthly-results.csv           ← מקור (per category+symbol, 24 חודשים)
data/volatility-profiles/volatility-profiles.json      ← קומפילציה; ה-sim engines קוראים רק אותה
server/volatilityProfileStore.ts                       ← טעינה חד-פעמית מדיסק, קאש לכל חיי התהליך
src/__tests__/volatilityProfile.test.ts                ← 45 טסטים (מודול הליבה + resolveVolatilityLadder)
src/__tests__/intradayVolatilityLadder.test.ts         ← 6 · src/__tests__/proVolatilityLadder.test.ts ← 6
src/__tests__/pathVolatilityLadder.test.ts             ← 5 · src/__tests__/bybitVolatilityLadder.test.ts ← 6
src/__tests__/backtestVolatilityGuard.test.ts          ← 4
```
ב-`data/` ולא ב-`ASSETS/` — `ASSETS/` מוחרג לגמרי מ-`.gitignore` (מיועד
לדאמפים גולמיים, לא לקוד/קונפיג שנכנס לריפו).

**נוסחאות מדויקות:** ראה `ALGO_MATH.md` §8 (זהה, לא כפול כאן).

**חיבור per-bot (אותה נקודת הזרקה שכבר קיימת ל-`calmRegimeScalp`):**
| בוט | קובץ + נקודת הזרקה | market |
|---|---|---|
| Intraday | `intradayEngine.ts`→`RiskPlanInput.volatilityLadder` (`intradayRisk.ts`) | SPOT/FUTURES לפי `tradeType` |
| Pro | `proSimExecution.ts`→`proStopTpLevels(...).opts.volatilityLadder` | תמיד `spot` |
| Path | `prev4hRange.ts`→`Prev4hRangeInput.volatilityProfiles` | LONG→`spot`, SHORT→`linear` |
| Bybit | `trendBreakout.ts`→`TrendBreakoutInput.volatilityProfiles` | תמיד `linear` |

Bybit מקפיא את הסטופ שנפתר על הפוזיציה בכניסה (`plan.stopLoss`) —
`effectiveStop` (טריילינג, `trendBreakoutExecution.ts`) כבר קורא `rUnit`
מה-stop **השמור על ה-lot**, לא מחשב מחדש מ-ATR, אז הוא ממשיך אוטומטית בלי
חיווט נוסף (מאומת ב-`bybitVolatilityLadder.test.ts`).

**דגל ההפעלה:** `params.volatilityProfileLadder`, `true` בכל אובייקט ה-override
של הסימולציה (`SIM_INTRADAY_PARAMS_OVERRIDE` ב-`simExecution.ts` ומקביליו),
לא מוגדר ב-LIVE. **הנתונים** (`getVolatilityProfileStore()`) נטענים פעם אחת
ב-`server/volatilityProfileStore.ts` ומוזרקים לכל בוט ב-`server/*SimEngine.ts`.

**חיבור ל-Backtest (`server/backtestRunner.ts`) — opt-in, ברירת מחדל log-only:**
`runPortfolioBacktest` מקבל פרמטר רביעי אופציונלי, `volatilityGuard?`.
בלי `applyToRisk` (או `false`): log-only בדיוק כמו קודם — מדפיס
`[volatility-profile]`/`[volatility-risk]` בכל פתיחת פוזיציה, לא נוגע
בגודל/כניסה/יציאה; נבדק מול כל קורא קיים (`scripts/abBacktest.ts`,
`intradayBacktestParity.test.ts`) — אף אחד לא מעביר guard, אז ההתנהגות
זהה לחלוטין למה שהייתה. עם `applyToRisk: true`: מזין את אותו
`resolveVolatilityLadder` ש-live/sim משתמשים בו ישירות ל-`buildRiskPlan`,
כך שהבקטסט משחזר בדיוק מה שהסימולציה תעשה — למדידה לפני הצעה ל-LIVE.

הגנת look-ahead (שני המצבים): הפרופיל **לא** נלקח מ-JSON המקומפל (שנבנה
מכל 24 החודשים) אלא נבנה מחדש מ-`monthlyRows` הגולמי, מוגבל לחודשים
שנסגרו **לפני** חודש ההחלטה (`buildVolatilityProfileAsOf` ל-log-only,
`makeVolatilityProfilesAsOfResolver` הממוזכר-לפי-חודש ל-`applyToRisk`), על
ה-H1 האחרון שכבר נסגר (`cursors.h1` — אותו מצביע שהמנוע עצמו כבר משתמש בו).

**וידוא (2026-09-16, אחרי החיבור לכל 4 הבוטים + `applyToRisk`):** 896 טסטים
עברו (70 קבצים, 0 נכשלו), `typecheck` + `typecheck:worker` נקיים, `build` +
`build:worker` עברו. LIVE אומת כלא-מושפע: `tradingWorker.ts:1118` (הנתיב
היחיד שבאמת שולח החלטה חיה) לא מעביר `params` בכלל → תמיד
`DEFAULT_INTRADAY_PARAMS` המקורי; ל-Pro אין קריאה כלל מ-`tradingWorker.ts`.

---

## פערים ידועים, לא-קריטיים (לא תוקנו — לתעד בלבד)
- **תוקן 2026-09-16 — Pro `PRO_COVERAGE_FULL_WEIGHT`:** היה 88 מול סכום
  משקלות בפועל 105, כך ש-`coverage` הגיע ל-1 לפני שכל 8 האינדיקטורים הספיקו
  להצביע (חימום קצר יותר ממה שהתכוון). עודכן ל-105 — `proAlgEngine.ts:119`.
  152 קבצי טסט / 1964 טסטים עברו אחרי השינוי, אף אחד לא נעל את הערך הישן.
- **הוצע ונדחה 2026-09-16 — risk-based sizing ל-Intraday/Path:** בדיקה של
  הצעה חיצונית לשנות את גודל הפוזיציה לפי רוחב הסטופ (כדי לאחד את הסיכון
  בדולרים בין עסקאות) העלתה שזו הפיכה של invariant מכוון: `positionTargetPct`
  קבוע ב-`intradayRisk.ts`/`prev4hRangeExecution.ts` (10% מההון, בלתי-תלוי
  ברוחב הסטופ), עם assertion מפורש ב-`intradayRisk.ts` §24 שזורק שגיאה על
  סטייה. `prev4hRangeExecution.ts` כבר ניסה sizing מבוסס-סיכון בעבר ונסוג
  ממנו (ראה ההערה בראש הקובץ: "התיאור הישן היה שגוי"). כמו כן, ה-Path כבר רץ
  ב-`calmRegimeScalp=true` שמקבע סטופ כמעט-קבוע (2.3%, עד 4.2% בסורג) —
  כך שההנחה "רוחב הסטופ משתנה פי 8 בין עסקאות" כבר לא נכונה למצב היום. לא
  שונה שום קוד. **אל תציעו מחדש בלי לבטל קודם את ה-assertion.**
- **`scripts/pathStudy.ts` + `pathEngine.ts`/`pathStudy.ts`** — נשארו בקוד
  (מיוצאים מ-`@cde/engine/analysis`, מסופקים ל-`aggregateToH4` ולבקטסטים) אך
  **אף בוט לא סוחר לפיהם יותר** מאז שנתיב 4H עבר ל-Prev-4H Range.
- **Prev-4H Range** — פילטר מגמת EMA20 בלבד; אין הוכחה לקצה אחרי עלויות
  (פריצות 4H מאובררות היטב). נוסף כ**עמית השוואה**, לא כהמלצה.
- **`scripts/abBacktest.ts:335`** — קורא ל-`runPortfolioBacktest` בסדר
  ארגומנטים שגוי (`FIXED_SL` איפה ש-`engine` מצופה). קיים מ-2026-09-06
  לפי `git blame`, לא קשור לתוספת §5 — `scripts/` לא נכלל באף פרויקט
  typecheck. לא תוקן, מתועד כדי שלא יתבלבל עם רגרסיה חדשה.

---

## 6. תשתית בקטסט ואימות (2026-09-16)

### `server/replayRunner.ts` — בקטסט דרך מנוע הביצוע האמיתי
`backtestRunner.ts` הוא מימוש שני של לולאת המסחר, ו-`EngineType = 'intraday'`
בלבד. `runReplay` מזרים נרות שמורים דרך **אותו** `tick()` של הסימולציה החיה,
באמצעות `SimEngineDeps` (שעון + 4 פידים, ניתנים להזרקה מ-2026-09-16).

```ts
runReplay(strategy, { histories, config, warmupBars, fundingAt?, derivativesAt? })
```
אגנוסטי למנוע — ארבע האסטרטגיות מיוצאות מ-`server/*SimEngine.ts`
(`intradayStrategy`, `proStrategy`, `pathStrategy`, `bybitStrategy`).

**הערובה:** `closedBy(bars, at)` — נר שזמן הסגירה שלו אחרי `at` לא נראה. טסט
(`replayRunner.test.ts`) סורק כל נר שכל אסטרטגיה ראתה בכל צעד ומאמת אפס הפרות.

**פערים מוצהרים:** derivatives נמנעים (אין היסטוריה מעל ~8 ימים), Spread ממודל
ולא נמדד, Funding נעדר אלא אם סופק.

### מודל העלויות — שני ממדים חדשים ב-`simExecution.ts`
| קבוע | ערך | מה זה |
|---|---|---|
| `DEFAULT_SPREAD_PERCENT` | 0.04% | חצי ספרד בכל רגל **שוק** (לימיט נח לא חוצה). **הנחה מתועדת**, לא מדידה |
| `DEFAULT_LIQUIDITY_CAP_FRACTION` | 5% | תקרת מילוי כאחוז מ-quote volume של הנר. **מדידה אמיתית**. חריגה → קיצוץ; מתחת ל-$100 → דילוג |

שניהם **דלוקים גם בסימולציה החיה** (החלטת מפעיל) — `quoteVolumeFor` מוזרק
מ-`simEngineFactory.ts` מנר ה-M5 האחרון שנסגר.

### `walkForward.ts` + `scripts/walkForward.ts`
TRAIN 60% / VALIDATION 20% / OOS 20% לפי זמן, עם:
- `scoreRun` — winRate / PF / expectancy / Sharpe לעסקה
- `nullExpectation` — מה מטבע הוגן היה מחזיר באותן עלויות
- `judgeSurvivor` — `netProfit > 0` **וגם** מעל תוחלת האפס, ב-N חלונות
- `assertOosUnspent` — **תקציב OOS**: אותה קונפיגורציה מותרת (שחזור), קונפיגורציה
  אחרת מול חלון שנוצל זורקת. ספר ב-`backtest-ab/oos-ledger.json`

מדידה ראשונה (Pro, 6 סימבולים, 2025-01→07): TRAIN 9 עסקאות / 88.9% / PF 24.9 /
+$86.93 מול VALIDATION 5 עסקאות / 0% / -$142.45. שני החלונות מתחת ל-20 עסקאות,
כלומר מתחת ל-`minTradesPerWindow` — הכלי עובד, קצה לא הוכח.
