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
import { contentHash } from "../run/persist.ts";
import { POLICY, scopeFor, type SessionScope } from "./protocol.ts";
import { assertDecisionMemo, renderDecisionMemo, type DecisionMemo } from "./memo.ts";

export interface JournalEntry {
  id: string;
  runId: string;
  date: string;
  attempt: number;
  text: string;
  decision?: DecisionMemo;
  evidenceIds: string[];
  requestId: string;
  ordersHash: string;
}
export interface JournalEvent {
  sequence: number;
  previous: string;
  scope: SessionScope;
  recordedAt: string;
  kind: "begin" | "append" | "sealed" | "failed";
  entry?: JournalEntry;
  payloadHash?: string;
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
const equalScope = (a: SessionScope, b: SessionScope) =>
  contentHash(a) === contentHash(b);
const isHash = (s: unknown): s is string =>
  typeof s === "string" && /^[a-f0-9]{64}$/.test(s);

/** The model never receives this file or its directory. Only the trusted broker writes. */
export class JournalStore {
  readonly path: string;
  private events: JournalEvent[] = [];
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, "journal-events.jsonl");
    if (!existsSync(this.path)) return;
    if (!lstatSync(this.path).isFile() || lstatSync(this.path).isSymbolicLink())
      throw new Error("Invalid journal file");
    const raw = readFileSync(this.path, "utf8");
    if (raw && !raw.endsWith("\n"))
      throw new Error("Incomplete journal append; quarantine required");
    for (const line of raw.trim().split("\n").filter(Boolean)) {
      const event = JSON.parse(line) as JournalEvent;
      const { hash, ...body } = event;
      if (
        event.sequence !== this.events.length + 1 ||
        event.previous !== this.root ||
        contentHash(body) !== hash
      )
        throw new Error("Journal integrity failure");
      this.validate(event);
      this.events.push(event);
    }
  }
  get root() {
    return this.events.at(-1)?.hash ?? "0".repeat(64);
  }
  all() {
    return structuredClone(this.events);
  }
  nextAttempt(date: string) {
    return (
      Math.max(
        0,
        ...this.events
          .filter((e) => e.scope.date === date)
          .map((e) => e.scope.attempt),
      ) + 1
    );
  }
  private matching(scope: SessionScope) {
    return this.events.filter((e) => equalScope(e.scope, scope));
  }
  status(scope: SessionScope) {
    return this.matching(scope).at(-1)?.kind;
  }
  entries(scope: SessionScope) {
    return this.matching(scope)
      .filter((e) => e.kind === "append")
      .map((e) => structuredClone(e.entry!));
  }
  begin(scope: SessionScope) {
    this.add(scope, "begin");
  }

  append(
    scope: SessionScope,
    text: string,
    evidenceIds: string[],
    requestId: string,
    ordersHash = contentHash([]),
    decision?: DecisionMemo,
  ): JournalEntry {
    if (!["begin", "append"].includes(this.status(scope) ?? ""))
      throw new Error("Journal attempt is closed");
    const entries = this.entries(scope);
    const duplicate = entries.find((e) => e.requestId === requestId);
    if (duplicate) {
      if (
        duplicate.text !== text ||
        contentHash(duplicate.evidenceIds) !== contentHash(evidenceIds) ||
        duplicate.ordersHash !== ordersHash ||
        contentHash(duplicate.decision ?? null) !== contentHash(decision ?? null)
      )
        throw new Error("Conflicting journal request ID");
      return duplicate;
    }
    const entry: JournalEntry = {
      id: `${scope.date}:${scope.attempt}:j${entries.length + 1}`,
      runId: scope.runId,
      date: scope.date,
      attempt: scope.attempt,
      text,
      ...(decision ? { decision: structuredClone(decision) } : {}),
      evidenceIds: [...evidenceIds],
      requestId,
      ordersHash,
    };
    this.add(scope, "append", entry);
    return structuredClone(entry);
  }
  finish(scope: SessionScope, kind: "sealed" | "failed", payloadHash: string) {
    if (this.status(scope) === kind) {
      const e = this.matching(scope).at(-1)!;
      if (e.payloadHash !== payloadHash)
        throw new Error("Journal seal differs");
      return e.hash;
    }
    return this.add(scope, kind, undefined, payloadHash).hash;
  }
  private validate(e: JournalEvent) {
    const scope = e.scope;
    if (
      !equalScope(scope, scopeFor(scope.runId, scope.date, scope.attempt)) ||
      !Number.isFinite(Date.parse(e.recordedAt))
    )
      throw new Error("Invalid journal scope/timestamp");
    if (this.events.length && this.events[0]!.scope.runId !== scope.runId)
      throw new Error("Foreign journal scope");
    const last = this.events.at(-1);
    if (e.kind === "begin") {
      if (scope.attempt !== this.nextAttempt(scope.date))
        throw new Error("Noncontiguous journal attempt");
      if (
        last &&
        (!["sealed", "failed"].includes(last.kind) ||
          scope.date < last.scope.date ||
          (last.kind === "sealed"
            ? scope.date === last.scope.date
            : scope.date !== last.scope.date))
      )
        throw new Error("Prior attempt must finish before advancing/retrying");
      if (e.entry || e.payloadHash) throw new Error("Invalid begin event");
      return;
    }
    if (
      !last ||
      !equalScope(last.scope, scope) ||
      !["begin", "append"].includes(last.kind)
    )
      throw new Error("Cannot change journal terminal state");
    if (e.kind === "append") {
      const n = this.entries(scope).length;
      const v = e.entry;
      if (
        !v ||
        n >= POLICY.maxEntries ||
        v.id !== `${scope.date}:${scope.attempt}:j${n + 1}` ||
        v.date !== scope.date ||
        v.attempt !== scope.attempt ||
        v.runId !== scope.runId ||
        typeof v.text !== "string" ||
        !v.text.trim() ||
        v.text.length > POLICY.maxEntryChars ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(v.requestId) ||
        !Array.isArray(v.evidenceIds) ||
        v.evidenceIds.length > 16 ||
        v.evidenceIds.some((id) => typeof id !== "string" || id.length > 100) ||
        !isHash(v.ordersHash) ||
        this.entries(scope).some((old) => old.requestId === v.requestId) ||
        e.payloadHash
      )
        throw new Error("Invalid journal entry");
      if (v.decision !== undefined) assertDecisionMemo(v.decision);
    } else if (
      !["sealed", "failed"].includes(e.kind) ||
      !isHash(e.payloadHash) ||
      e.entry
    )
      throw new Error("Invalid journal seal");
  }
  private add(
    scope: SessionScope,
    kind: JournalEvent["kind"],
    entry?: JournalEntry,
    payloadHash?: string,
  ) {
    const body = {
      sequence: this.events.length + 1,
      previous: this.root,
      scope,
      recordedAt: new Date().toISOString(),
      kind,
      ...(entry ? { entry } : {}),
      ...(payloadHash ? { payloadHash } : {}),
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
    this.events.push(event);
    return event;
  }
  renderDay(scope: SessionScope) {
    if (this.status(scope) !== "sealed")
      throw new Error("Only a sealed day can be rendered");
    const text = this.entries(scope)
      .map(
        (e) =>
          `${e.id}\n${e.text}\n${e.decision ? renderDecisionMemo(e.decision) + "\n" : ""}Evidence IDs: ${e.evidenceIds.join(", ")}\nQueued orders hash: ${e.ordersHash}\n`,
      )
      .join("\n");
    const file = join(this.dir, "journal", `${scope.date}.txt`);
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) {
      if (
        lstatSync(file).isSymbolicLink() ||
        readFileSync(file, "utf8") !== text
      )
        throw new Error("Journal rendering differs");
      return;
    }
    const fd = openSync(file, "wx", 0o400);
    try {
      writeAll(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    syncDir(dirname(file));
  }
}
