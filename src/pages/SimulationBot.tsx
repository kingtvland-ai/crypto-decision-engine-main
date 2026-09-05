import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useState } from 'react';
import { Bot, RefreshCw, AlertTriangle, Trash2, ExternalLink, Play, Pause, Square } from 'lucide-react';
import Navigation from '../components/Navigation';
import PortfolioRiskMeter from '../components/trading/PortfolioRiskMeter';
import SimulationEngineColumn from '../components/trading/SimulationEngineColumn';
import { useSimulationBotContext } from '../contexts/SimulationBotContext';
import { useLegacySimulationBotContext } from '../contexts/LegacySimulationBotContext';
import { useProSimulationBotContext } from '../contexts/ProSimulationBotContext';
import { useWorkerAuth } from '../contexts/WorkerAuthContext';
import { useCryptoData } from '../hooks/useCryptoData';
import { usePathSimulationBotContext } from '../contexts/PathSimulationBotContext';
// Thresholds are READ from the engines that own them, never restated here. A
// number typed into JSX is a second definition, and the moment the engine moves
// the panel starts describing a bot that no longer exists.
import { LEGACY_SPOT_BASE_THRESHOLD, LEGACY_FUTURES_BASE_THRESHOLD } from '@cde/engine/execution';
import { PRO_SPOT_BASE_THRESHOLD, PRO_FUTURES_BASE_THRESHOLD } from '@cde/engine/analysis';
import { SIM_CACHE_KEYS, toAggregated, combineRisk, groupAction, type AggregatedBot } from '../lib/botAggregation';

const SimulationBotPage = () => {
  const intraday = useSimulationBotContext();
  const legacy = useLegacySimulationBotContext();
  const pro = useProSimulationBotContext();
  const path = usePathSimulationBotContext();
  const { cryptoData, isLoading } = useCryptoData();
  const { baseUrl, setBaseUrl, persistBaseUrl, baseUrlSource, setBaseUrlSource } = useWorkerAuth();
  const [groupBusy, setGroupBusy] = useState(false);
  const [groupError, setGroupError] = useState<string | null>(null);

  const resetWorkerUrl = () => {
    localStorage.removeItem('workerConfig');
    setBaseUrl('');
    setBaseUrlSource('none');
  };

  const sourceLabel: Record<string, string> = {
    manual: 'הקלדה ידנית',
    localStorage: 'שמור ב-localStorage',
    env: 'משתנה סביבה (Netlify)',
    none: 'לא הוגדר'
  };

  // The four engines as one list.
  //
  // Every "all bots" action and every combined figure below iterates this, so a
  // fifth engine is one line here rather than a hunt through eight call sites.
  // That hunt is exactly what went wrong: Path shipped as a peer in the UI while
  // eight aggregations still read `intraday + legacy + pro`, and the risk meter
  // under-reported the portfolio for as long as Path held anything.
  const allBots: AggregatedBot[] = [
    toAggregated('חדש', intraday),
    toAggregated('מקורי', legacy),
    toAggregated('פרו', pro),
    // Path is the one engine with no browser fallback. When the worker is
    // unreachable its snapshot is a placeholder (equity 10,000, exposure 0),
    // not a reading — and `hasServerData` is how it says so.
    toAggregated('נתיב 4H', path, path.hasServerData)
  ];

  const runGroupAction = async (actions: Array<() => Promise<void>>) => {
    setGroupBusy(true);
    setGroupError(null);
    // allSettled, not all: one engine refusing must not stop the other three.
    const results = await Promise.allSettled(actions.map((action) => action()));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) {
      setGroupError(failures.map((failure) => failure.reason instanceof Error ? failure.reason.message : 'פעולה נכשלה').join(' | '));
    }
    setGroupBusy(false);
    return failures.length === 0;
  };

  // Reset All is NOT Clear Cache. It resets simulation state through each
  // engine's own resetAll and touches no localStorage key: clearing the
  // remembered market data as a side effect of "start over" is a different,
  // heavier operation, and the operator gets to choose it deliberately.
  const clearAllCache = async () => {
    if (!window.confirm('לאפס את כל המטמון של הבוטים (מקומי + שרת)? הפעולה תמחק את כל הפוזיציות וההיסטוריה של ארבעת המנועים ותרענן את הדף.')) {
      return;
    }
    for (const key of SIM_CACHE_KEYS) {
      try {
        localStorage.removeItem(key);
      } catch {
        // ignore
      }
    }
    // resetAll() on each engine also calls the server's reset endpoint,
    // clearing the persisted server-side snapshot that otherwise survives a
    // fresh deploy - that's the "remembers the past even after I uploaded a new
    // dist" symptom.
    if (await runGroupAction(groupAction(allBots, 'resetAll'))) {
      window.location.reload();
    }
  };

  const risk = combineRisk(allBots);

  const anyControlError = allBots.map((bot) => bot.controlError).find(Boolean) ?? null;
  const allRunning = allBots.every((bot) => bot.isRunning);
  const noneRunning = allBots.every((bot) => !bot.isRunning);

  return (
    <div className="min-h-screen bg-background">
      <Navigation />

      <div className="max-w-[1600px] mx-auto p-3 sm:p-4 space-y-6">
        {/* Header */}
        <div className="text-center pt-2">
          <h1 className="text-3xl sm:text-4xl font-bold mb-2 text-primary flex items-center justify-center gap-3 font-mono">
            <Bot className="w-9 h-9" />
            בוט סימולציה — השוואת ארבעה אלגוריתמים
          </h1>
          <p className="text-sm sm:text-base text-muted-foreground font-mono break-words">
            מנוע חדש (רב-שכבתי Multi-Timeframe) · מנוע מקורי (ציון ביטחון משוקלל) · בוט פרו (מימוש מדויק של alg.md) · מנוע נתיב 4H (Empirical Path) — כל אחד עם הון וסטטיסטיקה נפרדים
          </p>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
            <Button
              size="sm"
              onClick={() => void runGroupAction(groupAction(allBots, 'start'))}
              disabled={groupBusy || allRunning}
              className="bg-green-600 hover:bg-green-700 gap-2"
            >
              <Play className="w-4 h-4" />
              הפעל את כל הבוטים
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void runGroupAction(groupAction(allBots, 'pause'))}
              disabled={groupBusy || noneRunning}
              className="gap-2"
            >
              <Pause className="w-4 h-4" />
              השהה את כל הבוטים
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => void runGroupAction(groupAction(allBots, 'resetAll'))}
              disabled={groupBusy}
              className="gap-2"
            >
              <Square className="w-4 h-4" />
              אפס את כל הבוטים
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={clearAllCache}
              className="gap-2 text-destructive border-destructive/40 hover:bg-destructive/10"
            >
              <Trash2 className="w-4 h-4" />
              איפוס מטמון (מקומי + שרת)
            </Button>
          </div>

          {(groupError || anyControlError) && (
            <Card className="mt-3 border-red-500/40 bg-red-500/10">
              <CardContent className="p-3 text-sm text-red-300 font-mono">
                {groupError || anyControlError}
              </CardContent>
            </Card>
          )}

        {/* Worker URL diagnostic — shows exactly which URL the frontend is using
            and where it came from. This is the #1 cause of "CORS blocked" errors
            after a Render URL change: localStorage still holds the old address. */}
        <Card className="border-primary/20 bg-card/50">
          <CardContent className="p-3 flex flex-wrap items-center gap-3 text-xs font-mono">
            <span className="text-muted-foreground">Worker URL:</span>
            <span className="text-primary font-semibold break-all">{baseUrl || 'לא הוגדר'}</span>
            <span className="text-muted-foreground">מקור:</span>
            <span className={`px-2 py-0.5 rounded ${
              baseUrlSource === 'env' ? 'bg-green-500/10 text-green-400' :
              baseUrlSource === 'localStorage' ? 'bg-yellow-500/10 text-yellow-400' :
              baseUrlSource === 'manual' ? 'bg-blue-500/10 text-blue-400' :
              'bg-muted text-muted-foreground'
            }`}>
              {sourceLabel[baseUrlSource] || baseUrlSource}
            </span>
            {baseUrl && (
              <Button
                size="sm"
                variant="ghost"
                onClick={resetWorkerUrl}
                className="h-7 text-xs text-destructive hover:text-destructive"
              >
                איפוס כתובת
              </Button>
            )}
            {baseUrl && (
              <a
                href={`${baseUrl}/health`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline flex items-center gap-1"
              >
                <ExternalLink className="w-3 h-3" />
                בדיקת /health
              </a>
            )}
          </CardContent>
        </Card>

        {/* Cross-device sync status — the shared server state (so a second device
            sees the SAME running bot) needs a Worker URL configured on THIS
            device too; localStorage is per-device and never syncs on its own. */}
        {(intraday.syncStatus === 'local-only' || legacy.syncStatus === 'local-only' || pro.syncStatus === 'local-only' || path.syncStatus === 'local-only') && (
          <Card className="border-yellow-500/40 bg-yellow-500/5">
            <CardContent className="p-4 space-y-2 font-mono">
              <div className="flex items-center gap-2 text-yellow-400 text-sm font-bold">
                <AlertTriangle className="w-4 h-4" />
                {(() => {
                  const offline = [
                    intraday.syncStatus === 'local-only' && 'חדש',
                    legacy.syncStatus === 'local-only' && 'מקורי',
                    pro.syncStatus === 'local-only' && 'פרו',
                    // Path has no local twin: offline for it means no data at
                    // all, not "running locally". The banner below says so.
                    path.syncStatus === 'local-only' && 'נתיב 4H'
                  ].filter(Boolean) as string[];
                  return offline.length === 4
                    ? 'ארבעת המנועים לא מסונכרנים עם שרת — שלושה מציגים סימולציה מקומית, ומנוע נתיב 4H אינו זמין כלל (הוא רץ בשרת בלבד)'
                    : `מנוע ${offline.join(' ו-')} לא מסונכרן עם שרת — מציג סימולציה מקומית בלבד במכשיר הזה`;
                })()}
              </div>
              <p className="text-xs text-muted-foreground">
                אם הפעלת את הבוט במכשיר אחר, לא תראה כאן את אותה פעילות עד שתחבר את המכשיר הזה לאותה כתובת Worker.
                {intraday.syncError ? ` (${intraday.syncError})` : legacy.syncError ? ` (${legacy.syncError})` : pro.syncError ? ` (${pro.syncError})` : path.syncError ? ` (${path.syncError})` : ''}
              </p>
              <div className="flex gap-2 flex-wrap items-center">
                <Input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://<worker>.onrender.com או כתובת tunnel"
                  className="flex-1 min-w-[220px] text-xs"
                  autoCapitalize="off"
                  autoCorrect="off"
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button size="sm" onClick={persistBaseUrl}>
                  שמור כתובת Worker
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Live data status */}
        <Card className="border-primary/30 bg-card/50 backdrop-blur">
          <CardContent className="p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-mono">
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin text-primary' : 'text-muted-foreground'}`} />
              <span className="text-muted-foreground">
                {isLoading ? 'טוען נתוני שוק...' : `${cryptoData?.length || 0} נכסים חיים · נתונים משותפים לארבעת המנועים`}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Combined risk overview */}
        <PortfolioRiskMeter
          portfolioValue={risk.portfolioValue}
          totalInvestedUsd={risk.totalInvestedUsd}
          totalLeveragedExposureUsd={risk.totalLeveragedExposureUsd}
          openPositionsCount={risk.openPositionsCount}
          maxPositions={risk.maxPositions}
          openFuturesCount={risk.openFuturesCount}
          maxFutures={risk.maxFutures}
          dailyDrawdownPercent={risk.dailyDrawdownPercent}
          weeklyDrawdownPercent={risk.weeklyDrawdownPercent}
          unavailableEngines={risk.unavailableEngines}
        />

        {/* Four engines — 1 column on mobile, 2 from large up. Three-across left the
            fourth alone on its own row; two-across keeps the grid even. */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <SimulationEngineColumn
            title="מנוע חדש · Multi-Timeframe"
            subtitle="Setup + Entry מבניים על 1H/15M/5M"
            accentClass="text-primary"
            cryptoData={cryptoData}
            cash={intraday.cash}
            positions={intraday.positions}
            positionsValue={intraday.positionsValue}
            equity={intraday.equity}
            trades={intraday.trades}
            history={intraday.history}
            pending={intraday.pending}
            totalFees={intraday.totalFees}
            totalSlippageCost={intraday.totalSlippageCost}
            winRate={intraday.winRate}
            totalTrades={intraday.totalTrades}
            closedTrades={intraday.closedTrades}
            evaluations={intraday.evaluations}
            hasSavedSession={intraday.hasSavedSession}
            nextTickAt={intraday.nextTickAt}
            config={intraday.config}
            setConfig={intraday.setConfig}
            status={intraday.status}
            isRunning={intraday.isRunning}
            start={intraday.start}
            pause={intraday.pause}
            resetAll={intraday.resetAll}
          />

          <SimulationEngineColumn
            title="מנוע מקורי · Confidence Score"
            subtitle={`ציון משוקלל 7 אינדיקטורים · סף בסיס Spot ${LEGACY_SPOT_BASE_THRESHOLD} / Futures ${LEGACY_FUTURES_BASE_THRESHOLD} — שניהם עולים עד +15 נק׳ עם ATR`}
            accentClass="text-cyan-400"
            cryptoData={cryptoData}
            cash={legacy.cash}
            positions={legacy.positions}
            positionsValue={legacy.positionsValue}
            equity={legacy.equity}
            trades={legacy.trades}
            history={legacy.history}
            pending={legacy.pending}
            totalFees={legacy.totalFees}
            totalSlippageCost={legacy.totalSlippageCost}
            winRate={legacy.winRate}
            totalTrades={legacy.totalTrades}
            closedTrades={legacy.closedTrades}
            evaluations={legacy.evaluations}
            hasSavedSession={legacy.hasSavedSession}
            nextTickAt={legacy.nextTickAt}
            config={legacy.config}
            setConfig={legacy.setConfig}
            status={legacy.status}
            isRunning={legacy.isRunning}
            start={legacy.start}
            pause={legacy.pause}
            resetAll={legacy.resetAll}
          />

          <SimulationEngineColumn
            title="בוט פרו · alg.md"
            subtitle={`מימוש מדויק של ASSETS/alg.md · סף בסיס Spot ${PRO_SPOT_BASE_THRESHOLD} / Futures ${PRO_FUTURES_BASE_THRESHOLD} (אחרי קנסות), Kelly ישיר`}
            accentClass="text-amber-400"
            cryptoData={cryptoData}
            cash={pro.cash}
            positions={pro.positions}
            positionsValue={pro.positionsValue}
            equity={pro.equity}
            trades={pro.trades}
            history={pro.history}
            pending={pro.pending}
            totalFees={pro.totalFees}
            totalSlippageCost={pro.totalSlippageCost}
            winRate={pro.winRate}
            totalTrades={pro.totalTrades}
            closedTrades={pro.closedTrades}
            evaluations={pro.evaluations}
            hasSavedSession={pro.hasSavedSession}
            nextTickAt={pro.nextTickAt}
            config={pro.config}
            setConfig={pro.setConfig}
            status={pro.status}
            isRunning={pro.isRunning}
            start={pro.start}
            pause={pro.pause}
            resetAll={pro.resetAll}
          />

          <SimulationEngineColumn
            title="מנוע נתיב 4H · Empirical Path"
            subtitle={
              // The table's PROVENANCE is the headline, not its size: a
              // validated table and an in-sample one look identical in the trade
              // list and are worth completely different things.
              !path.table
                ? 'פירוק נר 4H ל-16 נתחי 15 דק׳ · טבלת הסתברויות נטענת'
                : path.table.readiness === 'warming-up'
                  // Zero buckets because no symbol has enough history yet is
                  // NOT the same as zero buckets because nothing cleared the
                  // bar, and the count alone reads identically for both.
                  ? `נתחי 15 דק׳ בתוך נר 4H · אוסף היסטוריה (${path.table.skippedForHistory}/${path.table.symbolsSeen} מטבעות מתחת ל-${path.table.minCandlesRequired} נרות)`
                  : path.table.source === 'validated'
                    ? `נתחי 15 דק׳ בתוך נר 4H · ${path.table.buckets} דליים מאומתים (walk-forward)`
                    : path.table.source === 'live-in-sample'
                      ? `נתחי 15 דק׳ בתוך נר 4H · ${path.table.buckets} דליים IN-SAMPLE — לא אומת`
                      : 'נתחי 15 דק׳ בתוך נר 4H · אין טבלה — הבוט נמנע'
            }
            accentClass="text-violet-400"
            cryptoData={cryptoData}
            cash={path.cash}
            positions={path.positions}
            positionsValue={path.positionsValue}
            equity={path.equity}
            trades={path.trades}
            history={path.history}
            pending={path.pending}
            totalFees={path.totalFees}
            totalSlippageCost={path.totalSlippageCost}
            winRate={path.winRate}
            totalTrades={path.totalTrades}
            closedTrades={path.closedTrades}
            evaluations={path.evaluations}
            hasSavedSession={path.hasSavedSession}
            nextTickAt={path.nextTickAt}
            config={path.config}
            setConfig={path.setConfig}
            status={path.status}
            isRunning={path.isRunning}
            start={path.start}
            pause={path.pause}
            resetAll={path.resetAll}
          />
        </div>
      </div>
    </div>
    </div>
  );
};

// The four sim-bot providers now live at the app root (see App.tsx) so every
// page — not just this one — sees live, server-synced bot state.
export default SimulationBotPage;

