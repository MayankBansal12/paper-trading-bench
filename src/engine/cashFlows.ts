import type { Contribution, CorporateActionEvent, PortfolioState } from "../domain/types.ts";
import { MAX_MONEY_USD, MAX_UNITS } from "./money.ts";
import { round2, roundUnits, valuePortfolio } from "./portfolio.ts";

export function contributionOn(contributions: readonly Contribution[] = [], date: string): number {
  return round2(contributions.filter((c) => c.date === date).reduce((sum, c) => sum + c.amount, 0));
}

export function validateContributions(contributions: readonly Contribution[], dates: readonly string[]): void {
  const seen = new Set<string>();
  for (const c of contributions) {
    if (!dates.includes(c.date) || seen.has(c.date) || !Number.isFinite(c.amount) || c.amount <= 0 || c.amount > MAX_MONEY_USD || round2(c.amount) !== c.amount) {
      throw new Error(`Invalid or duplicate contribution on ${c.date}: deposits require a unique evaluation date and positive whole-cent amount.`);
    }
    seen.add(c.date);
  }
}

/** Ex-date dividend cash and splits apply to prior holdings, before orders.
 * Splits precede dividends on a shared date; dividends are per post-split share.
 * Fractional split quantities round to the engine's six-decimal share grid. */
export function preparePortfolio(previous: PortfolioState, contribution: number, actions: readonly CorporateActionEvent[]): PortfolioState {
  if (!Number.isFinite(contribution) || contribution < 0 || round2(contribution) !== contribution) throw new Error("Invalid external contribution");
  let portfolio = structuredClone(previous);
  portfolio.cash = round2(portfolio.cash + contribution);
  for (const action of [...actions].sort((a, b) => Number(a.type === "dividend") - Number(b.type === "dividend"))) {
    const n = action.type === "split" ? action.ratio : action.amount;
    if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid corporate action for ${action.ticker}`);
    const holding = portfolio.holdings[action.ticker];
    if (!holding) continue;
    if (action.type === "split") {
      const units = roundUnits(holding.units * action.ratio);
      if (units <= 0 || units > MAX_UNITS) throw new Error(`Split share count outside supported domain for ${action.ticker}`);
      holding.units = units;
      holding.avgCost /= action.ratio;
      holding.lastClose /= action.ratio;
    } else {
      portfolio.cash = round2(portfolio.cash + round2(holding.units * action.amount));
    }
  }
  if (!Number.isFinite(portfolio.cash) || portfolio.cash < 0 || portfolio.cash > MAX_MONEY_USD) throw new Error("Cash after contribution/actions outside supported domain");
  return valuePortfolio(portfolio, (ticker) => portfolio.holdings[ticker]!.lastClose);
}
