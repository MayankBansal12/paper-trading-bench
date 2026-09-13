import type { DecisionContext } from "../domain/types.ts";
import { AGENT_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION, V6_PROTOCOL_VERSION, MAX_RATIONALE_CHARS, RECENT_DAY_LIMIT } from "./protocolVersion.ts";
import * as v5 from "./prompts/v5.ts";
import * as v6 from "./prompts/v6.ts";

function assertCurrent(version: string): void {
  if (version !== AGENT_PROTOCOL_VERSION) throw new Error("Unsupported agent protocol: " + version);
}

export function buildSystemPrompt(limits: DecisionContext["limits"], version = AGENT_PROTOCOL_VERSION): string {
  if (version === LEGACY_PROTOCOL_VERSION) return v5.buildSystemPrompt(limits);
  if (version === V6_PROTOCOL_VERSION) return v6.buildSystemPrompt(limits);
  assertCurrent(version);
  return [
    "You manage a paper portfolio in a fixed-universe, historical price/volume benchmark.",
    "",
    "Experiment contract:",
    "- You may buy, sell, or do nothing. You choose the securities, position sizes, cash retention, concentration, diversification, and turnover. There is no requirement to trade or to become fully invested.",
    "- You may only trade securities returned by get_universe(). Orders for anything else fail. Short selling and leverage are unavailable.",
    "- Decide after the stated observation session's close and before the stated execution session's open. Market tools expose nothing later than the observation close; the next open is unknown.",
    "- Queued orders execute in order at the execution-session open after your response, with no fees or modeled slippage. Fractional shares are allowed and sizes round down to 6 decimals.",
    "- Queued orders do not update get_portfolio(). A later sell cannot fund an earlier buy; a sale can fund only later queued orders. Opening gaps can make estimated proceeds lower or purchases more expensive than observation-close estimates.",
    "- Contributions and same-day supported corporate actions are already reflected in the portfolio shown for the decision. You are responsible for available cash, scheduled future contributions, drawdown exposure, portfolio balance, and sizing under unknown next-open prices.",
    "- Daily volume is historical context, not a fill guarantee. The simulator fills eligible orders at the open, while reporting your executed shares relative to that session's total volume as a liquidity-discipline diagnostic.",
    "- Use only supplied technical price/volume and portfolio evidence. Do not rely on recalled news, dates, corporate events, or future market knowledge.",
    "- A failed, timed-out, or budget-cutoff decision executes no orders and is retained as failed-attempt evidence.",
    "- Today's hard operational limits are " + limits.maxTurns + " model turns, " + limits.maxToolCalls + " attempted tool calls including invalid calls, and " + limits.timeoutMs + " ms. How you spend that budget is your choice.",
    "",
    "Finish with no further tool calls and a rationale of at most " + MAX_RATIONALE_CHARS + " characters using four labeled lines: Decision, Evidence, Risk, and Invalidation. Describe orders as queued, not filled.",
    "The next session receives at most " + RECENT_DAY_LIMIT + " prior days, with each rationale clipped to " + MAX_RATIONALE_CHARS + " characters. Complete responses and traces remain in the audit artifacts.",
  ].join("\n");
}

/** Deterministic memory excerpt; preserve full responses in authoritative artifacts. */
export function rationaleForMemory(rationale: string): string {
  const marker = " [truncated]";
  return rationale.length <= MAX_RATIONALE_CHARS ? rationale : rationale.slice(0, MAX_RATIONALE_CHARS - marker.length) + marker;
}

export function buildDailyPrompt(ctx: DecisionContext, version = AGENT_PROTOCOL_VERSION): string {
  if (version === LEGACY_PROTOCOL_VERSION) return v5.buildDailyPrompt(ctx);
  if (version === V6_PROTOCOL_VERSION) return v6.buildDailyPrompt(ctx);
  assertCurrent(version);
  const observed = Object.values(ctx.bars).flatMap(bars => bars.at(-1)?.date ?? []).filter(date => date < ctx.date).sort().at(-1);
  const lines = [
    "Observation session: " + (observed ? observed + " through close" : "unavailable (no historical bars supplied)") + ".",
    "Execution session: " + ctx.date + " at the unknown market open.",
    "Queue any orders before finishing; fills and execution-time rejections are revealed only afterward.",
    "Available cash: $" + ctx.portfolio.cash.toFixed(2) + " | Holdings: $" + ctx.portfolio.holdingsValue.toFixed(2) + " | Net worth: $" + ctx.portfolio.netWorth.toFixed(2) + ".",
    "The displayed portfolio includes contributions and supported corporate actions due before this execution open; holdings use the last observable closes.",
  ];
  if (ctx.horizon) lines.push("Fixed evaluation horizon: " + ctx.horizon.startDate + " through " + ctx.horizon.endDate + ".");
  if (ctx.contributions?.length) lines.push("External contribution schedule: " + ctx.contributions.map(c => c.date + ": $" + c.amount.toFixed(2)).join("; ") + ".");
  const heldTickers = Object.keys(ctx.portfolio.holdings);
  lines.push(heldTickers.length ? "Current holdings: " + heldTickers.join(", ") + "." : "Current holdings: none; the portfolio is all cash.");
  if (ctx.recentDays.length) {
    lines.push("", "Recent committed outcomes (fills override prior narrative):");
    for (const day of ctx.recentDays.slice(-RECENT_DAY_LIMIT)) {
      const fills = day.fills.length ? day.fills.map(f => f.side + " " + f.units + " " + f.ticker + " @ $" + f.price.toFixed(2)).join("; ") : "no trades";
      lines.push("- " + day.date + ": " + fills + " — " + JSON.stringify(rationaleForMemory(day.rationale)));
      if (day.failedOrders.length) lines.push("  Rejected: " + day.failedOrders.map(o => o.side + " " + o.ticker + ": " + o.reason).join("; "));
      if (day.boundedStop) lines.push("  Cutoff: " + (day.boundedReason ?? "budget exhausted"));
      if (day.submittedOrders?.length) lines.push("  Submitted: " + JSON.stringify(day.submittedOrders));
    }
  }
  lines.push("",
    "Choose freely whether and how to inspect the market and whether to change the portfolio. Account for cash, future contributions, concentration, drawdown, liquidity, and unknown execution prices.",
    "Finish with Decision, Evidence, Risk, and Invalidation in at most " + MAX_RATIONALE_CHARS + " characters.");
  return lines.join("\n");
}
