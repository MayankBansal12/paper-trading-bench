import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { runBatch } from "../src/run/orchestrator.ts";
import { deriveRunId, resolveRunDir, loadRunState } from "../src/run/state.ts";
import { acquireRunLock } from "../src/run/lock.ts";
import { loadDailyRecord } from "../src/run/persist.ts";
import { runConfigFile } from "../src/utils/paths.ts";
import { FakeAgent } from "../src/agent/fakeAgent.ts";
import { asOf, calendarDates, FIXTURE_VERSION } from "../src/data/ohlcv.ts";
import { computeIndicators } from "../src/data/indicators.ts";
import { createInitialPortfolio } from "../src/engine/portfolio.ts";
import { EXECUTION_CONVENTION } from "../src/engine/execution.ts";
import { AGENT_PROTOCOL_VERSION } from "../src/agent/protocolVersion.ts";
import { UNIVERSE_VERSION, UNIVERSE_V1 } from "../src/config/universe.ts";
import type { AgentDecision, AgentPort, DecisionContext, RunConfig } from "../src/domain/types.ts";

const LIMITS = { maxTurns: 8, maxToolCalls: 20, timeoutMs: 5000 };

function baseConfig(overrides: Partial<RunConfig>): RunConfig {
  return {
    model: "test-orchestrator",
    seed: 999,
    agent: "fake",
    startDate: null,
    endDate: null,
    startingCapital: 1000,
    universeVersion: UNIVERSE_VERSION,
    limits: LIMITS,
    executionConvention: EXECUTION_CONVENTION,
    fixtureVersion: FIXTURE_VERSION,
    protocolVersion: AGENT_PROTOCOL_VERSION,
    ...overrides,
  };
}

async function cleanRun(config: RunConfig): Promise<void> {
  const { dir } = resolveRunDir(config);
  await rm(dir, { recursive: true, force: true });
}

/** Wraps FakeAgent and counts decide() calls per date, so a test can prove a
 * date was (or wasn't) actually re-simulated. */
class CountingAgent implements AgentPort {
  readonly name = "counting-fake";
  private readonly inner = new FakeAgent();
  callsByDate = new Map<string, number>();
  async decide(ctx: DecisionContext): Promise<AgentDecision> {
    this.callsByDate.set(ctx.date, (this.callsByDate.get(ctx.date) ?? 0) + 1);
    return this.inner.decide(ctx);
  }
}

describe("run/orchestrator", () => {
  let dates: string[];

  beforeAll(async () => {
    dates = (await calendarDates(UNIVERSE_V1)).slice(0, 6); // 6 trading days
  });

  test("fresh batch produces one daily record per requested date and a matching equity curve", async () => {
    const config = baseConfig({ runId: "fresh", startDate: dates[0], endDate: dates[5] });
    await cleanRun(config);
    const { summary } = await runBatch(config, new FakeAgent());
    expect(summary.status === "completed" || summary.status === "terminated").toBe(true);
    expect(summary.equityCurve.length).toBe(dates.length);
    expect(summary.equityCurve.map((p) => p.date)).toEqual(dates);
    expect(summary.baselines.cash.equityCurve.length).toBe(dates.length);
    expect(summary.baselines.buyAndHold.equityCurve.length).toBe(dates.length);
    await cleanRun(config);
  });

  test("re-running an already-completed config is idempotent (identical summary, no re-simulation)", async () => {
    const config = baseConfig({ runId: "idempotent", startDate: dates[0], endDate: dates[3] });
    await cleanRun(config);
    const first = await runBatch(config, new FakeAgent());
    const second = await runBatch(config, new FakeAgent());
    expect(second.summary).toEqual(first.summary);
    await cleanRun(config);
  });

  test("a no-op rerun of a completed run touches NO artifact — not state.json, not transactions.jsonl, not summary.json", async () => {
    const config = baseConfig({ runId: "noop", startDate: dates[0], endDate: dates[1] });
    await cleanRun(config);
    await runBatch(config, new FakeAgent());
    const { dir } = resolveRunDir(config);
    const before = await loadRunState(dir);
    expect(before!.status).toBe("completed");

    const { runTransactionsFile, runSummaryFile } = await import("../src/utils/paths.ts");
    const { stat } = await import("node:fs/promises");
    const txnMtimeBefore = (await stat(runTransactionsFile(dir))).mtimeMs;
    const summaryMtimeBefore = (await stat(runSummaryFile(dir))).mtimeMs;

    await runBatch(config, new FakeAgent());
    const after = await loadRunState(dir);
    expect(after!.updatedAt).toBe(before!.updatedAt);
    expect(after).toEqual(before!);
    expect((await stat(runTransactionsFile(dir))).mtimeMs).toBe(txnMtimeBefore);
    expect((await stat(runSummaryFile(dir))).mtimeMs).toBe(summaryMtimeBefore);
    await cleanRun(config);
  });

  test("resumes a partially-completed run from the checkpoint instead of restarting", async () => {
    const partial = baseConfig({ runId: "resume", startDate: dates[0], endDate: dates[2] });
    await cleanRun(partial);
    const firstHalf = await runBatch(partial, new FakeAgent());
    expect(firstHalf.summary.equityCurve.length).toBe(3);

    // Same runId, extended end date: must continue from day 3 onward, not restart from day 0.
    const extended = baseConfig({ runId: "resume", startDate: dates[0], endDate: dates[5] });
    const fullRun = await runBatch(extended, new FakeAgent());
    expect(fullRun.summary.equityCurve.length).toBe(6);
    // The first 3 days' net worth must be untouched by the resume (proves no re-simulation).
    expect(fullRun.summary.equityCurve.slice(0, 3)).toEqual(firstHalf.summary.equityCurve);

    // config.json must reflect the extension, never left stale.
    const { dir } = resolveRunDir(extended);
    const storedConfig = JSON.parse(await readFile(runConfigFile(dir), "utf8")) as RunConfig;
    expect(storedConfig.endDate).toBe(dates[5]);
    await cleanRun(extended);
  });

  test("a crash-simulated stale summary after an endDate extension is repaired on the next invocation, not returned verbatim", async () => {
    const short = baseConfig({ runId: "stale-summary-repair", startDate: dates[0], endDate: dates[1] });
    await cleanRun(short);
    const firstHalf = await runBatch(short, new FakeAgent());
    expect(firstHalf.summary.equityCurve.length).toBe(2);
    const staleSummaryJson = JSON.stringify(firstHalf.summary, null, 2) + "\n";

    const extended = baseConfig({ runId: "stale-summary-repair", startDate: dates[0], endDate: dates[2] });
    const fullRun = await runBatch(extended, new FakeAgent());
    expect(fullRun.summary.equityCurve.length).toBe(3);
    expect(fullRun.summary.status).toBe("completed");

    // Simulate a crash between `state.status = "completed"` (already true on
    // disk, extended to 3 days) and the transactions.jsonl/summary.json
    // rewrite that's supposed to follow it: leave summary.json at its OLD,
    // shorter (2-day) content while state.json already reflects all 3 days.
    const { dir } = resolveRunDir(extended);
    const { runSummaryFile } = await import("../src/utils/paths.ts");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(runSummaryFile(dir), staleSummaryJson, "utf8");

    const resumed = await runBatch(extended, new FakeAgent());
    expect(resumed.summary.equityCurve.length).toBe(3); // repaired, not the stale 2-day summary
    expect(resumed.summary.equityCurve).toEqual(fullRun.summary.equityCurve);
    expect(resumed.summary.config.endDate).toBe(dates[2]);

    const onDisk = JSON.parse(await readFile(runSummaryFile(dir), "utf8")) as { equityCurve: unknown[] };
    expect(onDisk.equityCurve.length).toBe(3); // the on-disk artifact was actually rewritten, not just the return value
    await cleanRun(extended);
  });

  test("the TRUE no-op fast path (matching config/status/equity curve) still touches no artifact", async () => {
    const config = baseConfig({ runId: "noop-still-matches", startDate: dates[0], endDate: dates[1] });
    await cleanRun(config);
    await runBatch(config, new FakeAgent());
    const { dir } = resolveRunDir(config);
    const { runSummaryFile, runTransactionsFile } = await import("../src/utils/paths.ts");
    const { stat } = await import("node:fs/promises");
    const summaryMtimeBefore = (await stat(runSummaryFile(dir))).mtimeMs;
    const txnMtimeBefore = (await stat(runTransactionsFile(dir))).mtimeMs;

    await runBatch(config, new FakeAgent());
    expect((await stat(runSummaryFile(dir))).mtimeMs).toBe(summaryMtimeBefore);
    expect((await stat(runTransactionsFile(dir))).mtimeMs).toBe(txnMtimeBefore);
    await cleanRun(config);
  });

  test("a wholly invalid calendar range is rejected before any run-directory artifact (lock, config.json) is created", async () => {
    const config = baseConfig({ runId: "invalid-range-no-artifacts", startDate: "2030-01-01", endDate: "2030-01-02" });
    const { dir } = resolveRunDir(config);
    await cleanRun(config);
    await expect(runBatch(config, new FakeAgent())).rejects.toThrow(/No trading days between/);
    const { existsSync } = await import("node:fs");
    expect(existsSync(dir)).toBe(false);
  });

  test("shrinking or otherwise changing endDate on an existing run-id is rejected, not silently applied", async () => {
    const config = baseConfig({ runId: "shrink-guard", startDate: dates[0], endDate: dates[3] });
    await cleanRun(config);
    await runBatch(config, new FakeAgent());
    const shrunk = baseConfig({ runId: "shrink-guard", startDate: dates[0], endDate: dates[1] });
    await expect(runBatch(shrunk, new FakeAgent())).rejects.toThrow(/monotonic extension/);
    await cleanRun(config);
  });

  test("isolated state: two seeds for the same model never share a run directory", async () => {
    const a = baseConfig({ seed: 1, runId: "seed-a", startDate: dates[0], endDate: dates[1] });
    const b = baseConfig({ seed: 2, runId: "seed-b", startDate: dates[0], endDate: dates[1] });
    await cleanRun(a);
    await cleanRun(b);
    const ra = resolveRunDir(a);
    const rb = resolveRunDir(b);
    expect(ra.dir).not.toBe(rb.dir);
    await runBatch(a, new FakeAgent());
    await runBatch(b, new FakeAgent());
    const summaryA = await runBatch(a, new FakeAgent()); // idempotent re-run, should not touch b's dir
    expect(summaryA.dir).toBe(ra.dir);
    await cleanRun(a);
    await cleanRun(b);
  });

  test("mismatched config on an existing run directory fails loudly instead of corrupting state", async () => {
    const config = baseConfig({ runId: "guard", startDate: dates[0], endDate: dates[1] });
    await cleanRun(config);
    await runBatch(config, new FakeAgent());
    const incompatible = baseConfig({ runId: "guard", startingCapital: 5000, startDate: dates[0], endDate: dates[1] });
    await expect(runBatch(incompatible, new FakeAgent())).rejects.toThrow(/incompatible config/);
    await cleanRun(config);
  });

  test("a mismatched limits-only config is also rejected (limits are part of the canonical identity)", async () => {
    const config = baseConfig({ runId: "limits-guard", startDate: dates[0], endDate: dates[1] });
    await cleanRun(config);
    await runBatch(config, new FakeAgent());
    const differentLimits = baseConfig({
      runId: "limits-guard",
      startDate: dates[0],
      endDate: dates[1],
      limits: { maxTurns: 1, maxToolCalls: 1, timeoutMs: 1000 },
    });
    await expect(runBatch(differentLimits, new FakeAgent())).rejects.toThrow(/incompatible config/);
    await cleanRun(config);
  });

  test("deriveRunId's identity includes limits: two configs differing only in limits get different ids", () => {
    const a = baseConfig({ startDate: dates[0], endDate: dates[1] });
    const b = baseConfig({ startDate: dates[0], endDate: dates[1], limits: { maxTurns: 1, maxToolCalls: 1, timeoutMs: 1000 } });
    delete a.runId;
    delete b.runId;
    expect(deriveRunId(a)).not.toBe(deriveRunId(b));
  });

  test("deriveRunId's identity includes protocolVersion: a semantics-changing code bump can never resolve into an existing run's data", () => {
    const a = baseConfig({ startDate: dates[0], endDate: dates[1] });
    const b = baseConfig({ startDate: dates[0], endDate: dates[1], protocolVersion: "v99-different-protocol" });
    delete a.runId;
    delete b.runId;
    expect(deriveRunId(a)).not.toBe(deriveRunId(b));
  });

  test("a mismatched protocolVersion on an existing run directory is rejected instead of silently mixing semantics", async () => {
    const config = baseConfig({ runId: "protocol-guard", startDate: dates[0], endDate: dates[1] });
    await cleanRun(config);
    await runBatch(config, new FakeAgent());
    const differentProtocol = baseConfig({ runId: "protocol-guard", startDate: dates[0], endDate: dates[1], protocolVersion: "v99-different-protocol" });
    await expect(runBatch(differentProtocol, new FakeAgent())).rejects.toThrow(/incompatible config/);
    await cleanRun(config);
  });

  test("deriveRunId's identity includes executionConvention: the pre-fix (v1) cent-ledger config derives a different run id than the current (v2) one", () => {
    const current = baseConfig({ startDate: dates[0], endDate: dates[1] });
    const preFix = baseConfig({ startDate: dates[0], endDate: dates[1], executionConvention: "asof-before-D_exec-open-D_eod-close-D_v1" });
    delete current.runId;
    delete preFix.runId;
    expect(EXECUTION_CONVENTION).not.toBe("asof-before-D_exec-open-D_eod-close-D_v1"); // guards against this test going stale if the constant reverts
    expect(deriveRunId(current)).not.toBe(deriveRunId(preFix));
  });

  test("a pre-fix (v1) executionConvention config cannot resume into an explicit run directory written under the current (v2) convention", async () => {
    const config = baseConfig({ runId: "execconv-guard", startDate: dates[0], endDate: dates[1] });
    await cleanRun(config);
    await runBatch(config, new FakeAgent());
    const preFix = baseConfig({ runId: "execconv-guard", startDate: dates[0], endDate: dates[1], executionConvention: "asof-before-D_exec-open-D_eod-close-D_v1" });
    await expect(runBatch(preFix, new FakeAgent())).rejects.toThrow(/incompatible config/);
    await cleanRun(config);
  });

  test("an unsafe run-id (path traversal / absolute path) is rejected instead of resolving outside results/runs", () => {
    const config = baseConfig({ runId: "/tmp/paper-bench-escape", startDate: dates[0], endDate: dates[1] });
    expect(() => resolveRunDir(config)).toThrow(/Invalid --run-id/);

    const traversal = baseConfig({ runId: "../../etc", startDate: dates[0], endDate: dates[1] });
    expect(() => resolveRunDir(traversal)).toThrow(/Invalid --run-id/);
  });

  test("crash recovery: an orphan daily record (written but not yet committed to state) is adopted, not re-simulated", async () => {
    const config = baseConfig({ runId: "crash-recover", startDate: dates[0], endDate: dates[2] });
    await cleanRun(config);
    const counting = new CountingAgent();
    await runBatch(config, counting);
    expect(counting.callsByDate.get(dates[2]!)).toBe(1);

    // Simulate a crash between "daily/<date>.json written" and "state.json
    // committed": roll state.json back one day while leaving the daily
    // record for that day on disk untouched.
    const { dir } = resolveRunDir(config);
    const state = await loadRunState(dir);
    const orphanRecord = await loadDailyRecord(dir, dates[2]!);
    expect(orphanRecord).not.toBeNull();
    state!.completedDates = state!.completedDates.filter((d) => d !== dates[2]);
    state!.status = "active";
    const { saveRunState } = await import("../src/run/state.ts");
    await saveRunState(dir, state!);

    const resumed = await runBatch(config, counting);
    // The orphan day must be adopted as-is — the counting agent must NOT
    // have been invoked a second time for it.
    expect(counting.callsByDate.get(dates[2]!)).toBe(1);
    expect(resumed.summary.equityCurve.length).toBe(3);
    expect(resumed.summary.status).toBe("completed");
    await cleanRun(config);
  });

  test("two processes cannot write the same run directory concurrently", async () => {
    const config = baseConfig({ runId: "lock-guard", startDate: dates[0], endDate: dates[1] });
    await cleanRun(config);
    const { dir } = resolveRunDir(config);
    const release = await acquireRunLock(dir);
    await expect(runBatch(config, new FakeAgent())).rejects.toThrow(/locked by another process/);
    await release();
    // Lock released — a normal run now succeeds.
    const { summary } = await runBatch(config, new FakeAgent());
    expect(summary.status).toBe("completed");
    await cleanRun(config);
  });

  test("a tight tool-call budget produces a bounded stop that surfaces in run metrics", async () => {
    // Pick a date with 50+ bars of history so SMA50 is defined for the whole
    // universe, then independently compute how many crossover orders an
    // unbounded FakeAgent would place that day.
    const fullCalendar = await calendarDates(UNIVERSE_V1);
    const busyDate = fullCalendar[59]!;
    const indicators = Object.fromEntries(
      await Promise.all(UNIVERSE_V1.map(async (t) => [t, computeIndicators(await asOf(t, busyDate, 60))] as const)),
    );
    const unbounded = await new FakeAgent().decide({
      date: busyDate,
      universe: UNIVERSE_V1,
      portfolio: createInitialPortfolio(1000),
      bars: {},
      indicators,
      recentDays: [],
      limits: { maxTurns: 8, maxToolCalls: 1_000_000, timeoutMs: 5000 },
    });
    expect(unbounded.orders.length).toBeGreaterThan(1); // sanity: this date has multiple candidates

    const config = baseConfig({
      runId: "bounded",
      startDate: busyDate,
      endDate: busyDate,
      limits: { maxTurns: 8, maxToolCalls: 1, timeoutMs: 5000 },
    });
    await cleanRun(config);
    const { summary } = await runBatch(config, new FakeAgent());
    expect(summary.metrics.boundedStopCount).toBe(1);
    expect(summary.metrics.tradeCount).toBe(1);
    await cleanRun(config);
  });

  afterAll(async () => {
    await cleanRun(baseConfig({ runId: "fresh" }));
    await cleanRun(baseConfig({ runId: "idempotent" }));
    await cleanRun(baseConfig({ runId: "noop" }));
    await cleanRun(baseConfig({ runId: "resume" }));
    await cleanRun(baseConfig({ runId: "stale-summary-repair" }));
    await cleanRun(baseConfig({ runId: "noop-still-matches" }));
    await cleanRun(baseConfig({ runId: "invalid-range-no-artifacts" }));
    await cleanRun(baseConfig({ runId: "shrink-guard" }));
    await cleanRun(baseConfig({ seed: 1, runId: "seed-a" }));
    await cleanRun(baseConfig({ seed: 2, runId: "seed-b" }));
    await cleanRun(baseConfig({ runId: "guard" }));
    await cleanRun(baseConfig({ runId: "limits-guard" }));
    await cleanRun(baseConfig({ runId: "protocol-guard" }));
    await cleanRun(baseConfig({ runId: "crash-recover" }));
    await cleanRun(baseConfig({ runId: "lock-guard" }));
    await cleanRun(baseConfig({ runId: "bounded" }));
  });
});
