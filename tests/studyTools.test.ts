import { test, expect, afterEach } from "bun:test";
import { rmSync, readFileSync, writeFileSync } from "node:fs";
import { setup, payload, data } from "./studyTestSupport.ts";
import { JournalStore, type JournalEntry } from "../src/study/journal.ts";
import { SessionTools, toolDefinitions } from "../src/study/tools.ts";
import {
  dailyPrompt,
  openingContext,
  openingPortfolio,
  systemPrompt,
} from "../src/study/protocol.ts";
const dirs: string[] = [];
const make = (...args: Parameters<typeof setup>) => {
  const s = setup(...args);
  dirs.push(s.dir);
  return s;
};
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
test("exactly four tools; preloaded cash, funding, universe and original note", () => {
  const previous: JournalEntry = {
    id: "old",
    runId: "test",
    date: "2025-01-31",
    attempt: 1,
    text: "Apple thesis: original line one.\nKeep the exact second line.",
    tickers: ["AAPL"],
    evidenceRefs: [],
  };
  const s = make([previous]);
  expect(toolDefinitions.map((t) => t.name)).toEqual([
    "market_snapshot",
    "price_history",
    "journal",
    "submit_day",
  ]);
  const prompt = dailyPrompt(
    s.view,
    s.view.horizon.start,
    s.view.horizon.end,
    s.view.horizon.contributions,
    [previous],
  );
  expect(prompt).toContain(previous.text);
  expect(prompt).toContain('"eligibleTickers":["AAPL","MSFT"]');
  expect(prompt).toContain('"cash":500');
  expect(prompt).toContain('"amount":500');
  expect(systemPrompt(s.view.limits)).toContain("opening price is UNKNOWN");
});
test("submission is durable before acknowledgement, whole-batch validated and repeated delivery is idempotent", () => {
  const s = make(),
    p = payload([{ side: "BUY", ticker: "AAPL", notionalUsd: 200 }]);
  const result = s.tools.call("submit_day", p, "provider-real-call");
  expect(result.isError).toBeUndefined();
  const durable = new JournalStore(s.dir).submission(s.scope)!;
  expect(durable.providerCallId).toBe("provider-real-call");
  expect(durable.orderIds).toHaveLength(1);
  expect(s.view.portfolio.cash).toBe(500);
  expect(durable.orders).toHaveLength(1);
  expect(
    s.tools.call("submit_day", p, "provider-real-call").isError,
  ).toBeUndefined();
  expect(
    new JournalStore(s.dir).all().filter((e) => e.kind === "submission"),
  ).toHaveLength(1);
  expect(s.tools.call("submit_day", payload(), "different").isError).toBe(true);
  expect(s.tools.call("market_snapshot", {}).isError).toBe(true);
});
test("invalid/partial submissions persist no orders or journal, including mixed valid and invalid orders", () => {
  const s = make();
  for (const p of [
    { orders: [] },
    payload([
      { side: "BUY", ticker: "AAPL", units: 1 },
      { side: "BUY", ticker: "MSFT", units: 1, notionalUsd: 100 },
    ]),
    payload([{ side: "BUY", ticker: "FOREIGN", units: 1 }]),
    { orders: [], journal: { text: "  ", tickers: [] } },
    { orders: [], journal: { text: "x".repeat(2001), tickers: [] } },
    { orders: [], journal: { text: "hold", tickers: ["FOREIGN"] } },
  ]) {
    expect(s.tools.call("submit_day", p).isError).toBe(true);
    expect(s.tools.orders()).toEqual([]);
    expect(s.store.entries(s.scope)).toEqual([]);
  }
  expect(s.tools.call("submit_day", payload()).isError).toBeUndefined();
});
test("seen evidence includes every successful read and opening context; explicit citations stay separate", () => {
  const s = make();
  const response = s.tools.call("market_snapshot", { tickers: ["AAPL"] });
  const id = JSON.parse(response.content[0].text).receipt.id;
  s.tools.call("price_history", { tickers: ["AAPL", "MSFT"], lookback: 1 });
  expect(
    s.tools.call("submit_day", {
      ...payload(),
      journal: { text: "Cash reserve.", tickers: [], evidence_refs: [id] },
    }).isError,
  ).toBeUndefined();
  const submission = s.tools.submission()!;
  expect(submission.journal.evidenceRefs).toEqual([id]);
  expect(submission.seenEvidenceRefs).toHaveLength(4);
  expect(submission.seenEvidenceRefs).toContain(
    openingPortfolio(s.view).receipt.id,
  );
  expect(submission.seenEvidenceRefs).toContain(
    openingContext(s.view, s.view.horizon, []).receipt.id,
  );
});
test("forged, foreign and future evidence IDs rejected; citations optional including holds", () => {
  const s = make();
  for (const id of ["foreign:receipt", "2025-02-04:1:t1", "2025-01-31:1:t1"])
    expect(
      s.tools.call("submit_day", {
        orders: [],
        journal: { text: "Hold", tickers: [], evidence_refs: [id] },
      }).isError,
    ).toBe(true);
  expect(s.tools.call("submit_day", payload()).isError).toBeUndefined();
});
test("unlimited research calls; retained deadline and payload/history bounds", () => {
  const s = make();
  for (let i = 0; i < 80; i++)
    expect(s.tools.call("market_snapshot", {}).isError).toBeUndefined();
  expect(s.tools.boundedReason).toBeUndefined();
  for (const args of [
    { tickers: ["AAPL"], lookback: 253 },
    { tickers: ["AAPL"], lookback: 1, date: "2099-01-01" },
    { tickers: ["AAPL"], lookback: -1 },
    { tickers: ["AAPL"], lookback: 1.5 },
    { tickers: ["AAPL", "AAPL"], lookback: 1 },
  ])
    expect(s.tools.call("price_history", args).isError).toBe(true);
  const expired = new SessionTools(s.view, s.store, [], Date.now() - 1);
  expect(expired.call("submit_day", payload()).isError).toBe(true);
  expect(expired.boundedReason).toBeTruthy();
  expect(expired.orders()).toEqual([]);
});
test("unknown tools denied and permanently flagged as integrity failures", () => {
  const s = make();
  expect(s.tools.call("bash", { command: "date" }).isError).toBe(true);
  expect(s.tools.integrityError).toBe("Unknown tool");
  s.tools.revoke();
  expect(s.tools.call("submit_day", payload()).isError).toBe(true);
});
test("journal filters combine ticker aliases, exact dates and text, returning full notes with pagination", () => {
  const past: JournalEntry[] = [
    "2025-01-24",
    "2025-01-27",
    "2025-01-28",
    "2025-01-29",
    "2025-01-30",
    "2025-01-31",
  ].map((date, i) => ({
    id: String(i),
    runId: "test",
    date,
    attempt: 1,
    text: `Original thesis ${i}. Apple reassessment.`,
    tickers: ["AAPL"],
    evidenceRefs: [],
  }));
  const s = make(past);
  const first = data(
    s.tools.call("journal", { ticker: "Apple", query: "REASSESSMENT" }),
  );
  expect(first.entries).toEqual([...past].reverse());
  expect(first.nextCursor).toBeNull();
  expect(
    data(s.tools.call("journal", { ticker: "apple inc.", cursor: 4 })).entries,
  ).toEqual(past.slice(0, 2).reverse());
  expect(
    data(
      s.tools.call("journal", {
        ticker: "AAPL",
        date: "2025-01-29",
        query: "3",
      }),
    ).entries,
  ).toEqual([past[3]]);
  expect(
    data(s.tools.call("journal", { ticker: "Microsoft" })).entries,
  ).toEqual([]);
  expect(s.tools.call("journal", { date: s.scope.date }).isError).toBe(true);
  expect(s.tools.call("journal", { date: "2099-01-01" }).isError).toBe(true);
});
test("foreign/future journal input refused; current failed-attempt submissions never queried", () => {
  const s = make();
  for (const row of [
    { runId: "other", date: "2025-01-31" },
    { runId: "test", date: "2025-02-03" },
  ])
    expect(
      () =>
        new SessionTools(
          s.view,
          s.store,
          [
            {
              ...row,
              id: "x",
              attempt: 1,
              text: "untrusted",
              tickers: [],
              evidenceRefs: [],
            },
          ],
          Date.now() + 1000,
        ),
    ).toThrow();
  expect(data(s.tools.call("journal", {})).entries).toEqual([]);
});
test("event truncation and tampering refuse recovery instead of silently changing history", () => {
  const s = make();
  s.tools.call("submit_day", payload());
  const path = s.store.path,
    raw = readFileSync(path, "utf8");
  writeFileSync(path, raw.slice(0, -1));
  expect(() => new JournalStore(s.dir)).toThrow(/Incomplete/);
  writeFileSync(path, raw.replace("Hold cash", "Changed cash"));
  expect(() => new JournalStore(s.dir)).toThrow(/integrity/);
});
