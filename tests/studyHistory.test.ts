import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { config } from "./studyTestSupport.ts";
import { prepareStudyData } from "../src/study/runner.ts";
import { buildDecisionContext } from "../src/core/context.ts";
import { createInitialPortfolio } from "../src/engine/portfolio.ts";
import { makeView, openingContext, scopeFor } from "../src/study/protocol.ts";
import { SessionTools } from "../src/study/tools.ts";
import { JournalStore } from "../src/study/journal.ts";

for (const limit of [100, 120]) {
  test(`history=${limit} advertises and enforces its cap despite more stored data`, async () => {
    const c = { ...await config("2024-06-28", "2024-06-28"), history: limit };
    const p = await prepareStudyData(c);
    expect(p.market.asOfBefore("AAPL", c.start).length).toBeGreaterThan(120);
    const view = makeView(
      buildDecisionContext(p.config, c.start, p.universe, createInitialPortfolio(500), [], p.market),
      scopeFor(c.runId, c.start, 1),
    );
    const dir = mkdtempSync(join(tmpdir(), "study-history-"));
    try {
      const store = new JournalStore(dir);
      store.begin(view.scope);
      const tools = new SessionTools(view, store, [], Date.now() + 10000);
      expect(openingContext(view, view.horizon, []).data.priceHistory.maxLookback).toBe(limit);
      expect(tools.definitions.find(t => t.name === "price_history")!
        .inputSchema.properties.lookback.maximum).toBe(limit);
      const request = tools.call("price_history", { tickers: ["AAPL", "MSFT"], lookback: 120 });
      if (limit === 100) {
        expect(request.isError).toBe(true);
        expect(request.content[0].text).toContain("lookback");
        expect(request.content[0].text).toContain("100");
      } else {
        expect(request.isError).toBeUndefined();
        const data = JSON.parse(request.content[0].text).data;
        for (const ticker of ["AAPL", "MSFT"])
          expect(data.securities[ticker]).toEqual(p.market.asOfBefore(ticker, c.start, 120));
      }
      const atLimit = tools.call("price_history", { tickers: ["AAPL", "MSFT"], lookback: limit });
      expect(atLimit.isError).toBeUndefined();
      const data = JSON.parse(atLimit.content[0].text).data;
      for (const ticker of ["AAPL", "MSFT"]) {
        expect(data.securities[ticker]).toHaveLength(limit);
        expect(data.securities[ticker].at(-1).date).toBe(view.scope.observationDate);
      }
      expect(tools.call("price_history", { tickers: ["AAPL"], lookback: limit + 1 }).isError).toBe(true);
      // A bad lookback is recoverable; it does not prevent a later valid submission.
      expect(tools.call("submit_day", { orders: [], journal: { text: "Hold cash.", tickers: [] } }).isError).toBeUndefined();
      expect(tools.integrityError).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
