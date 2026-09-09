import { loadDataset, type MarketDataset } from "../data/dataset.ts";
import type { Contribution, EquityPoint, PortfolioState } from "../domain/types.ts";
import { executeOrder } from "./execution.ts";
import { applyFill, createInitialPortfolio, round2, valuePortfolio } from "./portfolio.ts";
import { contributionOn, preparePortfolio } from "./cashFlows.ts";

export function cashBaseline(startingCapital: number, dates: readonly string[], contributions: readonly Contribution[] = []): EquityPoint[] {
  let netWorth = round2(startingCapital);
  return dates.map((date) => {
    const contribution = contributionOn(contributions, date);
    netWorth = round2(netWorth + contribution);
    return { date, netWorth, ...(contribution ? { contribution } : {}) };
  });
}

export interface BuyAndHoldResult {
  equityCurve: EquityPoint[];
  tradeCount: number;
  turnoverPct: number[];
  finalPortfolio?: PortfolioState;
}

/** Equal-weight purchases at the first open and each deposit day's open.
 * Dividend cash is retained. Existing positions are never rebalanced. */
export async function buyAndHoldBaseline(startingCapital: number, universe: readonly string[], dates: readonly string[], contributions: readonly Contribution[] = [], dataset?: MarketDataset): Promise<BuyAndHoldResult> {
  if (!dates.length) return { equityCurve: [], tradeCount: 0, turnoverPct: [] };
  const market = dataset ?? await loadDataset();
  let portfolio = createInitialPortfolio(startingCapital);
  let tradeCount = 0;
  const equityCurve: EquityPoint[] = [], turnoverPct: number[] = [];
  for (const [i, date] of dates.entries()) {
    const contribution = contributionOn(contributions, date);
    portfolio = preparePortfolio(portfolio, contribution, market.actionsOn(date));
    const before = portfolio.netWorth;
    const budget = (i === 0 ? startingCapital : 0) + contribution;
    let notional = 0;
    if (budget > 0) for (const ticker of universe) {
      const price = market.openOn(ticker, date);
      if (price === undefined) continue;
      const result = executeOrder({ ticker, side: "BUY", sizing: { kind: "notional", usd: budget / universe.length } }, price, portfolio, date);
      if ("fill" in result) { portfolio = applyFill(portfolio, result.fill); tradeCount++; notional += result.fill.notional; }
    }
    portfolio = valuePortfolio(portfolio, (t) => market.closeOn(t, date));
    equityCurve.push({ date, netWorth: portfolio.netWorth, ...(contribution ? { contribution } : {}) });
    turnoverPct.push(before > 0 ? Math.round(notional / before * 1e6) / 1e4 : 0);
  }
  return { equityCurve, tradeCount, turnoverPct, finalPortfolio: portfolio };
}
