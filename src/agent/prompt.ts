// System + per-day prompt for the real Pi-backed agent. Kept text-only and
// declarative — all state the model needs is available via tools, not
// crammed into the prompt, so context stays small as a run progresses.

import type { DecisionContext } from "../domain/types.ts";

export function buildSystemPrompt(limits: DecisionContext["limits"]): string {
  return [
    "You are an autonomous paper-trading agent in a fixed-universe backtest benchmark.",
    "",
    "Rules:",
    "- You may only trade tickers returned by get_universe(). Orders for any other ticker fail.",
    "- Today's own price bar has not happened yet: get_ohlcv() and get_indicators() only return data through YESTERDAY's close. There is no intraday data, no news/web search, and no information about today's or any future close.",
    "- Buys and sells fill at TODAY's OPEN price (not yesterday's close, not today's close) with no fees and no slippage. Fractional shares are allowed; sizes round down to 6 decimal places.",
    "- No short selling: you can only sell units you currently hold.",
    `- You have a hard budget for today: at most ${limits.maxTurns} turns and ${limits.maxToolCalls} tool calls. Reserve at least 2 tool calls for buy()/sell(); never spend the entire budget only researching.`,
    "- Call get_indicators() ONCE with no ticker to screen the whole universe, then use get_ohlcv() only for a few finalists. Do not call get_indicators() ticker-by-ticker.",
    "- All market tools are strictly as-of yesterday — no look-ahead is possible.",
    "",
    "Each day, decide whether to buy, sell, or hold, then finish with a short rationale for your decisions as your final message (no further tool calls after it).",
  ].join("\n");
}

export function buildDailyPrompt(ctx: DecisionContext): string {
  const lines = [
    `Today is ${ctx.date}.`,
    `Cash: $${ctx.portfolio.cash.toFixed(2)} | Holdings value: $${ctx.portfolio.holdingsValue.toFixed(2)} | Net worth: $${ctx.portfolio.netWorth.toFixed(2)} (as of yesterday's close)`,
  ];
  const heldTickers = Object.keys(ctx.portfolio.holdings);
  lines.push(heldTickers.length > 0 ? `Current holdings: ${heldTickers.join(", ")}` : "Current holdings: none (all cash)");

  if (ctx.recentDays.length > 0) {
    lines.push("", "Your most recent decisions:");
    for (const day of ctx.recentDays) {
      const fillsDesc =
        day.fills.length > 0
          ? day.fills.map((f) => `${f.side} ${f.units} ${f.ticker} @ $${f.price.toFixed(2)}`).join("; ")
          : "no trades";
      lines.push(`- ${day.date}: ${fillsDesc} — "${day.rationale}"`);
    }
  }

  lines.push(
    "",
    "Call get_indicators() once without a ticker to screen all 50 stocks. Investigate only a few finalists, then place any buy()/sell() orders BEFORE the tool budget is exhausted.",
    "If no trade has positive conviction, hold. Finish with your rationale for today as plain text.",
  );
  return lines.join("\n");
}
