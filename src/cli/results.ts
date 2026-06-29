// `results` command. Pretty-prints the current portfolio + recent transactions
// + recent summaries to stdout. No model calls, no I/O beyond reads.

import { loadPortfolio, savePortfolio } from "../state/portfolio.ts";
import { readTransactions } from "../log/transactions.ts";
import { listSummaryDates, readSummary } from "../summary/manager.ts";
import { recalculateHoldingsValue } from "../state/valuation.ts";
import { fetchEodPrice } from "../price/fetcher.ts";
import { getToday } from "../utils/dates.ts";

const round2 = (n: number) => Math.round(n * 100) / 100;
const fmtUsd = (n: number) =>
  n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`;

function color(s: string, code: number): string {
  // ANSI escape codes — only when stdout is a TTY.
  if (!process.stdout.isTTY) return s;
  return `\x1b[${code}m${s}\x1b[0m`;
}

export async function runResults(): Promise<void> {
  const portfolio = await loadPortfolio();
  if (!portfolio) {
    console.error("[results] No portfolio found. Run `pnpm run start -- --model=<id>` first.");
    process.exit(1);
  }

  // Try to refresh prices — non-fatal if it fails.
  const today = getToday();
  let refreshed = portfolio;
  try {
    const priceMap = new Map<string, number>();
    for (const ticker of Object.keys(portfolio.holdings)) {
      try {
        const p = await fetchEodPrice(ticker, today);
        priceMap.set(ticker, p);
      } catch {
        // Use last_traded_price for this ticker.
      }
    }
    refreshed = recalculateHoldingsValue(portfolio, (t) => priceMap.get(t));
  } catch {
    refreshed = portfolio;
  }

  const pnlColor = refreshed.net_pnl >= 0 ? 32 : 31; // green / red
  const statusColor = refreshed.status === "terminated" ? 31 : 36; // red / cyan

  console.log();
  console.log("═══ PaperTrader Results ═══");
  console.log();
  console.log(`  Model:        ${refreshed.model ?? "(unknown)"}`);
  console.log(`  Start date:   ${refreshed.start_date}`);
  console.log(`  Last update:  ${refreshed.updated_at}`);
  console.log(`  Status:       ${color(refreshed.status, statusColor)}`);
  console.log();
  console.log("  Portfolio");
  console.log(`    Cash:            ${fmtUsd(refreshed.current_balance)}`);
  console.log(`    Holdings value:  ${fmtUsd(refreshed.holdings_value)}`);
  console.log(`    Net worth:       ${color(fmtUsd(refreshed.net_worth), 1)}`);
  console.log(`    Net P&L:         ${color(fmtUsd(refreshed.net_pnl), pnlColor)}  (${((refreshed.net_pnl / refreshed.opening_balance) * 100).toFixed(2)}%)`);
  console.log();

  const tickers = Object.keys(refreshed.holdings);
  if (tickers.length > 0) {
    console.log("  Holdings");
    for (const t of tickers.sort()) {
      const h = refreshed.holdings[t]!;
      console.log(
        `    ${t.padEnd(6, " ")}  ${String(h.units).padStart(5, " ")} units  @ avg $${h.avg_cost.toFixed(2).padStart(7, " ")}  (last $${h.last_traded_price.toFixed(2).padStart(7, " ")})  = $${h.value.toFixed(2).padStart(9, " ")}`,
      );
    }
    console.log();
  } else {
    console.log("  Holdings: (none — all cash)");
    console.log();
  }

  // Recent transactions (last 20)
  const txs = await readTransactions();
  if (txs.length > 0) {
    const recent = txs.slice(-20);
    console.log(`  Recent transactions (last ${recent.length} of ${txs.length})`);
    for (const t of recent) {
      const sign = t.side === "BUY" ? "B" : "S";
      console.log(
        `    [${sign}] ${t.date}  ${t.ticker.padEnd(6, " ")}  ${String(t.units).padStart(4, " ")} @ $${t.price.toFixed(2).padStart(7, " ")}  cash: ${fmtUsd(t.cash_remaining)}`,
      );
    }
    console.log();
  }

  // Recent summaries
  const dates = await listSummaryDates();
  if (dates.length > 0) {
    const recent = dates.slice(-5);
    console.log(`  Recent daily summaries (last ${recent.length} of ${dates.length})`);
    for (const d of recent) {
      const md = await readSummary(d);
      const preview = md ? md.split("\n").find((l) => l.startsWith("## ")) ?? "(no decisions header)" : "(missing)";
      console.log(`    ${d}  —  ${preview.replace(/^##\s*/, "")}`);
    }
    console.log();
  }

  // Persist refreshed prices back so the JSON state reflects the latest.
  if (refreshed !== portfolio) {
    try {
      await savePortfolio(refreshed);
    } catch {
      // Non-fatal — we still printed the report.
    }
  }
  // round2/fmtUsd retained for possible future use without unused-import warnings.
  void round2;
}
