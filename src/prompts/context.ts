// Opening user prompt — injected at session start. Bundles:
//   1. The current portfolio state (so the model knows exactly where it stands)
//   2. The weekly summary (its memory)
//   3. The trading date and a clear instruction to begin

import type { PortfolioState } from "../types.ts";
import { getWeeklySummaries } from "../summary/manager.ts";

export async function buildOpeningPrompt(
  date: string,
  portfolio: PortfolioState,
): Promise<string> {
  const summaries = await getWeeklySummaries(date);

  const portfolioBlock = `Current portfolio (as of ${date}):
- Cash: $${portfolio.current_balance.toFixed(2)}
- Holdings: ${JSON.stringify(portfolio.holdings, null, 2)}
- Holdings value: $${portfolio.holdings_value.toFixed(2)}
- Net worth: $${portfolio.net_worth.toFixed(2)}
- Net P&L: $${portfolio.net_pnl.toFixed(2)}
- Status: ${portfolio.status}`;

  const memoryBlock = summaries.length === 0
    ? "No prior daily summaries on record. This is your first session — start fresh."
    : `Recent daily summaries (your memory, oldest → newest):\n\n${summaries.map((md, i) => `--- Summary ${i + 1} of ${summaries.length} ---\n${md.trim()}`).join("\n\n")}`;

  return `Trading day: ${date}

${portfolioBlock}

${memoryBlock}

Begin. Decide what to do today. You may use the tools as many times as you want.
When you are finished with all trades for the day and ready to write the daily
summary, simply stop calling tools — the next prompt will ask you for the summary.`;
}
