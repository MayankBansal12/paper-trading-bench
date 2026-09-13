// Fixed, versioned trading universes. Never silently change membership: add a
// new version and comparison profile instead of editing an existing one.

export const UNIVERSE_VERSION = "v3";

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

/** Supported legacy historical universe, frozen for 202606-202608-v6. */
export const UNIVERSE_V2: readonly string[] = Object.freeze(UNIVERSE_V1.filter(ticker => ticker !== "HON"));

/**
 * Supported Nasdaq-100 index securities effective at the 2026-06-01 start.
 * Nasdaq's 2026-05-01 sheet lists 101 securities for 100 issuers because both
 * Alphabet classes are securities. The May 18 LITE-for-CSGP change is applied.
 * GOOG and GOOGL are both retained; HON and EA are explicitly excluded below.
 */
export const UNIVERSE_V3: readonly string[] = Object.freeze([
  "AAPL", "ABNB", "ADBE", "ADI", "ADP", "ADSK", "AEP", "ALNY", "AMAT", "AMD",
  "AMGN", "AMZN", "APP", "ARM", "ASML", "AVGO", "AXON", "BKR", "BKNG", "CCEP",
  "CDNS", "CEG", "CHTR", "CMCSA", "COST", "CPRT", "CRWD", "CSCO", "CSX", "CTAS",
  "CTSH", "DASH", "DDOG", "DXCM", "EXC", "FANG", "FAST", "FER", "FTNT", "GEHC",
  "GILD", "GOOG", "GOOGL", "IDXX", "INSM", "INTC", "INTU", "ISRG", "KDP", "KHC",
  "KLAC", "LIN", "LITE", "LRCX", "MAR", "MCHP", "MDLZ", "MELI", "META", "MNST",
  "MPWR", "MRVL", "MSFT", "MSTR", "MU", "NFLX", "NVDA", "NXPI", "ODFL", "ORLY",
  "PANW", "PAYX", "PCAR", "PDD", "PEP", "PLTR", "PYPL", "QCOM", "REGN", "ROP",
  "ROST", "SBUX", "SHOP", "SNDK", "SNPS", "STX", "TMUS", "TRI", "TSLA", "TTWO",
  "TXN", "VRSK", "VRTX", "WBD", "WDC", "WDAY", "WMT", "XEL", "ZS",
]);

export interface UniverseSource {
  readonly title: string;
  readonly url: string;
  readonly asOf: string;
  readonly role: "constituent-snapshot" | "effective-change" | "corporate-action-exclusion";
}

export interface UniverseDefinition {
  readonly version: string;
  readonly name: string;
  readonly indexSymbol: string;
  readonly effectiveDate: string;
  readonly frozenThrough: string;
  readonly membershipPolicy: string;
  readonly shareClassPolicy: string;
  readonly officialConstituentSecurityCount: number;
  readonly officialIssuerCount: number;
  readonly tradableSecurityCount: number;
  readonly sources: readonly UniverseSource[];
}

export const UNIVERSE_DEFINITIONS: Readonly<Record<string, UniverseDefinition>> = Object.freeze({
  v1: Object.freeze({
    version: "v1", name: "legacy synthetic US large-cap universe", indexSymbol: "none",
    effectiveDate: "2024-01-02", frozenThrough: "2024-06-28",
    membershipPolicy: "Legacy synthetic fixture universe; not an index constituent claim.",
    shareClassPolicy: "As originally frozen.", officialConstituentSecurityCount: 50,
    officialIssuerCount: 50, tradableSecurityCount: 50, sources: [],
  }),
  v2: Object.freeze({
    version: "v2", name: "legacy supported 49-security universe", indexSymbol: "none",
    effectiveDate: "2026-06-01", frozenThrough: "2026-08-31",
    membershipPolicy: "Legacy v1 subset, frozen for the 202606-202608-v6 comparison.",
    shareClassPolicy: "As originally frozen.", officialConstituentSecurityCount: 50,
    officialIssuerCount: 50, tradableSecurityCount: 49, sources: [],
  }),
  v3: Object.freeze({
    version: "v3", name: "Nasdaq-100 start-of-period supported securities (2026-06-01)", indexSymbol: "NDX",
    effectiveDate: "2026-06-01", frozenThrough: "2026-08-31",
    membershipPolicy: "Start-of-period membership: Nasdaq's 2026-05-01 security list, with the LITE-for-CSGP change effective 2026-05-18, frozen unchanged through 2026-08-31. Later June 22 and July 7 changes are deliberately ignored. HON and EA exclusions are declared; no replacements are substituted.",
    shareClassPolicy: "Security-level membership. Include both GOOG and GOOGL exactly as Nasdaq lists them; controls equal-weight securities, not issuers.",
    officialConstituentSecurityCount: 101, officialIssuerCount: 100, tradableSecurityCount: 99,
    sources: Object.freeze([
      Object.freeze({ title: "Nasdaq-100 component weights, data as of 2026-05-01", url: "https://www.nasdaq.com/docs/2026/05/04/NDX.pdf", asOf: "2026-05-01", role: "constituent-snapshot" as const }),
      Object.freeze({ title: "Lumentum Holdings Inc. to Join the Nasdaq-100 Index Beginning May 18, 2026", url: "https://ir.nasdaq.com/node/110416", asOf: "2026-05-18", role: "effective-change" as const }),
      Object.freeze({ title: "Honeywell Aerospace spin-off and reverse split timing", url: "https://www.honeywell.com/us/en/press/2026/06/honeywell-board-of-directors-sets-record-date-and-announces-expected-timing-for-spin-off-of-honeywell-aerospace-and-honeywell-reverse-stock-split", asOf: "2026-06-29", role: "corporate-action-exclusion" as const }),
    ]),
  }),
});

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
  v3: [{
    ticker: "HON",
    reason: "Official 2026-06-01 constituent excluded because the June 29 Honeywell Aerospace distribution plus HON 1-for-2 reverse split cannot be represented by split/dividend-only accounting. No substitute is added.",
    sources: [
      "https://www.nasdaq.com/docs/2026/05/04/NDX.pdf",
      "https://www.honeywell.com/us/en/press/2026/06/honeywell-board-of-directors-sets-record-date-and-announces-expected-timing-for-spin-off-of-honeywell-aerospace-and-honeywell-reverse-stock-split",
    ],
  }, {
    ticker: "EA",
    reason: "Official 2026-06-01 constituent excluded because Yahoo has no finite opening price for the 2026-07-20 exchange session. Missing execution data is never imputed or forward-filled.",
    sources: [
      "https://www.nasdaq.com/docs/2026/05/04/NDX.pdf",
      "https://query1.finance.yahoo.com/v8/finance/chart/EA",
    ],
  }],
});

export const UNIVERSES: Record<string, readonly string[]> = Object.freeze({
  v1: UNIVERSE_V1,
  v2: UNIVERSE_V2,
  v3: UNIVERSE_V3,
});

export function getUniverse(version: string): readonly string[] {
  const universe = UNIVERSES[version];
  if (!universe) throw new Error("Unknown universe version \"" + version + "\". Known: " + Object.keys(UNIVERSES).join(", "));
  return universe;
}

export function getUniverseDefinition(version: string): UniverseDefinition {
  const definition = UNIVERSE_DEFINITIONS[version];
  if (!definition) throw new Error("Unknown universe definition \"" + version + "\". Known: " + Object.keys(UNIVERSE_DEFINITIONS).join(", "));
  return structuredClone(definition);
}

if (UNIVERSE_V1.length !== 50) throw new Error("UNIVERSE_V1 must have exactly 50 tickers, has " + UNIVERSE_V1.length);
if (UNIVERSE_V3.length !== 99 || UNIVERSE_V3.includes("HON") || UNIVERSE_V3.includes("EA") || new Set(UNIVERSE_V3).size !== UNIVERSE_V3.length) {
  throw new Error("UNIVERSE_V3 must contain exactly 99 unique supported Nasdaq-100 securities and exclude HON/EA; has " + UNIVERSE_V3.length);
}
