import type {
  AttemptRecord, DailyRecord, EquityPoint, Metrics, PortfolioAnalytics, RunConfig, UsageStats,
} from "../domain/types.ts";
import type { MarketDataset } from "../data/dataset.ts";

const round2 = (value: number) => Math.round(value * 100) / 100;
const round4 = (value: number) => Math.round(value * 10_000) / 10_000;
const round8 = (value: number) => Math.round(value * 100_000_000) / 100_000_000;
const mean = (values: readonly number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
function stdev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}
function flowAdjustedReturns(curve: readonly EquityPoint[], startingCapital: number): number[] {
  let previous = startingCapital;
  return curve.map(point => {
    const denominator = previous + (point.contribution ?? 0);
    const value = denominator > 0 ? point.netWorth / denominator - 1 : 0;
    previous = point.netWorth;
    return value;
  });
}
function compoundedPct(returns: readonly number[]): number {
  return round4((returns.reduce((factor, value) => factor * (1 + value), 1) - 1) * 100);
}
function investedPct(record: DailyRecord): number {
  return record.portfolioAfter.netWorth > 0 ? record.portfolioAfter.holdingsValue / record.portfolioAfter.netWorth * 100 : 0;
}
function signedNotional(record: DailyRecord): number {
  return record.fills.reduce((sum, fill) => sum + (fill.side === "BUY" ? fill.notional : -fill.notional), 0);
}

/** Derived only for configs carrying a locked behaviorAnalysis identity. Legacy
 * summaries omit this entire block, so their historical meaning is unchanged. */
export function derivePortfolioAnalytics(args: {
  config: RunConfig;
  records: readonly DailyRecord[];
  attempts: readonly AttemptRecord[];
  modelMetrics: Metrics;
  cashMetrics: Metrics;
  referenceCurve: readonly EquityPoint[];
  referenceMetrics: Metrics;
  usage: UsageStats;
  market: MarketDataset;
}): PortfolioAnalytics | undefined {
  const { config, records, attempts, modelMetrics, cashMetrics, referenceCurve, referenceMetrics, usage, market } = args;
  const rules = config.behaviorAnalysis;
  if (!rules) return undefined;
  if (rules.version !== "dip-behavior-v1" || rules.reference !== "equal-weight-buy-and-hold"
    || ![rules.dailyLossThresholdPct, rules.drawdownThresholdPct].every(value => Number.isFinite(value) && value > 0)
    || rules.liquidityMetric !== "filled-shares-over-session-volume"
    || !Number.isSafeInteger(rules.cooldownSessions) || rules.cooldownSessions < 0
    || !Number.isSafeInteger(rules.forwardSessions) || rules.forwardSessions < 1) {
    throw new Error("Invalid registered behavior-analysis rules");
  }
  if (referenceCurve.length !== records.length) throw new Error("Behavior reference curve is not aligned with committed model sessions");

  const invested = records.map(investedPct);
  const hhis: number[] = [], effective: number[] = [], holdingCounts: number[] = [], topWeights: number[] = [];
  const held = new Set<string>();
  for (const record of records) {
    const holdings = Object.entries(record.portfolioAfter.holdings).filter(([, holding]) => holding.value > 0);
    for (const [ticker] of holdings) held.add(ticker);
    holdingCounts.push(holdings.length);
    const riskyTotal = holdings.reduce((sum, [, holding]) => sum + holding.value, 0);
    const hhi = riskyTotal > 0 ? holdings.reduce((sum, [, holding]) => sum + (holding.value / riskyTotal) ** 2, 0) : 0;
    hhis.push(hhi);
    effective.push(hhi > 0 ? 1 / hhi : 0);
    topWeights.push(record.portfolioAfter.netWorth > 0 ? Math.max(0, ...holdings.map(([, holding]) => holding.value / record.portfolioAfter.netWorth * 100)) : 0);
  }

  const fills = records.flatMap(record => record.fills);
  const buyNotional = fills.filter(fill => fill.side === "BUY").reduce((sum, fill) => sum + fill.notional, 0);
  const sellNotional = fills.filter(fill => fill.side === "SELL").reduce((sum, fill) => sum + fill.notional, 0);
  const totalTokens = (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
  const rejectedOrders = records.reduce((sum, record) => sum + record.failedOrders.length, 0);
  const submittedOrders = records.reduce((sum, record) => sum + (record.submittedOrders ?? record.decision?.submittedOrders ?? record.decision?.orders ?? []).length, 0);
  const elapsed = records.map(record => record.decision?.elapsedMs ?? 0);

  const liquidityRatios: number[] = [];
  let zeroVolumeFills = 0;
  for (const record of records) for (const fill of record.fills) {
    const volume = market.volumeOn(fill.ticker, record.date);
    if (volume <= 0) zeroVolumeFills++;
    else liquidityRatios.push(fill.units / volume * 100);
  }

  const modelCurve = records.map(record => ({ date: record.date, netWorth: record.portfolioAfter.netWorth, ...(record.contribution ? { contribution: record.contribution } : {}) }));
  const modelReturns = flowAdjustedReturns(modelCurve, config.startingCapital);
  const referenceReturns = flowAdjustedReturns(referenceCurve, config.startingCapital);
  const excessReturns = modelReturns.map((value, index) => value - referenceReturns[index]!);
  const trackingError = stdev(excessReturns);
  const informationRatio = trackingError > 0 ? mean(excessReturns) / trackingError * Math.sqrt(252) : null;

  let referenceIndex = 1, referencePeak = 1, lastTrigger = -Infinity;
  const dipEvents: PortfolioAnalytics["dipBehavior"]["events"] = [];
  for (let index = 0; index < records.length; index++) {
    referenceIndex *= 1 + referenceReturns[index]!;
    referencePeak = Math.max(referencePeak, referenceIndex);
    const dailyPct = referenceReturns[index]! * 100;
    const drawdownPct = referencePeak > 0 ? (referenceIndex / referencePeak - 1) * 100 : 0;
    const reasons: Array<"reference-daily-loss" | "reference-drawdown"> = [];
    if (dailyPct <= -rules.dailyLossThresholdPct) reasons.push("reference-daily-loss");
    if (drawdownPct <= -rules.drawdownThresholdPct) reasons.push("reference-drawdown");
    if (!reasons.length || index - lastTrigger <= rules.cooldownSessions) continue;
    lastTrigger = index;
    const start = index + 1;
    const end = index + rules.forwardSessions;
    const complete = end < records.length;
    const modelForward = complete ? compoundedPct(modelReturns.slice(start, end + 1)) : null;
    const referenceForward = complete ? compoundedPct(referenceReturns.slice(start, end + 1)) : null;
    dipEvents.push({
      triggerDate: records[index]!.date,
      triggerReasons: reasons,
      referenceDailyReturnPct: round4(dailyPct),
      referenceDrawdownPct: round4(drawdownPct),
      forwardWindowStart: records[start]?.date ?? null,
      forwardWindowEnd: complete ? records[end]!.date : null,
      completeForwardWindow: complete,
      modelInvestedPctAtTrigger: round4(invested[index]!),
      modelExposureChangePctPoints: complete ? round4(invested[end]! - invested[index]!) : null,
      modelForwardReturnPct: modelForward,
      referenceForwardReturnPct: referenceForward,
      forwardExcessReturnPct: modelForward === null || referenceForward === null ? null : round4(modelForward - referenceForward),
      forwardNetBuyNotional: complete ? round2(records.slice(start, end + 1).reduce((sum, record) => sum + signedNotional(record), 0)) : null,
    });
  }

  const averageInvestedPct = mean(invested);
  const finalHoldings = records.at(-1)?.portfolioAfter.holdings ?? {};
  const finalNetWorth = records.at(-1)?.portfolioAfter.netWorth ?? config.startingCapital;
  const finalTopWeight = finalNetWorth > 0 ? Math.max(0, ...Object.values(finalHoldings).map(holding => holding.value / finalNetWorth * 100)) : 0;
  const totalPrincipal = modelMetrics.totalContributions ?? config.startingCapital;
  const netProfit = modelMetrics.netProfit ?? modelMetrics.endingNetWorth - totalPrincipal;
  const decisions = records.length;
  const failedAttempts = attempts.filter(attempt => attempt.outcome !== "completed").length;

  return {
    rules: structuredClone(rules),
    excessReturn: {
      versusCashPct: round4(modelMetrics.totalReturnPct - cashMetrics.totalReturnPct),
      versusEqualWeightPct: round4(modelMetrics.totalReturnPct - referenceMetrics.totalReturnPct),
    },
    concentration: {
      averageRiskyHhi: round4(mean(hhis)), maximumRiskyHhi: round4(Math.max(0, ...hhis)),
      averageEffectiveRiskyPositions: round4(mean(effective)), averageHoldingCount: round4(mean(holdingCounts)),
      maximumSingleSecurityWeightPct: round4(Math.max(0, ...topWeights)), finalSingleSecurityWeightPct: round4(finalTopWeight),
    },
    cashDeployment: {
      averageInvestedPct: round4(averageInvestedPct), finalInvestedPct: round4(invested.at(-1) ?? 0),
      minimumInvestedPct: round4(invested.length ? Math.min(...invested) : 0), maximumInvestedPct: round4(Math.max(0, ...invested)),
      fullyCashDays: invested.filter(value => value === 0).length,
      contributionDayNetBuyPct: records.filter(record => !!record.contribution).map(record => {
        const netBuyNotional = round2(signedNotional(record));
        return { date: record.date, contribution: record.contribution!, netBuyNotional, pctOfContribution: round4(netBuyNotional / record.contribution! * 100) };
      }),
    },
    capitalEfficiency: {
      netProfitPctOfPrincipal: round4(totalPrincipal > 0 ? netProfit / totalPrincipal * 100 : 0),
      timeWeightedReturnPerAverageInvestedFraction: averageInvestedPct > 0 ? round4(modelMetrics.totalReturnPct / (averageInvestedPct / 100)) : null,
    },
    holdingAndTrading: {
      tradeDays: records.filter(record => record.fills.length > 0).length, noTradeDays: records.filter(record => record.fills.length === 0).length,
      buyFills: fills.filter(fill => fill.side === "BUY").length, sellFills: fills.filter(fill => fill.side === "SELL").length,
      uniqueSecuritiesHeld: held.size, grossTradedNotional: round2(buyNotional + sellNotional), netBuyNotional: round2(buyNotional - sellNotional),
      cumulativeTurnoverPct: round4(records.reduce((sum, record) => sum + record.turnoverPct, 0)),
    },
    riskEfficiency: {
      sharpe: modelMetrics.sharpe,
      returnOverAbsoluteMaxDrawdown: modelMetrics.maxDrawdownPct < 0 ? round4(modelMetrics.totalReturnPct / Math.abs(modelMetrics.maxDrawdownPct)) : null,
      returnPerAnnualizedVolatility: modelMetrics.annualizedVolatilityPct > 0 ? round4(modelMetrics.totalReturnPct / modelMetrics.annualizedVolatilityPct) : null,
      trackingErrorAnnualizedPct: round4(trackingError * Math.sqrt(252) * 100), informationRatio: informationRatio === null ? null : round4(informationRatio),
    },
    operationalEfficiency: {
      decisionDays: decisions, failedAttempts, submittedOrders, fills: fills.length, rejectedOrders,
      fillRatePct: fills.length + rejectedOrders > 0 ? round4(fills.length / (fills.length + rejectedOrders) * 100) : null,
      turnsPerDecisionDay: decisions ? round4((usage.turns ?? 0) / decisions) : 0,
      toolCallsPerDecisionDay: decisions ? round4((usage.toolCalls ?? 0) / decisions) : 0,
      tokensPerDecisionDay: decisions ? round4(totalTokens / decisions) : 0,
      tokensPerFill: fills.length ? round4(totalTokens / fills.length) : null,
      averageDecisionElapsedMs: round4(mean(elapsed)),
    },
    liquidity: {
      observedFills: fills.length, zeroVolumeFills,
      averageFilledSharesOfSessionVolumePct: liquidityRatios.length ? round8(mean(liquidityRatios)) : null,
      maximumFilledSharesOfSessionVolumePct: liquidityRatios.length ? round8(Math.max(...liquidityRatios)) : null,
      fillsAboveOnePctOfSessionVolume: liquidityRatios.filter(value => value > 1).length,
    },
    dipBehavior: {
      definition: "At an equal-weight close, trigger when its flow-adjusted daily return is at or below the negative daily threshold or its flow-adjusted drawdown is at or below the negative drawdown threshold; suppress triggers for the configured number of subsequent sessions; measure model actions and flow-adjusted returns over the next N sessions only (the trigger-day decision predates the triggering close). Incomplete terminal windows remain null.",
      events: dipEvents,
    },
  };
}
