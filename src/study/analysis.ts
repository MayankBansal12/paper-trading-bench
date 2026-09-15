import type { StudyRecord as DailyRecord } from "../core/types.ts";
import type { StudyAttempt } from "./agent.ts";
import { attemptDiagnostics } from "../report/attemptDiagnostics.ts";

/** Descriptive ledger facts, without a favored strategy or inferred hidden reasoning. */
export function analyzeStudy(records: DailyRecord[], accepted: StudyAttempt[]) {
  const mean = (xs: number[]) =>
    xs.length ? xs.reduce((n, x) => n + x, 0) / xs.length : 0;
  const cash = records.map((r) =>
    r.portfolioAfter.netWorth
      ? (r.portfolioAfter.cash / r.portfolioAfter.netWorth) * 100
      : 0,
  );
  const counts = records.map(
    (r) => Object.keys(r.portfolioAfter.holdings).length,
  );
  const topWeights = records.map((r) =>
    r.portfolioAfter.netWorth
      ? (Math.max(
          0,
          ...Object.values(r.portfolioAfter.holdings).map((h) => h.value),
        ) /
          r.portfolioAfter.netWorth) *
        100
      : 0,
  );
  const hhi = records.map((r) =>
    r.portfolioAfter.holdingsValue
      ? Object.values(r.portfolioAfter.holdings).reduce(
          (n, h) => n + (h.value / r.portfolioAfter.holdingsValue) ** 2,
          0,
        )
      : 0,
  );
  const validDates = new Set(accepted.map((a) => a.scope.date));
  const days = accepted.map((a) => {
    const calls = a.decision.trace.filter(
      (e: any) => e.type === "tool_attempt",
    ) as any[];
    const results = a.decision.trace.filter(
      (e: any) => e.type === "tool_result",
    ) as any[];
    return {
      date: a.scope.date,
      attempt: a.scope.attempt,
      toolCalls: calls.length,
      rejectedToolCalls: results.filter((e) => e.result.isError).length,
      securitiesRequested: [
        ...new Set(
          calls
            .flatMap((e) => e.arguments?.tickers ?? [e.arguments?.ticker])
            .filter((t) => typeof t === "string"),
        ),
      ].sort(),
      fullUniverseSnapshotRequests: calls.filter(
        (e) => e.name === "market_snapshot" && !e.arguments?.tickers,
      ).length,
      journalReads: calls.filter((e) => ["journal"].includes(e.name)).length,
      journalEntries: a.journalEntries.map((e) => ({
        id: e.id,
        evidenceIds: e.evidenceRefs,
        tickers: e.tickers,
        tags: e.tags ?? [],
      })),
      note: a.journalEntries.at(-1)?.text ?? null,
      distinctEvidenceReceipts: new Set(
        a.journalEntries.at(-1)?.evidenceRefs ?? [],
      ).size,
      orders: a.decision.orders.length,
      elapsedMs: a.decision.elapsedMs,
      turns: a.decision.usage.turns,
      tokens: a.decision.usage.totalTokens,
      costUsd: a.decision.usage.costUsd,
    };
  });
  return {
    days,
    meanCashPct: mean(cash),
    meanHoldings: mean(counts),
    meanLargestHoldingPct: mean(topWeights),
    meanRiskyAssetHHI: mean(hhi),
    noTradeDays: records.filter((r) => validDates.has(r.date) && !r.fills.length).length,
    invalidDecisionDays: records.filter((r) => !validDates.has(r.date)).length,
    portfolioObservationDays: records.length,
    buyNotional: records
      .flatMap((r) => r.fills)
      .filter((f) => f.side === "BUY")
      .reduce((n, f) => n + f.notional, 0),
    sellNotional: records
      .flatMap((r) => r.fills)
      .filter((f) => f.side === "SELL")
      .reduce((n, f) => n + f.notional, 0),
    interpretation:
      "Tool requests and journal citations measure recorded activity; they do not prove attention, decision quality, or hidden reasoning.",
  };
}

/** Evaluator-only attempt history, including failures and interrupted attempts. */
export function summarizeAttempts(
  events: import("./journal.ts").JournalEvent[],
  accepted: StudyAttempt[],
) {
  const committed = new Set(accepted.map(a => `${a.scope.date}:${a.scope.attempt}`));
  const grouped = new Map<string, typeof events>();
  for (const e of events) {
    const key = `${e.scope.date}:${e.scope.attempt}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(e);
  }
  return [...grouped].map(([key, rows]) => {
    const result = rows.find(e => e.kind === "result");
    const failed = rows.find(e => e.kind === "failed");
    const usage = result?.payload.decision?.usage;
    const observed = rows.filter(e => e.kind === "audit").map(e => e.payload);
    const outcome = result?.payload.outcome ?? (failed ? "interrupted" : "unfinished");
    const reason = result?.payload.reason ?? failed?.payload.reason ?? null;
    return {
      date: rows[0]!.scope.date,
      attempt: rows[0]!.scope.attempt,
      committed: committed.has(key),
      outcome, reason,
      ...attemptDiagnostics(outcome, reason, observed),
      submitted: rows.some(e => e.kind === "submission"),
      observedInferenceRequests: observed.filter(e => e.type === "inference_request").length,
      observedBrokerCalls: observed.filter(e => e.type === "tool_attempt").length,
      elapsedMs: result?.payload.decision?.elapsedMs ?? null,
      tokens: usage?.totalTokens ?? null,
      usageCompleteness: usage?.completeness ?? "unavailable",
    };
  });
}
