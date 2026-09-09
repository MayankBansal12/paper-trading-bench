// Fixed, versioned trading universe. The benchmark must never silently
// change which tickers a model can trade mid-comparison — bump the version
// and add a new UNIVERSE_<N> constant instead of editing one in place.

export const UNIVERSE_VERSION = "v1";

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

export const UNIVERSES: Record<string, readonly string[]> = Object.freeze({
  [UNIVERSE_VERSION]: UNIVERSE_V1,
});

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
