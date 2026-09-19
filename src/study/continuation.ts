import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { contentHash } from "../core/hash.ts";
import type { JournalEvent } from "./journal.ts";

// Explicit scheduling-only continuation authorization, separate from immutable
// manifests and model evidence. Never a general-purpose identity bypass.
export const CONTINUATION_FILE = "manual-quota-reset.json";
const changedFiles = new Set([
  "src/study/runner.ts", "src/study/availability.ts", "src/study/continuation.ts",
  "src/study/sandbox.ts", "scripts/sandbox/launch.sh", "src/study/model.ts", "src/pi/runtime.ts",
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
  // Trading, prompts, data, accounting, journal and model workers stay identical.
  // Reviewed runtime changes restore recorded executables/catalog from private pins.
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

export function runtimeMatches(saved: any, current: any, dir: string): boolean {
  if (contentHash(saved) === contentHash(current)) return true;
  const receipt = readContinuation(dir);
  if (!receipt || receipt.previousRuntimeHash !== contentHash(saved) ||
      receipt.continuedRuntimeHash !== contentHash(current)) return false;
  // Actual executables, catalog, model, workers, limits and isolation policy stay
  // identical. Only the launch script now executes the hash-pinned bwrap copy.
  const { id: oldId, ...oldIdentity } = saved;
  const { hashes: oldHashes, ...oldRest } = oldIdentity;
  const { id: newId, ...newIdentity } = current;
  const { hashes: newHashes, ...newRest } = newIdentity;
  const { ["scripts/sandbox/launch.sh"]: oldLaunch, ...oldFiles } = oldHashes;
  const { ["scripts/sandbox/launch.sh"]: newLaunch, ...newFiles } = newHashes;
  return contentHash(oldRest) === contentHash(newRest) && contentHash(oldFiles) === contentHash(newFiles) &&
    oldId === contentHash(oldIdentity) && newId === contentHash(newIdentity);
}
