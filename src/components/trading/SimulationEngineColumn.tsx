import { useState, useEffect, useMemo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Play, Pause, Square, Zap, Settings, ArrowDownCircle, ArrowUpCircle, ChevronDown, FileText } from 'lucide-react';
import PortfolioPulseCard from './PortfolioPulseCard';
import LivePositionChart from './LivePositionChart';
import type { CryptoData } from '@cde/engine';
import type { SimBotConfig, SimPosition, SimTrade, SimPoint, PendingOrder, SignalEvaluation, DecisionFactor } from '@/hooks/useSimulationBot';
import { tallyExitReasons } from '@/lib/botCsvExport';
import { ratchetLevels } from '@cde/engine/analysis';

const safeNumber = (value: unknown, fallback = 0): number => {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};

// Price formatter that keeps small-cap prices readable ($0.024790) without
// drowning majors in zeros ($64231.50).
const fmtUsd = (n: number): string => {
  const a = Math.abs(n);
  const dp = a >= 100 ? 2 : a >= 1 ? 4 : 6;
  return `$${n.toFixed(dp)}`;
};

const signedPct = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;

export interface EngineColumnProps {
  title: string;
  subtitle: string;
  /** Stable per-bot id for `data-testid` (e.g. 'intraday' | 'pro' | 'path' |
   *  'bybit') — the four columns are otherwise structurally identical, so
   *  nothing else distinguishes "this bot's start button" in the DOM. */
  testId: string;
  accentClass: string; // e.g. 'text-primary' or 'text-cyan-400' — column header + accent color
  /**
   * What "confidence" means for THIS engine's numbers.
   *
   * Intraday and Pro report a 0-100 weighted technical score; Path reports a
   * probability (a Wilson lower bound on a bucket's historical hit rate). The
   * two scales share a UI (this same 0-100 input, the same "ביטחון X%" badge)
   * but are not remotely the same thing — 33 is a strong probability edge for
   * a 1.5R target, 33 is a weak score. Defaults to 'score' so the two
   * existing engines render exactly as before; only Path passes 'probability'.
   */
  confidenceKind?: 'score' | 'probability';
  cryptoData?: CryptoData[];
  cash: number;
  positions: SimPosition[];
  positionsValue: number;
  equity: number;
  trades: SimTrade[];
  history: SimPoint[];
  /** Hourly-resolution history for the 1D/7D/30D range views — `history` alone
   *  only spans ~48 min. */
  hourlyHistory?: SimPoint[];
  pending: PendingOrder[];
  totalFees: number;
  totalSlippageCost: number;
  /** Cumulative perpetual funding on FUTURES positions (USD, positive = paid).
   *  Optional — spot-only bots and pre-funding snapshots leave it undefined. */
  totalFunding?: number;
  winRate: number;
  totalTrades: number;
  closedTrades: number;
  evaluations: SignalEvaluation[];
  hasSavedSession: boolean;
  nextTickAt: number;
  config: SimBotConfig;
  setConfig: (c: SimBotConfig) => void;
  status: 'running' | 'paused' | 'idle';
  isRunning: boolean;
  start: () => void;
  pause: () => void;
  resetAll: () => void;
}

// One self-contained engine column: control panel, capital/settings, live
// decision feed, pulse card, positions and trade log. Rendered twice side by
// side (new intraday engine vs. the original alg.md confidence-score engine)
// so both can be configured and watched independently for comparison.
export default function SimulationEngineColumn({
  title, subtitle, testId, accentClass, cryptoData,
  cash, positions, positionsValue, equity, trades, history, hourlyHistory = [], pending,
  totalFees, totalSlippageCost, totalFunding = 0, winRate, totalTrades, closedTrades,
  evaluations, hasSavedSession, nextTickAt, config: botConfig, setConfig: setBotConfig,
  status, isRunning, start, pause, resetAll, confidenceKind = 'score'
}: EngineColumnProps) {
  const isProbability = confidenceKind === 'probability';
  // Exit-reason buckets that actually occurred, worst-P&L first — the same
  // classifier the CSV export uses, so the panel and the file always agree.
  const exitBreakdown = useMemo(
    () => tallyExitReasons(trades).filter((r) => r.count > 0).sort((a, b) => a.pnl - b.pnl),
    [trades]
  );
  const [openLogs, setOpenLogs] = useState<string[]>([]);
  // null = no schedule known yet; 0 = the tick is overdue (server is still
  // working on it). Anything > 0 is a real number of seconds.
  const [countdown, setCountdown] = useState<number | null>(null);
  const [evalFilter, setEvalFilter] = useState('');
  const [evalSort, setEvalSort] = useState<'default' | 'confidence-desc' | 'confidence-asc'>('confidence-desc');

  useEffect(() => {
    if (!isRunning) {
      setCountdown(null);
      return;
    }
    const updateCountdown = () => {
      if (!nextTickAt) {
        setCountdown(null);
        return;
      }
      const remaining = nextTickAt - Date.now();
      // Two bugs lived on this line. `Math.min(5, …)` capped the display at 5s
      // even when the real wait was 20s, and the `: 1` fallback pinned it to
      // "1s" for as long as the tick was overdue — so the label sat frozen at
      // "טיק בעוד 1s" for ~90% of every cycle and the page looked hung.
      // Overdue is now reported as overdue.
      setCountdown(remaining > 0 ? Math.min(120, Math.ceil(remaining / 1000)) : 0);
    };
    updateCountdown();
    const id = setInterval(updateCountdown, 200);
    return () => clearInterval(id);
  }, [isRunning, nextTickAt]);

  const lastTrade = trades[0];
  const openFuturesCount = positions.filter((p) => p.type === 'FUTURES').length;

  const displayedEvaluations = useMemo(() => {
    const q = evalFilter.trim().toUpperCase();
    const filtered = q ? evaluations.filter((rec) => rec.symbol.toUpperCase().includes(q)) : evaluations;
    if (evalSort === 'default') return filtered;
    const sorted = [...filtered].sort((a, b) =>
      evalSort === 'confidence-desc' ? b.confidence - a.confidence : a.confidence - b.confidence
    );
    return sorted;
  }, [evaluations, evalFilter, evalSort]);

  // Visibility into WHY short-side setups are rare: SHORT only ever routes
  // through FUTURES, which only opens on a TRENDING+BEAR regime — this
  // count makes that market-condition reality checkable at a glance instead
  // of having to take it on faith or page through each symbol's own
  // decision-layer breakdown one at a time.
  // Uses type-safe comparison with MarketRegimeType (TRENDING/RANGING/TRANSITIONAL)
  const regimeCounts = evaluations.reduce(
    (acc, ev) => {
      const r = ev.regime;
      if (!r) { acc.noData++; return acc; }
      if (r.regime === 'TRENDING' && r.direction === 'BULL') acc.bullTrend++;
      else if (r.regime === 'TRENDING' && r.direction === 'BEAR') acc.bearTrend++;
      else if (r.regime === 'RANGING') acc.ranging++;
      else acc.transitional++;
      return acc;
    },
    { bullTrend: 0, bearTrend: 0, ranging: 0, transitional: 0, noData: 0 }
  );

  return (
    <div className="flex flex-col h-full space-y-4" data-testid={`sim-bot-column-${testId}`}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h2 className={`text-lg font-bold font-mono ${accentClass}`}>{title}</h2>
          <p className="text-xs text-muted-foreground font-mono">{subtitle}</p>
        </div>
        <div
          className={`w-3 h-3 rounded-full ${
            status === 'running' ? 'bg-green-500 animate-pulse' : status === 'paused' ? 'bg-yellow-500' : 'bg-gray-500'
          }`}
          title={status === 'running' ? 'פעיל' : status === 'paused' ? 'מושהה' : 'מושבת'}
        />
      </div>

      {/* Evaluations + Settings */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Dialog>
          <DialogTrigger asChild>
            {/* `DialogTrigger asChild` hands its props to this Card, which renders a
                plain <div> — so the trigger came out as role=null, tabIndex=-1 and an
                inert type="button". It could not be reached with Tab at all, and a
                screen reader was never told it was a control, leaving the decisions
                and settings mouse-only. Give the div the semantics the button lost. */}
            <Card
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  e.currentTarget.click();
                }
              }}
              className="border-border/40 bg-card/50 backdrop-blur cursor-pointer hover:border-primary/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <CardContent className="p-3.5 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Zap className={`w-5 h-5 shrink-0 ${accentClass}`} />
                  <div className="text-right min-w-0">
                    <div className="text-sm font-bold font-mono truncate">הערכות מנוע</div>
                    <div className="text-xs text-muted-foreground font-mono">{evaluations?.length || 0} נכסים</div>
                  </div>
                </div>
                <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
              </CardContent>
            </Card>
          </DialogTrigger>
          <DialogContent className="w-[95vw] max-w-4xl max-h-[85vh] overflow-y-auto overflow-x-hidden">
            <DialogHeader>
              <DialogTitle className={`flex items-center gap-2 font-mono ${accentClass}`}>
                <Zap className="w-5 h-5" />
                {title} — הערכות בזמן אמת ({evaluations?.length || 0})
              </DialogTitle>
              <DialogDescription className="sr-only">רשימת הערכות מנוע ההחלטות לכל מטבע</DialogDescription>
            </DialogHeader>
            {!!evaluations?.length && (
              <div className="flex items-center gap-2 flex-wrap text-[11px] font-mono text-muted-foreground border border-border/30 rounded-md px-2.5 py-1.5 bg-card/20">
                <span className="shrink-0">התפלגות משטר שוק כרגע:</span>
                <Badge variant="outline" className="text-green-400 border-green-400/30">↑ עולה {regimeCounts.bullTrend}</Badge>
                <Badge variant="outline" className="text-red-400 border-red-400/30">↓ יורד (SHORT זמין) {regimeCounts.bearTrend}</Badge>
                <Badge variant="outline" className="text-muted-foreground">דשדוש {regimeCounts.ranging}</Badge>
                <Badge variant="outline" className="text-muted-foreground">מעבר {regimeCounts.transitional}</Badge>
                {regimeCounts.bearTrend === 0 && (
                  <span className="text-[10px] w-full">
                    0 מגמות יורדות כרגע — SHORT דורש מגמה יורדת מובהקת (BEAR_TREND); ב-RANGING/דשדוש הבוט יכול רק Spot LONG (MEAN_REVERSION).
                  </span>
                )}
              </div>
            )}
            {!evaluations?.length ? (
              <div className="text-muted-foreground text-sm text-center py-4 font-mono">אין נתוני מטבעות זמינים</div>
            ) : (
              <div className="space-y-3 font-mono overflow-x-hidden">
                <div className="flex items-center gap-2 flex-wrap sticky top-0 bg-background/95 backdrop-blur z-10 pb-2">
                  <Input
                    value={evalFilter}
                    onChange={(e) => setEvalFilter(e.target.value)}
                    placeholder="סינון לפי סימבול..."
                    className="h-8 text-xs font-mono flex-1 min-w-[140px]"
                  />
                  <Select value={evalSort} onValueChange={(v) => setEvalSort(v as typeof evalSort)}>
                    <SelectTrigger className="h-8 text-xs font-mono w-[160px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="confidence-desc">ביטחון: גבוה → נמוך</SelectItem>
                      <SelectItem value="confidence-asc">ביטחון: נמוך → גבוה</SelectItem>
                      <SelectItem value="default">סדר סריקה (ברירת מחדל)</SelectItem>
                    </SelectContent>
                  </Select>
                  <span className="text-xs text-muted-foreground shrink-0">{displayedEvaluations.length}/{evaluations.length}</span>
                </div>
                {!displayedEvaluations.length && (
                  <div className="text-muted-foreground text-sm text-center py-4">אין תוצאות תואמות לסינון</div>
                )}
                {displayedEvaluations.map((rec) => {
                  const isFutures = rec.tradeType === 'FUTURES';
                  const isSpot = rec.tradeType === 'SPOT';
                  const open = openLogs.includes(rec.symbol);
                  const confidence = safeNumber(rec.confidence);
                  const price = safeNumber(rec.price);
                  const priceChange24h = safeNumber(rec.priceChange24h);
                  const factors = Array.isArray(rec.factors) ? rec.factors : [];

                  // The price the engine is working toward, plus its SL/TP ladder.
                  // A resting entry order (limit, or a delayed-market Pro entry) is
                  // the authoritative "waiting for this price" source; otherwise
                  // fall back to the levels computed on the evaluation itself
                  // (Pro: optimalEntryPrice + ATR ladder; the others: the plan on
                  // a SIGNAL). All are optional — the block hides when absent.
                  const entryOrder = pending.find(
                    (o) => o.symbol === rec.symbol && (o.side === 'buy' || o.side === 'long' || o.side === 'short')
                  );
                  const entryTarget = safeNumber(entryOrder?.signalPrice ?? rec.optimalEntryPrice ?? (rec.willExecute ? rec.price : 0)) || null;
                  const planSl = safeNumber(entryOrder?.stopLoss ?? rec.stopLoss ?? 0) || null;
                  // TP1/TP2 are NOT shown for a candidate entry, deliberately.
                  // The profit ratchet owns every profit exit in all four sim
                  // bots (Path/Bybit call evaluateRatchet unconditionally;
                  // Intraday via SIM_INTRADAY_PARAMS_OVERRIDE.profitRatchet,
                  // Pro via proSimExecution's { profitRatchet: true }), and the
                  // TP1/TP2 comparisons are either gated behind `!ratchet` or
                  // absent entirely. Those levels are carried on the order for
                  // reporting only — printing them as "the plan" advertised
                  // exits no code would ever take. The first ratchet rung is
                  // the level that actually governs, so that is what is shown.
                  const planIsLong = rec.tradeSide === 'LONG' || rec.tradeSide === 'BUY' || rec.action === 'buy';
                  const planFirstRung = entryTarget
                    ? safeNumber(ratchetLevels({
                        entryPrice: entryTarget,
                        peakPrice: entryTarget,
                        livePrice: entryTarget,
                        isLong: planIsLong
                      }).nextRungPrice) || null
                    : null;
                  const waitingForLimit = !!entryOrder && entryOrder.fill !== 'market';
                  const relPct = (target: number | null) =>
                    target && entryTarget ? ((target - entryTarget) / entryTarget) * 100 : null;
                  const gapFromMarketPct = entryTarget && price ? ((entryTarget - price) / price) * 100 : null;
                  const showPlan = Boolean(
                    (entryTarget || planSl || planFirstRung) &&
                    (entryOrder || rec.willExecute || rec.strategyDecision ||
                      /SIGNAL|ORDER_QUEUED|BELOW_THRESHOLD|DOWNTREND/.test(rec.status))
                  );

                  return (
                    <div key={rec.symbol} className="p-3.5 border border-border/40 rounded-lg bg-card/30 min-w-0 overflow-hidden break-words">
                      <div className="flex items-start justify-between gap-2 flex-wrap">
                        <div className="flex items-center gap-2 flex-wrap min-w-0">
                          <Badge className="font-mono">{rec.symbol}</Badge>
                          <Badge
                            variant="outline"
                            className={
                              isFutures
                                ? 'text-purple-400 border-purple-500/50 bg-purple-500/10'
                                : isSpot
                                ? 'text-cyan-400 border-cyan-500/50 bg-cyan-500/10'
                                : 'text-muted-foreground'
                            }
                          >
                            {isFutures ? `FUTURES ${rec.leverage}x ${rec.tradeSide}` : isSpot ? `SPOT ${rec.tradeSide}` : 'HOLD'}
                          </Badge>
                          <span className={`text-sm font-bold ${accentClass}`}>{isProbability ? 'הסתברות' : 'ביטחון'} {confidence.toFixed(1)}%</span>
                        </div>
                        <div className="text-sm text-muted-foreground shrink-0">
                          {fmtUsd(price)}{' '}
                          <span className={priceChange24h >= 0 ? 'text-green-400' : 'text-red-400'}>
                            ({priceChange24h >= 0 ? '+' : ''}{priceChange24h.toFixed(2)}%)
                          </span>
                        </div>
                        <Badge variant={rec.willExecute ? 'default' : 'secondary'} className="text-xs whitespace-normal break-all text-right max-w-full">{rec.status}</Badge>
                      </div>
                      <div className="text-xs text-muted-foreground mt-2 break-words">{rec.reasoning}</div>
                      {showPlan && (
                        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] border-t border-border/20 pt-2">
                          {entryTarget && (
                            <span className="text-foreground/90">
                              כניסה מתוכננת: <span className={`font-bold ${accentClass}`}>{fmtUsd(entryTarget)}</span>
                            </span>
                          )}
                          {waitingForLimit && gapFromMarketPct !== null && (
                            <span className="text-muted-foreground">
                              ⏳ ממתין לשער · שוק כעת {fmtUsd(price)} ({signedPct(gapFromMarketPct)} עד היעד)
                            </span>
                          )}
                          {planSl && (
                            <span className="text-red-400">
                              SL {fmtUsd(planSl)}{relPct(planSl) !== null ? ` (${signedPct(relPct(planSl)!)})` : ''}
                            </span>
                          )}
                          {planFirstRung && (
                            <span className="text-green-400">
                              מדרגת רווח ראשונה {fmtUsd(planFirstRung)}
                              {relPct(planFirstRung) !== null ? ` (${signedPct(relPct(planFirstRung)!)})` : ''}
                            </span>
                          )}
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => setOpenLogs((prev) => (prev.includes(rec.symbol) ? prev.filter((s) => s !== rec.symbol) : [...prev, rec.symbol]))}
                        className={`mt-2 flex items-center gap-1 text-xs cursor-pointer hover:underline ${accentClass}`}
                      >
                        <FileText className="w-3 h-3" />
                        פירוט שכבות החלטה ({factors.length})
                        <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
                      </button>
                      {open && (
                        <div className="mt-2 border-t border-border/30 pt-2 space-y-1.5 bg-background/40 p-2.5 rounded">
                          {/* Layer 0: Market Regime */}
                          {rec.regime && (
                            <div className="mb-2 p-2 border border-border/20 rounded bg-card/30">
                              <div className="text-[10px] font-semibold text-muted-foreground mb-1">שכבה 0 — משטר שוק</div>
                              <div className="flex items-center gap-2 flex-wrap text-[10px]">
                                 <Badge variant="outline" className={`text-[9px] ${rec.regime.regime === 'TRENDING' ? 'text-green-400 border-green-400/30' : rec.regime.regime === 'RANGING' ? 'text-yellow-400 border-yellow-400/30' : 'text-muted-foreground'}`}>
                                  {rec.regime.regime}
                                </Badge>
                                <span className="text-muted-foreground">
                                  כיוון: {rec.regime.direction === 'BULL' ? 'עולה ↑' : rec.regime.direction === 'BEAR' ? 'יורד ↓' : 'ניטרלי'}
                                </span>
                                <span className="text-muted-foreground">
                                  ADX: {rec.regime.adx?.toFixed(1) ?? 'N/A'}
                                </span>
                                <span className="text-muted-foreground">
                                  ATR%: {rec.regime.atrPercent?.toFixed(2) ?? 'N/A'}%
                                </span>
                                <span className="text-muted-foreground">
                                  תנודתיות: {rec.regime.volatility}
                                </span>
                              </div>
                            </div>
                          )}
                          {factors.map((f: DecisionFactor, i: number) => (
                            <div key={i} className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-0.5 sm:gap-2 text-xs py-1 border-b border-border/20 last:border-0">
                              <div className="flex items-center gap-2 flex-wrap min-w-0">
                                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${f.impact === 'positive' ? 'bg-green-400' : f.impact === 'negative' ? 'bg-red-400' : 'bg-muted-foreground'}`} />
                                <span className="font-semibold break-words">{f.label ?? 'N/A'}</span>
                                <span className="text-muted-foreground break-words min-w-0">{f.value ?? 'N/A'}</span>
                              </div>
                              <span className="text-muted-foreground sm:text-left break-words min-w-0 sm:max-w-[45%]">{f.note ?? ''}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </DialogContent>
        </Dialog>

        <Dialog>
          <DialogTrigger asChild>
            {/* `DialogTrigger asChild` hands its props to this Card, which renders a
                plain <div> — so the trigger came out as role=null, tabIndex=-1 and an
                inert type="button". It could not be reached with Tab at all, and a
                screen reader was never told it was a control, leaving the decisions
                and settings mouse-only. Give the div the semantics the button lost. */}
            <Card
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  e.currentTarget.click();
                }
              }}
              className="border-border/40 bg-card/50 backdrop-blur cursor-pointer hover:border-primary/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <CardContent className="p-3.5 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Settings className={`w-5 h-5 shrink-0 ${accentClass}`} />
                  <div className="text-right min-w-0">
                    <div className="text-sm font-bold font-mono truncate">הגדרות והון</div>
                    <div className="text-xs text-muted-foreground font-mono">${botConfig.initialAmount.toLocaleString()}</div>
                  </div>
                </div>
                <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
              </CardContent>
            </Card>
          </DialogTrigger>
          <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto font-mono">
            <DialogHeader>
              <DialogTitle className={`flex items-center gap-2 ${accentClass}`}>
                <Settings className="w-5 h-5" />
                {title} — הגדרות
              </DialogTitle>
              <DialogDescription className="sr-only">הגדרות פרופיל סיכון, הון התחלתי, עמלות והחלקה</DialogDescription>
            </DialogHeader>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm text-muted-foreground mb-2 block">
                  פרופיל סיכון — קובע כמה פוזיציות מקבילות (כל פוזיציה 10% מההון)
                </label>
                <Select value={botConfig.riskLevel} onValueChange={(value) => setBotConfig({ ...botConfig, riskLevel: value as SimBotConfig['riskLevel'] })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">נמוך (שמרני) — עד 3 פוזיציות</SelectItem>
                    <SelectItem value="medium">בינוני (מאוזן) — עד 5 פוזיציות</SelectItem>
                    <SelectItem value="high">גבוה (אגרסיבי) — עד 7 פוזיציות</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm text-muted-foreground mb-2 block">הון התחלתי ($) — נפרד לכל מנוע</label>
                <Input type="number" value={botConfig.initialAmount} onChange={(e) => setBotConfig({ ...botConfig, initialAmount: Number(e.target.value) })} />
              </div>
              <div>
                {/* Fixed, not operator-editable: this desk trades Bybit Spot only at
                    VIP 0 (0.10% taker fee), so the input that let an operator drift
                    this off the real fee schedule was removed 2026-09-16 — see
                    SIM_BASE_DEFAULTS.feePercent. */}
                <label className="text-sm text-muted-foreground mb-2 block">עמלת Spot Bybit (%)</label>
                <div className="h-10 flex items-center px-3 rounded-md border border-border/40 bg-muted/30 text-sm font-mono text-muted-foreground">
                  {botConfig.feePercent.toFixed(2)}% (Bybit Spot VIP 0 — קבוע)
                </div>
              </div>
              <div>
                {/* Fixed, not operator-editable — see SIM_BASE_DEFAULTS.slippagePercent. */}
                <label className="text-sm text-muted-foreground mb-2 block">החלקה בסיסית / Slippage (%)</label>
                <div className="h-10 flex items-center px-3 rounded-md border border-border/40 bg-muted/30 text-sm font-mono text-muted-foreground">
                  {botConfig.slippagePercent.toFixed(2)}% (קבוע)
                </div>
              </div>
              <div>
                <label className="text-sm text-muted-foreground mb-2 block">
                  {isProbability
                    ? 'סף הסתברות כניסה (%) — Wilson LB על שיעור ההצלחה ההיסטורי של הדלי, לא ציון טכני — הבוט קונה כשההסתברות עוברת אותו'
                    : 'סף ביטחון כניסה (%) — הבוט קונה כשהביטחון הכולל עובר אותו'}
                </label>
                <Input
                  type="number"
                  step="1"
                  min={0}
                  max={100}
                  value={botConfig.minConfidenceOverride ?? ''}
                  placeholder="אוטומטי — 70"
                  onChange={(e) => setBotConfig({ ...botConfig, minConfidenceOverride: e.target.value === '' ? 0 : Math.max(0, Math.min(100, Number(e.target.value))) })}
                />
              </div>
              {/* Bybit/TrendBreakout deliberately never reads this flag for entries
                  (trendBreakoutExecution.ts) — a resting limit BELOW market is
                  adverse selection for a breakout strategy (a break that runs
                  never fills; only a failing break does). Hidden here instead of
                  shown-but-lying, found 2026-09-16 when the panel's own "חל על
                  כל 4 הבוטים" claim was checked against the code and was false. */}
              {testId !== 'bybit' && (
                <div className="flex items-center gap-3 pt-6">
                  <input
                    id={`${title}-limit-entries`}
                    type="checkbox"
                    checked={botConfig.proLimitEntries === true}
                    onChange={(e) => setBotConfig({ ...botConfig, proLimitEntries: e.target.checked })}
                  />
                  <label htmlFor={`${title}-limit-entries`} className="text-sm text-muted-foreground cursor-pointer">
                    כניסה לפי שער (לימיט) — מסומן: הבוט ממתין שהשוק יגיע למחיר האות ורק אז קונה.
                    לא מסומן: כניסת MARKET מיידית במחיר החי.
                  </label>
                </div>
              )}
              <div className="flex items-center gap-3 pt-3">
                <input
                  id={`${title}-fear-boost`}
                  type="checkbox"
                  checked={botConfig.fearGreedSizeBoost === true}
                  onChange={(e) => setBotConfig({ ...botConfig, fearGreedSizeBoost: e.target.checked })}
                />
                <label htmlFor={`${title}-fear-boost`} className="text-sm text-muted-foreground cursor-pointer">
                  הגברת גודל בפחד שוק (20–35) — כשמדד הפחד בטווח הזה והבוט כבר החליט על קניית
                  MEAN_REVERSION, רצף הפסדים לא מקטין את הפוזיציה (חוזרת ל-~10% מ-equity, לא מעבר).
                  משפיע רק על "מנוע חדש".
                </label>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Control Panel */}
      <Card className="border-border/40 bg-card/50 backdrop-blur">
        <CardContent className="p-4 font-mono">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
            <span className="text-sm font-medium">
              {status === 'running' ? 'פעיל — סורק ומבצע' : status === 'paused' ? 'מושהה' : 'מושבת'}
              {isRunning && countdown !== null && (
                <span className={`mr-2 font-bold ${accentClass}`}>
                  {countdown > 0 ? `· טיק בעוד ${countdown}s` : '· מעבד טיק…'}
                </span>
              )}
            </span>
            <div className="flex gap-2 flex-wrap justify-center">
              <Button onClick={start} disabled={isRunning} size="sm" className="bg-green-600 hover:bg-green-700 cursor-pointer">
                <Play className="w-4 h-4 mr-1" />
                {status === 'paused' || hasSavedSession ? 'המשך' : 'התחל'}
              </Button>
              <Button onClick={pause} disabled={!isRunning} variant="outline" size="sm" className="cursor-pointer">
                <Pause className="w-4 h-4 mr-1" />
                השהה
              </Button>
              <Button onClick={resetAll} variant="destructive" size="sm" className="cursor-pointer">
                <Square className="w-4 h-4 mr-1" />
                איפוס
              </Button>
            </div>
          </div>
          {/* Why the bot is (not) buying — a one-line diagnosis of the live
              evaluation batch, so "high confidence but no entry" answers
              itself instead of needing log spelunking. */}
          {(() => {
            const books = evaluations.filter((ev) => ev.willExecute && ev.action === 'buy').length;
            const queued = evaluations.filter((ev) => ev.status.includes('ORDER_QUEUED')).length;
            const held = evaluations.filter((ev) => ev.status.includes('ALREADY_HELD')).length;
            const below = evaluations.filter((ev) => ev.status.includes('BELOW_THRESHOLD')).length;
            const noSlots = evaluations.filter((ev) => ev.status.includes('NO_SLOTS')).length;
            const noBudget = evaluations.filter((ev) => ev.status.includes('NO_BUDGET')).length;
            const waiting = evaluations.filter((ev) => ev.status.includes('NO_DIRECTION') || ev.action === 'hold').length;
            const reasons: string[] = [];
            if (queued) reasons.push(`🕐 ${queued} פקודות בתור`);
            if (held) reasons.push(`🔒 ${held} כבר מוחזק`);
            if (noSlots) reasons.push(`🎯 ${noSlots} אין סלוט פנוי`);
            if (noBudget) reasons.push(`💵 ${noBudget} אין תקציב`);
            if (below) reasons.push(`📉 ${below} מתחת לסף`);
            if (waiting) reasons.push(`⏳ ${waiting} ללא כיוון BUY חד`);
            return (
              <div className="mt-2 text-[11px] font-mono text-muted-foreground border-t border-border/30 pt-2">
                <span className="text-green-400">✅ {books} מוכן לקנייה</span>
                {reasons.length > 0 && <span> · {reasons.join(' · ')}</span>}
                {reasons.length === 0 && books === 0 && <span>· ממתין לאותות…</span>}
              </div>
            );
          })()}
        </CardContent>
      </Card>

      {/* Portfolio Pulse Card — grows to fill available space */}
      <div className="flex-1">
        <PortfolioPulseCard
          equity={equity}
          invested={botConfig.initialAmount}
          cash={cash}
          positionsValue={positionsValue}
          history={history}
          hourlyHistory={hourlyHistory}
          trades={trades}
          statusLabel={status === 'running' ? 'פעיל' : status === 'paused' ? 'מושהה' : 'מושבת'}
          statusTone={status}
          metrics={[
            { label: 'עסקאות', value: `${totalTrades}`, hint: `${closedTrades} נסגרו · ${winRate.toFixed(1)}%` },
            { label: 'פוזיציות', value: `${positions.length}/${botConfig.maxPositions ?? 7}`, hint: `${openFuturesCount} פיוצ'רס` },
            { label: 'עלויות', value: `-$${(totalFees + totalSlippageCost + Math.max(0, totalFunding)).toFixed(2)}`, tone: 'negative', hint: `עמלות $${totalFees.toFixed(2)}${totalFunding ? ` · פאנדינג ${totalFunding >= 0 ? '-' : '+'}$${Math.abs(totalFunding).toFixed(2)}` : ''}` },
            { label: 'אחרון', value: lastTrade ? `${lastTrade.side.toUpperCase()} ${lastTrade.symbol}` : '—', hint: lastTrade?.timestamp || 'אין' }
          ]}
        />
      </div>

      {/* Positions & Trades — pinned to the BOTTOM of the column (mt-auto) with a
          fixed-height inner scroll area, so a bot holding 12 positions is the
          same height as one holding none and the four columns stay aligned. */}
      <Card className="border-border/40 bg-card/50 backdrop-blur mt-auto">
        <CardContent className="p-3">
          <Tabs defaultValue="positions">
            <TabsList className="grid grid-cols-2 w-full mb-3">
              <TabsTrigger value="positions" className="font-mono text-xs">פוזיציות ({positions.length})</TabsTrigger>
              <TabsTrigger value="trades" className="font-mono text-xs">יומן ביצוע ({trades.length} · נסגרו {closedTrades})</TabsTrigger>
            </TabsList>

            <TabsContent value="positions">
              {positions.length === 0 ? (
                <div className="text-muted-foreground text-xs text-center font-mono h-[26rem] flex items-center justify-center">
                  {isRunning ? 'ממתין לאיתות מתאים...' : 'הפעל כדי להתחיל'}
                </div>
              ) : (
                <div className="space-y-3 h-[26rem] overflow-y-auto pr-1">
                  {positions.map((pos) => {
                    const isLong = pos.side === 'LONG' || pos.side === 'BUY';
                    const liveAsset = cryptoData?.find((c) => c.symbol.toUpperCase() === pos.symbol.toUpperCase());
                    const livePrice = liveAsset?.current_price ?? pos.currentPrice ?? pos.entryPrice;
                    const priceDiff = isLong ? livePrice - pos.entryPrice : pos.entryPrice - livePrice;
                    // No `* leverage` here: `quantity` already carries the full
                    // (leveraged) size — notional / entryPrice — so the backend
                    // close-out pnl is `priceDiff * quantity` with no leverage
                    // term. Multiplying again overstated an open FUTURES card by
                    // `leverage`x until the trade actually closed.
                    const pnl = priceDiff * pos.quantity;
                    // The profit ratchet (2026-09-14), not takeProfit1, is what
                    // actually closes this position now — every sim bot runs it.
                    // Passing these replaces the chart's old static "TP" line
                    // (which stopped meaning "the bot exits here" the day the
                    // ratchet shipped) with the real armed trigger price.
                    const ratchet = ratchetLevels({
                      entryPrice: pos.entryPrice,
                      peakPrice: (isLong ? pos.highestPrice : pos.lowestPrice) ?? pos.entryPrice,
                      livePrice,
                      isLong,
                      peakPctAtLastPartial: pos.ratchetPeakPct,
                      remainingNotionalUsd: pos.quantity * livePrice
                    });
                    return (
                      <LivePositionChart
                        key={pos.id}
                        symbol={pos.symbol}
                        type={pos.type}
                        side={pos.side}
                        entryPrice={pos.entryPrice}
                        currentPrice={livePrice}
                        quantity={pos.quantity}
                        openedAt={pos.openedAt}
                        openTimestamp={pos.openTimestamp}
                        stopLoss={pos.stopLoss}
                        ratchetArmedPrice={ratchet.armedSellPrice}
                        ratchetArmedIsFullClose={ratchet.armedIsFullClose}
                        ratchetNextRungPrice={ratchet.nextRungPrice}
                        // What went in vs what is still in. `initialCostUsd` is
                        // frozen at entry; the remaining cost basis is
                        // quantity × avgPrice for spot and the (already scaled)
                        // margin for futures. Positions persisted before
                        // initialCostUsd existed fall back to the current
                        // figures, which simply reads as "full".
                        investedUsd={pos.initialCostUsd ?? (pos.type === 'SPOT'
                          ? pos.quantity * (pos.avgPrice || pos.entryPrice)
                          : pos.marginUsd)}
                        remainingCostUsd={pos.type === 'SPOT'
                          ? pos.quantity * (pos.avgPrice || pos.entryPrice)
                          : pos.marginUsd}
                        leverage={pos.leverage}
                        unrealizedPnl={pnl}
                        confidence={pos.confidence}
                      />
                    );
                  })}
                </div>
              )}
            </TabsContent>

            <TabsContent value="trades">
              {trades.length === 0 ? (
                <div className="text-muted-foreground text-xs text-center font-mono h-[26rem] flex items-center justify-center">אין עסקאות עדיין</div>
              ) : (
                <div className="space-y-2 h-[26rem] overflow-y-auto font-mono pr-1">
                  {/* Why the bot actually exits — the single most diagnostic
                      view of a losing run. Count + summed P&L per bucket, so a
                      stop-dominated book is visible without reading every row. */}
                  {exitBreakdown.length > 0 && (
                    <div className="p-2 border border-border/40 rounded bg-muted/20 sticky top-0 z-10 backdrop-blur">
                      <div className="text-[11px] font-bold mb-1.5">סיבות יציאה ({exitBreakdown.reduce((s, r) => s + r.count, 0)} יציאות)</div>
                      <div className="space-y-1">
                        {exitBreakdown.map((r) => (
                          <div key={r.key} className="flex items-center justify-between gap-2 text-[10px]">
                            <span className="text-muted-foreground">{r.key}</span>
                            <span className="flex items-center gap-2">
                              <Badge variant="outline" className="text-[9px] px-1 py-0">{r.count}</Badge>
                              <span className={`font-bold tabular-nums ${r.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                {r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(2)}
                              </span>
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {trades.map((trade) => (
                    <div key={trade.id} className="p-2 border border-border/30 rounded bg-card/30">
                      {(() => {
                        const tradePrice = safeNumber(trade.price);
                        const tradePnl = trade.pnl === undefined ? undefined : safeNumber(trade.pnl);
                        return <>
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="flex items-center gap-2 text-xs">
                          {trade.side.includes('buy') || trade.side.includes('long') ? (
                            <ArrowUpCircle className="w-3.5 h-3.5 text-green-400" />
                          ) : (
                            <ArrowDownCircle className="w-3.5 h-3.5 text-red-400" />
                          )}
                          <Badge variant="outline" className="text-[10px]">{trade.symbol}</Badge>
                          <Badge className={`text-[10px] ${trade.pnl !== undefined ? 'bg-orange-500/20 text-orange-300 border-orange-500/40' : 'bg-blue-500/20 text-blue-300 border-blue-500/40'}`} variant="outline">
                            {trade.side === 'partial_tp1' ? 'יציאה חלקית' : trade.pnl !== undefined ? 'יציאה' : 'כניסה'}
                          </Badge>
                          <span className="text-muted-foreground">{trade.timestamp}</span>
                        </div>
                        <div className="text-xs">
                          <span className={accentClass}>${tradePrice.toFixed(4)}</span>
                          {tradePnl !== undefined && (
                            <span className={`mr-2 font-bold ${tradePnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                              {tradePnl >= 0 ? '+' : ''}${tradePnl.toFixed(2)}
                            </span>
                          )}
                        </div>
                      </div>
                      {/* NOT truncated: the exit reason is the whole point of
                          the log — it carries the level that fired, the R
                          progress and the gate name. One line hid all of it. */}
                      <div className="text-[10px] text-muted-foreground mt-1 whitespace-pre-wrap break-words">{trade.reason}</div>
                      </>;
                    })()}
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
