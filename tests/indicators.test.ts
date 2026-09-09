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

describe("Wilder reference regressions", () => {
  test("seed plus 14 declining bars retains recursively smoothed gains", () => {
    const closes = [...Array.from({ length: 15 }, (_, i) => 100 + i), ...Array.from({ length: 14 }, (_, i) => 113 - i)];
    const result = rsi(closes.map((close, i) => bar(String(i), close)), 14)!;
    // Seed is avg gain 1, avg loss 0; after 14 losses, gain=(13/14)^14.
    expect(result).toBeCloseTo(100 * (13 / 14) ** 14, 10);
    expect(result).toBeCloseTo(35.433531021986, 10);
    expect(result).not.toBe(0);
  });
  test("classic Wilder example matches independent published rounded values", () => {
    const closes = [44.34,44.09,44.15,43.61,44.33,44.83,45.10,45.42,45.84,46.08,45.89,46.03,45.61,46.28,46.28,46.00,46.03,46.41,46.22,45.64,46.21];
    expect(rsi(closes.slice(0,15).map((c,i) => bar(String(i),c)),14)).toBeCloseTo(70.4641350211, 8);
    expect(rsi(closes.map((c,i) => bar(String(i),c)),14)).toBeCloseTo(62.88071831, 7);
  });
  test("flat prices are neutral and calculations retain precision", () => {
    expect(rsi(Array.from({length:30},(_,i)=>bar(String(i),20)),14)).toBe(50);
    expect(sma([bar("a",1),bar("b",1),bar("c",2)],3)).toBe(4/3);
    expect(() => sma([],0)).toThrow(); expect(() => rsi([],1.5)).toThrow();
  });
  test("full-prefix initialization differs from sliding window reseeding", () => {
    const closes = Array.from({length:130},(_,i)=>100 + i/10 + 5*Math.sin(i/5));
    const bars = closes.map((c,i)=>bar(String(i),c));
    expect(rsi(bars,14)).not.toBe(rsi(bars.slice(-60),14));
  });
});
