import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Area, AreaChart, ResponsiveContainer, Tooltip, YAxis } from 'recharts';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { useMemo, useState } from 'react';
import ProfitScale from './ProfitScale';
import { summarizeLogicalTrades } from '@cde/engine/execution';

interface Metric {
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'positive' | 'negative';
}

type TimeRange = '1D' | '7D' | '30D';

interface HistoryPoint {
  timestamp: string;
  portfolio: number;
  at?: number;
}

interface TradeLike {
  at: number;
  pnl?: number;
  pnlPercent?: number;
  side: string;
  /** SimPosition.id — needed for logical-trade win-rate grouping
   *  (summarizeLogicalTrades). Absent on data recorded before 2026-09-18;
   *  that data just aggregates one row per logical trade, same as before. */
  positionId?: string;
}

interface Props {
  trades?: TradeLike[];
  equity: number;
  invested: number;
  cash: number;
  positionsValue: number;
  /** Minute-resolution buffer — only ~48 min of ticks (720 points). */
  history: HistoryPoint[];
  /** Hourly-resolution history, up to 30 days. Required for the 1D/7D/30D views
   *  to anchor on the right point; without it every range collapsed to the
   *  ~48-min `history` window and "יומי" was really "last 48 minutes". */
  hourlyHistory?: HistoryPoint[];
  metrics: Metric[];
  statusLabel: string;
  statusTone: 'running' | 'paused' | 'idle';
}

const RANGE_MS: Record<TimeRange, number> = {
  '1D': 24 * 60 * 60 * 1000,
  '7D': 7 * 24 * 60 * 60 * 1000,
  '30D': 30 * 24 * 60 * 60 * 1000,
};

const RANGE_LABEL: Record<TimeRange, string> = {
  '1D': 'יומי',
  '7D': 'שבועי',
  '30D': 'חודשי',
};

const toneClass = (tone?: Metric['tone']) =>
  tone === 'positive' ? 'text-green-400' : tone === 'negative' ? 'text-red-400' : 'text-primary';

const PortfolioPulseCard = ({
  trades = [],
  equity,
  invested,
  cash,
  positionsValue,
  history,
  hourlyHistory = [],
  metrics,
  statusLabel,
  statusTone,
}: Props) => {
  const [range, setRange] = useState<TimeRange>('1D');

  // One timeline: hourly points (span days) + the minute buffer (recent ~48
  // min), sorted by `at`, de-duped. `history` alone never reaches back more
  // than ~48 min, so without the hourly points every range button showed the
  // same 48-minute window and "יומי" was a 48-minute figure wearing a daily
  // label.
  const mergedHistory = useMemo(() => {
    const byAt = new Map<number, HistoryPoint>();
    for (const h of hourlyHistory) if ((h.at ?? 0) > 0) byAt.set(h.at as number, h);
    for (const h of history) if ((h.at ?? 0) > 0) byAt.set(h.at as number, h); // minute point wins a tie
    return [...byAt.values()].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  }, [history, hourlyHistory]);

  const filteredHistory = useMemo(() => {
    const cutoff = Date.now() - RANGE_MS[range];
    const inRange = mergedHistory.filter((h) => (h.at ?? 0) >= cutoff);
    // Run younger than the window → anchor on the earliest point we have (≈ run
    // start), so a 2-hour-old run's "יומי" reads from ~$10,000, matching P&L.
    if (inRange.length >= 2) return inRange;
    if (mergedHistory.length >= 2) return mergedHistory;
    return history;
  }, [mergedHistory, history, range]);

  const rangeStats = useMemo(() => {
    if (filteredHistory.length < 2) return null;
    const start = filteredHistory[0].portfolio;
    const end = filteredHistory[filteredHistory.length - 1].portfolio;
    const change = end - start;
    const changePercent = start ? (change / start) * 100 : 0;
    return { start, end, change, changePercent };
  }, [filteredHistory]);

  /** מדדי ביצוע לטווח הנבחר: רווח/הפסד, אחוז הצלחה ו-Max Drawdown */
  const rangeMetrics = useMemo(() => {
    const cutoff = Date.now() - RANGE_MS[range];
    const closed = trades.filter(
      (t) => typeof t.pnl === 'number' && (t.at ?? 0) >= cutoff
    );
    // 2026-09-18: logical-trade win rate within this window (grouped by
    // positionId) — a TP1 partial followed by a break-even loss on the same
    // position no longer counts as one win AND one loss. A leg from outside
    // the window is not visible here, so a position whose partial fired
    // before `cutoff` and whose close fires after it is scored on the close
    // leg alone — an inherent windowing approximation, not a regression from
    // the old per-row count.
    const logicalStats = summarizeLogicalTrades(closed);
    const wins = logicalStats.wins;
    const winRate = logicalStats.winRate;
    const realized = closed.reduce((s, t) => s + (t.pnl as number), 0);

    let peak = -Infinity;
    let maxDd = 0;
    let maxDdPercent = 0;
    for (const point of filteredHistory) {
      if (point.portfolio > peak) peak = point.portfolio;
      const dd = peak - point.portfolio;
      if (dd > maxDd) {
        maxDd = dd;
        maxDdPercent = peak ? (dd / peak) * 100 : 0;
      }
    }
    // `closed` here is the logical-trade denominator (matches `wins`), not
    // the raw exit-event row count — see the comment above.
    return { closed: logicalStats.closedLogicalTradeCount, wins, winRate, realized, maxDd, maxDdPercent };
  }, [trades, range, filteredHistory]);

  const pnl = equity - invested;
  const pnlPercent = invested ? (pnl / invested) * 100 : 0;
  const up = pnl >= 0;

  // Compute dynamic max loss / max profit from history for the ProfitScale range
  const { maxLoss, maxProfit } = useMemo(() => {
    if (!history || history.length === 0) return { maxLoss: 0, maxProfit: 0 };
    const values = history.map((h) => h.portfolio);
    const peak = Math.max(...values);
    const trough = Math.min(...values);
    return {
      maxLoss: Math.max(0, invested - trough),
      maxProfit: Math.max(0, peak - invested),
    };
  }, [history, invested]);

  const chartData = filteredHistory.length
    ? filteredHistory
    : [{ timestamp: '', portfolio: invested }, { timestamp: '', portfolio: equity }];

  return (
    <Card className="border-primary/30 bg-card/50 backdrop-blur overflow-hidden">
      <CardContent className="p-0">
        {/* Top: value + P&L + sparkline */}
        <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-4 p-4 sm:p-6">
          <div className="text-right">
            <div className="flex items-center gap-2 mb-1">
              <span
                className={`w-2 h-2 rounded-full ${
                  statusTone === 'running'
                    ? 'bg-green-500 animate-pulse'
                    : statusTone === 'paused'
                    ? 'bg-yellow-500'
                    : 'bg-muted-foreground'
                }`}
              />
              <span className="text-xs font-mono text-muted-foreground">{statusLabel}</span>
            </div>
            <div className="text-xs text-muted-foreground font-mono">שווי תיק כולל</div>
            <div className="text-3xl sm:text-4xl font-bold text-primary font-mono leading-tight">
              ${equity.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </div>
            <div className={`flex items-center gap-1 mt-1 font-mono text-sm ${up ? 'text-green-400' : 'text-red-400'}`}>
              {up ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
              {up ? '+' : ''}
              {pnl.toFixed(2)}$ ({pnlPercent.toFixed(2)}%)
              <span className="text-muted-foreground">P&amp;L</span>
            </div>
            {rangeStats && (
               <div className={`text-xs font-mono mt-1 ${rangeStats.change >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                 {RANGE_LABEL[range]}: {rangeStats.change >= 0 ? '+' : ''}{rangeStats.changePercent.toFixed(2)}%
                 <span className="text-muted-foreground mr-1">({rangeStats.change >= 0 ? '+' : ''}${rangeStats.change.toFixed(2)})</span>
               </div>
             )}
             <div className="flex gap-4 mt-3 text-xs font-mono">
               <span className="text-muted-foreground">
                 מזומן <span className="text-primary">${cash.toFixed(2)}</span>
               </span>
               <span className="text-muted-foreground">
                 פוזיציות <span className="text-primary">${positionsValue.toFixed(2)}</span>
               </span>
             </div>

             {/* Dynamic profit scale — visualizes P&L relative to invested capital */}
             <div className="mt-3 pt-2 border-t border-border/20">
               <ProfitScale
                 equity={equity}
                 invested={invested}
                 maxLoss={maxLoss}
                 maxProfit={maxProfit}
               />
             </div>
           </div>

          <div className="-mx-2">
            <div className="flex items-center justify-start px-2 mb-1 gap-1">
              {(['1D', '7D', '30D'] as TimeRange[]).map((r) => (
                <Button
                  key={r}
                  variant={range === r ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setRange(r)}
                  className="h-6 px-2 text-[10px] font-mono py-0"
                >
                  {r}
                </Button>
              ))}
            </div>
            <div className="h-20 sm:h-24 px-2">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
                <defs>
                  <linearGradient id="pnlFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={up ? '#22c55e' : '#ef4444'} stopOpacity={0.45} />
                    <stop offset="100%" stopColor={up ? '#22c55e' : '#ef4444'} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <YAxis hide domain={['dataMin', 'dataMax']} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--primary) / 0.3)',
                    borderRadius: '8px',
                    fontFamily: 'monospace',
                    fontSize: '12px',
                  }}
                  formatter={(v: number) => [`$${v.toFixed(2)}`, 'שווי תיק']}
                  labelFormatter={(label) => `זמן: ${label}`}
                />
                <Area
                  type="monotone"
                  dataKey="portfolio"
                  stroke={up ? '#22c55e' : '#ef4444'}
                  strokeWidth={2}
                  fill="url(#pnlFill)"
                  dot={false}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
            </div>
          </div>
        </div>

        {/* מדדי ביצוע לפי הטווח הנבחר */}
        <div className="grid grid-cols-2 sm:grid-cols-4 border-t border-primary/20 divide-x divide-primary/10 rtl:divide-x-reverse bg-background/30">
          <div className="p-3 text-right">
            <div className="text-[11px] text-muted-foreground font-mono">רווח/הפסד לתקופה</div>
            <div
              className={`text-base font-bold font-mono ${
                (rangeStats?.change ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'
              }`}
            >
              {(rangeStats?.change ?? 0) >= 0 ? '+' : ''}${(rangeStats?.change ?? 0).toFixed(2)}
            </div>
            <div className="text-[10px] text-muted-foreground font-mono">
              {(rangeStats?.changePercent ?? 0) >= 0 ? '+' : ''}
              {(rangeStats?.changePercent ?? 0).toFixed(2)}% • {RANGE_LABEL[range]}
            </div>
          </div>
          <div className="p-3 text-right">
            <div className="text-[11px] text-muted-foreground font-mono">רווח ממומש</div>
            <div
              className={`text-base font-bold font-mono ${
                rangeMetrics.realized >= 0 ? 'text-green-400' : 'text-red-400'
              }`}
            >
              {rangeMetrics.realized >= 0 ? '+' : ''}${rangeMetrics.realized.toFixed(2)}
            </div>
            <div className="text-[10px] text-muted-foreground font-mono">
              {rangeMetrics.closed} עסקאות סגורות
            </div>
          </div>
          <div className="p-3 text-right">
            <div className="text-[11px] text-muted-foreground font-mono">אחוז הצלחה</div>
            <div className="text-base font-bold font-mono text-primary">
              {rangeMetrics.closed ? `${rangeMetrics.winRate.toFixed(2)}%` : '—'}
            </div>
            <div className="text-[10px] text-muted-foreground font-mono">
              {rangeMetrics.wins}/{rangeMetrics.closed} מנצחות
            </div>
          </div>
          <div className="p-3 text-right">
            <div className="text-[11px] text-muted-foreground font-mono">Max Drawdown</div>
            <div className="text-base font-bold font-mono text-red-400">
              -{rangeMetrics.maxDdPercent.toFixed(2)}%
            </div>
            <div className="text-[10px] text-muted-foreground font-mono">
              -${rangeMetrics.maxDd.toFixed(2)} מהשיא
            </div>
          </div>
        </div>

        {/* Bottom: compact metric strip */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 border-t border-primary/20 divide-x divide-primary/10 rtl:divide-x-reverse">
          {metrics.map((m) => (
            <div key={m.label} className="p-3 text-right">
              <div className="text-[11px] text-muted-foreground font-mono">{m.label}</div>
              <div className={`text-base font-bold font-mono ${toneClass(m.tone)}`}>{m.value}</div>
              {m.hint && <div className="text-[10px] text-muted-foreground font-mono truncate">{m.hint}</div>}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
};

export default PortfolioPulseCard;
