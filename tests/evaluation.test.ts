import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { exchangeDates, CALENDAR_VERSION } from "../src/data/calendar.ts";
import { ADJUSTMENT_CONVENTION, sha256, type DatasetManifest } from "../src/data/dataset.ts";
import { createInitialPortfolio } from "../src/engine/portfolio.ts";
import { deterministicControl } from "../src/study/control.ts";
import {
  CONTROL_MODEL, EVALUATION_MODELS,
  evaluationSchedule, prepareEvaluation, runEvaluation, evaluationReport,
  type EvaluationInput,
} from "../src/study/evaluation.ts";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});
function input(start = "2024-10-01", end = "2026-03-31"): EvaluationInput {
  const dataDir = mkdtempSync(join(tmpdir(), "quarter-eval-test-"));
  cleanup.push(dataDir);
  const calendar = exchangeDates(start, end);
  const bars = JSON.stringify(calendar.map((date, i) => ({
    date, open: 100 + i / 100, high: 102 + i / 100, low: 99 + i / 100,
    close: 101 + i / 100, volume: 10000,
  })));
  writeFileSync(join(dataDir, "AAPL.json"), bars);
  writeFileSync(join(dataDir, "source.json"), "{}");
  const manifest: DatasetManifest = {
    schemaVersion: 1, kind: "historical", source: "controlled test data, not market observations",
    fetchedAt: "2026-04-01T00:00:00Z", adjustmentConvention: ADJUSTMENT_CONVENTION,
    calendarVersion: CALENDAR_VERSION, coverage: { start, end }, evaluation: { start, end },
    calendar, universe: ["AAPL"],
    // A boundary dividend must confer no entitlement on the freshly empty account.
    actions: [{ type: "dividend", ticker: "AAPL", date: "2025-07-01", amount: 10 }],
    files: { AAPL: { path: "AAPL.json", sha256: sha256(bars) } },
    snapshots: [{ path: "source.json", sha256: sha256("{}") }],
  };
  writeFileSync(join(dataDir, "manifest.json"), JSON.stringify(manifest));
  const value = { evalId: "test-eval-" + randomUUID(), dataDir, models: [CONTROL_MODEL] };
  cleanup.push(resolve("results/evaluations", value.evalId));
  for (const job of evaluationSchedule(value.evalId, [...EVALUATION_MODELS, CONTROL_MODEL]))
    cleanup.push(resolve("results/studies", job.runId));
  return value;
}

test("every model receives exactly the same four disjoint quarters across the year boundary", () => {
  const models = ["provider/model-a", "provider-model-a", "provider/model-b", "provider/model-c"];
  const jobs = evaluationSchedule("matrix", models);
  expect(jobs).toHaveLength(16);
  expect(new Set(jobs.map(j => j.runId)).size).toBe(16);
  for (const model of models) {
    expect(jobs.filter(j => j.model === model).map(({ label, start, end }) => ({ label, start, end })))
      .toEqual([
        { label: "2025-Q2", start: "2025-04-01", end: "2025-06-30" },
        { label: "2025-Q3", start: "2025-07-01", end: "2025-09-30" },
        { label: "2025-Q4", start: "2025-10-01", end: "2025-12-31" },
        { label: "2026-Q1", start: "2026-01-01", end: "2026-03-31" },
      ]);
  }
  expect(() => evaluationSchedule("duplicate", ["a", "a"])).toThrow("distinct");
  expect(() => evaluationSchedule("../escape", models)).toThrow("ID");
  expect(() => evaluationSchedule("empty", [])).toThrow("nonempty");
});

test("preflight freezes a separate model/quarter config and checks funding for all model/control jobs", async () => {
  const c = input();
  c.models = [...EVALUATION_MODELS, CONTROL_MODEL];
  const plan = await prepareEvaluation(c);
  expect(plan.jobs).toHaveLength((EVALUATION_MODELS.length + 1) * 4);
  expect(plan.execution).toEqual({ maxConcurrentRuns: (EVALUATION_MODELS.length + 1) * 4, scheduling: "model-then-quarter-queue", state: "independent-runs" });
  for (const model of c.models) {
    const jobs = plan.jobs.filter(j => j.model === model);
    expect(jobs.map(j => j.sessions)).toEqual([62, 64, 64, 61]);
    expect(jobs.map(j => j.firstSession)).toEqual(["2025-04-01", "2025-07-01", "2025-10-01", "2026-01-02"]);
    expect(jobs.every(j => j.funding.length === 2 && j.funding.every(d => d.amount === 50000))).toBe(true);
    expect(new Set(jobs.map(j => j.config.datasetHash)).size).toBe(1);
    expect(new Set(jobs.map(j => j.config)).size).toBe(4);
    expect(jobs.every(j => j.config.model === (model === CONTROL_MODEL ? undefined : model))).toBe(true);
  }
  expect(plan.initialization.totalFundingPerQuarter).toBe(150000);
  expect(plan.initialization.totalFundingPerModel).toBe(600000);
  expect(plan.initialization.carryForward).toBe(false);
  expect(existsSync(resolve("results/evaluations", c.evalId))).toBe(false);
});

test("a truncated fourth quarter fails before any earlier-quarter inference or artifact", async () => {
  const c = input("2024-10-01", "2026-02-27");
  let calls = 0;
  await expect(runEvaluation(c, { control: async (...args) => {
    calls++;
    return deterministicControl(...args);
  } })).rejects.toThrow("outside dataset coverage");
  expect(calls).toBe(0);
  expect(existsSync(resolve("results/evaluations", c.evalId))).toBe(false);
  for (const j of evaluationSchedule(c.evalId, c.models!))
    expect(existsSync(resolve("results/studies", j.runId))).toBe(false);
});

test("missing pre-April history and unqualified routes fail preflight", async () => {
  await expect(prepareEvaluation(input("2025-04-01"))).rejects.toThrow("Insufficient warmup");
  const c = input();
  await expect(prepareEvaluation({ ...c, models: ["opencode/paid-or-unqualified"] })).rejects.toThrow("Unqualified");
  await expect(prepareEvaluation({ ...c, history: 59 })).rejects.toThrow("History");
  await expect(prepareEvaluation({ ...c, timeoutMs: 3600001 })).rejects.toThrow("Timeout");
  for (const concurrency of [0, -1, 1.5, NaN, Infinity, 5])
    await expect(prepareEvaluation({ ...c, concurrency })).rejects.toThrow("Concurrency");
});

test("four concurrent runs own fresh balances, holdings, journals, funding, attempts and chains; resume only their own state", async () => {
  const c = input();
  const openings: string[] = [];
  let calls = 0;
  const allStarted = Promise.withResolvers<void>();
  const startDeadline = setTimeout(() => allStarted.reject(Error("All four quarters must start concurrently")), 10000);
  const result = await runEvaluation(c, { control: async (view, store, past) => {
    calls++;
    expect(past.every(p => p.runId === view.scope.runId && p.date < view.scope.date)).toBe(true);
    if (!past.length) {
      openings.push(view.scope.date);
      expect(view.portfolio).toEqual(createInitialPortfolio(50000));
      expect(view.scope.attempt).toBe(1);
      expect(store.all()).toHaveLength(1);
      expect(store.all()[0]!.previous).toBe("0".repeat(64));
      expect(view.horizon.contributions).toHaveLength(2);
      if (openings.length === 4) {
        clearTimeout(startDeadline);
        allStarted.resolve();
      }
      await allStarted.promise;
      expect(openings).toHaveLength(4);
    }
    return deterministicControl(view, store, past);
  } });
  expect(openings.sort()).toEqual(["2025-04-01", "2025-07-01", "2025-10-01", "2026-01-02"]);
  expect(calls).toBe(251);
  expect(result.report.status).toBe("completed");
  expect(JSON.parse(readFileSync(join(result.dir, "summary.json"), "utf8"))).toEqual(result.report);
  const yearly = result.report.models[0]!.year!;
  expect(yearly.totalContributions).toBe(600000);
  const equitySum = result.report.quarters.reduce((n, q) => n + q.metrics!.endingNetWorth, 0);
  expect(yearly.sumOfQuarterEndingEquities).toBeCloseTo(equitySum, 2);
  expect(yearly.netProfit).toBeCloseTo(equitySum - 600000, 2);
  expect(yearly).not.toHaveProperty("timeWeightedReturnPct");
  const logs: string[] = [];
  for (const job of result.plan.jobs) {
    const dir = resolve("results/studies", job.runId);
    const first = JSON.parse(readFileSync(join(dir, "days", job.firstSession + ".json"), "utf8"));
    expect(first.previous).toBe("0".repeat(64));
    expect(first.record.portfolioBefore).toEqual(createInitialPortfolio(50000));
    expect(first.record.contribution).toBe(0);
    const last = JSON.parse(readFileSync(join(dir, "days", job.lastSession + ".json"), "utf8"));
    expect(last.record.portfolioAfter.holdings.AAPL.units).toBeGreaterThan(0);
    expect(last.record.portfolioAfter.cash).not.toBe(50000);
    const q = result.report.quarters.find(q => q.runId === job.runId)!;
    expect(q.metrics!.totalContributions).toBe(150000);
    expect(q.summary!.journalEntries).toBe(job.sessions);
    logs.push(readFileSync(join(dir, "events.jsonl"), "utf8"));
  }
  const resume = await runEvaluation(c, { resume: true, control: async () => {
    throw Error("Completed quarters must never run again");
  } });
  expect(resume.report).toEqual(result.report);
  expect((await runEvaluation(c, { readOnly: true })).report).toEqual(result.report);
  for (const [i, job] of result.plan.jobs.entries())
    expect(readFileSync(resolve("results/studies", job.runId, "events.jsonl"), "utf8")).toBe(logs[i]!);
  await expect(runEvaluation(c)).rejects.toThrow("already exists");
  await expect(runEvaluation({ ...c, history: 101 }, { resume: true })).rejects.toThrow("changed");
  expect(evaluationReport(result.plan, result.report.quarters.slice(0, 3)).models[0]!.year).toBeNull();
  expect(() => evaluationReport(result.plan, [...result.report.quarters, result.report.quarters[0]!])).toThrow("Duplicate");
}, 300000);

test("three invalid days stop only their quarter; later quarters reset the streak and still run", async () => {
  const c = input();
  let firstQuarterCalls = 0;
  const first = await runEvaluation(c, { control: async (view, journal, past) => {
    if (view.scope.date < "2025-07-01") {
      firstQuarterCalls++;
      const a = await deterministicControl(view, journal, past);
      a.outcome = "provider_error";
      a.reason = "failure fixture";
      a.decision.outcome = "provider_error";
      a.decision.orders = [];
      return a;
    }
    if (!past.length) {
      expect(view.portfolio).toEqual(createInitialPortfolio(50000));
      expect(view.scope.attempt).toBe(1);
    }
    return deterministicControl(view, journal, past);
  } });
  expect(firstQuarterCalls).toBe(6);
  expect(first.report.quarters.map(q => q.status)).toEqual(["invalid", "completed", "completed", "completed"]);
  expect(first.report.quarters[0]!.summary!.committedDays).toBe(3);
  expect(first.report.quarters[0]!.summary!.invalidDays).toBe(3);
  expect(first.report.quarters.slice(1).every(q => q.summary!.consecutiveInvalidDays === 0)).toBe(true);
  expect(first.report.models[0]!.complete).toBe(false);
  expect(first.report.models[0]!.year).toBeNull();
  const resumed = await runEvaluation(c, { resume: true, control: async () => { throw Error("No fresh attempts"); } });
  expect(resumed.report).toEqual(first.report);
}, 300000);

test("new evaluations refuse existing child state and model results refuse a control transport", async () => {
  const c = input();
  const job = evaluationSchedule(c.evalId, c.models!)[0]!;
  mkdirSync(resolve("results/studies", job.runId), { recursive: true });
  await expect(runEvaluation(c)).rejects.toThrow("Refusing to adopt");
  await expect(runEvaluation({ ...c, models: EVALUATION_MODELS }, { control: deterministicControl }))
    .rejects.toThrow("Control transport");
});

test("eval CLI preflight has zero inference and refuses dates, truncation and model aliases", () => {
  const c = input();
  const base = ["bun", "src/index.ts", "eval", "--eval-id=" + c.evalId, "--data-dir=" + c.dataDir];
  const child = Bun.spawnSync([...base, "--preflight=true"], { stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(0);
  const parsed = JSON.parse(child.stdout.toString());
  expect(parsed.modelCalls).toBe(0);
  expect(parsed.plan.jobs).toHaveLength(EVALUATION_MODELS.length * 4);
  expect(parsed.plan.start).toBe("2025-04-01");
  expect(parsed.plan.end).toBe("2026-03-31");
  const serial = Bun.spawnSync([...base, "--preflight=true", "--concurrency=1"], { stdout: "pipe", stderr: "pipe" });
  expect(serial.exitCode).toBe(0);
  expect(JSON.parse(serial.stdout.toString()).plan.execution.maxConcurrentRuns).toBe(1);
  for (const flag of ["--end=2026-08-31", "--start=2026-01-01", "--models=unqualified", "--concurrency=0", "--concurrency=1.5", "--concurrency=999"]) {
    const p = Bun.spawnSync([...base, "--preflight=true", flag], { stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(1);
  }
  expect(existsSync(resolve("results/evaluations", c.evalId))).toBe(false);
});

test("one failed quarter leaves the other runs active and concurrent completions preserve the whole report", async () => {
  const c = input();
  const started = new Set<string>();
  const ready = Promise.withResolvers<void>();
  const releaseOthers = Promise.withResolvers<void>();
  const deadline = setTimeout(() => ready.reject(Error("Four runs did not start")), 10000);
  const running = runEvaluation(c, { control: async view => {
    started.add(view.scope.runId);
    if (started.size === 4) ready.resolve();
    if (view.scope.date < "2025-07-01") throw Error("First quarter failed independently");
    await releaseOthers.promise;
    throw Error("End controlled concurrent attempt");
  } });
  try {
    await ready.promise;
    expect(started.size).toBe(4);
    // The three waiting children still own the evaluation even if Q2 has failed.
    await expect(runEvaluation(c, { resume: true })).rejects.toThrow("locked by another process");
  } finally {
    clearTimeout(deadline);
    releaseOthers.resolve();
    await running;
  }
  const result = await running;
  expect(result.report.quarters.map(q => q.label)).toEqual(["2025-Q2", "2025-Q3", "2025-Q4", "2026-Q1"]);
  expect(result.report.quarters.every(q => q.status === "error")).toBe(true);
  expect(result.report.quarters[0]!.error).toContain("First quarter failed independently");
  expect(result.report.models[0]!.year).toBeNull();
  expect(JSON.parse(readFileSync(join(result.dir, "summary.json"), "utf8"))).toEqual(result.report);
}, 30000);

test("verify reports the damaged quarter and underlying replay error through the CLI", async () => {
  const c = input();
  const started = await runEvaluation(c, { control: async () => {
    throw Error("Leave a resumable attempt without accounting");
  } });
  const damaged = started.plan.jobs[2]!;
  const eventPath = resolve("results/studies", damaged.runId, "events.jsonl");
  const event = JSON.parse(readFileSync(eventPath, "utf8").trim());
  event.previous = "forged";
  writeFileSync(eventPath, JSON.stringify(event) + "\n");
  const child = Bun.spawnSync([
    "bun", "src/index.ts", "eval", "--eval-id=" + c.evalId,
    "--data-dir=" + c.dataDir, "--control=true", "--verify=true",
  ], { stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(1);
  expect(child.stderr.toString()).toContain(damaged.runId);
  expect(child.stderr.toString()).toContain("Event integrity failure");
});

test("default plan includes the registered OpenCode models and subsets retain exact route identity", async () => {
  const c = input();
  const plan = await prepareEvaluation({ ...c, models: undefined });
  expect(plan.models).toEqual([
    "opencode/muse-spark-1.3-contributor-free",
    "opencode/muse-spark-1.2-contributor-free",
    "openai/gpt-5.6-luna",
    "opencode-go/glm-5.3-flash",
    "opencode-go/deepseek-v4.1-flash",
    "opencode-go/kimi-k3",
  ]);
  expect(plan.jobs).toHaveLength(EVALUATION_MODELS.length * 4);
  for (const model of plan.models) {
    const subset = await prepareEvaluation({ ...c, models: [model] });
    expect(subset.jobs).toHaveLength(4);
    expect(subset.jobs.every(j => j.model === model && j.config.model === model)).toBe(true);
  }
});

test("all registered model jobs start concurrently with their own model configuration, without inference", async () => {
  const c = input();
  // Subprocess-local module mock keeps this test offline and cannot replace the
  // real runner in another test. The barrier detects model-at-a-time scheduling.
  const script = `import { mock } from "bun:test";
    const runnerPath = ${JSON.stringify(resolve("src/study/runner.ts"))};
    const actual = await import(runnerPath);
    const prepared = actual.prepareStudyData;
    const started = [];
    const barrier = Promise.withResolvers();
    const timer = setTimeout(() => barrier.reject(Error("Model jobs did not start concurrently")), 5000);
    mock.module(runnerPath, () => ({
      prepareStudyData: prepared,
      runStudy: async config => {
        started.push({ model: config.model, runId: config.runId, start: config.start });
        if (started.length === ${EVALUATION_MODELS.length * 4}) { clearTimeout(timer); barrier.resolve(); }
        await barrier.promise;
        throw Error("Offline model runner fixture");
      },
    }));
    const { runEvaluation } = await import(${JSON.stringify(resolve("src/study/evaluation.ts"))});
    const result = await runEvaluation(${JSON.stringify({ ...c, models: undefined })});
    console.log(JSON.stringify({ started, report: result.report }));`;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(err).toBe(""); expect(code).toBe(0);
  const result = JSON.parse(out);
  expect(result.started).toHaveLength(EVALUATION_MODELS.length * 4);
  expect(new Set(result.started.map((j: any) => j.runId)).size).toBe(EVALUATION_MODELS.length * 4);
  for (const model of EVALUATION_MODELS) expect(result.started.filter((j: any) => j.model === model)).toHaveLength(4);
  expect(result.report.quarters.every((q: any) => q.error.includes("Offline model runner fixture"))).toBe(true);
}, 10000);

for (const concurrency of [1, 2]) test(`bounded queue admits at most ${concurrency} runs, retains pending state and survives failed quarters`, async () => {
  const c = { ...input(), concurrency };
  const started: string[] = [];
  let active = 0, peak = 0;
  const firstWave = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const timeout = setTimeout(() => firstWave.reject(Error("Queue did not start")), 5000);
  const running = runEvaluation(c, { control: async (view, store, past) => {
    started.push(view.scope.runId); active++; peak = Math.max(peak, active);
    expect(view.portfolio).toEqual(createInitialPortfolio(50000));
    expect(view.scope.attempt).toBe(1); expect(past).toEqual([]); expect(store.all()).toHaveLength(1);
    if (started.length === concurrency) firstWave.resolve();
    try { await release.promise; throw Error("Offline quarter failure"); }
    finally { active--; }
  } });
  try {
    await firstWave.promise;
    const snapshot = JSON.parse(readFileSync(resolve("results/evaluations", c.evalId, "summary.json"), "utf8"));
    expect(snapshot.quarters.map((q: any) => q.status)).toEqual(Array.from({ length: 4 }, (_, i) => i < concurrency ? "running" : "pending"));
    const jobs = evaluationSchedule(c.evalId, c.models!);
    for (const job of jobs.slice(concurrency)) expect(existsSync(resolve("results/studies", job.runId, "manifest.json"))).toBe(false);
    await expect(runEvaluation(c, { resume: true })).rejects.toThrow("locked by another process");
  } finally {
    clearTimeout(timeout); release.resolve(); await running;
  }
  const result = await running;
  expect(peak).toBe(concurrency);
  // Concurrent first-wave jobs may start in either order; assert set membership, not order.
  expect(started).toHaveLength(result.plan.jobs.length);
  expect([...started].sort()).toEqual(result.plan.jobs.map(j => j.runId).sort());
  expect(result.report.quarters.every(q => q.status === "error" && q.error?.includes("Offline quarter failure"))).toBe(true);
  expect(result.report.models[0]!.year).toBeNull();
  expect(JSON.parse(readFileSync(join(result.dir, "summary.json"), "utf8"))).toEqual(result.report);
  await expect(runEvaluation({ ...c, concurrency: concurrency === 1 ? 2 : 1 }, { resume: true })).rejects.toThrow("changed");
  // Verification with the frozen schedule is read-only, even for interrupted jobs.
  const logs = result.plan.jobs.map(j => readFileSync(resolve("results/studies", j.runId, "events.jsonl"), "utf8"));
  expect((await runEvaluation(c, { readOnly: true })).report.status).toBe("incomplete");
  expect(result.plan.jobs.map(j => readFileSync(resolve("results/studies", j.runId, "events.jsonl"), "utf8"))).toEqual(logs);
}, 15000);

test("quota-aware serial evaluation pauses before admitting another quarter and freezes the policy", async () => {
  const c = { ...input(), models: ["pi/openai-codex/gpt-6-astra"], concurrency: 1, pauseOnQuota: true };
  for (const job of evaluationSchedule(c.evalId, c.models)) cleanup.push(resolve("results/studies", job.runId));
  const script = `import { mock } from "bun:test";
    let calls=0;
    mock.module(${JSON.stringify(resolve("src/study/model.ts"))},()=>({
      prepareModelRuntime:async()=>({credential:{authorize:async()=>new Headers()},bundle:{evidence:{id:"quota-fixture"}},dispose:async()=>{}}),
      decideStudy:async(view,store,past,horizon,audit)=>{
        calls++;
        const {initialStudyDecision}=await import(${JSON.stringify(resolve("src/study/agent.ts"))});
        const {contentHash}=await import(${JSON.stringify(resolve("src/core/hash.ts"))});
        const decision=initialStudyDecision(view);
        decision.trace=[{type:"inference_response",sequence:1,status:429},{type:"inference_chunk",sequence:1,base64:Buffer.from(JSON.stringify({error:{type:"usage_limit_reached",resets_in_seconds:3600}})).toString("base64")}];
        decision.trace.forEach(audit);
        return {outcome:"harness_error",reason:"quota fixture",scope:view.scope,viewHash:contentHash(view),decision,journalEntries:[]};
      }
    }));
    const {runEvaluation}=await import(${JSON.stringify(resolve("src/study/evaluation.ts"))});
    const c=${JSON.stringify(c)};
    const first=await runEvaluation(c);
    const resumed=await runEvaluation(c,{resume:true});
    const verified=await runEvaluation(c,{readOnly:true});
    console.log(JSON.stringify({calls,first:first.report.quarters.map(q=>q.status),resumed:resumed.report.quarters.map(q=>q.status),verified:verified.report.quarters.map(q=>q.status),policy:first.plan.jobs[0].config.availabilityPolicy,version:first.plan.version}));`;
  const p = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  expect(err).toBe(""); expect(code).toBe(0);
  const result = JSON.parse(out);
  expect(result.calls).toBe(1);
  expect(result.first).toEqual(["paused", "pending", "pending", "pending"]);
  expect(result.resumed).toEqual(result.first);
  expect(result.verified).toEqual(result.first);
  expect(result.policy.version).toBe("quota-pause-v1");
  expect(result.version).toContain("v5-quota-pause");
});
