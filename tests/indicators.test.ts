import { describe, expect, test } from "bun:test";
import { computeIndicators, rsi, sma } from "../src/data/indicators.ts";
import type { OhlcvBar } from "../src/domain/types.ts";

function bar(date: string, close: number): OhlcvBar {
  return { date, open: close, high: close, low: close, close, volume: 1 };
}

describe("data/indicators", () => {
  test("sma is null below the required window and computed once enough history exists", () => {
    const bars = Array.from({ length: 19 }, (_, i) => bar(`d${i}`, 100));
    expect(sma(bars, 20)).toBeNull();
    bars.push(bar("d19", 100));
    expect(sma(bars, 20)).toBe(100);
  });

  test("sma reflects only the trailing window, not the whole series", () => {
    const bars = [
      ...Array.from({ length: 10 }, (_, i) => bar(`a${i}`, 0)),
      ...Array.from({ length: 10 }, (_, i) => bar(`b${i}`, 100)),
    ];
    // window of 10 should be exactly the last 10 bars (all 100), independent of the leading zeros.
    expect(sma(bars, 10)).toBe(100);
  });

  test("rsi is 100 for an all-gains series and null with insufficient history", () => {
    const rising = Array.from({ length: 15 }, (_, i) => bar(`d${i}`, 100 + i));
    expect(rsi(rising.slice(0, 10), 14)).toBeNull();
    expect(rsi(rising, 14)).toBe(100);
  });

  test("rsi for an all-losses series is 0", () => {
    const falling = Array.from({ length: 15 }, (_, i) => bar(`d${i}`, 100 - i));
    expect(rsi(falling, 14)).toBe(0);
  });

  test("computeIndicators is a pure function of the given window", () => {
    const bars = Array.from({ length: 60 }, (_, i) => bar(`d${i}`, 100 + i * 0.5));
    const a = computeIndicators(bars);
    const b = computeIndicators([...bars]);
    expect(a).toEqual(b);
    expect(a.sma20).not.toBeNull();
    expect(a.sma50).not.toBeNull();
    expect(a.rsi14).not.toBeNull();
  });
});
