import {
  loadDataset,
  validateDatasetWindow,
  type MarketDataset,
} from "../data/dataset.ts";
import { buyAndHoldBaseline } from "../engine/baselines.ts";
import { preparePortfolio } from "../engine/cashFlows.ts";
import { computeMetrics } from "../engine/metrics.ts";
import type {
  Contribution,
  DailyRecord,
  EquityPoint,
} from "../domain/types.ts";

/** Evaluator-only reference. It is never passed to the model or its broker. */
export async function loadNDX(
  dir: string,
  hash: string,
  start: string,
  end: string,
) {
  const market = await loadDataset(dir);
  if (
    market.version !== hash ||
    market.kind !== "historical" ||
    market.universe.length !== 1 ||
    market.universe[0] !== "NDX"
  )
    throw new Error("Reference must be the frozen historical NDX price index");
  const dates = validateDatasetWindow(market, start, end, 0, ["NDX"]);
  if (dates.some((date) => market.actionsOn(date).length))
    throw new Error(
      "NDX price-index reference must not contain dividends or splits",
    );
  return market;
}
export async function compareNDX(
  market: MarketDataset,
  records: DailyRecord[],
  contributions: readonly Contribution[],
) {
  const dates = records.map((r) => r.date);
  const reference = await buyAndHoldBaseline(
    500,
    ["NDX"],
    dates,
    contributions,
    market,
  );
  const metrics = computeMetrics(
    reference.equityCurve,
    500,
    reference.tradeCount,
    0,
    0,
    reference.turnoverPct,
  );
  const modelCurve = records.map((r) => ({
    date: r.date,
    netWorth: r.portfolioAfter.netWorth,
    contribution: r.contribution,
  }));
  const model = computeMetrics(
    modelCurve,
    500,
    records.reduce((n, r) => n + r.fills.length, 0),
    records.reduce((n, r) => n + r.failedOrders.length, 0),
    0,
    records.map((r) => r.turnoverPct),
  );
  const returns = (curve: readonly EquityPoint[]) => {
    let previous = 500;
    return curve.map((p) => {
      const denominator = previous + (p.contribution ?? 0);
      const r = denominator > 0 ? p.netWorth / denominator - 1 : 0;
      previous = p.netWorth;
      return r;
    });
  };
  const a = returns(modelCurve),
    b = returns(reference.equityCurve);
  const excess = a.map((x, i) => x - b[i]!);
  const mean = excess.length
    ? excess.reduce((n, x) => n + x, 0) / excess.length
    : 0;
  const sd =
    excess.length > 1
      ? Math.sqrt(
          excess.reduce((n, x) => n + (x - mean) ** 2, 0) / (excess.length - 1),
        )
      : 0;
  return {
    symbol: "NDX",
    returnType: "price-index",
    alignment:
      "model and hypothetical index units funded at session opens; valued at session closes",
    metrics,
    equityCurve: reference.equityCurve,
    openToFinalClosePct: dates.length
      ? (market.closeOn("NDX", dates.at(-1)!) /
          market.openOn("NDX", dates[0]!)! -
          1) *
        100
      : null,
    activeReturnPercentagePoints:
      model.timeWeightedReturnPct! - metrics.timeWeightedReturnPct!,
    trackingErrorAnnualizedPct: sd * Math.sqrt(252) * 100,
    informationRatio: sd ? (mean / sd) * Math.sqrt(252) : null,
    portfolioDividendCash: records.reduce(
      (n, r) =>
        n +
        preparePortfolio(r.portfolioBefore, 0, r.corporateActions ?? []).cash -
        r.portfolioBefore.cash,
      0,
    ),
    caveat:
      "The portfolio receives dividends; NDX is a price index. Index units are a hypothetical reference, not a tradable product.",
  };
}
