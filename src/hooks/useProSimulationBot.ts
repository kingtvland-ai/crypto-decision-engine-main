// "Bot Pro" — a literal implementation of alg.md's weighted-indicator
// confidence engine, running side by side with the intraday engine
// (useSimulationBot.ts) and the 4H path engine.
//
// The evaluation/order-generation logic itself lives in
// packages/engine/src/services/proAlgEngine.ts + proSimExecution.ts, shared
// with server/proSimEngine.ts (which runs this same algorithm 24/7
// server-side) — this hook only owns this runtime's own state (React
// state+refs) and market-data refresh loop, and serves as the LOCAL FALLBACK
// when the server isn't reachable, same role useSimulationBot.ts plays for
// the intraday bot.
//
// Unlike the version of this hook that ran alg.md's OLDER, unrelated spec
// (ADX/Supertrend regime, ATR-scaled stops, Kelly sizing, Spot+Futures
// routing), there is no DecisionEngine pipeline here: alg.md's flow is one
// weighted score per symbol and one threshold check, with nothing to stage.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CryptoData } from '@cde/engine';
import { useBackgroundWorker } from './useBackgroundWorker';
import type { Candle } from '@cde/engine';
import { SignalEvaluation } from '@cde/engine';
import { getUniverseMarketData } from '@cde/engine/market-data';
import { toBaseAsset } from '@cde/engine/market-data';
import { fillDueOrders, selectFillableOrders } from '@cde/engine/execution';
import {
  generateProOrders,
  buildProEvaluation,
  MIN_PRO_CANDLES,
  formatDynamicPrice
} from '@cde/engine/execution';
import type {
  SimPosition,
  SimTrade,
  SimPoint,
  PendingOrder,
  SimBotConfig
} from './useSimulationBot';
import { computeProSignal, proMinConfidence, type ProSignalResult, type ProRiskLevel } from '@cde/engine/analysis';
import { SIM_MIN_CONFIDENCE } from '@cde/engine/execution';

export type { SimPosition, SimTrade, SimPoint, PendingOrder, SimBotConfig } from './useSimulationBot';

// A snapshot the engine can hydrate from (server-shared state may omit hourlyHistory).
interface HydratableSnapshot {
  cash: number;
  positions: SimPosition[];
  trades: SimTrade[];
  history: SimPoint[];
  hourlyHistory?: SimPoint[];
  pending: PendingOrder[];
  totalFees: number;
  totalSlippageCost: number;
}

interface Params {
  config: SimBotConfig;
  isRunning: boolean;
  cryptoData?: CryptoData[];
  fearGreedIndex?: number;
  initialSnapshot?: HydratableSnapshot | null;
  persist?: (state: PersistedSimState) => void;
}

export const PRO_SIM_BOT_STORAGE_KEY = 'pro-simulation-bot-state-v1';

interface PersistedSimState {
  cash: number;
  positions: SimPosition[];
  trades: SimTrade[];
  history: SimPoint[];
  hourlyHistory: SimPoint[];
  pending: PendingOrder[];
  totalFees: number;
  totalSlippageCost: number;
  savedAt: number;
}

const loadPersisted = (): PersistedSimState | null => {
  try {
    const raw = localStorage.getItem(PRO_SIM_BOT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedSimState;
    if (typeof parsed?.cash !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
};

export function useProSimulationBot({ config, isRunning, cryptoData, fearGreedIndex = 50, initialSnapshot, persist }: Params) {
  const [saved] = useState<HydratableSnapshot | PersistedSimState | null>(() => initialSnapshot ?? loadPersisted());
  const [cash, setCash] = useState(saved?.cash ?? config.initialAmount);
  const [positions, setPositions] = useState<SimPosition[]>(saved?.positions ?? []);
  const [trades, setTrades] = useState<SimTrade[]>(saved?.trades ?? []);
  const [history, setHistory] = useState<SimPoint[]>(saved?.history ?? []);
  const [hourlyHistory, setHourlyHistory] = useState<SimPoint[]>(saved?.hourlyHistory ?? []);
  const [pending, setPending] = useState<PendingOrder[]>(saved?.pending ?? []);
  const [totalFees, setTotalFees] = useState(saved?.totalFees ?? 0);
  const [totalSlippageCost, setTotalSlippageCost] = useState(saved?.totalSlippageCost ?? 0);
  const [lastEvaluation, setLastEvaluation] = useState<string>('');
  const [heartbeat, setHeartbeat] = useState(0);
  const [nextTickAt, setNextTickAt] = useState<number>(0);

  const cashRef = useRef(cash);
  const positionsRef = useRef(positions);
  const pendingRef = useRef(pending);
  const cryptoRef = useRef(cryptoData);
  const configRef = useRef(config);
  const exitCooldownRef = useRef<Record<string, number>>({});
  const tradesRef = useRef(trades);

  cashRef.current = cash;
  positionsRef.current = positions;
  pendingRef.current = pending;
  cryptoRef.current = cryptoData;
  configRef.current = config;
  tradesRef.current = trades;

  useEffect(() => {
    const meaningful = cash !== configRef.current.initialAmount || positions.length > 0 || trades.length > 0;
    if (!meaningful) return;
    const state: PersistedSimState = {
      cash, positions, trades, history, hourlyHistory, pending, totalFees, totalSlippageCost, savedAt: Date.now()
    };
    try {
      localStorage.setItem(PRO_SIM_BOT_STORAGE_KEY, JSON.stringify(state));
    } catch { /* ignore */ }
    if (typeof persist === 'function') {
      persist(state);
    }
  }, [cash, positions, trades, history, hourlyHistory, pending, totalFees, totalSlippageCost, persist]);

  useEffect(() => {
    if (!initialSnapshot) return;
    setCash(initialSnapshot.cash);
    setPositions(initialSnapshot.positions);
    setTrades(initialSnapshot.trades);
    setHistory(initialSnapshot.history);
    setHourlyHistory(initialSnapshot.hourlyHistory ?? []);
    setPending(initialSnapshot.pending ?? []);
    setTotalFees(initialSnapshot.totalFees ?? 0);
    setTotalSlippageCost(initialSnapshot.totalSlippageCost ?? 0);
  }, [initialSnapshot]);

  const hasSavedSession = trades.length > 0 || positions.length > 0;

  // ═══════════════════════════════════════════════════════
  // MARKET DATA — reuse the same hourly candles the MTF cache already fetches
  // (h1 series), since alg.md's algorithm is single-timeframe by design.
  // ═══════════════════════════════════════════════════════
  const [candlesBySymbol, setCandlesBySymbol] = useState<Record<string, Candle[]>>({});
  const candlesRef = useRef<Record<string, Candle[]>>({});
  candlesRef.current = candlesBySymbol;

  useEffect(() => {
    if (!cryptoData || cryptoData.length === 0) return;
    let cancelled = false;
    const symbols = cryptoData.map((c) => c.symbol.toUpperCase());

    const fetchCandles = async () => {
      try {
        const { snapshots } = await getUniverseMarketData(symbols, { log: false });
        if (cancelled) return;
        const next: Record<string, Candle[]> = {};
        for (const [sym, snap] of snapshots) {
          if (snap.h1 && snap.h1.length >= MIN_PRO_CANDLES) next[toBaseAsset(sym)] = snap.h1;
        }
        setCandlesBySymbol(next);
      } catch { /* keep last-known-good candles on failure */ }
    };

    fetchCandles();
    const interval = setInterval(fetchCandles, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [cryptoData]);

  const reset = useCallback(() => {
    setCash(configRef.current.initialAmount);
    setPositions([]);
    setTrades([]);
    setHistory([]);
    setHourlyHistory([]);
    setPending([]);
    setTotalFees(0);
    setTotalSlippageCost(0);
    setLastEvaluation('');
    try {
      localStorage.removeItem(PRO_SIM_BOT_STORAGE_KEY);
    } catch { /* ignore */ }
  }, []);

  // A run's P&L, drawdown and sizing are all measured against the capital it
  // opened with, so a new starting capital starts a NEW run — the alternative
  // (which this used to do) is to keep trading the old balance while reporting
  // profit against the new number. The server engine does the same on its
  // /config endpoint.
  const startingCapitalRef = useRef(config.initialAmount);
  useEffect(() => {
    if (config.initialAmount === startingCapitalRef.current) return;
    startingCapitalRef.current = config.initialAmount;
    reset();
  }, [config.initialAmount, reset]);

  const priceFor = useCallback(
    (symbol: string) => cryptoData?.find((c) => c.symbol.toUpperCase() === symbol.toUpperCase())?.current_price,
    [cryptoData]
  );
  const priceForRef = useRef(priceFor);
  priceForRef.current = priceFor;

  const positionsValue = useMemo(() => {
    return positions.reduce((sum, p) => {
      const livePrice = priceFor(p.symbol) ?? p.currentPrice;
      return sum + p.quantity * livePrice; // spot only — see proAlgEngine.ts's header
    }, 0);
  }, [positions, priceFor]);

  const equity = cash + positionsValue;

  const { dailyDrawdownPercent, weeklyDrawdownPercent } = useMemo(() => {
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
    // Use hourlyHistory for longer time windows — history only covers ~1 hour
    // (720 points × 5s), which is insufficient for daily/weekly drawdown calculation.
    const allPoints = [...hourlyHistory, ...history];
    let peakDay = equity;
    let peakWeek = equity;
    for (const pt of allPoints) {
      if (pt.at >= oneDayAgo && pt.portfolio > peakDay) peakDay = pt.portfolio;
      if (pt.at >= oneWeekAgo && pt.portfolio > peakWeek) peakWeek = pt.portfolio;
    }
    const dailyDD = peakDay > 0 ? ((peakDay - equity) / peakDay) * 100 : 0;
    const weeklyDD = peakWeek > 0 ? ((peakWeek - equity) / peakWeek) * 100 : 0;
    return {
      dailyDrawdownPercent: Math.max(0, Number(dailyDD.toFixed(2))),
      weeklyDrawdownPercent: Math.max(0, Number(weeklyDD.toFixed(2)))
    };
  }, [equity, history, hourlyHistory]);

  const closedTrades = useMemo(() => trades.filter((t) => typeof t.pnl === 'number'), [trades]);

  const riskLevel = (config.riskLevel ?? 'medium') as ProRiskLevel;
  const minConfidenceOverride = typeof config.minConfidenceOverride === 'number' && config.minConfidenceOverride > 0
    ? config.minConfidenceOverride
    : undefined;
  const minConfidence = proMinConfidence(riskLevel, minConfidenceOverride);

  // ═══════════════════════════════════════════════════════
  // Evaluation — alg.md §2/§4, one weighted score per symbol
  // ═══════════════════════════════════════════════════════
  const evaluations = useMemo<SignalEvaluation[]>(() => {
    if (!cryptoData?.length) return [];

    return cryptoData.map((crypto) => {
      const symbol = crypto.symbol.toUpperCase();
      const baseAsset = toBaseAsset(symbol);
      const currentPrice = crypto.current_price;
      const priceChange24h = crypto.price_change_percentage_24h || 0;
      const candles = candlesBySymbol[baseAsset];

      return buildProEvaluation(baseAsset, candles ?? [], currentPrice, priceChange24h, fearGreedIndex, riskLevel, minConfidenceOverride);
    });
  }, [cryptoData, candlesBySymbol, fearGreedIndex, riskLevel, minConfidenceOverride]);

  // Per-held-symbol current signal, for the exit check (§4's "flip to SELL").
  const signalsBySymbol = useMemo<Record<string, ProSignalResult>>(() => {
    const map: Record<string, ProSignalResult> = {};
    for (const pos of positions) {
      const candles = candlesBySymbol[pos.symbol];
      if (!candles || candles.length < MIN_PRO_CANDLES) continue;
      const crypto = cryptoData?.find((c) => toBaseAsset(c.symbol.toUpperCase()) === pos.symbol);
      map[pos.symbol] = computeProSignal(candles, crypto?.price_change_percentage_24h || 0, fearGreedIndex);
    }
    return map;
  }, [positions, candlesBySymbol, cryptoData, fearGreedIndex]);

  // ═══════════════════════════════════════════════════════
  // 1. Order Generator & Exit Engine Tick
  // ═══════════════════════════════════════════════════════
  useEffect(() => {
    if (!isRunning) return;

    const newOrders = generateProOrders({
      positions: positionsRef.current,
      pending: pendingRef.current,
      evaluations,
      signalsBySymbol,
      minConfidence,
      executionDelaySec: config.executionDelaySec,
      dailyDrawdownPercent,
      weeklyDrawdownPercent,
      cash: cashRef.current,
      initialAmount: config.initialAmount,
      riskLevel,
      exitCooldown: exitCooldownRef.current,
      priceFor: priceForRef.current,
      maxPositions: config.maxPositions || 7
    });

    if (newOrders.length) setPending((prev) => [...prev, ...newOrders]);
    setLastEvaluation(new Date().toLocaleTimeString('he-IL'));
    setNextTickAt(Date.now() + 5000);
  }, [isRunning, evaluations, signalsBySymbol, minConfidence, heartbeat, dailyDrawdownPercent, weeklyDrawdownPercent, config, riskLevel]);

  useEffect(() => {
    if (!isRunning) return;
    setNextTickAt(Date.now() + 5000);
  }, [isRunning]);

  useBackgroundWorker({
    enabled: isRunning,
    intervalMs: 5000,
    onTick: () => {
      setHeartbeat((h) => h + 1);
      setNextTickAt(Date.now() + 5000);

      const now = Date.now();
      const timeStr = new Date(now).toLocaleTimeString('he-IL');
      const equityNow = cashRef.current + positionsRef.current.reduce((sum, p) => {
        const live = priceForRef.current(p.symbol) ?? p.currentPrice;
        return sum + p.quantity * live;
      }, 0);

      setHistory((prev) => {
        const next = [...prev, { timestamp: timeStr, at: now, portfolio: equityNow }];
        return next.length > 720 ? next.slice(-720) : next;
      });

      setHourlyHistory((prev) => {
        const last = prev[prev.length - 1];
        const lastHour = last ? Math.floor(last.at / (60 * 60 * 1000)) : -1;
        const currentHour = Math.floor(now / (60 * 60 * 1000));
        if (currentHour > lastHour) {
          const next = [...prev, { timestamp: timeStr, at: now, portfolio: equityNow }];
          return next.length > 168 ? next.slice(-168) : next;
        }
        return prev;
      });
    }
  });

  // ═══════════════════════════════════════════════════════
  // 2. Execution Engine (Realistic Slippage & Fees) — identical mechanics to
  // the other bots (fillDueOrders from simExecution.ts).
  // ═══════════════════════════════════════════════════════
  useEffect(() => {
    if (!isRunning) return;

    const tick = () => {
      const { due, expired } = selectFillableOrders(pendingRef.current, Date.now(), priceForRef.current);
      if (expired.length) {
        const expiredIds = new Set(expired.map((o) => o.id));
        setPending((prev) => prev.filter((o) => !expiredIds.has(o.id)));
      }
      if (!due.length) return;

      const result = fillDueOrders(due, cashRef.current, positionsRef.current, priceForRef.current, formatDynamicPrice, {
        // configRef, not config: this effect owns a 1s interval keyed on
        // isRunning alone, so reading config directly would either restart the
        // timer on every edit or silently fill at the costs that were set when
        // the bot started.
        feePercent: configRef.current.feePercent,
        slippagePercent: configRef.current.slippagePercent
      });

      const dueIds = new Set(due.map((o) => o.id));
      setPending((prev) => prev.filter((o) => !dueIds.has(o.id)));

      if (result.newTrades.length) {
        setCash(result.cash);
        setPositions(result.positions);
        setTrades((prev) => [...result.newTrades.reverse(), ...prev].slice(0, 100));
        setTotalFees((f) => f + result.feesAdded);
        setTotalSlippageCost((s) => s + result.slipAdded);
        Object.assign(exitCooldownRef.current, result.newCooldowns);
        // Unlike the server engine, the browser sim has no Telegram wiring —
        // result.events is intentionally unused here.
      }
    };

    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [isRunning]);

  useEffect(() => {
    if (!cryptoData?.length) return;
    setPositions((prev) =>
      prev.map((p) => {
        const live = priceFor(p.symbol) ?? p.currentPrice;
        return {
          ...p,
          currentPrice: live,
          highestPrice: Math.max(p.highestPrice || p.entryPrice, live),
          lowestPrice: Math.min(p.lowestPrice || p.entryPrice, live)
        };
      })
    );
  }, [cryptoData, priceFor]);

  const wins = closedTrades.filter((t) => (t.pnl ?? 0) > 0).length;
  const winRate = closedTrades.length ? (wins / closedTrades.length) * 100 : 0;

  const displayHistory = useMemo(() => {
    const map = new Map<number, SimPoint>();
    [...hourlyHistory, ...history].forEach((p) => {
      const key = Math.floor(p.at / 60_000);
      map.set(key, p);
    });
    return Array.from(map.values()).sort((a, b) => a.at - b.at);
  }, [hourlyHistory, history]);

  return {
    cash, positions, positionsValue, equity, trades, history: displayHistory, pending,
    totalFees, totalSlippageCost, winRate, totalTrades: trades.length, closedTrades: closedTrades.length,
    lastEvaluation, evaluations, reset, minConfidence: minConfidence ?? SIM_MIN_CONFIDENCE.pro, hasSavedSession, nextTickAt,
    totalLeveragedExposureUsd: 0, dailyDrawdownPercent, weeklyDrawdownPercent,
    candleCount: Object.keys(candlesBySymbol).length
  };
}
