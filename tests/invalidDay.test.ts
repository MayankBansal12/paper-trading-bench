import { test, expect } from "bun:test";
import { executeInvalidDay } from "../src/core/execute.ts";
import type { MarketDataset } from "../src/data/dataset.ts";
import { JournalStore } from "../src/study/journal.ts";
import { scopeFor } from "../src/study/protocol.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("invalid day still credits funding/dividends, adjusts splits and marks close without reading an execution open", () => {
  const date = "2025-02-03";
  const previous = {
    cash: 100, holdings: { AAPL: { units: 4, avgCost: 100, lastClose: 100, value: 400 } },
    holdingsValue: 400, netWorth: 500,
  };
  const market = {
    actionsOn: () => [
      { type: "split", date, ticker: "AAPL", ratio: 2 },
      { type: "dividend", date, ticker: "AAPL", amount: 1 },
    ],
    openOn: () => { throw Error("Invalid decision cannot place orders"); },
    closeOn: () => 56,
  } as unknown as MarketDataset;
  const config = { start: date, end: date, history: 60,
    limits: { maxTurns: null, maxToolCalls: null, timeoutMs: 3600000 },
    contributions: [{ date, amount: 500 }],
  } as const;
  const result = executeInvalidDay(date, previous, { ...config, contributions: [...config.contributions] }, market, ["AAPL"]);
  expect(result.portfolioAfter).toMatchObject({
    cash: 608, holdingsValue: 448, netWorth: 1056,
    holdings: { AAPL: { units: 8, avgCost: 50, lastClose: 56 } },
  });
  expect(result.fills).toEqual([]);
  expect(result.failedOrders).toEqual([]);
  expect(previous.cash).toBe(100);
  expect(previous.holdings.AAPL.units).toBe(4);
});

test("event journal permits the next day only after an exhausted failure or a completed attempt", () => {
  const dir = mkdtempSync(join(tmpdir(), "invalid-sequence-"));
  try {
    const store = new JournalStore(dir);
    const first = scopeFor("sequence", "2025-02-03", 1), second = scopeFor("sequence", "2025-02-03", 2);
    const next = scopeFor("sequence", "2025-02-04", 1);
    store.begin(first); store.fail(first, "failure one");
    expect(() => store.begin(next)).toThrow("Invalid attempt sequence");
    store.begin(second); store.fail(second, "failure two");
    expect(() => store.begin(next)).not.toThrow();
    expect(new JournalStore(dir).root).toBe(store.root);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
