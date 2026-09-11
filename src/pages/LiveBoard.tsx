// Public, read-only results board — the one page that can be shared with
// anyone.
//
// Deliberately isolated from the rest of the app:
//   · no Navigation shell, no WorkerAuthContext, no sim-bot contexts. It reads
//     ONE endpoint (`/api/public/bots-summary`) that takes no parameters and
//     touches no state, so there is no control on this page that could change
//     anything even by accident.
//   · every number arrives already derived from the worker. The page formats;
//     it does not compute. A board that did its own arithmetic is exactly how
//     BacktestResults once reported a flat −90% for four bots that were fine.
//   · each bot is measured against ITS OWN starting capital, because the
//     operator sets that per bot.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, ArrowDownRight, ArrowUpRight, ChevronDown, Coins,
  Layers, RefreshCw, ShieldCheck, Timer, TrendingDown, TrendingUp, WifiOff
} from 'lucide-react';
import {
  getPublicBotsSummary,
  type PublicBotSummary,
  type PublicBotTrade
} from '../services/tradingApiClient';

const POLL_MS = 10_000;

const usd = (n: number | undefined, digits = 2) =>
  typeof n === 'number' && Number.isFinite(n)
    ? `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
    : '—';

const pct = (n: number | undefined, digits = 2) =>
  typeof n === 'number' && Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%` : '—';

const price = (n: number | undefined) => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
};

const clock = (at: number | undefined) =>
  typeof at === 'number' && at > 0
    ? new Date(at).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' })
    : '—';

const SIDE_LABEL: Record<string, string> = {
  buy: 'קנייה', long: 'לונג', short: 'שורט',
  close_long: 'סגירת לונג', close_short: 'סגירת שורט', partial_tp1: 'יציאה חלקית'
};

/** Accent per bot, so a reader tracks one column by colour across the page. */
const ACCENT: Record<string, { ring: string; text: string; glow: string; dot: string }> = {
  intraday: { ring: 'ring-sky-400/30',    text: 'text-sky-300',    glow: 'from-sky-500/20',    dot: 'bg-sky-400' },
  pro:      { ring: 'ring-violet-400/30', text: 'text-violet-300', glow: 'from-violet-500/20', dot: 'bg-violet-400' },
  path:     { ring: 'ring-amber-400/30',  text: 'text-amber-300',  glow: 'from-amber-500/20',  dot: 'bg-amber-400' },
  bybit:    { ring: 'ring-emerald-400/30',text: 'text-emerald-300',glow: 'from-emerald-500/20',dot: 'bg-emerald-400' }
};
const accentOf = (id: string) => ACCENT[id] ?? ACCENT.intraday;

/** The worker returns whatever nickname the operator typed into the bot config
 *  ("חדש", "פרו") — meaningless to a visitor. The board shows the strategy's
 *  real name instead, and keeps the operator's nickname only as a fallback for
 *  a bot id this map does not know. */
const STRATEGY: Record<string, { name: string; blurb: string }> = {
  intraday: { name: 'Multi-Timeframe', blurb: 'מגמה ב-H1, כניסה בתיקון על M5/M15' },
  pro:      { name: 'Pro · אוסצילטורים', blurb: 'הצבעת RSI/MACD/Stoch/BB עם משקל קורלציה' },
  path:     { name: 'Prev-4H Range',     blurb: 'פריצת טווח ארבע השעות הקודמות' },
  bybit:    { name: 'TrendBreakout',     blurb: 'פריצת Donchian ב-M15 עם אישור ווליום' }
};
const strategyOf = (bot: PublicBotSummary) =>
  STRATEGY[bot.id] ?? { name: bot.label, blurb: '' };

function Stat({ label, value, tone = 'neutral', hint }: {
  label: string; value: string; tone?: 'up' | 'down' | 'neutral'; hint?: string;
}) {
  const toneClass = tone === 'up' ? 'text-emerald-300' : tone === 'down' ? 'text-rose-300' : 'text-slate-100';
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-[0.14em] text-slate-500">{label}</span>
      <span className={`text-lg font-semibold tabular-nums ${toneClass}`}>{value}</span>
      {hint && <span className="text-[11px] text-slate-500">{hint}</span>}
    </div>
  );
}

function TradeTable({ trades }: { trades: PublicBotTrade[] }) {
  if (trades.length === 0) {
    return <p className="py-8 text-center text-sm text-slate-500">עדיין אין עסקאות בריצה הזו.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-right text-sm">
        <thead>
          <tr className="border-b border-white/10 text-[11px] uppercase tracking-[0.12em] text-slate-500">
            <th className="py-2 pl-3 font-medium">שעה</th>
            <th className="py-2 font-medium">סמל</th>
            <th className="py-2 font-medium">פעולה</th>
            <th className="py-2 font-medium">מחיר</th>
            <th className="py-2 font-medium">שווי</th>
            <th className="py-2 font-medium">רווח/הפסד</th>
            <th className="py-2 pr-3 font-medium">סיבה</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => {
            const hasPnl = typeof t.pnl === 'number';
            const up = hasPnl && (t.pnl as number) >= 0;
            return (
              <tr key={t.id} className="border-b border-white/5 transition-colors hover:bg-white/[0.03]">
                <td className="py-2.5 pl-3 tabular-nums text-slate-400">{t.timestamp}</td>
                <td className="py-2.5 font-medium text-slate-200">{t.symbol}</td>
                <td className="py-2.5">
                  <span className="rounded-md bg-white/5 px-2 py-0.5 text-xs text-slate-300">
                    {SIDE_LABEL[t.side] ?? t.side}
                  </span>
                </td>
                <td className="py-2.5 tabular-nums text-slate-300">{price(t.price)}</td>
                <td className="py-2.5 tabular-nums text-slate-400">{usd(t.usdValue)}</td>
                <td className={`py-2.5 tabular-nums font-medium ${hasPnl ? (up ? 'text-emerald-300' : 'text-rose-300') : 'text-slate-600'}`}>
                  {hasPnl ? `${up ? '+' : ''}${(t.pnl as number).toFixed(2)}` : '—'}
                  {hasPnl && typeof t.pnlPercent === 'number' && (
                    <span className="mr-1 text-[11px] opacity-70">({pct(t.pnlPercent)})</span>
                  )}
                </td>
                <td className="max-w-[280px] truncate py-2.5 pr-3 text-xs text-slate-500" title={t.reason}>
                  {t.reason || '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function BotCard({ bot, expanded, onToggle }: {
  bot: PublicBotSummary; expanded: boolean; onToggle: () => void;
}) {
  const accent = accentOf(bot.id);
  const strategy = strategyOf(bot);
  const up = (bot.pnl ?? 0) >= 0;

  if (!bot.hasData) {
    return (
      <div className="rounded-2xl border border-white/10 bg-slate-900/40 p-6">
        <div className="flex items-center gap-2 text-slate-300">
          <WifiOff className="h-4 w-4" />
          <h3 className="font-semibold">{strategy.name}</h3>
        </div>
        <p className="mt-3 text-sm text-slate-500">אין נתוני שרת עדיין.</p>
      </div>
    );
  }

  return (
    <div className={`group relative overflow-hidden rounded-2xl border border-white/10 bg-slate-900/50 ring-1 ${accent.ring} backdrop-blur transition-all duration-300 hover:border-white/20`}>
      <div className={`pointer-events-none absolute inset-x-0 -top-24 h-48 bg-gradient-to-b ${accent.glow} to-transparent opacity-60`} />

      <button
        onClick={onToggle}
        className="relative w-full cursor-pointer p-6 text-right"
        aria-expanded={expanded}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <span className={`h-2 w-2 rounded-full ${bot.running ? `${accent.dot} animate-pulse` : 'bg-slate-600'}`} />
            <div>
              <h3 className={`text-base font-semibold ${accent.text}`}>{strategy.name}</h3>
              {strategy.blurb && (
                <p className="mt-0.5 text-[11px] leading-relaxed text-slate-400">{strategy.blurb}</p>
              )}
              <p className="mt-0.5 text-[11px] text-slate-500">
                {bot.running ? 'פעיל' : 'מושהה'} · הון התחלתי {usd(bot.initialAmount, 0)}
              </p>
            </div>
          </div>
          <ChevronDown className={`h-4 w-4 shrink-0 text-slate-500 transition-transform duration-300 ${expanded ? 'rotate-180' : ''}`} />
        </div>

        <div className="mt-6 flex items-baseline gap-3">
          <span className={`text-4xl font-bold tabular-nums tracking-tight ${up ? 'text-emerald-300' : 'text-rose-300'}`}>
            {pct(bot.pnlPercent)}
          </span>
          <span className={`flex items-center gap-1 text-sm font-medium tabular-nums ${up ? 'text-emerald-400/80' : 'text-rose-400/80'}`}>
            {up ? <ArrowUpRight className="h-4 w-4" /> : <ArrowDownRight className="h-4 w-4" />}
            {usd(bot.pnl)}
          </span>
        </div>
        <p className="mt-1 text-xs text-slate-500">שווי תיק {usd(bot.equity)}</p>

        <div className="mt-6 grid grid-cols-3 gap-4 border-t border-white/5 pt-5">
          <Stat label="נפתחו" value={String(bot.positionsOpened ?? 0)} hint={`${bot.openPositions ?? 0} פתוחות כעת`} />
          <Stat label="נסגרו" value={String(bot.positionsClosed ?? 0)} hint={`${bot.wins ?? 0}W · ${bot.losses ?? 0}L`} />
          <Stat
            label="אחוז הצלחה"
            value={typeof bot.winRate === 'number' && (bot.positionsClosed ?? 0) > 0 ? `${bot.winRate.toFixed(0)}%` : '—'}
          />
        </div>
      </button>

      {expanded && (
        <div className="relative border-t border-white/10 bg-slate-950/40 px-6 py-5">
          <div className="mb-5 grid grid-cols-2 gap-5 sm:grid-cols-4">
            <Stat label="רווח ממומש" value={usd(bot.realizedPnl)} tone={(bot.realizedPnl ?? 0) >= 0 ? 'up' : 'down'} />
            <Stat label="לא ממומש" value={usd(bot.unrealizedPnl)} tone={(bot.unrealizedPnl ?? 0) >= 0 ? 'up' : 'down'} />
            <Stat label="עמלות" value={usd(bot.totalFees)} />
            <Stat label="מזומן פנוי" value={usd(bot.cash)} />
          </div>

          {(bot.openPositionsDetail?.length ?? 0) > 0 && (
            <div className="mb-5">
              <h4 className="mb-2 flex items-center gap-1.5 text-xs uppercase tracking-[0.14em] text-slate-500">
                <Layers className="h-3.5 w-3.5" /> פוזיציות פתוחות
              </h4>
              <div className="flex flex-wrap gap-2">
                {bot.openPositionsDetail!.map((pos) => {
                  const live = pos.currentPrice || pos.entryPrice;
                  const isLong = pos.side === 'LONG' || pos.side === 'BUY';
                  const move = pos.entryPrice > 0
                    ? ((live - pos.entryPrice) / pos.entryPrice) * 100 * (isLong ? 1 : -1)
                    : 0;
                  return (
                    <div key={`${pos.symbol}-${pos.openTimestamp}`} className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-slate-200">{pos.symbol}</span>
                        <span className={`text-xs font-medium tabular-nums ${move >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                          {pct(move)}
                        </span>
                        {pos.tp1Hit && (
                          <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300">TP1 ✓</span>
                        )}
                      </div>
                      <p className="mt-0.5 text-[11px] tabular-nums text-slate-500">
                        {price(pos.entryPrice)} → {price(live)} · {usd(pos.notionalUsd, 0)}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <h4 className="mb-2 flex items-center gap-1.5 text-xs uppercase tracking-[0.14em] text-slate-500">
            <Activity className="h-3.5 w-3.5" /> יומן עסקאות
          </h4>
          <TradeTable trades={bot.trades ?? []} />
        </div>
      )}
    </div>
  );
}

export default function LiveBoard() {
  const [bots, setBots] = useState<PublicBotSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastAt, setLastAt] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await getPublicBotsSummary();
      setBots(data.bots);
      setLastAt(data.serverTime);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'שגיאה בטעינת הנתונים');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const totals = useMemo(() => {
    const live = bots.filter((b) => b.hasData);
    const base = live.reduce((s, b) => s + (b.initialAmount ?? 0), 0);
    const equity = live.reduce((s, b) => s + (b.equity ?? 0), 0);
    return {
      base,
      equity,
      pnl: equity - base,
      pnlPercent: base > 0 ? ((equity - base) / base) * 100 : 0,
      opened: live.reduce((s, b) => s + (b.positionsOpened ?? 0), 0),
      closed: live.reduce((s, b) => s + (b.positionsClosed ?? 0), 0),
      open: live.reduce((s, b) => s + (b.openPositions ?? 0), 0),
      running: live.filter((b) => b.running).length
    };
  }, [bots]);

  const up = totals.pnl >= 0;

  return (
    <div dir="rtl" className="min-h-screen bg-[#070b14] text-slate-100 antialiased">
      {/* Ambient wash — one soft light source, not a gradient party. */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-40 right-1/4 h-[32rem] w-[32rem] rounded-full bg-sky-500/[0.07] blur-[120px]" />
        <div className="absolute -bottom-40 left-1/4 h-[32rem] w-[32rem] rounded-full bg-violet-500/[0.06] blur-[120px]" />
      </div>

      <div className="relative mx-auto max-w-6xl px-5 py-10 sm:px-8 sm:py-14">
        <header className="mb-10">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.24em] text-slate-500">
                <ShieldCheck className="h-3.5 w-3.5" />
                סימולציה בלבד · צפייה בלבד
              </div>
              <h1 className="mt-2 bg-gradient-to-l from-white via-slate-200 to-slate-400 bg-clip-text text-3xl font-bold tracking-tight text-transparent sm:text-4xl">
                לוח תוצאות הבוטים
              </h1>
              <p className="mt-2 max-w-xl text-sm leading-relaxed text-slate-500">
                ארבע אסטרטגיות מסחר עצמאיות רצות במקביל על אותם נתוני שוק חיים.
                כל בוט נמדד מול ההון ההתחלתי שלו עצמו. לחיצה על כרטיס פותחת את יומן העסקאות המלא.
              </p>
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span className="tabular-nums">עודכן {clock(lastAt ?? undefined)}</span>
            </div>
          </div>
        </header>

        {error && (
          <div className="mb-8 rounded-xl border border-rose-500/20 bg-rose-500/5 px-5 py-4 text-sm text-rose-300">
            {error}
          </div>
        )}

        {/* Portfolio-wide summary */}
        <section className="mb-10 overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-l from-white/[0.06] to-white/[0.02] p-7 backdrop-blur">
          <div className="grid gap-7 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <p className="text-[11px] uppercase tracking-[0.14em] text-slate-500">רווח/הפסד כולל</p>
              <p className={`mt-1.5 text-3xl font-bold tabular-nums ${up ? 'text-emerald-300' : 'text-rose-300'}`}>
                {pct(totals.pnlPercent)}
              </p>
              <p className={`mt-0.5 text-sm tabular-nums ${up ? 'text-emerald-400/70' : 'text-rose-400/70'}`}>
                {usd(totals.pnl)}
              </p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.14em] text-slate-500">שווי כולל</p>
              <p className="mt-1.5 text-3xl font-bold tabular-nums text-slate-100">{usd(totals.equity, 0)}</p>
              <p className="mt-0.5 text-sm text-slate-500">מתוך {usd(totals.base, 0)}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.14em] text-slate-500">פוזיציות</p>
              <p className="mt-1.5 text-3xl font-bold tabular-nums text-slate-100">{totals.opened}</p>
              <p className="mt-0.5 text-sm text-slate-500">{totals.closed} נסגרו · {totals.open} פתוחות</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.14em] text-slate-500">בוטים פעילים</p>
              <p className="mt-1.5 text-3xl font-bold tabular-nums text-slate-100">
                {totals.running}<span className="text-lg text-slate-600">/{bots.length}</span>
              </p>
              <p className="mt-0.5 flex items-center gap-1 text-sm text-slate-500">
                <Timer className="h-3.5 w-3.5" /> רענון כל {POLL_MS / 1000} שניות
              </p>
            </div>
          </div>
        </section>

        {loading && bots.length === 0 ? (
          <div className="grid gap-5 lg:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-64 animate-pulse rounded-2xl border border-white/5 bg-white/[0.02]" />
            ))}
          </div>
        ) : (
          <div className="grid gap-5 lg:grid-cols-2">
            {bots.map((bot) => (
              <BotCard
                key={bot.id}
                bot={bot}
                expanded={expanded === bot.id}
                onToggle={() => setExpanded(expanded === bot.id ? null : bot.id)}
              />
            ))}
          </div>
        )}

        <footer className="mt-14 flex items-center justify-center gap-2 border-t border-white/5 pt-8 text-center text-xs text-slate-600">
          <Coins className="h-3.5 w-3.5" />
          <span>
            כל הנתונים הם מסחר מדומה בלבד. אין כאן כסף אמיתי, ואין באמור המלצה או ייעוץ השקעות.
          </span>
        </footer>
      </div>
    </div>
  );
}
