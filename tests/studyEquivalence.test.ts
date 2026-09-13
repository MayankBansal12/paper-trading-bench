import { test, expect } from "bun:test";
import frozen from "./fixtures/v10-control-ledger.json";
import { executeAccepted } from "../src/core/execute.ts";
import { initialStudyDecision } from "../src/study/agent.ts";
import { scopeFor } from "../src/study/protocol.ts";
import { createInitialPortfolio } from "../src/engine/portfolio.ts";
import { monthlyDeposits } from "../src/core/funding.ts";
import type { MarketDataset } from "../src/data/dataset.ts";
import { tradeAnalysis } from "../src/study/review.ts";
const limits = {
  maxTurns: null,
  maxToolCalls: null,
  timeoutMs: 300000,
} as const;
test("all 64 archived v10 ledger days reproduce exactly under extracted accounting", () => {
  const rows = new Map(frozen.days.map((d) => [d.date, d]));
  const market = {
    openOn: (_t: string, date: string) => rows.get(date)!.market.open,
    closeOn: (_t: string, date: string) => rows.get(date)!.market.close,
    actionsOn: (date: string) => rows.get(date)!.record.corporateActions,
  } as unknown as MarketDataset;
  const config = {
    start: frozen.days[0]!.date,
    end: frozen.days.at(-1)!.date,
    history: 100,
    limits,
    contributions: monthlyDeposits(frozen.days.map((d) => d.date)),
  };
  let portfolio = createInitialPortfolio(500),
    fills = 0;
  for (const d of frozen.days) {
    const decision = initialStudyDecision({ limits } as any);
    decision.orders = d.orders as any;
    const result = executeAccepted(
      { scope: scopeFor("equivalence", d.date, 1), decision } as any,
      portfolio,
      config,
      market,
      ["AAPL"],
    );
    for (const key of [
      "portfolioBefore",
      "portfolioAfter",
      "contribution",
      "corporateActions",
      "fills",
      "failedOrders",
    ] as const)
      expect(result[key]).toEqual(d.record[key]);
    portfolio = result.portfolioAfter;
    fills += result.fills.length;
  }
  expect(fills).toBe(56);
  expect(portfolio.netWorth).toBe(1540.08);
});
test("ordered sells fund later buys; fixed shares can fail while dollar orders adapt to unknown open", () => {
  const previous = {
    cash: 0,
    holdings: { AAPL: { units: 2, avgCost: 100, lastClose: 100, value: 200 } },
    holdingsValue: 200,
    netWorth: 200,
  };
  const date = "2025-02-03",
    market = {
      openOn: () => 110,
      closeOn: () => 115,
      actionsOn: () => [],
    } as unknown as MarketDataset;
  const config = {
    start: date,
    end: date,
    history: 60,
    limits,
    contributions: [],
  };
  const run = (orders: any[], p = previous) =>
    executeAccepted(
      { scope: scopeFor("ordered", date, 1), decision: { orders } } as any,
      p,
      config,
      market,
      ["AAPL", "MSFT"],
    );
  const sell = {
      side: "SELL",
      ticker: "AAPL",
      sizing: { kind: "units", units: 2 },
    },
    buy = {
      side: "BUY",
      ticker: "MSFT",
      sizing: { kind: "notional", usd: 200 },
    };
  expect(run([sell, buy]).fills.map((f) => f.side)).toEqual(["SELL", "BUY"]);
  expect(run([buy, sell]).failedOrders).toHaveLength(1);
  const cash = createInitialPortfolio(100);
  expect(
    run(
      [{ side: "BUY", ticker: "AAPL", sizing: { kind: "units", units: 1 } }],
      cash as any,
    ).failedOrders,
  ).toHaveLength(1);
  const dollar = run(
    [{ side: "BUY", ticker: "AAPL", sizing: { kind: "notional", usd: 100 } }],
    cash as any,
  );
  expect(dollar.fills[0]!.units).toBeLessThan(1);
  expect(dollar.portfolioAfter.cash).toBeGreaterThanOrEqual(0);
});
test("contributions, split and dividend are applied once and evaluator gaps use split-consistent shares", () => {
  const date = "2025-02-03",
    previous = {
      cash: 100,
      holdings: {
        AAPL: { units: 4, avgCost: 100, lastClose: 100, value: 400 },
      },
      holdingsValue: 400,
      netWorth: 500,
    };
  const actions = [
    { date, type: "split", ticker: "AAPL", ratio: 2 },
    { date, type: "dividend", ticker: "AAPL", amount: 1 },
  ];
  const market = {
    openOn: () => 55,
    closeOn: () => 56,
    actionsOn: () => actions,
    asOfBefore: () => [{ close: 50 }],
  } as unknown as MarketDataset;
  const config = {
    start: date,
    end: date,
    history: 60,
    limits,
    contributions: [{ date, amount: 500 }],
  };
  const accepted = {
    scope: scopeFor("actions", date, 1),
    decision: {
      orders: [
        { side: "BUY", ticker: "AAPL", sizing: { kind: "notional", usd: 100 } },
      ],
    },
  } as any;
  const record = executeAccepted(accepted, previous, config, market, ["AAPL"]);
  expect(record.fills[0]!.cashAfter).toBe(508);
  expect(record.portfolioAfter.holdings.AAPL!.units).toBeGreaterThan(8);
  expect(executeAccepted(accepted, previous, config, market, ["AAPL"])).toEqual(
    record,
  );
  const analysis = tradeAnalysis(record, accepted, market);
  expect(analysis[0]!.observedClose).toBe(50);
  expect(analysis[0]!.gapPct).toBeCloseTo(10);
});

test("opening context applies due contribution, split-adjusted holdings and dividend before preload", async () => {
  const { buildDecisionContext } = await import("../src/core/context.ts");
  const { makeView } = await import("../src/study/protocol.ts");
  const date = "2025-02-03",
    previous = {
      cash: 100,
      holdings: {
        AAPL: { units: 4, avgCost: 100, lastClose: 100, value: 400 },
      },
      holdingsValue: 400,
      netWorth: 500,
    };
  const bar = {
    date: "2025-01-31",
    open: 50,
    high: 51,
    low: 49,
    close: 50,
    volume: 1000,
  };
  const market = {
    asOfBefore: () => [bar],
    actionsOn: () => [
      { date, type: "split", ticker: "AAPL", ratio: 2 },
      { date, type: "dividend", ticker: "AAPL", amount: 1 },
    ],
  } as unknown as MarketDataset;
  const ctx = buildDecisionContext(
    {
      start: date,
      end: date,
      history: 60,
      limits,
      contributions: [{ date, amount: 500 }],
    },
    date,
    ["AAPL"],
    previous,
    [],
    market,
  );
  const view = makeView(ctx, scopeFor("preload", date, 1));
  expect(view.portfolio.cash).toBe(608);
  expect(view.portfolio.holdings.AAPL).toEqual({
    units: 8,
    avgCost: 50,
    lastClose: 50,
    value: 400,
  });
  expect(view.portfolio.netWorth).toBe(1008);
  expect(previous.cash).toBe(100);
  expect(previous.holdings.AAPL.units).toBe(4);
});
