/**
 * Single source of truth for reading the saved Worker base URL — used by
 * tradingApiClient.ts, liveUniverse.ts, and WorkerAuthContext.tsx so the
 * resolution order (explicit > saved localStorage > build-time env) never
 * drifts between them. Written defensively (no direct `import.meta.env`
 * property access) because liveUniverse.ts is reachable from a Node
 * typecheck context (server/_smoke.ts -> bybitApi.ts) with no Vite types.
 */
export function resolveWorkerBaseUrl(configured?: string): string {
  const { url, source } = resolveWorkerBaseUrlWithSource(configured);
  return url;
}

export type UrlSource = 'manual' | 'localStorage' | 'env' | 'none';

/**
 * The production worker, hardcoded. This is ONLY for the public read-only board
 * (`/live`), which anyone with the link must be able to open — it cannot depend
 * on the operator's own localStorage or on a Netlify build variable that may
 * not be set. The endpoint it serves (`/api/public/bots-summary`) is tokenless
 * and read-only, so there is nothing secret about the address.
 *
 * Everything else in the app keeps using resolveWorkerBaseUrl() and stays
 * operator-configurable.
 */
export const DEFAULT_PUBLIC_WORKER_URL = 'https://cde-main.onrender.com';

/**
 * Ordered, de-duplicated candidates for the public board: whatever the operator
 * configured first (so a local worker still wins during development), the
 * hardcoded production worker last. The board walks the list until one answers,
 * which is what keeps a stale `workerConfig` in one person's browser from
 * breaking a page meant for everybody.
 */
export function resolvePublicBoardUrls(configured?: string): string[] {
  const preferred = resolveWorkerBaseUrl(configured);
  return [preferred, DEFAULT_PUBLIC_WORKER_URL].filter(
    (u, i, all) => !!u && all.indexOf(u) === i
  );
}

export function resolveWorkerBaseUrlWithSource(configured?: string): { url: string; source: UrlSource } {
  if (configured && configured.trim()) {
    return { url: configured.trim().replace(/\/$/, ''), source: 'manual' };
  }
  try {
    const saved = localStorage.getItem('workerConfig');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed.baseUrl && parsed.baseUrl.trim()) {
        return { url: parsed.baseUrl.trim().replace(/\/$/, ''), source: 'localStorage' };
      }
    }
  } catch { /* ignore */ }
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const fromEnv = env?.VITE_TRADING_API_URL;
  if (fromEnv && fromEnv.trim()) {
    return { url: fromEnv.trim().replace(/\/$/, ''), source: 'env' };
  }
  return { url: '', source: 'none' };
}
