import {
  openSync,
  closeSync,
  fsyncSync,
  writeSync,
  readFileSync,
  existsSync,
  mkdirSync,
  lstatSync,
  linkSync,
  unlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { contentHash } from "../core/hash.ts";
import type { OrderRequest } from "../domain/types.ts";
import { scopeFor, type SessionScope } from "./protocol.ts";
export interface JournalEntry {
  id: string;
  runId: string;
  date: string;
  attempt: number;
  text: string;
  tickers: string[];
  evidenceRefs: string[];
}
export interface Submission {
  id: string;
  providerCallId: string;
  orders: OrderRequest[];
  orderIds: string[];
  journal: JournalEntry;
  seenEvidenceRefs: string[];
}
export interface JournalEvent {
  sequence: number;
  previous: string;
  scope: SessionScope;
  recordedAt: string;
  kind: "begin" | "audit" | "submission" | "result" | "failed";
  payload: any;
  hash: string;
}
function writeAll(fd: number, text: string) {
  const bytes = Buffer.from(text);
  let offset = 0;
  while (offset < bytes.length) {
    const n = writeSync(fd, bytes, offset, bytes.length - offset);
    if (n <= 0) throw new Error("Incomplete durable write");
    offset += n;
  }
}
function syncDir(path: string) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
/** Atomic publication without replacement, including under concurrent writers. */
export function durableCreate(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const pending = `${path}.${randomUUID()}.pending`;
  const fd = openSync(pending, "wx", 0o600);
  try {
    writeAll(fd, JSON.stringify(value, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(pending, path);
    syncDir(dirname(path));
  } finally {
    unlinkSync(pending);
    syncDir(dirname(path));
  }
}
/** One append-only, fsynced hash chain. Daily commits are the authority for memory/state.
 * A truncated tail is refused, never silently repaired; keep it for forensic recovery. */
export class JournalStore {
  readonly path: string;
  private events: JournalEvent[] = [];
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, "events.jsonl");
    if (!existsSync(this.path)) return;
    if (!lstatSync(this.path).isFile() || lstatSync(this.path).isSymbolicLink())
      throw new Error("Invalid event file");
    const raw = readFileSync(this.path, "utf8");
    if (raw && !raw.endsWith("\n"))
      throw new Error("Incomplete event append; quarantine required");
    for (const line of raw.split("\n").filter(Boolean)) {
      const e = JSON.parse(line) as JournalEvent;
      const { hash, ...body } = e;
      if (
        e.sequence !== this.events.length + 1 ||
        e.previous !== this.root ||
        contentHash(body) !== hash
      )
        throw new Error("Event integrity failure");
      this.validate(e);
      this.events.push(e);
    }
  }
  get root() {
    return this.events.at(-1)?.hash ?? "0".repeat(64);
  }
  all() {
    return structuredClone(this.events);
  }
  matching(scope: SessionScope) {
    return structuredClone(
      this.events.filter((e) => contentHash(e.scope) === contentHash(scope)),
    );
  }
  nextAttempt(date: string) {
    return (
      1 +
      Math.max(
        0,
        ...this.events
          .filter((e) => e.scope.date === date)
          .map((e) => e.scope.attempt),
      )
    );
  }
  submission(scope: SessionScope): Submission | undefined {
    return this.matching(scope).find((e) => e.kind === "submission")?.payload;
  }
  entries(scope: SessionScope): JournalEntry[] {
    const s = this.submission(scope);
    return s ? [s.journal] : [];
  }
  trace(scope: SessionScope) {
    return this.matching(scope)
      .filter((e) => e.kind === "audit")
      .map((e) => e.payload);
  }
  begin(scope: SessionScope) {
    return this.add(scope, "begin", {});
  }
  audit(scope: SessionScope, event: unknown) {
    return this.add(scope, "audit", event);
  }
  submit(scope: SessionScope, submission: Submission) {
    const old = this.submission(scope);
    if (old) {
      if (contentHash(old) !== contentHash(submission))
        throw new Error("Conflicting second submission");
      return old;
    }
    this.add(scope, "submission", submission);
    return structuredClone(submission);
  }
  result(scope: SessionScope, payload: unknown) {
    return this.add(scope, "result", payload);
  }
  fail(scope: SessionScope, reason: string) {
    return this.add(scope, "failed", { reason });
  }
  private validate(e: JournalEvent) {
    if (
      contentHash(e.scope) !==
        contentHash(scopeFor(e.scope.runId, e.scope.date, e.scope.attempt)) ||
      !Number.isFinite(Date.parse(e.recordedAt))
    )
      throw new Error("Invalid event scope");
    const last = this.events.at(-1);
    if (last && last.scope.runId !== e.scope.runId)
      throw new Error("Foreign run event");
    if (e.kind === "begin") {
      if (
        e.scope.attempt !== this.nextAttempt(e.scope.date) ||
        (last &&
          (!["result", "failed"].includes(last.kind) ||
            e.scope.date < last.scope.date ||
            (last.kind === "failed" || last.payload.outcome !== "completed"
              ? e.scope.date !== last.scope.date
              : e.scope.date === last.scope.date)))
      )
        throw new Error("Invalid attempt sequence");
      return;
    }
    if (
      !last ||
      contentHash(last.scope) !== contentHash(e.scope) ||
      ["result", "failed"].includes(last.kind)
    )
      throw new Error("Attempt is closed");
    if (!["audit", "submission", "result", "failed"].includes(e.kind))
      throw new Error("Unknown event kind");
    if (
      e.kind === "submission" &&
      this.events.some(
        (x) =>
          x.kind === "submission" &&
          contentHash(x.scope) === contentHash(e.scope),
      )
    )
      throw new Error("Duplicate durable submission");
  }
  private add(
    scope: SessionScope,
    kind: JournalEvent["kind"],
    payload: unknown,
  ) {
    const body = {
      sequence: this.events.length + 1,
      previous: this.root,
      scope,
      recordedAt: new Date().toISOString(),
      kind,
      payload,
    };
    const event = { ...body, hash: contentHash(body) };
    this.validate(event);
    const fd = openSync(this.path, "a", 0o600);
    try {
      writeAll(fd, JSON.stringify(event) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    syncDir(this.dir);
    this.events.push(structuredClone(event));
    return structuredClone(event);
  }
}
