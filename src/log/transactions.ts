// Append-only transaction log. One line per trade, exact format from PRODUCT.md:
//
//   2026-07-01 | BUY  | NVDA | 2 units @ $131.20 | cash remaining: $737.60
//
// We never read this back into the model context (the spec forbids that —
// summaries are the memory layer). It's the human audit trail.

import { appendFile, readFile } from "node:fs/promises";
import { TRANSACTIONS_FILE } from "../utils/paths.ts";
import { ensureDir } from "../utils/fs.ts";
import type { TransactionEntry } from "../types.ts";

const round2 = (n: number) => Math.round(n * 100) / 100;

export function formatTransactionLine(e: TransactionEntry): string {
  const side = e.side.padEnd(4, " ");
  return `${e.date} | ${side} | ${e.ticker} | ${e.units} units @ $${round2(e.price).toFixed(2)} | cash remaining: $${round2(e.cash_remaining).toFixed(2)}`;
}

export async function appendTransaction(e: TransactionEntry): Promise<void> {
  await ensureDir(TRANSACTIONS_FILE.replace(/\/[^/]+$/, ""));
  await appendFile(TRANSACTIONS_FILE, formatTransactionLine(e) + "\n", "utf8");
}

export async function readTransactions(): Promise<TransactionEntry[]> {
  let raw: string;
  try {
    raw = await readFile(TRANSACTIONS_FILE, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  // Parse the formatted line back into a structured entry.
  // Format: DATE | SIDE | TICKER | N units @ $X.XX | cash remaining: $Y.YY
  const re = /^(\d{4}-\d{2}-\d{2}) \| (BUY|SELL)  \| (\S+) \| (\d+) units @ \$(\d+\.\d{2}) \| cash remaining: \$(\d+\.\d{2})$/;
  const out: TransactionEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const m = re.exec(line);
    if (!m) continue;
    const date = m[1]!;
    const side = m[2]! as TransactionEntry["side"];
    const ticker = m[3]!;
    const units = m[4]!;
    const price = m[5]!;
    const cash = m[6]!;
    out.push({
      date,
      side,
      ticker,
      units: Number(units),
      price: Number(price),
      cash_remaining: Number(cash),
    });
  }
  return out;
}
