// Combined report: original quarters + original Q1 prefix + newly committed Q1 suffix. Read-only.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join, dirname } from "node:path";
// Reporting fixes may live separately; replay always imports the recorded engine from cwd.
const engine = resolve(process.cwd());
const { contentHash } = await import(join(engine, "src/core/hash.ts"));
const { runStudy } = await import(join(engine, "src/study/runner.ts"));
const { evaluationReport } = await import(join(engine, "src/study/evaluation.ts"));
const { computeMetrics } = await import(join(engine, "src/engine/metrics.ts"));
const { STARTING_CAPITAL } = await import(join(engine, "src/core/funding.ts"));
const [evalDir, segmentRunId, out] = process.argv.slice(2);
if (!evalDir || !segmentRunId) throw new Error("usage: combined-report ORIGINAL_EVAL_DIR SEGMENT_RUN_ID [OUT_PREFIX]");
const plan = JSON.parse(readFileSync(join(resolve(evalDir), "manifest.json"), "utf8")).plan;
const segmentManifest = JSON.parse(readFileSync(resolve("results/studies", segmentRunId, "manifest.json"), "utf8"));
const cp = segmentManifest.config.continuation;
const parentStudies = dirname(cp.parentDir);
if (!cp.parentAudit?.path || !cp.parentAudit?.sha256) throw new Error("Missing pinned original-run audit proof");
const proofBytes = readFileSync(cp.parentAudit.path);
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
if (sha256(proofBytes) !== cp.parentAudit.sha256) throw new Error("Original-run proof changed");
const proof = JSON.parse(proofBytes.toString());
if (proof.originalEvalDir !== resolve(evalDir) || proof.verification.quarters.some((q: any) => q.error))
  throw new Error("Original verification does not authenticate this evaluation");
for (const file of proof.files) {
  const bytes = readFileSync(file.path);
  if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error("Original artifact changed: " + file.path);
}
const days = (dir: string) => readdirSync(join(dir, "days")).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(join(dir, "days", f), "utf8")));
// Authenticates the segment (own days replay under this source) and, through it, the parent prefix.
const segment = await runStudy(segmentManifest.config, { readOnly: true });
const checks: string[] = [];
const quarters = plan.jobs.map((job: any) => {
  const isContinued = job.runId === cp.parentRunId;
  let all: any[], summary: any;
  if (isContinued) {
    all = segment.days;
    const inherited = all.slice(0, cp.dayDates.length), suffix = all.slice(cp.dayDates.length);
    if (contentHash(inherited.map((d) => d.hash)) !== contentHash(days(cp.parentDir).slice(0, cp.dayDates.length).map((d) => d.hash))) throw new Error("Inherited prefix differs from parent");
    if (suffix.length && contentHash(suffix[0].record.portfolioBefore) !== contentHash(cp.boundaryPortfolio)) throw new Error("Boundary portfolio discontinuity");
    if (suffix.length && suffix[0].previous !== cp.lastDayHash) throw new Error("Boundary day chain discontinuity");
    checks.push(`${job.label}: ${inherited.length} inherited + ${suffix.length} newly committed; boundary portfolio and day-chain exact`);
    summary = segment.summary;
  } else {
    all = days(join(parentStudies, job.runId));
    const verified = proof.verification.quarters.find((q: any) => q.runId === job.runId);
    if (!verified || verified.status !== "completed" || !verified.summary) throw new Error("Original quarter lacks completed verification");
    summary = verified.summary;
  }
  const records = all.map((d) => d.record);
  const funded = records.reduce((n: number, r: any) => n + (r.contribution ?? 0), 0);
  if (funded !== job.funding.reduce((n: number, f: any) => n + f.amount, 0)) throw new Error(`${job.label}: contribution total differs from plan (double/missing funding)`);
  const complete = all.length === job.sessions;
  return {
    runId: job.runId, model: job.model, label: job.label, start: job.start, end: job.end,
    status: complete ? "completed" : "incomplete", summary, error: null,
    metrics: records.length ? computeMetrics(records.map((r: any) => ({ date: r.date, netWorth: r.portfolioAfter.netWorth, contribution: r.contribution })), STARTING_CAPITAL, summary.fills, summary.rejectedOrders, 0, records.map((r: any) => r.turnoverPct)) : null,
  };
});
const recovery = cp.recovery ? {
  boundaryDate: cp.recovery.boundaryDate,
  supersededDays: cp.recovery.supersededDays,
  supersededAttempts: cp.recovery.supersededAttempts,
  disclosure: "Extra attempts: the recovered dates after the boundary were re-run from fresh attempts in a separately identified run. The original failed attempts and invalid days stay in the original cohort, which remains stopped/incomplete; they are superseded here, not refunded or rewritten.",
} : undefined;
const report = {
  kind: recovery ? "combined-recovery-supplemental" : "combined-continuation",
  reportingScript: { path: import.meta.path, sha256: sha256(readFileSync(import.meta.path)), engine },
  label: recovery
    ? "RECOVERED/SUPPLEMENTAL COMBINED REPORT: three original quarters + original Q1 prefix through the last valid day (original implementation) + separately run Q1 recovery days (recovery implementation, fresh attempts disclosed). Not a single unchanged implementation or attempt budget; the original annual cohort is NOT marked completed and its score is unchanged."
    : "COMBINED CONTINUATION REPORT: three original quarters + original Q1 prefix (original implementation) + newly committed Q1 suffix (continuation implementation). Not a single unchanged implementation; the original annual cohort is NOT marked completed.",
  ...(recovery ? { recovery } : {}),
  parentAuditSha256: cp.parentAudit.sha256,
  segmentRunId, checks, inherited: cp.dayDates.length, newlyCommitted: segment.days.length - cp.dayDates.length,
  segmentImplementation: segmentManifest.implementation.hash, segmentRevision: segmentManifest.repositoryRevision,
  parentImplementation: cp.parentImplementationHash, parentRevision: cp.parentRepositoryRevision,
  report: evaluationReport(plan, quarters),
};
const text = JSON.stringify(report, null, 2) + "\n";
if (out) writeFileSync(`${out}.json`, text); else console.log(text);
if (report.report.status !== "completed") process.exitCode = 3;
