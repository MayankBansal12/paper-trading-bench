import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { PortfolioAnalytics, PortfolioState, RunConfig, RunSummary } from "../domain/types.ts";

export interface ComparisonRow {
  runDir: string; model: string; provider: string; seed: number; agent: string;
  status: string; experiment: string; daysRun: number; endingNetWorth: number;
  totalContributions: number; netProfit: number; totalReturnPct: number;
  maxDrawdownPct: number; annualizedVolatilityPct: number; sharpe: number | null;
  tradeCount: number; failedOrderCount: number; boundedStopCount: number;
  failedAttemptCount: number; cashReturnPct: number; buyAndHoldReturnPct: number;
  usagePromptTokens: number; usageCompletionTokens: number; cacheReadTokens: number;
  cacheWriteTokens: number; costUsd: number; finalPortfolio: PortfolioState;
  analytics?: PortfolioAnalytics;
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
    if (entries.some(entry => entry.isFile() && entry.name === "config.json")) { found.push(dir); return; }
    for (const entry of entries) if (entry.isDirectory()) await walk(join(dir, entry.name));
  }
  await walk(root);
  return found.sort();
}
export function cohortKeyOf(config: RunConfig): string {
  return JSON.stringify({ universe: config.universeVersion, data: config.fixtureVersion, execution: config.executionConvention,
    protocol: config.protocolVersion, start: config.startDate, end: config.endDate, capital: config.startingCapital,
    contributions: config.contributions ?? [], limits: config.limits, warmup: config.warmupBars ?? 0,
    experiment: config.experiment ?? "legacy", agent: config.agent, behaviorAnalysis: config.behaviorAnalysis ?? null,
    ...(config.comparisonProfile ? { comparisonProfile: config.comparisonProfile } : {}) });
}
export function toRow(dir: string, summary: RunSummary): ComparisonRow {
  if (!summary.finalPortfolio || summary.totalContributions === undefined || summary.netProfit === undefined) throw new Error("Missing validated final portfolio or contribution accounting");
  return { runDir: dir, model: summary.config.model, provider: summary.config.provider ?? "legacy", seed: summary.config.seed,
    agent: summary.config.agent, status: summary.status, experiment: summary.config.experiment ?? "legacy", daysRun: summary.metrics.daysRun,
    endingNetWorth: summary.metrics.endingNetWorth, totalContributions: summary.totalContributions, netProfit: summary.netProfit,
    totalReturnPct: summary.timeWeightedReturnPct ?? summary.metrics.totalReturnPct, maxDrawdownPct: summary.metrics.maxDrawdownPct,
    annualizedVolatilityPct: summary.metrics.annualizedVolatilityPct, sharpe: summary.metrics.sharpe, tradeCount: summary.metrics.tradeCount,
    failedOrderCount: summary.metrics.failedOrderCount, boundedStopCount: summary.metrics.boundedStopCount,
    failedAttemptCount: summary.failedAttemptCount ?? 0, cashReturnPct: summary.baselines.cash.metrics.totalReturnPct,
    buyAndHoldReturnPct: summary.baselines.buyAndHold.metrics.totalReturnPct, usagePromptTokens: summary.usageTotals.promptTokens,
    usageCompletionTokens: summary.usageTotals.completionTokens, cacheReadTokens: summary.usageTotals.cacheReadTokens ?? 0,
    cacheWriteTokens: summary.usageTotals.cacheWriteTokens ?? 0, costUsd: summary.usageTotals.costUsd ?? 0, finalPortfolio: summary.finalPortfolio,
    ...(summary.analytics ? { analytics: summary.analytics } : {}) };
}
export async function buildComparison(dirs: readonly string[], options: { strict?: boolean } = {}): Promise<ComparisonCohort[]> {
  const cohorts = new Map<string, ComparisonCohort>();
  for (const dir of [...new Set(dirs)]) {
    let summary: RunSummary;
    try { summary = await loadSummary(dir); }
    catch (error) { if (options.strict) throw error; console.error(`[report] Excluded ${dir}: ${error instanceof Error ? error.message : error}`); continue; }
    const key = cohortKeyOf(summary.config), config = summary.config;
    const cohort = cohorts.get(key) ?? { ...(config.comparisonProfile ? { comparisonProfile: config.comparisonProfile } : {}), cohortKey: key,
      universeVersion: config.universeVersion, fixtureVersion: config.fixtureVersion, executionConvention: config.executionConvention,
      protocolVersion: config.protocolVersion, startDate: config.startDate, endDate: config.endDate,
      startingCapital: config.startingCapital, limits: config.limits, experiment: config.experiment ?? "legacy", rows: [] };
    cohort.rows.push(toRow(dir, summary)); cohorts.set(key, cohort);
  }
  return [...cohorts.values()];
}
const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/[\r\n]/g, " ");
const value = (number: number | null, digits = 4) => number === null ? "—" : number.toFixed(digits);
export function renderMarkdownTable(cohorts: readonly ComparisonCohort[], relativeTo?: string): string {
  return cohorts.map(cohort => {
    const lines = [`### ${cohort.experiment}: ${cohort.startDate} through ${cohort.endDate}`, "",
      `Dataset: \`${cohort.fixtureVersion}\`; universe: \`${cohort.universeVersion}\`; protocol: \`${cohort.protocolVersion}\`.`, "",
      `Adapter: ${cohort.rows[0]?.agent ?? "unknown"}. Daily limits: ${cohort.limits.maxTurns} turns, ${cohort.limits.maxToolCalls} attempted tools, ${cohort.limits.timeoutMs} ms. Execution: ${cohort.executionConvention}.`, "",
      ...(cohort.comparisonProfile ? [`Comparison profile: \`${cohort.comparisonProfile}\`.`, ""] : []),
      "Returns exclude contributions. Failed/incomplete runs are not qualified benchmark results.", "",
      "| Model / provider | Seed | Status | Days | Principal | Final value | P&L | TWR % | Max DD % | Trades | Rejected | Failed attempts | B&H % | Tokens in / out | Cost USD |",
      "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"];
    for (const row of cohort.rows) lines.push(`| ${cell(row.model)} / ${cell(row.provider)} | ${row.seed} | ${row.status} | ${row.daysRun} | $${row.totalContributions.toFixed(2)} | $${row.endingNetWorth.toFixed(2)} | $${row.netProfit.toFixed(2)} | ${row.totalReturnPct.toFixed(2)} | ${row.maxDrawdownPct.toFixed(2)} | ${row.tradeCount} | ${row.failedOrderCount} | ${row.failedAttemptCount} | ${row.buyAndHoldReturnPct.toFixed(2)} | ${row.usagePromptTokens} / ${row.usageCompletionTokens} | ${row.costUsd.toFixed(6)} |`);
    for (const row of cohort.rows) {
      lines.push("", `#### Holdings: ${cell(row.model)} · seed ${row.seed}`, "", `Cash: **$${row.finalPortfolio.cash.toFixed(2)}**. Run: \`${cell(relativeTo ? relative(relativeTo, row.runDir) : row.runDir)}\`.`, "",
        "| Ticker | Shares | Average cost | Last close | Market value | Portfolio weight |", "|---|---|---|---|---|---|");
      for (const [ticker, holding] of Object.entries(row.finalPortfolio.holdings).sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(`| ${ticker} | ${holding.units} | $${holding.avgCost.toFixed(2)} | $${holding.lastClose.toFixed(2)} | $${holding.value.toFixed(2)} | ${(row.endingNetWorth > 0 ? holding.value / row.endingNetWorth * 100 : 0).toFixed(2)}% |`);
      }
      if (!Object.keys(row.finalPortfolio.holdings).length) lines.push("| — | 0 | — | — | $0.00 | 0.00% |");
      const a = row.analytics;
      if (!a) continue;
      lines.push("", `#### Registered analytics: ${cell(row.model)} · seed ${row.seed}`, "",
        "No composite intelligence score is calculated. Each dimension remains independently inspectable.", "",
        "| Excess vs cash | Excess vs equal weight | Avg / final invested | Avg risky HHI | Max security weight | Cumulative turnover |",
        "|---|---|---|---|---|---|",
        `| ${a.excessReturn.versusCashPct.toFixed(2)}% | ${a.excessReturn.versusEqualWeightPct.toFixed(2)}% | ${a.cashDeployment.averageInvestedPct.toFixed(2)}% / ${a.cashDeployment.finalInvestedPct.toFixed(2)}% | ${a.concentration.averageRiskyHhi.toFixed(4)} | ${a.concentration.maximumSingleSecurityWeightPct.toFixed(2)}% | ${a.holdingAndTrading.cumulativeTurnoverPct.toFixed(2)}% |`, "",
        "| Sharpe | Return / max drawdown | Return / annualized volatility | Tracking error | Information ratio |",
        "|---|---|---|---|---|",
        `| ${value(a.riskEfficiency.sharpe)} | ${value(a.riskEfficiency.returnOverAbsoluteMaxDrawdown)} | ${value(a.riskEfficiency.returnPerAnnualizedVolatility)} | ${a.riskEfficiency.trackingErrorAnnualizedPct.toFixed(2)}% | ${value(a.riskEfficiency.informationRatio)} |`, "",
        `Operations: ${a.operationalEfficiency.fills} fills, ${a.operationalEfficiency.rejectedOrders} rejected orders, ${a.operationalEfficiency.failedAttempts} failed attempts, fill rate ${value(a.operationalEfficiency.fillRatePct, 2)}%, ${a.operationalEfficiency.tokensPerDecisionDay.toFixed(2)} tokens/decision day.`, "",
        `Liquidity: maximum fill was ${value(a.liquidity.maximumFilledSharesOfSessionVolumePct, 8)}% of reported session volume; ${a.liquidity.zeroVolumeFills} fills had zero reported volume.`, "",
        `Dip rule: ${a.dipBehavior.definition}`, "",
        "| Trigger | Reasons | Reference day / drawdown | Forward window | Exposure change | Model / reference forward return | Forward net buys |",
        "|---|---|---|---|---|---|---|");
      for (const event of a.dipBehavior.events) lines.push(`| ${event.triggerDate} | ${event.triggerReasons.join(", ")} | ${event.referenceDailyReturnPct.toFixed(2)}% / ${event.referenceDrawdownPct.toFixed(2)}% | ${event.forwardWindowStart ?? "—"}..${event.forwardWindowEnd ?? "incomplete"} | ${value(event.modelExposureChangePctPoints, 2)} pp | ${value(event.modelForwardReturnPct, 2)}% / ${value(event.referenceForwardReturnPct, 2)}% | ${event.forwardNetBuyNotional === null ? "—" : "$" + event.forwardNetBuyNotional.toFixed(2)} |`);
      if (!a.dipBehavior.events.length) lines.push("| — | No registered triggers | — | — | — | — | — |");
    }
    return lines.join("\n");
  }).join("\n\n");
}
