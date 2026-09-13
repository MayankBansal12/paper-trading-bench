import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UNIVERSE_V1 } from "../src/config/universe.ts";
import { ADJUSTMENT_CONVENTION, loadDataset, sha256, type CorporateAction } from "../src/data/dataset.ts";
import { CALENDAR_VERSION, exchangeDates } from "../src/data/calendar.ts";
import { FIXTURE_VERSION } from "../src/data/ohlcv.ts";
import { EXECUTION_CONVENTION } from "../src/engine/execution.ts";
import { initialDecision } from "../src/agent/trace.ts";
import { AGENT_PROTOCOL_VERSION } from "../src/agent/protocolVersion.ts";
import { createInitialPortfolio, valuePortfolio } from "../src/engine/portfolio.ts";
import { computeMetrics } from "../src/engine/metrics.ts";
import { preparePortfolio } from "../src/engine/cashFlows.ts";
import { cashBaseline, buyAndHoldBaseline } from "../src/engine/baselines.ts";
import { loadValidatedSummary, runBatch } from "../src/run/orchestrator.ts";
import { loadRunState, resolveRunDir, saveRunState } from "../src/run/state.ts";
import { loadAttempts, loadDailyRecord, sealRecord, contentHash, textHash } from "../src/run/persist.ts";
import type { AgentDecision, AgentPort, DailyRecord, DecisionContext, RunConfig } from "../src/domain/types.ts";

const cleanup: string[] = [];
afterEach(async () => { for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true }); });
function config(overrides: Partial<RunConfig> = {}): RunConfig {
  const c: RunConfig = { model: "test-accounting", seed: 123, agent: "fake", startDate: "2024-01-02", endDate: "2024-03-29", startingCapital: 500,
    universeVersion: "v1", limits: { maxTurns: 10, maxToolCalls: 30, timeoutMs: 1000 }, executionConvention: EXECUTION_CONVENTION,
    protocolVersion: AGENT_PROTOCOL_VERSION, fixtureVersion: FIXTURE_VERSION, runId: crypto.randomUUID(), ...overrides };
  cleanup.push(resolveRunDir(c).dir); return c;
}
function decision(overrides: Partial<AgentDecision> = {}): AgentDecision {
  return { orders: [], failedOrders: [], rationale: "hold", usage: { turns: 1, toolCalls: 0, failedToolCalls: 0, promptTokens: 2, completionTokens: 3 }, boundedStop: false, boundedReason: null, outcome: "completed", ...overrides };
}
function agent(build: (ctx: DecisionContext) => AgentDecision | Promise<AgentDecision> = () => decision()): AgentPort { return { name: "accounting-script", decide: async (ctx) => build(ctx) }; }
const deposits = [{ date: "2024-02-01", amount: 500 }, { date: "2024-03-01", amount: 500 }];
async function dataset(dates: string[], actions: CorporateAction[] = [], prices = dates.map(() => [100, 100]), historicalEnd?: string) {
  const dir = await mkdtemp(join(tmpdir(), "accounting-market-")); cleanup.push(dir);
  const files: Record<string, { path: string; sha256: string }> = {};
  for (const ticker of UNIVERSE_V1) {
    const bars = dates.map((date, i) => ({ date, open: prices[i]![0], close: prices[i]![1], high: Math.max(...prices[i]!), low: Math.min(...prices[i]!), volume: 1000 }));
    const body = JSON.stringify(bars); files[ticker] = { path: `${ticker}.json`, sha256: sha256(body) }; await writeFile(join(dir, `${ticker}.json`), body);
  }
  const snapshot = "controlled historical-schema accounting fixture";
  if (historicalEnd) await writeFile(join(dir, "snapshot.txt"), snapshot);
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ schemaVersion: 1, kind: historicalEnd ? "historical" : "synthetic", source: "accounting-test", fetchedAt: "2024-01-01T00:00:00Z", adjustmentConvention: ADJUSTMENT_CONVENTION,
    calendarVersion: CALENDAR_VERSION, coverage: { start: dates[0], end: historicalEnd ?? dates.at(-1) }, evaluation: { start: dates[0], end: historicalEnd ?? dates.at(-1) }, calendar: dates, universe: UNIVERSE_V1, actions, files, snapshots: historicalEnd ? [{ path: "snapshot.txt", sha256: sha256(snapshot) }] : [] }));
  return { dir, market: await loadDataset(dir) };
}

describe("contribution-adjusted accounting", () => {
  test("three-month cash-only replay contributes exactly $1500 and reports no performance gain", async () => {
    const c = config({ contributions: deposits });
    const { summary, dir } = await runBatch(c, agent());
    expect(summary.status).toBe("completed"); expect(summary.finalPortfolio).toEqual(createInitialPortfolio(1500));
    expect(summary.totalContributions).toBe(1500); expect(summary.netProfit).toBe(0); expect(summary.timeWeightedReturnPct).toBe(0);
    expect(summary.metrics.maxDrawdownPct).toBe(0); expect(summary.metrics.dailyVolatilityPct).toBe(0);
    expect(summary.baselines.cash.metrics.totalContributions).toBe(1500); expect(summary.baselines.cash.metrics.totalReturnPct).toBe(0);
    expect((await loadDailyRecord(dir, "2024-02-01"))!.portfolioBefore.cash).toBe(500);
    expect((await loadDailyRecord(dir, "2024-02-01"))!.portfolioAfter.cash).toBe(1000);
    const resumed = await runBatch(c, agent(() => { throw new Error("must not call"); }));
    expect(resumed.summary).toEqual(summary);
  });

  test("full API benchmark validates exchange dates, warmup and monthly principal", async () => {
    const dates = exchangeDates("2023-10-02", "2024-03-31");
    const { dir, market } = await dataset(dates, [], dates.map(() => [100, 100]), "2024-03-31");
    const c = config({ dataDir: dir, fixtureVersion: market.version, experiment: "three-month", warmupBars: 60, startDate: "2024-01-01", endDate: "2024-03-31", contributions: deposits });
    const run = await runBatch(c, agent());
    expect(run.summary.status).toBe("completed"); expect(run.summary.finalPortfolio!.cash).toBe(1500);
    expect(run.summary.metrics.daysRun).toBe(exchangeDates("2024-01-01", "2024-03-31").length);
    expect(run.summary.timeWeightedReturnPct).toBe(0);
    for (const override of [{ startingCapital: 1000 }, { contributions: [] }, { warmupBars: 59 }, { endDate: "2024-03-28" }]) {
      await expect(runBatch({ ...c, ...override, runId: crypto.randomUUID() }, agent(() => { throw new Error("must reject before model"); }))).rejects.toThrow(/benchmark requires/);
    }
  });

  test("known flow-adjusted path links returns and computes drawdown on performance index", () => {
    const metrics = computeMetrics([{ date: "1", netWorth: 550 }, { date: "2", netWorth: 945, contribution: 500 }, { date: "3", netWorth: 1445, contribution: 500 }], 500, 0, 0, 0, [0, 0, 0]);
    expect(metrics.totalContributions).toBe(1500); expect(metrics.netProfit).toBe(-55);
    expect(metrics.timeWeightedReturnPct).toBe(-1); expect(metrics.maxDrawdownPct).toBe(-10);
  });

  test("split and dividend apply before decisions; new same-day shares get no dividend", async () => {
    const dates = ["2024-01-02", "2024-01-03"];
    const actions: CorporateAction[] = [{ date: dates[1]!, ticker: "AAPL", type: "split", ratio: 2 }, { date: dates[1]!, ticker: "AAPL", type: "dividend", amount: 1 }];
    const { dir, market } = await dataset(dates, actions, [[100, 100], [49, 49]]);
    const c = config({ startDate: dates[0], endDate: dates[1], dataDir: dir, fixtureVersion: market.version, warmupBars: 0 });
    const contexts: DecisionContext[] = [];
    const result = await runBatch(c, agent((ctx) => { contexts.push(ctx); return decision({ orders: ctx.date === dates[0] ? [{ ticker: "AAPL", side: "BUY", sizing: { kind: "units", units: 5 } }] : [] }); }));
    expect(contexts[1]!.portfolio.holdings.AAPL!.units).toBe(10); expect(contexts[1]!.portfolio.holdings.AAPL!.avgCost).toBe(50);
    expect(contexts[1]!.portfolio.cash).toBe(10); expect(contexts[1]!.bars.AAPL![0]!.close).toBe(50);
    expect(result.summary.finalPortfolio!.netWorth).toBe(500); expect(result.summary.netProfit).toBe(0);
    const noPrior = preparePortfolio(createInitialPortfolio(500), 0, actions); expect(noPrior.cash).toBe(500);
  });

  test("baseline buys each deposit at its own open and includes splits and dividends", async () => {
    const dates = ["2024-01-02", "2024-02-01", "2024-03-01"];
    const { market } = await dataset(dates, [{ type: "split", date: dates[1]!, ticker: "AAPL", ratio: 2 }, { type: "dividend", date: dates[2]!, ticker: "AAPL", amount: 1 }], [[100, 100], [50, 50], [50, 50]]);
    const bh = await buyAndHoldBaseline(500, ["AAPL"], dates, deposits, market);
    expect(bh.tradeCount).toBe(3); expect(bh.finalPortfolio!.holdings.AAPL!.units).toBeCloseTo(30, 2);
    expect(bh.finalPortfolio!.cash).toBeCloseTo(20, 1); expect(bh.finalPortfolio!.netWorth).toBeCloseTo(1520, 1);
    expect(cashBaseline(500, dates, deposits).at(-1)!.netWorth).toBe(1500);
  });

  test("negative and non-finite marks are rejected at the financial boundary", () => {
    const p = { cash: 0, holdings: { AAPL: { units: 1, avgCost: 100, lastClose: 100, value: 100 } }, holdingsValue: 100, netWorth: 100 };
    expect(() => valuePortfolio(p, () => -100)).toThrow(/Invalid valuation/);
    expect(() => valuePortfolio(p, () => NaN)).toThrow(/Invalid valuation/);
  });
});

describe("atomic decisions and resume integrity", () => {
  test("provider failure after queued buy is not a hold or partial trade and retries deposit date", async () => {
    const c = config({ startDate: "2024-01-31", endDate: "2024-02-02", contributions: [deposits[0]!] });
    const failedOrder = { ticker: "AAPL", side: "BUY" as const, sizing: { kind: "units" as const, units: 1 } };
    const seen: number[] = [];
    const first = await runBatch(c, agent((ctx) => { if (ctx.date === "2024-02-01") { seen.push(ctx.portfolio.cash); return decision({ outcome: "provider_error", orders: [failedOrder], terminalReason: "provider unavailable", usage: { turns: 1, toolCalls: 1, failedToolCalls: 0, promptTokens: 10, completionTokens: 20, cacheReadTokens: 30, costUsd: 0.01 } }); } return decision(); }));
    expect(first.summary.status).toBe("failed"); expect(first.summary.metrics.daysRun).toBe(1); expect(first.summary.metrics.tradeCount).toBe(0);
    expect(first.summary.finalPortfolio!.cash).toBe(500); expect(first.summary.totalContributions).toBe(500);
    expect(await loadDailyRecord(first.dir, "2024-02-01")).toBeNull();
    const attempts = await loadAttempts(first.dir); expect(attempts[0]!.decision!.orders).toEqual([failedOrder]);
    expect(first.summary.usageTotals.cacheReadTokens).toBe(30);
    const second = await runBatch(c, agent((ctx) => { if (ctx.date === "2024-02-01") seen.push(ctx.portfolio.cash); return decision(); }));
    expect(seen).toEqual([1000, 1000]); expect(second.summary.finalPortfolio!.cash).toBe(1000);
    expect(second.summary.attemptCount).toBe(4); expect(second.summary.failedAttemptCount).toBe(1);
  });

  test("a thrown agent exception creates an uncommitted harness-error attempt", async () => {
    const c = config({ endDate: "2024-01-02" });
    const run = await runBatch(c, agent(() => { throw new Error("transport exploded"); }));
    expect(run.summary.status).toBe("failed"); expect(run.summary.metrics.daysRun).toBe(0);
    expect((await loadAttempts(run.dir))[0]!.outcome).toBe("harness_error");
    expect((await loadRunState(run.dir))!.completedDates).toEqual([]);
  });

  test("deposit-day orphan recovery adopts valid ledger and never credits twice", async () => {
    const c = config({ startDate: "2024-01-31", endDate: "2024-02-01", contributions: [deposits[0]!] });
    const first = await runBatch(c, agent());
    const state = (await loadRunState(first.dir))!;
    state.completedDates.pop(); state.lastNetWorth = 500; state.status = "active"; await saveRunState(first.dir, state);
    const replay = await runBatch(c, agent(() => { throw new Error("orphan must be adopted"); }));
    expect(replay.summary.finalPortfolio!.cash).toBe(1000); expect(replay.summary.metrics.daysRun).toBe(2);
    expect(replay.summary.failedAttemptCount).toBe(0);
  });

  test("validator repairs corrupt summary metrics and missing transactions", async () => {
    const c = config({ endDate: "2024-01-03" });
    const first = await runBatch(c, agent());
    const bad = structuredClone(first.summary); bad.metrics.totalReturnPct = 999; bad.metrics.tradeCount = 999;
    await writeFile(join(first.dir, "summary.json"), JSON.stringify(bad)); await rm(join(first.dir, "transactions.jsonl"));
    const repaired = await loadValidatedSummary(first.dir);
    expect(repaired).toEqual(first.summary); expect(await readFile(join(first.dir, "transactions.jsonl"), "utf8")).toBe("");
  });

  test("rejects corrupted hashes and forged portfolio even with a recomputed checksum", async () => {
    const c = config({ endDate: "2024-01-02" }); const run = await runBatch(c, agent());
    const path = join(run.dir, "daily", "2024-01-02.json");
    const record = JSON.parse(await readFile(path, "utf8")) as DailyRecord;
    record.portfolioAfter.cash = 900; record.portfolioAfter.netWorth = 900;
    await writeFile(path, JSON.stringify(record));
    await expect(loadValidatedSummary(run.dir)).rejects.toThrow(/integrity mismatch/);
    await writeFile(path, JSON.stringify(sealRecord(record)));
    await expect(loadValidatedSummary(run.dir)).rejects.toThrow(/ledger is inconsistent/);
  });

  test("rejects mismatched filename dates and non-prefix state", async () => {
    const c = config({ endDate: "2024-01-03" }); const run = await runBatch(c, agent());
    const path = join(run.dir, "daily", "2024-01-03.json"); const record = JSON.parse(await readFile(path, "utf8")) as DailyRecord;
    record.date = "2099-12-31"; await writeFile(path, JSON.stringify(sealRecord(record)));
    await expect(loadValidatedSummary(run.dir)).rejects.toThrow(/Invalid or legacy daily/);
    const state = (await loadRunState(run.dir))!; state.completedDates = ["2024-01-03"]; await saveRunState(run.dir, state);
    await expect(loadValidatedSummary(run.dir)).rejects.toThrow(/ordered evaluation-calendar prefix/);
  });

  test("extension failure has current config and failed state instead of an old completed report", async () => {
    const c = config({ endDate: "2024-01-02" }); const first = await runBatch(c, agent());
    const extended = await runBatch({ ...c, endDate: "2024-01-03" }, agent(() => { throw new Error("extension failed"); }));
    expect(extended.summary.status).toBe("failed"); expect((await loadRunState(first.dir))!.status).toBe("failed");
    const report = await loadValidatedSummary(first.dir); expect(report.config.endDate).toBe("2024-01-03"); expect(report.status).toBe("failed");
  });

  test("failed runs compare baselines only over the committed prefix", async () => {
    const c = config({ startDate: "2024-01-31", endDate: "2024-02-02", contributions: [deposits[0]!] });
    const run = await runBatch(c, agent((ctx) => ctx.date === "2024-02-01" ? decision({ outcome: "provider_error", terminalReason: "failed" }) : decision()));
    expect(run.summary.baselines.cash.equityCurve.map((p) => p.date)).toEqual(["2024-01-31"]);
    expect(run.summary.baselines.cash.metrics.totalContributions).toBe(500);
    expect(run.summary.baselines.buyAndHold.metrics.daysRun).toBe(1);
    const empty = await runBatch(config({ endDate: "2024-01-02" }), agent(() => decision({ outcome: "provider_error" })));
    expect(empty.summary.baselines.buyAndHold.metrics.tradeCount).toBe(0); expect(empty.summary.baselines.cash.metrics.endingNetWorth).toBe(500);
  });

  test("rehashing failed-attempt usage or context does not evade semantic validation", async () => {
    const c = config({ endDate: "2024-01-02" });
    const run = await runBatch(c, agent(() => decision({ outcome: "provider_error", terminalReason: "failed" })));
    const path = join(run.dir, "attempts", "2024-01-02-000001.json");
    const original = JSON.parse(await readFile(path, "utf8"));
    const rehash = async (raw: Record<string, unknown>) => { const { integrityHash, ...body } = raw; await writeFile(path, JSON.stringify({ ...body, integrityHash: contentHash(body) })); };
    await rehash({ ...original, usage: { ...original.usage, promptTokens: 999 } });
    await expect(loadValidatedSummary(run.dir)).rejects.toThrow(/outcome\/usage mismatch/);
    await rehash({ ...original, contextHash: "f".repeat(64) });
    await expect(loadValidatedSummary(run.dir)).rejects.toThrow(/Attempt context mismatch|anchored attempt evidence/);
    await rehash({ ...original, outcome: "completed" });
    await expect(loadValidatedSummary(run.dir)).rejects.toThrow(/Invalid attempt artifact/);
  });

  test("rehashing a changed daily context does not evade replay validation", async () => {
    const run = await runBatch(config({ endDate: "2024-01-02" }), agent());
    const path = join(run.dir, "daily", "2024-01-02.json");
    const raw = JSON.parse(await readFile(path, "utf8")) as DailyRecord;
    await writeFile(path, JSON.stringify(sealRecord({ ...raw, contextHash: "f".repeat(64) })));
    await expect(loadValidatedSummary(run.dir)).rejects.toThrow(/ledger is inconsistent/);
  });

  test("malformed returned decisions preserve original rationale, trace and usage", async () => {
    const c = config({ endDate: "2024-01-02" });
    const original = decision({ rationale: 123 as any, trace: [{ providerEvidence: "retained" }], usage: { turns: 1, toolCalls: 0, failedToolCalls: 0, promptTokens: 100, completionTokens: 20, costUsd: 0.01 } });
    const run = await runBatch(c, agent(() => original));
    expect(run.summary.status).toBe("failed"); expect(run.summary.usageTotals.promptTokens).toBe(100); expect(run.summary.usageTotals.costUsd).toBe(0.01);
    const attempt = (await loadAttempts(run.dir))[0]!;
    expect(attempt.decision).toEqual(original); expect(attempt.failurePhase).toBe("validation");
    expect((await loadValidatedSummary(run.dir)).failedAttemptCount).toBe(1);
  });

  test("self-consistent but unrelated system prompts fail without losing provider evidence", async () => {
    const c = config({ endDate: "2024-01-02" });
    const run = await runBatch(c, agent((ctx) => {
      const d = initialDecision(ctx, c.model, "opencode");
      d.outcome = "completed"; d.rationale = "Hold."; d.effectiveSystemPrompt = "You are an unrelated coding assistant"; d.promptHash = textHash(d.effectiveSystemPrompt);
      Object.assign(d.trace[0] as object, { systemPrompt: d.effectiveSystemPrompt, promptHash: d.promptHash });
      d.usage.promptTokens = 100; d.usage.costUsd = 0.01;
      return d;
    }));
    expect(run.summary.status).toBe("failed"); expect(run.summary.usageTotals.promptTokens).toBe(100); expect(run.summary.usageTotals.costUsd).toBe(0.01);
    const attempt = (await loadAttempts(run.dir))[0]!;
    expect(attempt.reason).toMatch(/system prompt does not match/); expect(attempt.decision!.trace).toHaveLength(1);
    expect((await loadValidatedSummary(run.dir)).status).toBe("failed");
  });

  test("deleting sole or last failed attempt after successful retry is rejected", async () => {
    for (const failures of [1, 2]) {
      const c = config({ endDate: "2024-01-02" });
      let dir = "";
      for (let i = 0; i < failures; i++) dir = (await runBatch(c, agent(() => decision({ outcome: "provider_error", terminalReason: "retry" })))).dir;
      const success = await runBatch(c, agent());
      expect(success.summary.failedAttemptCount).toBe(failures);
      await rm(join(dir, "attempts", `2024-01-02-${String(failures).padStart(6, "0")}.json`));
      await expect(loadValidatedSummary(dir)).rejects.toThrow(/anchored attempt evidence/);
    }
  });

  test("resume cannot erase missing failed-state attempt evidence", async () => {
    const c = config({ endDate: "2024-01-02" });
    const run = await runBatch(c, agent(() => decision({ outcome: "provider_error", terminalReason: "retry" })));
    await rm(join(run.dir, "attempts"), { recursive: true });
    let calls = 0;
    await expect(runBatch(c, agent(() => { calls++; return decision(); }))).rejects.toThrow(/anchored attempt evidence/);
    expect(calls).toBe(0); expect((await loadRunState(run.dir))!.status).toBe("failed");
  });

  test("a durable failed-attempt orphan is adopted after crash before checkpoint anchoring", async () => {
    const c = config({ endDate: "2024-01-02" });
    const run = await runBatch(c, agent(() => decision({ outcome: "provider_error", terminalReason: "retry" })));
    const state = (await loadRunState(run.dir))!;
    state.attemptHashes = []; state.status = "active"; delete state.failure;
    await saveRunState(run.dir, state);
    const report = await loadValidatedSummary(run.dir);
    expect(report.status).toBe("failed"); expect((await loadRunState(run.dir))!.attemptHashes).toHaveLength(1);
    const success = await runBatch(c, agent());
    expect(success.summary.status).toBe("completed"); expect(success.summary.failedAttemptCount).toBe(1);
    expect((await loadDailyRecord(run.dir, "2024-01-02"))!.priorAttemptHashes).toHaveLength(1);
  });

  test("full benchmark survives a 99.5% first-day loss and still credits all later deposits", async () => {
    const dates = exchangeDates("2023-10-02", "2024-03-31");
    const prices = dates.map((date) => date < "2024-01-02" ? [100, 100] : date === "2024-01-02" ? [100, 0.5] : [0.5, 0.5]);
    const { dir, market } = await dataset(dates, [], prices, "2024-03-31");
    const c = config({ dataDir: dir, fixtureVersion: market.version, experiment: "three-month", warmupBars: 60, startDate: "2024-01-01", endDate: "2024-03-31", contributions: deposits });
    const run = await runBatch(c, agent((ctx) => decision({ orders: ctx.date === "2024-01-02" ? [{ ticker: "AAPL", side: "BUY", sizing: { kind: "units", units: 5 } }] : [] })));
    expect(run.summary.status).toBe("completed"); expect(run.summary.totalContributions).toBe(1500); expect(run.summary.finalPortfolio!.netWorth).toBe(1002.5);
    expect(run.summary.metrics.daysRun).toBe(exchangeDates("2024-01-01", "2024-03-31").length);
    expect((await loadDailyRecord(run.dir, "2024-01-02"))!.terminated).toBe(false);
  });

  test("checkpoint net worth cannot contradict its committed ledger", async () => {
    const c = config({ endDate: "2024-01-02" }); const run = await runBatch(c, agent());
    const state = (await loadRunState(run.dir))!; state.lastNetWorth = 999; await saveRunState(run.dir, state);
    await expect(loadValidatedSummary(run.dir)).rejects.toThrow(/checkpoint net worth is inconsistent/);
  });

  test("declared experiment horizons cannot change across resume", async () => {
    const c = config({ endDate: "2024-01-02", experiment: "smoke", warmupBars: 0 });
    await runBatch(c, agent());
    await expect(runBatch({ ...c, endDate: "2024-01-03" }, agent())).rejects.toThrow(/horizon is immutable/);
  });

  test("dataset omissions and wrong identity fail before inference", async () => {
    const { dir, market } = await dataset(["2024-01-02", "2024-01-03"]);
    let calls = 0; const spy = agent(() => { calls++; return decision(); });
    const c = config({ dataDir: dir, fixtureVersion: "wrong", startDate: "2024-01-02", endDate: "2024-01-03", warmupBars: 0 });
    await expect(runBatch(c, spy)).rejects.toThrow(/identity/);
    await expect(runBatch({ ...c, fixtureVersion: market.version, endDate: "2024-02-01" }, spy)).rejects.toThrow(/coverage/);
    await expect(runBatch({ ...c, fixtureVersion: market.version, warmupBars: 60 }, spy)).rejects.toThrow(/warmup/);
    expect(calls).toBe(0);
  });
});
