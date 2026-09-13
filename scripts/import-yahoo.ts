#!/usr/bin/env bun
import { mkdir, readFile, writeFile, access, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { getUniverse, getUniverseDefinition, UNIVERSE_VERSION, UNIVERSE_EXCLUSIONS } from "../src/config/universe.ts";
import { ADJUSTMENT_CONVENTION, verifiedFile, loadDataset, sha256, validateDatasetWindow, type DatasetManifest, type DatasetFile } from "../src/data/dataset.ts";
import { assertDate, exchangeDates, shiftDate, CALENDAR_VERSION } from "../src/data/calendar.ts";
import { convertYahooChart, yahooSymbol } from "../src/data/yahoo.ts";

interface SnapshotIndex {
  schemaVersion: 1; fetchedAt: string; start: string; end: string; historyStart: string;
  universeVersion?: string; exclusions?: readonly { ticker: string; reason: string; sources: readonly string[] }[];
  universeDefinition?: ReturnType<typeof getUniverseDefinition>; universeRecord?: DatasetFile;
  derivedFrom?: { manifestSha256: string; excludedTickers: string[] };
  warmupBars: number; universe: string[]; requests: Record<string, { url: string; file: string; sha256: string }>;
}
export async function importYahoo(args: string[]): Promise<string> {
  const { values } = parseArgs({ args, options: {
    start: { type: "string" }, end: { type: "string" }, out: { type: "string" }, tickers: { type: "string" },
    "universe-version": { type: "string" }, "warmup-bars": { type: "string" }, "history-start": { type: "string" }, "from-snapshot": { type: "string" }, help: { type: "boolean" },
  }, strict: true });
  if (values.help) return "Usage: bun scripts/import-yahoo.ts --start YYYY-MM-DD --end YYYY-MM-DD --out DIR [--universe-version v3 | --tickers AAPL,MSFT] [--warmup-bars 100] [--history-start YYYY-MM-DD]\nOffline identical rebuild: --from-snapshot EXISTING_DATASET_DIR --out NEW_DIR\nThe destination must not exist. No network is used in snapshot mode. Add --universe-version v3 to explicitly derive a supported subset from a preserved snapshot.";
  if (!values.out) throw new Error("--out is required");
  if (values.tickers && values["universe-version"]) throw new Error("--tickers and --universe-version are mutually exclusive");
  const out = resolve(values.out);
  try { await access(out); throw new Error(`Refusing to overwrite existing dataset: ${out}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let index: SnapshotIndex;
  let sourceDir: string | undefined;
  if (values["from-snapshot"]) {
    if (values.start || values.end || values.tickers || values["warmup-bars"] || values["history-start"]) throw new Error("Snapshot replay uses original options; do not override its window/universe");
    sourceDir = resolve(values["from-snapshot"]);
    const parentBytes = await readFile(resolve(sourceDir, "manifest.json"));
    const parent = JSON.parse(parentBytes.toString()) as DatasetManifest;
    // An explicit subset derivation may use a quarantined source whose derived
    // actions are rejected. Authenticate ALL source bytes, then reconvert only
    // the selected supported tickers. Never reuse its derived bars/actions.
    if (values["universe-version"]) {
      if (parent.schemaVersion !== 1 || parent.source !== "Yahoo Finance chart v8" || !Array.isArray(parent.snapshots) || !parent.snapshots.some(f => f.path === "sources/index.json")) throw new Error("Invalid parent Yahoo snapshot manifest");
      for (const snapshot of parent.snapshots) await verifiedFile(sourceDir, snapshot);
    } else await loadDataset(sourceDir);
    index = JSON.parse(await readFile(resolve(sourceDir, "sources/index.json"), "utf8"));
    if (index.schemaVersion !== 1) throw new Error("Unsupported Yahoo snapshot index");
    if (values["universe-version"]) {
      const version = values["universe-version"], selected = [...getUniverse(version)];
      if (selected.some(t => !index.universe.includes(t))) throw new Error("Requested universe is not a subset of the source snapshot");
      const excludedTickers = index.universe.filter(t => !selected.includes(t));
      index = { ...index, universe: selected, universeVersion: version, exclusions: UNIVERSE_EXCLUSIONS[version] ?? [],
        requests: Object.fromEntries(selected.map(t => [t, index.requests[t]!])),
        derivedFrom: { manifestSha256: sha256(parentBytes), excludedTickers } };
      index.universeDefinition = getUniverseDefinition(version); delete index.universeRecord;
    }
  } else {
    assertDate(values.start, "--start"); assertDate(values.end, "--end");
    const today = new Date().toISOString().slice(0, 10);
    if (values.start > values.end || values.end >= today) throw new Error(`Evaluation must end before today (${today}); requested ${values.start}..${values.end}`);
    const warmupBars = Number(values["warmup-bars"] ?? 100);
    if (!Number.isSafeInteger(warmupBars) || warmupBars < 60) throw new Error("--warmup-bars must be an integer >=60");
    const historyStart = values["history-start"] ?? shiftDate(values.start, -Math.max(365, warmupBars * 2));
    assertDate(historyStart, "--history-start");
    if (historyStart >= values.start) throw new Error("History must start before evaluation");
    const universeVersion = values.tickers ? "custom" : values["universe-version"] ?? UNIVERSE_VERSION;
    const universe = values.tickers ? values.tickers.split(",").map(s => s.trim()).sort() : [...getUniverse(universeVersion)];
    if (!universe.length || new Set(universe).size !== universe.length || universe.some(t => !/^[A-Z0-9][A-Z0-9.-]{0,15}$/.test(t))) throw new Error("Invalid/duplicate tickers");
    index = { schemaVersion: 1, fetchedAt: new Date().toISOString(), start: values.start, end: values.end, historyStart, warmupBars, universe, universeVersion, ...(universeVersion === "custom" ? {} : { universeDefinition: getUniverseDefinition(universeVersion) }), exclusions: UNIVERSE_EXCLUSIONS[universeVersion] ?? [], requests: {} };
  }
  const calendar = exchangeDates(index.historyStart, index.end);
  if (calendar.filter(d => d < index.start).length < index.warmupBars) throw new Error("Requested history has insufficient warmup sessions");
  const stage = `${out}.partial-${process.pid}`;
  await mkdir(resolve(stage, "sources"), { recursive: true });
  await mkdir(resolve(stage, "ohlcv"));
  const files: Record<string, DatasetFile> = {}, snapshots: DatasetFile[] = [], actions: DatasetManifest["actions"] = [];
  const adjustments: Record<string, unknown> = {};
  try {
    if (index.universeVersion === "v3") {
      index.universeDefinition ??= getUniverseDefinition("v3");
      const canonicalPath = "sources/universe-v3.json";
      const bytes = sourceDir && index.universeRecord
        ? await readFile(resolve(sourceDir, index.universeRecord.path))
        : await readFile(new URL("../src/config/universes/nasdaq100-2026-06-01-v3.json", import.meta.url));
      if (index.universeRecord && sha256(bytes) !== index.universeRecord.sha256) throw new Error("Canonical universe record hash mismatch");
      const record = JSON.parse(bytes.toString()) as { universeVersion?: string; officialSecurities?: string[]; tradableSecurities?: string[]; excludedSecurities?: {ticker:string}[] };
      if (record.universeVersion !== "v3" || record.officialSecurities?.length !== 101
        || JSON.stringify(record.tradableSecurities) !== JSON.stringify(index.universe)
        || JSON.stringify(record.excludedSecurities?.map(x => x.ticker)) !== JSON.stringify((index.exclusions ?? []).map(x => x.ticker))) {
        throw new Error("Canonical universe record does not match selected membership/exclusions");
      }
      await writeFile(resolve(stage, canonicalPath), bytes, { flag: "wx" });
      index.universeRecord = { path: canonicalPath, sha256: sha256(bytes) };
      snapshots.push(index.universeRecord);
    }
    for (const ticker of index.universe) {
      let text: string;
      const file = `sources/${ticker}.json`;
      if (sourceDir) {
        const request = index.requests[ticker];
        if (!request || request.file !== file) throw new Error(`Invalid snapshot request for ${ticker}`);
        text = await readFile(resolve(sourceDir, file), "utf8");
        if (sha256(text) !== request.sha256) throw new Error(`Snapshot hash mismatch for ${ticker}`);
      } else {
        // Yahoo adjusts even a historical sub-window for subsequent splits. Fetch
        // THROUGH snapshot time, not evaluation end, or raw reconstruction is wrong.
        const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol(ticker))}`);
        url.search = new URLSearchParams({ period1: String(Date.parse(index.historyStart) / 1000), period2: String(Math.floor(Date.parse(index.fetchedAt) / 1000)), interval: "1d", events: "div,splits,capitalGains", includeAdjustedClose: "true" }).toString();
        text = await download(url.toString());
        index.requests[ticker] = { url: url.toString(), file, sha256: sha256(text) };
      }
      const converted = convertYahooChart(JSON.parse(text), ticker, index.historyStart, index.end);
      if (converted.bars.length !== calendar.length || converted.bars.some((b, i) => b.date !== calendar[i])) throw new Error(`Incomplete Yahoo coverage for ${ticker}: expected ${calendar[0]}..${calendar.at(-1)} (${calendar.length} sessions), received ${converted.bars[0]?.date}..${converted.bars.at(-1)?.date} (${converted.bars.length}); missing/stale rows are never substituted`);
      await writeFile(resolve(stage, file), text, { flag: "wx" });
      snapshots.push({ path: file, sha256: sha256(text) });
      const barsText = JSON.stringify(converted.bars, null, 2) + "\n", barsPath = `ohlcv/${ticker}.json`;
      await writeFile(resolve(stage, barsPath), barsText, { flag: "wx" });
      files[ticker] = { path: barsPath, sha256: sha256(barsText) };
      actions.push(...converted.actions); adjustments[ticker] = converted.allSplits;
      console.error(`Imported ${ticker}: ${converted.bars.length} bars, ${converted.actions.length} actions`);
    }
    const indexText = JSON.stringify(index, null, 2) + "\n";
    await writeFile(resolve(stage, "sources/index.json"), indexText, { flag: "wx" });
    snapshots.push({ path: "sources/index.json", sha256: sha256(indexText) });
    const manifest: DatasetManifest = {
      schemaVersion: 1, kind: "historical", source: "Yahoo Finance chart v8", fetchedAt: index.fetchedAt,
      adjustmentConvention: ADJUSTMENT_CONVENTION, calendarVersion: CALENDAR_VERSION,
      coverage: { start: index.historyStart, end: index.end }, evaluation: { start: index.start, end: index.end },
      calendar, universe: index.universe, actions, files, snapshots,
      universeVersion: index.universeVersion ?? "custom", exclusions: index.exclusions ?? [],
      ...(index.universeDefinition ? { universeDefinition: index.universeDefinition } : {}),
      ...(index.universeRecord ? { universeRecord: index.universeRecord } : {}),
      ...(index.derivedFrom ? { derivedFrom: index.derivedFrom } : {}),
      importerVersion: "yahoo-raw-v3", warmupBars: index.warmupBars,
      corporateActionReview: { policyVersion: "splits-dividends-only-v2", sourceEvents: ["splits", "dividends", "capitalGains"], unsupportedEvents: ["spin-offs", "rights", "mergers", "cash-in-lieu", "capital-gain distributions"], nonstandardSplitFactors: "fail closed", preCoverageEvents: "discarded because they cannot affect retained raw bars", exclusions: index.exclusions ?? [] },
      sourceAdjustment: "Yahoo OHLC/dividends split-adjusted; volume inverse split-adjusted; adjclose ignored",
      reconstructionSplits: adjustments,
      dividendTiming: "Cash credited on ex-date to prior holdings, after same-day splits; payment-date lag omitted",
      sourceReferences: ["https://help.yahoo.com/kb/SLN28256.html", "https://finance.yahoo.com/quote/AAPL/history/", "https://www.apple.com/newsroom/2020/07/apple-reports-third-quarter-results/", "https://www.nyse.com/trade/hours-calendars"],
      limitations: ["Frozen current universe has survivorship selection bias", "Yahoo may revise historical data; reproduce from preserved source snapshots", "Spin-offs, rights, mergers and capital-gain distributions are unsupported; only splits and cash dividends are modeled", "Exchange calendar 2000-2030 uses frozen rules and known exceptional closures"],
    };
    await writeFile(resolve(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
    const dataset = await loadDataset(stage);
    validateDatasetWindow(dataset, index.start, index.end, index.warmupBars);
    await rename(stage, out);
    return JSON.stringify({ dataDir: out, version: dataset.version, kind: dataset.kind, evaluation: dataset.evaluation, coverage: dataset.coverage, sessions: calendar.length, tickers: index.universe.length });
  } catch (error) {
    // A failed staging tree is not a valid dataset and cannot be selected by CLI.
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}
async function download(url: string): Promise<string> {
  let failure: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 paper-trading-bench historical importer" }, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Yahoo HTTP ${response.status} for ${new URL(url).pathname}`);
      return await response.text();
    } catch (error) { failure = error; if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); }
  }
  throw failure;
}
if (import.meta.main) importYahoo(process.argv.slice(2)).then(console.log).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
