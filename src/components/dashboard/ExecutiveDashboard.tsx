import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Wallet,
  Bot,
  Activity,
  RefreshCw,
  Zap,
  TrendingUp,
  ShieldCheck,
  Play,
  Pause,
  ExternalLink,
  ChevronRight,
  Flame,
  CheckCircle2,
  AlertTriangle
} from 'lucide-react';
import { createTradingApiClient } from '@/services/tradingApiClient';
import type { WorkerAccountSummary, WorkerBotState } from '@/services/tradingApiClient';
import { useSimulationBotContextSafe } from '@/contexts/SimulationBotContext';
import { useProSimulationBotContextSafe } from '@/contexts/ProSimulationBotContext';
import { usePathSimulationBotContextSafe, PATH_SIM_BOT_LAST_KNOWN_RUNNING_KEY } from '@/contexts/PathSimulationBotContext';
import { useBybitSimulationBotContextSafe, BYBIT_SIM_BOT_LAST_KNOWN_RUNNING_KEY } from '@/contexts/BybitSimulationBotContext';
import type { SimPosition, SimTrade } from '@/hooks/useSimulationBot';
import { useWorkerAuth } from '@/contexts/WorkerAuthContext';
import { summarizeSimBot } from '@/lib/simBotSummary';
import { ratchetLevels as summarizeRatchet } from '@cde/engine/analysis';
import { summarizeLogicalTrades } from '@cde/engine/execution';
import { useApiPolling } from '@/hooks/useApiPolling';


/** The four simulation bots, in the order the simulation page shows them.
 *  `accent` keeps each bot the same colour across the whole app. */
interface SimBotCardMeta {
  id: 'intraday' | 'pro' | 'path' | 'bybit';
  title: string;
  subtitle: string;
  footer: string;
  accent: { icon: string; badge: string; stat: string };
}

const SIM_BOT_CARDS: SimBotCardMeta[] = [
  {
    id: 'intraday',
    title: 'מנוע חדש · Multi-Timeframe',
    subtitle: 'Setup + Entry מבניים על 1H/15M/5M',
    footer: 'מנוע 4-Layer Decision Engine',
    accent: {
      icon: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
      badge: 'text-blue-400 border-blue-500/30',
      stat: 'text-blue-400'
    }
  },
  {
    id: 'pro',
    title: 'בוט פרו · alg.md',
    subtitle: 'ציון משוקלל של 8 אינדיקטורים',
    footer: 'בוט פרו · alg.md',
    accent: {
      icon: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
      badge: 'text-amber-400 border-amber-500/30',
      stat: 'text-amber-400'
    }
  },
  {
    id: 'path',
    title: 'נתיב 4H · טווח נר קודם',
    subtitle: 'פריצת טווח ארבע השעות הקודמות',
    footer: 'Prev-4H Range',
    accent: {
      icon: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
      badge: 'text-violet-400 border-violet-500/30',
      stat: 'text-violet-400'
    }
  },
  {
    id: 'bybit',
    title: 'Bybit · TrendBreakout',
    subtitle: 'פריצת Donchian ב-M15 עם אישור ווליום',
    footer: 'TrendBreakout · סימולציה בלבד',
    // Cyan, not emerald: green is reserved for profit. A bot whose identity
    // colour is green reads as "this bot is up" before you look at a number.
    accent: {
      icon: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',
      badge: 'text-cyan-400 border-cyan-500/30',
      stat: 'text-cyan-400'
    }
  }
];

interface SimBotCardState {
  equity: number;
  cash: number;
  initialAmount: number;
  positionsCount: number;
  totalTrades: number;
  winRate: number;
  totalProfit: number;
  isRunning: boolean;
}

const usd0 = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

function SimBotCard({ meta, state }: { meta: SimBotCardMeta; state: SimBotCardState | null }) {
  const profit = state?.totalProfit ?? 0;
  const up = profit >= 0;
  // Percent against the bot's OWN starting capital — the operator sets that per
  // bot, so a shared denominator would misreport three of the four.
  const profitPct = state && state.initialAmount > 0 ? (profit / state.initialAmount) * 100 : 0;

  // Status as {dot, text} rather than an emoji prefix: emoji render at a
  // different size and baseline per platform, and carry no accessible name.
  const status = !state
    ? { tone: 'idle' as const, text: 'ממתין לנתונים' }
    : state.isRunning
      ? {
          tone: 'live' as const,
          text: state.positionsCount > 0 ? `${state.positionsCount} פוזיציות פעילות` : 'פועל — ממתין לאותות'
        }
      : {
          tone: 'paused' as const,
          text: state.positionsCount > 0 ? `מושהה • ${state.positionsCount} פוזיציות` : 'מושהה'
        };

  const dotClass = status.tone === 'live'
    ? 'bg-profit live-dot'
    : status.tone === 'paused' ? 'bg-warning' : 'bg-neutral';

  return (
    // flex column + mt-auto below: titles wrap to different line counts across
    // the four bots, and without this the metric rows sit at different heights
    // and the row reads as misaligned.
    <Card className="glass-card flex h-full flex-col border-0">
      <CardHeader className="space-y-2.5 pb-3">
        <div className="flex items-start gap-2.5">
          <div className={`p-2 rounded-lg border shrink-0 ${meta.accent.icon}`}>
            <Bot className="w-5 h-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            {/* No truncate: at four cards across, every title was clipped
                mid-word ("TrendBreakout …"). Wrapping costs one line and
                keeps the bot identifiable. */}
            <CardTitle className="font-display text-[15px] font-bold leading-snug">
              {meta.title}
            </CardTitle>
            <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{meta.subtitle}</p>
          </div>
        </div>
        <Badge
          variant="outline"
          className={`w-fit gap-1.5 text-[10px] font-medium ${meta.accent.badge}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} aria-hidden="true" />
          {status.text}
        </Badge>
      </CardHeader>
      <CardContent className="mt-auto space-y-4">
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg border border-border/40 bg-background/50 p-2.5">
            {/* Equity, not cash: cash alone drops by the full size of every open
                position and reads as a catastrophic loss on a flat bot. */}
            <div className="text-[11px] leading-tight text-muted-foreground">שווי תיק</div>
            <div className="tabular mt-1 text-lg font-bold text-foreground">
              {state ? usd0(state.equity) : '—'}
            </div>
            {state && state.positionsCount > 0 && (
              <div className="mt-0.5 text-[10px] text-muted-foreground">
                <span className="tabular">{usd0(state.cash)}</span> מזומן
              </div>
            )}
          </div>
          <div className="rounded-lg border border-border/40 bg-background/50 p-2.5">
            <div className="text-[11px] leading-tight text-muted-foreground">סך רווח / הפסד</div>
            <div className={`tabular mt-1 text-lg font-bold ${up ? 'text-profit' : 'text-loss'}`}>
              {state ? `${up ? '+' : '-'}${usd0(Math.abs(profit))}` : '—'}
            </div>
            {state && (
              <div className={`tabular mt-0.5 text-[10px] ${up ? 'text-profit/75' : 'text-loss/75'}`}>
                {up ? '+' : ''}{profitPct.toFixed(2)}%
              </div>
            )}
          </div>
          <div className="rounded-lg border border-border/40 bg-background/50 p-2.5">
            <div className="text-[11px] leading-tight text-muted-foreground">אחוז הצלחה</div>
            <div className={`tabular mt-1 text-lg font-bold ${meta.accent.stat}`}>
              {state ? `${state.winRate.toFixed(1)}%` : '—'}
            </div>
            {state && (
              <div className="mt-0.5 text-[10px] text-muted-foreground">
                <span className="tabular">{state.totalTrades}</span> עסקאות
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border/40 pt-2">
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <Activity className={`w-3.5 h-3.5 shrink-0 ${meta.accent.stat}`} aria-hidden="true" />
            <span className="truncate">{meta.footer}</span>
          </div>
          <Link to="/simulation-bot" className="shrink-0">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 cursor-pointer gap-1 px-2 text-xs text-primary hover:text-primary"
            >
              כניסה
              <ChevronRight className="w-3.5 h-3.5 rotate-180" aria-hidden="true" />
            </Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

export const ExecutiveDashboard: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [hasApiConfig, setHasApiConfig] = useState(false);
  const [workerSummary, setWorkerSummary] = useState<WorkerAccountSummary | null>(null);
  const [workerState, setWorkerState] = useState<WorkerBotState | null>(null);
  const [workerHealth, setWorkerHealth] = useState<Record<string, unknown> | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  // Simulation Bot State — live from the global provider (runs continuously so
  // the dashboard reflects real-time data). Falls back to the last persisted
  // snapshot in localStorage when the provider is unavailable.
  const sim = useSimulationBotContextSafe();
  const pro = useProSimulationBotContextSafe();
  const path = usePathSimulationBotContextSafe();
  const bybit = useBybitSimulationBotContextSafe();

  /** The shared shape of all four sim-bot contexts, narrowed to what this
   *  dashboard reads. All four expose equity/positionsValue/initialAmount. */
  interface SimSource {
    cash?: number;
    /** Cash + mark-to-market value of open positions. The number the cards
     *  show — `cash` alone is only the uninvested remainder. */
    equity?: number;
    positionsValue?: number;
    /** Authoritative capital the run opened with, from the server snapshot. */
    initialAmount?: number;
    positions?: SimPosition[];
    trades?: SimTrade[];
    config?: { initialAmount?: number };
    isRunning?: boolean;
    winRate?: number;
  }

  const deriveSimState = (source: SimSource | null, fallbackKey: string | null, fallbackStatusKey: string) => {
    const mapPosition = (p: SimPosition) => {
      const notional = p.notionalUsd || p.quantity * p.currentPrice || 0;
      const isLong = p.side === 'LONG' || p.side === 'BUY';
      const pnl = isLong
        ? ((p.currentPrice - p.entryPrice) / p.entryPrice) * 100 * (p.leverage || 1)
        : ((p.entryPrice - p.currentPrice) / p.entryPrice) * 100 * (p.leverage || 1);
      // The profit ratchet (2026-09-14), not takeProfit1, is what actually
      // closes this position — every sim bot runs it. See the identical fix
      // in LivePositionChart.tsx / SimulationEngineColumn.tsx.
      const ratchet = summarizeRatchet({
        entryPrice: p.entryPrice,
        peakPrice: (isLong ? p.highestPrice : p.lowestPrice) ?? p.entryPrice,
        livePrice: p.currentPrice,
        isLong,
        peakPctAtLastPartial: p.ratchetPeakPct,
        remainingQuantityFraction: p.quantity / (p.initialQuantity ?? p.quantity)
      });
      return {
        symbol: p.symbol,
        side: p.side,
        entryPrice: p.entryPrice,
        currentPrice: p.currentPrice,
        pnlPercent: pnl,
        leverage: p.leverage || 1,
        ratchetPrice: ratchet.armedSellPrice ?? ratchet.nextRungPrice,
        ratchetIsArmed: ratchet.armedSellPrice != null,
        ratchetIsFullClose: ratchet.armedIsFullClose,
        stopLoss: p.stopLoss
      };
    };

    if (source) {
      // Use native context values so the home page matches the simulation bot page exactly.
      //
      // EQUITY, not cash (fixed 2026-09-14). Both numbers below used to read
      // `source.cash`, which is only the UNINVESTED remainder: a bot holding
      // $5,024 of open positions showed a $4,976 "balance" and a −$5,024
      // "profit/loss" while it was actually flat. Equity = cash + the
      // mark-to-market value of open positions, which is what the simulation
      // page itself displays.
      return {
        ...summarizeSimBot({
          cash: source.cash,
          equity: source.equity,
          positionsValue: source.positionsValue,
          initialAmount: source.initialAmount,
          config: source.config,
          positionsCount: source.positions?.length,
          totalTrades: source.trades?.length,
          winRate: source.winRate,
          isRunning: source.isRunning
        }),
        activePositions: (source.positions || []).map(mapPosition)
      };
    }
    // Fallback: read last snapshot persisted by the simulation bot hook.
    if (!fallbackKey) return null;
    try {
      const raw = localStorage.getItem(fallbackKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const initial = 10000;
      const positions = (parsed.positions || []) as SimPosition[];
      const trades = (parsed.trades || []) as SimTrade[];
      let currentVal = parsed.cash ?? initial;
      const activeMapped = positions.map(mapPosition);
      positions.forEach((p) => {
        const notional = p.notionalUsd || p.quantity * p.currentPrice || 0;
        const pnl = p.side === 'LONG' || p.side === 'BUY'
          ? ((p.currentPrice - p.entryPrice) / p.entryPrice) * 100 * (p.leverage || 1)
          : ((p.entryPrice - p.currentPrice) / p.entryPrice) * 100 * (p.leverage || 1);
        currentVal += (p.marginUsd || notional) + (p.marginUsd || notional) * (pnl / 100);
      });
      // 2026-09-18: logical-trade win rate (grouped by positionId), not one
      // row per exit event — same fix as the live path's source.winRate
      // above (which already comes pre-aggregated from useSimulationBot.ts).
      const winRate = summarizeLogicalTrades(trades).winRate;
      const totalProfit = currentVal - initial;
      const status = localStorage.getItem(fallbackStatusKey);
      // `currentVal` already carries cash + marked-to-market positions, which is
      // exactly equity — the live branch above is the one that used to disagree.
      return {
        ...summarizeSimBot({
          cash: parsed.cash ?? initial,
          equity: currentVal,
          initialAmount: initial,
          positionsCount: positions.length,
          totalTrades: trades.length,
          winRate,
          isRunning: status === 'running'
        }),
        activePositions: activeMapped
      };
    } catch {
      return null;
    }
  };

  const simState = deriveSimState(sim, 'simulation-bot-state-v2', 'sim-bot-last-known-running');
  const proState = deriveSimState(pro, 'pro-simulation-bot-state-v1', 'pro-sim-bot-last-known-running');
  // Path and Bybit are server-read only — unlike Intraday/Pro they never
  // persist a state snapshot to localStorage (just the running flag), so there
  // is no fallback key to give them. With no provider they simply render "—".
  const pathState = deriveSimState(path, null, PATH_SIM_BOT_LAST_KNOWN_RUNNING_KEY);
  const bybitState = deriveSimState(bybit, null, BYBIT_SIM_BOT_LAST_KNOWN_RUNNING_KEY);

  const botStates: Record<SimBotCardMeta['id'], SimBotCardState | null> = {
    intraday: simState,
    pro: proState,
    path: pathState,
    bybit: bybitState
  };

  // Shared with RealTradingBot.tsx via context (lives above the router, so it
  // survives in-app navigation) — BOT_ADMIN_TOKEN is memory-only, never in
  // localStorage. Entering it on the Real Trading Bot page is what makes the
  // real account summary / bot state show up here too.
  const { baseUrl: workerUrl, adminToken } = useWorkerAuth();

  const fetchWorkerData = useCallback(async () => {
    const worker = createTradingApiClient(workerUrl, adminToken);

    if (!workerUrl) {
      setHasApiConfig(false);
      setApiError('כתובת ה-Worker (VITE_TRADING_API_URL) לא הוגדרה. הגדר אותה במשתני בנייה של Netlify.');
      return;
    }

    setHasApiConfig(true);
    setLoading(true);
    setApiError(null);

    try {
      const health = await worker.getHealth();
      setWorkerHealth(health);
      setLastUpdated(new Date().toLocaleTimeString('he-IL'));

      if (!adminToken) {
        setWorkerSummary(null);
        setWorkerState(null);
        return;
      }
      const [summary, state] = await Promise.all([worker.getAccountSummary(), worker.getState()]);
      setWorkerSummary(summary);
      setWorkerState(state);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'שגיאת התחברות ל-Worker';
      console.error('[Worker] fetchWorkerData error:', errMsg);
      setApiError(`שגיאת Worker: ${errMsg}`);
    } finally {
      setLoading(false);
    }
  }, [workerUrl, adminToken]);

  // Poll with exponential backoff on 429s / network errors.
  const { syncStatus, syncError, refresh: refreshWorkerData } = useApiPolling<null>(
    async () => {
      await fetchWorkerData();
      return null;
    },
    { baseInterval: 15000, maxInterval: 60000 }
  );

  return (
    <div className="space-y-6 mb-8">
      {/* 1. Real Bybit Live Account Hub */}
      <Card className="border-primary/40 bg-gradient-to-br from-card via-card/95 to-primary/5 shadow-xl shadow-primary/5 relative overflow-hidden">
        <div className="absolute top-0 right-0 left-0 h-1 bg-gradient-to-r from-primary via-emerald-500 to-primary" />
        
        <CardHeader className="pb-3 flex flex-row items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-primary/10 border border-primary/20 text-primary">
              <Wallet className="w-6 h-6" />
            </div>
            <div>
              <CardTitle className="text-xl font-bold flex items-center gap-2 font-mono">
                מרכז פיקוד Bybit Live
                {hasApiConfig && (
                  <Badge variant={workerState?.testnet ? "secondary" : "default"} className="font-mono text-xs">
                    {workerState?.testnet ? "🟡 Testnet" : "🟢 Mainnet Live"}
                  </Badge>
                )}
              </CardTitle>
              <p className="text-xs text-muted-foreground font-mono">
                נתוני ארנק וחשבון Bybit בזמן אמת {lastUpdated && `• עודכן לאחרונה: ${lastUpdated}`}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                fetchWorkerData();
              }}
              disabled={loading}
              className="font-mono text-xs gap-1.5 h-8"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              רענן נתונים
            </Button>
            <Link to="/real-trading">
              <Button size="sm" className="font-mono text-xs gap-1.5 h-8">
                <Zap className="w-3.5 h-3.5" />
                בוט Bybit Live
              </Button>
            </Link>
          </div>
        </CardHeader>

        <CardContent>
          {hasApiConfig ? (
            <div className="space-y-4">
              {/* Metrics Grid */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {/* Total Equity */}
                <div className="p-3.5 rounded-xl bg-background/80 border border-border/60">
                  <div className="text-xs text-muted-foreground font-mono mb-1">שווי חשבון כולל (Total Equity)</div>
                  <div className="text-2xl font-bold font-mono text-foreground">
                    ${workerSummary?.totalUsdt.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) ?? '0.00'}
                  </div>
                  <div className="text-[11px] text-muted-foreground font-mono mt-0.5">
                    סך הון פעיל
                  </div>
                </div>

                {/* Available USDT */}
                <div className="p-3.5 rounded-xl bg-background/80 border border-border/60">
                  <div className="text-xs text-muted-foreground font-mono mb-1">יתרת USDT זמינה (Available)</div>
                  <div className="text-2xl font-bold font-mono text-emerald-400">
                    ${workerSummary?.availableUsdt.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) ?? '0.00'}
                  </div>
                  <div className="text-[11px] text-muted-foreground font-mono mt-0.5">
                    USDT זמין למסחר
                  </div>
                </div>

                {/* Open Futures */}
                <div className="p-3.5 rounded-xl bg-background/80 border border-border/60">
                  <div className="text-xs text-muted-foreground font-mono mb-1">פוזיציות פתוחות (Open Futures)</div>
                  <div className="text-2xl font-bold font-mono text-primary">
                    {workerSummary?.openFuturesCount ?? 0}
                  </div>
                  <div className="text-[11px] text-muted-foreground font-mono mt-0.5">
                    פוזיציות פעילות
                  </div>
                </div>

                {/* Connection / Health */}
                <div className="p-3.5 rounded-xl bg-background/80 border border-border/60">
                  <div className="text-xs text-muted-foreground font-mono mb-1">סטטוס חיבור (Worker)</div>
                  <div className="text-2xl font-bold font-mono flex items-center gap-1.5">
                    {workerHealth ? (
                      <CheckCircle2 className="w-6 h-6 text-emerald-400" />
                    ) : (
                      <AlertTriangle className="w-6 h-6 text-red-400" />
                    )}
                  </div>
                  <div className="text-[11px] text-muted-foreground font-mono mt-0.5">
                    {workerHealth ? 'מחובר' : 'מנותק'}
                  </div>
                </div>
              </div>

              {/* Positions Breakdown */}
              {workerSummary && workerSummary.positions.length > 0 && (
                <div className="pt-2 border-t border-border/40">
                  <div className="text-xs font-mono text-muted-foreground mb-2">פוזיציות פתוחות בחשבון:</div>
                  <div className="flex flex-wrap gap-2">
                    {workerSummary.positions.map((p) => (
                      <Badge key={p.symbol} variant="outline" className="font-mono text-xs py-1 px-2.5 bg-background/60">
                        <span className="font-bold text-primary mr-1">{p.symbol}:</span>
                        <span>{p.side}</span>
                        {p.leverage > 1 && <span className="ml-1">{p.leverage}x</span>}
                        <span className="text-muted-foreground ml-1.5">({p.size})</span>
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {apiError && (
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-400 font-mono flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                  {apiError}
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-6 bg-background/40 rounded-xl border border-dashed border-border/80">
              <ShieldCheck className="w-10 h-10 text-primary mx-auto mb-2 opacity-80" />
              <h4 className="text-base font-semibold font-mono mb-1">הגדרת חיבור Bybit API</h4>
              <p className="text-xs text-muted-foreground font-mono max-w-md mx-auto mb-4">
                הגדר את כתובת ה-Worker (VITE_TRADING_API_URL) ואת ה-BOT_ADMIN_TOKEN כדי לצפות ביתרות הארנק, פוזיציות ומצב הבוט בזמן אמת דרך ה-Render Worker.
              </p>
              <Link to="/real-trading">
                <Button size="sm" className="font-mono text-xs gap-1.5">
                  <Zap className="w-3.5 h-3.5" />
                  הגדר Bybit API עכשיו
                </Button>
              </Link>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 2. Simulation Bots Grid — all FOUR engines.
          Was two hand-written cards (Intraday + Pro) that drifted from each
          other and left Path and Bybit off the home page entirely; now one
          card component rendered from SIM_BOT_CARDS. */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
        {SIM_BOT_CARDS.map((meta) => (
          <SimBotCard key={meta.id} meta={meta} state={botStates[meta.id]} />
        ))}
      </div>
      {/* 3. Live Active Positions Radar (if any positions open) */}
      {simState && simState.activePositions.length > 0 && (
        <Card className="border-border/60 bg-card">
          <CardHeader className="pb-3 flex flex-row items-center justify-between">
            <div className="flex items-center gap-2">
              <Flame className="w-5 h-5 text-amber-400" />
              <CardTitle className="text-base font-bold font-mono">
                פוזיציות פתוחות בזמן אמת ({simState.activePositions.length})
              </CardTitle>
            </div>
            <Link to="/simulation-bot">
              <Button variant="outline" size="sm" className="font-mono text-xs h-7">
                צפה בכל הפוזיציות
              </Button>
            </Link>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {simState.activePositions.map((p) => (
                <div key={p.symbol} className="p-3 rounded-lg bg-background/80 border border-border/50 font-mono text-xs space-y-1.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <span className="font-bold text-sm text-foreground">{p.symbol}</span>
                      <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${
                        p.side === 'LONG' || p.side === 'BUY' ? 'text-emerald-400 border-emerald-500/30' : 'text-red-400 border-red-500/30'
                      }`}>
                        {p.side} {p.leverage > 1 ? `${p.leverage}x` : ''}
                      </Badge>
                    </div>
                    <div className={`font-bold ${p.pnlPercent >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {p.pnlPercent >= 0 ? '+' : ''}{p.pnlPercent.toFixed(2)}%
                    </div>
                  </div>
                  <div className="flex justify-between text-muted-foreground text-[11px]">
                    <span>כניסה: ${p.entryPrice < 1 ? p.entryPrice.toFixed(4) : p.entryPrice.toFixed(2)}</span>
                    <span>נוכחי: ${p.currentPrice < 1 ? p.currentPrice.toFixed(4) : p.currentPrice.toFixed(2)}</span>
                  </div>
                  {(p.ratchetPrice || p.stopLoss) && (
                    <div className="flex justify-between text-[10px] text-muted-foreground/80 pt-1 border-t border-border/30">
                      <span className={p.ratchetIsArmed ? 'text-amber-400/90' : ''}>
                        {p.ratchetIsArmed ? (p.ratchetIsFullClose ? 'סגירה' : 'מימוש 30%') : 'מדרגה הבאה'}: $
                        {p.ratchetPrice ? (p.ratchetPrice < 1 ? p.ratchetPrice.toFixed(4) : p.ratchetPrice.toFixed(2)) : '-'}
                      </span>
                      <span>SL: ${p.stopLoss ? (p.stopLoss < 1 ? p.stopLoss.toFixed(4) : p.stopLoss.toFixed(2)) : '-'}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
};


