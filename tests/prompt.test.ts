import { describe, expect, test } from "bun:test";
import { buildDailyPrompt, buildSystemPrompt, rationaleForMemory } from "../src/agent/prompt.ts";
import { AGENT_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION, MAX_RATIONALE_CHARS } from "../src/agent/protocolVersion.ts";
import { createInitialPortfolio } from "../src/engine/portfolio.ts";
import { initialDecision, hashText } from "../src/agent/trace.ts";
import { validateDecisionEvidence } from "../src/run/day.ts";
import { contentHash } from "../src/run/persist.ts";
import type { DailyRecord, DecisionContext, RunConfig } from "../src/domain/types.ts";

function context(date = "2026-06-01", observed = "2026-05-29"): DecisionContext {
  return { date, universe: ["AAPL"], portfolio: createInitialPortfolio(500),
    bars: { AAPL: [{ date: observed, open: 100, high: 100, low: 100, close: 100, volume: 1000 }] },
    indicators: {}, recentDays: [], limits: { maxTurns: 12, maxToolCalls: 20, timeoutMs: 300000 },
    horizon: { startDate: "2026-06-01", endDate: "2026-08-31" },
    contributions: [{ date: "2026-07-01", amount: 500 }, { date: "2026-08-03", amount: 500 }] };
}
function record(date: string, rationale: string): DailyRecord {
  return { date, rationale, fills: [], failedOrders: [], portfolioBefore: createInitialPortfolio(500), portfolioAfter: createInitialPortfolio(500),
    usage: { turns: 1, toolCalls: 0, failedToolCalls: 0, promptTokens: 0, completionTokens: 0 }, turnoverPct: 0, terminated: false, boundedStop: false, boundedReason: null };
}

describe("v6 decision timing and bounded memory", () => {
  test.each([["2026-06-08", "2026-06-05"], ["2026-06-22", "2026-06-18"], ["2026-07-06", "2026-07-02"]])("dates remain explicit across weekends and holidays: %s", (execution, observation) => {
    const ctx = context(execution, observation);
    expect(buildDailyPrompt(ctx)).toContain(`Observation date: ${observation}, through market close.`);
    expect(buildDailyPrompt(ctx)).toContain(`Execution date: ${execution}, at market open. Its opening prices are unknown.`);
    expect(buildSystemPrompt(ctx.limits)).toContain("Sale proceeds become available immediately when that sale executes");
    expect(buildSystemPrompt(ctx.limits)).toContain("proceeds can be lower and purchases can cost more");
  });
  test("empty smoke history does not invent a prior observation date", () => {
    const ctx = context(); ctx.bars = {};
    expect(buildDailyPrompt(ctx)).toContain("Observation date: unavailable (no historical bars supplied)");
  });
  test("five bounded memory excerpts preserve actual fills/rejections and full authoritative responses", () => {
    const ctx = context("2026-06-09", "2026-06-08");
    ctx.recentDays = Array.from({ length: 6 }, (_, i) => record(`2026-06-0${i + 1}`, i === 0 ? "expired-memory" : `Evidence-${i} ` + "x".repeat(20000)));
    const latest = ctx.recentDays.at(-1)!;
    latest.fills = [{ date: latest.date, ticker: "AAPL", side: "BUY", units: 1, price: 100, notional: 100, cashAfter: 400 }];
    latest.failedOrders = [{ date: latest.date, ticker: "AAPL", side: "SELL", reason: "insufficient shares" }];
    const before = JSON.stringify(ctx);
    const prompt = buildDailyPrompt(ctx);
    expect(prompt).not.toContain("expired-memory");
    expect(prompt.match(/\[truncated\]/g)).toHaveLength(5);
    expect(prompt.length).toBeLessThan(8500);
    expect(prompt).toContain("BUY 1 AAPL @ $100.00");
    expect(prompt).toContain("SELL AAPL: insufficient shares");
    expect(JSON.stringify(ctx)).toBe(before);
    expect(rationaleForMemory(latest.rationale)).toHaveLength(MAX_RATIONALE_CHARS);
    expect(rationaleForMemory("x".repeat(MAX_RATIONALE_CHARS))).toHaveLength(MAX_RATIONALE_CHARS);
    expect(buildSystemPrompt(ctx.limits)).toContain("four labeled lines: Decision:");
  });
  test("v5 prompt hashes match the original qualified MiMo day, without reinterpreting it as v6", () => {
    const ctx = context();
    expect(hashText(buildSystemPrompt(ctx.limits, LEGACY_PROTOCOL_VERSION))).toBe("61816016950aff91e3548a1157a4914f975477bef23d13a701185ba5e9a0d533");
    expect(hashText(buildDailyPrompt(ctx, LEGACY_PROTOCOL_VERSION))).toBe("9fc9f9e92fcc1cba6a882e1c2ead0f01331c4212033bfb434808655aed3d6326");
    ctx.recentDays = [record("2026-05-29", "x".repeat(20000))];
    expect(buildDailyPrompt(ctx, LEGACY_PROTOCOL_VERSION)).toContain("x".repeat(20000));
    expect(buildDailyPrompt(ctx)).not.toContain("x".repeat(20000));
    const decision = initialDecision(ctx, "test", "opencode");
    decision.effectiveSystemPrompt = buildSystemPrompt(ctx.limits, LEGACY_PROTOCOL_VERSION);
    decision.promptHash = hashText(decision.effectiveSystemPrompt);
    decision.trace = [{ type: "protocol", contextHash: contentHash(ctx), model: "test", provider: "opencode", systemPrompt: decision.effectiveSystemPrompt,
      promptHash: decision.promptHash, dailyPrompt: buildDailyPrompt(ctx, LEGACY_PROTOCOL_VERSION) }];
    const config = { agent: "pi", model: "test", provider: "opencode", limits: ctx.limits, protocolVersion: LEGACY_PROTOCOL_VERSION } as RunConfig;
    expect(() => validateDecisionEvidence(decision, contentHash(ctx), config, ctx.date, ctx)).not.toThrow();
    expect(() => validateDecisionEvidence(decision, contentHash(ctx), { ...config, protocolVersion: AGENT_PROTOCOL_VERSION }, ctx.date, ctx)).toThrow(/prompt/);
    expect(() => buildSystemPrompt(ctx.limits, "unknown")).toThrow(/Unsupported/);
  });
});
