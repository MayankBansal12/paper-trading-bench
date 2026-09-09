// Deterministic, offline, zero-token agent implementing the same AgentPort
// as the real Pi-backed agent. Used by every automated test and by
// `--agent=fake` so the whole pipeline can be exercised without network
// access or paid model calls.
//
// Strategy (intentionally simple — this is a test double, not a baseline
// worth benchmarking): SMA(20/50) crossover using only as-of indicators.
// Golden cross + no position -> buy a fixed slice of cash. Death cross +
// held position -> sell the whole position. Ties/insufficient history do
// nothing. Iterates the universe in its fixed order so output is stable.

import type { AgentDecision, AgentPort, DecisionContext, OrderRequest } from "../domain/types.ts";

const BUY_SLICE_OF_CASH = 0.1;

export class FakeAgent implements AgentPort {
  readonly name = "fake";

  async decide(ctx: DecisionContext): Promise<AgentDecision> {
    const orders: OrderRequest[] = [];
    let boundedStop = false;
    let boundedReason: string | null = null;

    for (const ticker of ctx.universe) {
      if (orders.length >= ctx.limits.maxToolCalls) {
        boundedStop = true;
        boundedReason = `max tool calls (${ctx.limits.maxToolCalls}) reached while scanning universe`;
        break;
      }
      const ind = ctx.indicators[ticker];
      if (!ind || ind.sma20 === null || ind.sma50 === null) continue;
      const holding = ctx.portfolio.holdings[ticker];
      const goldenCross = ind.sma20 > ind.sma50;

      if (goldenCross && !holding) {
        const usd = Math.floor(ctx.portfolio.cash * BUY_SLICE_OF_CASH * 100) / 100;
        if (usd >= 1) {
          orders.push({ ticker, side: "BUY", sizing: { kind: "notional", usd } });
        }
      } else if (!goldenCross && holding) {
        orders.push({ ticker, side: "SELL", sizing: { kind: "units", units: holding.units } });
      }
    }

    return {
      orders,
      failedOrders: [],
      rationale: `SMA(20/50) crossover: ${orders.length} order(s) on ${ctx.date}.`,
      usage: {
        turns: 1,
        toolCalls: orders.length,
        failedToolCalls: 0,
        promptTokens: 0,
        completionTokens: 0,
      },
      boundedStop,
      boundedReason,
    };
  }
}
