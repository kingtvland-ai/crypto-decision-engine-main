/**
 * Volatility Profile store — the ONE place the worker touches disk for this
 * module. Loads data/volatility-profiles/volatility-profiles.json once at
 * process start and caches it for the process's lifetime.
 * ============================================================================
 * `packages/engine/src/services/volatilityProfile.ts` does no I/O by design
 * (it's also bundled into the browser build via `src/`), so file access has
 * to live here, server-side, and get handed down as a plain `Map` to
 * whichever sim engine needs it.
 *
 * NEVER throws and NEVER blocks startup: a missing or corrupt file logs once
 * and leaves the store empty, which makes every lookup PROFILE_NOT_FOUND —
 * every bot then falls back to its own existing SL/TP computation
 * unchanged, exactly the same fallback used for a symbol with no compiled
 * profile at all.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadVolatilityProfiles, type VolatilityProfile } from '@cde/engine/volatility';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Two candidate paths, tried in order:
 *   - bundled (`node server/dist/worker.js`, esbuild inlines this module —
 *     `import.meta.url` then resolves to `server/dist/worker.js`): two
 *     levels up from __dirname is the repo root.
 *   - dev (`npx tsx tradingWorker.ts` inside server/, unbundled — this
 *     file's own `import.meta.url` is `server/volatilityProfileStore.ts`):
 *     one level up is the repo root.
 * Mirrors the same __dirname-relative convention `kvStore.ts` already uses
 * for `server/.data`.
 */
const CANDIDATE_PATHS = [
  path.join(__dirname, '..', '..', 'data', 'volatility-profiles', 'volatility-profiles.json'),
  path.join(__dirname, '..', 'data', 'volatility-profiles', 'volatility-profiles.json')
];

let cachedProfiles: Map<string, VolatilityProfile> | null = null;

function loadFromDisk(): Map<string, VolatilityProfile> {
  for (const candidate of CANDIDATE_PATHS) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const text = fs.readFileSync(candidate, 'utf8');
      const profiles = loadVolatilityProfiles(text);
      console.log(`[volatility-profile-store] loaded ${profiles.size} profiles from ${candidate}`);
      return profiles;
    } catch (e) {
      console.warn(
        `[volatility-profile-store] failed to load ${candidate}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
  console.warn(
    '[volatility-profile-store] volatility-profiles.json not found in any candidate path — ' +
    'every symbol falls back to its existing SL/TP computation.'
  );
  return new Map();
}

/** Lazily loads (once) and returns the cached profile store. Safe to call
 *  from any sim/live engine — repeated calls never re-read the file. */
export function getVolatilityProfileStore(): Map<string, VolatilityProfile> {
  if (!cachedProfiles) cachedProfiles = loadFromDisk();
  return cachedProfiles;
}
