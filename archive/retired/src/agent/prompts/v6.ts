// Frozen v6 prompt behavior: retained for historical replay. Never edit this
// module; introduce a new protocol instead.

import type { DecisionContext } from "../../domain/types.ts";

const MAX_RATIONALE_CHARS = 1200;
const RECENT_DAY_LIMIT = 5;

export function buildSystemPrompt(limits: DecisionContext["limits"]): string {
  return [
    "You are an autonomous paper-trading agent in a fixed-universe backtest benchmark.",
    "",
    "Rules:",
    "- You may only trade tickers returned by get_universe(). Orders for any other ticker fail.",
    "- Decide after the stated observation date's market close and before the stated execution date's market open. These are trading-session dates; weekends and exchange holidays are skipped.",
    "- Market tools return data only through the observation date's close. The execution date's open and all later prices are UNKNOWN to you. There is no intraday data or news/web search.",
    "- Buys and sells fill at the execution date's OPEN price after your decision finishes, with no fees and no slippage. Fractional shares are allowed; sizes round down to 6 decimal places.",
    "- Use technical price/volume evidence only; do not use recalled news or future events.",
    "- Orders execute in queue order; later sells cannot fund earlier buys. A failed or bounded decision executes no orders and is retried on the same day.",
    "- Sale proceeds become available immediately when that sale executes. Yesterday's close is NOT a guaranteed execution price: proceeds can be lower and purchases can cost more. Leave room for unknown opening prices when sizing dependent orders; queued orders do not update get_portfolio().",
    "- No short selling: you can only sell units you currently hold.",
    "- You have a hard budget for today: at most " + limits.maxTurns + " turns and " + limits.maxToolCalls + " attempted tool calls (including invalid or unknown calls). Reserve at least 2 tool calls for buy()/sell(); never spend the entire budget only researching.",
    "- Call get_indicators() ONCE with no ticker to screen the whole universe, then use get_ohlcv() only for a few finalists. Do not call get_indicators() ticker-by-ticker.",
    "",
    "Finish with a concise rationale of at most " + MAX_RATIONALE_CHARS + " characters total, using four labeled lines: Decision: (queued orders or hold); Evidence: (key observations); Risk: (main downside); Invalidation: (what would change your thesis). No tables or repeated universe rankings.",
    "The next session receives at most " + RECENT_DAY_LIMIT + " previous days. Each remembered rationale is limited to " + MAX_RATIONALE_CHARS + " characters; the full original response remains in the audit record.",
    "Describe orders as queued, never filled. Give your final rationale only after all tool calls; do not call more tools afterward.",
  ].join("\n");
}

export function rationaleForMemory(rationale: string): string {
  const marker = " [truncated]";
  return rationale.length <= MAX_RATIONALE_CHARS ? rationale : rationale.slice(0, MAX_RATIONALE_CHARS - marker.length) + marker;
}

export function buildDailyPrompt(ctx: DecisionContext): string {
  const observed = Object.values(ctx.bars).flatMap(bars => bars.at(-1)?.date ?? []).filter(date => date < ctx.date).sort().at(-1);
  const lines = [
    "Observation date: " + (observed ? observed + ", through market close" : "unavailable (no historical bars supplied)") + ".",
    "Execution date: " + ctx.date + ", at market open. Its opening prices are unknown.",
    "Make this decision between those two boundaries. Queue orders now; fills and execution-time rejections become known only after you finish.",
    "Cash: $" + ctx.portfolio.cash.toFixed(2) + " | Holdings value: $" + ctx.portfolio.holdingsValue.toFixed(2) + " | Net worth: $" + ctx.portfolio.netWorth.toFixed(2) + ".",
    "Holdings use the last observable prices; contributions and corporate actions due for the execution date have already been applied to this portfolio.",
  ];
  if (ctx.horizon) lines.push("Evaluation horizon: " + ctx.horizon.startDate + " through " + ctx.horizon.endDate + ".");
  if (ctx.contributions?.length) lines.push("External contribution schedule: " + ctx.contributions.map(c => c.date + ": $" + c.amount.toFixed(2)).join("; ") + ".");
  const heldTickers = Object.keys(ctx.portfolio.holdings);
  lines.push(heldTickers.length ? "Current holdings: " + heldTickers.join(", ") : "Current holdings: none (all cash)");
  if (ctx.recentDays.length) {
    lines.push("", "Your most recent decisions (actual fills take precedence over prior narrative):");
    for (const day of ctx.recentDays.slice(-RECENT_DAY_LIMIT)) {
      const fills = day.fills.length ? day.fills.map(f => f.side + " " + f.units + " " + f.ticker + " @ $" + f.price.toFixed(2)).join("; ") : "no trades";
      lines.push("- " + day.date + ": " + fills + " — " + JSON.stringify(rationaleForMemory(day.rationale)));
      if (day.failedOrders.length) lines.push("  Rejected orders: " + day.failedOrders.map(o => o.side + " " + o.ticker + ": " + o.reason).join("; "));
      if (day.boundedStop) lines.push("  Cutoff: " + (day.boundedReason ?? "budget exhausted"));
      if (day.submittedOrders?.length) lines.push("  Submitted requests: " + JSON.stringify(day.submittedOrders));
    }
  }
  lines.push("", "Call get_indicators() once without a ticker to screen the fixed universe. Investigate only a few finalists, then queue any orders before the tool budget is exhausted.",
    "If no trade has positive conviction, hold. Finish with Decision, Evidence, Risk, and Invalidation in at most " + MAX_RATIONALE_CHARS + " characters.");
  return lines.join("\n");
}
