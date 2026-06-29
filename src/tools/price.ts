// get_price — returns today's EOD price for a ticker (from cache or yahoo-finance2).
// Pure read. No side effects on portfolio.

import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { fetchEodPrice } from "../price/fetcher.ts";
import { BenchmarkError } from "../utils/errors.ts";
import type { TradingContext } from "./context.ts";

const Schema = Type.Object({
  stock: Type.String({
    description: "Stock ticker symbol, e.g. 'NVDA', 'AAPL'. Will be uppercased.",
  }),
});

export function buildGetPriceTool(
  ctx: TradingContext,
): ToolDefinition<typeof Schema, unknown> {
  return {
    name: "get_price",
    label: "Get Price",
    description:
      "Returns the end-of-day price for a given stock ticker on the current trading day. Uses a local cache and falls back to Yahoo Finance on miss. Returns an error if the ticker is invalid or the market has no data for that date.",
    parameters: Schema,
    execute: async (_id, params) => {
      try {
        const price = await fetchEodPrice(params.stock, ctx.date);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ticker: params.stock.toUpperCase(), date: ctx.date, price },
                null,
                2,
              ),
            },
          ],
          details: { ticker: params.stock.toUpperCase(), price },
        };
      } catch (e) {
        const msg = e instanceof BenchmarkError ? e.message : (e as Error).message;
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          isError: true,
          details: { error: msg },
        };
      }
    },
  };
}

export type GetPriceParams = Static<typeof Schema>;
