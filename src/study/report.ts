import { join } from "node:path";
import type { StudyConfig, runStudy } from "./runner.ts";
import { loadDataset, validateDatasetWindow } from "../data/dataset.ts";
import { writeFileAtomic } from "../utils/fs.ts";
import {
  renderJournalReview,
  tradeAnalysis,
  datasetGapAnalysis,
} from "./review.ts";
import { analyzeStudy } from "./analysis.ts";
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
  await writeFileAtomic(
    join(result.dir, "review.md"),
    renderJournalReview(records, result.attempts, market),
  );
  if (options.analysis)
    await writeFileAtomic(
      join(result.dir, "analysis.json"),
      JSON.stringify(
        {
          ...analyzeStudy(records, result.attempts),
          trades: records.flatMap((r, i) =>
            tradeAnalysis(r, result.attempts[i]!, market).map((t) => ({
              date: r.date,
              ...t,
            })),
          ),
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
