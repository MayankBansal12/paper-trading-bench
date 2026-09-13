import { describe, expect, test } from "bun:test";
import { PiAgent } from "../src/agent/piAgent.ts";
import { buildSystemPrompt } from "../src/agent/prompt.ts";
import { hashText } from "../src/agent/trace.ts";
import type { DecisionContext } from "../src/domain/types.ts";

const offlineTransportModule = new URL("./fixtures/live/transport.ts", import.meta.url).href;
function context(scenario: string, limits: Partial<DecisionContext["limits"]> = {}): DecisionContext {
  return { date: "2024-03-01", universe: ["AAPL", scenario], bars: {}, indicators: {}, recentDays: [],
    portfolio: { cash: 500, holdings: {}, holdingsValue: 0, netWorth: 500 },
    limits: { timeoutMs: 5000, maxTurns: 8, maxToolCalls: 20, ...limits } };
}
const agent = () => new PiAgent("mimo-v2.5-free", "opencode", { freeOnly: true, offlineTransportModule });

describe("real Pi SDK with offline transport in isolated subprocess", () => {
  test("effective model-boundary system prompt and full cached usage/cost survive serialization", async () => {
    const ctx = context("cache");
    const result = await agent().decide(ctx);
    expect(result.outcome).toBe("completed");
    expect(result.effectiveSystemPrompt).toBe(buildSystemPrompt(ctx.limits));
    expect(result.promptHash).toBe(hashText(result.effectiveSystemPrompt));
    expect(result.usage).toMatchObject({ inputTokens: 100, promptTokens: 1050, completionTokens: 20,
      cacheReadTokens: 900, cacheWriteTokens: 50, totalTokens: 1070, costUsd: .037 });
    expect(result.trace.some((e: any) => e.type === "model_request" && e.systemPrompt === buildSystemPrompt(ctx.limits))).toBe(true);
    expect(JSON.parse(JSON.stringify(result)).trace.length).toBeGreaterThan(3);
  });
  for (const scenario of ["error", "throw", "aborted", "partial-error"]) test(`${scenario} cannot become a successful hold or partial buy`, async () => {
    const result = await agent().decide(context(scenario));
    expect(result.outcome).toBe("provider_error");
    expect(result.orders).toEqual([]);
    expect(result.terminalReason).toBeTruthy();
    if (scenario === "partial-error") expect(result.submittedOrders).toHaveLength(1);
  });
  test("SDK unknown and schema-invalid attempts count and malformed buy is retained", async () => {
    const result = await agent().decide(context("invalid"));
    expect(result.outcome).toBe("completed");
    expect(result.usage).toMatchObject({ toolCalls: 2, attemptedToolCalls: 2, failedToolCalls: 2, admittedToolCalls: 2, pendingToolCalls: 0 });
    expect(result.failedOrders).toHaveLength(1);
    expect(result.trace.filter((e: any) => e.type === "tool_attempt")).toHaveLength(2);
    expect(result.trace.filter((e: any) => e.type === "tool_result")).toHaveLength(2);
  });
  test("unknown calls consume cap; later valid buy is blocked before body", async () => {
    const result = await agent().decide(context("over-cap", { maxToolCalls: 1 }));
    expect(result.outcome).toBe("budget_cutoff");
    expect(result.orders).toEqual([]);
    expect(result.submittedOrders).toEqual([]);
    expect(result.usage).toMatchObject({ toolCalls: 2, attemptedToolCalls: 2, admittedToolCalls: 1, refusedToolCalls: 1 });
  });
  test("exact tool cap permits final rationale and completed buy", async () => {
    const result = await agent().decide(context("buy", { maxToolCalls: 1 }));
    expect(result.outcome).toBe("completed");
    expect(result.orders).toHaveLength(1);
    expect(result.usage).toMatchObject({ toolCalls: 1, successfulToolCalls: 1, refusedToolCalls: 0 });
  });
  test("semantic tool errors are counted once", async () => {
    const result = await agent().decide(context("semantic"));
    expect(result.outcome).toBe("completed");
    expect(result.failedOrders).toHaveLength(1);
    expect(result.usage.failedToolCalls).toBe(1);
  });
  test("max turns cuts off incomplete queued order atomically", async () => {
    const result = await agent().decide(context("buy", { maxTurns: 1 }));
    expect(result.outcome).toBe("budget_cutoff");
    expect(result.orders).toEqual([]);
    expect(result.submittedOrders).toHaveLength(1);
    expect(result.usage.turns).toBe(1);
  });
  for (const scenario of ["hang", "partial-hang", "cpu-hang"]) test(`${scenario} is hard-bounded without waiting for SDK idle`, async () => {
    const start = performance.now();
    const result = await agent().decide(context(scenario, { timeoutMs: 1200 }));
    expect(performance.now() - start).toBeLessThan(1800);
    expect(result.outcome).toBe("budget_cutoff");
    expect(result.orders).toEqual([]);
    expect(result.trace.some((e: any) => e.type === "model_request")).toBe(true);
    if (scenario === "partial-hang") {
      expect(result.submittedOrders).toHaveLength(1);
      expect(result.usage.inputTokens).toBe(10);
    }
  });
  test("timeout kills the SDK process and retains partial streamed output", async () => {
    const result = await agent().decide(context("stream-hang", { timeoutMs: 1200 }));
    expect(result.outcome).toBe("budget_cutoff");
    expect(result.trace.some((e: any) => e.type === "stream_delta" && e.delta === "Partial rationale")).toBe(true);
    expect(result.trace.at(-1)).toMatchObject({ usageComplete: false, effectivePromptObserved: true });
    const started = result.trace.find((e: any) => e.type === "isolation_start") as { pid: number };
    expect(started.pid).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(() => process.kill(started.pid, 0)).toThrow();
  });
  test("setup deadline and unexpected process exits are atomic failures", async () => {
    const timed = await agent().decide(context("cache", { timeoutMs: 1 }));
    expect(timed.outcome).toBe("budget_cutoff");
    expect(timed.orders).toEqual([]);
    const exited = await agent().decide(context("exit"));
    expect(exited.outcome).toBe("harness_error");
    expect(exited.terminalReason).toContain("exited before result");
    expect(exited.orders).toEqual([]);
  });
  test("empty and length-limited final responses are incomplete", async () => {
    expect((await agent().decide(context("empty"))).outcome).toBe("harness_error");
    expect((await agent().decide(context("length"))).outcome).toBe("budget_cutoff");
  });
  test("free-only rejects paid provider and model; unknown models never fall back", () => {
    expect(() => new PiAgent("minimax-m3", "opencode-go", { freeOnly: true })).toThrow(/Free-only/);
    expect(() => new PiAgent("claude-sonnet-4-5", "opencode", { freeOnly: true })).toThrow(/Free-only/);
    expect(() => new PiAgent("not-a-model", "opencode")).toThrow(/No fallback/);
  });
});
