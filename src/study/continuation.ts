import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { contentHash } from "../core/hash.ts";
import type { JournalEvent } from "./journal.ts";

// Explicit scheduling-only continuation authorization, separate from immutable
// manifests and model evidence. Never a general-purpose identity bypass.
export const CONTINUATION_FILE = "manual-quota-reset.json";
const changedFiles = new Set([
  "src/study/runner.ts", "src/study/availability.ts", "src/study/continuation.ts",
]);
export function readContinuation(dir: string): any | undefined {
  const path = join(dir, CONTINUATION_FILE);
  if (!existsSync(path)) return;
  const receipt = JSON.parse(readFileSync(path, "utf8"));
  if (receipt.version !== "manual-quota-reset-v1" ||
      receipt.authorization !== "user-confirmed-external-quota-reset" ||
      !Number.isFinite(Date.parse(receipt.authorizedAt)) ||
      !Array.isArray(receipt.failureHashes) ||
      receipt.failureHashes.some((h: unknown) => typeof h !== "string" || !/^[a-f0-9]{64}$/.test(h as string)))
    throw new Error("Invalid manual quota-reset receipt");
  return receipt;
}
export function implementationMatches(saved: any, current: any, dir: string, config: unknown): boolean {
  if (contentHash(saved) === contentHash(current)) return true;
  const r = readContinuation(dir);
  if (!r || r.configHash !== contentHash(config) ||
      r.previousImplementationHash !== saved.hash || r.continuedImplementationHash !== current.hash ||
      saved.hash !== contentHash(saved.hashes) || current.hash !== contentHash(current.hashes)) return false;
  // All trading, prompt, data, model, sandbox, accounting, and journal code stays
  // byte-identical. The reviewed runner delta only replaces this identity check.
  const files = new Set([...Object.keys(saved.hashes), ...Object.keys(current.hashes)]);
  for (const file of files)
    if (!changedFiles.has(file) && saved.hashes[file] !== current.hashes[file]) return false;
  return true;
}
export function quotaWasReset(dir: string, event: JournalEvent): boolean {
  const r = readContinuation(dir);
  return !!r && r.runId === event.scope.runId &&
    Date.parse(event.recordedAt) <= Date.parse(r.authorizedAt) &&
    r.failureHashes.includes(event.hash);
}
