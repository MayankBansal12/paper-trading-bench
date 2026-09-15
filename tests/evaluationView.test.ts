import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { viewerIdentity, viewerCohorts } from "../src/report/evaluationView.ts";
import { EVALUATION_QUARTERS } from "../src/study/evaluation.ts";
import { exchangeDates } from "../src/data/calendar.ts";
import { createVisualizer, loadRun } from "../scripts/visualizer.ts";
import { CLIENT } from "../scripts/visualizer-client.ts";

function manifest(label = "2025-Q2", model = "future/new-model") {
  const q = EVALUATION_QUARTERS.find(q => q.label === label)!;
  return { config: { runId: `annual-${label}`, model, kind: "environment", protocol: "v12", datasetHash: "frozen-data", history: 100,
    limits: { maxTurns: null, maxToolCalls: null }, policy: { maxConsecutiveInvalidDays: 3 }, start: q.start, end: q.end },
    implementation: { hash: "frozen-source" } };
}
function run(label: string) {
  const m = manifest(label), days = exchangeDates(m.config.start, m.config.end).length;
  return { ...viewerIdentity(m), runId: m.config.runId, label, start: m.config.start, end: m.config.end,
    committed: days, totalDays: days, valid: days, invalid: 0, state: "Completed", timeline: [], lastEventAt: null,
    funding: { startingCapital: 50000, totalPrincipal: 150000, netProfit: 1000, returnOnPrincipalPct: 2 / 3, timeWeightedReturnPct: 2 },
    days: [{ fills: 2, failedOrders: 1, tools: { journal: 3 } }] };
}

test("manifest-based discovery supports new models and separates launches, protocols and datasets", () => {
  const a = manifest(), b = manifest("2025-Q3");
  expect(viewerIdentity(a).modelName).toBe("future/new-model");
  expect(viewerIdentity(a).cohortId).toBe(viewerIdentity(b).cohortId);
  for (const patch of [{ runId: "another-2025-Q3" }, { datasetHash: "other" }, { protocol: "v13" }, { history: 120 }, { model: "other/model" }]) {
    expect(viewerIdentity({ ...b, config: { ...b.config, ...patch } }).cohortId).not.toBe(viewerIdentity(a).cohortId);
  }
});

test("year results require four unique complete quarters and distinguish principal returns from TWR", () => {
  const runs = EVALUATION_QUARTERS.map(q => run(q.label));
  const group = viewerCohorts(runs)[0]!;
  expect(group).toMatchObject({ expected: 251, committed: 251, valid: 251, fills: 8, rejectedOrders: 4, tools: 12, complete: true });
  expect(group.year).toEqual({ netProfit: 4000, contributed: 600000, meanQuarterTimeWeightedReturnPct: 2 });
  expect(viewerCohorts(runs.slice(1))[0]).toMatchObject({ expected: 251, complete: false, year: null });
  expect(viewerCohorts([...runs, runs[0]!])[0]!.year).toBeNull();
  runs[0]!.state = "Stopped after invalid days";
  expect(viewerCohorts(runs)[0]!.year).toBeNull();
});

test("browser model pages render unknown models, empty quarters and partial years without NaN", async () => {
  const r = { ...run("2025-Q2"), committed: 0, valid: 0, days: [], state: "Incomplete",
    funding: { startingCapital: null, totalPrincipal: null, netProfit: null, returnOnPrincipalPct: null, timeWeightedReturnPct: null } };
  const nodes = new Map<string, any>();
  const node = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: "", textContent: "", addEventListener() {}, classList: { add() {}, remove() {} } });
    return nodes.get(id);
  };
  const data = { runs: [r], cohorts: viewerCohorts([r]) };
  const ctx: any = { document: { getElementById: node, addEventListener() {} }, window: {},
    fetch: async () => ({ ok: true, json: async () => data }), setInterval() {}, requestAnimationFrame() {} };
  runInNewContext(CLIENT, ctx);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(node("main").innerHTML).toContain("future/new-model");
  expect(node("main").innerHTML).toContain("Full-year score is unavailable");
  expect(node("main").innerHTML).toContain("Not started · 0/64");
  expect(node("main").innerHTML).not.toMatch(/NaN|undefined/);
  ctx.pickQuarter(r.cohortId, r.runId);
  expect(node("main").innerHTML).toContain("Sessions — click for the agent run");
  expect(node("main").innerHTML).not.toMatch(/NaN|undefined/);
  ctx.pickModel(r.cohortId);
  ctx.fetch = async () => { throw new Error("offline"); };
  await ctx.refresh();
  expect(node("updated").textContent).toContain("Refresh failed: offline");
});

test("viewer API retains committed journals, pairs tool results, exposes unfinished days and follows symlinks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "viewer-api-"));
  const studies = join(dir, "studies"), source = join(dir, "source");
  await mkdir(studies); await mkdir(join(source, "days"), { recursive: true });
  const m = manifest();
  await writeFile(join(source, "manifest.json"), JSON.stringify(m));
  const portfolio = (netWorth: number) => ({ netWorth, cash: netWorth, holdings: {}, holdingsValue: 0 });
  const day = { date: "2025-04-01", status: "invalid", submissionEventHash: null, reason: "Timeout",
    record: { date: "2025-04-01", portfolioBefore: portfolio(50000), portfolioAfter: portfolio(100000), contribution: 50000,
      fills: [], failedOrders: [], turnoverPct: 0 } };
  await writeFile(join(source, "days", "2025-04-01.json"), JSON.stringify(day));
  const event = (sequence: number, date: string, kind: string, payload: any) => ({ sequence, hash: String(sequence), kind, payload,
    recordedAt: new Date(sequence * 1000).toISOString(), scope: { date, attempt: 1 } });
  const events = [
    event(1, day.date, "begin", {}),
    event(2, day.date, "audit", { type: "tool_attempt", name: "price_history", providerCallId: "call", arguments: { lookback: 10 } }),
    event(4, day.date, "audit", { type: "tool_result", name: "price_history", result: { isError: true, content: [{ type: "text", text: "Split the batch" }] } }),
    event(5, day.date, "submission", { journal: { text: "uncommitted note", tags: ["discarded"] }, orders: [] }),
    event(6, day.date, "result", { outcome: "budget_cutoff", reason: "Timeout" }),
    event(7, "2025-04-02", "begin", {}),
  ];
  await writeFile(join(source, "events.jsonl"), events.map(e => JSON.stringify(e)).join("\n") + '\n{"partial":');
  await symlink(source, join(studies, "linked-run"));
  const server = createVisualizer(studies);
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const listing = await (await fetch(base + "/api/runs")).json() as any;
    expect(listing.runs).toHaveLength(1);
    expect(listing.runs[0].dir).toBeUndefined();
    expect(listing.runs[0].days[0]).toMatchObject({ dailyProfit: 0, totalPrincipal: 100000, tags: [], toolErrors: 1, attempts: 1 });
    expect(listing.cohorts[0]).toMatchObject({ observedProfit: 0, year: null, expected: 251 });
    const detail = await (await fetch(base + "/api/run/annual-2025-Q2/2025-04-01")).json() as any;
    expect(detail.journal).toBeNull();
    expect(detail.totalPrincipal).toBe(100000);
    expect(detail.calls[0]).toMatchObject({ ok: false, ms: 2000, raw: { lookback: 10 } });
    expect(detail.calls[0].result.content[0].text).toBe("Split the batch");
    const pending = await (await fetch(base + "/api/run/annual-2025-Q2/2025-04-02")).json() as any;
    expect(pending).toMatchObject({ status: "uncommitted", after: null, journal: null });
    expect((await fetch(base + "/api/run/annual-2025-Q2/2026-04-01")).status).toBe(404);
    // A newly published commit invalidates the cache even without a new event.
    await writeFile(join(source, "days", "2025-04-02.json"), JSON.stringify({ ...day, date: "2025-04-02", record: { ...day.record, date: "2025-04-02" } }));
    expect(((await (await fetch(base + "/api/runs")).json()) as any).runs[0].committed).toBe(2);
    await writeFile(join(source, "events.jsonl"), '{"bad complete line"}\n');
    await expect(loadRun(source)).rejects.toThrow();
  } finally {
    await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
