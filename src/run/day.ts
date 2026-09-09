// Simulates a single trading day under the causal convention (see
// engine/execution.ts): decision context is built from bars strictly before
// D, orders fill at D's OPEN, and end-of-day mark-to-market (net worth,
// termination check, equity curve point) uses D's CLOSE. The real Pi agent's
// buy()/sell() tool calls (agent/tools.ts) only ever QUEUE an OrderRequest —
// they never see or execute against D's open. Every order (fake or real
// agent) is executed here, against the SAME `executionPrices`, strictly
// AFTER decide() returns, so no order can ever condition on a D-open price
// inferred from an earlier order's fill within the same decision.

import { asOfBefore, closeOn, openOn } from "../data/ohlcv.ts";
import { computeIndicators } from "../data/indicators.ts";
import { executeOrder } from "../engine/execution.ts";
import { applyFill, isTerminated, valuePortfolio } from "../engine/portfolio.ts";
import type {
  AgentPort,
  DailyRecord,
  FailedOrder,
  Fill,
  Indicators,
  OhlcvBar,
  PortfolioState,
  RunConfig,
} from "../domain/types.ts";

const LOOKBACK_BARS = 60;

export async function runOneDay(
  agent: AgentPort,
  config: RunConfig,
  date: string,
  universe: readonly string[],
  portfolioBefore: PortfolioState,
  recentDays: DailyRecord[],
): Promise<DailyRecord> {
  // Decision context: bars/indicators strictly BEFORE D — D's own session
  // (open, close, volume) does not exist yet from the agent's point of view.
  const bars: Record<string, OhlcvBar[]> = {};
  const indicators: Record<string, Indicators> = {};
  for (const ticker of universe) {
    const series = await asOfBefore(ticker, date, LOOKBACK_BARS);
    bars[ticker] = series;
    indicators[ticker] = computeIndicators(series);
  }

  // Execution prices for D: its own open. Precomputed for the whole universe
  // so the real Pi agent's tools (agent/tools.ts) can fill at the identical
  // price this function uses to replay `decision.orders` below.
  const executionPrices: Record<string, number> = {};
  for (const ticker of universe) {
    const price = await openOn(ticker, date);
    if (price !== undefined) executionPrices[ticker] = price;
  }

  const startOfDayNetWorth = portfolioBefore.netWorth;

  // NOTE: `executionPrices` (D's own open) is deliberately NOT part of the
  // DecisionContext passed to agent.decide() — see domain/types.ts. It's
  // computed above only so the orders decide() returns can be replayed
  // against it below, strictly AFTER the agent has committed to its whole
  // day-D batch.
  const decision = await agent.decide({
    date,
    universe,
    portfolio: portfolioBefore,
    bars,
    indicators,
    recentDays,
    limits: config.limits,
  });

  let portfolio = portfolioBefore;
  const fills: Fill[] = [];
  const failedOrders: FailedOrder[] = [...decision.failedOrders];
  for (const order of decision.orders) {
    if (!universe.includes(order.ticker)) {
      failedOrders.push({ date, ticker: order.ticker, side: order.side, reason: `"${order.ticker}" is not in the trading universe.` });
      continue;
    }
    const price = executionPrices[order.ticker];
    if (price === undefined) {
      failedOrders.push({ date, ticker: order.ticker, side: order.side, reason: `No open price for ${order.ticker} on ${date}.` });
      continue;
    }
    const result = executeOrder(order, price, portfolio, date);
    if ("fill" in result) {
      portfolio = applyFill(portfolio, result.fill);
      fills.push(result.fill);
    } else {
      failedOrders.push(result.failed);
    }
  }

  // End-of-day mark-to-market at D's close — this is the netWorth that
  // appears on the equity curve and is checked for termination.
  const closes: Record<string, number> = {};
  for (const ticker of universe) closes[ticker] = await closeOn(ticker, date);
  portfolio = valuePortfolio(portfolio, (t) => closes[t] ?? portfolio.holdings[t]!.lastClose);

  const turnoverNotional = fills.reduce((sum, f) => sum + f.notional, 0);
  const turnoverPct = startOfDayNetWorth > 0 ? (turnoverNotional / startOfDayNetWorth) * 100 : 0;

  return {
    date,
    portfolioBefore,
    portfolioAfter: portfolio,
    fills,
    failedOrders,
    rationale: decision.rationale,
    usage: decision.usage,
    turnoverPct: Math.round(turnoverPct * 10000) / 10000,
    terminated: isTerminated(portfolio, config.startingCapital),
    boundedStop: decision.boundedStop,
    boundedReason: decision.boundedReason,
  };
}
