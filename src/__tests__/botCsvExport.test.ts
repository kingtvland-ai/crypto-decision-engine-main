/**
 * CSV export — exit-reason classifier + the two file shapes.
 * ============================================================================
 * The classifier is shared by the export and the in-UI exit-reason panel, so a
 * miscategorised reason would make the screen and the file disagree. These
 * tests pin the buckets against the ACTUAL reason strings the four engines
 * emit (copied from live worker trade logs).
 */

import { describe, it, expect } from 'vitest';
import {
  classifyExitReason,
  tallyExitReasons,
  buildBotComparisonCsv,
  buildTradeLogCsv,
  csvFilename,
  EXIT_REASON_KEYS,
  type CsvBot,
  type CsvTrade
} from '@/lib/botCsvExport';

describe('classifyExitReason — real strings from the engines', () => {
  it('stop-outs, including the emergency 4.2% cap', () => {
    expect(classifyExitReason('Stop Loss ב-$1.0624 (מחיר $1.0579)')).toBe('Stop Loss');
    expect(classifyExitReason('Stop Loss ב-0.0076 (-1.64%, תקרה 4.2%)')).toBe('Stop Loss');
    expect(classifyExitReason('חריגת תקרת הפסד 4.2% בתוך נר — יציאת חירום (-4.30%)')).toBe('Stop Loss');
  });

  it('break-even wins over the TP1 text it also contains', () => {
    // "Break-even stop אחרי TP1" holds both tokens — it is a break-even exit.
    expect(classifyExitReason('Break-even stop אחרי TP1 ב-0.149259 (שינוי 0.01%)')).toBe('Break-even');
  });

  it('trailing wins over the stop text it also contains', () => {
    expect(classifyExitReason('Trailing Stop ב-$0.14843 (MFE 1.99R)')).toBe('Trailing');
  });

  it('targets', () => {
    expect(classifyExitReason('TP1 ב-0.149259 — סגירת 50% והפעלת Trailing')).toBe('Trailing');
    expect(classifyExitReason('TP1 הושג ב-0.000003432 (+2.53%) — סגירת 50%')).toBe('TP1');
    expect(classifyExitReason('TP2 הושג ב-0.6557 (+4.75%)')).toBe('TP2');
  });

  it('time stops, in all four engines\' wordings', () => {
    expect(classifyExitReason('משך החזקה מקסימלי (90 דק\') — יציאת זמן')).toBe('Time stop');
    expect(classifyExitReason('Time Stop: אחרי 63.1 דק\' התקדמות -0.24R < 0.3R')).toBe('Time stop');
    expect(classifyExitReason('יציאה אחרי 4 שעות (time stop)')).toBe('Time stop');
  });

  it('trend reversal, and an unknown string falls through to אחר', () => {
    expect(classifyExitReason('היפוך מגמה — H1 Supertrend התהפך ל-BULL')).toBe('היפוך מגמה');
    expect(classifyExitReason('something nobody has written yet')).toBe('אחר');
    expect(classifyExitReason(undefined)).toBe('אחר');
  });
});

describe('tallyExitReasons', () => {
  const trades: CsvTrade[] = [
    { symbol: 'A', side: 'buy' }, // entry — no pnl, must not be counted
    { symbol: 'A', side: 'close_long', pnl: -10, reason: 'Stop Loss ב-1' },
    { symbol: 'B', side: 'close_long', pnl: -5, reason: 'Stop Loss ב-2' },
    { symbol: 'C', side: 'partial_tp1', pnl: 7, reason: 'TP1 הושג ב-3 — סגירת 50%' }
  ];

  it('counts and sums P&L per bucket, ignoring entries', () => {
    const t = tallyExitReasons(trades);
    const by = Object.fromEntries(t.map((r) => [r.key, r]));
    expect(by['Stop Loss'].count).toBe(2);
    expect(by['Stop Loss'].pnl).toBeCloseTo(-15, 6);
    expect(by['TP1'].count).toBe(1);
    expect(by['TP1'].pnl).toBeCloseTo(7, 6);
  });

  it('always returns every bucket so the columns are stable', () => {
    expect(tallyExitReasons([]).map((r) => r.key)).toEqual([...EXIT_REASON_KEYS]);
    expect(tallyExitReasons([]).every((r) => r.count === 0 && r.pnl === 0)).toBe(true);
  });
});

// ── the two files ────────────────────────────────────────────────────────────

const bot = (over: Partial<CsvBot> = {}): CsvBot => ({
  label: 'מנוע חדש',
  isRunning: true,
  equity: 9850.37,
  cash: 5000,
  positionsValue: 4850.37,
  positions: [{}, {}],
  trades: [
    { symbol: 'ENA', side: 'buy', price: 0.14683, usdValue: 500, at: 2, timestamp: '17:09:31', reason: 'entry\nline two' },
    { symbol: 'ENA', side: 'close_long', price: 0.145, usdValue: 500, at: 3, timestamp: '17:40:00', pnl: -6.2, pnlPercent: -1.24, reason: 'Stop Loss ב-0.145' }
  ],
  totalFees: 1.69,
  totalSlippageCost: 187.32,
  totalFunding: 0,
  winRate: 27.3,
  totalTrades: 21,
  closedTrades: 11,
  config: { initialAmount: 10000, feePercent: 0.01, slippagePercent: 0.5, proLimitEntries: false, riskLevel: 'high', maxPositions: 7 },
  ...over
});

describe('buildBotComparisonCsv', () => {
  const csv = buildBotComparisonCsv([bot()]);
  const lines = csv.split('\r\n');

  it('starts with a UTF-8 BOM so Excel reads the Hebrew', () => {
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it('one header + one row per bot', () => {
    expect(lines).toHaveLength(2);
  });

  it('carries the cost config — the columns that explain a drifted comparison', () => {
    expect(lines[0]).toContain('feePercent');
    expect(lines[0]).toContain('slippagePercent');
    expect(lines[0]).toContain('כניסת לימיט');
    expect(lines[1]).toContain('0.01');
    expect(lines[1]).toContain('0.5');
  });

  it('P&L is equity − initial, and realized comes from the closed fills', () => {
    const cells = lines[1].split(',');
    expect(cells).toContain('-149.63'); // 9850.37 − 10000
    expect(cells).toContain('-6.2');    // realized
  });

  it('has a count + P&L column pair for every exit-reason bucket', () => {
    for (const k of EXIT_REASON_KEYS) {
      expect(lines[0]).toContain(`${k} — כמות`);
      expect(lines[0]).toContain(`${k} — רווח $`);
    }
  });
});

describe('buildTradeLogCsv', () => {
  const csv = buildTradeLogCsv([bot()]);
  const lines = csv.split('\r\n');

  it('one row per fill — entries included', () => {
    expect(lines).toHaveLength(3); // header + entry + exit
  });

  it('a multi-line engine reason collapses to ONE cell, never extra rows', () => {
    expect(csv).not.toMatch(/\n\s*line two/);
    expect(csv).toContain('entry | line two');
  });

  it('the exit row carries both the bucket and the full reason text', () => {
    expect(lines[2]).toContain('Stop Loss');
    expect(lines[2]).toContain('Stop Loss ב-0.145');
  });

  it('quotes a field containing a comma rather than splitting it', () => {
    const withComma = buildTradeLogCsv([bot({
      trades: [{ symbol: 'X', side: 'close_long', pnl: 1, at: 1, reason: 'Stop Loss, ב-1.5' }]
    })]);
    expect(withComma).toContain('"Stop Loss, ב-1.5"');
  });
});

describe('csvFilename', () => {
  it('is filesystem-safe — no colons from the ISO timestamp', () => {
    const name = csvFilename('bots-comparison', new Date('2026-09-11T08:05:00Z'));
    expect(name).toBe('bots-comparison-2026-09-11T08-05.csv');
    expect(name).not.toContain(':');
  });
});

describe('profit-ratchet exit reasons (2026-09-14)', () => {
  const partial = 'סולם רווח: חזרה למדרגה 4% (שיא +4.20%, כעת +4.00%) — מימוש 30%';
  const full = 'סולם רווח: חזרה למדרגה 1.8% (שיא +2.50%, כעת +1.80%) — סגירה מלאה';

  it('gets its own buckets rather than falling into TP1 or אחר', () => {
    expect(classifyExitReason(partial)).toBe('סולם — מימוש 30%');
    expect(classifyExitReason(full)).toBe('סולם — סגירה מלאה');
  });

  it('does not steal the legacy buckets', () => {
    expect(classifyExitReason('TP1 הושג ב-3 — סגירת 50%')).toBe('TP1');
    expect(classifyExitReason('Stop Loss ב-97.7')).toBe('Stop Loss');
  });
});
