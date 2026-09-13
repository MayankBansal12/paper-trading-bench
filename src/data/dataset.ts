import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import type { OhlcvBar } from "../domain/types.ts";
import { FIXTURES_DIR } from "../utils/paths.ts";
import { assertDate, exchangeDates, CALENDAR_VERSION } from "./calendar.ts";
import { getUniverse, getUniverseDefinition, UNIVERSE_EXCLUSIONS, type UniverseDefinition } from "../config/universe.ts";

export type CorporateAction =
  | { type: "split"; date: string; ticker: string; ratio: number }
  | { type: "dividend"; date: string; ticker: string; amount: number };
export interface MarketDataset {
  readonly version: string;
  readonly kind: "historical" | "synthetic";
  readonly calendar: readonly string[];
  readonly universe: readonly string[];
  readonly coverage: Readonly<{ start: string; end: string }>;
  readonly evaluation: Readonly<{ start: string; end: string }>;
  asOfBefore(ticker: string, date: string, lookback?: number): OhlcvBar[];
  openOn(ticker: string, date: string): number | undefined;
  closeOn(ticker: string, date: string): number;
  volumeOn(ticker: string, date: string): number;
  actionsOn(date: string): CorporateAction[];
}
export const ADJUSTMENT_CONVENTION = "raw-as-traded-ohlcv;split-events;dividend-cash-on-ex-date-v1";
export interface DatasetFile { path: string; sha256: string }
export interface DatasetManifest {
  schemaVersion: 1;
  kind: "historical" | "synthetic";
  source: string;
  fetchedAt: string;
  adjustmentConvention: typeof ADJUSTMENT_CONVENTION;
  calendarVersion: string;
  coverage: { start: string; end: string };
  evaluation: { start: string; end: string };
  calendar: string[];
  universe: string[];
  actions: CorporateAction[];
  files: Record<string, DatasetFile>;
  snapshots: DatasetFile[];
  universeVersion?: string;
  universeDefinition?: UniverseDefinition;
  universeRecord?: DatasetFile;
  exclusions?: readonly { ticker: string; reason: string; sources: readonly string[] }[];
  corporateActionReview?: Record<string, unknown>;
  [key: string]: unknown;
}
export function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export function validateBars(raw: unknown, ticker: string): OhlcvBar[] {
  if (!Array.isArray(raw) || !raw.length) throw new Error(`Empty or invalid bars for ${ticker}`);
  let previous = "";
  return raw.map((row: unknown) => {
    if (!row || typeof row !== "object") throw new Error(`Invalid bar for ${ticker}`);
    const b = row as OhlcvBar;
    assertDate(b.date, `${ticker} bar date`);
    if (b.date <= previous) throw new Error(`Dates must be strictly increasing and unique for ${ticker}: ${b.date}`);
    previous = b.date;
    for (const key of ["open", "high", "low", "close"] as const) {
      if (typeof b[key] !== "number" || !Number.isFinite(b[key]) || b[key] <= 0) throw new Error(`Invalid ${ticker} ${b.date} ${key}`);
    }
    if (b.low > Math.min(b.open, b.close) || b.high < Math.max(b.open, b.close) || b.low > b.high) throw new Error(`Invalid OHLC bounds for ${ticker} ${b.date}`);
    // Reversing split-adjusted volume may yield fractional shares (reverse splits).
    if (typeof b.volume !== "number" || !Number.isFinite(b.volume) || b.volume < 0 || b.volume > Number.MAX_SAFE_INTEGER) throw new Error(`Invalid volume for ${ticker} ${b.date}`);
    return { date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
  });
}
/** Conservative Yahoo ingestion gate: exotic factors can encode spin-offs rather
 * than actual share-count changes (e.g. HON 1.061 and 0.9535). A nonstandard
 * legitimate split needs issuer verification and an explicit supported policy. */
export function assertSupportedSplitRatio(ratio: number, ticker: string, date: string): void {
  const simpleRatio = Number.isFinite(ratio) && ratio > 0 && Array.from({ length: 20 }, (_, i) => i + 1).some(denominator => {
    const numerator = ratio * denominator;
    return numerator >= 1 && numerator <= 1000 && Math.abs(numerator - Math.round(numerator)) < 1e-9;
  });
  if (!simpleRatio) throw new Error(`Unsupported nonstandard split factor ${ratio} for ${ticker} on ${date}: possible spin-off/combined adjustment; issuer review required`);
}
function assertCalendar(calendar: unknown): asserts calendar is string[] {
  if (!Array.isArray(calendar) || !calendar.length) throw new Error("Empty or invalid calendar");
  let previous = "";
  for (const date of calendar) {
    assertDate(date, "calendar date");
    if (date <= previous) throw new Error("Calendar dates must be strictly increasing and unique");
    if ([0, 6].includes(new Date(date).getUTCDay())) throw new Error(`Weekend in calendar: ${date}`);
    previous = date;
  }
}
export function validateActions(raw: unknown, universe: readonly string[], calendar: readonly string[]): CorporateAction[] {
  if (!Array.isArray(raw)) throw new Error("Invalid corporate actions");
  const seen = new Set<string>();
  return raw.map((item: unknown): CorporateAction => {
    if (!item || typeof item !== "object") throw new Error("Invalid corporate action");
    const action = item as CorporateAction;
    assertDate(action.date, "action date");
    if (!universe.includes(action.ticker) || !calendar.includes(action.date)) throw new Error(`Action outside universe/calendar: ${action.ticker} ${action.date}`);
    const key = `${action.ticker}:${action.date}:${action.type}`;
    if (seen.has(key)) throw new Error(`Duplicate corporate action: ${key}`);
    seen.add(key);
    const value = action.type === "split" ? action.ratio : action.type === "dividend" ? action.amount : NaN;
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid corporate action: ${key}`);
    return action.type === "split" ? { type: "split", ticker: action.ticker, date: action.date, ratio: value } : { type: "dividend", ticker: action.ticker, date: action.date, amount: value };
  }).sort((a, b) => a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker) || (a.type === b.type ? 0 : a.type === "split" ? -1 : 1));
}
function buildDataset(manifest: Pick<DatasetManifest, "kind" | "calendar" | "universe" | "coverage" | "evaluation" | "actions">, series: Map<string, OhlcvBar[]>, version: string): MarketDataset {
  assertCalendar(manifest.calendar);
  for (const ticker of manifest.universe) {
    const bars = series.get(ticker)!;
    if (bars.length !== manifest.calendar.length || bars.some((b, i) => b.date !== manifest.calendar[i])) throw new Error(`Ticker "${ticker}" has a different trading calendar or missing bars`);
  }
  const actions = validateActions(manifest.actions, manifest.universe, manifest.calendar);
  if (manifest.kind === "historical") for (const a of actions) if (a.type === "split") assertSupportedSplitRatio(a.ratio, a.ticker, a.date);
  const dates = new Map(manifest.calendar.map((date, i) => [date, i]));
  const lookup = (ticker: string): OhlcvBar[] => {
    const bars = series.get(ticker);
    if (!bars) throw new Error(`Unknown dataset ticker "${ticker}"`);
    return bars;
  };
  const exact = (ticker: string, date: string): OhlcvBar | undefined => {
    assertDate(date); const i = dates.get(date);
    return i === undefined ? undefined : lookup(ticker)[i];
  };
  return Object.freeze({
    version, kind: manifest.kind, calendar: Object.freeze([...manifest.calendar]), universe: Object.freeze([...manifest.universe]),
    coverage: Object.freeze({ ...manifest.coverage }), evaluation: Object.freeze({ ...manifest.evaluation }),
    asOfBefore(ticker: string, date: string, lookback?: number): OhlcvBar[] {
      assertDate(date);
      if (lookback !== undefined && (!Number.isSafeInteger(lookback) || lookback < 0)) throw new Error("lookback must be a nonnegative integer");
      const bars = lookup(ticker).filter(b => b.date < date);
      const selected = lookback === undefined ? bars : lookback === 0 ? [] : bars.slice(-lookback);
      // On split morning, normalize prior prices to the shares held AFTER today's
      // action. Future splits never enter the decision input. Dividend gaps remain.
      const splits = actions.filter(a => a.type === "split" && a.ticker === ticker && a.date <= date);
      return selected.map(b => {
        const factor = splits.reduce((f, a) => a.type === "split" && a.date > b.date ? f * a.ratio : f, 1);
        return { ...b, open: b.open / factor, high: b.high / factor, low: b.low / factor, close: b.close / factor, volume: b.volume * factor };
      });
    },
    openOn(ticker: string, date: string) { return exact(ticker, date)?.open; },
    closeOn(ticker: string, date: string) {
      const bar = exact(ticker, date); if (!bar) throw new Error(`No bar for ${ticker} on ${date}`); return bar.close;
    },
    volumeOn(ticker: string, date: string) {
      const bar = exact(ticker, date); if (!bar) throw new Error("No bar for " + ticker + " on " + date); return bar.volume;
    },
    actionsOn(date: string) { assertDate(date); return actions.filter(a => a.date === date).map(a => ({ ...a })); },
  });
}
export async function verifiedFile(dir: string, file: DatasetFile): Promise<Buffer> {
  if (!file || typeof file.path !== "string" || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error("Invalid dataset file descriptor");
  const base = await realpath(dir), path = await realpath(resolve(dir, file.path)), rel = relative(base, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Dataset file escapes directory: ${file.path}`);
  const bytes = await readFile(path);
  if (sha256(bytes) !== file.sha256) throw new Error(`Dataset SHA-256 mismatch: ${file.path}`);
  return bytes;
}
/** Every call verifies bytes again: explicit datasets are immutable snapshots, not stale caches. */
export async function loadDataset(dataDir?: string): Promise<MarketDataset> {
  if (dataDir === undefined || resolve(dataDir) === resolve(FIXTURES_DIR)) {
    const files = (await readdir(FIXTURES_DIR)).filter(f => f.endsWith(".json")).sort();
    const series = new Map<string, OhlcvBar[]>(), hash = createHash("sha256");
    for (const file of files) {
      const bytes = await readFile(resolve(FIXTURES_DIR, file)); hash.update(file).update("\0").update(bytes).update("\0");
      series.set(file.slice(0, -5), validateBars(JSON.parse(bytes.toString()), file));
    }
    const calendar = [...series.values()][0]?.map(b => b.date) ?? [];
    assertCalendar(calendar);
    const coverage = { start: calendar[0]!, end: calendar.at(-1)! };
    return buildDataset({ kind: "synthetic", universe: [...series.keys()], calendar, coverage, evaluation: coverage, actions: [] }, series, hash.digest("hex"));
  }
  const manifestBytes = await readFile(resolve(dataDir, "manifest.json"));
  const m = JSON.parse(manifestBytes.toString()) as DatasetManifest;
  if (!m || m.schemaVersion !== 1 || !["historical", "synthetic"].includes(m.kind) || m.adjustmentConvention !== ADJUSTMENT_CONVENTION) throw new Error("Unsupported dataset manifest or adjustment convention");
  if (typeof m.source !== "string" || !m.source || typeof m.fetchedAt !== "string" || !Number.isFinite(Date.parse(m.fetchedAt))) throw new Error("Missing dataset provenance");
  assertCalendar(m.calendar);
  if (!Array.isArray(m.universe) || !m.universe.length || m.universe.some(t => typeof t !== "string" || !/^[A-Z0-9][A-Z0-9.-]{0,15}$/.test(t)) || new Set(m.universe).size !== m.universe.length) throw new Error("Invalid dataset universe");
  for (const range of [m.coverage, m.evaluation]) { assertDate(range?.start); assertDate(range?.end); if (range.start > range.end) throw new Error("Invalid dataset coverage"); }
  if (m.evaluation.start < m.coverage.start || m.evaluation.end > m.coverage.end || m.calendar[0]! < m.coverage.start || m.calendar.at(-1)! > m.coverage.end) throw new Error("Evaluation/calendar outside dataset coverage");
  if (m.kind === "historical") {
    if (m.calendarVersion !== CALENDAR_VERSION || JSON.stringify(exchangeDates(m.coverage.start, m.coverage.end)) !== JSON.stringify(m.calendar)) throw new Error("Historical calendar is incomplete or does not match exchange sessions");
    if (!Array.isArray(m.snapshots) || !m.snapshots.length) throw new Error("Historical dataset must preserve source snapshots");
  }
  if (!m.files || Object.keys(m.files).sort().join(",") !== [...m.universe].sort().join(",")) throw new Error("Ticker file map must match universe");
  if (!Array.isArray(m.snapshots)) throw new Error("Missing snapshot list");
  const series = new Map<string, OhlcvBar[]>();
  for (const ticker of m.universe) series.set(ticker, validateBars(JSON.parse((await verifiedFile(dataDir, m.files[ticker]!)).toString()), ticker));
  for (const snapshot of m.snapshots) await verifiedFile(dataDir, snapshot);
  if (m.universeVersion === "v3") {
    const expectedDefinition = getUniverseDefinition("v3");
    const expectedExclusions = UNIVERSE_EXCLUSIONS.v3 ?? [];
    if (JSON.stringify(m.universe) !== JSON.stringify(getUniverse("v3"))) throw new Error("Nasdaq universe membership/order differs from canonical v3");
    if (JSON.stringify(m.universeDefinition) !== JSON.stringify(expectedDefinition)) throw new Error("Nasdaq universe definition differs from canonical v3");
    if (JSON.stringify(m.exclusions) !== JSON.stringify(expectedExclusions)) throw new Error("Nasdaq universe exclusions differ from canonical v3");
    if (!m.universeRecord || !m.snapshots.some(file => JSON.stringify(file) === JSON.stringify(m.universeRecord))) throw new Error("Nasdaq dataset is missing its canonical universe snapshot");
    const record = JSON.parse((await verifiedFile(dataDir, m.universeRecord)).toString()) as { universeVersion?: string; tradableSecurities?: string[]; excludedSecurities?: {ticker:string}[] };
    if (record.universeVersion !== "v3" || JSON.stringify(record.tradableSecurities) !== JSON.stringify(m.universe)
      || JSON.stringify(record.excludedSecurities?.map(x => x.ticker)) !== JSON.stringify(expectedExclusions.map(x => x.ticker))) {
      throw new Error("Nasdaq canonical universe snapshot is incompatible with its manifest");
    }
    if (m.corporateActionReview?.policyVersion !== "splits-dividends-only-v2" || m.corporateActionReview?.nonstandardSplitFactors !== "fail closed") {
      throw new Error("Nasdaq corporate-action review policy is missing or incompatible");
    }
  }
  return buildDataset(m, series, sha256(manifestBytes));
}
/** Reject truncated evaluation and insufficient warmup before any inference call. */
export function validateDatasetWindow(dataset: MarketDataset, start: string, end: string, warmupBars = 60, universe: readonly string[] = dataset.universe): string[] {
  assertDate(start); assertDate(end);
  if (start > end || start < dataset.coverage.start || end > dataset.coverage.end) throw new Error(`Requested window ${start}..${end} is outside dataset coverage ${dataset.coverage.start}..${dataset.coverage.end}`);
  if (!Number.isSafeInteger(warmupBars) || warmupBars < 0) throw new Error("warmupBars must be a nonnegative integer");
  const dates = dataset.calendar.filter(d => d >= start && d <= end);
  if (!dates.length) throw new Error("Requested window contains no trading sessions");
  if (!universe.length || new Set(universe).size !== universe.length) throw new Error("Invalid evaluation universe");
  for (const ticker of universe) {
    if (!dataset.universe.includes(ticker)) throw new Error(`Dataset missing ticker ${ticker}`);
    if (dataset.asOfBefore(ticker, dates[0]!).length < warmupBars) throw new Error(`Insufficient warmup for ${ticker}: need ${warmupBars} bars before ${dates[0]}`);
  }
  return dates;
}
