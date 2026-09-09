import { describe, expect, test } from "bun:test";
import { computeMetrics } from "../src/engine/metrics.ts";
import { MAX_MONEY_USD, MIN_MONEY_USD } from "../src/engine/money.ts";
import type { EquityPoint } from "../src/domain/types.ts";

function curve(values: number[], startDate = "2024-01-02"): EquityPoint[] {
  const start = new Date(`${startDate}T00:00:00Z`);
  return values.map((netWorth, i) => {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    return { date: d.toISOString().slice(0, 10), netWorth };
  });
}

describe("engine/metrics", () => {
  test("flat curve: zero return, zero drawdown, zero volatility, null sharpe", () => {
    const m = computeMetrics(curve([1000, 1000, 1000, 1000]), 1000, 0, 0, 0, [0, 0, 0, 0]);
    expect(m.totalReturnPct).toBe(0);
    expect(m.maxDrawdownPct).toBe(0);
    expect(m.dailyVolatilityPct).toBe(0);
    expect(m.sharpe).toBeNull();
  });

  test("monotonically rising curve: positive return, zero drawdown", () => {
    const m = computeMetrics(curve([1000, 1010, 1020.1]), 1000, 2, 0, 0, [5, 5]);
    expect(m.totalReturnPct).toBeCloseTo(2.01, 2);
    expect(m.maxDrawdownPct).toBe(0);
    expect(m.avgTurnoverPct).toBe(5);
  });

  test("drawdown captures the worst peak-to-trough decline, not just start-to-end", () => {
    const m = computeMetrics(curve([1000, 1200, 900, 1100]), 1000, 0, 0, 0, [0, 0, 0, 0]);
    // peak 1200 -> trough 900 = -25%
    expect(m.maxDrawdownPct).toBeCloseTo(-25, 4);
  });

  test("counts pass through untouched", () => {
    const m = computeMetrics(curve([1000, 990]), 1000, 3, 2, 1, [10, 0]);
    expect(m.tradeCount).toBe(3);
    expect(m.failedOrderCount).toBe(2);
    expect(m.boundedStopCount).toBe(1);
    expect(m.daysRun).toBe(2);
  });

  test("empty curve falls back to starting capital with zero days", () => {
    const m = computeMetrics([], 1000, 0, 0, 0, []);
    expect(m.endingNetWorth).toBe(1000);
    expect(m.totalReturnPct).toBe(0);
    expect(m.daysRun).toBe(0);
  });

  test("a first-day loss is captured in BOTH totalReturnPct and maxDrawdownPct (starting capital seeds the curve)", () => {
    const m = computeMetrics(curve([500]), 1000, 0, 0, 0, [0]);
    expect(m.totalReturnPct).toBeCloseTo(-50, 4);
    expect(m.maxDrawdownPct).toBeCloseTo(-50, 4); // was 0 before starting capital seeded the drawdown series
  });

  test("a first-day gain is captured in maxDrawdownPct's peak tracking too (no false drawdown from an unseeded series)", () => {
    const m = computeMetrics(curve([1500]), 1000, 0, 0, 0, [0]);
    expect(m.totalReturnPct).toBeCloseTo(50, 4);
    expect(m.maxDrawdownPct).toBe(0);
  });

  test("zero starting capital is rejected at the metric boundary", () => {
    expect(() => computeMetrics(curve([0, 0]), 0, 0, 0, 0, [0, 0])).toThrow(/Starting capital/);
  });

  test("every persisted metric stays finite at the MIN_MONEY_USD boundary", () => {
    const m = computeMetrics(curve([MIN_MONEY_USD, MIN_MONEY_USD * 1.1]), MIN_MONEY_USD, 1, 0, 0, [0, 5]);
    for (const v of [m.totalReturnPct, m.maxDrawdownPct, m.dailyVolatilityPct, m.avgTurnoverPct, m.endingNetWorth]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    expect(m.sharpe === null || Number.isFinite(m.sharpe)).toBe(true);
  });

  test("every persisted metric stays finite at the MAX_MONEY_USD boundary", () => {
    const m = computeMetrics(curve([MAX_MONEY_USD, MAX_MONEY_USD * 0.9]), MAX_MONEY_USD, 1, 0, 0, [0, 5]);
    for (const v of [m.totalReturnPct, m.maxDrawdownPct, m.dailyVolatilityPct, m.avgTurnoverPct, m.endingNetWorth]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    expect(m.sharpe === null || Number.isFinite(m.sharpe)).toBe(true);
  });

  test("the first day's return is included in volatility/Sharpe, not silently excluded", () => {
    // Two-day curve: day 1 is a +10% jump from starting capital, day 2 flat.
    // If day 1's return were excluded, only the flat day-1->day-2 return
    // (0%) would feed stdev/mean, understating volatility to zero.
    const m = computeMetrics(curve([1100, 1100]), 1000, 0, 0, 0, [0, 0]);
    expect(m.dailyVolatilityPct).toBeGreaterThan(0);
  });
});
