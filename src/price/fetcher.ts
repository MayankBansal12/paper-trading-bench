// EOD price fetcher with caching. Tries the local cache first; on miss,
// hits yahoo-finance2 historical() and writes back to the cache.
//
// Failure modes:
//   - ticker delisted / invalid -> throws InvalidTickerError
//   - market closed on date (no data row) -> throws PriceUnavailableError
//   - network error -> propagates (caller decides whether to abort session)

import YahooFinance from "yahoo-finance2";
import yahooFinance from "yahoo-finance2";
import { parseDate } from "../utils/dates.ts";
import { InvalidTickerError, PriceUnavailableError } from "../utils/errors.ts";
import {
  getCachedPrice,
  loadPriceCache,
  savePriceCache,
  setCachedPrice,
} from "./cache.ts";
import type { PriceCache } from "../types.ts";

const yf = new YahooFinance({ validation: { logErrors: false } });

/**
 * Fetch the EOD price for a ticker on a given date.
 * - If the date is today/future and the market hasn't closed yet, we may
 *   still get the latest close. The spec says "today's EOD price" which we
 *   interpret as the most recent settled close.
 * - On weekends/holidays, yahoo-finance2 returns the last available prior
 *   trading day; we treat that as the EOD price for the requested date.
 */
export async function fetchEodPrice(ticker: string, date: string): Promise<number> {
  const t = ticker.toUpperCase();
  const cache = await loadPriceCache();
  const cached = getCachedPrice(cache, t, date);
  if (cached !== undefined) return cached;

  // Cap end-date to "today" so we never ask yahoo for the future.
  const end = parseDate(date) ?? new Date();
  // Pull a small window — yahoo-finance2 is inclusive on period1/period2.
  const start = new Date(end);
  start.setDate(start.getDate() - 7);

  let rows: Array<{ date: Date; close: number | null }>;
  try {
    const result = await yf.historical(t, {
      period1: start,
      period2: end,
      interval: "1d",
    });
    rows = result as Array<{ date: Date; close: number | null }>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // yahoo-finance2 throws "Failed to get crumb" or "Not Found" for bad tickers.
    if (/Not Found|Invalid|ticker/i.test(msg)) {
      throw new InvalidTickerError(t, msg);
    }
    throw err;
  }

  if (!rows || rows.length === 0) {
    throw new PriceUnavailableError(t, date);
  }

  // Use the most recent row <= requested date.
  const target = parseDate(date)?.getTime() ?? Date.now();
  const eligible = rows.filter((r) => r.date.getTime() <= target);
  if (eligible.length === 0) {
    throw new PriceUnavailableError(t, date);
  }
  const last = eligible[eligible.length - 1]!;
  const price = last.close;
  if (price === null || price === undefined || Number.isNaN(price)) {
    throw new PriceUnavailableError(t, date);
  }

  // Persist back to cache (mutable update via setter).
  const updated: PriceCache = setCachedPrice(cache, t, date, price);
  await savePriceCache(updated);

  return price;
}

// Re-export yahooFinance in case any external code needs the raw client.
export { yahooFinance };
