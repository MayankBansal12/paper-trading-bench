// `start` command. Wires everything together:
//   1. Parse --model flag (default: kimi-k2.6)
//   2. Load (or initialize) the portfolio
//   3. Check termination
//   4. Build a TradingContext + pi session
//   5. Run the trading day
//   6. Write summary to results/summaries/YYYY-MM-DD.md FIRST
//   7. Save portfolio state atomically (only after success)
//
// Per spec: "results/summaries/YYYY-MM-DD.md" is written first, then
// "portfolio-state.json". A crash mid-session leaves the prior state intact.

import {
  createInitialPortfolio,
  loadPortfolio,
  savePortfolio,
} from "../state/portfolio.ts";
import { writeSummary } from "../summary/manager.ts";
import { getToday } from "../utils/dates.ts";
import { createTradingSession } from "../agent/session.ts";
import { runTradingDay } from "../agent/loop.ts";
import { shouldTerminate } from "../agent/termination.ts";
import type { TradingContext } from "../tools/registry.ts";

export async function runStart(modelId: string): Promise<void> {
  // 1. Load or init portfolio
  let portfolio = await loadPortfolio();
  if (!portfolio) {
    portfolio = createInitialPortfolio(modelId);
    console.error(`[start] No existing portfolio. Initialized with $${portfolio.opening_balance.toFixed(2)} (model: ${modelId}, date: ${portfolio.start_date}).`);
  }

  // 2. Stamp this run's model onto the portfolio (so results show who ran it).
  portfolio = { ...portfolio, model: modelId };

  const date = getToday();

  // 3. Termination check. Per spec, "Subsequent runs on a terminated
  //    portfolio exit immediately." We use shouldTerminate (which also
  //    catches net_worth < threshold even if status flag is stale).
  if (shouldTerminate(portfolio)) {
    console.log(`[start] Portfolio is terminated (net worth: $${portfolio.net_worth.toFixed(2)}, status: ${portfolio.status}). Nothing to do.`);
    return;
  }

  // 4. Build context + session
  const ctx: TradingContext = { portfolio, date, model: modelId };
  console.error(`[start] Starting trading day ${date} with model ${modelId}...`);
  const session = await createTradingSession(modelId, ctx);

  try {
    // 5. Run the day. Tools mutate ctx.portfolio in place; we pass ctx
    //    so runTradingDay reads back the post-trade state.
    const result = await runTradingDay(session, ctx, portfolio);

    // 6. Write summary FIRST (spec requirement)
    if (result.dailySummary) {
      await writeSummary(date, result.dailySummary);
      console.error(`[start] Daily summary written to results/summaries/${date}.md`);
    } else {
      console.warn(`[start] WARNING: model did not produce a daily summary. Portfolio state will still be saved.`);
    }

    // 7. Save updated portfolio state (atomic, only after success)
    await savePortfolio(result.portfolio);
    console.error(
      `[start] Portfolio saved. Net worth: $${result.portfolio.net_worth.toFixed(2)} (P&L: $${result.portfolio.net_pnl.toFixed(2)}, status: ${result.portfolio.status}).`,
    );

    if (result.terminated) {
      console.error(`[start] Portfolio terminated (net worth < $10). Subsequent runs will exit immediately.`);
    }
  } finally {
    session.dispose();
  }
}
