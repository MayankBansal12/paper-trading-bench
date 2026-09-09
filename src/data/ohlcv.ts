// As-of OHLCV loader. This is the single choke point that prevents
// look-ahead. Execution convention (see engine/execution.ts): decisions for
// day D may only see bars dated STRICTLY BEFORE D (`asOfBefore`); orders for
// day D fill at D's own open (`openOn`); end-of-day mark-to-market uses D's
// own close (`closeOn`). Every caller (indicators, execution, baselines,
// agent tools) goes through one of these three functions — even though the
// full fixture file is loaded into memory, none of them ever hand back a bar
// the caller isn't causally entitled to yet.

import { readFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FIXTURES_DIR } from "../utils/paths.ts";
import type { OhlcvBar } from "../domain/types.ts";

/** Human label for the fixture generation this snapshot targets (date range,
 * generator version). Not the run-identity value by itself — see
 * FIXTURE_VERSION below, which folds in an actual content hash so identity
 * can never silently drift from what's on disk. */
const FIXTURE_LABEL = "synthetic-v1-2024-01-02_2024-06-28";

/** FNV-1a over every fixtures/ohlcv/*.json file's bytes, sorted by filename
 * for determinism. Computed synchronously at import time (51 small files,
 * negligible cost) so FIXTURE_VERSION stays a plain constant every caller
 * can use without awaiting anything. */
function hashFixtureBytes(): string {
  const files = readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  let h = 0x811c9dc5;
  for (const file of files) {
    const bytes = readFileSync(resolve(FIXTURES_DIR, file));
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i]!;
      h = Math.imul(h, 0x01000193);
    }
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Identifies this fixture snapshot: the human label PLUS a content hash of
 * every fixture file's actual bytes. Stored in RunConfig and folded into a
 * run's identity hash (run/state.ts) so regenerating/editing/replacing
 * fixtures with different bytes can never be silently conflated with an
 * existing run's data — unlike a manually-bumped string, this can't go
 * stale: editing a fixture file without remembering to bump a label still
 * changes FIXTURE_VERSION automatically. See fixtures/ohlcv/README.md. */
export const FIXTURE_VERSION = `${FIXTURE_LABEL}-${hashFixtureBytes()}`;

const seriesCache = new Map<string, OhlcvBar[]>();
let calendarCache: string[] | null = null;

async function loadSeries(ticker: string): Promise<OhlcvBar[]> {
  const cached = seriesCache.get(ticker);
  if (cached) return cached;
  const path = resolve(FIXTURES_DIR, `${ticker}.json`);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`No OHLCV fixture for ticker "${ticker}" at ${path}`, { cause: err });
  }
  const bars = JSON.parse(raw) as OhlcvBar[];
  // Defensive: fixtures must be ascending by date; enforce it once here so
  // every downstream consumer can assume sorted input.
  const sorted = [...bars].sort((a, b) => a.date.localeCompare(b.date));
  seriesCache.set(ticker, sorted);
  return sorted;
}

/** Bars with date <= asOfDate, optionally truncated to the last `lookback` entries. */
export async function asOf(ticker: string, asOfDate: string, lookback?: number): Promise<OhlcvBar[]> {
  const series = await loadSeries(ticker);
  const eligible = series.filter((b) => b.date <= asOfDate);
  if (lookback === undefined || eligible.length <= lookback) return eligible;
  return eligible.slice(eligible.length - lookback);
}

/**
 * Bars with date < asOfDate (STRICTLY before), optionally truncated to the
 * last `lookback` entries. This is what decision context (bars/indicators)
 * must use: day D's own bar is not observable until D's execution has
 * already happened, so agent input is built from `asOfBefore(ticker, D)`.
 */
export async function asOfBefore(ticker: string, asOfDate: string, lookback?: number): Promise<OhlcvBar[]> {
  const series = await loadSeries(ticker);
  const eligible = series.filter((b) => b.date < asOfDate);
  if (lookback === undefined || eligible.length <= lookback) return eligible;
  return eligible.slice(eligible.length - lookback);
}

/** The exact bar for a date, or undefined if the market wasn't open (fixture has no row). */
export async function barOn(ticker: string, date: string): Promise<OhlcvBar | undefined> {
  const series = await loadSeries(ticker);
  return series.find((b) => b.date === date);
}

/** Open price on `date` — the execution price for orders decided going into day D. Undefined (not throw) if no bar, so callers can turn a bad ticker/date into a FailedOrder instead of aborting. */
export async function openOn(ticker: string, date: string): Promise<number | undefined> {
  const bar = await barOn(ticker, date);
  return bar?.open;
}

/** Close price on `date`, throws if no bar exists (caller decided to trade on a bad date). */
export async function closeOn(ticker: string, date: string): Promise<number> {
  const bar = await barOn(ticker, date);
  if (!bar) throw new Error(`No bar for ${ticker} on ${date}`);
  return bar.close;
}

/**
 * The full trading calendar, derived from the fixture data itself (all
 * tickers share one synthetic calendar for v0 — see fixtures/ohlcv/README.md).
 * Validates that every ticker actually shares that calendar, so a future
 * data-source swap with per-ticker gaps fails loudly instead of silently
 * mis-valuing a day.
 */
export async function calendarDates(universe: readonly string[]): Promise<string[]> {
  if (calendarCache) return calendarCache;
  const first = await loadSeries(universe[0]!);
  const dates = first.map((b) => b.date);
  for (const ticker of universe.slice(1)) {
    const series = await loadSeries(ticker);
    const other = series.map((b) => b.date);
    if (other.length !== dates.length || other.some((d, i) => d !== dates[i])) {
      throw new Error(`Ticker "${ticker}" has a different trading calendar than "${universe[0]}"`);
    }
  }
  calendarCache = dates;
  return dates;
}

/** Test-only: clear module-level caches between fixture swaps. */
export function __resetCachesForTests(): void {
  seriesCache.clear();
  calendarCache = null;
}
