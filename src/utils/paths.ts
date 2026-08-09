// Centralized filesystem paths. One source of truth so no file hand-rolls a path.
// All paths are absolute and resolved against RESULTS_DIR (which lives at the
// project root, beside package.json).

import { resolve } from "node:path";

/** Project root — directory containing package.json. */
export const PROJECT_ROOT = resolve(import.meta.dir, "..", "..");

/** Where the benchmark reads/writes all runtime state. */
export const RESULTS_DIR = resolve(PROJECT_ROOT, "results");

export const PORTFOLIO_FILE = resolve(RESULTS_DIR, "portfolio-state.json");
export const TRANSACTIONS_FILE = resolve(RESULTS_DIR, "transactions.txt");
export const PRICE_CACHE_FILE = resolve(RESULTS_DIR, ".price-cache.json");
export const SUMMARIES_DIR = resolve(RESULTS_DIR, "summaries");
export const TRACES_DIR = resolve(RESULTS_DIR, "traces");
