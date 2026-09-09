// Generates deterministic SYNTHETIC OHLCV fixtures for the fixed universe.
// Run once via `pnpm run fixtures:generate`; output is committed so the
// benchmark is fully offline and reproducible (no network calls at run time).
//
// This is NOT real market data — see fixtures/ohlcv/README.md. Swapping in a
// real historical dataset later only requires replacing these JSON files;
// the loader in src/data/ohlcv.ts is format-compatible either way.

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { UNIVERSE_V1 } from "../src/config/universe.ts";

const START_DATE = "2024-01-02";
const END_DATE = "2024-06-28";
const OUT_DIR = resolve(import.meta.dir, "..", "fixtures", "ohlcv");

/** mulberry32 — small, fast, deterministic PRNG seeded by a 32-bit int. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a string hash -> 32-bit int, used to seed each ticker independently. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function businessDays(start: string, end: string): string[] {
  const out: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  while (d.getTime() <= endDate.getTime()) {
    const dow = d.getUTCDay();
    if (dow >= 1 && dow <= 5) {
      out.push(d.toISOString().slice(0, 10));
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function generateSeries(ticker: string, dates: string[]) {
  const rand = mulberry32(fnv1a(ticker));
  // Starting price in [20, 420), deterministic per ticker.
  let close = 20 + rand() * 400;
  const dailyDrift = 0.0002; // slight upward drift, consistent with a long-only large-cap universe
  const dailyVol = 0.015;

  return dates.map((date) => {
    // Box-Muller for a roughly normal daily return.
    const u1 = Math.max(rand(), 1e-9);
    const u2 = rand();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const ret = dailyDrift + dailyVol * z;

    const open = close;
    close = Math.max(1, open * (1 + ret));
    const wiggle = 0.004 + rand() * 0.006;
    const high = Math.max(open, close) * (1 + wiggle);
    const low = Math.min(open, close) * (1 - wiggle);
    const volume = Math.round(1_000_000 + rand() * 9_000_000);

    return {
      date,
      open: round2(open),
      high: round2(high),
      low: round2(low),
      close: round2(close),
      volume,
    };
  });
}

async function main() {
  const dates = businessDays(START_DATE, END_DATE);
  await mkdir(OUT_DIR, { recursive: true });
  for (const ticker of UNIVERSE_V1) {
    const bars = generateSeries(ticker, dates);
    const path = resolve(OUT_DIR, `${ticker}.json`);
    await writeFile(path, JSON.stringify(bars, null, 2) + "\n", "utf8");
  }
  console.error(`[fixtures] wrote ${UNIVERSE_V1.length} tickers x ${dates.length} bars to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
