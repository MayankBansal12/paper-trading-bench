// buy(stock, units) — validate cash → fetch price → mutate in-memory state → append log.
// MUTATES ctx.portfolio. Does NOT persist to disk (orchestrator does that once
// at end of session).
//
// Per spec, we recompute holdings value after every mutation so net_worth
// reflects the new position immediately.

import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { fetchEodPrice } from "../price/fetcher.ts";
import { recalculateHoldingsValue } from "../state/valuation.ts";
import { appendTransaction } from "../log/transactions.ts";
import {
  InsufficientCashError,
  InvalidTickerError,
  PriceUnavailableError,
} from "../utils/errors.ts";
import type { TradingContext } from "./context.ts";

const Schema = Type.Object({
  stock: Type.String({ description: "Stock ticker, e.g. 'NVDA'. Uppercased." }),
  units: Type.Number({
    description: "Number of shares to buy. Must be a positive integer.",
    minimum: 1,
  }),
});

const round2 = (n: number) => Math.round(n * 100) / 100;

export function buildBuyTool(
  ctx: TradingContext,
): ToolDefinition<typeof Schema, unknown> {
  return {
    name: "buy",
    label: "Buy Stock",
    description:
      "Buys `units` shares of `stock` at the current EOD price. Validates you have enough cash; if not, returns your current cash and holdings so you can decide what to sell first. Updates portfolio state immediately and appends to the transaction log. EOD price is the execution price (no slippage, no fees).",
    parameters: Schema,
    executionMode: "sequential", // must not race with sell or another buy on the same ticker
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

      const cost = round2(price * units);
      if (ctx.portfolio.current_balance < cost) {
        const err = new InsufficientCashError(cost, ctx.portfolio.current_balance);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err.message}\nHoldings: ${JSON.stringify(ctx.portfolio.holdings)}`,
            },
          ],
          isError: true,
          details: {
            reason: "insufficient_cash",
            needed: cost,
            available: ctx.portfolio.current_balance,
            holdings: ctx.portfolio.holdings,
          },
        };
      }
      // Mutate holdings: bump units, weighted avg_cost, last_traded_price, value.
      const existing = ctx.portfolio.holdings[ticker];
      const newUnits = (existing?.units ?? 0) + units;
      const newAvgCost = existing
        ? (existing.units * existing.avg_cost + units * price) / newUnits
        : price;

      // Build the candidate portfolio for THIS buy. We use the new buy's price
      // for the just-bought ticker, but keep existing last_traded_price for
      // other tickers (we don't have fresh prices for them in this handler).
      // recalculateHoldingsValue is called WITHOUT a priceLookup, so it falls
      // back to last_traded_price for any ticker not given an override.
      const candidate: typeof ctx.portfolio = {
        ...ctx.portfolio,
        current_balance: round2(ctx.portfolio.current_balance - cost),
        holdings: {
          ...ctx.portfolio.holdings,
          [ticker]: {
            units: newUnits,
            avg_cost: round2(newAvgCost),
            last_traded_price: price,
            value: round2(price * newUnits),
          },
        },
      };

      // Provide price lookup that returns the new buy's price for the just-bought
      // ticker and falls back to the candidate's last_traded_price for everything
      // else (preserves existing tickers' last prices).
      ctx.portfolio = recalculateHoldingsValue(
        candidate,
        (t) => (t === ticker ? price : candidate.holdings[t]?.last_traded_price),
      );

      const cashRemaining = ctx.portfolio.current_balance;

      try {
        await appendTransaction({
          date: ctx.date,
          side: "BUY",
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
                action: "BUY",
                ticker,
                units,
                price,
                cost,
                cash_remaining: cashRemaining,
                net_worth: ctx.portfolio.net_worth,
                new_position: ctx.portfolio.holdings[ticker] ?? null,
              },
              null,
              2,
            ),
          },
        ],
        details: { action: "BUY", ticker, units, price, cost, cash_remaining: cashRemaining },
      };
    },
  };
}

export type BuyParams = Static<typeof Schema>;
