// Price cache. Per-session, per-ticker, per-date EOD prices cached in
// results/.price-cache.json. Prevents refetching across sessions and
// makes the benchmark deterministic / offline-capable for cached tickers.

import { readFile } from "node:fs/promises";
import { PRICE_CACHE_FILE } from "../utils/paths.ts";
import { writeFileAtomic } from "../utils/fs.ts";
import { nowIso } from "../utils/dates.ts";
import type { PriceCache } from "../types.ts";

export async function loadPriceCache(): Promise<PriceCache> {
  try {
    const raw = await readFile(PRICE_CACHE_FILE, "utf8");
    return JSON.parse(raw) as PriceCache;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

export async function savePriceCache(cache: PriceCache): Promise<void> {
  await writeFileAtomic(PRICE_CACHE_FILE, JSON.stringify(cache, null, 2) + "\n");
}

/** Cache key is "TICKER|DATE" — same ticker on different days are distinct entries. */
function key(ticker: string, date: string): string {
  return `${ticker.toUpperCase()}|${date}`;
}

export function getCachedPrice(
  cache: PriceCache,
  ticker: string,
  date: string,
): number | undefined {
  return cache[key(ticker, date)]?.price;
}

export function setCachedPrice(
  cache: PriceCache,
  ticker: string,
  date: string,
  price: number,
): PriceCache {
  return {
    ...cache,
    [key(ticker, date)]: {
      ticker: ticker.toUpperCase(),
      date,
      price,
      fetched_at: nowIso(),
    },
  };
}
