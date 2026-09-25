import { test, expect, afterEach, setDefaultTimeout } from "bun:test";
setDefaultTimeout(180_000);
import { rmSync, readFileSync, writeFileSync, readdirSync, appendFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { config } from "./studyTestSupport.ts";
import { runStudy } from "../src/study/runner.ts";
import { deterministicControl } from "../src/study/control.ts";
import { initialStudyDecision } from "../src/study/agent.ts";
import { contentHash } from "../src/core/hash.ts";
import { exportCheckpoint } from "../src/study/segment.ts";
import { monthlyDeposits } from "../src/core/funding.ts";
import { prepareStudyData } from "../src/study/runner.ts";

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
const stripRun = (v: any) => JSON.parse(JSON.stringify(v, (k, x) => (k === "runId" ? undefined : x)));
/** Control that fails listed (date, attempt) pairs, records every view/past it is given. */
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
async function stoppedParent(failDate: string) {
  const cfg = await config(...RANGE);
  dirOf(cfg.runId);
  const dates = (await prepareStudyData(cfg)).dates;
  let halted = false;
  try {
    await runStudy(cfg, {
      control: scripted([[failDate, 1]]),
      fault: (phase, date) => {
        if (phase === "after-result" && date === failDate) {
          halted = true;
          throw new Error("halt after the failed attempt is durable");
        }
      },
    });
  } catch (e) {
    if (!halted) throw e;
  }
  return { cfg, dates, dir: resolve("results/studies", cfg.runId) };
}
const segmentConfig = (cfg: any, dir: string) => {
  const c = { ...cfg, runId: cfg.runId + "-segment", continuation: exportCheckpoint(dir, { note: "test", at: new Date().toISOString() }) };
  dirOf(c.runId);
  return c;
};

test("continuation reproduces the uninterrupted run: context, journal, boundary, funding, no rerun", async () => {
  const p = await stoppedParent("2024-05-01"); // crosses the April->May deposit boundary
  const failDate = "2024-05-01";
  const offset = p.dates.indexOf(failDate);
  expect(readdirSync(join(p.dir, "days")).length).toBe(offset);
  const parentBefore = { events: readFileSync(join(p.dir, "events.jsonl"), "utf8"), days: readdirSync(join(p.dir, "days")).map((f) => readFileSync(join(p.dir, "days", f), "utf8")) };
  const seenSegment: any[] = [], seenReference: any[] = [];
  const seg = segmentConfig(p.cfg, p.dir);
  const segment = await runStudy(seg, { control: scripted([], seenSegment) });
  // Reference: one uninterrupted run with the same single scripted failure.
  const ref = { ...p.cfg, runId: p.cfg.runId + "-reference" };
  dirOf(ref.runId);
  const reference = await runStudy(ref, { control: scripted([[failDate, 1]], seenReference) });
  // Only new days were exercised, starting with attempt 2 of the carried date.
  expect(seenSegment[0].date).toBe(failDate);
  expect(seenSegment[0].attempt).toBe(2);
  expect(seenSegment.filter((s) => s.date === failDate).length).toBe(1);
  expect(seenSegment.some((s) => p.dates.indexOf(s.date) < offset)).toBe(false);
  // First continuation view/past equal the reference's expected view/past (only the run id differs).
  const refFirst = seenReference.find((s) => s.date === failDate && s.attempt === 2);
  expect(stripRun(seenSegment[0].view)).toEqual(stripRun(refFirst.view));
  expect(stripRun(seenSegment[0].past)).toEqual(stripRun(refFirst.past));
  expect(seenSegment[0].past.length).toBe(offset);
  // Every continued day's ledger record equals the reference; boundary portfolio is exact.
  expect(segment.days.map((d) => d.record)).toEqual(reference.days.map((d) => d.record));
  expect(segment.days[offset]!.record.portfolioBefore).toEqual(segment.days[offset - 1]!.record.portfolioAfter);
  expect(segment.summary.portfolio).toEqual(reference.summary.portfolio);
  expect(segment.days[offset]!.previous).toBe(segment.days[offset - 1]!.hash);
  // Deposits counted exactly once across the inherited prefix and the new suffix.
  const deposits = monthlyDeposits(p.dates).reduce((n, d) => n + d.amount, 0);
  expect(segment.days.reduce((n, d) => n + (d.record.contribution ?? 0), 0)).toBe(deposits);
  // Summary labels inherited vs newly committed days.
  expect((segment.summary as any).continuation).toMatchObject({ inheritedDays: offset, newlyCommittedDays: p.dates.length - offset, totalDays: p.dates.length });
  expect(readdirSync(join(seg.runId ? resolve("results/studies", seg.runId) : "", "days")).length).toBe(p.dates.length - offset);
  // Parent evidence is byte-identical afterwards.
  expect(readFileSync(join(p.dir, "events.jsonl"), "utf8")).toBe(parentBefore.events);
  expect(readdirSync(join(p.dir, "days")).map((f) => readFileSync(join(p.dir, "days", f), "utf8"))).toEqual(parentBefore.days);
  // Read-only replay of the finished segment succeeds and is stable.
  expect((await runStudy(seg, { readOnly: true })).summary).toEqual(segment.summary);
});

test("cumulative attempt limit: the parent's failure counts, one new attempt only, then invalid day with both failures", async () => {
  const p = await stoppedParent("2024-04-10");
  const seg = segmentConfig(p.cfg, p.dir);
  const seen: any[] = [];
  const result = await runStudy(seg, { control: scripted([["2024-04-10", 2]], seen) });
  expect(seen.filter((s) => s.date === "2024-04-10").map((s) => s.attempt)).toEqual([2]);
  const day = result.days.find((d) => d.date === "2024-04-10")!;
  expect(day.status).toBe("invalid");
  expect(day.failureEventHashes.length).toBe(2);
  const parentFailure = readFileSync(join(p.dir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.kind === "result" && e.payload.outcome !== "completed");
  expect(day.failureEventHashes[0]).toBe(parentFailure.hash);
  expect(result.summary.invalidDays).toBe(1);
  expect((result.summary as any).continuation.inheritedDays).toBe(p.dates.indexOf("2024-04-10"));
});

test("frozen-parent tampering, drift and config mismatch are rejected", async () => {
  const p = await stoppedParent("2024-04-15");
  const seg = segmentConfig(p.cfg, p.dir);
  const control = { control: scripted([]) };
  // Later parent progress (any appended event) breaks the frozen prefix.
  const events = join(p.dir, "events.jsonl");
  const original = readFileSync(events, "utf8");
  const days = readdirSync(join(p.dir, "days"));
  const day0 = join(p.dir, "days", days[0]!);
  const dayOriginal = readFileSync(day0, "utf8");
  // 1. tampered day content
  writeFileSync(day0, dayOriginal.replace('"status": "completed"', '"status": "invalid"'));
  await expect(runStudy(seg, control)).rejects.toThrow(/parent/i);
  writeFileSync(day0, dayOriginal);
  // 2. extra parent day file
  writeFileSync(join(p.dir, "days", "2099-01-01.json"), "{}");
  await expect(runStudy(seg, control)).rejects.toThrow(/parent/i);
  rmSync(join(p.dir, "days", "2099-01-01.json"));
  // 3. tampered event chain
  writeFileSync(events, original.replace("scripted failure", "scripted fai1ure"));
  await expect(runStudy(seg, control)).rejects.toThrow(/parent/i);
  writeFileSync(events, original);
  // 4. later original-worker progress
  const lastLine = original.trim().split("\n").at(-1)!;
  appendFileSync(events, lastLine + "\n");
  await expect(runStudy(seg, control)).rejects.toThrow(/parent/i);
  writeFileSync(events, original);
  // 5. segment config differing from the parent beyond run id/continuation
  await expect(runStudy({ ...seg, history: 61 }, control)).rejects.toThrow();
  // Untampered parent still accepted after restoration.
  expect((await runStudy(seg, control)).summary.status).toBe("completed");
});

test("export refuses an open tail instead of trimming a consumed attempt", async () => {
  const cfg = await config(...RANGE);
  dirOf(cfg.runId);
  await expect(runStudy(cfg, { control: async () => { throw new Error("abort mid-attempt"); } })).rejects.toThrow();
  expect(() => exportCheckpoint(resolve("results/studies", cfg.runId), { note: "x", at: new Date().toISOString() })).toThrow();
});

test("inherited-run authorization is exact, scoped to the segment run, and removed afterwards", async () => {
  const { setup } = await import("./studyTestSupport.ts");
  const { registerInheritedRun, unregisterInheritedRun, SessionTools } = await import("../src/study/tools.ts");
  const entry = (runId: string, date: string) => ({ id: `${date}:1:submission:journal`, runId, date, attempt: 1, text: "original note text", tickers: [], evidenceRefs: [] }) as any;
  const base = setup([], "2025-02-03");
  const make = (past: any[]) => new SessionTools(base.view, base.store, past, Date.now() + 10_000);
  const parentNote = entry("parent-run", "2025-01-30");
  // Without registration the parent's note is foreign.
  expect(() => make([parentNote])).toThrow(/Foreign/);
  registerInheritedRun(base.view.scope.runId, "parent-run");
  const tools = make([parentNote]);
  // The note is presented verbatim (metadata and text are not remapped).
  expect(JSON.stringify(tools.prompt())).toContain("original note text");
  expect(parentNote.runId).toBe("parent-run");
  // A third/foreign run's note is still rejected, as is a future-dated inherited note.
  expect(() => make([entry("other-run", "2025-01-30")])).toThrow(/Foreign/);
  expect(() => make([entry("parent-run", "2025-02-03")])).toThrow(/Foreign/);
  // Authorization names exactly one parent run, and is removed after the run.
  registerInheritedRun(base.view.scope.runId, "someone-else");
  expect(() => make([parentNote])).toThrow(/Foreign/);
  unregisterInheritedRun(base.view.scope.runId);
  expect(() => make([parentNote])).toThrow(/Foreign/);
});
