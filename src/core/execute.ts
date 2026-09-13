import type { StudyAttempt } from "../study/agent.ts";
import type { ContextConfig } from "./context.ts";
import type { StudyRecord } from "./types.ts";
import type { MarketDataset } from "../data/dataset.ts";
import type { PortfolioState, Fill, FailedOrder } from "../domain/types.ts";
import { preparePortfolio, contributionOn } from "../engine/cashFlows.ts";
import { applyFill, valuePortfolio } from "../engine/portfolio.ts";
import { executeOrder } from "../engine/execution.ts";
import { STUDY_PROTOCOL } from "../study/protocol.ts";
export function executeAccepted(
  accepted: StudyAttempt,
  previous: PortfolioState,
  config: ContextConfig,
  market: MarketDataset,
  universe: readonly string[],
): StudyRecord {
  const date = accepted.scope.date,
    contribution = contributionOn(config.contributions, date),
    actions = market.actionsOn(date);
  let portfolio = preparePortfolio(previous, contribution, actions);
  const before = portfolio.netWorth;
  const fills: Fill[] = [],
    failed: FailedOrder[] = [];
  for (const order of accepted.decision.orders) {
    if (!universe.includes(order.ticker))
      throw new Error("Accepted order escaped universe");
    const price = market.openOn(order.ticker, date);
    if (price === undefined) throw new Error("Execution price missing");
    const r = executeOrder(order, price, portfolio, date);
    if ("fill" in r) {
      portfolio = applyFill(portfolio, r.fill);
      fills.push(r.fill);
    } else failed.push(r.failed);
  }
  portfolio = valuePortfolio(portfolio, (t) => market.closeOn(t, date));
  return {
    artifactVersion: STUDY_PROTOCOL,
    date,
    portfolioBefore: previous,
    portfolioAfter: portfolio,
    contribution,
    corporateActions: actions,
    fills,
    failedOrders: failed,
    turnoverPct: before
      ? (fills.reduce((n, f) => n + f.notional, 0) / before) * 100
      : 0,
    terminated: false,
    boundedStop: false,
    boundedReason: null,
  };
}
