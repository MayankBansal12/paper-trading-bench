import type { StudyRecord } from "../core/types.ts";
import type { StudyAttempt } from "./agent.ts";
import type { MarketDataset } from "../data/dataset.ts";
import { preparePortfolio } from "../engine/cashFlows.ts";
import { executeOrder } from "../engine/execution.ts";
import { applyFill } from "../engine/portfolio.ts";
const safe = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Evaluator-only: use the SAME split-adjusted observation units as the decision context. */
export function tradeAnalysis(
  record: StudyRecord,
  attempt: StudyAttempt,
  market: MarketDataset,
) {
  let portfolio = preparePortfolio(
    record.portfolioBefore,
    record.contribution ?? 0,
    record.corporateActions ?? [],
  );
  return attempt.decision.orders.map((order, index) => {
    const observedClose = market
      .asOfBefore(order.ticker, record.date, 1)
      .at(-1)!.close;
    const open = market.openOn(order.ticker, record.date)!;
    // Ordered execution is reconstructed independently to avoid matching repeated ticker orders ambiguously.
    const result = executeOrder(order, open, portfolio, record.date);
    if ("fill" in result) portfolio = applyFill(portfolio, result.fill);
    return {
      index,
      order,
      observedClose,
      executionOpen: open,
      gapPct: (open / observedClose - 1) * 100,
      actualFill: "fill" in result ? result.fill : null,
      rejection: "failed" in result ? result.failed : null,
    };
  });
}
export function renderJournalReview(
  records: StudyRecord[],
  accepted: StudyAttempt[],
  market: MarketDataset,
) {
  const lines = [
    "# Decision review",
    "",
    "Original notes record stated reasons, not private reasoning. Available receipts and explicit citations are different. Opening fills and closing outcomes below were unavailable during the same decision.",
    "",
    "The previous-close/next-open gap is an environment constraint. Dollar orders specify amounts; resulting shares depend on the unknown open. Fixed-share buys may fail for insufficient cash.",
    "",
  ];
  for (const [i, a] of accepted.entries()) {
    const r = records[i]!,
      note = a.journalEntries[0]!;
    lines.push(
      `## ${a.scope.date}`,
      "",
      `Observed through ${a.scope.observationDate} close.`,
      "",
      "Previous original note:",
      "",
      safe(accepted[i - 1]?.journalEntries[0]?.text ?? "First day; none."),
      "",
      "Committed original note:",
      "",
      safe(note.text),
      "",
      `Ticker tags: ${note.tickers.join(", ") || "none"}. Explicit citations: ${note.evidenceRefs.join(", ") || "none"}.`,
      "",
      `[Atomic day commit](days/${a.scope.date}.json) · [Raw context, calls, submission and failures](events.jsonl)`,
      "",
      "| Order | Requested | Observed close | Opening price | Gap |",
      "|---|---|---:|---:|---:|",
    );
    for (const t of tradeAnalysis(r, a, market))
      lines.push(
        `| ${t.index + 1}. ${t.order.side} ${t.order.ticker} | ${t.order.sizing.kind === "notional" ? "$" + t.order.sizing.usd : t.order.sizing.units + " shares"} | ${t.observedClose.toFixed(4)} | ${t.executionOpen.toFixed(4)} | ${t.gapPct.toFixed(4)}% |`,
      );
    lines.push("", "Actual fills after submission:", "");
    for (const f of r.fills)
      lines.push(
        `- ${f.side} ${f.ticker}: ${f.units} shares at $${f.price}; cash moved $${f.notional}.`,
      );
    for (const f of r.failedOrders)
      lines.push(`- Rejected ${f.side} ${f.ticker}: ${safe(f.reason)}`);
    if (!a.decision.orders.length) lines.push("- Hold (empty order batch).");
    lines.push(
      "",
      `Contribution $${r.contribution ?? 0}; closing cash $${r.portfolioAfter.cash}; closing equity $${r.portfolioAfter.netWorth}.`,
      "",
      `Usage: ${a.decision.usage.turns} model turns; tokens ${a.decision.usage.totalTokens ?? "unavailable"}; reported cost ${a.decision.usage.costUsd ?? "unavailable"}.`,
      "",
    );
  }
  return lines.join("\n") + "\n";
}
export function datasetGapAnalysis(
  market: MarketDataset,
  dates: readonly string[],
) {
  const rows = dates.flatMap((date) =>
    market.universe.map((ticker) => {
      const observedClose = market.asOfBefore(ticker, date, 1).at(-1)!.close,
        open = market.openOn(ticker, date)!;
      return {
        ticker,
        date,
        observedClose,
        open,
        gapPct: (open / observedClose - 1) * 100,
      };
    }),
  );
  const abs = rows.map((r) => Math.abs(r.gapPct)).sort((a, b) => a - b);
  const percentile = (p: number) => {
    const i = (abs.length - 1) * p,
      lo = Math.floor(i);
    return abs[lo]! + (abs[Math.ceil(i)]! - abs[lo]!) * (i - lo);
  };
  return {
    datasetHash: market.version,
    unit: "stored-dataset security-days; not actual model fills or independently verified market-wide estimates",
    splitUnits:
      "previous close adjusted for splits through execution date; same units as opening fill",
    securities: market.universe.length,
    days: dates.length,
    observations: rows.length,
    absoluteMedianPct: percentile(0.5),
    absoluteP95Pct: percentile(0.95),
    absoluteOver2Pct: (abs.filter((n) => n > 2).length / abs.length) * 100,
    absoluteMaxPct: abs.at(-1),
    rows,
  };
}
