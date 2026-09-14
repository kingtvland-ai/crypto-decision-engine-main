import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useState } from 'react';
import { Bot, RefreshCw, AlertTriangle, Trash2, ExternalLink, Play, Pause, Square, Download } from 'lucide-react';
import Navigation from '../components/Navigation';
import PortfolioRiskMeter from '../components/trading/PortfolioRiskMeter';
import SimulationEngineColumn from '../components/trading/SimulationEngineColumn';
import { useSimulationBotContext } from '../contexts/SimulationBotContext';
import { useProSimulationBotContext } from '../contexts/ProSimulationBotContext';
import { useWorkerAuth } from '../contexts/WorkerAuthContext';
import { useCryptoData } from '../hooks/useCryptoData';
import { usePathSimulationBotContext } from '../contexts/PathSimulationBotContext';
import { useBybitSimulationBotContext } from '../contexts/BybitSimulationBotContext';
// Thresholds are READ from the engines that own them, never restated here. A
// number typed into JSX is a second definition, and the moment the engine moves
// the panel starts describing a bot that no longer exists.
// Pro's entry bar is the operator's flat default (70) — an override in the
// settings overrides it; the risk table stays exported as reference.
import { PRO_ENTRY_ALLOCATION_PERCENT, PRO_DEFAULT_ENTRY_CONFIDENCE, PRO_STOP_LOSS_PERCENT, PRO_TAKE_PROFIT_PERCENT } from '@cde/engine/analysis';
import { SIM_CACHE_KEYS, toAggregated, combineRisk, groupAction, type AggregatedBot } from '../lib/botAggregation';
import { buildBotComparisonCsv, buildTradeLogCsv, csvFilename, downloadCsv, type CsvBot } from '../lib/botCsvExport';
import { clearBacktestArchive } from '../services/tradingApiClient';

const SimulationBotPage = () => {
  const intraday = useSimulationBotContext();
  const pro = useProSimulationBotContext();
  const path = usePathSimulationBotContext();
  const bybit = useBybitSimulationBotContext();
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

  // The three engines as one list.
  //
  // Every "all bots" action and every combined figure below iterates this, so a
  // fourth engine is one line here rather than a hunt through eight call sites.
  // That hunt is exactly what went wrong: Path shipped as a peer in the UI while
  // eight aggregations still read `intraday + legacy + pro`, and the risk meter
  // under-reported the portfolio for as long as Path held anything.
  const allBots: AggregatedBot[] = [
    toAggregated('חדש', intraday),
    toAggregated('פרו', pro),
    // Path and Bybit are the engines with no browser fallback. When the worker
    // is unreachable their snapshot is a placeholder (equity 10,000, exposure
    // 0), not a reading — and `hasServerData` is how they say so.
    toAggregated('נתיב 4H', path, path.hasServerData),
    toAggregated('Bybit', bybit, bybit.hasServerData)
  ];

  // The four bots as compact summary cards (equity / P&L / positions / win
  // rate). Structurally narrower than any one context so the four differing
  // context types assign cleanly; `hasServerData` is optional because only the
  // two server-only bots carry it.
  const summaryBots: Array<{
    key: string;
    label: string;
    accent: string;
    ring: string;
    serverOnly?: boolean;
    ctx: {
      config: { initialAmount: number };
      equity: number;
      positions: Array<{ type?: string }>;
      isRunning: boolean;
      winRate: number;
      closedTrades: number;
      hasServerData?: boolean;
    };
  }> = [
    { key: 'intraday', label: 'חדש', ctx: intraday, accent: 'text-primary', ring: 'border-primary/30' },
    { key: 'pro', label: 'פרו', ctx: pro, accent: 'text-amber-400', ring: 'border-amber-400/30' },
    { key: 'path', label: 'נתיב 4H', ctx: path, accent: 'text-violet-400', ring: 'border-violet-400/30', serverOnly: true },
    { key: 'bybit', label: 'Bybit', ctx: bybit, accent: 'text-cyan-400', ring: 'border-cyan-400/30', serverOnly: true }
  ];

  // What the two CSV exports read. Deliberately built from the SAME four
  // contexts the columns render from, so an exported row can never disagree
  // with what is on screen.
  const csvBots: CsvBot[] = [
    { label: 'מנוע חדש', ...intraday },
    { label: 'פרו', ...pro },
    { label: 'נתיב 4H', ...path },
    { label: 'Bybit', ...bybit }
  ].map((b) => ({
    label: b.label,
    isRunning: b.isRunning,
    equity: b.equity,
    cash: b.cash,
    positionsValue: b.positionsValue,
    positions: b.positions,
    trades: b.trades,
    totalFees: b.totalFees,
    totalSlippageCost: b.totalSlippageCost,
    totalFunding: b.totalFunding,
    winRate: b.winRate,
    totalTrades: b.totalTrades,
    closedTrades: b.closedTrades,
    config: b.config
  }));

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

  // Reset All is NOT Clear Cache. "Reset All Bots" resets each engine's run and
  // ARCHIVES it server-side (§9/#4) so BacktestResults keeps the history. Clear
  // Cache is the heavier operation: it also wipes that archive and the local
  // localStorage keys.
  const clearAllCache = async () => {
    if (!window.confirm('לאפס את כל המטמון של הבוטים (מקומי + שרת)? הפעולה תמחק את כל הפוזיציות, ההיסטוריה, ו-ארכיון הריצות של ארבעת המנועים ותרענן את הדף.')) {
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
    const ok = await runGroupAction(groupAction(allBots, 'resetAll'));
    // Wipe the server-side run archive AFTER the resets — those resets each
    // append the just-ended run to the archive (§9/#4), so clearing must come
    // last. This is the ONE action that erases historical runs from
    // BacktestResults; a plain "Reset All Bots" keeps them.
    try {
      await clearBacktestArchive(baseUrl);
    } catch {
      // ignore — the reload below still proceeds
    }
    if (ok) {
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
        {/* Header — one compact title row + one controls row (was five stacked
            full-width cards). */}
        <div className="pt-2 space-y-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h1 className="text-xl sm:text-2xl font-bold text-primary flex items-center gap-2 font-mono">
              <Bot className="w-7 h-7" />
              בוט סימולציה — השוואת ארבעה אלגוריתמים
            </h1>
            <span className="text-[11px] text-muted-foreground font-mono">
              הון וסטטיסטיקה נפרדים לכל בוט · נתיב 4H ו-Bybit סימולציה בלבד (לא לכסף אמיתי)
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
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
            <div className="h-6 w-px bg-border mx-1 hidden sm:block" />

            <Button
              size="sm"
              variant="outline"
              onClick={() => downloadCsv(csvFilename('bots-comparison'), buildBotComparisonCsv(csvBots))}
              className="gap-2"
              title="שורה לכל בוט: הון, רווח/הפסד, אחוז הצלחה, מודל העלות (עמלה/החלקה/לימיט) ופילוח סיבות יציאה"
            >
              <Download className="w-4 h-4" />
              השוואת בוטים CSV
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => downloadCsv(csvFilename('bots-trades'), buildTradeLogCsv(csvBots))}
              className="gap-2"
              title="שורה לכל ביצוע בכל הבוטים, כולל סיבת היציאה המלאה"
            >
              <Download className="w-4 h-4" />
              יומן עסקאות CSV
            </Button>
            <div className="h-6 w-px bg-border mx-1 hidden sm:block" />

            {/* Worker URL + live-data pulled inline so the header is two rows,
                not a stack of full-width diagnostic cards. */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-mono text-muted-foreground">
              <span>Worker:</span>
              <span className="text-primary font-semibold break-all">{baseUrl || 'לא הוגדר'}</span>
              <span className={`px-1.5 py-0.5 rounded ${
                baseUrlSource === 'env' ? 'bg-green-500/10 text-green-400' :
                baseUrlSource === 'localStorage' ? 'bg-yellow-500/10 text-yellow-400' :
                baseUrlSource === 'manual' ? 'bg-blue-500/10 text-blue-400' :
                'bg-muted text-muted-foreground'
              }`}>
                {sourceLabel[baseUrlSource] || baseUrlSource}
              </span>
              {baseUrl && (
                <a
                  href={`${baseUrl}/health`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline inline-flex items-center gap-1"
                >
                  <ExternalLink className="w-3 h-3" />
                  /health
                </a>
              )}
              {baseUrl && (
                <button type="button" onClick={resetWorkerUrl} className="text-destructive hover:underline">
                  איפוס כתובת
                </button>
              )}
              <span className="mx-0.5">·</span>
              <span className="inline-flex items-center gap-1">
                <RefreshCw className={`w-3 h-3 ${isLoading ? 'animate-spin text-primary' : ''}`} />
                {isLoading ? 'טוען שוק…' : `${cryptoData?.length || 0} נכסים חיים · נתונים משותפים לארבעת המנועים`}
              </span>
            </div>
          </div>

          {(groupError || anyControlError) && (
            <Card className="border-red-500/40 bg-red-500/10">
              <CardContent className="p-3 text-sm text-red-300 font-mono">
                {groupError || anyControlError}
              </CardContent>
            </Card>
          )}

        {/* Cross-device sync status — the shared server state (so a second device
            sees the SAME running bot) needs a Worker URL configured on THIS
            device too; localStorage is per-device and never syncs on its own. */}
        {(intraday.syncStatus === 'local-only' || pro.syncStatus === 'local-only' || path.syncStatus === 'local-only' || bybit.syncStatus === 'local-only') && (
          <Card className="border-yellow-500/40 bg-yellow-500/5">
            <CardContent className="p-4 space-y-2 font-mono">
              <div className="flex items-center gap-2 text-yellow-400 text-sm font-bold">
                <AlertTriangle className="w-4 h-4" />
                {(() => {
                  const offline = [
                    intraday.syncStatus === 'local-only' && 'חדש',
                    pro.syncStatus === 'local-only' && 'פרו',
                    // Path and Bybit have no local twin: offline for them means
                    // no data at all, not "running locally". The banner below
                    // says so.
                    path.syncStatus === 'local-only' && 'נתיב 4H',
                    bybit.syncStatus === 'local-only' && 'Bybit'
                  ].filter(Boolean) as string[];
                  return offline.length === 4
                    ? 'ארבעת המנועים לא מסונכרנים עם שרת — חדש ופרו מציגים סימולציה מקומית, ומנועי נתיב 4H ו-Bybit אינם זמינים כלל (הם רצים בשרת בלבד)'
                    : `מנוע ${offline.join(' ו-')} לא מסונכרן עם שרת — מציג סימולציה מקומית בלבד במכשיר הזה`;
                })()}
              </div>
              <p className="text-xs text-muted-foreground">
                אם הפעלת את הבוט במכשיר אחר, לא תראה כאן את אותה פעילות עד שתחבר את המכשיר הזה לאותה כתובת Worker.
                {intraday.syncError ? ` (${intraday.syncError})` : pro.syncError ? ` (${pro.syncError})` : path.syncError ? ` (${path.syncError})` : bybit.syncError ? ` (${bybit.syncError})` : ''}
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

        {/* Four analytic summary cards — one column per bot: equity, P&L, open
            positions, win rate. Full controls + decision feed stay in each
            engine column below. */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {summaryBots.map(({ key, label, ctx, accent, ring, serverOnly }) => {
            const invested = ctx.config.initialAmount || 10_000;
            const pnl = ctx.equity - invested;
            const pnlPct = invested ? (pnl / invested) * 100 : 0;
            const noData = serverOnly && !ctx.hasServerData;
            const openCount = ctx.positions.length;
            const futCount = ctx.positions.filter((p) => p.type === 'FUTURES').length;
            const up = pnl >= 0;
            return (
              <Card key={key} className={`bg-card/50 backdrop-blur ${ring}`}>
                <CardContent className="p-3 font-mono space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-sm font-bold ${accent}`}>{label}</span>
                    <span
                      className={`w-2 h-2 rounded-full ${ctx.isRunning ? 'bg-green-500 animate-pulse' : 'bg-gray-500'}`}
                      title={ctx.isRunning ? 'פעיל' : 'מושבת'}
                    />
                  </div>
                  {noData ? (
                    <div className="text-xs text-muted-foreground py-3">אין נתוני שרת</div>
                  ) : (
                    <>
                      <div className="text-xl font-bold tabular-nums">
                        ${ctx.equity.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                      </div>
                      <div className={`text-xs font-bold tabular-nums ${up ? 'text-green-400' : 'text-red-400'}`}>
                        {up ? '+' : ''}${pnl.toFixed(2)} ({up ? '+' : ''}{pnlPct.toFixed(2)}%)
                      </div>
                      <div className="flex items-center justify-between text-[11px] text-muted-foreground pt-1.5 border-t border-border/30">
                        <span>{openCount} פוז׳{futCount ? ` · ${futCount}F` : ''}</span>
                        <span>הצלחה {ctx.winRate.toFixed(0)}%</span>
                        <span>{ctx.closedTrades} נסגרו</span>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>

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

        {/* Four engines — 1 column on mobile, 2 from large up (2×2). */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <SimulationEngineColumn
            title="מנוע חדש · Multi-Timeframe"
            testId="intraday"
            subtitle="Setup + Entry מבניים על 1H/15M/5M"
            accentClass="text-primary"
            cryptoData={cryptoData}
            cash={intraday.cash}
            positions={intraday.positions}
            positionsValue={intraday.positionsValue}
            equity={intraday.equity}
            trades={intraday.trades}
            history={intraday.history}
            hourlyHistory={intraday.hourlyHistory}
            pending={intraday.pending}
            totalFees={intraday.totalFees}
            totalSlippageCost={intraday.totalSlippageCost}
            totalFunding={intraday.totalFunding}
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
            title="בוט פרו · alg.md"
            testId="pro"
            subtitle={`מימוש alg.md · אשכול RSI/MA/BB/Stoch נספר עם עונש קורלציה (1/√n) · קנייה כשהביטחון עובר ${PRO_DEFAULT_ENTRY_CONFIDENCE}% · הקצאה ${PRO_ENTRY_ALLOCATION_PERCENT * 100}% מהמזומן · SL ${PRO_STOP_LOSS_PERCENT}% (תקרה, ATR-scaled) / TP ${PRO_TAKE_PROFIT_PERCENT}%`}
            accentClass="text-amber-400"
            cryptoData={cryptoData}
            cash={pro.cash}
            positions={pro.positions}
            positionsValue={pro.positionsValue}
            equity={pro.equity}
            trades={pro.trades}
            history={pro.history}
            hourlyHistory={pro.hourlyHistory}
            pending={pro.pending}
            totalFees={pro.totalFees}
            totalSlippageCost={pro.totalSlippageCost}
            totalFunding={pro.totalFunding}
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
            title="נתיב 4H · טווח נר קודם"
            testId="path"
            subtitle="פריצת הגבוה/נמוך של נר ה-4H הקודם, בכיוון מגמת EMA20 (4H) · SL = אמצע הטווח, TP = טווח×1 · יציאה בסוף הנר"
            accentClass="text-violet-400"
            cryptoData={cryptoData}
            cash={path.cash}
            positions={path.positions}
            positionsValue={path.positionsValue}
            equity={path.equity}
            trades={path.trades}
            history={path.history}
            hourlyHistory={path.hourlyHistory}
            pending={path.pending}
            totalFees={path.totalFees}
            totalSlippageCost={path.totalSlippageCost}
            totalFunding={path.totalFunding}
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

          <SimulationEngineColumn
            title="Bybit · TrendBreakout"
            testId="bybit"
            subtitle="פריצת Donchian(20) ב-M15 על מגמת H1 (Supertrend + EMA50/200), תזמון M5 · SL 1.5×ATR, TP 2R, scale-in 50/30/20 · סימולציה בלבד"
            accentClass="text-cyan-400"
            cryptoData={cryptoData}
            cash={bybit.cash}
            positions={bybit.positions}
            positionsValue={bybit.positionsValue}
            equity={bybit.equity}
            trades={bybit.trades}
            history={bybit.history}
            hourlyHistory={bybit.hourlyHistory}
            pending={bybit.pending}
            totalFees={bybit.totalFees}
            totalSlippageCost={bybit.totalSlippageCost}
            totalFunding={bybit.totalFunding}
            winRate={bybit.winRate}
            totalTrades={bybit.totalTrades}
            closedTrades={bybit.closedTrades}
            evaluations={bybit.evaluations}
            hasSavedSession={bybit.hasSavedSession}
            nextTickAt={bybit.nextTickAt}
            config={bybit.config}
            setConfig={bybit.setConfig}
            status={bybit.status}
            isRunning={bybit.isRunning}
            start={bybit.start}
            pause={bybit.pause}
            resetAll={bybit.resetAll}
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

