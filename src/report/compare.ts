import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { RunConfig, RunSummary, PortfolioState } from "../domain/types.ts";

export interface ComparisonRow {
  runDir: string; model: string; provider: string; seed: number; agent: string;
  status: string; experiment: string; daysRun: number; endingNetWorth: number;
  totalContributions: number; netProfit: number; totalReturnPct: number;
  maxDrawdownPct: number; annualizedVolatilityPct: number; sharpe: number | null;
  tradeCount: number; failedOrderCount: number; boundedStopCount: number;
  failedAttemptCount: number; cashReturnPct: number; buyAndHoldReturnPct: number;
  usagePromptTokens: number; usageCompletionTokens: number; cacheReadTokens: number;
  cacheWriteTokens: number; costUsd: number; finalPortfolio: PortfolioState;
}
export interface ComparisonCohort {
  comparisonProfile?: string;
  cohortKey: string; universeVersion: string; fixtureVersion: string;
  executionConvention: string; protocolVersion: string; startDate: string | null;
  endDate: string | null; startingCapital: number; limits: RunConfig["limits"];
  experiment: string; rows: ComparisonRow[];
}

/** Reporting replays and validates committed artifacts; summary.json is never trusted alone. */
export async function loadSummary(dir: string): Promise<RunSummary> {
  const { loadValidatedSummary } = await import("../run/orchestrator.ts");
  return loadValidatedSummary(dir);
}
export async function discoverRunDirs(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (entries.some(e => e.isFile() && e.name === "config.json")) { found.push(dir); return; }
    for (const entry of entries) if (entry.isDirectory()) await walk(join(dir, entry.name));
  }
  await walk(root);
  return found.sort();
}
export function cohortKeyOf(config: RunConfig): string {
  return JSON.stringify({universe:config.universeVersion,data:config.fixtureVersion,execution:config.executionConvention,
    protocol:config.protocolVersion,start:config.startDate,end:config.endDate,capital:config.startingCapital,
    contributions:config.contributions??[],limits:config.limits,warmup:config.warmupBars??0,
    experiment:config.experiment??"legacy",agent:config.agent,
    ...(config.comparisonProfile ? { comparisonProfile:config.comparisonProfile } : {})});
}
export function toRow(dir: string, summary: RunSummary): ComparisonRow {
  if (!summary.finalPortfolio || summary.totalContributions===undefined || summary.netProfit===undefined) throw new Error("Missing validated final portfolio or contribution accounting");
  return {runDir:dir,model:summary.config.model,provider:summary.config.provider??"legacy",seed:summary.config.seed,
    agent:summary.config.agent,status:summary.status,experiment:summary.config.experiment??"legacy",daysRun:summary.metrics.daysRun,
    endingNetWorth:summary.metrics.endingNetWorth,totalContributions:summary.totalContributions,netProfit:summary.netProfit,
    totalReturnPct:summary.timeWeightedReturnPct??summary.metrics.totalReturnPct,maxDrawdownPct:summary.metrics.maxDrawdownPct,
    annualizedVolatilityPct:summary.metrics.annualizedVolatilityPct,sharpe:summary.metrics.sharpe,tradeCount:summary.metrics.tradeCount,
    failedOrderCount:summary.metrics.failedOrderCount,boundedStopCount:summary.metrics.boundedStopCount,
    failedAttemptCount:summary.failedAttemptCount??0,cashReturnPct:summary.baselines.cash.metrics.totalReturnPct,
    buyAndHoldReturnPct:summary.baselines.buyAndHold.metrics.totalReturnPct,usagePromptTokens:summary.usageTotals.promptTokens,
    usageCompletionTokens:summary.usageTotals.completionTokens,cacheReadTokens:summary.usageTotals.cacheReadTokens??0,
    cacheWriteTokens:summary.usageTotals.cacheWriteTokens??0,costUsd:summary.usageTotals.costUsd??0,finalPortfolio:summary.finalPortfolio};
}
export async function buildComparison(dirs: readonly string[], options: { strict?: boolean } = {}): Promise<ComparisonCohort[]> {
  const cohorts=new Map<string,ComparisonCohort>();
  for (const dir of [...new Set(dirs)]) {
    let summary:RunSummary;
    try { summary=await loadSummary(dir); }
    catch(error) { if(options.strict) throw error; console.error(`[report] Excluded ${dir}: ${error instanceof Error?error.message:error}`); continue; }
    const key=cohortKeyOf(summary.config);const config=summary.config;
    const cohort=cohorts.get(key)??{...(config.comparisonProfile ? {comparisonProfile:config.comparisonProfile} : {}),cohortKey:key,universeVersion:config.universeVersion,fixtureVersion:config.fixtureVersion,
      executionConvention:config.executionConvention,protocolVersion:config.protocolVersion,startDate:config.startDate,
      endDate:config.endDate,startingCapital:config.startingCapital,limits:config.limits,experiment:config.experiment??"legacy",rows:[]};
    cohort.rows.push(toRow(dir,summary));cohorts.set(key,cohort);
  }
  return [...cohorts.values()];
}
const cell=(value:string)=>value.replace(/\|/g,"\\|").replace(/[\r\n]/g," ");
export function renderMarkdownTable(cohorts: readonly ComparisonCohort[], relativeTo?:string): string {
  return cohorts.map(cohort=>{
    const lines=[`### ${cohort.experiment}: ${cohort.startDate} through ${cohort.endDate}`,"",
      `Dataset: \`${cohort.fixtureVersion}\`; universe: \`${cohort.universeVersion}\`; protocol: \`${cohort.protocolVersion}\`.`,"",
      `Adapter: ${cohort.rows[0]?.agent ?? "unknown"}. Daily limits: ${cohort.limits.maxTurns} turns, ${cohort.limits.maxToolCalls} attempted tools, ${cohort.limits.timeoutMs} ms. Execution: ${cohort.executionConvention}.`,"",
      ...(cohort.comparisonProfile ? [`Comparison profile: \`${cohort.comparisonProfile}\`.`, ""] : []),
      "Returns exclude contributions. Failed/incomplete runs are not qualified benchmark results.","",
      "| Model / provider | Seed | Status | Days | Principal | Final value | P&L | TWR % | Max DD % | Trades | Rejected | Failed attempts | B&H % | Tokens in / out | Cost USD |",
      "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"];
    for(const row of cohort.rows){
      lines.push(`| ${cell(row.model)} / ${cell(row.provider)} | ${row.seed} | ${row.status} | ${row.daysRun} | $${row.totalContributions.toFixed(2)} | $${row.endingNetWorth.toFixed(2)} | $${row.netProfit.toFixed(2)} | ${row.totalReturnPct.toFixed(2)} | ${row.maxDrawdownPct.toFixed(2)} | ${row.tradeCount} | ${row.failedOrderCount} | ${row.failedAttemptCount} | ${row.buyAndHoldReturnPct.toFixed(2)} | ${row.usagePromptTokens} / ${row.usageCompletionTokens} | ${row.costUsd.toFixed(6)} |`);
    }
    for(const row of cohort.rows){
      lines.push("",`#### Holdings: ${cell(row.model)} · seed ${row.seed}`,"",`Cash: **$${row.finalPortfolio.cash.toFixed(2)}**. Run: \`${cell(relativeTo?relative(relativeTo,row.runDir):row.runDir)}\`.`,"",
        "| Ticker | Shares | Average cost | Last close | Market value | Portfolio weight |","|---|---|---|---|---|---|");
      for(const [ticker,h] of Object.entries(row.finalPortfolio.holdings).sort(([a],[b])=>a.localeCompare(b))){
        lines.push(`| ${ticker} | ${h.units} | $${h.avgCost.toFixed(2)} | $${h.lastClose.toFixed(2)} | $${h.value.toFixed(2)} | ${(row.endingNetWorth>0?h.value/row.endingNetWorth*100:0).toFixed(2)}% |`);
      }
      if(Object.keys(row.finalPortfolio.holdings).length===0)lines.push("| — | 0 | — | — | $0.00 | 0.00% |");
    }
    return lines.join("\n");
  }).join("\n\n");
}
