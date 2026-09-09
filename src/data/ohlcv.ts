// As-of OHLCV loader. This is the single choke point that prevents
// look-ahead. Execution convention (see engine/execution.ts): decisions for
// day D may only see bars dated STRICTLY BEFORE D (`asOfBefore`); orders for
// day D fill at D's own open (`openOn`); end-of-day mark-to-market uses D's
// own close (`closeOn`). Every caller (indicators, execution, baselines,
// agent tools) goes through one of these three functions — even though the
// full fixture file is loaded into memory, none of them ever hand back a bar
// the caller isn't causally entitled to yet.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { FIXTURES_DIR } from "../utils/paths.ts";
import type { OhlcvBar } from "../domain/types.ts";
import { validateBars } from "./dataset.ts";
import { assertDate } from "./calendar.ts";
export { loadDataset, validateDatasetWindow } from "./dataset.ts";
export type { MarketDataset, CorporateAction } from "./dataset.ts";

/** Legacy test-fixture label. New run identities use loadDataset().version,
 * a SHA-256 verified at load time. Importing this module performs no file I/O. */
export const FIXTURE_VERSION = "synthetic-v1-2024-01-02_2024-06-28-legacy";

const seriesCache = new Map<string, OhlcvBar[]>();
const calendarCache = new Map<string, string[]>();

async function loadSeries(ticker: string): Promise<OhlcvBar[]> {
  if (!/^[A-Z0-9][A-Z0-9.-]{0,15}$/.test(ticker)) throw new Error(`Invalid ticker: ${ticker}`);
  const cached = seriesCache.get(ticker);
  if (cached) return cached;
  const path = resolve(FIXTURES_DIR, `${ticker}.json`);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`No OHLCV fixture for ticker "${ticker}" at ${path}`, { cause: err });
  }
  const bars = validateBars(JSON.parse(raw), ticker);
  seriesCache.set(ticker, bars);
  return bars;
}

/** Bars with date <= asOfDate, optionally truncated to the last `lookback` entries. */
export async function asOf(ticker: string, asOfDate: string, lookback?: number): Promise<OhlcvBar[]> {
  const series = await loadSeries(ticker);
  assertDate(asOfDate);
  validateLookback(lookback);
  const eligible = series.filter((b) => b.date <= asOfDate).map(b => ({ ...b }));
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
  assertDate(asOfDate);
  validateLookback(lookback);
  const eligible = series.filter((b) => b.date < asOfDate).map(b => ({ ...b }));
  if (lookback === undefined || eligible.length <= lookback) return eligible;
  return eligible.slice(eligible.length - lookback);
}

/** The exact bar for a date, or undefined if the market wasn't open (fixture has no row). */
export async function barOn(ticker: string, date: string): Promise<OhlcvBar | undefined> {
  const series = await loadSeries(ticker);
  assertDate(date);
  const bar = series.find((b) => b.date === date);
  return bar ? { ...bar } : undefined;
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
  if (!universe.length || new Set(universe).size !== universe.length) throw new Error("Invalid universe");
  const key = [...universe].sort().join(",");
  const cached = calendarCache.get(key);
  if (cached) return [...cached];
  const first = await loadSeries(universe[0]!);
  const dates = first.map((b) => b.date);
  for (const ticker of universe.slice(1)) {
    const series = await loadSeries(ticker);
    const other = series.map((b) => b.date);
    if (other.length !== dates.length || other.some((d, i) => d !== dates[i])) {
      throw new Error(`Ticker "${ticker}" has a different trading calendar than "${universe[0]}"`);
    }
  }
  calendarCache.set(key, dates);
  return [...dates];
}

/** Test-only: clear module-level caches between fixture swaps. */
export function __resetCachesForTests(): void {
  seriesCache.clear();
  calendarCache.clear();
}

function validateLookback(lookback?: number): void {
  if (lookback !== undefined && (!Number.isSafeInteger(lookback) || lookback < 0)) throw new Error("lookback must be a nonnegative integer");
}
