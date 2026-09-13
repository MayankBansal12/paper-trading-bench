import type { DailyRecord } from "../domain/types.ts";
import type { StudyAttempt } from "./agent.ts";
import { renderDecisionMemo } from "./memo.ts";

const safe = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Evaluator-only: joins pretrade statements with subsequent actual fills and marks. */
export function renderJournalReview(records: DailyRecord[], accepted: StudyAttempt[]): string {
  const lines = ["# Decision journal review", "", "Pretrade memos are the model's stated justifications. Receipt validation establishes provenance, not factual entailment or hidden reasoning. Execution results below were unavailable when each memo was written.", ""];
  for (const a of accepted) {
    const r = records.find(r => r.date === a.scope.date)!;
    const final = a.journalEntries.at(-1)!;
    lines.push(`## ${a.scope.date}`, "", `Observed through **${a.scope.observationDate} close**. Attempt ${a.scope.attempt}.`, "",
      safe(final.text), "", safe(renderDecisionMemo(final.decision!)).replace(/\n/g, "\n\n"), "",
      `[Accepted memo and tool receipts](accepted/${a.scope.date}.json) · [Execution ledger](daily/${a.scope.date}.json)`, "",
      "### Actual execution after the memo", "",
      `Contribution: $${(r.contribution ?? 0).toFixed(2)}. Queued orders: ${a.decision.orders.length}. Fills: ${r.fills.length}. Rejected: ${r.failedOrders.length}.`, "");
    for (const order of a.decision.orders) lines.push(`- Queued ${order.side} ${order.ticker}: ${order.sizing.kind === "notional" ? "$" + order.sizing.usd.toFixed(2) : order.sizing.units + " shares"}.`);
    for (const fill of r.fills) lines.push(`- Filled ${fill.side} ${fill.ticker}: ${fill.units} shares at $${fill.price}; $${fill.notional.toFixed(2)}.`);
    for (const rejected of r.failedOrders) lines.push(`- Rejected ${rejected.side} ${rejected.ticker}: ${safe(rejected.reason)}.`);
    if (!a.decision.orders.length) lines.push("- Chose to hold; no orders queued.");
    lines.push("", `End-of-day equity: **$${r.portfolioAfter.netWorth.toFixed(2)}**. Cash: **$${r.portfolioAfter.cash.toFixed(2)}**.`, "",
      `Decision budget used: ${a.decision.usage.turns} turns, ${a.decision.trace.filter((e: any) => e.type === "tool_attempt").length} broker tool attempts, ${(a.decision.elapsedMs / 1000).toFixed(1)} seconds.`, "");
  }
  return lines.join("\n") + "\n";
}
