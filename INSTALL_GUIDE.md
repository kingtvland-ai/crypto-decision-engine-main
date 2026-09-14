# מדריך התקנה מלא — כל החיבורים של המערכת

> מחליף את `DEPLOYMENT.md` הישן (עבר ל-`TRASH/superseded-docs/`).
> נכון ל-2026-09-10. מכסה: **Firebase · Bybit · Render · Netlify · Telegram ·
> GitHub Actions · הרצה מקומית**.

---

## 0. ארכיטקטורה — מי מדבר עם מי

```
                 build-time VITE_*                 HTTPS / JSON
┌──────────────┐  (נצרב ל-bundle)   ┌──────────────────┐  Firestore REST   ┌────────────┐
│   Netlify    │ ─────────────────▶ │   Render (worker)│ ───────────────▶ │  Firebase  │
│  frontend    │  VITE_TRADING_     │  server/worker   │  service-account  │ Firestore  │
│  React/Vite  │  API_URL           │  4 בוטי סימולציה │  JWT auth         │   (kv)     │
│  dist/       │ ◀───────────────── │  + בוט אמיתי      │ ◀─────────────── │            │
└──────────────┘   state / trades   └────────┬─────────┘   state / archive └────────────┘
                                             │
                          ┌──────────────────┼───────────────────┐
                          ▼                  ▼                   ▼
                   Bybit REST API      Binance/CoinGecko    Telegram Bot API
                   (נרות + חשבון        (נרות ציבוריים,      (התראות, אופציונלי)
                    אמיתי — live בלבד)   fallback)
```

| שירות | תפקיד | בלעדיו |
|---|---|---|
| **Netlify** | ה-UI בלבד. Build-time — משתנה `VITE_*` חדש דורש **rebuild**. | אין ממשק; ה-worker רץ לבד. |
| **Render** | ה-worker שמריץ את 4 בוטי הסימולציה 24/7 ומחשב את **כל** ההחלטות. | אין בוטים. |
| **Firebase (Firestore)** | אחסון עמיד: state של הבוטים, ארכיון הריצות (`BacktestResults`), warm-cache של נרות. | כל restart של Render מוחק הכל. |
| **Bybit** | מקור נרות + חשבון אמיתי. **4 בוטי הסימולציה לא נוגעים בו** — הם משתמשים בנרות ציבוריים ולא שולחים פקודות. | הבוט האמיתי לא יכול לסחור; הסימולציה עדיין רצה. |
| **Telegram** | התראות דחיפה. אופציונלי לגמרי. | אין התראות. |
| **GitHub Actions** | CI (typecheck + test + build) ו-keepalive ל-Render free tier. | ה-worker נרדם אחרי 15 דק' חוסר תנועה. |

> ⚠️ **כלל זהב:** שינוי במנוע ההחלטות (`packages/engine/`, `server/`) דורש
> **rebuild של Render**. שינוי ב-UI או ב-`VITE_*` דורש **rebuild של Netlify**.
> שינוי שנוגע בשניהם — **שניהם**. (Render לא מזהה שינוי במנוע אם ה-Root
> Directory שלו הוגדר ל-`server` — ראה §3.1.)

---

## 1. Firebase — Firestore + Service Account

### 1.1 יצירת הפרויקט
1. https://console.firebase.google.com → **Add project** (או קיים).
2. **Build → Firestore Database → Create database**.
   - מצב: **Production mode** (הכללים לא רלוונטיים — service-account עוקף אותם).
   - Location: כל אזור (`eur3` / `us-central` וכו').

### 1.2 יצירת Service Account
1. **Project settings** (גלגל שיניים) → לשונית **Service accounts**.
2. **Generate new private key** → מוריד קובץ JSON. **זה סוד — לא ל-commit.**
3. מבנה הקובץ:
   ```json
   {
     "type": "service_account",
     "project_id": "your-project-id",
     "private_key_id": "...",
     "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
     "client_email": "firebase-adminsdk-xxx@your-project-id.iam.gserviceaccount.com",
     "client_id": "...",
     "auth_uri": "...", "token_uri": "...",
     "auth_provider_x509_cert_url": "...", "client_x509_cert_url": "...",
     "universe_domain": "googleapis.com"
   }
   ```

### 1.3 המרה לשורה אחת (חובה למשתנה סביבה)
משתנה סביבה לא יכול להכיל newline אמיתי. צריך את כל ה-JSON בשורה אחת, כשה-`\n`
שבתוך `private_key` **נשארים כטקסט `\n`** (לא newline אמיתי).

```bash
# Bash / Git Bash:
node -e "process.stdout.write(JSON.stringify(JSON.parse(require('fs').readFileSync('service-account.json','utf8'))))"
```
```powershell
# PowerShell:
(Get-Content service-account.json -Raw | ConvertFrom-Json | ConvertTo-Json -Compress -Depth 10)
```
הפלט = הערך של `FIREBASE_SERVICE_ACCOUNT_KEY`.

### 1.4 שני המשתנים ל-Render
| משתנה | ערך |
|---|---|
| `FIREBASE_PROJECT_ID` | ה-`project_id` מתוך ה-JSON (למשל `cryptom-f7a95`) |
| `FIREBASE_SERVICE_ACCOUNT_KEY` | ה-JSON כולו **בשורה אחת** (מ-1.3) |

**בדיקה:** אחרי deploy, בלוג ההפעלה של Render מופיע `[kv] durable storage
configured`. אם חסר — אזהרה חד-פעמית רועשת.

**מה נשמר ב-Firestore** (collection `kv`, מסמכים לפי prefix):
- `<botId>-sim-state:state` — snapshot חי של כל בוט (`intraday` / `pro` / `path` / `bybit`).
- `bot-archive:<botId>` — ארכיון ריצות (מערך, עד 25/בוט). נכתב ב-"אפס את כל
  הבוטים", נמחק ב-"איפוס מטמון + שרת".
- `historical-candles:*` — warm-cache של נרות (דחוס).

---

## 2. Bybit — מפתחות API

> **לסימולציה בלבד אין צורך במפתחות אמיתיים.** 4 בוטי הסימולציה לא שולחים
> אף פקודה ל-Bybit ולא קוראים חשבון — הם משתמשים בנרות ציבוריים בלבד. ערכי
> דמה ב-`BYBIT_API_KEY` / `BYBIT_SECRET_KEY` מספיקים כדי שה-worker יעלה.

### 2.1 מתי צריך מפתחות אמיתיים
רק כאשר `BOT_DRY_RUN=false` — כלומר מפעילים את **הבוט האמיתי** (`/api/bot/*`),
לא את בוטי הסימולציה.

### 2.2 יצירת מפתח
1. https://www.bybit.com → **API** → **Create New Key**.
2. סוג: **System-generated API Keys**.
3. הרשאות: **Read-Write** על **Unified Trading / Contract / Spot** לפי הצורך.
   ל-read-only (רק קריאת חשבון) — **Read** מספיק.
4. **IP restriction:** הוסף את כתובת ה-IP היוצאת של Render (Static Outbound
   IPs בתוכניות בתשלום; ב-Free tley אין IP קבוע → השאר ללא הגבלת IP או עבור
   לתוכנית בתשלום).
5. שמור את ה-**Secret** — מוצג פעם אחת בלבד.

### 2.3 משתנים ל-Render
| משתנה | ערך | הערה |
|---|---|---|
| `BYBIT_API_KEY` | ה-key | `sync: false` (סוד) |
| `BYBIT_SECRET_KEY` | ה-secret | `sync: false` (סוד) |
| `BYBIT_TESTNET` | `false` (mainnet) / `true` (testnet) | לסימולציה לא משנה |
| `BOT_DRY_RUN` | `true` = הבוט האמיתי **לא** שולח פקודות. בוטי הסימולציה מתעלמים מזה. | השאר `true` עד החלטה מפורשת. |

### 2.4 בדיקה
```
curl "https://<your-worker>.onrender.com/api/bybit-sim/state"   # סימולציה — לא נוגע ב-Bybit האמיתי
```
לבוט האמיתי: `GET /api/account/summary` עם `Authorization: Bearer <BOT_ADMIN_TOKEN>`.

---

## 3. Render — ה-worker

### 3.1 הגדרות השירות
| שדה | ערך | הערה |
|---|---|---|
| **Root Directory** | *(ריק — שורש ה-repo)* | ⚠️ **אסור** להגדיר ל-`server`. ה-worker מייבא ~28 מודולים מ-`packages/engine/`; אם Root Directory = `server`, שינוי במנוע **לא** מפעיל auto-deploy וה-worker רץ קוד ישן (build ירוק, `/health` תקין, החלטות ישנות — כשל שקט). ראה ההערה בראש `render.yaml`. |
| **Build Command** | `npm install && npm --prefix server install && npm --prefix server run build` | |
| **Start Command** | `node server/dist/worker.js` | |
| **Health Check Path** | `/health` | |
| **Auto-Deploy** | On | |
| **Instance Type** | Free / Starter | Free עושה spin-down אחרי 15 דק' חוסר תנועה נכנסת → Firestore משמר את ה-state, ו-GitHub keepalive (§6) מונע את זה. |

### 3.2 משתני סביבה

**סודות (`sync: false` — הזנה ידנית ב-Dashboard):**
| משתנה | הערה |
|---|---|
| `BOT_ADMIN_TOKEN` | מחרוזת אקראית ארוכה. שומר על endpoints של כסף אמיתי (`/api/bot`, `/api/account`, `/api/decisions`). endpoints של סימולציה **חסרי טוקן** בכוונה. |
| `BYBIT_API_KEY` / `BYBIT_SECRET_KEY` | §2. דמה מספיק לסימולציה. |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | §5. אופציונלי. |
| `FIREBASE_PROJECT_ID` | §1.4 |
| `FIREBASE_SERVICE_ACCOUNT_KEY` | §1.4 — **שורה אחת!** |

**ערכים גלויים:**
| משתנה | מומלץ | הערה |
|---|---|---|
| `NPM_CONFIG_PRODUCTION` | `false` | כדי ש-devDependencies יותקנו ל-build |
| `BYBIT_TESTNET` | `false` | |
| `BOT_DRY_RUN` | `true` | הבוט האמיתי לא שולח פקודות. **4 בוטי הסימולציה מתעלמים.** |
| `BOT_AUTOSTART` | `false` | `true` = מתחיל לסרוק בהפעלה |
| `BOT_RISK_LEVEL` | `medium` | `low`\|`medium`\|`high` — משפיע על הבוט האמיתי; ל-Pro/סימולציה זו החלטת מוצר מתועדת שלא משנה תדירות/גודל |
| `BOT_SYMBOLS` | `100` | גודל היקום |
| `BOT_MIN_CONFIDENCE` | `60` | SIGNAL SCORE 0-100. מגיע ל-4 בוטי הסימולציה **וגם** לבוט האמיתי. ריק → הרצפה המכוילת של כל בוט (Intraday 52, Pro 70, Prev-4H 55, TrendBreakout 70). |
| `BOT_PATH_MIN_CONFIDENCE` | *(ריק)* | **מתעלמים.** ה-"Path" הישן (probability) הוחלף ב-Prev-4H Range (score bot). |
| `BOT_POSITION_PERCENT` | `10` | תקרת מפעיל בלבד. הגודל בפועל = 10% מה-equity (`POSITION_TARGET_PCT`). |
| `BOT_MAX_OPEN_POSITIONS` | **`7`** | תקרת פוזיציות מקבילות לבוטי הסימולציה (7 × 10% = 70% מושקע, ~20% buffer מתחת לתקרת ה-80% `MAX_TOTAL_EXPOSURE_PERCENT`). ה-worker חותך ל-`MAX_TOTAL_EXPOSURE_PERCENT / POSITION_TARGET_PCT` (= 8) כדי שערך גבוה מדי לא יזרוק `EXPOSURE_MODEL_INVALID` ויקפיא את הסימולציות. הבוט האמיתי שומר תקרה 2 משלו (`DEFAULT_INTRADAY_PARAMS`). |
| `BOT_MAX_FUTURES_POSITIONS` | `2` | |
| `BOT_SCAN_CONCURRENCY` | `5` | |
| `BOT_SCAN_INTERVAL_SECONDS` | `300` | |
| `BOT_KLINE_INTERVAL` | `240` | דקות (נר 4H) |
| `BOT_RATE_LIMIT_MAX` | `120`–`300` | |
| `BOT_RATE_LIMIT_WINDOW_MS` | `60000`–`120000` | |
| `BOT_REQUEST_TIMEOUT_MS` | `15000` | |
| `BOT_REENTRY_COOLDOWN_HOURS` | `24` | |
| `CORS_ORIGIN` | `https://<your-site>.netlify.app,http://localhost:8080,http://localhost:5173` | ⚠️ **חייב לכלול את כתובת ה-Netlify המדויקת** — אחרת הדפדפן חוסם כל בקשה. ללא wildcard. |
| `PORT` | `3001` | (Render מזריק `PORT` משלו — הקוד מכבד אותו) |

> `render.yaml` שב-repo הוא **reference בלבד** — השירות בפועל נוצר ידנית
> (ה-hostname נגזר משם השירות ב-Render, לא מ-`name` בקובץ). שנה ערכים
> ב-Dashboard, לא רק בקובץ. **אל תשנה את שם השירות** — Render מזהה שירות
> מנוהל-blueprint לפי השם; שינוי שם מייתם את השירות הרץ והורג את ה-hostname
> שצרוב ב-`VITE_TRADING_API_URL`.

### 3.3 Hostname נוכחי — ותולדות אי-העקביות (עדכון 2026-09-14)
**ה-hostname הנוכחי, החי, הוא `cde-engine.onrender.com`.** מוצמד עכשיו בשלושה
מקומות: `netlify.toml` (`VITE_TRADING_API_URL`), `src/services/workerConfig.ts`
(`DEFAULT_PUBLIC_WORKER_URL`, הפולבק ל-`/live`), ו-`.github/workflows/keepalive.yml`.

זהו לפחות ה-hostname **השלישי** שהשירות נשא: `crypto-decision-engine-main-hev8`
(מת — 404) → `cde-main` (הושעה ע"י Render, 503 "Service Suspended") →
`cde-engine` (חי, נכון לתאריך העדכון). בכל מעבר, `keepalive.yml` **המשיך
לרוץ כל 10 דקות מול ה-hostname הקודם**, כישלון שקט ב-Actions log שאיש לא שם
לב אליו — ping "מצליח" מול hostname מת לא מונע ספינדאון בפועל, ואין שום
דבר שמתריע על זה חוץ מלפתוח את לשונית Actions ידנית.

**לפני שינוי hostname עתידי: עדכן את כל שלושת המקומות באותו commit**, ולא
בנפרד — זה בדיוק מה שהחמיץ אותם בפעם הקודמת. `render.yaml` CORS מפנה
ל-`crypto-d.netlify.app` (צד הלקוח, לא צד ה-worker) — לא קשור לשם ה-worker
עצמו ואינו צריך להשתנות יחד עם זה.

### 3.4 בדיקה אחרי deploy
```
curl https://<your-worker>.onrender.com/health                      → 200
curl https://<your-worker>.onrender.com/api/bybit-sim/state         → JSON snapshot
curl https://<your-worker>.onrender.com/api/public/backtest-archive → {"intraday":[],"pro":[],"path":[],"bybit":[]}
```
בלוג בכל טיק (כל 4 שניות): `[<bot>-engine] evals=.. willExecute=.. pos=.. cash=..`.
`tick failed: EXPOSURE_MODEL_INVALID` → `BOT_MAX_OPEN_POSITIONS` × 10% חורג
מ-80% (כלומר > 8). הורד ל-7, redeploy.

---

## 4. Netlify — ה-frontend

### 4.1 הגדרות Build
| שדה | ערך |
|---|---|
| **Base directory** | *(ריק)* |
| **Build command** | `npm run build` |
| **Publish directory** | `dist` |
| **Node version** | 24 (מוגדר ב-`netlify.toml`) |

`netlify.toml` מטפל ב-SPA redirect (`/* → /index.html 200`) וב-cache headers
ל-`/assets/*`.

### 4.2 משתני סביבה
| משתנה | ערך | הערה |
|---|---|---|
| `VITE_TRADING_API_URL` | `https://<your-worker>.onrender.com` | ⚠️ **build-time** — נצרב ל-bundle. שינוי דורש **Deploys → Trigger deploy → Clear cache and deploy**. |
| `VITE_ENABLE_ANALYTICS` | `true` / `false` | אופציונלי |

> מדף בוט הסימולציה אפשר לעקוף את ה-URL בזמן ריצה ("Worker URL" → localStorage).
> זה לבדיקות; `VITE_TRADING_API_URL` הוא ברירת המחדל.

### 4.3 בדיקה
פתח → `/simulation-bot`. בשורת ה-Worker אמור להופיע ה-URL עם מקור "משתנה
סביבה (Netlify)". "בדיקת /health" → פותח את ה-health של ה-worker.

---

## 5. Telegram — התראות (אופציונלי)

1. שלח `/newbot` ל-[@BotFather](https://t.me/BotFather) → קבל `TELEGRAM_BOT_TOKEN`.
2. התחל צ'אט עם הבוט החדש (שלח לו הודעה כלשהי).
3. קבל את ה-chat id:
   ```
   curl "https://api.telegram.org/bot<TOKEN>/getUpdates"
   ```
   חפש `"chat":{"id":...}` → זה `TELEGRAM_CHAT_ID`.
4. הזן את שניהם ב-Render (`sync: false`). ריק בשניהם = התראות כבויות.

---

## 6. GitHub Actions

שני workflows ב-`.github/workflows/`:

| קובץ | מתי | מה עושה |
|---|---|---|
| `ci.yml` | push / PR ל-`main` | `npm ci` → typecheck (node + app) → `build:worker` → `build` → `npm test`. **חייב לעבור לפני merge.** |
| `keepalive.yml` | cron כל 10 דק' + ידני | `curl -f /health` על ה-worker מבחוץ, כדי ש-Render Free tier לא ירדם (spin-down אחרי 15 דק' ללא תנועה נכנסת). |

**להתקנה:** אין הגדרה נדרשת מעבר ל-push של הקבצים — GitHub Actions מופעל
אוטומטית ב-repo. אם ה-worker hostname משתנה — **עדכן את ה-URL ב-`keepalive.yml`**.
keepalive לא הופך את ה-persistence לעמיד (זה תפקיד Firebase §1) — הוא רק שומר
את הקונטיינר חי.

---

## 7. הרצה מקומית

```bash
cp .env.example .env          # מלא ערכים; Firebase אופציונלי (ירד ל-server/.data/ מקומי)
npm install                   # מתקין גם את workspaces: packages/* + server

# חלון 1 — frontend
npm run dev                   # → http://localhost:8080

# חלון 2 — worker
npm --prefix server install
npm --prefix server run dev   # (npx tsx tradingWorker.ts) → http://localhost:3001
```

ב-`.env` הגדר `VITE_TRADING_API_URL=http://localhost:3001` (או הזן בשדה
ה-Worker URL ב-UI). ל-CORS מקומי ודא `CORS_ORIGIN` כולל `http://localhost:8080`.

**בדיקות ו-typecheck לפני push:**
```bash
npm test                      # vitest — כל החבילה
npm run typecheck             # tsconfig.app.json (frontend)
npm run typecheck:worker      # tsconfig.worker.json (server + packages/engine)
cd packages/engine && npx tsc --noEmit
npx vite build                # אימות build מלא
```

---

## 8. Checklist פריסה (סדר פעולות)

1. **Firebase:** פרויקט + Firestore + service account → JSON בשורה אחת.
2. **Bybit:** דמה לסימולציה, או מפתח אמיתי + `BOT_DRY_RUN` נשאר `true`.
3. **Render:** צור/עדכן שירות, הזן את כל המשתנים מ-§3.2 (במיוחד
   `BOT_MAX_OPEN_POSITIONS=7` ושני משתני Firebase), deploy.
4. אמת: `/health` = 200, בלוג מראה טיקים, אין `EXPOSURE_MODEL_INVALID`.
5. **Netlify:** הגדר `VITE_TRADING_API_URL` = כתובת Render, **Clear cache and deploy**.
6. אמת: הדף נטען, `/simulation-bot` מתחבר, הפעל בוט, ראה פוזיציות/עסקאות.
7. `POST /api/{bot}-sim/reset` (או "אפס את כל הבוטים" ב-UI) → אמת
   ש-`GET /api/public/backtest-archive` מחזיר ריצה שמורה.
8. וודא ש-`keepalive.yml` מצביע ל-hostname הנכון.

---

## 9. Gotchas — הכי נפוצים

| תסמין | סיבה | תיקון |
|---|---|---|
| כל הבוטים "קפואים", בלוג `tick failed: EXPOSURE_MODEL_INVALID` | `maxPositions × 10%` > 80% (`BOT_MAX_OPEN_POSITIONS > 8`) | הורד ל-7, redeploy Render |
| "CORS blocked" בקונסול | `CORS_ORIGIN` לא כולל את כתובת ה-Netlify | הוסף ב-Render, redeploy |
| הבוטים "מתאפסים" בכל restart | Firebase לא מוגדר → נשמר לדיסק זמני | הגדר `FIREBASE_PROJECT_ID` + `FIREBASE_SERVICE_ACCOUNT_KEY` |
| `FIREBASE_SERVICE_ACCOUNT_KEY` לא עובד | newline אמיתי במפתח, או JSON חסר | שורה אחת, `\n` כטקסט (§1.3), JSON **מלא** (כולל `client_id` / `client_x509_cert_url`) |
| ה-UI מציג נתונים ישנים אחרי שינוי מנוע | רק Netlify נבנה מחדש | redeploy גם את Render |
| שינוי `VITE_TRADING_API_URL` לא נתפס | build-time בלבד | Netlify → Clear cache and deploy |
| `BacktestResults` ריק אחרי "אפס את כל הבוטים" | Firebase לא מוגדר, או שרת לא נגיש | ראה שורה 3 |
| ה-worker נרדם כל ~15 דק' | keepalive לא רץ / URL שגוי | תקן את ה-URL ב-`keepalive.yml` |
| auto-deploy לא קורה על שינוי במנוע | Render Root Directory הוגדר ל-`server` | החזר לריק, ראה §3.1 |

---

## 10. טבלת משתני סביבה מלאה

| משתנה | שירות | סוד? | תיאור |
|---|---|---|---|
| `FIREBASE_PROJECT_ID` | Render | לא | `project_id` מה-service-account JSON |
| `FIREBASE_SERVICE_ACCOUNT_KEY` | Render | **כן** | JSON מלא, שורה אחת |
| `BYBIT_API_KEY` / `BYBIT_SECRET_KEY` | Render | **כן** | live בלבד; דמה לסימולציה |
| `BYBIT_TESTNET` | Render | לא | `false` = mainnet |
| `BOT_ADMIN_TOKEN` | Render | **כן** | שומר endpoints של כסף אמיתי |
| `BOT_DRY_RUN` | Render | לא | `true` = הבוט האמיתי לא שולח פקודות |
| `BOT_AUTOSTART` | Render | לא | `true` = סורק בהפעלה |
| `BOT_RISK_LEVEL` | Render | לא | `low`\|`medium`\|`high` |
| `BOT_SYMBOLS` | Render | לא | גודל היקום |
| `BOT_MIN_CONFIDENCE` | Render | לא | SCORE 0-100, כל הבוטים |
| `BOT_PATH_MIN_CONFIDENCE` | Render | לא | **מתעלמים** |
| `BOT_POSITION_PERCENT` | Render | לא | תקרת מפעיל; בפועל 10% equity |
| `BOT_MAX_OPEN_POSITIONS` | Render | לא | תקרת סלוטים לסימולציה (7) |
| `BOT_MAX_FUTURES_POSITIONS` | Render | לא | (2) |
| `BOT_SCAN_CONCURRENCY` / `_INTERVAL_SECONDS` / `_KLINE_INTERVAL` | Render | לא | כוונון סריקה (בוט אמיתי) |
| `BOT_RATE_LIMIT_MAX` / `_WINDOW_MS` / `BOT_REQUEST_TIMEOUT_MS` | Render | לא | rate-limit |
| `BOT_REENTRY_COOLDOWN_HOURS` | Render | לא | (24) |
| `CORS_ORIGIN` | Render | לא | origins מותרים, מופרד בפסיקים, ללא wildcard |
| `PORT` | Render | לא | `3001` (Render דורס) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Render | **כן** | התראות, אופציונלי |
| `NPM_CONFIG_PRODUCTION` | Render | לא | `false` — devDeps ל-build |
| `VITE_TRADING_API_URL` | Netlify | לא | כתובת ה-worker, **build-time** |
| `VITE_ENABLE_ANALYTICS` | Netlify | לא | אופציונלי |
| `WORKER_URL` | סקריפטים מקומיים | לא | יעד ל-scripts חד-פעמיים |
