// Daily summary read/write. The spec says the model writes the markdown and we
// persist it as results/summaries/YYYY-MM-DD.md. Summaries are the model's
// "memory" — getWeeklySummary concatenates the last 7 files.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SUMMARIES_DIR } from "../utils/paths.ts";
import { ensureDir } from "../utils/fs.ts";
import { getToday, parseDate } from "../utils/dates.ts";

export async function writeSummary(date: string, markdown: string): Promise<void> {
  await ensureDir(SUMMARIES_DIR);
  await writeFile(join(SUMMARIES_DIR, `${date}.md`), markdown, "utf8");
}

export async function readSummary(date: string): Promise<string | null> {
  try {
    return await readFile(join(SUMMARIES_DIR, `${date}.md`), "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Returns up to 7 most recent summaries (oldest → newest), skipping missing days. */
export async function getWeeklySummaries(today: string = getToday()): Promise<string[]> {
  const t = parseDate(today);
  if (!t) return [];

  const dates: string[] = [];
  // Walk back 6 days from today (so 7 dates total: today + 6 prior)
  for (let i = 6; i >= 0; i--) {
    const d = new Date(t);
    d.setDate(d.getDate() - i);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    dates.push(`${y}-${m}-${day}`);
  }

  // Read each one — missing days just return null and are skipped.
  const out: string[] = [];
  for (const date of dates) {
    const md = await readSummary(date);
    if (md !== null) out.push(md);
  }
  return out;
}

export async function listSummaryDates(): Promise<string[]> {
  try {
    const entries = await readdir(SUMMARIES_DIR);
    return entries.filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "")).sort();
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}
