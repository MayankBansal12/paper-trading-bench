import { describe, expect, test } from "bun:test";
import { asOf, barOn, calendarDates } from "../src/data/ohlcv.ts";
import { UNIVERSE_V1 } from "../src/config/universe.ts";

describe("data/ohlcv as-of loading (no look-ahead)", () => {
  test("asOf never returns bars dated after the requested date", async () => {
    const bars = await asOf("AAPL", "2024-02-01");
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) {
      expect(bar.date <= "2024-02-01").toBe(true);
    }
  });

  test("asOf on the first calendar date returns exactly one bar", async () => {
    const bars = await asOf("AAPL", "2024-01-02");
    expect(bars.length).toBe(1);
    expect(bars[0]!.date).toBe("2024-01-02");
  });

  test("lookback truncates from the end, keeping the as-of date as the last bar", async () => {
    const full = await asOf("MSFT", "2024-03-01");
    const truncated = await asOf("MSFT", "2024-03-01", 5);
    expect(truncated.length).toBe(5);
    expect(truncated[truncated.length - 1]).toEqual(full[full.length - 1]!);
  });

  test("asOf is a strict function of the date — later calls don't leak future state", async () => {
    const early = await asOf("GOOGL", "2024-01-10");
    const later = await asOf("GOOGL", "2024-01-15");
    expect(later.length).toBeGreaterThan(early.length);
    // Every bar visible on the earlier date must still be identical and present later.
    for (const bar of early) {
      expect(later.find((b) => b.date === bar.date)).toEqual(bar);
    }
  });

  test("barOn returns undefined for a non-trading day (weekend)", async () => {
    // 2024-01-06 and 2024-01-07 are a Sat/Sun.
    expect(await barOn("AAPL", "2024-01-06")).toBeUndefined();
    expect(await barOn("AAPL", "2024-01-07")).toBeUndefined();
  });

  test("calendarDates agrees across the full universe and is sorted ascending", async () => {
    const dates = await calendarDates(UNIVERSE_V1);
    expect(dates.length).toBeGreaterThan(100);
    const sorted = [...dates].sort();
    expect(dates).toEqual(sorted);
  });
});
