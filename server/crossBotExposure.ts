/**
 * Cross-bot symbol concentration cap — sim bots only.
 * ============================================================================
 * Each of the four sim bots (intraday / pro / path / bybit) enforces
 * PER_ASSET_EXPOSURE_CAP_PERCENT (10%) against its OWN equity, independently.
 * Nothing stops all four from opening the same symbol at once — each bot's
 * `positions` array lives in its own closure (see simEngineFactory.ts) and
 * none of them can see what the others hold.
 *
 * Observed 2026-09-15: LA opened in Path, Pro and Bybit simultaneously and
 * lost -$90.56 combined (48% of that session's total loss) when it broke down
 * — three independently-approved 10% positions turning into one correlated
 * 30%+ bet the risk model never saw as a single position.
 *
 * All four sim engines run as separate polling loops inside ONE Node process
 * (server/tradingWorker.ts), so a synchronous in-memory registry is enough —
 * no IPC, no shared KV, no race condition beyond what a single-threaded event
 * loop already serializes. The REAL trading bot does not go through
 * `createGenericSimEngine` and never touches this module.
 */

/** At most this many of the four sim bots may hold an open position in the
 *  same symbol at once. 2, not 1: two bots independently agreeing on a symbol
 *  is a normal correlation of signals; three or more is the concentration
 *  that turned one bad breakdown into the dominant share of a session's loss. */
export const CROSS_BOT_MAX_HOLDERS_PER_SYMBOL = 2;

const heldSymbolsByBot = new Map<string, ReadonlySet<string>>();

/** Called once per tick by each bot with its OWN currently open symbols
 *  (before this tick's new entries). Overwrites this bot's previous entry —
 *  never accumulates across ticks, so a closed position stops counting
 *  immediately rather than needing an explicit "unregister". */
export function registerBotHoldings(botId: string, symbols: Iterable<string>): void {
  heldSymbolsByBot.set(botId, new Set(symbols));
}

/** How many bots OTHER than `excludeBotId` currently hold `symbol`. */
export function countOtherBotsHolding(symbol: string, excludeBotId: string): number {
  let count = 0;
  for (const [botId, symbols] of heldSymbolsByBot) {
    if (botId !== excludeBotId && symbols.has(symbol)) count++;
  }
  return count;
}

/** Bot ids (other than `excludeBotId`) currently holding `symbol` — for the
 *  rejection log line, so a blocked entry names who is already in it. */
export function otherBotsHolding(symbol: string, excludeBotId: string): string[] {
  const out: string[] = [];
  for (const [botId, symbols] of heldSymbolsByBot) {
    if (botId !== excludeBotId && symbols.has(symbol)) out.push(botId);
  }
  return out.sort();
}

/** True when `excludeBotId` opening `symbol` would put MORE than
 *  CROSS_BOT_MAX_HOLDERS_PER_SYMBOL bots into it at once. A bot that already
 *  holds the symbol itself is never blocked from being one of the holders it
 *  is compared against — this only gates a NEW entry, and the per-symbol "one
 *  position per bot" rule elsewhere already prevents a bot from opening a
 *  second position in a symbol it holds. */
export function wouldExceedCrossBotCap(symbol: string, excludeBotId: string): boolean {
  return countOtherBotsHolding(symbol, excludeBotId) >= CROSS_BOT_MAX_HOLDERS_PER_SYMBOL;
}

/** Test-only: drop all registered state between test cases. */
export function _resetCrossBotExposureForTests(): void {
  heldSymbolsByBot.clear();
}
