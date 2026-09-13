import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { loadDataset } from "../src/data/dataset.ts";
import { createInitialPortfolio } from "../src/engine/portfolio.ts";
import {
  makeView,
  scopeFor,
  POLICY,
  STUDY_PROTOCOL,
} from "../src/study/protocol.ts";
import { JournalStore, type JournalEntry } from "../src/study/journal.ts";
import { SessionTools } from "../src/study/tools.ts";
import type { StudyConfig } from "../src/study/runner.ts";
export function setup(past: JournalEntry[] = [], date = "2025-02-03") {
  const scope = scopeFor("test", date, 1),
    dir = mkdtempSync(join(tmpdir(), "v11-tools-"));
  const bar = {
    date: scope.observationDate,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1000,
  };
  const view = makeView(
    {
      date,
      universe: ["AAPL", "MSFT"],
      portfolio: createInitialPortfolio(500),
      bars: { AAPL: [bar], MSFT: [bar] },
      indicators: {},
      recentDays: [],
      limits: { maxTurns: null, maxToolCalls: null, timeoutMs: 10000 },
      horizon: { startDate: "2025-01-31", endDate: "2025-02-04" },
      contributions: [{ date, amount: 500 }],
    },
    scope,
    { AAPL: ["Apple Inc."], MSFT: ["Microsoft Corporation"] },
  );
  const store = new JournalStore(dir);
  store.begin(scope);
  return {
    view,
    scope,
    dir,
    store,
    tools: new SessionTools(view, store, past, Date.now() + 10000),
  };
}
export const note = {
  text: "Hold cash while assessing uncertainty; reconsider when observations change.",
  tickers: [],
};
export const payload = (orders: any[] = []) => ({
  orders,
  journal: structuredClone(note),
});
export const data = (r: any) => JSON.parse(r.content[0].text).data;
export async function config(
  start = "2024-04-02",
  end = "2024-04-03",
): Promise<StudyConfig> {
  const market = await loadDataset();
  return {
    protocol: STUDY_PROTOCOL,
    kind: "control",
    runId: "test-v11-" + randomUUID(),
    dataDir: resolve("fixtures/ohlcv"),
    datasetHash: market.version,
    universeVersion: "v1",
    start,
    end,
    history: 60,
    limits: { maxTurns: null, maxToolCalls: null, timeoutMs: 10000 },
    policy: POLICY,
  };
}
