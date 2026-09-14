import { test, expect } from "bun:test";
import { literalText } from "../src/report/text.ts";
import { renderJournalReview } from "../src/study/review.ts";

const hostile = "Keep AAPL.\n![tracker](https://example.invalid/pixel)\n[claim](https://example.invalid/)\n<img src='https://example.invalid/x'>\n```\n````\n# Fake report\nhttps://example.invalid/";

test("original journal prose cannot create active report content or escape a fence", () => {
  const html = Bun.markdown.html(literalText(hostile));
  expect(html).not.toMatch(/<(?:a|img|script|h1)\b/i);
  expect(html).toContain("Keep AAPL.");
  expect(html).toContain("example.invalid");
});

test("decision reviews keep hostile original notes literal while preserving host artifact links", () => {
  const a: any = {
    scope: { date: "2026-07-30", observationDate: "2026-07-29", attempt: 1 },
    decision: { orders: [], elapsedMs: 100, trace: [], usage: { turns: 1, totalTokens: null, costUsd: null } },
    journalEntries: [{ text: hostile, tickers: [], tags: [hostile], evidenceRefs: [], decision: {
      thesis: hostile, evidence: [{ claim: hostile, receiptIds: ["opening"] }],
      allocation: "Cash", alternatives: "Hold", risks: "Risk", invalidation: "Review", continuity: "First day",
    } }],
  };
  const r: any = { portfolioBefore: { cash: 500, holdings: {}, holdingsValue: 0, netWorth: 500 }, date: a.scope.date, fills: [], failedOrders: [], portfolioAfter: { netWorth: 500, cash: 500 } };
  const markdown = (renderJournalReview as Function)([r], [a], {});
  const html = Bun.markdown.html(markdown);
  expect(html).not.toMatch(/<(?:img|script)\b/i);
  expect(html).not.toMatch(/href=["']https:/);
  expect(html).toContain("Keep AAPL.");
  expect(html).toContain("href=");
});
