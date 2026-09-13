import { test, expect } from "bun:test";
import { compareNDX, loadNDX } from "../src/study/reference.ts";
import type { MarketDataset } from "../src/data/dataset.ts";
import type { DailyRecord } from "../src/domain/types.ts";
import { createInitialPortfolio } from "../src/engine/portfolio.ts";
const dates = ["2025-01-31", "2025-02-03"];
const market: MarketDataset = {
  version: "test",
  kind: "historical",
  calendar: dates,
  universe: ["NDX"],
  coverage: { start: dates[0]!, end: dates[1]! },
  evaluation: { start: dates[0]!, end: dates[1]! },
  asOfBefore: () => [],
  openOn: (_t, d) => (d === dates[0] ? 100 : 120),
  closeOn: (_t, d) => (d === dates[0] ? 110 : 132),
  volumeOn: () => 1000,
  actionsOn: () => [],
};
function record(date: string, equity: number, contribution = 0): DailyRecord {
  return {
    date,
    portfolioBefore: createInitialPortfolio(500),
    portfolioAfter: createInitialPortfolio(equity),
    contribution,
    fills: [],
    failedOrders: [],
    rationale: "control",
    usage: {
      turns: 0,
      toolCalls: 0,
      failedToolCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
    },
    turnoverPct: 0,
    terminated: false,
    boundedStop: false,
    boundedReason: null,
  };
}
test("NDX comparison aligns actual contribution opens and separates price return from funded return", async () => {
  const result = await compareNDX(
    market,
    [record(dates[0]!, 550.01), record(dates[1]!, 1210.02, 500)],
    [{ date: dates[1]!, amount: 500 }],
  );
  expect(result.metrics.endingNetWorth).toBe(1210.02);
  expect(result.metrics.totalContributions).toBe(1000);
  expect(result.openToFinalClosePct).toBeCloseTo(32, 6);
  expect(result.metrics.timeWeightedReturnPct).toBeCloseTo(
    ((550.01 / 500) * (1210.02 / 1050.01) - 1) * 100,
    4,
  );
  expect(result.activeReturnPercentagePoints).toBe(0);
  expect(result.trackingErrorAnnualizedPct).toBe(0);
  expect(result.informationRatio).toBeNull();
});
test("portfolio dividends are accounted separately, including same-day split-adjusted units", async () => {
  const day = record(dates[0]!, 500);
  day.portfolioBefore = {
    cash: 100,
    holdings: { AAPL: { units: 4, avgCost: 90, lastClose: 100, value: 400 } },
    holdingsValue: 400,
    netWorth: 500,
  };
  day.corporateActions = [
    { type: "split", ticker: "AAPL", date: day.date, ratio: 2 },
    { type: "dividend", ticker: "AAPL", date: day.date, amount: 1 },
  ];
  const result = await compareNDX(market, [day], []);
  expect(result.portfolioDividendCash).toBe(8);
  expect(result.returnType).toBe("price-index");
});
