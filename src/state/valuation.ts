// Valuation: recompute holdings_value + net_worth from a price lookup.
// Pure function — caller passes in prices (typically {getPrice(ticker, date)} from price/cache).
//
// We round monetary values to 2 decimal places at the boundary so JSON state
// stays clean and equality checks are stable.

import type { PortfolioState } from "../types.ts";

const round2 = (n: number) => Math.round(n * 100) / 100;

export type PriceLookup = (ticker: string) => number | undefined;

export function recalculateHoldingsValue(
  state: PortfolioState,
  priceLookup: PriceLookup,
): PortfolioState {
  let holdingsValue = 0;
  const holdings = { ...state.holdings };

  for (const [ticker, h] of Object.entries(holdings)) {
    const price = priceLookup(ticker);
    if (price === undefined) {
      // No fresh price — fall back to last_traded_price so net_worth stays defined.
      holdingsValue += h.last_traded_price * h.units;
      continue;
    }
    const value = round2(price * h.units);
    holdings[ticker] = { ...h, last_traded_price: price, value };
    holdingsValue += value;
  }

  const netWorth = round2(state.current_balance + holdingsValue);
  const netPnl = round2(netWorth - state.opening_balance);

  return {
    ...state,
    holdings,
    holdings_value: round2(holdingsValue),
    net_worth: netWorth,
    net_pnl: netPnl,
  };
}
