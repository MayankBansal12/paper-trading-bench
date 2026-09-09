// Fixed, versioned trading universe. The benchmark must never silently
// change which tickers a model can trade mid-comparison — bump the version
// and add a new UNIVERSE_<N> constant instead of editing one in place.

export const UNIVERSE_VERSION = "v2";

/** 50 liquid US large-cap equities, alphabetical. Frozen for UNIVERSE_V1. */
export const UNIVERSE_V1: readonly string[] = Object.freeze([
  "AAPL", "ABBV", "ABT", "ACN", "ADBE",
  "AMD", "AMZN", "AVGO", "BAC", "BRK.B",
  "CAT", "COST", "CRM", "CSCO", "CVX",
  "DHR", "DIS", "GE", "GOOGL", "HD",
  "HON", "IBM", "INTC", "JNJ", "JPM",
  "KO", "LIN", "LLY", "LOW", "MA",
  "MCD", "MRK", "META", "MSFT", "NFLX",
  "NKE", "NVDA", "ORCL", "PEP", "PFE",
  "PG", "QCOM", "TMO", "TSLA", "TXN",
  "UNH", "V", "WFC", "WMT", "XOM",
]);

/** Supported historical universe. HON is excluded because Yahoo represents
 * its 2025/2026 spin-offs as price factors, not actual share-count splits. */
export const UNIVERSE_V2: readonly string[] = Object.freeze(UNIVERSE_V1.filter(ticker => ticker !== "HON"));
export const UNIVERSE_EXCLUSIONS: Readonly<Record<string, readonly { ticker: string; reason: string; sources: readonly string[] }[]>> = Object.freeze({
  v1: [],
  v2: [{
    ticker: "HON",
    reason: "Unsupported Solstice 2025-10-30 and Honeywell Aerospace 2026-06-29 spin-offs plus reverse split; Yahoo factors 1.061 and 0.9535 are not actual share ratios. Excluded from warmup and evaluation.",
    sources: [
      "https://www.honeywell.com/us/en/news/press-releases/2025/10/honeywell-completes-spin-off-of-solstice-advanced-materials",
      "https://www.honeywell.com/us/en/press/2026/06/honeywell-board-of-directors-sets-record-date-and-announces-expected-timing-for-spin-off-of-honeywell-aerospace-and-honeywell-reverse-stock-split",
    ],
  }],
});
export const UNIVERSES: Record<string, readonly string[]> = Object.freeze({ v1: UNIVERSE_V1, v2: UNIVERSE_V2 });

export function getUniverse(version: string): readonly string[] {
  const u = UNIVERSES[version];
  if (!u) {
    throw new Error(`Unknown universe version "${version}". Known: ${Object.keys(UNIVERSES).join(", ")}`);
  }
  return u;
}

if (UNIVERSE_V1.length !== 50) {
  throw new Error(`UNIVERSE_V1 must have exactly 50 tickers, has ${UNIVERSE_V1.length}`);
}
