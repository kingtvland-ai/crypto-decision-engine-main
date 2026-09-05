/**
 * Binance public data dumps — history by the month instead of by the page.
 * ============================================================================
 *
 * The snapshot commands used to page the REST kline endpoint: 1000 candles per
 * request, a courtesy sleep between pages, repeated per symbol and per
 * timeframe. For the 40-month, 16-symbol window the walk-forward study needs
 * that is tens of thousands of requests, and it is the reason "just measure it"
 * kept turning into an hour of waiting.
 *
 * Binance publishes the same candles as monthly ZIPs at data.binance.vision —
 * one request per symbol-month, no rate limit, no pagination. Same exchange,
 * same bars, no third-party data to reconcile.
 *
 * The ZIPs are read here rather than with a dependency: one CSV per archive,
 * either stored or deflated, is a few lines against `zlib.inflateRawSync`, and
 * a build that downloads history should not also grow an unzip library.
 */

import { inflateRawSync } from 'node:zlib';

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const BASE = 'https://data.binance.vision/data/spot/monthly/klines';

/**
 * Extracts the single file held in a Binance kline archive.
 *
 * Reads the central directory from the end of the archive rather than trusting
 * the local header: when a ZIP is written with a streaming data descriptor the
 * local header carries zeroes for both sizes, and a reader that believes them
 * silently returns an empty file.
 */
function unzipSingleFile(buf: Buffer): string {
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65_557; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory)');

  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cdOffset) !== 0x02014b50) throw new Error('bad central directory');

  const method = buf.readUInt16LE(cdOffset + 10);
  const compressedSize = buf.readUInt32LE(cdOffset + 20);
  const nameLen = buf.readUInt16LE(cdOffset + 28);
  const extraLen = buf.readUInt16LE(cdOffset + 30);
  const commentLen = buf.readUInt16LE(cdOffset + 32);
  const localOffset = buf.readUInt32LE(cdOffset + 42);
  void nameLen; void extraLen; void commentLen;

  // The local header's own name/extra lengths decide where the payload starts;
  // they are allowed to differ from the central directory's.
  const localNameLen = buf.readUInt16LE(localOffset + 26);
  const localExtraLen = buf.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + localNameLen + localExtraLen;
  const payload = buf.subarray(dataStart, dataStart + compressedSize);

  if (method === 0) return payload.toString('utf8');
  if (method === 8) return inflateRawSync(payload).toString('utf8');
  throw new Error(`unsupported zip compression method ${method}`);
}

/**
 * Parses a kline CSV.
 *
 * Two shape changes Binance has made that a naive parser gets wrong:
 *  · newer archives carry a header row, so a non-numeric first field is skipped
 *    rather than parsed into NaN;
 *  · open_time moved to MICROseconds in 2025 archives, which would place every
 *    bar ~50,000 years in the future and silently produce an empty backtest.
 */
function parseKlineCsv(csv: string): Candle[] {
  const out: Candle[] = [];
  for (const line of csv.split('\n')) {
    if (!line) continue;
    const f = line.split(',');
    if (f.length < 6) continue;
    let ts = Number(f[0]);
    if (!Number.isFinite(ts)) continue; // header row
    if (ts > 1e14) ts = Math.floor(ts / 1000);
    const candle: Candle = {
      timestamp: ts,
      open: Number(f[1]), high: Number(f[2]),
      low: Number(f[3]), close: Number(f[4]), volume: Number(f[5])
    };
    if (!Number.isFinite(candle.close) || candle.close <= 0) continue;
    out.push(candle);
  }
  return out;
}

/** Every YYYY-MM between two dates, inclusive of the month each falls in. */
export function monthsBetween(fromISO: string, toISO: string): string[] {
  const from = new Date(`${fromISO}T00:00:00Z`);
  const to = new Date(`${toISO}T00:00:00Z`);
  const months: string[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  while (cursor <= to) {
    months.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

async function fetchMonth(symbol: string, interval: string, month: string): Promise<Candle[]> {
  const url = `${BASE}/${symbol}/${interval}/${symbol}-${interval}-${month}.zip`;
  const res = await fetch(url);
  // A month before the pair listed, or the current month before it is archived,
  // is a 404. That is expected and not an error — the caller gets fewer bars.
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`${symbol} ${interval} ${month}: HTTP ${res.status}`);
  return parseKlineCsv(unzipSingleFile(Buffer.from(await res.arrayBuffer())));
}

/**
 * One symbol, one timeframe, a whole date range.
 *
 * Months are fetched with bounded concurrency: the archive host has no
 * documented rate limit, but opening forty sockets at once to save two seconds
 * is a good way to acquire one.
 */
export async function fetchBulkKlines(
  symbol: string,
  interval: '1h' | '15m' | '5m',
  fromISO: string,
  toISO: string,
  concurrency = 6
): Promise<Candle[]> {
  const months = monthsBetween(fromISO, toISO);
  const chunks: Candle[][] = new Array(months.length);

  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, months.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= months.length) return;
        chunks[i] = await fetchMonth(symbol, interval, months[i]);
      }
    })
  );

  const startMs = Date.parse(`${fromISO}T00:00:00Z`);
  const endMs = Date.parse(`${toISO}T00:00:00Z`);
  const out: Candle[] = [];
  for (const chunk of chunks) {
    if (!chunk) continue;
    for (const c of chunk) {
      if (c.timestamp >= startMs && c.timestamp < endMs) out.push(c);
    }
  }
  out.sort((a, b) => a.timestamp - b.timestamp);
  return out;
}
