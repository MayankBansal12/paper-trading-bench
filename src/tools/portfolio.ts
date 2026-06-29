// get_portfolio — returns current cash, holdings, total value, P&L.
// Pure read. No side effects.

import { Type, type Static } from "typebox";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TradingContext } from "./context.ts";

const Schema = Type.Object({});

export function buildGetPortfolioTool(
  ctx: TradingContext,
): ToolDefinition<typeof Schema, unknown> {
  return {
    name: "get_portfolio",
    label: "Get Portfolio",
    description:
      "Returns the current portfolio state: cash balance, holdings (units, avg_cost, last_traded_price, value per ticker), total holdings value, net worth, and net P&L. Call this any time you need a current snapshot before making decisions.",
    parameters: Schema,
    execute: async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              date: ctx.date,
              cash: ctx.portfolio.current_balance,
              holdings: ctx.portfolio.holdings,
              holdings_value: ctx.portfolio.holdings_value,
              net_worth: ctx.portfolio.net_worth,
              net_pnl: ctx.portfolio.net_pnl,
              status: ctx.portfolio.status,
            },
            null,
            2,
          ),
        },
      ],
      details: { kind: "get_portfolio", net_worth: ctx.portfolio.net_worth },
    }),
  };
}

export type GetPortfolioParams = Static<typeof Schema>;
