import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { contentHash } from "../core/hash.ts";
import type { PortfolioState } from "../domain/types.ts";
import type { JournalEntry, JournalEvent } from "./journal.ts";

export const CONTINUATION_VERSION = "quarter-segment-continuation-v1";
/** Separately labelled supplemental recovery: restarts after the parent's last valid day; later original failures are disclosed, never carried or refunded. */
export const RECOVERY_VERSION = "quarter-segment-recovery-v1";
export interface RecoveryBoundary {
  boundaryDate: string;
  parentDayDates: string[];
  parentLastDayHash: string;
  parentEventCount: number;
  parentEventRoot: string;
  supersededDays: Array<{ date: string; status: string; reason: string; hash: string }>;
  supersededAttempts: Array<{ date: string; attempt: number; outcome: string; reason: string; hash: string }>;
}
/** Immutable pointer to an authenticated prefix of an original run. Parent files are only ever read. */
export interface ContinuationCheckpoint {
  version: typeof CONTINUATION_VERSION | typeof RECOVERY_VERSION;
  parentRunId: string;
  parentDir: string;
  parentManifestSha256: string;
  parentImplementationHash: string;
  parentRepositoryRevision: string;
  dayDates: string[];
  lastDayHash: string;
  eventCount: number;
  eventRoot: string;
  carriedFailures: Array<{ date: string; attempt: number; hash: string }>;
  boundaryPortfolio: PortfolioState;
  consecutiveInvalidDays: number;
  maxConsecutiveInvalidDays: number;
  recovery?: RecoveryBoundary;
  authorization: { note: string; at: string };
}
export interface ParentPrefix {
  days: any[];
  events: JournalEvent[];
  past: JournalEntry[];
  portfolio: PortfolioState;
  consecutiveInvalidDays: number;
  maxConsecutiveInvalidDays: number;
  carried: JournalEvent[];
  config: any;
}
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const ZERO = "0".repeat(64);
function readEvents(dir: string): JournalEvent[] {
  const raw = readFileSync(join(dir, "events.jsonl"), "utf8");
  if (raw && !raw.endsWith("\n")) throw new Error("Parent event log has an incomplete tail");
  const events: JournalEvent[] = [];
  for (const line of raw.split("\n").filter(Boolean)) {
    const e = JSON.parse(line) as JournalEvent;
    const { hash, ...body } = e;
    if (e.sequence !== events.length + 1 || e.previous !== (events.at(-1)?.hash ?? ZERO) || contentHash(body) !== hash)
      throw new Error("Parent event integrity failure");
    events.push(e);
  }
  return events;
}
const closedFailure = (e: JournalEvent) => e.kind === "failed" || (e.kind === "result" && e.payload.outcome !== "completed");
const supersededAttempts = (events: JournalEvent[]) => events.filter(closedFailure).map((e) => ({
  date: e.scope.date, attempt: e.scope.attempt, outcome: e.kind === "failed" ? "failed" : e.payload.outcome,
  reason: String(e.payload.reason ?? ""), hash: e.hash,
}));
/** Everything after the recovery boundary must be closed failures of later dates: no decision there is discarded. */
function recoverySuffix(events: JournalEvent[], days: any[], boundaryDate: string, previous: string) {
  const eventsAfter = events;
  if (events.some((e) => e.scope.date <= boundaryDate) || (events.length && !["result", "failed"].includes(events.at(-1)!.kind)))
    throw new Error("Recovery parent suffix is not a closed set of later attempts");
  if (eventsAfter.some((e) => e.kind === "submission" || (e.kind === "result" && e.payload.outcome === "completed")))
    throw new Error("Recovery parent has a committed decision after the boundary");
  for (const day of days) {
    const { hash, ...body } = day;
    if (day.previous !== previous || contentHash(body) !== hash || day.status !== "invalid" ||
        !day.failureEventHashes.length || day.failureEventHashes.some((h: string) => !eventsAfter.some((e) => e.hash === h && closedFailure(e))))
      throw new Error("Recovery parent day after the boundary is not an authenticated invalid day: " + day.date);
    previous = hash;
  }
  return {
    lastDayHash: previous,
    supersededDays: days.map((d) => ({ date: d.date, status: d.status, reason: String(d.reason ?? ""), hash: d.hash })),
    supersededAttempts: supersededAttempts(eventsAfter),
  };
}
/** Re-authenticates the parent prefix against the checkpoint; any drift or tamper throws. */
export function loadParentPrefix(cp: ContinuationCheckpoint): ParentPrefix {
  const recovery = cp.version === RECOVERY_VERSION ? cp.recovery : undefined;
  if (cp.version !== CONTINUATION_VERSION && !recovery) throw new Error("Unknown continuation version");
  if (cp.version === CONTINUATION_VERSION && cp.recovery) throw new Error("Continuation checkpoint cannot carry a recovery boundary");
  const manifestBytes = readFileSync(join(cp.parentDir, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString());
  if (sha(manifestBytes) !== cp.parentManifestSha256 || manifest.implementation?.hash !== cp.parentImplementationHash ||
      manifest.repositoryRevision !== cp.parentRepositoryRevision || manifest.config?.runId !== cp.parentRunId)
    throw new Error("Continuation parent manifest differs from checkpoint");
  const all = readEvents(cp.parentDir);
  // The parent must stay frozen: later original-worker progress may not coexist with the segment.
  if (all.length !== (recovery?.parentEventCount ?? cp.eventCount) || (all.at(-1)?.hash ?? ZERO) !== (recovery?.parentEventRoot ?? cp.eventRoot))
    throw new Error("Continuation parent events differ from checkpoint (parent must remain frozen)");
  const events = all.slice(0, cp.eventCount);
  if ((events.at(-1)?.hash ?? ZERO) !== cp.eventRoot) throw new Error("Continuation parent event prefix differs from checkpoint");
  const last = events.at(-1);
  if (last && !["result", "failed"].includes(last.kind)) throw new Error("Continuation checkpoint cuts an open attempt");
  const dayDir = join(cp.parentDir, "days");
  const files = existsSync(dayDir) ? readdirSync(dayDir).filter((f) => f.endsWith(".json")).sort() : [];
  const parentDates = recovery?.parentDayDates ?? cp.dayDates;
  if (files.length !== parentDates.length || parentDates.some((d, i) => files[i] !== `${d}.json`) || cp.dayDates.some((d, i) => parentDates[i] !== d))
    throw new Error("Continuation parent days differ from checkpoint");
  const days = cp.dayDates.map((d) => JSON.parse(readFileSync(join(dayDir, `${d}.json`), "utf8")));
  let previous = ZERO, streak = 0, maxStreak = 0;
  const past: JournalEntry[] = [];
  for (const [i, day] of days.entries()) {
    const { hash, ...body } = day;
    if (day.date !== cp.dayDates[i] || day.previous !== previous || contentHash(body) !== hash)
      throw new Error("Continuation parent day chain failure: " + day.date);
    const terminal = events.find((e) => e.hash === day.resultEventHash);
    if (!terminal || terminal.scope.date !== day.date) throw new Error("Continuation parent day lacks its result event");
    if (day.status === "completed") {
      const submission = events.find((e) => e.kind === "submission" && e.hash === day.submissionEventHash);
      if (!submission || contentHash(submission.scope) !== contentHash(terminal.scope)) throw new Error("Continuation parent submission mismatch");
      past.push(submission.payload.journal);
      streak = 0;
    } else {
      if (!day.failureEventHashes.length || day.failureEventHashes.some((h: string) => !events.some((e) => e.hash === h))) throw new Error("Continuation parent invalid day lacks failures");
      maxStreak = Math.max(maxStreak, ++streak);
    }
    previous = hash;
  }
  if (previous !== cp.lastDayHash) throw new Error("Continuation parent last-day hash differs");
  if (recovery) {
    if (days.at(-1)?.status !== "completed" || days.at(-1)?.date !== recovery.boundaryDate || cp.carriedFailures.length ||
        events.at(-1)?.kind !== "result" || events.at(-1)?.hash !== days.at(-1)?.resultEventHash)
      throw new Error("Recovery boundary must end exactly at the parent's last valid day");
    const later = parentDates.slice(cp.dayDates.length).map((d) => JSON.parse(readFileSync(join(dayDir, `${d}.json`), "utf8")));
    const suffix = recoverySuffix(all.slice(cp.eventCount), later, recovery.boundaryDate, previous);
    if (suffix.lastDayHash !== recovery.parentLastDayHash || contentHash(suffix.supersededDays) !== contentHash(recovery.supersededDays) ||
        contentHash(suffix.supersededAttempts) !== contentHash(recovery.supersededAttempts))
      throw new Error("Recovery superseded parent attempts differ from checkpoint");
  }
  const portfolio = days.at(-1)!.record.portfolioAfter as PortfolioState;
  if (contentHash(portfolio) !== contentHash(cp.boundaryPortfolio) || streak !== cp.consecutiveInvalidDays || maxStreak !== cp.maxConsecutiveInvalidDays)
    throw new Error("Continuation boundary state differs from checkpoint");
  const nextDate = cp.carriedFailures[0]?.date;
  const carried = nextDate ? events.filter((e) => e.scope.date === nextDate && closedFailure(e)) : [];
  if (contentHash(carried.map((e) => ({ date: e.scope.date, attempt: e.scope.attempt, hash: e.hash }))) !== contentHash(cp.carriedFailures))
    throw new Error("Continuation carried failures differ from checkpoint");
  if (nextDate && (events.some((e) => e.scope.date === nextDate && e.kind === "result" && e.payload.outcome === "completed") || days.some((d) => d.date === nextDate)))
    throw new Error("Continuation carried date is already committed");
  return { days, events, past, portfolio, consecutiveInvalidDays: streak, maxConsecutiveInvalidDays: maxStreak, carried, config: manifest.config };
}
/** Builds a checkpoint from the parent's current durable state (call only after its pinned-engine verification). */
export function exportCheckpoint(parentDir: string, authorization: ContinuationCheckpoint["authorization"], boundaryDate?: string): ContinuationCheckpoint {
  const manifestBytes = readFileSync(join(parentDir, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString());
  const events = readEvents(parentDir);
  const count = events.length;
  if (count && !["result", "failed"].includes(events[count - 1]!.kind)) throw new Error("Parent has an open attempt; refusing to trim it");
  const parentDays = readdirSync(join(parentDir, "days")).filter((f) => f.endsWith(".json")).sort()
    .map((f) => JSON.parse(readFileSync(join(parentDir, "days", f), "utf8")));
  const days = boundaryDate ? parentDays.filter((d) => d.date <= boundaryDate) : parentDays;
  const lastDay = days.at(-1);
  if (boundaryDate && (lastDay?.date !== boundaryDate || lastDay.status !== "completed"))
    throw new Error("Recovery boundary must be a committed valid parent day");
  const cut = boundaryDate ? events.findIndex((e) => e.hash === lastDay.resultEventHash) + 1 : count;
  if (boundaryDate && (cut === 0 || events.slice(cut).some((e) => e.scope.date <= boundaryDate)))
    throw new Error("Recovery boundary does not split the parent event chain cleanly");
  const prefix = events.slice(0, cut);
  const next = prefix.at(-1)?.scope.date;
  const carried = !boundaryDate && next && next > lastDay.date ? prefix.filter((e) => e.scope.date === next && closedFailure(e)) : [];
  let streak = 0, maxStreak = 0;
  for (const d of days) streak = d.status === "completed" ? 0 : (maxStreak = Math.max(maxStreak, streak + 1), streak + 1);
  const suffix = boundaryDate ? recoverySuffix(events.slice(cut), parentDays.slice(days.length), boundaryDate, lastDay.hash) : undefined;
  return {
    version: boundaryDate ? RECOVERY_VERSION : CONTINUATION_VERSION,
    parentRunId: manifest.config.runId,
    parentDir,
    parentManifestSha256: sha(manifestBytes),
    parentImplementationHash: manifest.implementation.hash,
    parentRepositoryRevision: manifest.repositoryRevision,
    dayDates: days.map((d) => d.date),
    lastDayHash: lastDay.hash,
    eventCount: prefix.length,
    eventRoot: prefix.at(-1)?.hash ?? ZERO,
    carriedFailures: carried.map((e) => ({ date: e.scope.date, attempt: e.scope.attempt, hash: e.hash })),
    boundaryPortfolio: lastDay.record.portfolioAfter,
    consecutiveInvalidDays: streak,
    maxConsecutiveInvalidDays: maxStreak,
    ...(suffix ? { recovery: {
      boundaryDate: boundaryDate!, parentDayDates: parentDays.map((d) => d.date), parentLastDayHash: suffix.lastDayHash,
      parentEventCount: count, parentEventRoot: events.at(-1)?.hash ?? ZERO,
      supersededDays: suffix.supersededDays, supersededAttempts: suffix.supersededAttempts,
    } } : {}),
    authorization,
  };
}
/** Zero-inference check that a checkpoint's authenticated parent fits this run's dates and configuration. */
export function continuationFits(parent: ParentPrefix, c: { kind: string; continuation?: unknown } & Record<string, unknown>, dates: string[]) {
  const offset = parent.days.length;
  return ["environment", "control"].includes(c.kind) && contentHash(parent.days.map((d) => d.date)) === contentHash(dates.slice(0, offset)) &&
    !(parent.carried.length && parent.carried[0]!.scope.date !== dates[offset]) &&
    contentHash({ ...parent.config, runId: 0, continuation: 0 }) === contentHash({ ...c, runId: 0, continuation: 0 });
}
