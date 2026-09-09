import { expect, test } from "bun:test";
import { reconcileClientTools, validateClientRuntimeAudits } from "../src/opencode/audit.ts";
import { initialDecision } from "../src/agent/trace.ts";
function usage() {
  return initialDecision({ date: "2024-03-01", universe: [], bars: {}, indicators: {}, recentDays: [],
    portfolio: { cash: 500, holdings: {}, holdingsValue: 0, netWorth: 500 }, limits: { maxTurns: 8, maxToolCalls: 10, timeoutMs: 5000 } }, "mimo-v2.5-free", "opencode").usage;
}
const part = (id: string, tool: string, status: string, input: unknown = {}) => ({ type: "tool", callID: id, tool, state: { status, input } });
const audit = (...parts: unknown[]) => ({ type: "client_audit", file: "tool-parts.jsonl", data: parts });
const mcp = (name: string, args: unknown = {}, isError = false) => [
  { type: "tool_attempt", name, arguments: args }, { type: "tool_result", name, result: { isError } },
];
test("SDK updates deduplicate; older file snapshots do not erase completed stdout evidence", () => {
  const u = usage();
  const trace = [...mcp("get_universe"), { type: "opencode_event", event: { type: "tool_use", part: part("one", "trading_get_universe", "completed") } },
    audit(part("one", "trading_get_universe", "pending"), part("one", "trading_get_universe", "running"), part("one", "trading_get_universe", "completed"))];
  expect(reconcileClientTools(trace, u, 10).errors).toEqual([]);
  expect(u).toMatchObject({ attemptedToolCalls: 1, successfulToolCalls: 1, failedToolCalls: 0, pendingToolCalls: 0 });
});
test("SDK schema rejection never reaching MCP counts as failed attempt", () => {
  const u = usage();
  const result = reconcileClientTools([audit(part("bad", "trading_buy", "error", { units: 2 }))], u, 10);
  expect(result.errors).toEqual([]);
  expect(u).toMatchObject({ attemptedToolCalls: 1, failedToolCalls: 1, successfulToolCalls: 0 });
});
test("unknown SDK call consumes cap before later valid MCP trade; day fails closed", () => {
  const u = usage();
  const result = reconcileClientTools([...mcp("buy", { ticker: "AAPL", units: 1 }), audit(
    part("bad", "invalid", "error", { tool: "unknown", error: "missing" }),
    part("buy", "trading_buy", "completed", { units: 1, ticker: "AAPL" }))], u, 1);
  expect(result.boundedReason).toContain("exceeded");
  expect(result.errors.join()).toContain("non-trading");
  expect(u).toMatchObject({ attemptedToolCalls: 2, admittedToolCalls: 1, refusedToolCalls: 1, failedToolCalls: 1 });
});
test("MCP semantic failure counts once even when SDK marks wrapper completed", () => {
  const u = usage();
  expect(reconcileClientTools([...mcp("buy", { units: -1 }, true), audit(part("bad", "trading_buy", "completed", { units: -1 }))], u, 10).errors).toEqual([]);
  expect(u.failedToolCalls).toBe(1);
  expect(u.successfulToolCalls).toBe(0);
});
test("unmatched completed calls, missing SDK evidence, pending calls and conflicting terminal states fail closed", () => {
  expect(reconcileClientTools([audit(part("fake", "trading_buy", "completed"))], usage(), 10).errors.join()).toContain("no MCP");
  expect(reconcileClientTools(mcp("get_universe"), usage(), 10).errors.join()).toContain("no matching SDK");
  const u = usage();
  expect(reconcileClientTools([audit(part("hang", "trading_buy", "running"))], u, 10).errors.join()).toContain("Unfinished");
  expect(u.pendingToolCalls).toBe(1);
  expect(reconcileClientTools([audit(part("x", "trading_buy", "error"), part("x", "trading_buy", "completed"))], usage(), 10).errors.join()).toContain("Conflicting");
});
test("same arguments called twice require two distinct MCP executions", () => {
  const u = usage();
  const result = reconcileClientTools([...mcp("get_universe"), ...mcp("get_universe"), audit(part("a", "trading_get_universe", "completed"), part("b", "trading_get_universe", "completed"))], u, 10);
  expect(result.errors).toEqual([]);
  expect(u.successfulToolCalls).toBe(2);
});

function validRuntimeDecision() {
  const d = initialDecision({ date: "2024-03-01", universe: [], bars: {}, indicators: {}, recentDays: [], portfolio: { cash: 500, holdings: {}, holdingsValue: 0, netWorth: 500 }, limits: { maxTurns: 8, maxToolCalls: 10, timeoutMs: 5000 } }, "mimo-v2.5-free", "opencode");
  const toolAllowlist = ["get_portfolio", "get_universe", "get_ohlcv", "get_indicators", "buy", "sell"].map((s) => `trading_${s}`);
  const permission = { "*": "deny", ...Object.fromEntries(toolAllowlist.map((s) => [s, "allow"])) };
  const model = "opencode/mimo-v2.5-free";
  const runtime = { cliVersion: "1.18.29", versionSource: "caller preflight opencode --version", versions: { bun: "1.3.14" }, executable: "/official/opencode" };
  const workspace = { directory: "/tmp/bench-test", processCwd: "/tmp/bench-test", worktree: "/tmp/bench-test" };
  const prompt = { model, runtime, workspace, resolvedModel: { id: "mimo-v2.5-free", providerID: "opencode", cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } },
    effectiveSystemPrompt: d.effectiveSystemPrompt, promptHash: d.promptHash, system: [d.effectiveSystemPrompt], toolAllowlist, sessionID: "one" };
  d.usage.turns = 2;
  d.trace = [
    { type: "opencode_event", event: { type: "step_start" } }, { type: "opencode_event", event: { type: "step_finish" } },
    { type: "opencode_event", event: { type: "step_start" } }, { type: "opencode_event", event: { type: "step_finish" } },
    { type: "client_audit", file: "client-config-audit.json", data: { runtime, workspace, model, small_model: model,
    permission, agent: { model, mode: "primary", prompt: d.effectiveSystemPrompt, permission }, mcpNames: ["trading"], plugins: ["file:///tmp/bench-test/benchmark-plugin.mjs"] } },
    { type: "client_audit", file: "system-prompts.jsonl", data: [structuredClone(prompt), structuredClone(prompt)] },
    { type: "client_audit", file: "system-prompt.json", data: structuredClone(prompt) }];
  return d;
}
test("all runtime request/config audits must agree on free model, exact prompt, tools and isolated cwd", () => {
  expect(validateClientRuntimeAudits(validRuntimeDecision(), "opencode/mimo-v2.5-free", "/tmp/bench-test")).toEqual([]);
  const changed = validRuntimeDecision();
  (changed.trace[5] as any).data[0].effectiveSystemPrompt = "Earlier bad prompt";
  expect(validateClientRuntimeAudits(changed, "opencode/mimo-v2.5-free").join()).toContain("prompt drift");
});
test("runtime audit fails closed on ambient tools, missing version, wrong directory and nonzero model cache pricing", () => {
  for (const mutate of [
    (d: any) => { d.trace[4].data.permission.bash = "allow"; },
    (d: any) => { d.trace[4].data.runtime.cliVersion = null; },
    (d: any) => { d.trace[5].data[0].workspace.processCwd = "/workspace"; },
    (d: any) => { d.trace[5].data[0].resolvedModel.cost.cache.read = 1; },
  ]) {
    const d = validRuntimeDecision(); mutate(d);
    expect(validateClientRuntimeAudits(d, "opencode/mimo-v2.5-free", "/tmp/bench-test").length).toBeGreaterThan(0);
  }
});

test("unmetered background requests fail the runtime audit even with matching prompts", () => {
  const d = validRuntimeDecision();
  (d.trace[5] as any).data.push(structuredClone((d.trace[5] as any).data[0]));
  expect(validateClientRuntimeAudits(d, "opencode/mimo-v2.5-free").join()).toContain("fully metered");
});

test("unmatched MCP refusals remain counted in failed-attempt evidence", () => {
  const u = usage();
  const result = reconcileClientTools([{ type: "tool_attempt", name: "buy", arguments: {} }, { type: "tool_refused", name: "buy", reason: "timeout" }], u, 10);
  expect(result.errors.join()).toContain("no matching SDK");
  expect(u).toMatchObject({ attemptedToolCalls: 1, refusedToolCalls: 1, failedToolCalls: 1, admittedToolCalls: 0 });
});
