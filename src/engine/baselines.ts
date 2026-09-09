// Baselines a run is compared against: pure cash (no growth, no trades) and
// equal-weight buy-and-hold across the full universe. Buy-and-hold is routed
// through the SAME executeOrder/applyFill/valuePortfolio arithmetic agents
// use (see engine/execution.ts, engine/portfolio.ts) so it's never a
// separately-implemented, potentially-diverging notion of "fill" and
// "value" — it buys once at the first date's OPEN (the same convention an
// agent's day-one order would fill at) and is mark-to-market at every day's
// CLOSE, including day one.

import { closeOn, openOn } from "../data/ohlcv.ts";
import type { EquityPoint, OrderRequest, PortfolioState } from "../domain/types.ts";
import { executeOrder } from "./execution.ts";
import { applyFill, createInitialPortfolio, round2, valuePortfolio } from "./portfolio.ts";

export function cashBaseline(startingCapital: number, dates: readonly string[]): EquityPoint[] {
  const netWorth = round2(startingCapital);
  return dates.map((date) => ({ date, netWorth }));
}

export interface BuyAndHoldResult {
  equityCurve: EquityPoint[];
  /** Count of tickers that actually got a filled day-one BUY — NOT
   * universe.length: a ticker with no bar on `firstDate`, or whose per-ticker
   * slice is too small to clear the minimum notional, contributes zero
   * fills, and the baseline's tradeCount must reflect that instead of
   * silently overstating trades that never happened. */
  tradeCount: number;
  /** Turnover % per date, same definition as DailyRecord.turnoverPct (sum of
   * accepted fill notional / starting-of-day net worth * 100): the actual
   * day-one deployment (not always ~100% — some per-ticker slices can fail
   * the minimum notional), then 0 on every later date since buy-and-hold
   * never trades again. */
  turnoverPct: number[];
}

export async function buyAndHoldBaseline(
  startingCapital: number,
  universe: readonly string[],
  dates: readonly string[],
): Promise<BuyAndHoldResult> {
  if (dates.length === 0) return { equityCurve: [], tradeCount: 0, turnoverPct: [] };
  const perTicker = startingCapital / universe.length;
  const firstDate = dates[0]!;

  let portfolio: PortfolioState = createInitialPortfolio(startingCapital);
  let tradeCount = 0;
  let dayOneNotional = 0;
  for (const ticker of universe) {
    const price = await openOn(ticker, firstDate);
    if (price === undefined) continue;
    const order: OrderRequest = { ticker, side: "BUY", sizing: { kind: "notional", usd: perTicker } };
    const result = executeOrder(order, price, portfolio, firstDate);
    if ("fill" in result) {
      portfolio = applyFill(portfolio, result.fill);
      tradeCount++;
      dayOneNotional += result.fill.notional;
    }
  }
  const dayOneTurnoverPct = startingCapital > 0 ? Math.round((dayOneNotional / startingCapital) * 100 * 10000) / 10000 : 0;

  const equityCurve: EquityPoint[] = [];
  for (const date of dates) {
    const closes: Record<string, number> = {};
    for (const ticker of Object.keys(portfolio.holdings)) closes[ticker] = await closeOn(ticker, date);
    portfolio = valuePortfolio(portfolio, (t) => closes[t] ?? portfolio.holdings[t]!.lastClose);
    equityCurve.push({ date, netWorth: portfolio.netWorth });
  }
  const turnoverPct = dates.map((_, i) => (i === 0 ? dayOneTurnoverPct : 0));
  return { equityCurve, tradeCount, turnoverPct };
}
