/** Versioned US equity session calendar. Early closes are still sessions.
 * Rules: https://www.nyse.com/trade/hours-calendars . Explicit exceptional
 * closures are frozen; unsupported years fail rather than guessing. */
export const CALENDAR_VERSION = "XNYS-2000-2030-v1";
const DAY = 86_400_000;
export function assertDate(value: unknown, label = "date"): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid ${label}: ${String(value)}`);
  }
}
export function shiftDate(date: string, days: number): string {
  assertDate(date);
  return new Date(Date.parse(date) + days * DAY).toISOString().slice(0, 10);
}
const iso = (year: number, month: number, day: number) => new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
function nthMonday(year: number, month: number, n: number): string {
  return iso(year, month, 1 + (8 - new Date(iso(year, month, 1)).getUTCDay()) % 7 + (n - 1) * 7);
}
function observed(date: string): string {
  const day = new Date(date).getUTCDay();
  return shiftDate(date, day === 6 ? -1 : day === 0 ? 1 : 0);
}
function easter(year: number): string {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451), v = h + l - 7 * m + 114;
  return iso(year, Math.floor(v / 31), v % 31 + 1);
}
const exceptional = new Set([
  "2001-09-11", "2001-09-12", "2001-09-13", "2001-09-14", "2004-06-11",
  "2007-01-02", "2012-10-29", "2012-10-30", "2018-12-05", "2025-01-09",
]);
export function exchangeDates(start: string, end: string): string[] {
  assertDate(start, "calendar start"); assertDate(end, "calendar end");
  if (start > end) throw new Error("Calendar start is after end");
  const firstYear = Number(start.slice(0, 4)), lastYear = Number(end.slice(0, 4));
  if (firstYear < 2000 || lastYear > 2030) throw new Error(`Unsupported exchange calendar years: ${start}..${end}`);
  const holidays = new Set(exceptional);
  for (let year = firstYear; year <= lastYear; year++) {
    const ny = iso(year, 1, 1);
    // NYSE does not observe a Saturday New Year on the preceding Friday.
    if (new Date(ny).getUTCDay() !== 6) holidays.add(observed(ny));
    holidays.add(nthMonday(year, 1, 3)); holidays.add(nthMonday(year, 2, 3));
    holidays.add(shiftDate(easter(year), -2));
    const may31 = iso(year, 5, 31);
    holidays.add(shiftDate(may31, -(new Date(may31).getUTCDay() + 6) % 7));
    if (year >= 2022) holidays.add(observed(iso(year, 6, 19)));
    holidays.add(observed(iso(year, 7, 4))); holidays.add(nthMonday(year, 9, 1));
    const nov1 = iso(year, 11, 1);
    holidays.add(shiftDate(nov1, (11 - new Date(nov1).getUTCDay()) % 7 + 21));
    holidays.add(observed(iso(year, 12, 25)));
  }
  const result: string[] = [];
  for (let date = start; date <= end; date = shiftDate(date, 1)) {
    const day = new Date(date).getUTCDay();
    if (day !== 0 && day !== 6 && !holidays.has(date)) result.push(date);
  }
  return result;
}
