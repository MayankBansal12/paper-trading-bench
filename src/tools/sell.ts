// sell(stock, units) — mirror of buy. Validates holdings, fetches price, mutates state.
//
// If the sell would bring units to 0 we drop the ticker from holdings entirely
// (cleaner portfolio view than leaving a zero-unit ghost).

import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { fetchEodPrice } from "../price/fetcher.ts";
import { recalculateHoldingsValue } from "../state/valuation.ts";
import { appendTransaction } from "../log/transactions.ts";
import {
  InvalidHoldingError,
  InvalidTickerError,
  PriceUnavailableError,
} from "../utils/errors.ts";
import type { TradingContext } from "./context.ts";

const Schema = Type.Object({
  stock: Type.String({ description: "Stock ticker, e.g. 'NVDA'. Uppercased." }),
  units: Type.Number({
    description:
      "Number of shares to sell. Must be a positive integer and <= units held.",
    minimum: 1,
  }),
});

const round2 = (n: number) => Math.round(n * 100) / 100;

export function buildSellTool(
  ctx: TradingContext,
): ToolDefinition<typeof Schema, unknown> {
  return {
    name: "sell",
    label: "Sell Stock",
    description:
      "Sells `units` shares of `stock` at the current EOD price. Validates you hold at least that many shares; if not, returns the actual units held so you can correct the order. If the sell fully closes the position, the ticker is removed from holdings. Updates portfolio state and appends to the transaction log.",
    parameters: Schema,
    executionMode: "sequential",
    execute: async (_id, params) => {
      const ticker = params.stock.toUpperCase();
      const units = Math.floor(params.units);
      if (units < 1) {
        return {
          content: [{ type: "text" as const, text: "Error: units must be >= 1" }],
          isError: true,
          details: { reason: "invalid_units" },
        };
      }

      const existing = ctx.portfolio.holdings[ticker];
      if (!existing || existing.units < units) {
        const err = new InvalidHoldingError(ticker, units, existing?.units ?? 0);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err.message}\nHoldings: ${JSON.stringify(ctx.portfolio.holdings)}`,
            },
          ],
          isError: true,
          details: {
            reason: "invalid_holding",
            ticker,
            requested: units,
            held: existing?.units ?? 0,
          },
        };
      }

      let price: number;
      try {
        price = await fetchEodPrice(ticker, ctx.date);
      } catch (e) {
        if (e instanceof InvalidTickerError || e instanceof PriceUnavailableError) {
          return {
            content: [{ type: "text" as const, text: `Error: ${e.message}` }],
            isError: true,
            details: { reason: "price_unavailable", ticker, date: ctx.date },
          };
        }
        throw e;
      }

      const proceeds = round2(price * units);
      const newUnits = existing.units - units;

      const newHoldings = { ...ctx.portfolio.holdings };
      if (newUnits === 0) {
        delete newHoldings[ticker];
      } else {
        newHoldings[ticker] = {
          ...existing,
          units: newUnits,
          last_traded_price: price,
          value: round2(price * newUnits),
        };
      }

      ctx.portfolio = recalculateHoldingsValue(
        {
          ...ctx.portfolio,
          current_balance: round2(ctx.portfolio.current_balance + proceeds),
          holdings: newHoldings,
        },
        () => price,
      );

      const cashRemaining = ctx.portfolio.current_balance;

      try {
        await appendTransaction({
          date: ctx.date,
          side: "SELL",
          ticker,
          units,
          price,
          cash_remaining: cashRemaining,
        });
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: portfolio updated in memory but transaction log write failed: ${(e as Error).message}`,
            },
          ],
          isError: true,
          details: { reason: "log_write_failed" },
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                action: "SELL",
                ticker,
                units,
                price,
                proceeds,
                cash_remaining: cashRemaining,
                net_worth: ctx.portfolio.net_worth,
                remaining_position: ctx.portfolio.holdings[ticker] ?? null,
              },
              null,
              2,
            ),
          },
        ],
        details: { action: "SELL", ticker, units, price, proceeds, cash_remaining: cashRemaining },
      };
    },
  };
}

export type SellParams = Static<typeof Schema>;
