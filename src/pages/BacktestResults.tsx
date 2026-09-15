import { useEffect, useMemo, useState } from 'react';
import { Activity, TrendingUp, TrendingDown, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import Navigation from '../components/Navigation';
import { useWorkerAuth } from '../contexts/WorkerAuthContext';
import { useSimulationBotContext } from '../contexts/SimulationBotContext';
import { useProSimulationBotContext } from '../contexts/ProSimulationBotContext';
import { usePathSimulationBotContext } from '../contexts/PathSimulationBotContext';
import { useBybitSimulationBotContext } from '../contexts/BybitSimulationBotContext';
import type { SimTrade, SimPosition } from '@cde/engine/execution';
import { getBacktestArchive, type BacktestArchiveResponse } from '../services/tradingApiClient';

// A live side-by-side comparison of the four simulation bots — closed-trade
// stats and a merged trade log. The bots poll the worker on their own (every
// 5s via their contexts), so there is nothing to "run" here; this page only
// reads what they have already done. All four are simulation only.
//
// Two things this page gets right that the first cut got wrong (see
// ANALYST_REPORT_2026-09-07_bot-comparison.md):
//   · Every bot is measured against ITS OWN starting capital
//     (`config.initialAmount`), not a hardcoded $10,000 — the bots each carry
//     separate capital and the operator changes it per bot.
//   · "שינוי הון (MtM)" (equity − base: includes unrealized + costs) and
//     "רווח ממומש" (closed trades only) are shown as two clearly labelled
//     measures, with an independent reconciliation check between them.
//   · A server-only bot with no worker data is shown as "אין נתוני שרת", not
//     folded in as a fake flat $10,000 / 0% row.

type BotKey = 'intraday' | 'pro' | 'path' | 'bybit';

interface TradeRow extends SimTrade {
  bot: string;
  botKey: BotKey;
  /** Set for rows coming from an archived (pre-reset) run — §9/#4. */
  runId?: string;
  archived?: boolean;
}

interface BotStats {
  key: BotKey;
  label: string;
  running: boolean;
  hasData: boolean;
  base: number;
  equity: number;
  /** equity − base. Mark-to-market: unrealized P&L on open positions plus
   *  accumulated fees / slippage / funding. */
  pnlTotalUsd: number;
  pnlTotalPct: number;
  /** Independent price-move P&L on the still-open positions. */
  unrealizedPnl: number;
  dailyDrawdownPercent: number;
  /** Server-authoritative (same figure the bot's own column shows). */
  closedTrades: number;
  winRate: number;
  /** Rows this bot contributes to the merged log below. */
  logRows: number;
  wins: number;
  losses: number;
  breakeven: number;
  realizedPnl: number;
  avgPnl: number;
  bestTrade: number;
  worstTrade: number;
  /** |MtM − (realized + unrealized)|. Should be within a few dollars (open-
   *  position entry fees + funding). A large gap means a figure upstream is
   *  wrong — exactly the symptom the −90% bug produced. */
  reconGap: number;
  reconOff: boolean;
}

const fmt = (n: number, digits = 2) =>
  n.toFixed(digits).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const pnlColor = (pnl: number) =>
  pnl > 0 ? 'text-green-400' : pnl < 0 ? 'text-red-400' : 'text-muted-foreground';

interface BotInput {
  key: BotKey;
  label: string;
  running: boolean;
  hasData: boolean;
  base: number;
  equity: number;
  dailyDrawdownPercent: number;
  positions: SimPosition[];
  serverWinRate: number;
  serverClosedTrades: number;
  trades: TradeRow[]; // this bot's closed-trade rows (t.pnl is a number)
}

function unrealizedFor(positions: SimPosition[]): number {
  return positions.reduce((sum, p) => {
    const dir = p.side === 'LONG' || p.side === 'BUY' ? 1 : -1;
    const px = p.currentPrice || p.entryPrice;
    // Sim futures are all 1x, and `quantity` already carries leverage — no
    // separate leverage multiply here.
    return sum + (px - p.entryPrice) * p.quantity * dir;
  }, 0);
}

function statsFor(input: BotInput): BotStats {
  const closed = input.trades;
  const wins = closed.filter((t) => (t.pnl ?? 0) > 0);
  const losses = closed.filter((t) => (t.pnl ?? 0) < 0);
  const breakeven = closed.filter((t) => (t.pnl ?? 0) === 0);
  const realizedPnl = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const pnls = closed.map((t) => t.pnl ?? 0);
  const unrealizedPnl = unrealizedFor(input.positions);

  const pnlTotalUsd = input.equity - input.base;
  const reconGap = pnlTotalUsd - realizedPnl - unrealizedPnl;

  return {
    key: input.key,
    label: input.label,
    running: input.running,
    hasData: input.hasData,
    base: input.base,
    equity: input.equity,
    pnlTotalUsd,
    pnlTotalPct: input.base ? (pnlTotalUsd / input.base) * 100 : 0,
    unrealizedPnl,
    dailyDrawdownPercent: input.dailyDrawdownPercent,
    // Server-authoritative — matches the bot's own column on /simulation-bot.
    closedTrades: input.serverClosedTrades,
    winRate: input.serverWinRate,
    logRows: closed.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: breakeven.length,
    realizedPnl,
    avgPnl: closed.length ? realizedPnl / closed.length : 0,
    bestTrade: pnls.length ? Math.max(...pnls) : 0,
    worstTrade: pnls.length ? Math.min(...pnls) : 0,
    reconGap,
    reconOff: Math.abs(reconGap) > Math.max(input.base * 0.01, 5)
  };
}

export default function BacktestResults() {
  const { baseUrl } = useWorkerAuth();
  const intraday = useSimulationBotContext();
  const pro = useProSimulationBotContext();
  const path = usePathSimulationBotContext();
  const bybit = useBybitSimulationBotContext();

  const [selectedBot, setSelectedBot] = useState<'all' | BotKey>('all');
  const [sortBy, setSortBy] = useState<'time' | 'pnl'>('time');
  /** Exit reasons carry the numbers that explain the trade ("MFE 0.05R",
   *  the actual stop level). Truncating them to a `title` tooltip hid that
   *  from touch devices entirely and made it uncopyable everywhere. */
  const [showFullReasons, setShowFullReasons] = useState(false);
  const [expandedReasons, setExpandedReasons] = useState<Set<string>>(new Set());
  const [includeHistory, setIncludeHistory] = useState(true);

  // §9/#4 — historical runs archived server-side at each reset. A plain
  // "Reset All Bots" no longer destroys them; they are re-read here so past
  // performance survives. Cleared only by "Clear Cache + Server".
  const [archive, setArchive] = useState<BacktestArchiveResponse | null>(null);
  useEffect(() => {
    if (!baseUrl) { setArchive(null); return; }
    let cancelled = false;
    getBacktestArchive(baseUrl)
      .then((a) => { if (!cancelled) setArchive(a); })
      .catch(() => { if (!cancelled) setArchive(null); });
    return () => { cancelled = true; };
  }, [baseUrl]);

  const bots = useMemo(() => ([
    { key: 'intraday' as const, label: 'מנוע חדש', ctx: intraday },
    { key: 'pro' as const, label: 'פרו', ctx: pro },
    { key: 'path' as const, label: 'נתיב 4H', ctx: path },
    { key: 'bybit' as const, label: 'Bybit', ctx: bybit }
  ]), [intraday, pro, path, bybit]);

  const archivedRows: TradeRow[] = useMemo(() => {
    if (!archive) return [];
    const rows: TradeRow[] = [];
    for (const b of bots) {
      for (const run of archive[b.key] ?? []) {
        for (const t of run.trades ?? []) {
          if (typeof t.pnl !== 'number') continue;
          rows.push({ ...t, bot: b.label, botKey: b.key, runId: run.runId, archived: true });
        }
      }
    }
    return rows;
  }, [archive, bots]);
  const archivedRunCount = useMemo(
    () => bots.reduce((n, b) => n + ((archive?.[b.key]?.length) ?? 0), 0),
    [archive, bots]
  );

  const liveTrades: TradeRow[] = useMemo(() =>
    bots.flatMap((b) =>
      (b.ctx.trades ?? [])
        .filter((t) => typeof t.pnl === 'number') // closed trades only
        .map((t) => ({ ...t, bot: b.label, botKey: b.key }))
    ), [bots]);

  const allTrades: TradeRow[] = useMemo(
    () => includeHistory ? [...liveTrades, ...archivedRows] : liveTrades,
    [liveTrades, archivedRows, includeHistory]
  );

  const perBotStats: BotStats[] = useMemo(() =>
    bots.map((b) => {
      // intraday / pro have no browser fallback flag (always real); path / bybit
      // expose hasServerData and it is false when the worker is unreachable.
      const hasData = 'hasServerData' in b.ctx ? b.ctx.hasServerData !== false : true;
      const botRows = allTrades.filter((t) => t.botKey === b.key);
      // With history folded in, the live-context winRate/closedTrades only cover
      // the CURRENT run — recompute from the merged rows so the headline numbers
      // match the log.
      const mergedWins = botRows.filter((t) => (t.pnl ?? 0) > 0).length;
      return statsFor({
        key: b.key,
        label: b.label,
        running: b.ctx.isRunning,
        hasData,
        base: b.ctx.initialAmount,
        equity: b.ctx.equity,
        dailyDrawdownPercent: b.ctx.dailyDrawdownPercent,
        positions: (b.ctx.positions ?? []) as SimPosition[],
        serverWinRate: includeHistory
          ? (botRows.length ? (mergedWins / botRows.length) * 100 : 0)
          : (b.ctx.winRate ?? 0),
        serverClosedTrades: includeHistory ? botRows.length : (b.ctx.closedTrades ?? 0),
        trades: botRows
      });
    }), [bots, allTrades, includeHistory]);

  const filtered = selectedBot === 'all'
    ? allTrades
    : allTrades.filter((t) => t.botKey === selectedBot);

  const sorted = [...filtered].sort((a, b) =>
    sortBy === 'time' ? b.at - a.at : (b.pnl ?? 0) - (a.pnl ?? 0)
  );

  const activeStats = selectedBot === 'all'
    ? null
    : perBotStats.find((s) => s.key === selectedBot) ?? null;

  // Totals cover only the bots we actually have data for — a disconnected
  // server-only bot is excluded, never folded in at a placeholder equity.
  const combined = useMemo(() => {
    const live = perBotStats.filter((s) => s.hasData);
    const base = live.reduce((s, b) => s + b.base, 0);
    const equity = live.reduce((s, b) => s + b.equity, 0);
    const realized = live.reduce((s, b) => s + b.realizedPnl, 0);
    const unrealized = live.reduce((s, b) => s + b.unrealizedPnl, 0);
    const closed = live.reduce((s, b) => s + b.logRows, 0);
    const wins = live.reduce((s, b) => s + b.wins, 0);
    const pnlUsd = equity - base;
    return {
      base,
      equity,
      pnlUsd,
      pnlPct: base ? (pnlUsd / base) * 100 : 0,
      realized,
      unrealized,
      closed,
      winRate: closed ? (wins / closed) * 100 : 0,
      excluded: perBotStats.filter((s) => !s.hasData).map((s) => s.label)
    };
  }, [perBotStats]);

  const reconWarnings = perBotStats.filter((s) => s.hasData && s.reconOff);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Navigation />
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="flex items-center gap-3 mb-6 flex-wrap">
          <Activity className="text-orange-400 w-6 h-6" />
          <h1 className="text-2xl font-bold">השוואת ביצועי הבוטים</h1>
          <span className="text-muted-foreground text-sm">({allTrades.length} עסקאות סגורות)</span>
          {archivedRunCount > 0 && (
            <label className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer ml-auto">
              <input
                type="checkbox"
                checked={includeHistory}
                onChange={(e) => setIncludeHistory(e.target.checked)}
              />
              כלול היסטוריית ריצות ({archivedRunCount} ריצות מאורכבות)
            </label>
          )}
        </div>

        {!baseUrl && (
          <Card className="bg-yellow-950/40 border-yellow-700 mb-6">
            <CardContent className="flex items-center gap-3 p-4">
              <AlertTriangle className="text-yellow-400 w-5 h-5 flex-shrink-0" />
              <p className="text-yellow-200 text-sm">
                כתובת Worker לא הוגדרה. חבר אותה בדף בוט הסימולציה כדי לראות עסקאות אמיתיות.
              </p>
            </CardContent>
          </Card>
        )}

        {/* Reconciliation guard — fires when equity−base and realized+unrealized
            disagree by more than 1% of capital. That gap is what a wrong
            baseline (the old hardcoded $10,000) looks like. */}
        {reconWarnings.length > 0 && (
          <Card className="bg-red-950/40 border-red-700 mb-6">
            <CardContent className="flex items-start gap-3 p-4">
              <AlertTriangle className="text-red-400 w-5 h-5 flex-shrink-0 mt-0.5" />
              <div className="text-red-200 text-sm space-y-1">
                <p className="font-semibold">אי-התאמה בין שינוי ההון לרווח הממומש+הלא-ממומש:</p>
                {reconWarnings.map((s) => (
                  <p key={s.key} className="font-mono text-xs">
                    {s.label}: שינוי הון ${fmt(s.pnlTotalUsd)} · ממומש+לא-ממומש ${fmt(s.realizedPnl + s.unrealizedPnl)} · פער ${fmt(s.reconGap)}
                  </p>
                ))}
                <p className="text-xs text-red-300/80">
                  בדוק שההון ההתחלתי של הבוט (config.initialAmount) תואם ל-equity שהשרת מחזיר.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Per-bot equity summary */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          {perBotStats.map((s) => (
            <Card key={s.key} className="bg-card/60 border-border">
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-1">
                  <p className="font-semibold">{s.label}</p>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${s.running ? 'bg-green-900/50 text-green-300' : 'bg-muted text-muted-foreground'}`}>
                    {s.running ? 'פעיל' : 'מושהה'}
                  </span>
                </div>
                {!s.hasData ? (
                  <p className="text-sm text-muted-foreground py-3">אין נתוני שרת — הבוט רץ בשרת בלבד וה-Worker לא נגיש</p>
                ) : (
                  <>
                    <p className={`text-xl font-bold font-mono ${pnlColor(s.pnlTotalUsd)}`}>
                      {s.pnlTotalUsd >= 0 ? '+' : ''}${fmt(s.pnlTotalUsd)}
                      <span className="text-xs ml-1">({s.pnlTotalPct >= 0 ? '+' : ''}{fmt(s.pnlTotalPct, 1)}%)</span>
                    </p>
                    <div className="text-xs text-muted-foreground mt-1 font-mono">
                      הון בסיס ${fmt(s.base)} · שווי ${fmt(s.equity)}
                    </div>
                    <div className="text-xs text-muted-foreground font-mono">
                      ממומש <span className={pnlColor(s.realizedPnl)}>{s.realizedPnl >= 0 ? '+' : ''}${fmt(s.realizedPnl)}</span>
                      {' · '}לא-ממומש <span className={pnlColor(s.unrealizedPnl)}>{s.unrealizedPnl >= 0 ? '+' : ''}${fmt(s.unrealizedPnl)}</span>
                    </div>
                    <div className="text-xs text-muted-foreground font-mono">
                      {s.closedTrades} עסקאות · {s.closedTrades ? `${fmt(s.winRate, 1)}% הצלחה` : 'אין עסקאות'} · DD יומי {fmt(s.dailyDrawdownPercent, 1)}%
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-2 mb-4">
          {[
            { key: 'all' as const, label: `הכל (${allTrades.length})` },
            ...perBotStats.map((s) => ({ key: s.key, label: `${s.label} (${s.logRows})` }))
          ].map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setSelectedBot(key)}
              className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                selectedBot === key ? 'bg-orange-500 text-white' : 'bg-muted text-muted-foreground hover:bg-muted/70'
              }`}
            >
              {label}
            </button>
          ))}
          <div className="flex-1" />
          <div className="flex gap-2">
            <span className="text-muted-foreground text-sm self-center">מיון:</span>
            {[
              { key: 'time' as const, label: 'זמן' },
              { key: 'pnl' as const, label: 'רווח/הפסד' }
            ].map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setSortBy(key)}
                className={`px-3 py-1.5 rounded text-sm transition-colors ${
                  sortBy === key ? 'bg-slate-500 text-white' : 'bg-muted text-muted-foreground hover:bg-muted/70'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Active-filter stat strip */}
        {activeStats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            {[
              { label: 'עסקאות סגורות', value: `${activeStats.closedTrades}`, color: 'text-foreground' },
              { label: 'אחוז הצלחה', value: `${fmt(activeStats.winRate, 1)}%`, color: activeStats.winRate >= 50 ? 'text-green-400' : 'text-red-400' },
              { label: 'רווח ממומש', value: `${activeStats.realizedPnl >= 0 ? '+' : ''}$${fmt(activeStats.realizedPnl)}`, color: pnlColor(activeStats.realizedPnl) },
              { label: 'ממוצע לעסקה', value: `${activeStats.avgPnl >= 0 ? '+' : ''}$${fmt(activeStats.avgPnl)}`, color: pnlColor(activeStats.avgPnl) }
            ].map(({ label, value, color }) => (
              <Card key={label} className="bg-card/60 border-border">
                <CardContent className="p-3">
                  <p className="text-muted-foreground text-xs mb-1">{label}</p>
                  <p className={`text-lg font-bold font-mono ${color}`}>{value}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Trade log */}
        {allTrades.length === 0 ? (
          <Card className="bg-card/60 border-border">
            <CardContent className="py-16 text-center">
              <Activity className="w-12 h-12 text-muted-foreground/40 mx-auto mb-3" />
              <p className="text-muted-foreground">
                {baseUrl
                  ? 'אין עדיין עסקאות סגורות — הפעל את הבוטים בדף בוט הסימולציה והמתן.'
                  : 'הגדר כתובת Worker כדי לראות עסקאות.'}
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card className="bg-card/60 border-border overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
              <span className="text-xs text-muted-foreground">
                יומן עסקאות · <span className="tabular">{Math.min(sorted.length, 200)}</span> מתוך{' '}
                <span className="tabular">{sorted.length}</span>
              </span>
              <button
                type="button"
                onClick={() => setShowFullReasons((v) => !v)}
                aria-pressed={showFullReasons}
                className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                {showFullReasons
                  ? <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                  : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
                {showFullReasons ? 'כווץ סיבות' : 'הצג סיבות מלאות'}
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-muted-foreground text-right">
                    <th className="px-4 py-3 font-medium">זמן</th>
                    <th className="px-4 py-3 font-medium">בוט</th>
                    <th className="px-4 py-3 font-medium">סמל</th>
                    <th className="px-4 py-3 font-medium">סוג</th>
                    <th className="px-4 py-3 font-medium">כיוון</th>
                    <th className="px-4 py-3 font-medium">מחיר</th>
                    <th className="px-4 py-3 font-medium">PnL ($)</th>
                    <th className="px-4 py-3 font-medium">PnL (%)</th>
                    <th className="px-4 py-3 font-medium">סיבה</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.slice(0, 200).map((t, i) => {
                    const pnl = t.pnl ?? 0;
                    const pct = t.pnlPercent ?? 0;
                    const ts = new Date(t.at).toLocaleString('he-IL', {
                      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
                    });
                    const isBuy = t.side.includes('buy') || t.side.includes('long');
                    return (
                      <tr key={`${t.botKey}-${t.id}-${i}`} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-2.5 text-muted-foreground whitespace-nowrap">{ts}</td>
                        <td className="px-4 py-2.5">{t.bot}</td>
                        <td className="px-4 py-2.5 font-mono font-medium">{t.symbol}</td>
                        <td className="px-4 py-2.5">
                          <span className={`text-xs px-2 py-0.5 rounded ${t.type === 'FUTURES' ? 'bg-purple-900/50 text-purple-300' : 'bg-blue-900/50 text-blue-300'}`}>
                            {t.type}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <span className={`flex items-center gap-1 ${isBuy ? 'text-green-400' : 'text-red-400'}`}>
                            {isBuy ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                            {t.side}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 font-mono">${fmt(t.price, t.price < 1 ? 6 : 2)}</td>
                        <td className={`px-4 py-2.5 font-mono font-medium ${pnlColor(pnl)}`}>{pnl >= 0 ? '+' : ''}${fmt(pnl)}</td>
                        <td className={`px-4 py-2.5 font-mono ${pnlColor(pct)}`}>{pct >= 0 ? '+' : ''}{fmt(pct)}%</td>
                        <td className="px-4 py-2.5 text-xs text-muted-foreground">
                          {(() => {
                            const key = `${t.botKey}-${t.id}-${i}`;
                            const open = showFullReasons || expandedReasons.has(key);
                            return (
                              <button
                                type="button"
                                onClick={() => setExpandedReasons((prev) => {
                                  const next = new Set(prev);
                                  next.has(key) ? next.delete(key) : next.add(key);
                                  return next;
                                })}
                                aria-expanded={open}
                                title={open ? undefined : t.reason}
                                className={[
                                  'w-full cursor-pointer rounded text-right transition-colors hover:text-foreground',
                                  open ? 'whitespace-pre-wrap break-words' : 'block max-w-[220px] truncate',
                                ].join(' ')}
                              >
                                {t.reason}
                              </button>
                            );
                          })()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {/* Summary table */}
        {allTrades.length > 0 && (
          <div className="mt-6">
            <h2 className="text-lg font-semibold mb-1">השוואה בין הבוטים</h2>
            <p className="text-xs text-muted-foreground mb-3">
              "שינוי הון (MtM)" = equity − הון בסיס (כולל לא-ממומש ועלויות). "רווח ממומש" = עסקאות סגורות בלבד.
              כל בוט נמדד מול ההון ההתחלתי שלו.
            </p>
            <Card className="bg-card/60 border-border overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground text-right">
                      <th className="px-4 py-3 font-medium">בוט</th>
                      <th className="px-4 py-3 font-medium">הון בסיס</th>
                      <th className="px-4 py-3 font-medium">שינוי הון (MtM)</th>
                      <th className="px-4 py-3 font-medium">לא ממומש</th>
                      <th className="px-4 py-3 font-medium">רווח ממומש</th>
                      <th className="px-4 py-3 font-medium">עסקאות</th>
                      <th className="px-4 py-3 font-medium">הצלחות</th>
                      <th className="px-4 py-3 font-medium">הפסדים</th>
                      <th className="px-4 py-3 font-medium">תיקו</th>
                      <th className="px-4 py-3 font-medium">Win Rate</th>
                      <th className="px-4 py-3 font-medium">ממוצע/עסקה</th>
                      <th className="px-4 py-3 font-medium">הכי טוב</th>
                      <th className="px-4 py-3 font-medium">הכי רע</th>
                    </tr>
                  </thead>
                  <tbody>
                    {perBotStats.map((s) => (
                      <tr key={s.key} className="border-b border-border/50">
                        <td className="px-4 py-3 font-medium">
                          {s.label}
                          {s.reconOff && <AlertTriangle className="inline w-3.5 h-3.5 text-red-400 mr-1" />}
                        </td>
                        {!s.hasData ? (
                          <td className="px-4 py-3 text-muted-foreground" colSpan={12}>אין נתוני שרת</td>
                        ) : (
                          <>
                            <td className="px-4 py-3 font-mono text-muted-foreground">${fmt(s.base)}</td>
                            <td className={`px-4 py-3 font-mono font-medium ${pnlColor(s.pnlTotalUsd)}`}>
                              {s.pnlTotalUsd >= 0 ? '+' : ''}${fmt(s.pnlTotalUsd)} ({s.pnlTotalPct >= 0 ? '+' : ''}{fmt(s.pnlTotalPct, 1)}%)
                            </td>
                            <td className={`px-4 py-3 font-mono ${pnlColor(s.unrealizedPnl)}`}>
                              {s.unrealizedPnl >= 0 ? '+' : ''}${fmt(s.unrealizedPnl)}
                            </td>
                            <td className={`px-4 py-3 font-mono ${pnlColor(s.realizedPnl)}`}>
                              {s.logRows ? `${s.realizedPnl >= 0 ? '+' : ''}$${fmt(s.realizedPnl)}` : '—'}
                            </td>
                            <td className="px-4 py-3">{s.closedTrades}</td>
                            <td className="px-4 py-3 text-green-400">{s.wins}</td>
                            <td className="px-4 py-3 text-red-400">{s.losses}</td>
                            <td className="px-4 py-3 text-muted-foreground">{s.breakeven || '—'}</td>
                            <td className={`px-4 py-3 font-medium ${s.winRate >= 50 ? 'text-green-400' : 'text-red-400'}`}>
                              {s.closedTrades ? `${fmt(s.winRate, 1)}%` : '—'}
                            </td>
                            <td className={`px-4 py-3 font-mono ${pnlColor(s.avgPnl)}`}>
                              {s.logRows ? `${s.avgPnl >= 0 ? '+' : ''}$${fmt(s.avgPnl)}` : '—'}
                            </td>
                            <td className="px-4 py-3 font-mono text-green-400">{s.logRows ? `+$${fmt(s.bestTrade)}` : '—'}</td>
                            <td className="px-4 py-3 font-mono text-red-400">{s.logRows ? `$${fmt(s.worstTrade)}` : '—'}</td>
                          </>
                        )}
                      </tr>
                    ))}
                    <tr className="border-t-2 border-border font-semibold">
                      <td className="px-4 py-3">סה"כ</td>
                      <td className="px-4 py-3 font-mono text-muted-foreground">${fmt(combined.base)}</td>
                      <td className={`px-4 py-3 font-mono ${pnlColor(combined.pnlUsd)}`}>
                        {combined.pnlUsd >= 0 ? '+' : ''}${fmt(combined.pnlUsd)} ({combined.pnlPct >= 0 ? '+' : ''}{fmt(combined.pnlPct, 1)}%)
                      </td>
                      <td className={`px-4 py-3 font-mono ${pnlColor(combined.unrealized)}`}>
                        {combined.unrealized >= 0 ? '+' : ''}${fmt(combined.unrealized)}
                      </td>
                      <td className={`px-4 py-3 font-mono ${pnlColor(combined.realized)}`}>
                        {combined.closed ? `${combined.realized >= 0 ? '+' : ''}$${fmt(combined.realized)}` : '—'}
                      </td>
                      <td className="px-4 py-3">{combined.closed}</td>
                      <td className="px-4 py-3" colSpan={3} />
                      <td className={`px-4 py-3 ${combined.winRate >= 50 ? 'text-green-400' : 'text-red-400'}`}>
                        {combined.closed ? `${fmt(combined.winRate, 1)}%` : '—'}
                      </td>
                      <td className="px-4 py-3" colSpan={3} />
                    </tr>
                  </tbody>
                </table>
              </div>
              {combined.excluded.length > 0 && (
                <p className="px-4 py-2 text-xs text-muted-foreground border-t border-border/50">
                  לא נכלל בסה"כ (אין נתוני שרת): {combined.excluded.join(', ')}
                </p>
              )}
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
