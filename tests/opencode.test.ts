import { describe, expect, test } from "bun:test";
import { initialDecision } from "../src/agent/trace.ts";
import { TurnBudget } from "../src/agent/limits.ts";
import { serveTradingTools } from "../src/opencode/mcp.ts";
import { readEvents } from "../src/opencode/events.ts";
import type { DecisionContext } from "../src/domain/types.ts";

const context = (): DecisionContext => ({ date: "2024-01-03", universe: ["AAPL"], portfolio: { cash: 500, holdings: {}, holdingsValue: 0, netWorth: 500 }, bars: { AAPL: [{ date: "2024-01-02", open: 10, high: 11, low: 9, close: 10, volume: 10 }] }, indicators: { AAPL: { sma20: null, sma50: null, rsi14: null } }, recentDays: [], limits: { maxTurns: 3, maxToolCalls: 3, timeoutMs: 10000 } });

describe("official client causal tool boundary", () => {
  test("invalid calls consume budget; queued trade reveals no execution price and never changes portfolio", async () => {
    const ctx = context(), decision = initialDecision(ctx, "test", "test");
    const state = { ...ctx, decidedOrders: [], failedOrders: [], budget: new TurnBudget(ctx.limits, Date.now()), externalAccounting: true };
    const stopped: string[] = [];
    const endpoint = serveTradingTools(state, decision, (reason) => stopped.push(reason));
    const call = async (name: string, args: unknown) => (await (await fetch(endpoint.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()) as any;
    try {
      expect((await call("get_ohlcv", { ticker: 123 })).result.isError).toBe(true);
      expect((await call("buy", { ticker: "AAPL", units: "bad" })).result.isError).toBe(true);
      expect(state.failedOrders).toMatchObject([{ ticker: "AAPL", side: "BUY", reason: "Invalid arguments for buy" }]);
      const queued = await call("buy", { ticker: "AAPL", notionalUsd: 100 });
      expect(queued.result.isError).toBeUndefined();
      expect(JSON.parse(queued.result.content[0].text)).toEqual({ queued: true, ticker: "AAPL", side: "BUY", sizing: { kind: "notional", usd: 100 } });
      expect(state.portfolio).toEqual(ctx.portfolio);
      expect(state.decidedOrders).toHaveLength(1);
      expect((await call("sell", { ticker: "AAPL", units: 1 })).result.isError).toBe(true);
      expect(stopped).toHaveLength(1);
      expect(decision.usage).toMatchObject({ attemptedToolCalls: 4, admittedToolCalls: 3, refusedToolCalls: 1, failedToolCalls: 2, successfulToolCalls: 1, pendingToolCalls: 0 });
      expect((await fetch(endpoint.url.replace(/\/[^/]+$/, "/wrong"), { method: "POST" })).status).toBe(404);
    } finally { endpoint.close(); }
  });
  test("event accounting includes cached and reasoning tokens and refuses unexpected tools", async () => {
    const events = [
      { type: "step_start" }, { type: "text", part: { text: "Hold." } },
      { type: "step_finish", part: { reason: "stop", cost: 0, tokens: { total: 41, input: 10, output: 2, reasoning: 3, cache: { read: 20, write: 6 } } } },
    ];
    const decision = initialDecision(context(), "test", "test"), stopped: string[] = [];
    const parsed = await readEvents(new Response(events.map((e) => JSON.stringify(e)).join("\n")).body!, decision, 3, (r) => stopped.push(r));
    expect(parsed).toEqual({ finalReason: "stop", error: undefined, rationale: "Hold." });
    expect(decision.usage).toMatchObject({ turns: 1, inputTokens: 10, promptTokens: 36, completionTokens: 5, totalTokens: 41, costUsd: 0 });
    const invalid = await readEvents(new Response(JSON.stringify({ type: "tool_use", part: { tool: "bash" } })).body!, decision, 3, (r) => stopped.push(r));
    expect(invalid.error).toContain("Unexpected non-trading tool");
    expect(stopped).toHaveLength(1);
  });
});
