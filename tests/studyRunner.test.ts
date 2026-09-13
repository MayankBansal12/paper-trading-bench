import { test, expect, afterEach } from "bun:test";
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadDataset } from "../src/data/dataset.ts";
import { initialStudyDecision } from "../src/study/agent.ts";
import { contentHash } from "../src/run/persist.ts";
import {
  STUDY_PROTOCOL,
  POLICY,
  type SessionView,
  openingPortfolio,
  dailyPrompt,
} from "../src/study/protocol.ts";
import { JournalStore, type JournalEntry } from "../src/study/journal.ts";
import { SessionTools } from "../src/study/tools.ts";
import { runStudy, validateOpeningContext, type StudyConfig } from "../src/study/runner.ts";
import type { StudyAttempt } from "../src/study/agent.ts";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
async function config(end = "2024-04-03"): Promise<StudyConfig> {
  const dataset = await loadDataset();
  const runId = "test-study-" + randomUUID();
  dirs.push(resolve("results/studies", runId));
  return {
    protocol: STUDY_PROTOCOL,
    kind: "control",
    runId,
    dataDir: resolve("fixtures/ohlcv"),
    datasetHash: dataset.version,
    universeVersion: "v1",
    start: "2024-04-02",
    end,
    history: 60,
    limits: { maxTurns: null, maxToolCalls: 24, timeoutMs: 10000 },
    policy: POLICY,
  };
}
async function control(
  view: SessionView,
  journal: JournalStore,
  past: JournalEntry[],
): Promise<StudyAttempt> {
  const tools = new SessionTools(view, journal, past, Date.now() + 10000);
  const observed = tools.call("get_price", { ticker: "AAPL" });
  if (!past.length) tools.call("buy", { ticker: "AAPL", notionalUsd: 200 });
  else tools.call("journal_search", { query: "control" });
  tools.call("journal_append", {
    text: "Deterministic control: hold or buy, for engine qualification only.",
    decision: {
      thesis: "Mechanical control to validate journal and order replay.",
      evidence: [{ claim: "The eligible prior close is available.", receiptIds: [JSON.parse(observed.content[0].text).receipt.id] }],
      allocation: "Fixed control sizing, remaining funds stay in cash.",
      alternatives: "No strategy optimization; this is an engine control.",
      risks: "Unknown opening fill price and price changes.",
      invalidation: "Stop if eligible data or accounting validation fails.",
      continuity: past.length ? "Continue the same mechanical control." : "First session; no prior thesis.",
    },
    requestId: "final",
  });
  const decision = initialStudyDecision(view);
  decision.outcome = "completed";
  decision.orders = tools.orders();
  decision.submittedOrders = tools.orders();
  decision.rationale = "Deterministic control";
  decision.trace = tools.trace;
  return {
    outcome: "completed",
    scope: view.scope,
    viewHash: contentHash(view),
    decision,
    journalEntries: journal.entries(view.scope),
  };
}
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));

test("deterministic multi-day control replays byte-for-byte without inference or duplicate fills", async () => {
  const c = await config();
  const first = await runStudy(c, { control });
  expect(first.summary.status).toBe("completed");
  expect(first.summary.metrics.tradeCount).toBe(1);
  expect(first.summary.journal.entries).toBe(2);
  const review = readFileSync(join(first.dir, "journal-review.md"), "utf8");
  expect(review).toContain("Invalidation / next review:");
  expect(review).toContain("Actual execution after the memo");
  expect(review).toContain("Filled BUY AAPL");
  expect(first.summary.behavior.days[0]?.evidenceClaims).toBe(1);
  const before = readFileSync(
    join(first.dir, "daily", "2024-04-02.json"),
    "utf8",
  );
  const replay = await runStudy(c, { readOnly: true });
  expect(replay.summary).toEqual(first.summary);
  const resumed = await runStudy(c, {
    control: async () => {
      throw new Error("Must never query again");
    },
  });
  expect(resumed.summary.metrics).toEqual(first.summary.metrics);
  expect(
    readFileSync(join(first.dir, "daily", "2024-04-02.json"), "utf8"),
  ).toBe(before);
});
test("interrupted acknowledged journal survives and is excluded from retry memory", async () => {
  const c = await config("2024-04-02");
  await expect(
    runStudy(c, {
      control: async (view, journal) => {
        journal.append(view.scope, "abandoned", [], "acknowledged");
        throw new Error("simulated crash");
      },
    }),
  ).rejects.toThrow();
  // The acknowledged entry stays in evaluator history, outside retry memory.
  const result = await runStudy(c, {
    control: async (view, journal, past) => {
      expect(past).toEqual([]);
      expect(view.scope.attempt).toBe(2);
      return control(view, journal, past);
    },
  });
  expect(result.summary.operational).toMatchObject({ attempts: 2, failed: 1 });
  expect(result.summary.metrics.tradeCount).toBe(1);
});
test("successful result survives crash before accepted publication and executes once", async () => {
  const c = await config("2024-04-02");
  const first = await runStudy(c, { control });
  const ledger = join(first.dir, "journal-events.jsonl");
  const lines = readFileSync(ledger, "utf8").trim().split("\n");
  lines.pop();
  writeFileSync(ledger, lines.join("\n") + "\n");
  for (const part of ["accepted", "daily", "journal"])
    rmSync(join(first.dir, part), { recursive: true });
  const recovered = await runStudy(c, {
    control: async () => {
      throw new Error("No second decision allowed");
    },
  });
  expect(recovered.summary.operational.attempts).toBe(1);
  expect(recovered.summary.metrics).toEqual(first.summary.metrics);
});
test("accepted decision survives missing daily commit without another decision", async () => {
  const c = await config("2024-04-02");
  const first = await runStudy(c, { control });
  rmSync(join(first.dir, "daily"), { recursive: true });
  await expect(runStudy(c, { readOnly: true })).rejects.toThrow(
    "not committed",
  );
  const recovered = await runStudy(c, {
    control: async () => {
      throw new Error("No new decision");
    },
  });
  expect(recovered.summary.metrics).toEqual(first.summary.metrics);
});
test("orders added after the final journal note fail closed", async () => {
  const c = await config("2024-04-02");
  const r = await runStudy(c, {
    control: async (v, j, p) => {
      const a = await control(v, j, p);
      a.decision.orders.push({
        ticker: "AAPL",
        side: "BUY",
        sizing: { kind: "units", units: 1 },
      });
      return a;
    },
  });
  expect(r.summary.status).toBe("incomplete");
  expect(r.summary.metrics.tradeCount).toBe(0);
  expect(r.summary.failure).toContain("journal");
  expect(existsSync(join(r.dir, "accepted", "2024-04-02.json"))).toBe(false);
});
test("rehashing a fabricated price receipt does not make it valid evidence", async () => {
  const c = await config("2024-04-02");
  const r = await runStudy(c, {
    control: async (v, j, p) => {
      const a = await control(v, j, p);
      const e = a.decision.trace.find(
        (e: any) => e.type === "tool_result" && e.name === "get_price",
      ) as any;
      const payload = JSON.parse(e.result.content[0].text);
      payload.data.price = 999999;
      payload.receipt.resultHash = contentHash(payload.data);
      e.result.content[0].text = JSON.stringify(payload);
      return a;
    },
  });
  expect(r.summary.failure).toContain("eligible data");
  expect(r.summary.metrics.tradeCount).toBe(0);
});
test("tampered portfolio or deleted acknowledged journal suffix fails verification", async () => {
  const c = await config("2024-04-02");
  const r = await runStudy(c, { control });
  const file = join(r.dir, "daily", "2024-04-02.json");
  const day = read(file);
  day.record.portfolioAfter.cash += 100;
  writeFileSync(file, JSON.stringify(day));
  await expect(runStudy(c, { readOnly: true })).rejects.toThrow(
    "replay mismatch",
  );
  const ledger = join(r.dir, "journal-events.jsonl");
  const lines = readFileSync(ledger, "utf8").trim().split("\n");
  lines.pop();
  writeFileSync(ledger, lines.join("\n") + "\n");
  await expect(runStudy(c, { readOnly: true })).rejects.toThrow(
    "Missing journal seal",
  );
});
test("controls cannot masquerade as model smoke results; quarter lengths fail preflight", async () => {
  const c = await config();
  await expect(runStudy({ ...c, kind: "smoke" }, { control })).rejects.toThrow(
    "Control transport",
  );
  await expect(runStudy({ ...c, kind: "quarter" })).rejects.toThrow(
    "complete calendar quarter",
  );
});

test("frozen code identity and run identity are enforced on replay", async () => {
  const c = await config("2024-04-02");
  const r = await runStudy(c, { control });
  const file = join(r.dir, "environment.json");
  const environment = read(file);
  environment.implementation.hash = "0".repeat(64);
  writeFileSync(file, JSON.stringify(environment));
  await expect(runStudy(c, { readOnly: true })).rejects.toThrow(
    "implementation/runtime changed",
  );
});

test("a plain final note cannot authorize trades or a hold without the decision memo", async () => {
  const c = await config("2024-04-02");
  const result = await runStudy(c, { control: async (view, journal, past) => {
    const a = await control(view, journal, past);
    const tools = new SessionTools(view, journal, past, Date.now() + 10000);
    tools.call("journal_append", { text: "Hold.", requestId: "plain-final" });
    a.decision.orders = [];
    a.decision.trace.push(...tools.trace);
    a.journalEntries = journal.entries(view.scope);
    return a;
  }});
  expect(result.summary.status).toBe("incomplete");
  expect(result.summary.metrics.tradeCount).toBe(0);
  expect(result.summary.failure).toContain("structured decision memo");
});

test("opening state carries fills and applies the monthly cash contribution exactly once", async () => {
  const c = await config("2024-05-01"); c.start = "2024-04-30";
  const packets: ReturnType<typeof openingPortfolio>[] = [];
  const r = await runStudy(c, { control: async (view, journal, past) => {
    packets.push(openingPortfolio(view));
    return control(view, journal, past);
  }});
  expect(r.summary.status).toBe("completed");
  expect(packets[0]!.data.cash).toBe(500);
  expect(packets[0]!.data.holdings).toEqual({});
  const first = read(join(r.dir, "daily", "2024-04-30.json")).record;
  expect(packets[1]!.data.cash).toBe(800); // 500 - 200 buy + 500 contribution.
  expect(packets[1]!.data.holdings).toEqual(first.portfolioAfter.holdings);
  expect(packets[1]!.data.netWorth).toBe(first.portfolioAfter.netWorth + 500);
  expect(packets[1]!.receipt.observedThrough).toBe("2024-04-30");
  expect((await runStudy(c, { readOnly: true })).summary).toEqual(r.summary);
});

test("opening receipt alone can support a hold after more than 24 turns and replay", async () => {
  const c = await config("2024-04-02");
  const r = await runStudy(c, { control: async (view, journal) => {
    const tools = new SessionTools(view, journal, [], Date.now() + 10000);
    tools.call("journal_append", {
      text: "Keep the opening cash balance.", requestId: "hold",
      decision: {
        thesis: "Retain the initial cash pending stronger evidence.",
        evidence: [{ claim: "The supplied portfolio contains 500 cash.", receiptIds: [openingPortfolio(view).receipt.id] }],
        allocation: "Keep all 500 in cash today.", alternatives: "Buying now requires more evidence.",
        risks: "Cash may lag appreciating securities.", invalidation: "Reassess when new observable evidence arrives.", continuity: "First day; no previous thesis.",
      },
    });
    const decision = initialStudyDecision(view);
    decision.outcome = "completed"; decision.rationale = "Hold opening cash.";
    decision.usage.turns = 300; decision.trace = tools.trace;
    return {outcome: "completed", scope: view.scope, viewHash: contentHash(view), decision, journalEntries: journal.entries(view.scope)};
  }});
  expect(r.summary.status).toBe("completed");
  expect(r.summary.metrics.tradeCount).toBe(0);
  expect((await runStudy(c, { readOnly: true })).summary).toEqual(r.summary);
});

test("opening prompt validation rejects a changed cash snapshot even with a recomputed receipt hash", async () => {
  const c = await config("2024-04-02");
  const r = await runStudy(c, { control: async (view, journal, past) => {
    const a = await control(view, journal, past);
    const horizon = { start: c.start, end: c.end, contributions: [] };
    const protocol = {
      type: "protocol", version: STUDY_PROTOCOL, viewHash: contentHash(view),
      openingPortfolio: openingPortfolio(view),
      dailyPrompt: dailyPrompt(view, horizon.start, horizon.end, horizon.contributions),
    };
    a.decision.trace.push(protocol);
    expect(() => validateOpeningContext(a, view, past, horizon)).not.toThrow();
    protocol.openingPortfolio.data.cash = 999999;
    protocol.openingPortfolio.receipt.resultHash = contentHash(protocol.openingPortfolio.data);
    expect(() => validateOpeningContext(a, view, past, horizon)).toThrow("Opening portfolio");
    protocol.openingPortfolio = openingPortfolio(view);
    protocol.dailyPrompt += "\nCash balance: 999999";
    expect(() => validateOpeningContext(a, view, past, horizon)).toThrow("daily prompt");
    a.decision.trace.pop();
    return a;
  }});
  expect(r.summary.status).toBe("completed");
});
