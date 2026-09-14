import { expect, test } from "bun:test";
import { studyFunding, studySession } from "../src/report/studyView.ts";
import type { Day } from "../src/study/runner.ts";
import type { JournalEvent } from "../src/study/journal.ts";
import { HTML } from "../scripts/visualizer.ts";

function day(date: string, before: number, after: number, contribution = 0): Day {
  const portfolio = (netWorth: number) => ({ netWorth, cash: netWorth, holdings: {}, holdingsValue: 0 });
  return {
    date, previous: "", resultEventHash: "", submissionEventHash: "accepted",
    status: "completed", failureEventHashes: [], reason: null, hash: "",
    record: { artifactVersion: "v12", date, portfolioBefore: portfolio(before), portfolioAfter: portfolio(after),
      contribution, corporateActions: [], fills: [], failedOrders: [], turnoverPct: 0,
      terminated: false, boundedStop: false, boundedReason: null },
  };
}

test("deposits on invalid days count as principal and never as profit", () => {
  const deposit = { ...day("2025-05-01", 50000, 100000, 50000), status: "invalid" as const };
  const funding = studyFunding([day("2025-04-01", 50000, 50000), deposit]);
  expect(funding).toMatchObject({ startingCapital: 50000, totalPrincipal: 100000,
    netProfit: 0, returnOnPrincipalPct: 0, timeWeightedReturnPct: 0 });
  expect(funding.daily[1]).toMatchObject({ contribution: 50000, totalPrincipal: 100000, dailyProfit: 0 });
});

test("principal return and time-weighted return remain distinct with gains around a deposit", () => {
  const funding = studyFunding([day("2025-04-01", 50000, 55000), day("2025-05-01", 55000, 110000, 50000)]);
  expect(funding).toMatchObject({ totalPrincipal: 100000, netProfit: 10000, returnOnPrincipalPct: 10 });
  expect(funding.timeWeightedReturnPct).toBeCloseTo(15.2381, 4);
  expect(funding.daily[1]!.dailyProfit).toBe(5000);
});

test("historical capital is read from the ledger and an empty run does not invent it", () => {
  expect(studyFunding([day("2026-04-01", 500, 510), day("2026-05-01", 510, 1010, 500)]))
    .toMatchObject({ startingCapital: 500, totalPrincipal: 1000, netProfit: 10, returnOnPrincipalPct: 1 });
  expect(studyFunding([])).toMatchObject({ startingCapital: null, totalPrincipal: null,
    netProfit: null, returnOnPrincipalPct: null, timeWeightedReturnPct: null });
});

function event(sequence: number, attempt: number, kind: JournalEvent["kind"], payload: any, hash = String(sequence)): JournalEvent {
  return { sequence, previous: "", hash, recordedAt: new Date(sequence * 1000).toISOString(),
    scope: { protocol: "v12", runId: "test", date: "2025-04-01", observationDate: "2025-03-31", reportCutoff: "2025-04-01", attempt },
    kind, payload };
}

test("tool results pair within attempts even when event sequences differ and request IDs repeat", () => {
  const events = [
    event(1, 1, "begin", {}),
    event(2, 1, "audit", { type: "tool_attempt", name: "price_history", providerCallId: "first", arguments: { lookback: 10 } }),
    event(3, 1, "audit", { type: "tool_result", name: "price_history", result: { isError: true, content: [{ type: "text", text: "Too large" }] } }),
    event(4, 1, "audit", { type: "tool_attempt", name: "price_history", providerCallId: "unfinished", arguments: {} }),
    event(5, 1, "result", { outcome: "budget_cutoff", reason: "Timeout" }),
    event(6, 2, "begin", {}),
    event(7, 2, "audit", { type: "tool_attempt", name: "price_history", providerCallId: "second", arguments: { lookback: 5 } }),
    event(9, 2, "audit", { type: "tool_result", name: "price_history", result: { content: [{ type: "text", text: "bars" }] } }),
    event(10, 2, "audit", { type: "inference_request", sequence: 1, model: "muse" }),
    event(11, 2, "audit", { type: "inference_response", sequence: 1, status: 429 }),
    event(12, 2, "audit", { type: "inference_request", sequence: 2, model: "muse" }),
    event(13, 2, "audit", { type: "inference_response", sequence: 2, status: 200 }),
  ];
  const session = studySession("2025-04-01", undefined, events);
  expect(session.calls[0]).toMatchObject({ providerCallId: "first", ok: false, ms: 1000 });
  expect(session.calls[1]).toMatchObject({ providerCallId: "unfinished", ok: null, ms: null });
  expect(session.calls[2]).toMatchObject({ attempt: 2, providerCallId: "second", ok: true, ms: 2000 });
  expect(session.calls[3]).toMatchObject({ httpStatus: 429, ok: null, ms: null });
  expect(session.calls[4]).toMatchObject({ httpStatus: 200, ok: null, ms: null });
  expect(session.attempts[0]).toMatchObject({ outcome: "budget_cutoff", reason: "Timeout", accepted: false });
});

test("only the committed submission supplies the day journal; failed attempts remain inspectable", () => {
  const events = [
    event(1, 1, "submission", { orders: [], journal: { text: "Discarded" } }, "discarded"),
    event(2, 1, "result", { outcome: "harness_error", reason: "Audit mismatch" }),
    event(3, 2, "submission", { orders: [], journal: { text: "Committed", tags: ["hold"] } }, "accepted"),
    event(4, 2, "result", { outcome: "completed" }),
  ];
  const session = studySession("2025-04-01", day("2025-04-01", 50000, 50000), events);
  expect(session.journal.text).toBe("Committed");
  expect(session.attempts.map(a => a.accepted)).toEqual([false, true]);
  expect(session.attempts[0]!.submissions[0]!.journal.text).toBe("Discarded");
  const invalid = studySession("2025-04-01", { ...day("2025-04-01", 50000, 50000), status: "invalid", submissionEventHash: null }, events);
  expect(invalid.journal).toBeNull();
  expect(invalid.attempts.every(a => !a.accepted)).toBe(true);
});

test("uncommitted and unattempted sessions do not masquerade as holds or executions", () => {
  const events = [event(1, 1, "submission", { orders: [], journal: { text: "Pending" } })];
  expect(studySession("2025-04-01", undefined, events)).toMatchObject({ status: "uncommitted", journal: null, after: null, dailyProfit: null });
  expect(studySession("2025-04-02", undefined, events)).toMatchObject({ status: "unattempted", journal: null, after: null, attempts: [] });
});

test("emitted browser code parses, including inline call/detail rendering", () => {
  const script = HTML.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  expect(() => new Function(script)).not.toThrow();
});
