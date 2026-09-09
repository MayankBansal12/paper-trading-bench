import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { runDailyFile, runTransactionsFile } from "../utils/paths.ts";
import { writeFileAtomic } from "../utils/fs.ts";
import type { AttemptRecord, DailyRecord, UsageStats } from "../domain/types.ts";

export const ARTIFACT_VERSION = "credible-accounting-v4";
export function textHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
export function contentHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function sealRecord(record: DailyRecord): DailyRecord {
  const { integrityHash: _, ...body } = record;
  return { ...body, integrityHash: contentHash(body) };
}
export function validateRecordEnvelope(record: DailyRecord, date: string): void {
  if (!record || record.artifactVersion !== ARTIFACT_VERSION || record.date !== date || record.outcome !== "completed" || record.boundedStop || !record.decision || !Array.isArray(record.priorAttemptHashes) || record.priorAttemptHashes.some((h) => !/^[a-f0-9]{64}$/.test(h)) || !/^[a-f0-9]{64}$/.test(record.contextHash ?? "") || !Array.isArray(record.fills) || !Array.isArray(record.failedOrders)) throw new Error(`Invalid or legacy daily artifact for ${date}`);
  if (sealRecord(record).integrityHash !== record.integrityHash) throw new Error(`Daily artifact integrity mismatch for ${date}`);
  validateUsage(record.usage);
}
export function validateUsage(usage: unknown): void {
  if (!usage || typeof usage !== "object") throw new Error("Invalid usage artifact");
  const values = usage as Record<string, unknown>;
  for (const key of ["turns", "toolCalls", "failedToolCalls", "promptTokens", "completionTokens"]) if (typeof values[key] !== "number") throw new Error(`Missing usage field ${key}`);
  for (const [key, value] of Object.entries(values)) if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (key !== "costUsd" && !Number.isSafeInteger(value))) throw new Error("Invalid usage counter");
}
export async function writeIfChanged(path: string, content: string): Promise<void> {
  try { if (await readFile(path, "utf8") === content) return; }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  await writeFileAtomic(path, content);
}
export async function writeDailyRecord(dir: string, record: DailyRecord): Promise<void> {
  validateRecordEnvelope(record, record.date);
  await writeFileAtomic(runDailyFile(dir, record.date), JSON.stringify(record, null, 2) + "\n");
}
export async function loadDailyRecord(dir: string, date: string): Promise<DailyRecord | null> {
  try {
    const record = JSON.parse(await readFile(runDailyFile(dir, date), "utf8")) as DailyRecord;
    validateRecordEnvelope(record, date);
    return record;
  } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; throw err; }
}
export async function writeTransactions(dir: string, records: readonly DailyRecord[]): Promise<void> {
  const lines = records.flatMap((r) => r.fills).map((f) => JSON.stringify(f));
  await writeIfChanged(runTransactionsFile(dir), lines.length ? lines.join("\n") + "\n" : "");
}
export async function loadAttempts(dir: string): Promise<AttemptRecord[]> {
  let files: string[];
  try { files = await readdir(join(dir, "attempts")); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; throw err; }
  const attempts: AttemptRecord[] = [];
  for (const file of files.filter((f) => f.endsWith(".json")).sort()) {
    const raw = JSON.parse(await readFile(join(dir, "attempts", file), "utf8"));
    const { integrityHash, ...body } = raw;
    if (integrityHash !== contentHash(body) || body.artifactVersion !== ARTIFACT_VERSION || file !== `${body.date}-${String(body.attempt).padStart(6, "0")}.json` || !/^[a-f0-9]{64}$/.test(body.contextHash ?? "") || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(body.date) || !Number.isSafeInteger(body.attempt) || body.attempt <= 0 || !["budget_cutoff", "provider_error", "harness_error"].includes(body.outcome)) throw new Error(`Invalid attempt artifact ${file}`);
    if (body.attempt !== attempts.filter((a) => a.date === body.date).length + 1) throw new Error(`Noncontiguous attempt sequence for ${body.date}`);
    validateUsage(body.usage);
    if (body.decision) {
      if (JSON.stringify(body.usage) !== JSON.stringify(decisionUsage(body.decision.usage))) throw new Error(`Attempt decision outcome/usage mismatch for ${file}`);
      if (body.failurePhase !== undefined) {
        if (!["validation", "execution"].includes(body.failurePhase) || body.outcome !== "harness_error" || typeof body.reason !== "string") throw new Error(`Invalid returned-decision failure for ${file}`);
      } else {
        const outcome = body.decision.outcome && body.decision.outcome !== "completed" ? body.decision.outcome : body.decision.boundedStop ? "budget_cutoff" : "harness_error";
        if (outcome !== body.outcome) throw new Error(`Attempt decision outcome/usage mismatch for ${file}`);
        if (body.decision.outcome === "completed" && !body.decision.boundedStop) throw new Error(`Successful decision in failed attempt ${file}`);
        const reason = body.decision.terminalReason ?? body.decision.boundedReason ?? `Decision ${body.decision.outcome ?? "budget_cutoff"} on ${body.date}`;
        if (reason !== body.reason) throw new Error(`Attempt decision reason mismatch for ${file}`);
      }
    } else if (body.failurePhase !== undefined || body.outcome !== "harness_error" || Object.values(body.usage).some((v) => v !== 0)) throw new Error(`Attempt without decision has fabricated provider usage: ${file}`);
    attempts.push(body as AttemptRecord);
  }
  return attempts;
}
export async function writeAttempt(dir: string, record: AttemptRecord): Promise<void> {
  validateUsage(record.usage);
  await writeFileAtomic(join(dir, "attempts", `${record.date}-${String(record.attempt).padStart(6, "0")}.json`), JSON.stringify({ ...record, integrityHash: contentHash(record) }, null, 2) + "\n");
}

/** Keep raw malformed decisions as evidence while accounting only valid counters. */
export function decisionUsage(raw: unknown): UsageStats {
  try { validateUsage(raw); return raw as UsageStats; }
  catch { return { turns: 0, toolCalls: 0, failedToolCalls: 0, promptTokens: 0, completionTokens: 0 }; }
}
