import { resolve } from "node:path";

export const MONTHLY_CONTRIBUTION = 500;

/** Three complete calendar months preceding the current UTC month. */
export function defaultWindow(now = new Date()): { start: string; end: string } {
  const year = now.getUTCFullYear(), month = now.getUTCMonth();
  return {
    start: new Date(Date.UTC(year, month - 3, 1)).toISOString().slice(0, 10),
    end: new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10),
  };
}

export function isThreeMonthWindow(start: string, end: string): boolean {
  const date = new Date(`${start}T00:00:00Z`);
  return start.endsWith("-01") && new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 3, 0)).toISOString().slice(0, 10) === end;
}

export function defaultDataDir(start: string, end: string): string {
  return resolve("datasets", "historical", `${start.slice(0, 7).replace("-", "")}_${end.slice(0, 7).replace("-", "")}`);
}

/** Initial capital funds the first represented month; later months receive one deposit each. */
export function monthlyDeposits(dates: readonly string[]): Array<{ date: string; amount: number }> {
  const months = new Set<string>();
  const deposits: Array<{ date: string; amount: number }> = [];
  for (const date of dates) {
    const month = date.slice(0, 7);
    if (months.has(month)) continue;
    if (months.size > 0) deposits.push({ date, amount: MONTHLY_CONTRIBUTION });
    months.add(month);
  }
  return deposits;
}

export function parseBooleanFlag(name: string, raw: string | undefined, fallback = false): boolean {
  if (raw === undefined) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`--${name} must be true or false, got "${raw}"`);
}
