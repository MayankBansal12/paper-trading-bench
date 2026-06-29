// Wrap-up prompt — injected after the agent's tool-calling loop ends.
// Asks the model to produce the daily summary in the exact markdown shape
// required by PRODUCT.md.

import type { PortfolioState } from "../types.ts";

export function buildWrapUpPrompt(date: string, portfolio: PortfolioState): string {
  return `Trading day ${date} is over. Tools are now closed for the day.

Final portfolio snapshot:
- Cash: $${portfolio.current_balance.toFixed(2)}
- Holdings: ${JSON.stringify(portfolio.holdings, null, 2)}
- Holdings value: $${portfolio.holdings_value.toFixed(2)}
- Net worth: $${portfolio.net_worth.toFixed(2)}
- Net P&L: $${portfolio.net_pnl.toFixed(2)}

Now write your daily summary as your FINAL message in this exact markdown
format. Do NOT call any more tools. The summary will be persisted to
\`results/summaries/${date}.md\` and is the only memory of this session
for future days.

\`\`\`markdown
# ${date}

## Decisions
- (Bullet list of trades made and why. Include ticker, units, price, rationale.)

## Reasoning
- (Why this strategy today? What signals drove the calls?)

## Portfolio Snapshot
- Cash: $X.XX
- Holdings: (one bullet per ticker: units, avg cost, last price, value)
- Net worth: $X.XX
- Net P&L: $X.XX

## Watchlist
- (Tickers you're tracking for the next session, with one-line notes.)

## Outlook
- (How you're positioning into tomorrow, what would change your mind.)
\`\`\``;
}
