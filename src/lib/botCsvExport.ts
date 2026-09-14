/**
 * CSV export for the four simulation bots — comparison + full trade log.
 * ============================================================================
 * Pure (except `downloadCsv`, which touches the DOM) so the column contract and
 * the exit-reason classifier are testable without a browser.
 *
 * Two different shapes, two different files — deliberately NOT one CSV with
 * mixed schemas, which no spreadsheet can pivot:
 *   · comparison — one row per bot: capital, P&L, win rate, COST CONFIG, and a
 *     count + P&L per exit reason.
 *   · trade log  — one row per fill across all four bots, carrying the FULL
 *     exit reason text.
 *
 * The cost-config columns are in the comparison on purpose. The four bots'
 * fee/slippage/limit-entry settings are operator-editable and have drifted
 * apart more than once (2026-09-10: feePercent 0.001 vs 0.1; 2026-09-11:
 * intraday slippage 0.5 vs 0.05 on the other three). A comparison that does
 * not show the cost model each row was produced under is not a comparison.
 */

export interface CsvTrade {
  symbol: string;
  side: string;
  price?: number;
  usdValue?: number;
  quantity?: number;
  timestamp?: string;
  at?: number;
  reason?: string;
  pnl?: number;
  pnlPercent?: number;
  slippagePercent?: number;
  fee?: number;
  confidence?: number;
}

export interface CsvBot {
  label: string;
  isRunning?: boolean;
  equity: number;
  cash: number;
  positionsValue: number;
  positions: Array<unknown>;
  trades: CsvTrade[];
  totalFees: number;
  totalSlippageCost: number;
  totalFunding?: number;
  winRate: number;
  totalTrades: number;
  closedTrades: number;
  config: {
    initialAmount: number;
    feePercent?: number;
    slippagePercent?: number;
    proLimitEntries?: boolean;
    riskLevel?: string;
    maxPositions?: number;
  };
}

/** The exit-reason buckets, in the order they appear as CSV columns. */
export const EXIT_REASON_KEYS = [
  'Stop Loss',
  'סולם — מימוש 30%',
  'סולם — סגירה מלאה',
  'Break-even',
  'TP1',
  'TP2',
  'Trailing',
  'Time stop',
  'היפוך מגמה',
  'אחר'
] as const;
export type ExitReasonKey = (typeof EXIT_REASON_KEYS)[number];

/**
 * One exit reason → one bucket. Order matters: "Break-even stop אחרי TP1"
 * contains both "Break-even" and "TP1", and it is a break-even exit, so that
 * test runs first. Likewise an emergency 4.2% cap exit is a stop.
 */
export function classifyExitReason(reason: string | undefined): ExitReasonKey {
  const r = reason ?? '';
  // The profit ratchet (2026-09-14) is the sim bots' only profit exit, and its
  // two verdicts are the numbers the operator actually watches — so they get
  // their own buckets ahead of everything else. Its reason string contains
  // "מימוש 30%", which the generic TP1/"יציאה חלקית" test below would otherwise
  // swallow.
  if (/^סולם רווח/.test(r)) {
    return /סגירה מלאה/.test(r) ? 'סולם — סגירה מלאה' : 'סולם — מימוש 30%';
  }
  if (/break-?even/i.test(r)) return 'Break-even';
  if (/trailing/i.test(r)) return 'Trailing';
  if (/stop loss|תקרת הפסד|יציאת חירום|סטופ/i.test(r)) return 'Stop Loss';
  if (/TP2/.test(r)) return 'TP2';
  if (/TP1|יציאה חלקית/.test(r)) return 'TP1';
  if (/time stop|משך החזקה|יציאת זמן|4 שעות/i.test(r)) return 'Time stop';
  if (/היפוך/.test(r)) return 'היפוך מגמה';
  return 'אחר';
}

/** Closed-position fills only — an entry carries no pnl. */
const exitsOf = (bot: CsvBot) => bot.trades.filter((t) => typeof t.pnl === 'number');

export interface ExitReasonTally {
  key: ExitReasonKey;
  count: number;
  pnl: number;
}

/** Count + summed P&L per exit reason, every bucket present (0 when unused). */
export function tallyExitReasons(trades: CsvTrade[]): ExitReasonTally[] {
  const byKey = new Map<ExitReasonKey, ExitReasonTally>(
    EXIT_REASON_KEYS.map((key) => [key, { key, count: 0, pnl: 0 }])
  );
  for (const t of trades) {
    if (typeof t.pnl !== 'number') continue;
    const row = byKey.get(classifyExitReason(t.reason))!;
    row.count += 1;
    row.pnl += t.pnl;
  }
  return [...byKey.values()];
}

/** RFC-4180 field: quote when it holds a comma, quote or newline; "" escapes ". */
function cell(value: unknown): string {
  if (value === undefined || value === null) return '';
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const rows = (data: unknown[][]): string => data.map((r) => r.map(cell).join(',')).join('\r\n');

/** Excel only reads a UTF-8 CSV as UTF-8 when it starts with a BOM — without
 *  it every Hebrew exit reason opens as mojibake. */
const BOM = '﻿';

const num = (n: number | undefined, dp = 2) =>
  typeof n === 'number' && Number.isFinite(n) ? Number(n.toFixed(dp)) : '';

/** One row per bot: capital, P&L, win rate, cost config, exit-reason tallies. */
export function buildBotComparisonCsv(bots: CsvBot[]): string {
  const header = [
    'בוט', 'פעיל', 'הון התחלתי', 'שווי תיק', 'מזומן', 'שווי פוזיציות', 'פוזיציות פתוחות',
    'רווח/הפסד $', 'רווח/הפסד %', 'ממומש $', 'לא ממומש $',
    'עסקאות סה"כ', 'נסגרו', 'רווחיות', 'מפסידות', 'אחוז הצלחה',
    'עמלות $', 'החלקה $', 'פאנדינג $',
    'feePercent', 'slippagePercent', 'כניסת לימיט', 'פרופיל סיכון', 'מקס׳ פוזיציות',
    ...EXIT_REASON_KEYS.flatMap((k) => [`${k} — כמות`, `${k} — רווח $`])
  ];

  const body = bots.map((b) => {
    const exits = exitsOf(b);
    const realized = exits.reduce((s, t) => s + (t.pnl as number), 0);
    const pnl = b.equity - b.config.initialAmount;
    const wins = exits.filter((t) => (t.pnl as number) > 0).length;
    const losses = exits.filter((t) => (t.pnl as number) < 0).length;
    const tally = tallyExitReasons(b.trades);
    return [
      b.label,
      b.isRunning ? 'כן' : 'לא',
      num(b.config.initialAmount),
      num(b.equity),
      num(b.cash),
      num(b.positionsValue),
      b.positions.length,
      num(pnl),
      num(b.config.initialAmount ? (pnl / b.config.initialAmount) * 100 : 0),
      num(realized),
      num(pnl - realized),
      b.totalTrades,
      b.closedTrades,
      wins,
      losses,
      num(b.winRate, 1),
      num(b.totalFees),
      num(b.totalSlippageCost),
      num(b.totalFunding ?? 0),
      b.config.feePercent ?? '',
      b.config.slippagePercent ?? '',
      b.config.proLimitEntries ? 'כן' : 'לא',
      b.config.riskLevel ?? '',
      b.config.maxPositions ?? '',
      ...tally.flatMap((t) => [t.count, num(t.pnl)])
    ];
  });

  return BOM + rows([header, ...body]);
}

/** One row per fill across every bot, carrying the FULL exit reason. */
export function buildTradeLogCsv(bots: CsvBot[]): string {
  const header = [
    'בוט', 'זמן', 'חותמת זמן', 'מטבע', 'צד', 'סוג רשומה',
    'מחיר', 'כמות', 'שווי $', 'החלקה %', 'עמלה $', 'ביטחון',
    'רווח/הפסד $', 'רווח/הפסד %', 'קטגוריית יציאה', 'סיבה מלאה'
  ];

  const body = bots.flatMap((b) =>
    [...b.trades]
      .sort((x, y) => (x.at ?? 0) - (y.at ?? 0))
      .map((t) => {
        const isExit = typeof t.pnl === 'number';
        return [
          b.label,
          t.timestamp ?? '',
          typeof t.at === 'number' ? new Date(t.at).toISOString() : '',
          t.symbol,
          t.side,
          t.side === 'partial_tp1' ? 'יציאה חלקית' : isExit ? 'יציאה' : 'כניסה',
          num(t.price, 8),
          num(t.quantity, 8),
          num(t.usdValue),
          num(t.slippagePercent, 4),
          num(t.fee, 4),
          num(t.confidence, 1),
          isExit ? num(t.pnl) : '',
          isExit ? num(t.pnlPercent) : '',
          isExit ? classifyExitReason(t.reason) : '',
          // Multi-line engine reasoning collapses to one cell — newlines would
          // otherwise split one trade across several CSV rows.
          (t.reason ?? '').replace(/\s*\n\s*/g, ' | ')
        ];
      })
  );

  return BOM + rows([header, ...body]);
}

/** `bots-comparison-2026-09-11T08-05.csv` — colons are illegal in filenames. */
export function csvFilename(prefix: string, now: Date = new Date()): string {
  return `${prefix}-${now.toISOString().slice(0, 16).replace(/[:]/g, '-')}.csv`;
}

/** Browser-only: hand the CSV to the user as a download. */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
