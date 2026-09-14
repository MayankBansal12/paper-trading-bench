import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { exchangeDates } from "../src/data/calendar.ts";
import { contentHash } from "../src/core/hash.ts";
import { JournalStore, type JournalEntry } from "../src/study/journal.ts";
import { POLICY, openingContext } from "../src/study/protocol.ts";
import { readJournal } from "../src/study/retrieval.ts";
import { SessionTools } from "../src/study/tools.ts";
import { verifyToolEvidence } from "../src/study/verify.ts";
import { setup, data } from "./studyTestSupport.ts";

const dirs: string[] = [];
function make(past: JournalEntry[] = []) {
  const s = setup(past);
  dirs.push(s.dir);
  return s;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const dates = exchangeDates("2024-01-02", "2025-01-31");
function entry(i: number, overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: String(i), runId: "test", date: dates[i]!, attempt: 1,
    text: "AAPL: trim on weakness; sell on a failed reclaim.",
    tickers: [], evidenceRefs: [], ...overrides,
  };
}

test("journal AND keywords span nonadjacent prose and optional tags, case-insensitively", () => {
  const match = entry(0, { tags: ["phase-defensive", "rule-aapl-428"] });
  const s = make([
    match,
    entry(1, { text: "AAPL trim, hold cash." }),
    entry(2, { text: "MSFT: sell if weak.", tags: ["phase-defensive"] }),
  ]);
  expect(data(s.tools.call("journal", { query: "  AAPL\ttrim\nSELL  " })).entries).toEqual([match]);
  expect(data(s.tools.call("journal", { query: "TRIM defensive 428" })).entries).toEqual([match]);
  expect(data(s.tools.call("journal", { query: "AAPL missing" })).entries).toEqual([]);
  expect(data(s.tools.call("journal", { query: "phase-defensive", date: match.date })).entries).toEqual([match]);
  expect(s.tools.call("journal", { query: " \t\n " }).isError).toBe(true);
});

test("ticker and frozen company filters find prose-only mentions and combine with date/query", () => {
  const match = entry(0, { text: "Review $aapl. Trim after a failed reclaim.", tickers: ["MSFT"] });
  const declared = entry(1, { text: "Keep existing rule.", tickers: ["AAPL"] });
  const s = make([match, declared, entry(2, { text: "Avoid XAAPL, AAPLX, AAPL.B and AAPL-B." })]);
  expect(data(s.tools.call("journal", { ticker: "Apple Inc." })).entries).toEqual([declared, match]);
  expect(data(s.tools.call("journal", { ticker: "aapl", date: match.date, query: "reclaim TRIM" })).entries).toEqual([match]);
  expect(s.tools.call("journal", { ticker: "unavailable" }).isError).toBe(true);
  const rows = [entry(0, { text: "Momentum at BRK.B; trim $MU." }), entry(1, { text: "Momentum, BRK-B, BRKXB." })];
  expect(readJournal(rows, ["MU", "BRK.B", "BRK"], { tickers: ["MU"] }).entries).toEqual([rows[0]!]);
  expect(readJournal(rows, ["MU", "BRK.B", "BRK"], { tickers: ["BRK.B"] }).entries).toEqual([rows[0]!]);
  expect(readJournal(rows, ["MU", "BRK.B", "BRK"], { tickers: ["BRK"] }).entries).toEqual([]);
});

test("newest-first pages fill the text budget, return complete notes, and advance without duplicates", () => {
  const past = Array.from({ length: 14 }, (_, i) => entry(i, {
    text: ("AAPL rule " + i + ". ").padEnd(POLICY.maxEntryChars, "x"),
  }));
  const original = structuredClone(past);
  const s = make(past);
  const first = data(s.tools.call("journal", { ticker: "AAPL" }));
  expect(first.entries).toEqual(past.slice(-6).reverse());
  expect(first.nextCursor).toBe(6);
  const second = data(s.tools.call("journal", { ticker: "AAPL", cursor: first.nextCursor }));
  expect(second.entries).toEqual(past.slice(2, 8).reverse());
  expect(second.nextCursor).toBe(12);
  const last = data(s.tools.call("journal", { ticker: "AAPL", cursor: second.nextCursor }));
  expect(last.entries).toEqual(past.slice(0, 2).reverse());
  expect(last.nextCursor).toBeNull();
  const exhausted = data(s.tools.call("journal", { ticker: "AAPL", cursor: 99 }));
  expect(exhausted.entries).toEqual([]);
  expect(exhausted.nextCursor).toBeNull();
  expect(exhausted.matchingEntries).toBe(past.length);
  expect(exhausted.hint).toContain("cursor 0");
  expect(exhausted.availableIndex).toBeUndefined();
  expect(past).toEqual(original);
});

test("metadata-heavy pages respect the response bound and allow every note to be reached", () => {
  const past = Array.from({ length: 90 }, (_, i) => entry(i, {
    text: "短",
    evidenceRefs: Array.from({ length: 16 }, (_, j) => String(j).padEnd(160, "x")),
  }));
  const s = make(past);
  let cursor = 0;
  const seen: string[] = [];
  while (true) {
    const response = s.tools.call("journal", { cursor });
    expect(response.isError).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(POLICY.maxResponseBytes);
    const page = data(response);
    expect(page.entries.length).toBeGreaterThan(0);
    seen.push(...page.entries.map((e: JournalEntry) => e.id));
    if (page.nextCursor === null) break;
    expect(page.nextCursor).toBeGreaterThan(cursor);
    cursor = page.nextCursor;
  }
  expect(seen).toEqual([...past].reverse().map((e) => e.id));
});

test("zero matches give a bounded recent date/ticker index with prose mentions and retry guidance", () => {
  const past = Array.from({ length: 25 }, (_, i) =>
    entry(i, i === 24 ? { tags: ["rule-aapl-428"] } : {}));
  const s = make(past);
  const response = data(s.tools.call("journal", { query: "nonexistent", date: past[0]!.date, ticker: "MSFT" }));
  expect(response.entries).toEqual([]);
  expect(response.nextCursor).toBeNull();
  expect(response.availableIndex.entries).toEqual(
    past.slice(-20).reverse().map((e) => ({ date: e.date, tickers: ["AAPL"], tags: e.tags ?? [] })),
  );
  expect(response.availableIndex.entries[0]!.tags).toEqual(["rule-aapl-428"]);
  expect(response.availableIndex.totalEntries).toBe(25);
  expect(response.availableIndex.truncated).toBe(true);
  expect(response.hint).toContain("fewer keywords");
  const date = response.availableIndex.entries[0].date;
  expect(data(s.tools.call("journal", { date, ticker: "AAPL" })).entries).toEqual([past.at(-1)]);
  const fresh = make();
  expect(data(fresh.tools.call("journal", {})).availableIndex).toEqual({
    entries: [], totalEntries: 0, truncated: false,
  });
});

test("optional tag slugs validate before any durable submission and survive delivery, reload and replay", () => {
  const s = make();
  for (const tags of [["UPPER"], ["phase:defensive"], ["two words"], [""], ["-edge"], ["edge-"], ["two--hyphens"],
    ["duplicate", "duplicate"], ["x".repeat(49)], Array.from({ length: 9 }, (_, i) => "tag-" + i)]) {
    expect(s.tools.call("submit_day", { orders: [], journal: { text: "Hold.", tickers: [], tags } }).isError).toBe(true);
    expect(new JournalStore(s.dir).submission(s.scope)).toBeUndefined();
  }
  const tags = ["phase-defensive", "rule-aapl-428"];
  const request = { orders: [], journal: { text: "Keep the rule.", tickers: [], tags } };
  expect(s.tools.call("submit_day", request, "tagged-decision").isError).toBeUndefined();
  expect(s.tools.call("submit_day", request, "tagged-decision").isError).toBeUndefined();
  const persisted = new JournalStore(s.dir).submission(s.scope)!;
  expect(persisted.journal.tags).toEqual(tags);
  expect(() => verifyToolEvidence({
    decision: { trace: s.tools.trace, orders: [] },
    submission: persisted, journalEntries: [persisted.journal],
  } as any, s.view, [])).not.toThrow();
  tags.push("mutated");
  expect(s.tools.submission()!.journal.tags).toEqual(["phase-defensive", "rule-aapl-428"]);
  expect(s.tools.call("submit_day", request, "different-decision").isError).toBe(true);
  const next = setup([persisted.journal], "2025-02-04");
  dirs.push(next.dir);
  expect(data(next.tools.call("journal", { query: "rule 428" })).entries).toEqual([persisted.journal]);
  for (const optional of [{}, { tags: [] }]) {
    const legacy = make();
    expect(legacy.tools.call("submit_day", { orders: [], journal: { text: "Free prose.", tickers: [], ...optional } }).isError).toBeUndefined();
  }
});

test("opening context includes exactly the three latest original committed journals and hashes their metadata", () => {
  const past = Array.from({ length: 5 }, (_, i) => entry(i, { text: "Original " + i + ".\nExact next line.", tags: ["rule-" + i] }));
  const s = make(past);
  const context = openingContext(s.view, s.view.horizon, past);
  expect(context.data.recentJournals).toEqual(past.slice(-3).reverse());
  expect(context.data.committedJournalEntries).toBe(5);
  expect(context.receipt.resultHash).toBe(contentHash(context.data));
  expect(s.tools.prompt()).not.toContain(past[0]!.text);
  for (const note of past.slice(-3)) expect(s.tools.prompt()).toContain(note.text);
  expect(openingContext(s.view, s.view.horizon, []).data.recentJournals).toEqual([]);
  const changed = structuredClone(past);
  changed.at(-2)!.tags = ["changed"];
  expect(openingContext(s.view, s.view.horizon, changed).receipt.resultHash).not.toBe(context.receipt.resultHash);
});

test("fallback and preloads use the immutable committed prefix, excluding current failed-attempt notes", () => {
  const past = [entry(0)];
  const s = make(past);
  past[0]!.text = "mutated caller input";
  expect(s.tools.call("submit_day", {
    orders: [], journal: { text: "Failed private plan.", tickers: [], tags: ["failed-plan"] },
  }).isError).toBeUndefined();
  const retry = new SessionTools(s.view, s.store, [entry(0)], Date.now() + 10000);
  expect(data(retry.call("journal", { query: "failed-plan" })).availableIndex.entries).toEqual([
    { date: entry(0).date, tickers: ["AAPL"], tags: [] },
  ]);
  expect(retry.prompt()).not.toContain("Failed private plan.");
  expect(s.tools.prompt()).not.toContain("mutated caller input");
});
