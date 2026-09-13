import { describe, expect, test } from "bun:test";
import { initialDecision } from "./helpers.ts";
import { readEvents } from "../src/opencode/events.ts";
import type { DecisionContext } from "../src/domain/types.ts";

const ctx: DecisionContext = {
  date: "2026-06-01",
  universe: [],
  portfolio: { cash: 500, holdings: {}, holdingsValue: 0, netWorth: 500 },
  bars: {},
  indicators: {},
  recentDays: [],
  limits: { maxTurns: 6, maxToolCalls: 20, timeoutMs: 1000 },
};
const tokens = () => ({
  input: 10,
  output: 2,
  reasoning: 3,
  cache: { read: 20, write: 6 },
  total: 41,
});
const start = { type: "step_start" };
const text = { type: "text", part: { text: "Hold." } };
const finish = (usage: unknown = tokens(), reason = "stop", cost = 0) => ({
  type: "step_finish",
  part: { reason, cost, tokens: usage },
});
async function parse(events: unknown[], maxTurns: number | null = 6) {
  const decision = initialDecision(ctx, "test", "opencode"),
    stops: string[] = [];
  const parsed = await readEvents(
    new Response(events.map((e) => JSON.stringify(e)).join("\n")).body!,
    decision,
    maxTurns,
    (r) => stops.push(r),
  );
  return { decision, parsed, stops };
}

describe("official client strict step and usage accounting", () => {
  test("requires a matching start before a terminal finish", async () => {
    const r = await parse([text, finish()]);
    expect(r.parsed.error).toBeDefined();
    expect(r.parsed.finalReason).toBeUndefined();
    expect(r.decision.usage.turns).toBe(0);
  });
  test("rejects fractional, negative, string and inconsistent token fields", async () => {
    const invalid = [
      { ...tokens(), input: -1 },
      { ...tokens(), output: 1.5 },
      { ...tokens(), reasoning: "3" },
      { ...tokens(), total: 99 },
    ];
    for (const usage of invalid) {
      const r = await parse([start, text, finish(usage)]);
      expect(r.parsed.error).toMatch(/usage|total/);
      expect(r.parsed.finalReason).toBeUndefined();
      expect(r.decision.usage.totalTokens).toBe(0);
    }
  });
  test("rejects invalid costs and cumulative token overflow", async () => {
    expect(
      (await parse([start, text, finish(tokens(), "stop", -0.1)])).parsed.error,
    ).toMatch(/usage/);
    const huge = {
      input: Number.MAX_SAFE_INTEGER,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
      total: Number.MAX_SAFE_INTEGER,
    };
    const r = await parse([
      start,
      finish(huge, "tool-calls"),
      start,
      text,
      finish(),
    ]);
    expect(r.parsed.error).toMatch(/numeric range/);
  });
  test("counts separately reported reasoning and reconciles prompt plus completion", async () => {
    const r = await parse([start, text, finish()]);
    expect(r.parsed.error).toBeUndefined();
    expect(r.decision.usage).toMatchObject({
      promptTokens: 36,
      completionTokens: 5,
      totalTokens: 41,
    });
  });
  test("does not double-count reasoning already included in output", async () => {
    const r = await parse([
      start,
      text,
      finish({ ...tokens(), output: 5, total: 41 }),
    ]);
    expect(r.parsed.error).toBeUndefined();
    expect(r.decision.usage).toMatchObject({
      promptTokens: 36,
      completionTokens: 5,
      totalTokens: 41,
    });
  });
  test("rejects nested, duplicate and unfinished steps", async () => {
    for (const events of [
      [start, start, text, finish()],
      [start, text, finish(), finish()],
      [start, text],
      [start, text, finish(), start, text, finish()],
    ]) {
      expect((await parse(events)).parsed.error).toBeDefined();
    }
  });
  test("counts turns against the cap and keeps only final-step rationale", async () => {
    const r = await parse(
      [
        start,
        { type: "text", part: { text: "intermediate" } },
        finish(tokens(), "tool-calls"),
        start,
        text,
        finish(),
      ],
      1,
    );
    expect(r.stops).toEqual(["Max turns (1) exceeded"]);
    expect(r.parsed.rationale).toBe("Hold.");
  });
  test("malformed prefixed tool parts cannot evade the reconciliation input schema", async () => {
    const r = await parse([
      start,
      { type: "tool_use", part: { tool: "trading_buy" } },
      text,
      finish(),
    ]);
    expect(r.parsed.error).toMatch(/Malformed client tool part/);
  });
  test("provider error stays terminally unsuccessful even if followed by a stop", async () => {
    const r = await parse([
      start,
      { type: "error", error: { message: "provider failed" } },
      text,
      finish(),
    ]);
    expect(r.parsed.error).toContain("provider failed");
  });
  test("malformed JSON is retained as evidence and cannot become success", async () => {
    const decision = initialDecision(ctx, "test", "opencode");
    const raw = JSON.stringify(start) + "\n{";
    const parsed = await readEvents(
      new Response(raw).body!,
      decision,
      6,
      () => {},
    );
    expect(parsed.error).toMatch(/Malformed/);
    expect(
      decision.trace.some((e: any) => e.type === "opencode_malformed_event"),
    ).toBe(true);
  });
  test("accepts all six usage snapshots captured from the actual MiMo qualification", async () => {
    const snapshots = [
      [1640, 42, 0, 1682],
      [329, 39, 1600, 1968],
      [6268, 2196, 1920, 10384],
      [5972, 554, 8128, 14654],
      [1783, 1225, 14080, 17088],
      [1392, 287, 15808, 17487],
    ];
    const events = snapshots.flatMap(([input, output, read, total], i) => [
      start,
      text,
      finish(
        { input, output, reasoning: 0, cache: { read, write: 0 }, total },
        i === snapshots.length - 1 ? "stop" : "tool-calls",
      ),
    ]);
    const r = await parse(events);
    expect(r.parsed).toEqual({
      error: undefined,
      finalReason: "stop",
      rationale: "Hold.",
    });
    expect(r.decision.usage.turns).toBe(6);
    expect(r.decision.usage.totalTokens).toBe(
      r.decision.usage.promptTokens + r.decision.usage.completionTokens,
    );
    expect(r.stops).toEqual([]);
  });
});

test("unlimited study turns retain complete event and usage accounting beyond old caps", async () => {
  const events = Array.from({ length: 300 }, (_, i) => [
    start,
    text,
    finish(tokens(), i === 299 ? "stop" : "tool-calls"),
  ]).flat();
  const r = await parse(events, null);
  expect(r.stops).toEqual([]);
  expect(r.parsed).toEqual({
    error: undefined,
    finalReason: "stop",
    rationale: "Hold.",
  });
  expect(r.decision.usage.turns).toBe(300);
  expect(r.decision.usage.totalTokens).toBe(300 * 41);
});

test("missing numeric metadata is unavailable, not zero or a submission integrity error", async () => {
  for (const missing of [
    {},
    { ...tokens(), total: undefined },
    { ...tokens(), cache: {} },
  ]) {
    const r = await parse([start, finish(missing, "tool-calls")], null);
    expect(r.parsed.error).toBeUndefined();
    expect(r.decision.usage.totalTokens).toBeNull();
    expect(r.decision.usage.completeness).toBe("unavailable");
  }
});
test("explicit tool-call completion needs no final prose step", async () => {
  const r = await parse([start, finish(tokens(), "tool-calls")], null);
  expect(r.parsed.error).toBeUndefined();
  expect(r.parsed.rationale).toBe("");
  expect(r.decision.usage.turns).toBe(1);
});
