import { test, expect, afterEach, setDefaultTimeout } from "bun:test";
setDefaultTimeout(180_000);
import { rmSync, readFileSync, writeFileSync, readdirSync, appendFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { config } from "./studyTestSupport.ts";
import { runStudy, prepareStudyData } from "../src/study/runner.ts";
import { deterministicControl } from "../src/study/control.ts";
import { initialStudyDecision } from "../src/study/agent.ts";
import { contentHash } from "../src/core/hash.ts";
import { exportCheckpoint, CONTINUATION_VERSION, RECOVERY_VERSION } from "../src/study/segment.ts";
import { monthlyDeposits } from "../src/core/funding.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const dirOf = (id: string) => {
  const d = resolve("results/studies", id);
  dirs.push(d);
  return d;
};
const RANGE: [string, string] = ["2024-04-02", "2024-05-10"];
const FAILED = ["2024-04-29", "2024-04-30", "2024-05-01"]; // crosses the April->May deposit boundary
const stripRun = (v: any) => JSON.parse(JSON.stringify(v, (k, x) => (k === "runId" ? undefined : x)));
function scripted(failures: Array<[string, number]>, seen: Array<{ date: string; attempt: number; view: any; past: any }> = []) {
  return async (view: any, journal: any, past: any[]) => {
    seen.push({ date: view.scope.date, attempt: view.scope.attempt, view, past });
    if (failures.some(([d, a]) => d === view.scope.date && a === view.scope.attempt)) {
      const decision = initialStudyDecision(view);
      return { outcome: "harness_error", reason: "scripted failure", scope: view.scope, viewHash: contentHash(view), decision, journalEntries: [] } as any;
    }
    return deterministicControl(view, journal, past);
  };
}
/** Parent stopped by the consecutive-invalid guard: every attempt on the three FAILED dates fails. */
async function stoppedParent() {
  const cfg = await config(...RANGE);
  dirOf(cfg.runId);
  const dates = (await prepareStudyData(cfg)).dates;
  const result = await runStudy(cfg, { control: scripted(FAILED.flatMap((d) => [[d, 1], [d, 2]] as Array<[string, number]>)) });
  const boundary = dates[dates.indexOf(FAILED[0]!) - 1]!;
  return { cfg, dates, result, boundary, dir: resolve("results/studies", cfg.runId) };
}
const snapshot = (dir: string) => ({
  events: readFileSync(join(dir, "events.jsonl"), "utf8"),
  days: readdirSync(join(dir, "days")).map((f) => readFileSync(join(dir, "days", f), "utf8")),
});
const recoveryConfig = (cfg: any, dir: string, boundary: string) => {
  const c = { ...cfg, runId: cfg.runId + "-recovery", continuation: exportCheckpoint(dir, { note: "test", at: new Date().toISOString() }, boundary) };
  dirOf(c.runId);
  return c;
};

test("recovery restarts after the last valid day with fresh attempts and reproduces the uninterrupted run", async () => {
  const p = await stoppedParent();
  expect(p.result.summary).toMatchObject({ status: "invalid", stopped: true, invalidDays: 3 });
  const before = snapshot(p.dir);
  const offset = p.dates.indexOf(FAILED[0]!);
  const rec = recoveryConfig(p.cfg, p.dir, p.boundary);
  expect(rec.continuation).toMatchObject({ version: RECOVERY_VERSION, consecutiveInvalidDays: 0, carriedFailures: [] });
  expect(rec.continuation.dayDates).toEqual(p.dates.slice(0, offset));
  expect(rec.continuation.recovery.supersededDays.map((d: any) => d.date)).toEqual(FAILED);
  expect(rec.continuation.recovery.supersededAttempts.map((a: any) => [a.date, a.attempt])).toEqual(FAILED.flatMap((d) => [[d, 1], [d, 2]]));
  const seen: any[] = [], seenReference: any[] = [];
  const recovery = await runStudy(rec, { control: scripted([], seen) });
  const ref = { ...p.cfg, runId: p.cfg.runId + "-reference" };
  dirOf(ref.runId);
  const reference = await runStudy(ref, { control: scripted([], seenReference) });
  // Only dates after the boundary run, each from a fresh attempt 1; nothing is inherited from the failed attempts.
  expect(seen.map((s) => [s.date, s.attempt])).toEqual(p.dates.slice(offset).map((d) => [d, 1]));
  const refFirst = seenReference.find((s) => s.date === FAILED[0])!;
  expect(stripRun(seen[0].view)).toEqual(stripRun(refFirst.view));
  expect(stripRun(seen[0].past)).toEqual(stripRun(refFirst.past));
  // Ledger, boundary portfolio, deposits and chain continuity equal the uninterrupted run.
  expect(recovery.days.map((d) => d.record)).toEqual(reference.days.map((d) => d.record));
  expect(recovery.days[offset]!.record.portfolioBefore).toEqual(recovery.days[offset - 1]!.record.portfolioAfter);
  expect(recovery.days[offset]!.previous).toBe(recovery.days[offset - 1]!.hash);
  expect(recovery.summary.portfolio).toEqual(reference.summary.portfolio);
  const deposits = monthlyDeposits(p.dates).reduce((n, d) => n + d.amount, 0);
  expect(recovery.days.reduce((n, d) => n + (d.record.contribution ?? 0), 0)).toBe(deposits);
  // Disclosure: superseded parent attempts are labelled, never counted as this run's attempts.
  expect(recovery.summary).toMatchObject({ status: "completed", invalidDays: 0, retriedDays: 0 });
  expect((recovery.summary as any).continuation).toMatchObject({
    version: RECOVERY_VERSION, inheritedDays: offset, newlyCommittedDays: p.dates.length - offset,
    recovery: { boundaryDate: p.boundary, supersededDays: FAILED, supersededAttempts: 6 },
  });
  expect((recovery.summary as any).continuation.recovery.label).toMatch(/SUPPLEMENTAL RECOVERY/);
  // The parent is byte-identical and still scores as stopped/invalid on its own.
  expect(snapshot(p.dir)).toEqual(before);
  expect((await runStudy(p.cfg, { readOnly: true })).summary).toEqual(p.result.summary);
  // Read-only replay of the recovery is stable.
  expect((await runStudy(rec, { readOnly: true })).summary).toEqual(recovery.summary);
});

test("recovery still enforces attempt limits and the consecutive-invalid stop on its own days", async () => {
  const p = await stoppedParent();
  const rec = recoveryConfig(p.cfg, p.dir, p.boundary);
  const seen: any[] = [];
  const result = await runStudy(rec, { control: scripted(FAILED.flatMap((d) => [[d, 1], [d, 2]] as Array<[string, number]>), seen) });
  expect(seen.map((s) => [s.date, s.attempt])).toEqual(FAILED.flatMap((d) => [[d, 1], [d, 2]]));
  expect(result.summary).toMatchObject({ status: "invalid", stopped: true, invalidDays: 3, consecutiveInvalidDays: 3 });
  // Recovery invalid days cite only this run's own failures.
  const parentHashes = new Set(readFileSync(join(p.dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).hash));
  for (const d of result.days.filter((x) => x.status === "invalid")) {
    expect(d.failureEventHashes).toHaveLength(2);
    expect(d.failureEventHashes.some((h) => parentHashes.has(h))).toBe(false);
  }
});

test("recovery boundary and frozen parent are authenticated; tampering and dishonest boundaries are rejected", async () => {
  const p = await stoppedParent();
  const note = { note: "x", at: new Date().toISOString() };
  // Boundary must be the last valid day: an invalid day, or an earlier valid day (would discard a decision), is refused.
  expect(() => exportCheckpoint(p.dir, note, FAILED[0])).toThrow(/valid/);
  expect(() => exportCheckpoint(p.dir, note, p.dates[p.dates.indexOf(p.boundary) - 1])).toThrow(/committed decision/);
  const rec = recoveryConfig(p.cfg, p.dir, p.boundary);
  const control = { control: scripted([]) };
  const events = join(p.dir, "events.jsonl");
  const original = readFileSync(events, "utf8");
  // Later original progress (an appended event) breaks the frozen parent.
  appendFileSync(events, original.trim().split("\n").at(-1)! + "\n");
  await expect(runStudy(rec, control)).rejects.toThrow(/parent/i);
  writeFileSync(events, original);
  // A tampered superseded invalid day is rejected.
  const failedDay = join(p.dir, "days", `${FAILED[1]}.json`);
  const dayOriginal = readFileSync(failedDay, "utf8");
  writeFileSync(failedDay, dayOriginal.replace("scripted failure", "scripted fai1ure"));
  await expect(runStudy(rec, control)).rejects.toThrow(/parent|recovery/i);
  writeFileSync(failedDay, dayOriginal);
  // Hiding a superseded attempt, or relabelling a recovery as a plain continuation, is rejected.
  // (Each variant is its own run id: a rejected run may already hold a manifest for its config.)
  const variant = (suffix: string, continuation: any) => {
    const c = { ...rec, runId: rec.runId + suffix, continuation };
    dirOf(c.runId);
    return c;
  };
  const hidden = { ...rec.continuation, recovery: { ...rec.continuation.recovery, supersededAttempts: rec.continuation.recovery.supersededAttempts.slice(1) } };
  await expect(runStudy(variant("-hidden", hidden), control)).rejects.toThrow(/superseded/);
  await expect(runStudy(variant("-relabel", { ...rec.continuation, version: CONTINUATION_VERSION }), control)).rejects.toThrow(/recovery/);
  const { recovery: _, ...bare } = rec.continuation;
  await expect(runStudy(variant("-bare", bare), control)).rejects.toThrow(/version/);
  // Config drift beyond run id/continuation is rejected.
  await expect(runStudy({ ...variant("-drift", rec.continuation), history: 61 }, control)).rejects.toThrow();
  // Untampered parent still accepted.
  expect((await runStudy(rec, control)).summary.status).toBe("completed");
});
