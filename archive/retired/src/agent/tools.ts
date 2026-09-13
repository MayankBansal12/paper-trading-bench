// The 6 tools exposed to the real Pi-backed agent. Deliberately NOT 7 — no
// news/web search tool exists in v0 (spec requirement). Tools operate on a
// mutable `PiWorkingState`, but that mutation is limited to bookkeeping
// (queued orders, failed orders, budget) — the causal boundary is enforced
// by NEVER exposing D's own open price (the execution price) anywhere in
// this file. buy()/sell() only validate what's knowable without it (ticker
// membership, sizing shape) and queue an OrderRequest; get_portfolio always
// reports the SAME pre-D portfolio for the whole session, regardless of
// anything queued. Actual pricing, cash/holdings sufficiency, and fills
// happen entirely in run/day.ts's replay AFTER decide() returns (see
// agent/piAgent.ts), so no order — including a later one in the same
// session — can ever condition on a D-open price inferred from an earlier
// order's fill.
//
// get_ohlcv/get_indicators only ever see bars strictly BEFORE today (D-1 and
// earlier — see data/ohlcv.ts asOfBefore()).

import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { FailedOrder, Indicators, OhlcvBar, OrderRequest, PortfolioState } from "../domain/types.ts";
import type { TurnBudget } from "./limits.ts";

/** Exact tool names exposed to the real agent — the single source of truth
 * for the explicit allowlist passed to `createAgentSession({ tools })` in
 * agent/piAgent.ts, so the active tool set can never silently drift from
 * what this file actually registers. */
export const TRADING_TOOL_NAMES = ["get_portfolio", "get_universe", "get_ohlcv", "get_indicators", "buy", "sell"] as const;

export interface PiWorkingState {
  date: string;
  universe: readonly string[];
  bars: Record<string, OhlcvBar[]>;
  indicators: Record<string, Indicators>;
  /** The portfolio as of D-1's close — the state the agent is entitled to
   * see. Never mutated during the session: orders are queued, not executed,
   * so this can never leak a D-open-derived value back to the agent. */
  portfolio: PortfolioState;
  decidedOrders: OrderRequest[];
  failedOrders: FailedOrder[];
  budget: TurnBudget;
  /** Live SDK accounts attempts/results before validation; direct unit tools use local counters. */
  externalAccounting?: boolean;
}

const err = (text: string, details: Record<string, unknown> = {}) => ({
  content: [{ type: "text" as const, text }],
  isError: true,
  details: { ...details, rejected: true },
});
const ok = (data: unknown, details: Record<string, unknown> = {}) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  details,
});

/** Every tool goes through this first. Returns an error result if the day's
 * budget is already spent — WITHOUT recording another tool call: a
 * non-cooperative agent hammering tools after being told to stop must never
 * push usage.toolCalls past the advertised cap. */
function budgetGate(state: PiWorkingState) {
  if (state.externalAccounting) return null;
  const reason = state.budget.exceeded(Date.now());
  if (reason) {
    state.budget.recordRefusal(reason);
    return err(`Budget exceeded (${reason}). Stop calling tools and give your final rationale now.`, { reason });
  }
  return null;
}

/** Reject and record a trade call that fails a causally-safe (price-free)
 * check — unknown ticker or malformed sizing. Recorded immediately in
 * `state.failedOrders` (not deferred to replay) since the agent gets
 * synchronous feedback and every rejected attempt must be visible in the
 * day's failedOrderCount, per PRODUCT.md. */
function rejectTradeCall(state: PiWorkingState, side: "BUY" | "SELL", ticker: string, reason: string) {
  recordToolCall(state, true);
  state.failedOrders.push({ date: state.date, ticker, side, reason });
  return err(reason, { ticker, side });
}

function recordToolCall(state: PiWorkingState, failed: boolean) {
  if (!state.externalAccounting) state.budget.recordToolCall(failed);
}

function sizeOf(params: { notionalUsd?: number; units?: number }): OrderRequest["sizing"] | null {
  if (params.notionalUsd !== undefined && params.units !== undefined) return null;
  if (params.notionalUsd !== undefined) {
    return Number.isFinite(params.notionalUsd) && params.notionalUsd > 0 ? { kind: "notional", usd: params.notionalUsd } : null;
  }
  if (params.units !== undefined) {
    return Number.isFinite(params.units) && params.units > 0 ? { kind: "units", units: params.units } : null;
  }
  return null;
}

function tradeTool(state: PiWorkingState, side: "BUY" | "SELL"): ToolDefinition {
  const Schema = Type.Object({
    ticker: Type.String({ description: "Ticker from get_universe(). Case-sensitive." }),
    notionalUsd: Type.Optional(Type.Number({ description: "USD amount to trade. Provide this OR units, not both." })),
    units: Type.Optional(Type.Number({ description: "Exact share count (fractional allowed). Provide this OR notionalUsd." })),
  });
  return {
    name: side === "BUY" ? "buy" : "sell",
    label: side === "BUY" ? "Buy" : "Sell",
    description:
      `Queue a ${side === "BUY" ? "buy" : "sell"} order for today. Provide exactly one of notionalUsd or units. ` +
      "You will NOT see today's open price, a fill, or an updated portfolio during this session — every order you " +
      "queue today (across every buy/sell call) executes in queue order at today's open, only after you finish with your " +
      "final rationale. Later sells cannot fund earlier buys. Failed or bounded decisions execute no orders. get_portfolio always reflects yesterday's close, never anything queued this session. An order " +
      "can still fail at execution time (e.g. insufficient cash) — that is reported in the run's failed-order count, " +
      "not visible to you mid-session.",
    parameters: Schema,
    executionMode: "sequential",
    execute: async (_id, params: Static<typeof Schema>) => {
      const gated = budgetGate(state);
      if (gated) return gated;

      const ticker = params.ticker;
      if (!state.universe.includes(ticker)) {
        return rejectTradeCall(state, side, ticker, `"${ticker}" is not in the trading universe.`);
      }
      const sizing = sizeOf(params);
      if (!sizing) {
        return rejectTradeCall(state, side, ticker, "Provide exactly one of notionalUsd or units, and it must be positive.");
      }

      state.decidedOrders.push({ ticker, side, sizing });
      recordToolCall(state, false);
      return ok({ queued: true, ticker, side, sizing });
    },
  };
}

export function buildTradingTools(state: PiWorkingState): ToolDefinition[] {
  return [
    {
      name: "get_portfolio",
      label: "Get Portfolio",
      description: "Cash, holdings, and net worth as of yesterday's close. Never reflects orders queued this session.",
      parameters: Type.Object({}),
      execute: async () => {
        const gated = budgetGate(state);
        if (gated) return gated;
        recordToolCall(state, false);
        return ok(state.portfolio);
      },
    },
    {
      name: "get_universe",
      label: "Get Universe",
      description: "The fixed list of tickers you may trade.",
      parameters: Type.Object({}),
      execute: async () => {
        const gated = budgetGate(state);
        if (gated) return gated;
        recordToolCall(state, false);
        return ok(state.universe);
      },
    },
    {
      name: "get_ohlcv",
      label: "Get OHLCV",
      description: "As-of daily OHLCV bars for a ticker, oldest first, through yesterday's close only (today has not happened yet).",
      parameters: Type.Object({
        ticker: Type.String(),
        lookback: Type.Optional(Type.Number({ description: "Max bars to return, most recent first truncation." })),
      }),
      execute: async (_id, params: { ticker: string; lookback?: number }) => {
        const gated = budgetGate(state);
        if (gated) return gated;
        const bars = state.bars[params.ticker];
        if (!bars) {
          recordToolCall(state, true);
          return err(`"${params.ticker}" is not in the trading universe.`, { ticker: params.ticker });
        }
        recordToolCall(state, false);
        const slice = params.lookback ? bars.slice(Math.max(0, bars.length - params.lookback)) : bars;
        return ok(slice);
      },
    },
    {
      name: "get_indicators",
      label: "Get Indicators",
      description: "As-of SMA20, SMA50, RSI14 and last observable close/date through yesterday. Omit ticker to screen the entire fixed universe in one call; provide ticker for one stock.",
      parameters: Type.Object({ ticker: Type.Optional(Type.String()) }),
      execute: async (_id, params: { ticker?: string }) => {
        const gated = budgetGate(state);
        if (gated) return gated;
        const snapshot = (ticker: string) => {
          const bars = state.bars[ticker] ?? [];
          const last = bars.at(-1);
          return { ...state.indicators[ticker], lastClose: last?.close ?? null, lastDate: last?.date ?? null };
        };
        if (params.ticker === undefined) {
          recordToolCall(state, false);
          return ok(Object.fromEntries(state.universe.map((ticker) => [ticker, snapshot(ticker)])));
        }
        if (!state.indicators[params.ticker]) {
          recordToolCall(state, true);
          return err(`"${params.ticker}" is not in the trading universe.`, { ticker: params.ticker });
        }
        recordToolCall(state, false);
        return ok(snapshot(params.ticker));
      },
    },
    tradeTool(state, "BUY"),
    tradeTool(state, "SELL"),
  ];
}
