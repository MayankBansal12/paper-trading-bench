import { validateComparisonConfig } from "../config/comparison.ts";
import { AGENT_PROTOCOL_VERSION, RECENT_DAY_LIMIT } from "../agent/protocolVersion.ts";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadDataset, validateDatasetWindow, type MarketDataset } from "../data/dataset.ts";
import { getUniverse } from "../config/universe.ts";
import { resolveDateRange } from "../engine/calendar.ts";
import { createInitialPortfolio } from "../engine/portfolio.ts";
import { validateContributions } from "../engine/cashFlows.ts";
import { computeMetrics } from "../engine/metrics.ts";
import { cashBaseline, buyAndHoldBaseline } from "../engine/baselines.ts";
import { buildDecisionContext, DecisionAttemptError, replayDecision, runOneDay, validateDecisionEvidence } from "./day.ts";
import { ensureConfig, loadRunState, resolveRunDir, saveRunState } from "./state.ts";
import { acquireRunLock } from "./lock.ts";
import { ARTIFACT_VERSION, contentHash, decisionUsage, loadAttempts, loadDailyRecord, writeAttempt, writeDailyRecord, writeIfChanged, writeTransactions } from "./persist.ts";
import { runConfigFile, runSummaryFile } from "../utils/paths.ts";
import type { AgentPort, AttemptRecord, DailyRecord, RunConfig, RunState, RunSummary, UsageStats } from "../domain/types.ts";

const nowIso = () => new Date().toISOString();
const zeroUsage = (): UsageStats => ({ turns: 0, toolCalls: 0, failedToolCalls: 0, promptTokens: 0, completionTokens: 0 });
function sumUsage(usages: readonly UsageStats[]): UsageStats {
  const total = zeroUsage() as unknown as Record<string, number>;
  for (const usage of usages) for (const [key, value] of Object.entries(usage)) if (typeof value === "number") total[key] = (total[key] ?? 0) + value;
  return total as unknown as UsageStats;
}

async function preflight(config: RunConfig) {
  validateComparisonConfig(config);
  const market = await loadDataset(config.dataDir);
  const universe = getUniverse(config.universeVersion);
  if (config.dataDir && config.fixtureVersion !== market.version) throw new Error("Dataset content identity does not match config.fixtureVersion");
  if (universe.some((t) => !market.universe.includes(t))) throw new Error("Dataset is missing requested universe tickers");
  // Small legacy fixtures keep their historical range behavior. Explicit
  // datasets and experiment configs require declared coverage and warm-up.
  const dates = config.dataDir || config.experiment || config.warmupBars !== undefined
    ? validateDatasetWindow(market, config.startDate ?? market.calendar[0]!, config.endDate ?? market.calendar.at(-1)!, config.warmupBars ?? 60, universe)
    : resolveDateRange(market.calendar, config.startDate, config.endDate);
  if (new Set(dates).size !== dates.length || dates.some((d, i) => i > 0 && d <= dates[i - 1]!)) throw new Error("Evaluation dates must be strictly increasing and unique");
  validateContributions(config.contributions ?? [], dates);
  if (config.experiment === "three-month") {
    const start = config.startDate, end = config.endDate;
    if (!start || !end || !start.endsWith("-01")) throw new Error("Three-month benchmark requires exactly three complete calendar months");
    const first = new Date(`${start}T00:00:00Z`);
    const expectedEnd = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 3, 0)).toISOString().slice(0, 10);
    if (end !== expectedEnd || config.startingCapital !== 500 || (config.warmupBars ?? 60) < 60 || market.kind !== "historical") throw new Error("Three-month benchmark requires three complete calendar months, historical data, $500 initially, and at least 60 warmup bars");
    const monthStarts = dates.filter((d, i) => i === 0 || d.slice(0, 7) !== dates[i - 1]!.slice(0, 7));
    const required = monthStarts.slice(1).map((date) => ({ date, amount: 500 }));
    if (monthStarts.length !== 3 || JSON.stringify(config.contributions ?? []) !== JSON.stringify(required)) throw new Error("Three-month benchmark requires $500 deposits on the first trading session of months two and three");
  }
  createInitialPortfolio(config.startingCapital);
  for (const date of dates) for (const ticker of universe) {
    const open = market.openOn(ticker, date), close = market.closeOn(ticker, date);
    if (open === undefined || !Number.isFinite(open) || open <= 0 || !Number.isFinite(close) || close <= 0) throw new Error(`Missing/invalid price coverage for ${ticker} on ${date}`);
  }
  return { market, universe, dates };
}

function assertState(state: RunState, config: RunConfig, dates: readonly string[]): void {
  if (state.artifactVersion !== ARTIFACT_VERSION || !Array.isArray(state.completedDates) || !Array.isArray(state.attemptHashes) || state.attemptHashes.some((h) => !/^[a-f0-9]{64}$/.test(h)) || !["active", "completed", "terminated", "failed"].includes(state.status)) throw new Error("Invalid or legacy run state; a new run is required");
  if (state.completedDates.length > dates.length || state.completedDates.some((d, i) => d !== dates[i])) throw new Error("Completed dates are not an ordered evaluation-calendar prefix");
  const { endDate: oldEnd, ...oldConfig } = state.config;
  const { endDate: newEnd, ...newConfig } = config;
  if (JSON.stringify(oldConfig) !== JSON.stringify(newConfig) || (oldEnd !== newEnd && !(oldEnd && newEnd && oldEnd < newEnd))) throw new Error("Run state config is inconsistent with config.json");
}

async function reconstruct(dir: string, state: RunState, config: RunConfig, dates: readonly string[], universe: readonly string[], market: MarketDataset): Promise<DailyRecord[]> {
  assertState(state, config, dates);
  if (state.datasetVersion !== market.version) throw new Error("Run dataset identity is inconsistent with frozen data");
  let dailyFiles: string[] = [];
  try { dailyFiles = (await readdir(join(dir, "daily"))).filter((f) => f.endsWith(".json")).sort(); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  // Only a contiguous prefix is recoverable. Out-of-window and skipped-day
  // orphans must never be silently accepted or ignored.
  if (dailyFiles.some((f, i) => f !== `${dates[i]}.json`)) throw new Error("Daily artifact files are not an ordered evaluation-calendar prefix");
  const records: DailyRecord[] = [];
  let portfolio = createInitialPortfolio(config.startingCapital);
  for (let i = 0; i < Math.max(state.completedDates.length, dailyFiles.length); i++) {
    const date = dates[i]!;
    const record = await loadDailyRecord(dir, date);
    if (!record) throw new Error(`Run state lists ${date} as completed but daily/${date}.json is missing in ${dir}`);
    if (records.at(-1)?.terminated) throw new Error("Daily artifact exists after portfolio termination");
    const replayed = replayDecision(config, date, universe, portfolio, record.decision!, market, records.slice(-RECENT_DAY_LIMIT), record.priorAttemptHashes!);
    if (JSON.stringify(replayed) !== JSON.stringify(record)) throw new Error(`Daily portfolio/order ledger is inconsistent for ${date}`);
    records.push(record);
    portfolio = record.portfolioAfter;
  }
  const committedNetWorth = state.completedDates.length ? records[state.completedDates.length - 1]!.portfolioAfter.netWorth : config.startingCapital;
  if (state.lastNetWorth !== committedNetWorth) throw new Error("Run checkpoint net worth is inconsistent with committed daily ledger");
  if (state.status === "terminated" && !records.at(-1)?.terminated) throw new Error("Run termination state is inconsistent with daily ledger");
  return records;
}

async function deriveSummary(dir: string, config: RunConfig, state: RunState, records: DailyRecord[], attempts: AttemptRecord[], dates: string[], universe: readonly string[], market: MarketDataset): Promise<RunSummary> {
  const equityCurve = records.map((r) => ({ date: r.date, netWorth: r.portfolioAfter.netWorth, ...(r.contribution ? { contribution: r.contribution } : {}) }));
  const failed = attempts.filter((a) => a.outcome !== "completed");
  const metrics = computeMetrics(equityCurve, config.startingCapital, records.reduce((n, r) => n + r.fills.length, 0), records.reduce((n, r) => n + r.failedOrders.length, 0), failed.filter((a) => a.outcome === "budget_cutoff").length, records.map((r) => r.turnoverPct));
  // Baselines stop at exactly the model's committed date prefix. A failed
  // decision must not be compared against returns from future sessions.
  const baselineDates = records.map((r) => r.date);
  const cashCurve = cashBaseline(config.startingCapital, baselineDates, config.contributions);
  const bh = await buyAndHoldBaseline(config.startingCapital, universe, baselineDates, config.contributions, market);
  const body: RunSummary = { artifactVersion: ARTIFACT_VERSION, datasetVersion: market.version, datasetKind: market.kind, config, status: state.status,
    resolvedCoverage: { firstDate: dates[0]!, lastDate: dates.at(-1)!, tradingDays: dates.length },
    finalPortfolio: records.at(-1)?.portfolioAfter ?? createInitialPortfolio(config.startingCapital),
    totalContributions: metrics.totalContributions, netProfit: metrics.netProfit, timeWeightedReturnPct: metrics.timeWeightedReturnPct,
    attemptCount: records.length + failed.length, failedAttemptCount: failed.length,
    equityCurve, metrics, usageTotals: sumUsage([...records.map((r) => r.usage), ...failed.map((a) => a.usage)]),
    baselines: {
      cash: { equityCurve: cashCurve, metrics: computeMetrics(cashCurve, config.startingCapital, 0, 0, 0, baselineDates.map(() => 0)) },
      buyAndHold: { equityCurve: bh.equityCurve, metrics: computeMetrics(bh.equityCurve, config.startingCapital, bh.tradeCount, 0, 0, bh.turnoverPct) },
    } };
  const summary = { ...body, integrityHash: contentHash(body) };
  await writeTransactions(dir, records);
  await writeIfChanged(runSummaryFile(dir), JSON.stringify(summary, null, 2) + "\n");
  return summary;
}

async function processRun(dir: string, config: RunConfig, prepared: Awaited<ReturnType<typeof preflight>>, agent?: AgentPort): Promise<RunSummary> {
  const { market, universe, dates } = prepared;
  let state = await loadRunState(dir);
  if (!state) {
    if (!agent) throw new Error("Missing run state");
    state = { artifactVersion: ARTIFACT_VERSION, datasetVersion: market.version, attemptHashes: [], config, status: "active", completedDates: [], lastNetWorth: config.startingCapital, createdAt: nowIso(), updatedAt: nowIso() };
    await saveRunState(dir, state);
  }
  const oldState = JSON.stringify(state);
  const records = await reconstruct(dir, state, config, dates, universe, market);
  const attempts = await loadAttempts(dir);
  if (attempts.some((a) => !dates.includes(a.date) || dates.indexOf(a.date) > records.length)) throw new Error("Attempt date outside committed or next evaluation day");
  const attemptHashes = attempts.map(contentHash);
  const anchored = state.attemptHashes!;
  if (anchored.length > attemptHashes.length || anchored.some((h, i) => h !== attemptHashes[i])) throw new Error("Missing or changed anchored attempt evidence");
  const orphans = attempts.slice(anchored.length);
  if (orphans.length > 1 || orphans.some((a) => a.date !== dates[records.length])) throw new Error("Unanchored attempts are not a recoverable next-day orphan");
  for (const record of records) {
    const expected = attempts.filter((a) => a.date <= record.date).map(contentHash);
    if (JSON.stringify(record.priorAttemptHashes) !== JSON.stringify(expected)) throw new Error(`Daily attempt evidence anchor mismatch for ${record.date}`);
  }
  if (state.status === "failed" && !attempts.some((a) => a.date === dates[state.completedDates.length])) throw new Error("Failed run state is missing its attempt evidence");
  for (const attempt of attempts) {
    const index = dates.indexOf(attempt.date);
    const prior = index ? records[index - 1]!.portfolioAfter : createInitialPortfolio(config.startingCapital);
    const expectedContext = buildDecisionContext(config, attempt.date, universe, prior, records.slice(Math.max(0, index - RECENT_DAY_LIMIT), index), market);
    const expectedHash = contentHash(expectedContext);
    if (attempt.contextHash !== expectedHash) throw new Error(`Attempt context mismatch for ${attempt.date}`);
    if (attempt.decision && attempt.failurePhase) {
      let observed: unknown;
      try { replayDecision(config, attempt.date, universe, prior, attempt.decision, market, records.slice(Math.max(0, index - RECENT_DAY_LIMIT), index)); }
      catch (error) { observed = error; }
      if (!(observed instanceof DecisionAttemptError) || observed.failurePhase !== attempt.failurePhase || observed.message !== attempt.reason) throw new Error(`Returned-decision failure evidence does not reproduce for ${attempt.date}`);
    } else if (attempt.decision) validateDecisionEvidence(attempt.decision, expectedHash, config, attempt.date, expectedContext);
  }
  state.attemptHashes = attemptHashes;
  state.config = config;
  state.completedDates = records.map((r) => r.date);
  state.lastNetWorth = records.at(-1)?.portfolioAfter.netWorth ?? config.startingCapital;
  if (records.at(-1)?.terminated) state.status = "terminated";
  else if (records.length === dates.length) state.status = "completed";
  else if (agent || state.status === "completed") state.status = "active";
  if (!agent && records.length < dates.length && state.status !== "terminated") {
    const latestFailure = attempts.filter((a) => a.date === dates[records.length]).at(-1);
    if (latestFailure) { state.status = "failed"; state.failure = { date: latestFailure.date, reason: latestFailure.reason ?? latestFailure.outcome }; }
    else if (state.status === "failed") throw new Error("Failed run state is missing its attempt evidence");
  }
  if (state.status !== "failed") delete state.failure;
  if (JSON.stringify(state) !== oldState) { state.updatedAt = nowIso(); await saveRunState(dir, state); }
  if (agent && state.status === "active") {
    for (const date of dates.slice(records.length)) {
      let record: DailyRecord;
      try { record = await runOneDay(agent, config, date, universe, records.at(-1)?.portfolioAfter ?? createInitialPortfolio(config.startingCapital), records.slice(-RECENT_DAY_LIMIT), market, state.attemptHashes); }
      catch (error) {
        const decision = error instanceof DecisionAttemptError ? error.decision : undefined;
        const attempt: AttemptRecord = { artifactVersion: ARTIFACT_VERSION, date, contextHash: contentHash(buildDecisionContext(config, date, universe, records.at(-1)?.portfolioAfter ?? createInitialPortfolio(config.startingCapital), records.slice(-RECENT_DAY_LIMIT), market)), attempt: attempts.filter((a) => a.date === date).length + 1,
          outcome: error instanceof DecisionAttemptError && error.failurePhase ? "harness_error" : decision?.outcome && decision.outcome !== "completed" ? decision.outcome : decision?.boundedStop ? "budget_cutoff" : "harness_error",
          ...(error instanceof DecisionAttemptError && error.failurePhase ? { failurePhase: error.failurePhase } : {}),
          reason: error instanceof Error ? error.message : String(error), ...(decision ? { decision } : {}), usage: decision ? decisionUsage(decision.usage) : zeroUsage() };
        await writeAttempt(dir, attempt); attempts.push(attempt); state.attemptHashes!.push(contentHash(attempt));
        state.status = "failed"; state.failure = { date, reason: attempt.reason! }; state.updatedAt = nowIso(); await saveRunState(dir, state);
        break;
      }
      await writeDailyRecord(dir, record);
      records.push(record); state.completedDates.push(date); state.lastNetWorth = record.portfolioAfter.netWorth;
      state.status = record.terminated ? "terminated" : records.length === dates.length ? "completed" : "active";
      state.updatedAt = nowIso(); await saveRunState(dir, state);
      if (record.terminated) break;
    }
  }
  return deriveSummary(dir, config, state, records, attempts, dates, universe, market);
}

export async function runBatch(configInput: RunConfig, agent: AgentPort): Promise<{ runId: string; dir: string; summary: RunSummary }> {
  if (configInput.agent !== "fake" && configInput.protocolVersion !== AGENT_PROTOCOL_VERSION) {
    throw new Error(`Live runs require protocol ${AGENT_PROTOCOL_VERSION}; historical protocols are available for report replay only. Start a new run.`);
  }
  const { runId, dir } = resolveRunDir(configInput);
  const config = { ...configInput, runId };
  const prepared = await preflight(config);
  const release = await acquireRunLock(dir);
  try { const resolved = await ensureConfig(dir, config); return { runId, dir, summary: await processRun(dir, resolved, prepared, agent) }; }
  finally { await release(); }
}

/** Authoritative report entry point: validate frozen inputs and every daily
 * ledger, then repair derived artifacts. Never invokes an agent. Legacy,
 * inconsistent and corrupted authoritative artifacts are rejected. */
export async function loadValidatedSummary(dir: string): Promise<RunSummary> {
  const config = JSON.parse(await readFile(runConfigFile(dir), "utf8")) as RunConfig;
  const prepared = await preflight(config);
  const release = await acquireRunLock(dir);
  try { return await processRun(dir, config, prepared); }
  finally { await release(); }
}
