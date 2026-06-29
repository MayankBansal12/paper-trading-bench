// Termination check. Per the spec, a portfolio is "terminated" if total value
// (cash + holdings at last_traded_price) is < $10. We use last_traded_price
// here as a conservative estimate (no live price fetch on termination).

import type { PortfolioState } from "../types.ts";
import { TERMINATION_THRESHOLD } from "../state/portfolio.ts";

export function shouldTerminate(portfolio: PortfolioState): boolean {
  if (portfolio.status === "terminated") return true;
  const total = portfolio.current_balance + portfolio.holdings_value;
  return total < TERMINATION_THRESHOLD;
}

export { TERMINATION_THRESHOLD };
