// Resolves a configurable date batch against the fixture trading calendar.

export function resolveDateRange(
  fullCalendar: readonly string[],
  startDate: string | null,
  endDate: string | null,
): string[] {
  if (fullCalendar.length === 0) {
    throw new Error("Fixture calendar is empty — no OHLCV fixtures were loaded for the requested universe.");
  }
  const availableFirst = fullCalendar[0]!;
  const availableLast = fullCalendar[fullCalendar.length - 1]!;
  const start = startDate ?? availableFirst;
  const end = endDate ?? availableLast;
  if (start > end) {
    throw new Error(`--start (${start}) must be <= --end (${end})`);
  }
  const resolved = fullCalendar.filter((d) => d >= start && d <= end);
  if (resolved.length === 0) {
    throw new Error(
      `No trading days between --start=${start} and --end=${end} fall within the fixture calendar ` +
        `(available: ${availableFirst}..${availableLast}). Pick a range that overlaps the available dates.`,
    );
  }
  return resolved;
}
