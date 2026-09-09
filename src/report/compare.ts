// Aggregates one or more run summary.json files into a single comparison —
// JSON for tooling, a markdown table for humans. Runs are grouped into
// COHORTS by every field that affects comparability (universe, fixture
// snapshot, execution convention, date range, starting capital, limits); a
// model's return is never presented next to another run's unless everything
// but the model/seed/agent actually matches, so a reader can't mistake two
// non-comparable experiments for a head-to-head result.

import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { runSummaryFile } from "../utils/paths.ts";
import type { RunConfig, RunSummary } from "../domain/types.ts";

export interface ComparisonRow {
  runDir: string;
  model: string;
  seed: number;
  agent: string;
  status: string;
  daysRun: number;
  endingNetWorth: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  dailyVolatilityPct: number;
  annualizedVolatilityPct: number;
  sharpe: number | null;
  avgTurnoverPct: number;
  tradeCount: number;
  failedOrderCount: number;
  boundedStopCount: number;
  cashReturnPct: number;
  buyAndHoldReturnPct: number;
  usageTurns: number;
  usageToolCalls: number;
  usageFailedToolCalls: number;
  usagePromptTokens: number;
  usageCompletionTokens: number;
}

export interface ComparisonCohort {
  cohortKey: string;
  universeVersion: string;
  fixtureVersion: string;
  executionConvention: string;
  protocolVersion: string;
  startDate: string | null;
  endDate: string | null;
  startingCapital: number;
  limits: RunConfig["limits"];
  rows: ComparisonRow[];
}

export async function loadSummary(dir: string): Promise<RunSummary | null> {
  try {
    return JSON.parse(await readFile(runSummaryFile(dir), "utf8")) as RunSummary;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Recursively find every directory under `runsRoot` containing a summary.json. */
export async function discoverRunDirs(runsRoot: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === "summary.json")) {
      found.push(dir);
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) await walk(join(dir, e.name));
    }
  }
  await walk(runsRoot);
  return found;
}

export function cohortKeyOf(config: RunConfig): string {
  return [
    config.universeVersion,
    config.fixtureVersion,
    config.executionConvention,
    config.protocolVersion,
    config.startDate ?? "earliest",
    config.endDate ?? "latest",
    config.startingCapital,
    config.limits.maxTurns,
    config.limits.maxToolCalls,
    config.limits.timeoutMs,
  ].join("|");
}

export function toRow(dir: string, summary: RunSummary): ComparisonRow {
  return {
    runDir: dir,
    model: summary.config.model,
    seed: summary.config.seed,
    agent: summary.config.agent,
    status: summary.status,
    daysRun: summary.metrics.daysRun,
    endingNetWorth: summary.metrics.endingNetWorth,
    totalReturnPct: summary.metrics.totalReturnPct,
    maxDrawdownPct: summary.metrics.maxDrawdownPct,
    dailyVolatilityPct: summary.metrics.dailyVolatilityPct,
    annualizedVolatilityPct: summary.metrics.annualizedVolatilityPct,
    sharpe: summary.metrics.sharpe,
    avgTurnoverPct: summary.metrics.avgTurnoverPct,
    tradeCount: summary.metrics.tradeCount,
    failedOrderCount: summary.metrics.failedOrderCount,
    boundedStopCount: summary.metrics.boundedStopCount,
    cashReturnPct: summary.baselines.cash.metrics.totalReturnPct,
    buyAndHoldReturnPct: summary.baselines.buyAndHold.metrics.totalReturnPct,
    usageTurns: summary.usageTotals.turns,
    usageToolCalls: summary.usageTotals.toolCalls,
    usageFailedToolCalls: summary.usageTotals.failedToolCalls,
    usagePromptTokens: summary.usageTotals.promptTokens,
    usageCompletionTokens: summary.usageTotals.completionTokens,
  };
}

export async function buildComparison(runDirs: readonly string[]): Promise<ComparisonCohort[]> {
  const cohorts = new Map<string, ComparisonCohort>();
  for (const dir of runDirs) {
    const summary = await loadSummary(dir);
    if (!summary) {
      console.error(`[report] WARNING: no summary.json in ${dir}, skipping`);
      continue;
    }
    const key = cohortKeyOf(summary.config);
    let cohort = cohorts.get(key);
    if (!cohort) {
      cohort = {
        cohortKey: key,
        universeVersion: summary.config.universeVersion,
        fixtureVersion: summary.config.fixtureVersion,
        executionConvention: summary.config.executionConvention,
        protocolVersion: summary.config.protocolVersion,
        startDate: summary.config.startDate,
        endDate: summary.config.endDate,
        startingCapital: summary.config.startingCapital,
        limits: summary.config.limits,
        rows: [],
      };
      cohorts.set(key, cohort);
    }
    cohort.rows.push(toRow(dir, summary));
  }
  return [...cohorts.values()];
}

export function renderMarkdownTable(cohorts: readonly ComparisonCohort[], relativeTo?: string): string {
  const header =
    "| Model | Seed | Agent | Status | Days | Net Worth | Return % | Max DD % | Ann.Vol % | Sharpe | Turnover % | Trades | Failed | Bounded | Cash % | B&H % | Turns | Tool Calls | Failed Calls | Prompt Tok | Compl Tok |";
  const sep = "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";
  const sections = cohorts.map((cohort) => {
    const title = `### Cohort: universe=${cohort.universeVersion} fixture=${cohort.fixtureVersion} exec=${cohort.executionConvention} protocol=${cohort.protocolVersion} range=${cohort.startDate ?? "earliest"}..${cohort.endDate ?? "latest"} capital=$${cohort.startingCapital} limits=${cohort.limits.maxTurns}/${cohort.limits.maxToolCalls}/${cohort.limits.timeoutMs}ms`;
    const lines = cohort.rows.map((r) => {
      const dirLabel = relativeTo ? relative(relativeTo, r.runDir) : r.runDir;
      return `| ${r.model} (\`${dirLabel}\`) | ${r.seed} | ${r.agent} | ${r.status} | ${r.daysRun} | $${r.endingNetWorth.toFixed(2)} | ${r.totalReturnPct.toFixed(2)} | ${r.maxDrawdownPct.toFixed(2)} | ${r.annualizedVolatilityPct.toFixed(2)} | ${r.sharpe === null ? "n/a" : r.sharpe.toFixed(2)} | ${r.avgTurnoverPct.toFixed(2)} | ${r.tradeCount} | ${r.failedOrderCount} | ${r.boundedStopCount} | ${r.cashReturnPct.toFixed(2)} | ${r.buyAndHoldReturnPct.toFixed(2)} | ${r.usageTurns} | ${r.usageToolCalls} | ${r.usageFailedToolCalls} | ${r.usagePromptTokens} | ${r.usageCompletionTokens} |`;
    });
    return [title, "", header, sep, ...lines].join("\n");
  });
  return sections.join("\n\n");
}
