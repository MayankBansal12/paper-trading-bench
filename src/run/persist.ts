// Per-day artifact I/O: the daily JSON snapshot (source of truth for resume
// and for transactions.jsonl) and the transactions log itself.
//
// transactions.jsonl is a DERIVED artifact, fully rewritten from the
// completed daily records every time writeTransactions() runs (not
// appended). This is what makes it crash-safe: if the process dies at any
// point, the next invocation rebuilds it from scratch from whatever daily
// records are actually committed (daily/<date>.json + state.completedDates),
// so there is no window where a crash can leave stray or duplicated fills —
// unlike an append-only log, which would double-write a day's fills if a
// crash caused that day to be re-derived and re-flushed.

import { readFile } from "node:fs/promises";
import { runDailyFile, runTransactionsFile } from "../utils/paths.ts";
import { writeFileAtomic } from "../utils/fs.ts";
import type { DailyRecord } from "../domain/types.ts";

export async function writeDailyRecord(dir: string, record: DailyRecord): Promise<void> {
  await writeFileAtomic(runDailyFile(dir, record.date), JSON.stringify(record, null, 2) + "\n");
}

export async function loadDailyRecord(dir: string, date: string): Promise<DailyRecord | null> {
  try {
    return JSON.parse(await readFile(runDailyFile(dir, date), "utf8")) as DailyRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Rebuild transactions.jsonl from scratch: one line per fill, in the order
 * the (already date-sorted) daily records occurred. Idempotent — the same
 * `records` always produces byte-identical output. */
export async function writeTransactions(dir: string, records: readonly DailyRecord[]): Promise<void> {
  const lines = records.flatMap((r) => r.fills).map((f) => JSON.stringify(f));
  const content = lines.length > 0 ? lines.join("\n") + "\n" : "";
  await writeFileAtomic(runTransactionsFile(dir), content);
}
