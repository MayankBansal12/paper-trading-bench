import { join } from "node:path";
import type { StudyConfig, runStudy } from "./runner.ts";
import { loadDataset, validateDatasetWindow } from "../data/dataset.ts";
import { writeFileAtomic } from "../utils/fs.ts";
import {
  renderJournalReview,
  tradeAnalysis,
  datasetGapAnalysis,
} from "./review.ts";
import { analyzeStudy, summarizeAttempts } from "./analysis.ts";
import { JournalStore } from "./journal.ts";
import { literalText } from "../report/text.ts";
import { monthlyDeposits } from "../core/funding.ts";
import { computeMetrics } from "../engine/metrics.ts";
import { cashBaseline, buyAndHoldBaseline } from "../engine/baselines.ts";
import { loadNDX, compareNDX } from "./reference.ts";
/** Optional derived artifacts. No code in the simulation imports this module. */
export async function writeStudyReview(
  c: StudyConfig,
  result: Awaited<ReturnType<typeof runStudy>>,
  options: {
    analysis: boolean;
    gaps: boolean;
    comparisons: boolean;
    ndxDir?: string;
  },
) {
  const market = await loadDataset(c.dataDir);
  if (market.version !== c.datasetHash)
    throw new Error("Dataset changed before review");
  const records = result.days.map((d) => d.record),
    dates = records.map((r) => r.date),
    contributions = monthlyDeposits(
      validateDatasetWindow(market, c.start, c.end, c.history),
    );
  const attempts = summarizeAttempts(new JournalStore(result.dir).all(), result.attempts);
  const acceptedByDate = new Map(result.attempts.map((a) => [a.scope.date, a]));
  const status = [
    "# Run status", "",
    `${result.summary.status}: ${result.summary.validDays}/${result.summary.totalDays} valid decisions; ${result.summary.committedDays} days accounted; ${result.summary.failures} failed attempts.`, "",
    `${result.summary.attemptedDays} trading days attempted; ${result.summary.retriedDays} retried; ${result.summary.invalidDays} invalid after exhausted attempts; ${result.summary.unattemptedDays} not attempted.`, "",
    "Portfolio metrics include every accounted day, including deposits, corporate actions and market movement on invalid days. Decision metrics cover valid decisions only. Failed attempts remain in the operational record; quarters stopped after three consecutive invalid days are incomplete-period results.", "",
    "| Date | Attempt | Outcome | Committed | Inference requests | Broker calls |",
    "|---|---:|---|---|---:|---:|",
    ...attempts.map(a => `| ${a.date} | ${a.attempt} | ${a.outcome} | ${a.committed ? "yes" : "no"} | ${a.observedInferenceRequests} | ${a.observedBrokerCalls} |`),
    "",
    ...attempts.filter(a => a.reason).flatMap(a => [
      `${a.date}, attempt ${a.attempt}:`, "", literalText(String(a.reason)), "",
    ]),
  ];
  await writeFileAtomic(
    join(result.dir, "review.md"),
    status.join("\n") + "\n" + renderJournalReview(records, result.attempts, market),
  );
  if (options.analysis)
    await writeFileAtomic(
      join(result.dir, "analysis.json"),
      JSON.stringify(
        {
          run: result.summary,
          attempts,
          metricsScope: "Portfolio metrics include all accounted days, including invalid days carried forward without orders. Decision metrics cover valid decisions only.",
          invalidSessions: result.summary.invalidSessions,
          ...analyzeStudy(records, result.attempts),
          trades: records.flatMap((r) => {
            const accepted = acceptedByDate.get(r.date);
            return accepted ? tradeAnalysis(r, accepted, market).map((t) => ({ date: r.date, ...t })) : [];
          }),
        },
        null,
        2,
      ) + "\n",
    );
  if (options.gaps)
    await writeFileAtomic(
      join(result.dir, "dataset-gaps.json"),
      JSON.stringify(
        datasetGapAnalysis(
          market,
          validateDatasetWindow(market, c.start, c.end, c.history),
        ),
        null,
        2,
      ) + "\n",
    );
  if (options.comparisons) {
    const curve = records.map((r) => ({
      date: r.date,
      netWorth: r.portfolioAfter.netWorth,
      contribution: r.contribution,
    }));
    const metrics = computeMetrics(
      curve,
      500,
      result.summary.fills,
      result.summary.rejectedOrders,
      0,
      records.map((r) => r.turnoverPct),
    );
    const cash = cashBaseline(500, dates, contributions),
      buyAndHold = await buyAndHoldBaseline(
        500,
        market.universe,
        dates,
        contributions,
        market,
      );
    const ndx = options.ndxDir
      ? await loadNDX(
          options.ndxDir,
          (await loadDataset(options.ndxDir)).version,
          c.start,
          c.end,
        )
      : undefined;
    await writeFileAtomic(
      join(result.dir, "comparisons.json"),
      JSON.stringify(
        {
          eligibility:
            "Descriptive offline references; this calculation does not assert scored-study eligibility",
          runStatus: result.summary.status,
          validDays: result.summary.validDays,
          invalidDays: result.summary.invalidDays,
          accountedDays: result.summary.committedDays,
          metricsScope: "All accounted days, including no-order valuation on invalid days.",
          metrics,
          cash,
          buyAndHold,
          ndx: ndx ? await compareNDX(ndx, records, contributions) : null,
        },
        null,
        2,
      ) + "\n",
    );
  }
}
