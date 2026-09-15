/**
 * Volatility Profile calibration script.
 * ============================================================================
 * Reads data/volatility-profiles/monthly-results.csv (24 months of
 * closed-1H-candle excursion data per Bybit spot/linear symbol) and compiles
 * data/volatility-profiles/volatility-profiles.json — the ONLY file the
 * trading runtime reads for volatility context.
 *
 * This lives under data/ (tracked in git) rather than ASSETS/ (gitignored —
 * see .gitignore's "raw exchange data pasted in for analysis, not tracked"
 * note) precisely because the compiled profile and its calibration source
 * ARE meant to be committed and reviewed, per the spec's §24 requirement.
 *
 * Deterministic: the same monthly-results.csv always produces the same
 * `profiles` object, byte for byte, except the `generatedAt` timestamp. No
 * randomization, no network calls, no LLM.
 *
 * Run: npx tsx scripts/generateVolatilityProfiles.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildVolatilityProfiles,
  parseMonthlyResultsCsv,
  MIN_PROFILE_MONTHS,
  type VolatilityProfilesFile
} from '@cde/engine/volatility';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const INPUT_FILE = path.join(ROOT, 'data', 'volatility-profiles', 'monthly-results.csv');
const OUTPUT_FILE = path.join(ROOT, 'data', 'volatility-profiles', 'volatility-profiles.json');

const VERSION = '1.0.0';

function main(): void {
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`ERROR: input file not found: ${INPUT_FILE}`);
    process.exit(1);
  }

  const csvText = fs.readFileSync(INPUT_FILE, 'utf8');
  const rows = parseMonthlyResultsCsv(csvText);
  if (!rows.length) {
    console.error('ERROR: no usable rows parsed from monthly-results.csv');
    process.exit(1);
  }

  const profileMap = buildVolatilityProfiles(rows);

  const skipped: string[] = [];
  const totalGroups = new Set(rows.map((r) => `${r.category}:${r.symbol}`));
  for (const key of totalGroups) {
    if (!profileMap.has(key)) skipped.push(key);
  }

  const profiles: VolatilityProfilesFile['profiles'] = {};
  for (const [key, profile] of [...profileMap.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    profiles[key] = profile;
  }

  const file: VolatilityProfilesFile = {
    version: VERSION,
    timeframe: '1H',
    historyMonths: MIN_PROFILE_MONTHS,
    generatedAt: new Date().toISOString(),
    profiles
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(file, null, 2) + '\n', 'utf8');

  console.log(`Volatility profiles written: ${OUTPUT_FILE}`);
  console.log(`  Symbols with a compiled profile: ${profileMap.size}`);
  if (skipped.length) {
    console.log(`  Skipped (PROFILE_INSUFFICIENT_HISTORY, < ${MIN_PROFILE_MONTHS} months): ${skipped.join(', ')}`);
  }
}

main();
