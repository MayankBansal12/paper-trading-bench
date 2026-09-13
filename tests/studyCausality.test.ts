import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadDataset,
  sha256,
  ADJUSTMENT_CONVENTION,
  type DatasetManifest,
} from "../src/data/dataset.ts";
import { CALENDAR_VERSION, exchangeDates } from "../src/data/calendar.ts";
import {
  scopeFor,
  makeView,
  dailyPrompt,
  openingPortfolio,
} from "../src/study/protocol.ts";
import { buildDecisionContext } from "../src/core/context.ts";
import { createInitialPortfolio } from "../src/engine/portfolio.ts";
import { SessionTools } from "../src/study/tools.ts";
import { JournalStore } from "../src/study/journal.ts";
import type { ContextConfig } from "../src/core/context.ts";
test("changing every future price and future split leaves all current financial tool replies identical", async () => {
  const dir = mkdtempSync(join(tmpdir(), "study-future-"));
  try {
    const calendar = exchangeDates("2025-01-02", "2025-01-24");
    const bars = calendar.map((date, i) => ({
      date,
      open: 100 + i,
      high: 102 + i,
      low: 99 + i,
      close: 101 + i,
      volume: 1000,
    }));
    const manifest: DatasetManifest = {
      schemaVersion: 1,
      kind: "historical",
      source: "adversarial controlled fixture",
      fetchedAt: "2025-01-25T00:00:00Z",
      adjustmentConvention: ADJUSTMENT_CONVENTION,
      calendarVersion: CALENDAR_VERSION,
      coverage: { start: "2025-01-02", end: "2025-01-24" },
      evaluation: { start: "2025-01-02", end: "2025-01-24" },
      calendar,
      universe: ["AAPL"],
      actions: [
        { type: "split", ticker: "AAPL", date: "2025-01-24", ratio: 2 },
      ],
      files: {},
      snapshots: [{ path: "source.json", sha256: sha256("{}") }],
    };
    writeFileSync(join(dir, "source.json"), "{}");
    const save = () => {
      const data = JSON.stringify(bars);
      writeFileSync(join(dir, "AAPL.json"), data);
      manifest.files.AAPL = { path: "AAPL.json", sha256: sha256(data) };
      writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    };
    save();
    const before = await loadDataset(dir);
    for (const bar of bars)
      if (bar.date >= "2025-01-22") {
        bar.open *= 50;
        bar.high *= 50;
        bar.low *= 50;
        bar.close *= 50;
        bar.volume *= 100;
      }
    manifest.actions[0] = {
      type: "split",
      ticker: "AAPL",
      date: "2025-01-24",
      ratio: 8,
    };
    save();
    const after = await loadDataset(dir);
    expect(before.version).not.toBe(after.version);
    expect(before.openOn("AAPL", "2025-01-22")).not.toBe(
      after.openOn("AAPL", "2025-01-22"),
    );
    const scope = scopeFor("causality", "2025-01-22", 1);
    const config = {
      history: 60,
      limits: { maxTurns: null, maxToolCalls: null, timeoutMs: 10000 },
      contributions: [],
    } as unknown as ContextConfig;
    const views = [before, after].map((m) =>
      makeView(
        buildDecisionContext(
          config,
          scope.date,
          ["AAPL"],
          createInitialPortfolio(500),
          [],
          m,
        ),
        scope,
      ),
    );
    expect(views[0]).toEqual(views[1]);
    expect(openingPortfolio(views[0]!)).toEqual(openingPortfolio(views[1]!));
    expect(dailyPrompt(views[0]!, scope.date, "2025-01-24", [])).toEqual(
      dailyPrompt(views[1]!, scope.date, "2025-01-24", []),
    );
    const replies = views.map((view, i) => {
      const journal = new JournalStore(join(dir, `journal-${i}`));
      journal.begin(scope);
      const tools = new SessionTools(view, journal, [], Date.now() + 10000);
      return [
        tools.call("market_snapshot", { tickers: ["AAPL"] }),
        tools.call("price_history", { tickers: ["AAPL"], lookback: 252 }),
        tools.call("journal", {}),
      ];
    });
    expect(replies[0]).toEqual(replies[1]);
    expect(replies[0]!.every((r) => !r.isError)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
