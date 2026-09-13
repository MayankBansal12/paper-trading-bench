import type { StudyRecord as DailyRecord } from "../core/types.ts";
import type { StudyAttempt } from "./agent.ts";

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
    noTradeDays: records.filter((r) => !r.fills.length).length,
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
