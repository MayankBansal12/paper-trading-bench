import { test, expect, afterEach } from "bun:test";
import {
  rmSync,
  readFileSync,
  readdirSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { config, payload } from "./studyTestSupport.ts";
import {
  runStudy,
  prepareStudyData,
  validateOpeningContext,
} from "../src/study/runner.ts";
import { deterministicControl } from "../src/study/control.ts";
import { SessionTools } from "../src/study/tools.ts";
import { JournalStore, durableCreate } from "../src/study/journal.ts";
import { makeView, scopeFor } from "../src/study/protocol.ts";
import { buildDecisionContext } from "../src/core/context.ts";
import { createInitialPortfolio } from "../src/engine/portfolio.ts";
import { contentHash } from "../src/core/hash.ts";
import { TOKEN_FIELDS } from "../src/core/types.ts";
const dirs: string[] = [];
async function c(...args: Parameters<typeof config>) {
  const value = await config(...args);
  dirs.push(resolve("results/studies", value.runId));
  return value;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
test("multi-day control replays and resumes without duplicate decisions/fills or duplicate authoritative files", async () => {
  const cfg = await c();
  const first = await runStudy(cfg, { control: deterministicControl });
  expect(first.summary.status).toBe("completed");
  expect(first.summary.fills).toBe(2);
  expect(readdirSync(first.dir).sort()).toEqual([
    "days",
    "events.jsonl",
    "manifest.json",
  ]);
  const before = readFileSync(join(first.dir, "events.jsonl"), "utf8");
  expect((await runStudy(cfg, { readOnly: true })).summary).toEqual(
    first.summary,
  );
  expect(
    (
      await runStudy(cfg, {
        control: async () => {
          throw Error("No extra decision");
        },
      })
    ).summary,
  ).toEqual(first.summary);
  expect(readFileSync(join(first.dir, "events.jsonl"), "utf8")).toBe(before);
});
for (const phase of ["after-result", "after-commit"] as const)
  test(`crash ${phase} recovers durable decision exactly once without another turn`, async () => {
    const cfg = await c("2024-04-30", "2024-05-01");
    let crashed = false;
    await expect(
      runStudy(cfg, {
        control: deterministicControl,
        fault: (p, d) => {
          if (p === phase && d === "2024-05-01" && !crashed) {
            crashed = true;
            throw Error("crash");
          }
        },
      }),
    ).rejects.toThrow("crash");
    const replay = await runStudy(cfg, {
      control: async () => {
        throw Error("Must recover without inference");
      },
    });
    expect(replay.summary.committedDays).toBe(2);
    expect(replay.summary.fills).toBe(2);
    expect(replay.days.map((d) => d.record.contribution)).toEqual([0, 500]);
    expect((await runStudy(cfg, { readOnly: true })).summary).toEqual(
      replay.summary,
    );
  });
test("crash after durable submission but before integrity completion executes nothing and hides failed note on retry", async () => {
  const cfg = await c("2024-04-02", "2024-04-02");
  await expect(
    runStudy(cfg, {
      control: async (view, journal) => {
        const tools = new SessionTools(view, journal, [], Date.now() + 1000);
        tools.call("submit_day", {
          orders: [{ ticker: "AAPL", side: "BUY", notionalUsd: 500 }],
          journal: { text: "Failed private attempt note.", tickers: ["AAPL"] },
        });
        throw Error("missing client audit");
      },
    }),
  ).rejects.toThrow();
  const dir = resolve("results/studies", cfg.runId);
  expect(existsSync(join(dir, "days"))).toBe(false);
  const result = await runStudy(cfg, {
    control: async (view, journal, past) => {
      expect(view.scope.attempt).toBe(2);
      expect(view.portfolio.cash).toBe(500);
      expect(past).toEqual([]);
      return deterministicControl(view, journal, past);
    },
  });
  expect(result.summary.failures).toBe(1);
  expect(result.summary.fills).toBe(1);
  expect(readFileSync(join(dir, "events.jsonl"), "utf8")).toContain(
    "Failed private attempt note",
  );
  expect(result.attempts[0]!.journalEntries[0]!.text).not.toContain(
    "Failed private",
  );
});
test("unknown usage preserves an otherwise complete submission and remains null on replay", async () => {
  const cfg = await c("2024-04-02", "2024-04-02");
  const first = await runStudy(cfg, {
    control: async (...args) => {
      const a = await deterministicControl(...args);
      a.decision.usage.completeness = "unavailable";
      a.decision.usage.missingSteps = 1;
      for (const field of TOKEN_FIELDS) a.decision.usage[field] = null;
      return a;
    },
  });
  expect(first.summary.status).toBe("completed");
  expect(first.summary.usageUnavailableAttempts).toBe(1);
  expect(
    (await runStudy(cfg, { readOnly: true })).attempts[0]!.decision.usage
      .totalTokens,
  ).toBeNull();
});
test("broker/result/context integrity errors invalidate complete submissions", async () => {
  for (const mutate of [
    (a: any) => {
      a.decision.trace.find(
        (e: any) => e.type === "tool_result",
      ).result.content[0].text = "forged";
    },
    (a: any) => {
      a.viewHash = "forged";
    },
    (a: any) => {
      a.decision.trace.push({
        type: "tool_attempt",
        name: "shell",
        arguments: {},
      });
    },
  ]) {
    const cfg = await c("2024-04-02", "2024-04-02");
    const result = await runStudy(cfg, {
      control: async (...args) => {
        const a = await deterministicControl(...args);
        mutate(a);
        return a;
      },
    });
    expect(result.summary.committedDays).toBe(0);
    expect(result.summary.fills).toBe(0);
    expect(result.summary.failures).toBe(1);
  }
});
test("next-day prompt includes exact original note and changed cash/holdings; forged preload rejected", async () => {
  const cfg = await c("2024-04-30", "2024-05-01");
  const result = await runStudy(cfg, {
    control: async (view, journal, past) => {
      if (past.length) {
        expect(view.portfolio.cash).toBe(900);
        expect(view.portfolio.holdings.AAPL!.units).toBeGreaterThan(0);
      }
      return deterministicControl(view, journal, past);
    },
  });
  const p = await prepareStudyData(cfg),
    a = result.attempts[1]!,
    view = makeView(
      buildDecisionContext(
        p.config,
        a.scope.date,
        p.universe,
        result.days[0]!.record.portfolioAfter,
        [],
        p.market,
      ),
      a.scope,
      p.aliases,
    );
  const history = result.attempts[0]!.journalEntries;
  expect(() =>
    validateOpeningContext(a, view, history, view.horizon),
  ).not.toThrow();
  a.decision.trace.find((e) => e.type === "protocol").dailyPrompt +=
    "foreign note";
  expect(() => validateOpeningContext(a, view, history, view.horizon)).toThrow(
    /prompt/,
  );
});
test("changed semantics and conflicting atomic publication fail closed", async () => {
  const cfg = await c("2024-04-02", "2024-04-02");
  const r = await runStudy(cfg, { control: deterministicControl });
  await expect(
    runStudy(
      { ...cfg, protocol: "v10-unlimited-turns-portfolio-context" },
      { readOnly: true },
    ),
  ).rejects.toThrow(/old cohorts/);
  const path = join(r.dir, "days", `${cfg.start}.json`),
    raw = readFileSync(path, "utf8");
  expect(() => durableCreate(path, { conflicting: true })).toThrow();
  expect(readFileSync(path, "utf8")).toBe(raw);
  const day = JSON.parse(raw);
  day.record.portfolioAfter.cash += 100;
  writeFileSync(path, JSON.stringify(day));
  await expect(runStudy(cfg, { readOnly: true })).rejects.toThrow(
    /replay mismatch/,
  );
});


test("offline reports show uncommitted failures and recovered attempts without treating failed notes as decisions", async () => {
  const cfg = await c("2024-04-02", "2024-04-03");
  const { initialStudyDecision } = await import("../src/study/agent.ts");
  const { writeStudyReview } = await import("../src/study/report.ts");
  const options = { analysis: true, gaps: false, comparisons: false };
  const partial = await runStudy(cfg, {
    control: async (view, journal, past) => {
      if (!past.length) return deterministicControl(view, journal, past);
      const tools = new SessionTools(view, journal, past, Date.now() + 1000);
      tools.call("market_snapshot", {});
      const decision = initialStudyDecision(view);
      decision.outcome = "budget_cutoff";
      decision.boundedStop = true;
      decision.trace = tools.trace;
      decision.elapsedMs = 10000;
      return { outcome: "budget_cutoff", reason: "No submit ![tracker](https://example.invalid)",
        scope: view.scope, viewHash: contentHash(view), decision, journalEntries: [] };
    },
  });
  await writeStudyReview(cfg, partial, options);
  const review = readFileSync(join(partial.dir, "review.md"), "utf8");
  expect(review).toContain("incomplete: 1/2 sessions committed; 1 failed attempts");
  expect(Bun.markdown.html(review)).not.toContain("<img");
  const analysis = JSON.parse(readFileSync(join(partial.dir, "analysis.json"), "utf8"));
  expect(analysis.days).toHaveLength(1);
  expect(analysis.attempts).toHaveLength(2);
  expect(analysis.attempts[1]).toMatchObject({ outcome: "budget_cutoff", committed: false, observedBrokerCalls: 1, submitted: false });
  const recovered = await runStudy(cfg, { control: deterministicControl });
  await writeStudyReview(cfg, recovered, options);
  const after = JSON.parse(readFileSync(join(recovered.dir, "analysis.json"), "utf8"));
  expect(after.run.status).toBe("completed");
  expect(after.run.failures).toBe(1);
  expect(after.attempts).toHaveLength(3);
  expect(after.attempts.map((a: any) => a.committed)).toEqual([true, false, true]);
  expect(after.days).toHaveLength(2);
});
