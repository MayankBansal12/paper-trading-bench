// Performance metrics computed from a run's equity curve. rf = 0 throughout;
// annualization assumes 252 trading days/year (standard convention, not
// derived from the fixture calendar length).
//
// `startingCapital` is treated as the pre-first-day equity point for BOTH
// drawdown and daily-return purposes (see `seedWithStartingCapital` below) —
// otherwise a first-day loss (e.g. $1,000 -> $500) would report a -50%
// totalReturnPct but a 0% maxDrawdownPct, and the first day's return would
// be silently excluded from volatility/Sharpe. This only affects internal
// computation; the returned `curve`/`daysRun` still has exactly one point
// per simulated day, never a synthetic day 0.

import type { EquityPoint, Metrics } from "../domain/types.ts";

const TRADING_DAYS_PER_YEAR = 252;
const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** Prepends a synthetic pre-first-day point at `startingCapital` — internal
 * to metrics computation only, never part of the persisted equity curve. */
function seedWithStartingCapital(curve: readonly EquityPoint[], startingCapital: number): EquityPoint[] {
  return [{ date: "(start)", netWorth: startingCapital }, ...curve];
}

function dailyReturns(curve: readonly EquityPoint[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1]!.netWorth;
    const cur = curve[i]!.netWorth;
    out.push(prev === 0 ? 0 : cur / prev - 1);
  }
  return out;
}

function stdev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

function maxDrawdownPct(curve: readonly EquityPoint[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const p of curve) {
    peak = Math.max(peak, p.netWorth);
    if (peak > 0) worst = Math.min(worst, (p.netWorth - peak) / peak);
  }
  return round4(worst * 100);
}

export function computeMetrics(
  curve: readonly EquityPoint[],
  startingCapital: number,
  tradeCount: number,
  failedOrderCount: number,
  boundedStopCount: number,
  turnoverPctSeries: readonly number[],
): Metrics {
  const ending = curve.length > 0 ? curve[curve.length - 1]!.netWorth : startingCapital;
  const seeded = seedWithStartingCapital(curve, startingCapital);
  const rets = dailyReturns(seeded);
  const dailyVol = stdev(rets);
  const meanRet = rets.length > 0 ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const sharpe = dailyVol > 0 ? round4((meanRet / dailyVol) * Math.sqrt(TRADING_DAYS_PER_YEAR)) : null;
  const avgTurnover =
    turnoverPctSeries.length > 0
      ? round4(turnoverPctSeries.reduce((a, b) => a + b, 0) / turnoverPctSeries.length)
      : 0;

  return {
    startingCapital: round2(startingCapital),
    endingNetWorth: round2(ending),
    totalReturnPct: round4((ending / startingCapital - 1) * 100),
    maxDrawdownPct: maxDrawdownPct(seeded),
    dailyVolatilityPct: round4(dailyVol * 100),
    annualizedVolatilityPct: round4(dailyVol * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100),
    sharpe,
    avgTurnoverPct: avgTurnover,
    tradeCount,
    failedOrderCount,
    boundedStopCount,
    daysRun: curve.length,
  };
}
