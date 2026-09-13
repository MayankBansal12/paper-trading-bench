import { expect, test } from "bun:test";
import { derivePortfolioAnalytics } from "../src/report/analytics.ts";
import { computeMetrics } from "../src/engine/metrics.ts";
import { cashBaseline } from "../src/engine/baselines.ts";
import type { DailyRecord, EquityPoint, PortfolioState, RunConfig } from "../src/domain/types.ts";
import type { MarketDataset } from "../src/data/dataset.ts";

const dates = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05", "2026-06-08"];
const modelValues = [100, 99, 98, 100, 101, 102];
const referenceValues = [100, 97, 94, 96, 90, 91];
function portfolio(netWorth: number, invested: number): PortfolioState {
  return { cash: netWorth - invested, holdingsValue: invested, netWorth,
    holdings: invested ? { AAPL: { units: invested / 100, avgCost: 100, lastClose: 100, value: invested } } : {} };
}
const records: DailyRecord[] = dates.map((date, index) => ({
  date, portfolioBefore: portfolio(index ? modelValues[index - 1]! : 100, 50), portfolioAfter: portfolio(modelValues[index]!, 50 + index * 5),
  fills: index === 0 ? [{ date, ticker: "AAPL", side: "BUY", units: 0.5, price: 100, notional: 50, cashAfter: 50 }]
    : index === 2 ? [{ date, ticker: "AAPL", side: "SELL", units: 0.1, price: 100, notional: 10, cashAfter: 48 }] : [],
  failedOrders: index === 3 ? [{ date, ticker: "AAPL", side: "BUY", reason: "insufficient cash" }] : [],
  submittedOrders: index === 0 || index === 2 ? [{ ticker: "AAPL", side: index === 0 ? "BUY" : "SELL", sizing: { kind: "units", units: index === 0 ? 0.5 : 0.1 } }] : [],
  rationale: "test", usage: { turns: 1, toolCalls: 2, failedToolCalls: 0, promptTokens: 10, completionTokens: 5 },
  turnoverPct: index === 0 ? 50 : index === 2 ? 10.101 : 0, terminated: false, boundedStop: false, boundedReason: null,
}));
const curve = (values: number[]): EquityPoint[] => dates.map((date, index) => ({ date, netWorth: values[index]! }));
const config: RunConfig = { model: "fake", seed: 1, agent: "fake", startDate: dates[0]!, endDate: dates.at(-1)!, startingCapital: 100,
  universeVersion: "v1", limits: { maxTurns: 2, maxToolCalls: 4, timeoutMs: 1000 }, executionConvention: "test", fixtureVersion: "test",
  protocolVersion: "test", behaviorAnalysis: { version: "dip-behavior-v1", reference: "equal-weight-buy-and-hold", dailyLossThresholdPct: 2,
    drawdownThresholdPct: 5, cooldownSessions: 1, forwardSessions: 2, liquidityMetric: "filled-shares-over-session-volume" } };
const market = { volumeOn: () => 100 } as unknown as MarketDataset;

test("registered analytics keep dimensions separate and measure causal forward dip behavior", () => {
  const modelCurve = curve(modelValues), referenceCurve = curve(referenceValues), cashCurve = cashBaseline(100, dates);
  const modelMetrics = computeMetrics(modelCurve, 100, 2, 1, 0, records.map(record => record.turnoverPct));
  const referenceMetrics = computeMetrics(referenceCurve, 100, 6, 0, 0, dates.map(() => 0));
  const result = derivePortfolioAnalytics({ config, records, attempts: [{ artifactVersion: "x", date: dates[3]!, attempt: 1, contextHash: "x", outcome: "provider_error", reason: "x", usage: { turns: 1, toolCalls: 0, failedToolCalls: 0, promptTokens: 0, completionTokens: 0 } }],
    modelMetrics, cashMetrics: computeMetrics(cashCurve, 100, 0, 0, 0, dates.map(() => 0)), referenceCurve, referenceMetrics,
    usage: { turns: 6, toolCalls: 12, failedToolCalls: 1, promptTokens: 60, completionTokens: 30 }, market });
  expect(result).toBeDefined();
  expect(result!.excessReturn.versusEqualWeightPct).toBeCloseTo(modelMetrics.totalReturnPct - referenceMetrics.totalReturnPct, 4);
  expect(result!.concentration.averageRiskyHhi).toBe(1);
  expect(result!.cashDeployment.minimumInvestedPct).toBeGreaterThan(0);
  expect(result!.holdingAndTrading).toMatchObject({ tradeDays: 2, noTradeDays: 4, buyFills: 1, sellFills: 1, uniqueSecuritiesHeld: 1, grossTradedNotional: 60, netBuyNotional: 40 });
  expect(result!.operationalEfficiency).toMatchObject({ decisionDays: 6, failedAttempts: 1, submittedOrders: 2, fills: 2, rejectedOrders: 1, fillRatePct: 66.6667, turnsPerDecisionDay: 1, toolCallsPerDecisionDay: 2, tokensPerDecisionDay: 15, tokensPerFill: 45 });
  expect(result!.liquidity).toMatchObject({ observedFills: 2, zeroVolumeFills: 0, maximumFilledSharesOfSessionVolumePct: 0.5 });
  expect(result!.dipBehavior.events.map(event => event.triggerDate)).toEqual(["2026-06-02", "2026-06-05"]);
  expect(result!.dipBehavior.events[0]).toMatchObject({ forwardWindowStart: "2026-06-03", forwardWindowEnd: "2026-06-04", completeForwardWindow: true });
  expect(result!.dipBehavior.events[1]).toMatchObject({ forwardWindowEnd: null, completeForwardWindow: false, modelForwardReturnPct: null, forwardNetBuyNotional: null });
  expect(result!.dipBehavior.definition).toContain("trigger-day decision predates the triggering close");
  expect((result as any).intelligenceScore).toBeUndefined();
});

test("legacy configs get no new analytics and therefore no silent reinterpretation", () => {
  expect(derivePortfolioAnalytics({ config: { ...config, behaviorAnalysis: undefined }, records, attempts: [],
    modelMetrics: computeMetrics(curve(modelValues), 100, 0, 0, 0, dates.map(() => 0)),
    cashMetrics: computeMetrics(cashBaseline(100, dates), 100, 0, 0, 0, dates.map(() => 0)),
    referenceCurve: curve(referenceValues), referenceMetrics: computeMetrics(curve(referenceValues), 100, 0, 0, 0, dates.map(() => 0)),
    usage: { turns: 0, toolCalls: 0, failedToolCalls: 0, promptTokens: 0, completionTokens: 0 }, market })).toBeUndefined();
});
