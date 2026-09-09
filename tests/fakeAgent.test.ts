import { describe, expect, test } from "bun:test";
import { FakeAgent } from "../src/agent/fakeAgent.ts";
import { createInitialPortfolio } from "../src/engine/portfolio.ts";
import type { DecisionContext, Indicators } from "../src/domain/types.ts";

function ctx(overrides: Partial<DecisionContext> = {}): DecisionContext {
  return {
    date: "2024-03-01",
    universe: ["AAA", "BBB"],
    portfolio: createInitialPortfolio(1000),
    bars: {},
    indicators: {},
    recentDays: [],
    limits: { maxTurns: 8, maxToolCalls: 20, timeoutMs: 5000 },
    ...overrides,
  };
}

describe("agent/fakeAgent", () => {
  test("is deterministic: same context in, same decision out", async () => {
    const agent = new FakeAgent();
    const indicators: Record<string, Indicators> = { AAA: { sma20: 110, sma50: 100, rsi14: 60 }, BBB: { sma20: 90, sma50: 100, rsi14: 40 } };
    const a = await agent.decide(ctx({ indicators }));
    const b = await agent.decide(ctx({ indicators }));
    expect(a.orders).toEqual(b.orders);
  });

  test("golden cross with no position triggers a BUY", async () => {
    const agent = new FakeAgent();
    const decision = await agent.decide(ctx({ indicators: { AAA: { sma20: 110, sma50: 100, rsi14: 60 }, BBB: { sma20: null, sma50: null, rsi14: null } } }));
    expect(decision.orders).toEqual([{ ticker: "AAA", side: "BUY", sizing: { kind: "notional", usd: 100 } }]);
  });

  test("death cross while holding triggers a full SELL", async () => {
    const agent = new FakeAgent();
    const portfolio = createInitialPortfolio(1000);
    portfolio.holdings.AAA = { units: 3, avgCost: 90, lastClose: 95, value: 285 };
    const decision = await agent.decide(
      ctx({ portfolio, indicators: { AAA: { sma20: 90, sma50: 100, rsi14: 40 }, BBB: { sma20: null, sma50: null, rsi14: null } } }),
    );
    expect(decision.orders).toEqual([{ ticker: "AAA", side: "SELL", sizing: { kind: "units", units: 3 } }]);
  });

  test("respects the tool-call budget and reports a bounded stop", async () => {
    const agent = new FakeAgent();
    const universe = ["A", "B", "C", "D"];
    const indicators: Record<string, Indicators> = Object.fromEntries(
      universe.map((t) => [t, { sma20: 110, sma50: 100, rsi14: 60 }]),
    );
    const decision = await agent.decide(ctx({ universe, indicators, limits: { maxTurns: 8, maxToolCalls: 2, timeoutMs: 5000 } }));
    expect(decision.orders.length).toBe(2);
    expect(decision.boundedStop).toBe(true);
    expect(decision.boundedReason).toMatch(/max tool calls/);
  });

  test("insufficient indicator history means no orders", async () => {
    const agent = new FakeAgent();
    const decision = await agent.decide(ctx({ indicators: { AAA: { sma20: null, sma50: null, rsi14: null }, BBB: { sma20: null, sma50: null, rsi14: null } } }));
    expect(decision.orders).toEqual([]);
    expect(decision.boundedStop).toBe(false);
  });
});
