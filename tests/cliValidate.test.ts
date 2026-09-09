import { describe, expect, test } from "bun:test";
import { parseFlags } from "../src/cli/args.ts";
import { assertInRange, assertKnownFlags, assertNoPositionals, parseDateFlag, parseIntFlag, parsePositiveFinite, parsePositiveInt } from "../src/cli/validate.ts";
import { resolveDateRange } from "../src/engine/calendar.ts";
import { MAX_MONEY_USD, MIN_MONEY_USD } from "../src/engine/money.ts";
import { round2 } from "../src/engine/portfolio.ts";

describe("cli/args parseFlags", () => {
  test("a leading `--` separator (as pnpm forwards it) is dropped, not treated as an empty flag", () => {
    const { flags, positionals } = parseFlags(["--", "--agent=fake", "--seed=2"]);
    expect(flags.get("agent")).toBe("fake");
    expect(flags.get("seed")).toBe("2");
    expect(flags.has("")).toBe(false);
    expect(positionals).toEqual([]);
  });

  test("parses identically with or without the leading separator", () => {
    const withSep = parseFlags(["--", "--agent=fake", "--start=2024-01-02"]);
    const withoutSep = parseFlags(["--agent=fake", "--start=2024-01-02"]);
    expect(withSep).toEqual(withoutSep);
  });

  test("a non-flag token is collected as a positional, not silently dropped", () => {
    const { positionals } = parseFlags(["--agent=fake", "garbage"]);
    expect(positionals).toEqual(["garbage"]);
  });

  test("`--flag value` form still consumes its value, not treated as a positional", () => {
    const { flags, positionals } = parseFlags(["--model", "demo"]);
    expect(flags.get("model")).toBe("demo");
    expect(positionals).toEqual([]);
  });

  test("only ONE leading separator is dropped; a second bare `--` is caught as an unknown flag, not silently accepted", () => {
    const { flags } = parseFlags(["--", "--", "--agent=fake"]);
    expect(flags.get("agent")).toBe("fake");
    expect(() => assertKnownFlags(flags, ["agent"], "run")).toThrow(/Unknown flag/);
  });
});

describe("cli/validate assertKnownFlags / assertNoPositionals", () => {
  test("rejects an unknown flag by name, not by the separator", () => {
    const { flags } = parseFlags(["--", "--agent=fake", "--wat=1"]);
    expect(() => assertKnownFlags(flags, ["agent"], "run")).toThrow(/--wat/);
  });

  test("rejects stray positional arguments", () => {
    expect(() => assertNoPositionals(["garbage"], "run")).toThrow(/garbage/);
  });

  test("accepts an empty positionals list", () => {
    expect(() => assertNoPositionals([], "run")).not.toThrow();
  });
});

describe("cli/validate parseDateFlag", () => {
  test("accepts a real calendar date", () => {
    expect(parseDateFlag("start", "2024-02-29")).toBe("2024-02-29"); // 2024 is a leap year
  });

  test("rejects an impossible month", () => {
    expect(() => parseDateFlag("start", "2024-99-98")).toThrow(/real calendar date/);
  });

  test("rejects an impossible day-of-month (Feb 30)", () => {
    expect(() => parseDateFlag("start", "2024-02-30")).toThrow(/real calendar date/);
  });

  test("rejects Feb 29 on a non-leap year", () => {
    expect(() => parseDateFlag("start", "2023-02-29")).toThrow(/real calendar date/);
  });

  test("rejects a malformed shape before even checking calendar validity", () => {
    expect(() => parseDateFlag("start", "01-02-2024")).toThrow(/YYYY-MM-DD/);
  });

  test("undefined input means \"not provided\" (null), not an error", () => {
    expect(parseDateFlag("start", undefined)).toBeNull();
  });
});

describe("cli/validate numeric flag parsing", () => {
  test("parsePositiveFinite rejects non-finite/non-positive input", () => {
    expect(() => parsePositiveFinite("starting-capital", "garbage", 1000)).toThrow();
    expect(() => parsePositiveFinite("starting-capital", "-5", 1000)).toThrow();
    expect(() => parsePositiveFinite("starting-capital", "0", 1000)).toThrow();
  });

  test("parsePositiveInt rejects a non-integer", () => {
    expect(() => parsePositiveInt("max-turns", "1.5", 8)).toThrow();
  });

  test("parseIntFlag rejects a non-integer but allows negative", () => {
    expect(() => parseIntFlag("seed", "garbage", 1)).toThrow();
    expect(parseIntFlag("seed", "-1", 1)).toBe(-1);
  });
});

describe("cli/run --starting-capital normalize-then-bound (round2 BEFORE assertInRange)", () => {
  // Mirrors the exact expression cli/run.ts uses: round2(parsePositiveFinite(...)),
  // then assertInRange against MIN_MONEY_USD/MAX_MONEY_USD — the raw value is
  // never bound-checked on its own, only the normalized one.
  function normalizeAndBound(raw: string): number {
    const parsed = parsePositiveFinite("starting-capital", raw, 1000);
    const normalized = round2(parsed);
    assertInRange("starting-capital", normalized, MIN_MONEY_USD, MAX_MONEY_USD);
    return normalized;
  }

  test("a sub-cent value that's positive/finite RAW but rounds to $0 is rejected, not silently accepted as capital 0", () => {
    expect(round2(0.001)).toBe(0); // raw passes parsePositiveFinite's > 0 check...
    expect(() => normalizeAndBound("0.001")).toThrow(/between/); // ...but the NORMALIZED value must still be caught
  });

  test("1e307 is finite RAW but round2(1e307) overflows to Infinity — rejected, not accepted as an infinite-capital run", () => {
    expect(Number.isFinite(round2(1e307))).toBe(false);
    expect(() => normalizeAndBound("1e307")).toThrow(/between/);
  });

  test("1e306 stays nominally finite after round2 but is still rejected — outside the documented safe range even though it wouldn't hang assertInRange itself", () => {
    expect(Number.isFinite(round2(1e306))).toBe(true);
    expect(() => normalizeAndBound("1e306")).toThrow(/between/);
  });

  test("$0.01 (MIN_MONEY_USD) is accepted; a value that rounds below it is not", () => {
    expect(normalizeAndBound("0.01")).toBe(0.01);
    expect(round2(0.004)).toBe(0);
    expect(() => normalizeAndBound("0.004")).toThrow(/between/);
  });

  test("MAX_MONEY_USD is accepted; a dollar above is not", () => {
    expect(normalizeAndBound(String(MAX_MONEY_USD))).toBe(MAX_MONEY_USD);
    expect(() => normalizeAndBound(String(MAX_MONEY_USD + 1))).toThrow(/between/);
  });

  test("the documented benchmark default ($1000) is comfortably inside the safe range", () => {
    expect(normalizeAndBound("1000")).toBe(1000);
  });
});

describe("engine/calendar resolveDateRange", () => {
  const CALENDAR = ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"];

  test("a wholly out-of-range window is rejected with the available range in the message", () => {
    expect(() => resolveDateRange(CALENDAR, "2030-01-01", "2030-01-02")).toThrow(/available: 2024-01-02\.\.2024-01-05/);
  });

  test("start after end is rejected", () => {
    expect(() => resolveDateRange(CALENDAR, "2024-01-04", "2024-01-02")).toThrow(/must be <= --end/);
  });

  test("an empty fixture calendar is rejected outright", () => {
    expect(() => resolveDateRange([], null, null)).toThrow(/Fixture calendar is empty/);
  });

  test("a partially overlapping window resolves to just the intersection", () => {
    expect(resolveDateRange(CALENDAR, "2024-01-04", "2024-06-01")).toEqual(["2024-01-04", "2024-01-05"]);
  });

  test("null start/end default to the full calendar", () => {
    expect(resolveDateRange(CALENDAR, null, null)).toEqual(CALENDAR);
  });
});
