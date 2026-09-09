// Centralized filesystem paths. One source of truth so no file hand-rolls a path.

import { relative, resolve } from "node:path";

/** Project root — directory containing package.json. */
export const PROJECT_ROOT = resolve(import.meta.dir, "..", "..");

export const FIXTURES_DIR = resolve(PROJECT_ROOT, "fixtures", "ohlcv");
export const RESULTS_DIR = resolve(PROJECT_ROOT, "results");
export const RUNS_DIR = resolve(RESULTS_DIR, "runs");
export const REPORTS_DIR = resolve(RESULTS_DIR, "reports");

/** Alphanumeric plus `_`/`-` only, 1-128 chars, no leading separator — rules
 * out path separators, `..`, and absolute paths (e.g. a malicious or
 * fat-fingered `--run-id=/tmp/escape`). */
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Isolated directory for one (model, seed, runId) tuple. Validates that
 * runId is a safe path segment AND that the resolved directory still lands
 * under RUNS_DIR — the latter is a backstop against any input (including a
 * pathological model id) resolving outside results/runs. */
export function runDir(model: string, seed: number, runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`Invalid --run-id "${runId}": must match ${RUN_ID_PATTERN.source} (alphanumeric, "_"/"-" only, no path separators).`);
  }
  const dir = resolve(RUNS_DIR, sanitize(model), `seed-${seed}`, runId);
  const rel = relative(RUNS_DIR, dir);
  if (rel === "" || rel.startsWith("..") || resolve(RUNS_DIR, rel) !== dir) {
    throw new Error(`Resolved run directory "${dir}" escapes ${RUNS_DIR}.`);
  }
  return dir;
}

export function runConfigFile(dir: string): string {
  return resolve(dir, "config.json");
}
export function runStateFile(dir: string): string {
  return resolve(dir, "state.json");
}
export function runTransactionsFile(dir: string): string {
  return resolve(dir, "transactions.jsonl");
}
export function runDailyFile(dir: string, date: string): string {
  return resolve(dir, "daily", `${date}.json`);
}
export function runSummaryFile(dir: string): string {
  return resolve(dir, "summary.json");
}

/** Filesystem-safe path segment (models/tickers can contain '.', ':', '/'). */
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, "_");
}
