// Date helpers. Pure functions, no I/O.
// All dates in the benchmark use YYYY-MM-DD strings (no time component for trading days)
// except created_at/updated_at which are ISO 8601.

/** Today as YYYY-MM-DD in the local timezone (consistent with the user's wall clock). */
export function getToday(): string {
  const d = new Date();
  return formatDate(d);
}

/** YYYY-MM-DD from a Date. */
export function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Parse YYYY-MM-DD into a Date at local midnight. Returns null on bad input. */
export function parseDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const [, y, mo, d] = m;
  const dt = new Date(Number(y), Number(mo) - 1, Number(d));
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

/** True if the date is a Mon-Fri. Holidays are not modeled (spec: "market working day"). */
export function isMarketDay(date: Date | string): boolean {
  const d = typeof date === "string" ? parseDate(date) : date;
  if (!d) return false;
  const dow = d.getDay();
  return dow >= 1 && dow <= 5;
}

/** ISO 8601 timestamp for created_at / updated_at fields. */
export function nowIso(): string {
  return new Date().toISOString();
}
