import React, { useState, useEffect, useRef } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  ReferenceArea,
  ReferenceDot
} from 'recharts';
import { Target, ShieldAlert, Crosshair, DollarSign, Loader2, Activity, ShoppingBag, TrendingUp, TrendingDown } from 'lucide-react';
import { formatFullPrice } from '@/utils/formatPrice';
import { fetchTimeframe, getAggregatedCandles } from '@cde/engine/market-data';

const FIVE_MIN_MS = 300_000;
const DAY_MS = 86_400_000;
/** 5-minute bars of context to keep BEFORE the entry — the entry candle is the
 *  anchor, this is the run-up the engine saw when it decided to buy. Large
 *  enough that a fresh position still fills the axis with candles instead of a
 *  handful of sticks spaced far apart. */
const CONTEXT_BARS_BEFORE = 46;
/** Most 5m candles to draw. ~13h — covers every intraday / Path hold with room;
 *  a longer position keeps the most recent window, entry markers clamp to edge. */
const RENDER_CAP = 150;
/** Hard cap on how many 5m bars to PULL from the feed (~20h). */
const MAX_5M_BARS = 240;

const UP = '#10b981';
const DOWN = '#f43f5e';
const ENTRY_HL = '#fbbf24';

type Candle = { timestamp: number; open: number; high: number; low: number; close: number };
type Row = {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** [low, high] — the value recharts scales the bar by; the shape reads O/C off payload. */
  ohlc: [number, number];
  isEntry: boolean;
  forming?: boolean;
};

export interface LivePositionChartProps {
  symbol: string;
  type: 'SPOT' | 'FUTURES';
  side: 'BUY' | 'SELL' | 'LONG' | 'SHORT';
  entryPrice: number;
  currentPrice: number;
  quantity?: number;
  openedAt?: string;
  openTimestamp?: number;
  stopLoss?: number;
  takeProfit?: number;
  takeProfit1?: number;
  breakEvenPrice?: number;
  /** Profit-ratchet levels (profitRatchet.ts) — the ACTUAL exit mechanism for
   *  every sim bot since 2026-09-14, in price terms. Supersede takeProfit /
   *  takeProfit1 for the chart's profit marker: those are the entry-time plan,
   *  but the ratchet — not touching TP1 — is what closes the position now.
   *  `undefined` (prop omitted) keeps the legacy takeProfit/takeProfit1 line
   *  for a caller that has not computed ratchet levels; `null` is the ratchet's
   *  own "nothing armed yet" answer and must NOT fall back to takeProfit1 (that
   *  would silently resurrect the misleading old line). */
  ratchetArmedPrice?: number | null;
  ratchetArmedIsFullClose?: boolean;
  ratchetNextRungPrice?: number;
  leverage?: number;
  unrealizedPnl?: number;
  /** Confidence (0-100) the engine entered this position with — shown as a
   *  holographic overlay on the chart. */
  confidence?: number;
  candles?: Candle[];
}

const fmtClock = (ts: number) =>
  new Date(ts).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
const fmtDay = (ts: number) =>
  new Date(ts).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' });

/** One candlestick. recharts hands the shape the pixel box the bar occupies
 *  (x/width across, y/height spanning low→high because the bar's value is
 *  [low, high]); we interpolate the body from open/close on the payload. */
const CandleBar: React.FC<{
  x?: number; y?: number; width?: number; height?: number;
  payload?: Row;
}> = ({ x = 0, y = 0, width = 0, height = 0, payload }) => {
  if (!payload) return null;
  const { open, close, high, low, isEntry, forming } = payload;
  const cx = x + width / 2;
  const span = high - low;
  const priceToY = (p: number) => (span > 0 ? y + ((high - p) / span) * height : y + height / 2);

  const isUp = close >= open;
  const color = isUp ? UP : DOWN;
  const bodyTop = priceToY(Math.max(open, close));
  const bodyH = Math.max(1, priceToY(Math.min(open, close)) - bodyTop);
  const bw = Math.max(2, Math.min(width * 0.72, 16));

  return (
    <g opacity={forming ? 0.7 : 1}>
      {isEntry && (
        <rect
          x={cx - bw * 1.7} width={bw * 3.4} y={y - 5} height={height + 10} rx={2}
          fill={ENTRY_HL} fillOpacity={0.13} stroke={ENTRY_HL} strokeOpacity={0.4} strokeWidth={1}
        />
      )}
      <line x1={cx} x2={cx} y1={y} y2={y + height} stroke={color} strokeWidth={1} />
      <rect
        x={cx - bw / 2} width={bw} y={bodyTop} height={bodyH} rx={0.5}
        fill={color}
        stroke={isEntry ? ENTRY_HL : color}
        strokeWidth={isEntry ? 1.5 : 0}
      />
    </g>
  );
};

export const LivePositionChart: React.FC<LivePositionChartProps> = ({
  symbol,
  type,
  side,
  entryPrice,
  currentPrice,
  quantity = 0,
  openedAt,
  openTimestamp,
  stopLoss,
  takeProfit,
  takeProfit1,
  breakEvenPrice,
  ratchetArmedPrice,
  ratchetArmedIsFullClose,
  ratchetNextRungPrice,
  leverage = 1,
  unrealizedPnl,
  confidence,
  candles: externalCandles
}) => {
  const [internalCandles, setInternalCandles] = useState<Candle[]>([]);
  const [loadingCandles, setLoadingCandles] = useState(false);
  // false → real 5-minute candles for the holding window; true → had to fall
  // back to the daily aggregate (5m feed unavailable for this symbol).
  const [usingDaily, setUsingDaily] = useState(false);
  const hasDataRef = useRef(false);

  const isLong = side === 'BUY' || side === 'LONG';
  // Ratchet-aware, in priority order: an ARMED trigger (a sell fires if price
  // reaches it) beats the NEXT rung (informational — price has to climb
  // further before it even arms) beats the legacy static TP1/TP fallback for
  // a caller that never computed ratchet levels at all.
  const usingRatchet = ratchetArmedPrice !== undefined || ratchetNextRungPrice !== undefined;
  const effectiveTP = usingRatchet
    ? (ratchetArmedPrice ?? ratchetNextRungPrice)
    : (takeProfit || takeProfit1);
  const tpIsArmedSell = usingRatchet && ratchetArmedPrice != null;
  const tpLabel = tpIsArmedSell
    ? (ratchetArmedIsFullClose ? 'סגירה' : 'מימוש 30%')
    : usingRatchet ? 'מדרגה הבאה' : 'TP';
  const effectiveLeverage = leverage > 0 ? leverage : 1;

  // PnL calculations
  const priceDiff = isLong ? currentPrice - entryPrice : entryPrice - currentPrice;
  const pnlPercent = entryPrice > 0 ? (priceDiff / entryPrice) * 100 * effectiveLeverage : 0;

  const effectivePnl = unrealizedPnl !== undefined
    ? unrealizedPnl
    : (quantity > 0 ? priceDiff * quantity * effectiveLeverage : 0);

  const isProfitable = effectivePnl >= 0;
  const moveColor = isProfitable ? '#10b981' : '#f43f5e';

  const hasConfidence = typeof confidence === 'number' && confidence > 0;
  const heldMs = openTimestamp ? Math.max(0, Date.now() - openTimestamp) : 0;
  const heldLabel = openTimestamp
    ? heldMs < 3_600_000
      ? `${Math.max(1, Math.round(heldMs / 60_000))} דק'`
      : `${(heldMs / 3_600_000).toFixed(1)} שע'`
    : null;

  // ── Fetch 5-minute candles covering the holding window ─────────────────────
  useEffect(() => {
    if (externalCandles && externalCandles.length > 0) {
      setInternalCandles(externalCandles);
      hasDataRef.current = true;
      return;
    }

    let active = true;

    const load = () => {
      if (!hasDataRef.current) setLoadingCandles(true);
      const bars = openTimestamp ? Math.ceil((Date.now() - openTimestamp) / FIVE_MIN_MS) : 0;
      const limit = Math.min(MAX_5M_BARS, Math.max(72, bars + CONTEXT_BARS_BEFORE + 8));

      const daily = () =>
        getAggregatedCandles(symbol, 45).then((c) => {
          if (active && c && c.length) {
            setInternalCandles(c);
            setUsingDaily(true);
            hasDataRef.current = true;
          }
        });

      // minCandles: 12 — this chart wants a short window (an hour of 5m bars is
      // plenty to draw). Without the override fetchTimeframe enforces the
      // engine's floor of 500 and rejects every request this component makes,
      // so it always fell through to the daily aggregate ("5ד׳ לא זמין").
      fetchTimeframe(symbol, '5m', { limit, minCandles: 12, requireClosed: false, category: 'spot' })
        .then((res) => {
          if (!active) return;
          if (res.candles && res.candles.length > 2) {
            setInternalCandles(res.candles);
            setUsingDaily(false);
            hasDataRef.current = true;
            return;
          }
          return daily();
        })
        .catch(() => daily().catch(() => {}))
        .finally(() => {
          if (active) setLoadingCandles(false);
        });
    };

    load();
    // The 5m feed refreshes on ~45s cadence; re-pull once a minute so the chart
    // keeps extending for as long as the position is open.
    const id = setInterval(load, 60_000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [symbol, externalCandles, openTimestamp]);

  const activeCandles = externalCandles && externalCandles.length > 0 ? externalCandles : internalCandles;
  const entryTs = openTimestamp || activeCandles[0]?.timestamp || Date.now();
  const tfMs = usingDaily ? DAY_MS : FIVE_MIN_MS;

  // ── Build the candlestick window, anchored on the entry candle ─────────────
  const { chartData, entryCandleTs } = React.useMemo(() => {
    if (!activeCandles || activeCandles.length === 0) {
      return { chartData: [] as Row[], entryCandleTs: entryTs };
    }
    const sorted = [...activeCandles].sort((a, b) => a.timestamp - b.timestamp);

    // The candle that CONTAINS the entry = last one opening at or before entryTs.
    let eIdx = -1;
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].timestamp <= entryTs) eIdx = i;
      else break;
    }
    const anchor = eIdx === -1 ? 0 : eIdx;
    let rows = sorted.slice(Math.max(0, anchor - CONTEXT_BARS_BEFORE));
    if (rows.length > RENDER_CAP) rows = rows.slice(-RENDER_CAP);

    const eTsRaw = eIdx >= 0 ? sorted[eIdx].timestamp : (rows[0]?.timestamp ?? entryTs);
    // If the position is old enough that the true entry candle fell outside the
    // RENDER_CAP window, pin the entry markers to the left edge instead of
    // letting them vanish — "the buy was before this view".
    const eTs = rows.some((c) => c.timestamp === eTsRaw) ? eTsRaw : (rows[0]?.timestamp ?? eTsRaw);

    const out: Row[] = rows.map((c) => ({
      ts: c.timestamp,
      open: c.open, high: c.high, low: c.low, close: c.close,
      ohlc: [c.low, c.high],
      isEntry: c.timestamp === eTsRaw
    }));

    // Fold the live market price into the forming candle so the last bar tracks
    // the position in real time.
    if (currentPrice > 0 && out.length) {
      const last = out[out.length - 1];
      if (Date.now() - last.ts >= tfMs) {
        const o = last.close;
        const hi = Math.max(o, currentPrice);
        const lo = Math.min(o, currentPrice);
        out.push({ ts: last.ts + tfMs, open: o, high: hi, low: lo, close: currentPrice, ohlc: [lo, hi], isEntry: false, forming: true });
      } else {
        last.close = currentPrice;
        last.high = Math.max(last.high, currentPrice);
        last.low = Math.min(last.low, currentPrice);
        last.ohlc = [last.low, last.high];
        last.forming = true;
      }
    }

    return { chartData: out, entryCandleTs: eTs };
  }, [activeCandles, entryTs, currentPrice, tfMs]);

  const lastTs = chartData.length ? chartData[chartData.length - 1].ts : entryTs;
  // A category axis can hand the formatter a stringified ts — coerce before Date().
  const tickFmt = (v: number | string) => (usingDaily ? fmtDay : fmtClock)(Number(v));

  // Y domain: the candle band, plus entry/SL/TP/BE — but SL/TP only pull the
  // scale up to ~1.2× the candle range so the candles never get squashed flat.
  const yDomain = React.useMemo<[number, number] | ['auto', 'auto']>(() => {
    if (!chartData.length) return ['auto', 'auto'];
    let cLo = Infinity, cHi = -Infinity;
    for (const d of chartData) { cLo = Math.min(cLo, d.low); cHi = Math.max(cHi, d.high); }
    if (!Number.isFinite(cLo) || !Number.isFinite(cHi)) return ['auto', 'auto'];
    const range = Math.max(cHi - cLo, cHi * 1e-4);
    let lo = cLo, hi = cHi;
    for (const v of [entryPrice, currentPrice, stopLoss, effectiveTP, breakEvenPrice]) {
      if (typeof v === 'number' && v > 0) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    }
    lo = Math.max(lo, cLo - range * 1.2);
    hi = Math.min(hi, cHi + range * 1.2);
    const pad = (hi - lo) * 0.06 || hi * 0.01;
    return [lo - pad, hi + pad];
  }, [chartData, entryPrice, currentPrice, stopLoss, effectiveTP, breakEvenPrice]);

  // Distance to targets — used by the fallback bar when no candles loaded.
  const slDistancePercent = stopLoss && entryPrice > 0
    ? Math.abs((entryPrice - stopLoss) / entryPrice) * 100
    : 0;
  const tpDistancePercent = effectiveTP && entryPrice > 0
    ? Math.abs((effectiveTP - entryPrice) / entryPrice) * 100
    : 0;

  // ── The BUY flag, pinned to the exact entry candle on the chart ────────────
  const renderBuyFlag = (props: { viewBox?: { x?: number; y?: number; cx?: number; cy?: number } }) => {
    const vb = props.viewBox ?? {};
    const cx = vb.cx ?? vb.x ?? 0;
    const cy = vb.cy ?? vb.y ?? 0;
    const label = `BUY $${formatFullPrice(entryPrice)}`;
    const w = Math.min(180, label.length * 6.6 + 20);
    const arrow = isProfitable ? '▲' : '▼';
    return (
      <g transform={`translate(${cx}, ${cy})`} style={{ pointerEvents: 'none' }}>
        {/* connector from flag down to the dot */}
        <line x1={0} y1={0} x2={0} y2={-14} stroke={isLong ? '#34d399' : '#fb7185'} strokeWidth={1.5} />
        <g transform={`translate(${-w / 2}, ${-38})`}>
          <rect x={-1} y={-1} width={w + 2} height={24} rx={6} fill={isLong ? '#10b981' : '#f43f5e'} opacity={0.3} />
          <rect
            x={0} y={0} width={w} height={22} rx={5}
            fill={isLong ? '#064e3b' : '#881337'}
            stroke={isLong ? '#34d399' : '#fb7185'}
            strokeWidth={1.5}
            filter="drop-shadow(0 2px 4px rgba(0,0,0,0.6))"
          />
          <text x={8} y={15} fill="#ffffff" fontSize={10.5} fontWeight="bold" fontFamily="monospace">
            {label}
          </text>
          <text x={w - 6} y={15} textAnchor="end" fill={moveColor} fontSize={10} fontWeight="bold" fontFamily="monospace">
            {arrow}{Math.abs(pnlPercent).toFixed(2)}%
          </text>
        </g>
      </g>
    );
  };

  const renderTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ payload: Row }> }) => {
    if (!active || !payload || !payload.length) return null;
    const r = payload[0].payload;
    const up = r.close >= r.open;
    return (
      <div style={{ backgroundColor: 'rgba(15,23,42,0.96)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 8, fontSize: 11, padding: '6px 8px', fontFamily: 'monospace' }}>
        <div style={{ color: '#94a3b8', marginBottom: 2 }}>
          {usingDaily ? fmtDay(r.ts) : `${fmtDay(r.ts)} ${fmtClock(r.ts)}`}
          {r.isEntry && <span style={{ color: ENTRY_HL }}> · כניסה</span>}
          {r.forming && <span style={{ color: '#94a3b8' }}> · נר פעיל</span>}
        </div>
        <div style={{ color: up ? UP : DOWN }}>
          O {formatFullPrice(r.open)}　H {formatFullPrice(r.high)}<br />
          L {formatFullPrice(r.low)}　C {formatFullPrice(r.close)}
        </div>
      </div>
    );
  };

  return (
    <Card className="border border-border/40 bg-card/60 backdrop-blur-md overflow-hidden transition-all duration-200 hover:border-primary/40">
      {/* scoped holographic styling for the confidence badge */}
      <style>{`
        @keyframes lpcHoloSheen { 0% { transform: translateX(-120%); } 60%,100% { transform: translateX(220%); } }
        @keyframes lpcHoloFloat { 0%,100% { transform: perspective(400px) rotateX(0deg); } 50% { transform: perspective(400px) rotateX(6deg); } }
        .lpc-holo {
          position: absolute; top: 8px; left: 8px; z-index: 5; pointer-events: none;
          padding: 5px 10px; border-radius: 9px; overflow: hidden;
          font-family: monospace; line-height: 1.05;
          background: linear-gradient(135deg, rgba(34,211,238,0.16), rgba(139,92,246,0.16));
          border: 1px solid rgba(56,189,248,0.55);
          box-shadow: 0 0 14px rgba(56,189,248,0.35), inset 0 0 10px rgba(139,92,246,0.25);
          backdrop-filter: blur(3px);
          animation: lpcHoloFloat 5s ease-in-out infinite;
        }
        .lpc-holo::after {
          content: ''; position: absolute; inset: 0; width: 45%;
          background: linear-gradient(100deg, transparent, rgba(255,255,255,0.55), transparent);
          animation: lpcHoloSheen 3.4s ease-in-out infinite;
        }
        .lpc-holo__k { font-size: 8px; letter-spacing: .12em; color: rgba(186,230,253,0.9); text-transform: uppercase; }
        .lpc-holo__v {
          font-size: 15px; font-weight: 800;
          background: linear-gradient(90deg, #67e8f9, #a78bfa);
          -webkit-background-clip: text; background-clip: text; color: transparent;
          text-shadow: 0 0 10px rgba(103,232,249,0.45);
        }
      `}</style>

      <CardHeader className="p-3 pb-2 border-b border-border/30 bg-muted/20">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono font-bold text-base">{symbol}</span>
            <Badge variant="outline" className={type === 'FUTURES' ? 'border-purple-500/50 text-purple-400 bg-purple-500/10' : 'border-cyan-500/50 text-cyan-400 bg-cyan-500/10'}>
              {type} {effectiveLeverage > 1 ? `${effectiveLeverage}x` : ''}
            </Badge>
            <Badge className={isLong ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40' : 'bg-rose-500/20 text-rose-400 border-rose-500/40'}>
              {side}
            </Badge>
            <Badge className="bg-primary/20 text-primary border border-primary/40 font-mono text-xs flex items-center gap-1">
              <ShoppingBag className="w-3 h-3" />
              <span>נקנה: ${formatFullPrice(entryPrice)}</span>
              {openedAt && <span className="opacity-80">({openedAt})</span>}
            </Badge>
            {hasConfidence && (
              <Badge variant="outline" className="border-sky-400/50 text-sky-300 bg-sky-400/10 font-mono text-xs">
                ביטחון כניסה {Math.round(confidence!)}%
              </Badge>
            )}
            {heldLabel && (
              <Badge variant="outline" className="border-border/50 text-muted-foreground font-mono text-[11px]">
                מוחזק {heldLabel}
              </Badge>
            )}
          </div>

          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-muted-foreground">מחיר נוכחי:</span>
            <span className="font-mono font-bold text-sm sm:text-base">${formatFullPrice(currentPrice)}</span>
            <Badge className={`${isProfitable ? 'bg-emerald-600' : 'bg-rose-600'} text-white font-mono text-xs shadow-sm flex items-center gap-1`}>
              {isProfitable ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
              {isProfitable ? '+' : ''}{pnlPercent.toFixed(2)}% ({isProfitable ? '+' : ''}${effectivePnl.toFixed(2)})
            </Badge>
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-3 pt-2">
        {loadingCandles && chartData.length === 0 ? (
          <div className="h-36 w-full flex flex-col items-center justify-center gap-2 bg-black/20 rounded-md border border-border/20">
            <Loader2 className="w-5 h-5 text-primary animate-spin" />
            <span className="text-xs font-mono text-muted-foreground">טוען נרות 5 דקות...</span>
          </div>
        ) : chartData.length > 2 ? (
          <div className="relative h-40 w-full">
            {hasConfidence && (
              <div className="lpc-holo">
                <div className="lpc-holo__k">ביטחון כניסה</div>
                <div className="lpc-holo__v">{Math.round(confidence!)}%</div>
              </div>
            )}
            <div className="absolute top-1.5 right-2 z-[5] text-[10px] font-mono text-muted-foreground/80 pointer-events-none">
              {usingDaily ? 'נרות יומיים (5ד׳ לא זמין)' : 'נרות 5 דקות · פוקוס על הכניסה'}
            </div>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ top: 20, right: 12, left: -18, bottom: 0 }} barCategoryGap="8%">
                <XAxis
                  dataKey="ts"
                  type="category"
                  stroke="#71717a"
                  fontSize={10}
                  tickLine={false}
                  tickFormatter={tickFmt}
                  minTickGap={44}
                  interval="preserveStartEnd"
                />
                <YAxis stroke="#71717a" fontSize={10} domain={yDomain} tickLine={false} width={58}
                  allowDecimals tickFormatter={(v: number) => `$${formatFullPrice(v)}`} />
                <Tooltip content={renderTooltip} />

                {/* Held period tint — the stretch of chart since the BUY */}
                <ReferenceArea x1={entryCandleTs} x2={lastTs} fill={moveColor} fillOpacity={0.06} />

                {/* The candlesticks */}
                <Bar dataKey="ohlc" shape={(p: object) => <CandleBar {...(p as React.ComponentProps<typeof CandleBar>)} />} isAnimationActive={false} maxBarSize={22} />

                {/* Exact entry time */}
                <ReferenceLine x={entryCandleTs} stroke={ENTRY_HL} strokeDasharray="3 3" strokeOpacity={0.85} />
                {/* Entry price level */}
                <ReferenceLine y={entryPrice} stroke={isLong ? '#10b981' : '#f43f5e'} strokeDasharray="4 4" strokeWidth={1.25}
                  label={{ value: 'כניסה', fill: isLong ? '#34d399' : '#fb7185', fontSize: 9, position: 'insideLeft' }} />

                {/* The BUY marker — precise x (entry candle) + y (entry price) */}
                <ReferenceDot
                  x={entryCandleTs}
                  y={entryPrice}
                  r={5}
                  fill={isLong ? '#10b981' : '#f43f5e'}
                  stroke="#ffffff"
                  strokeWidth={2}
                  ifOverflow="extendDomain"
                  label={renderBuyFlag}
                />

                {stopLoss && (
                  <ReferenceLine y={stopLoss} stroke="#ef4444" strokeWidth={1.5}
                    label={{ value: `SL: $${formatFullPrice(stopLoss)}`, fill: '#f87171', fontSize: 10, position: 'insideBottomLeft' }} />
                )}
                {effectiveTP && (
                  <ReferenceLine
                    y={effectiveTP}
                    stroke={tpIsArmedSell ? '#f59e0b' : '#10b981'}
                    strokeWidth={1.5}
                    strokeDasharray={tpIsArmedSell ? undefined : '4 3'}
                    label={{
                      value: `${tpLabel}: $${formatFullPrice(effectiveTP)}`,
                      fill: tpIsArmedSell ? '#fbbf24' : '#34d399',
                      fontSize: 10,
                      position: 'insideTopRight'
                    }}
                  />
                )}
                {breakEvenPrice && (
                  <ReferenceLine y={breakEvenPrice} stroke="#a855f7" strokeDasharray="2 2"
                    label={{ value: `BE: $${formatFullPrice(breakEvenPrice)}`, fill: '#c084fc', fontSize: 10, position: 'insideBottomRight' }} />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        ) : (
          /* Fallback visual position tracker if candles could not be loaded */
          <div className="relative h-36 w-full flex flex-col justify-center px-4 py-2 bg-card/40 rounded-lg border border-border/30 space-y-3">
            {hasConfidence && (
              <div className="lpc-holo">
                <div className="lpc-holo__k">ביטחון כניסה</div>
                <div className="lpc-holo__v">{Math.round(confidence!)}%</div>
              </div>
            )}
            <div className="flex items-center justify-between text-xs font-mono">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-primary" />
                <span className="text-muted-foreground">מעקב מחיר שוק לפוזיציה</span>
                <Badge className="bg-primary/20 text-primary border-primary/30 text-[11px] px-1.5 py-0">
                  נקנה: ${formatFullPrice(entryPrice)}
                </Badge>
              </div>
              <span className={isProfitable ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                {isProfitable ? 'רווח נוכחי: +' : 'הפסד נוכחי: '}{pnlPercent.toFixed(2)}%
              </span>
            </div>

            <div className="space-y-1.5">
              <div className="flex justify-between text-[11px] font-mono text-muted-foreground">
                <span className="text-rose-400">SL: ${formatFullPrice(stopLoss || entryPrice * (isLong ? 0.95 : 1.05))}</span>
                <span className="text-emerald-400 font-bold">כניסה: ${formatFullPrice(entryPrice)}</span>
                <span className={tpIsArmedSell ? 'text-amber-400' : 'text-emerald-400'}>{tpLabel}: ${formatFullPrice(effectiveTP || entryPrice * (isLong ? 1.05 : 0.95))}</span>
              </div>
              <div className="relative h-2 w-full bg-muted/40 rounded-full overflow-hidden">
                <div
                  className={`h-full ${isProfitable ? 'bg-emerald-500' : 'bg-rose-500'} transition-all duration-300`}
                  style={{ width: `${Math.min(100, Math.max(5, 50 + pnlPercent * 2))}%` }}
                />
              </div>
              <div className="flex justify-between text-[10px] font-mono text-muted-foreground">
                <span>מרחק מ-SL: -{slDistancePercent.toFixed(1)}%</span>
                <span>מרחק מ-TP: +{tpDistancePercent.toFixed(1)}%</span>
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2 pt-2 border-t border-border/30 text-xs font-mono">
          <div className="flex items-center gap-1 text-muted-foreground">
            <Crosshair className="w-3.5 h-3.5 text-blue-400" />
            <span>כניסה: </span>
            <span className="text-foreground font-semibold">${formatFullPrice(entryPrice)}</span>
          </div>
          {stopLoss && (
            <div className="flex items-center gap-1 text-muted-foreground">
              <ShieldAlert className="w-3.5 h-3.5 text-rose-400" />
              <span>SL: </span>
              <span className="text-rose-400 font-semibold">${formatFullPrice(stopLoss)}</span>
            </div>
          )}
          {effectiveTP && (
            <div className="flex items-center gap-1 text-muted-foreground">
              <Target className={`w-3.5 h-3.5 ${tpIsArmedSell ? 'text-amber-400' : 'text-emerald-400'}`} />
              <span>{tpLabel}: </span>
              <span className={`font-semibold ${tpIsArmedSell ? 'text-amber-400' : 'text-emerald-400'}`}>${formatFullPrice(effectiveTP)}</span>
            </div>
          )}
          {breakEvenPrice && (
            <div className="flex items-center gap-1 text-muted-foreground">
              <DollarSign className="w-3.5 h-3.5 text-purple-400" />
              <span>BE: </span>
              <span className="text-purple-400 font-semibold">${formatFullPrice(breakEvenPrice)}</span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

export default LivePositionChart;
