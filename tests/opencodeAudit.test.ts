import { expect, test } from "bun:test";
import {
  reconcileClientTools,
  validateClientRuntimeAudits,
} from "../src/opencode/audit.ts";
import { QUALIFIED_ROUTES, type QualifiedRoute } from "../src/opencode/qualification.ts";
import { catalogFixture } from "./opencodeFixtures.ts";
import { initialDecision } from "./helpers.ts";
function usage() {
  return initialDecision(
    {
      date: "2024-03-01",
      universe: [],
      bars: {},
      indicators: {},
      recentDays: [],
      portfolio: { cash: 500, holdings: {}, holdingsValue: 0, netWorth: 500 },
      limits: { maxTurns: 8, maxToolCalls: 10, timeoutMs: 5000 },
    },
    "muse-spark-1.3-contributor-free",
    "opencode",
  ).usage;
}
const part = (
  id: string,
  tool: string,
  status: string,
  input: unknown = {},
) => ({ type: "tool", callID: id, tool, state: { status, input } });
const audit = (...parts: unknown[]) => ({
  type: "client_audit",
  file: "tool-parts.jsonl",
  data: parts,
});
const mcp = (name: string, args: unknown = {}, isError = false) => [
  { type: "tool_attempt", name, arguments: args },
  { type: "tool_result", name, result: { isError } },
];
test("SDK updates deduplicate; older file snapshots do not erase completed stdout evidence", () => {
  const u = usage();
  const trace = [
    ...mcp("market_snapshot"),
    {
      type: "opencode_event",
      event: {
        type: "tool_use",
        part: part("one", "trading_market_snapshot", "completed"),
      },
    },
    audit(
      part("one", "trading_market_snapshot", "pending"),
      part("one", "trading_market_snapshot", "running"),
      part("one", "trading_market_snapshot", "completed"),
    ),
  ];
  expect(reconcileClientTools(trace, u, 10).errors).toEqual([]);
  expect(u).toMatchObject({
    attemptedToolCalls: 1,
    successfulToolCalls: 1,
    failedToolCalls: 0,
    pendingToolCalls: 0,
  });
});
test("SDK schema rejection never reaching MCP counts as failed attempt", () => {
  const u = usage();
  const result = reconcileClientTools(
    [audit(part("bad", "trading_submit_day", "error", { units: 2 }))],
    u,
    10,
  );
  expect(result.errors).toEqual([]);
  expect(u).toMatchObject({
    attemptedToolCalls: 1,
    failedToolCalls: 1,
    successfulToolCalls: 0,
  });
});
test("unknown SDK call consumes cap before later valid MCP trade; day fails closed", () => {
  const u = usage();
  const result = reconcileClientTools(
    [
      ...mcp("submit_day", { ticker: "AAPL", units: 1 }),
      audit(
        part("bad", "invalid", "error", { tool: "unknown", error: "missing" }),
        part("buy", "trading_submit_day", "completed", {
          units: 1,
          ticker: "AAPL",
        }),
      ),
    ],
    u,
    1,
  );
  expect(result.boundedReason).toContain("exceeded");
  expect(result.errors.join()).toContain("non-trading");
  expect(u).toMatchObject({
    attemptedToolCalls: 2,
    admittedToolCalls: 1,
    refusedToolCalls: 1,
    failedToolCalls: 1,
  });
});
test("MCP semantic failure counts once even when SDK marks wrapper completed", () => {
  const u = usage();
  expect(
    reconcileClientTools(
      [
        ...mcp("submit_day", { units: -1 }, true),
        audit(part("bad", "trading_submit_day", "completed", { units: -1 })),
      ],
      u,
      10,
    ).errors,
  ).toEqual([]);
  expect(u.failedToolCalls).toBe(1);
  expect(u.successfulToolCalls).toBe(0);
});
test("unmatched completed calls, missing SDK evidence, pending calls and conflicting terminal states fail closed", () => {
  expect(
    reconcileClientTools(
      [audit(part("fake", "trading_submit_day", "completed"))],
      usage(),
      10,
    ).errors.join(),
  ).toContain("no MCP");
  expect(
    reconcileClientTools(mcp("market_snapshot"), usage(), 10).errors.join(),
  ).toContain("no matching SDK");
  const u = usage();
  expect(
    reconcileClientTools(
      [audit(part("hang", "trading_submit_day", "running"))],
      u,
      10,
    ).errors.join(),
  ).toContain("Unfinished");
  expect(u.pendingToolCalls).toBe(1);
  expect(
    reconcileClientTools(
      [
        audit(
          part("x", "trading_submit_day", "error"),
          part("x", "trading_submit_day", "completed"),
        ),
      ],
      usage(),
      10,
    ).errors.join(),
  ).toContain("Conflicting");
});
test("same arguments called twice require two distinct MCP executions", () => {
  const u = usage();
  const result = reconcileClientTools(
    [
      ...mcp("market_snapshot"),
      ...mcp("market_snapshot"),
      audit(
        part("a", "trading_market_snapshot", "completed"),
        part("b", "trading_market_snapshot", "completed"),
      ),
    ],
    u,
    10,
  );
  expect(result.errors).toEqual([]);
  expect(u.successfulToolCalls).toBe(2);
});

function validRuntimeDecision(route: QualifiedRoute = QUALIFIED_ROUTES[0]!) {
  const d = initialDecision(
    {
      date: "2024-03-01",
      universe: [],
      bars: {},
      indicators: {},
      recentDays: [],
      portfolio: { cash: 500, holdings: {}, holdingsValue: 0, netWorth: 500 },
      limits: { maxTurns: 8, maxToolCalls: 10, timeoutMs: 5000 },
    },
    "muse-spark-1.3-contributor-free",
    "opencode",
  );
  const toolAllowlist = [
    "market_snapshot",
    "price_history",
    "journal",
    "submit_day",
  ].map((s) => `trading_${s}`);
  const permission = {
    "*": "deny",
    ...Object.fromEntries(toolAllowlist.map((s) => [s, "allow"])),
  };
  const model = route.id;
  const runtime = {
    cliVersion: "1.18.30",
    versionSource: "caller preflight opencode --version",
    versions: { bun: "1.3.14" },
    executable: "/official/opencode",
  };
  const workspace = {
    directory: "/tmp/bench-test",
    processCwd: "/tmp/bench-test",
    worktree: "/tmp/bench-test",
  };
  const prompt = {
    model,
    runtime,
    workspace,
    resolvedModel: {
      ...catalogFixture(route),
    },
    effectiveSystemPrompt: d.effectiveSystemPrompt,
    promptHash: d.promptHash,
    system: [d.effectiveSystemPrompt],
    toolAllowlist,
    sessionID: "one",
  };
  d.usage.turns = 2;
  d.trace = [
    { type: "opencode_event", event: { type: "step_start" } },
    { type: "opencode_event", event: { type: "step_finish" } },
    { type: "opencode_event", event: { type: "step_start" } },
    { type: "opencode_event", event: { type: "step_finish" } },
    {
      type: "client_audit",
      file: "client-config-audit.json",
      data: {
        runtime,
        workspace,
        model,
        small_model: model,
        enabled_providers: [route.provider],
        permission,
        agent: {
          model,
          mode: "primary",
          prompt: d.effectiveSystemPrompt,
          permission,
        },
        mcpNames: ["trading"],
        plugins: ["file:///tmp/bench-test/benchmark-plugin.mjs"],
      },
    },
    {
      type: "client_audit",
      file: "system-prompts.jsonl",
      data: [structuredClone(prompt), structuredClone(prompt)],
    },
    {
      type: "client_audit",
      file: "system-prompt.json",
      data: structuredClone(prompt),
    },
  ];
  return d;
}
test("all runtime request/config audits must agree on free model, exact prompt, tools and isolated cwd", () => {
  expect(
    validateClientRuntimeAudits(
      validRuntimeDecision(),
      "opencode/muse-spark-1.3-contributor-free",
      "/tmp/bench-test",
    ),
  ).toEqual([]);
  const changed = validRuntimeDecision();
  (changed.trace[5] as any).data[0].effectiveSystemPrompt =
    "Earlier bad prompt";
  expect(
    validateClientRuntimeAudits(
      changed,
      "opencode/muse-spark-1.3-contributor-free",
    ).join(),
  ).toContain("prompt drift");
});
test("runtime audit fails closed on ambient tools, missing version, wrong directory and nonzero model cache pricing", () => {
  for (const mutate of [
    (d: any) => {
      d.trace[4].data.permission.bash = "allow";
    },
    (d: any) => {
      d.trace[4].data.runtime.cliVersion = null;
    },
    (d: any) => {
      d.trace[5].data[0].workspace.processCwd = "/workspace";
    },
    (d: any) => {
      d.trace[5].data[0].resolvedModel.cost.cache.read = 1;
    },
  ]) {
    const d = validRuntimeDecision();
    mutate(d);
    expect(
      validateClientRuntimeAudits(
        d,
        "opencode/muse-spark-1.3-contributor-free",
        "/tmp/bench-test",
      ).length,
    ).toBeGreaterThan(0);
  }
});

test("unmetered background requests fail the runtime audit even with matching prompts", () => {
  const d = validRuntimeDecision();
  (d.trace[5] as any).data.push(structuredClone((d.trace[5] as any).data[0]));
  expect(
    validateClientRuntimeAudits(
      d,
      "opencode/muse-spark-1.3-contributor-free",
    ).join(),
  ).toContain("complete client steps");
});

test("unmatched MCP refusals remain counted in failed-attempt evidence", () => {
  const u = usage();
  const result = reconcileClientTools(
    [
      { type: "tool_attempt", name: "buy", arguments: {} },
      { type: "tool_refused", name: "buy", reason: "timeout" },
    ],
    u,
    10,
  );
  expect(result.errors.join()).toContain("no matching SDK");
  expect(u).toMatchObject({
    attemptedToolCalls: 1,
    refusedToolCalls: 1,
    failedToolCalls: 1,
    admittedToolCalls: 0,
  });
});

for (const route of QUALIFIED_ROUTES) test(`${route.id}: runtime audits require exact provider and route`, () => {
  expect(validateClientRuntimeAudits(validRuntimeDecision(route), route.id, "/tmp/bench-test")).toEqual([]);
  for (const mutate of [
    (d: any) => { d.trace[4].data.enabled_providers = ["other"]; },
    (d: any) => { d.trace[4].data.small_model = QUALIFIED_ROUTES.find(r => r.id !== route.id)!.id; },
    (d: any) => { d.trace[5].data[0].resolvedModel.api.url = "https://unqualified.test"; },
    (d: any) => { d.trace[5].data[0].resolvedModel.cost.tiers = {}; },
    (d: any) => { d.trace[5].data[0].resolvedModel.capabilities.toolcall = false; },
  ]) {
    const d = validRuntimeDecision(route); mutate(d);
    expect(validateClientRuntimeAudits(d, route.id).length).toBeGreaterThan(0);
  }
  expect(validateClientRuntimeAudits(validRuntimeDecision(route), "unknown/model").join()).toContain("not a qualified route");
});
