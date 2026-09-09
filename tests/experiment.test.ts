import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { defaultWindow, defaultDataDir, isThreeMonthWindow, monthlyDeposits, parseBooleanFlag } from "../src/cli/experiment.ts";
import { PROJECT_ROOT } from "../src/utils/paths.ts";

function cli(args: string[]) {
  const p = Bun.spawnSync(["bun", "run", "src/index.ts", "run", "--agent=fake", ...args], { cwd: PROJECT_ROOT, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, error: p.stderr.toString() };
}

describe("three-month experiment contract", () => {
  test("default uses the last three completed UTC calendar months", () => {
    expect(defaultWindow(new Date("2026-09-09T12:30:00Z"))).toEqual({ start: "2026-06-01", end: "2026-08-31" });
    expect(defaultWindow(new Date("2026-09-01T00:00:00Z"))).toEqual({ start: "2026-06-01", end: "2026-08-31" });
    expect(defaultWindow(new Date("2025-01-31T23:59:59Z"))).toEqual({ start: "2024-10-01", end: "2024-12-31" });
    expect(defaultWindow(new Date("2024-03-01T00:00:00Z"))).toEqual({ start: "2023-12-01", end: "2024-02-29" });
  });
  test("window qualification requires first-of-month through final day of month three", () => {
    expect(isThreeMonthWindow("2024-01-01", "2024-03-31")).toBe(true);
    expect(isThreeMonthWindow("2023-12-01", "2024-02-29")).toBe(true);
    expect(isThreeMonthWindow("2024-01-02", "2024-03-31")).toBe(false);
    expect(isThreeMonthWindow("2024-01-01", "2024-03-29")).toBe(false);
    expect(isThreeMonthWindow("2024-01-01", "2024-04-30")).toBe(false);
  });
  test("deposits occur on first represented session of months two and three, including holidays/weekends", () => {
    const dates = ["2024-08-01", "2024-08-02", "2024-08-30", "2024-09-03", "2024-09-04", "2024-09-30", "2024-10-01", "2024-10-02"];
    expect(monthlyDeposits(dates)).toEqual([{ date: "2024-09-03", amount: 500 }, { date: "2024-10-01", amount: 500 }]);
    expect(monthlyDeposits(["2024-12-31", "2025-01-02"])).toEqual([{ date: "2025-01-02", amount: 500 }]);
    expect(monthlyDeposits(["2024-01-02", "2024-01-03"])).toEqual([]);
    expect(monthlyDeposits([])).toEqual([]);
  });
  test("dataset defaults identify both evaluation months", () => {
    expect(defaultDataDir("2026-06-01", "2026-08-31")).toBe(resolve("datasets/historical/202606_202608"));
  });
  test("boolean flags reject ambiguous values", () => {
    expect(parseBooleanFlag("smoke", undefined)).toBe(false);
    expect(parseBooleanFlag("free-only", undefined, true)).toBe(true);
    expect(parseBooleanFlag("smoke", "true")).toBe(true);
    expect(parseBooleanFlag("free-only", "false", true)).toBe(false);
    expect(() => parseBooleanFlag("smoke", "yes")).toThrow(/true or false/);
  });
  test("short windows require explicit smoke labeling", () => {
    const result = cli(["--start=2024-01-02", "--end=2024-01-03", "--data-dir=fixtures/ohlcv"]);
    expect(result.code).not.toBe(0); expect(result.error).toMatch(/three complete calendar months/); expect(result.error).toMatch(/--smoke/);
  });
  test("benchmarks require exactly $500 initial capital and at least 60 warm-up bars", () => {
    for (const flag of ["--starting-capital=1000", "--warmup-bars=59"]) {
      const result = cli(["--start=2024-01-01", "--end=2024-03-31", flag]);
      expect(result.code).not.toBe(0); expect(result.error).toMatch(/\$500 initial capital, and at least 60 warm-up bars/);
    }
  });
  test("synthetic data cannot be reported as a full historical benchmark", () => {
    const result = cli(["--start=2024-01-01", "--end=2024-03-31", "--data-dir=fixtures/ohlcv"]);
    expect(result.code).not.toBe(0); expect(result.error).toMatch(/requires historical data/);
  });
  test("smoke keeps warm-up validation unless explicitly lowered", () => {
    const result = cli(["--smoke", "--start=2024-01-02", "--end=2024-01-03", "--data-dir=fixtures/ohlcv"]);
    expect(result.code).not.toBe(0); expect(result.error).toMatch(/Insufficient warmup/);
  });
  test("explicit report directories fail loudly when invalid", () => {
    const p = Bun.spawnSync(["bun", "run", "src/index.ts", "report", "--dirs=/tmp/nonexistent-accounting-benchmark-report"], { cwd: PROJECT_ROOT, stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).not.toBe(0);
    const malformed = Bun.spawnSync(["bun", "run", "src/index.ts", "report", "--dirs=,"], { cwd: PROJECT_ROOT, stdout: "pipe", stderr: "pipe" });
    expect(malformed.exitCode).not.toBe(0); expect(malformed.stderr.toString()).toMatch(/nonempty run directories/);
  });
});
