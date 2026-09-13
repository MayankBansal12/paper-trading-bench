import { initialStudyDecision, type StudyAttempt } from "./agent.ts";
import { SessionTools } from "./tools.ts";
import { contentHash } from "../core/hash.ts";
import {
  STUDY_PROTOCOL,
  dailyPrompt,
  openingPortfolio,
  type SessionView,
} from "./protocol.ts";
import { JournalStore, type JournalEntry } from "./journal.ts";
/** The v10 mechanical order policy, unchanged for ledger equivalence. */
export async function deterministicControl(
  view: SessionView,
  journal: JournalStore,
  past: JournalEntry[],
): Promise<StudyAttempt> {
  const tools = new SessionTools(
    view,
    journal,
    past,
    Date.now() + view.limits.timeoutMs,
  );
  const decision = initialStudyDecision(view);
  const protocol = {
    type: "protocol",
    version: STUDY_PROTOCOL,
    viewHash: contentHash(view),
    openingPortfolio: openingPortfolio(view),
    dailyPrompt: dailyPrompt(
      view,
      view.horizon.start,
      view.horizon.end,
      view.horizon.contributions,
      past,
    ),
  };
  journal.audit(view.scope, protocol);
  const ticker = view.universe[0]!;
  const observed = tools.call("market_snapshot", { tickers: [ticker] });
  tools.call("price_history", { tickers: [ticker], lookback: 20 });
  tools.call("journal", { query: "control" });
  const orders: any[] = [],
    units = view.portfolio.holdings[ticker]?.units ?? 0;
  if (past.length % 7 === 6 && units > 0)
    orders.push({ side: "SELL", ticker, units: units / 2 });
  if (view.portfolio.cash >= 100)
    orders.push({ side: "BUY", ticker, notionalUsd: 100 });
  const result = tools.call("submit_day", {
    orders,
    journal: {
      text: "Deterministic engine control. Mechanical fills, cash-flow and journal replay check; not a model strategy.",
      tickers: [ticker],
      evidence_refs: [JSON.parse(observed.content[0].text).receipt.id],
    },
  });
  if (result.isError) throw new Error(result.content[0].text);
  decision.outcome = "completed";
  decision.orders = tools.orders();
  decision.submittedOrders = tools.orders();
  decision.rationale = tools.submission()!.journal.text;
  decision.trace = [protocol, ...tools.trace];
  const calls = tools.trace.filter((e) => e.type === "tool_attempt").length;
  decision.usage.toolCalls = calls;
  decision.usage.attemptedToolCalls = calls;
  decision.usage.admittedToolCalls = calls;
  decision.usage.successfulToolCalls = calls;

  return {
    outcome: "completed",
    scope: view.scope,
    viewHash: contentHash(view),
    decision,
    journalEntries: journal.entries(view.scope),
    submission: tools.submission(),
  };
}
