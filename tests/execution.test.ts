import { describe, expect, test } from "bun:test";
import { executeOrder } from "../src/engine/execution.ts";
import { MAX_MONEY_USD, MAX_UNITS, MIN_PRICE_USD } from "../src/engine/money.ts";
import { applyFill, createInitialPortfolio, floorCents, floorUnits, round2, UNIT_DECIMALS, valuePortfolio } from "../src/engine/portfolio.ts";
import type { PortfolioState } from "../src/domain/types.ts";

/** Deterministic pseudo-random tick-count sampler (LCG) — reproducible
 * across runs, unlike `Math.random()`, so a domain-fuzz test either always
 * passes or always fails the same way instead of flaking. */
function deterministicTicks(seed: number, count: number, maxTicks: number): number[] {
  const ticks: number[] = [];
  let state = seed >>> 0;
  for (let i = 0; i < count; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    ticks.push(Math.floor((state / 2 ** 32) * maxTicks));
  }
  return ticks;
}

/** Adjacent representable positive double; used to probe raw values directly
 * below/above an otherwise canonical decimal tick. */
function adjacent(value: number, direction: -1 | 1): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  view.setBigUint64(0, bits + BigInt(direction));
  return view.getFloat64(0);
}

/** Strict conservation invariant: after ANY accepted fill, cash plus the
 * position's rounded value AT THE FILL PRICE must equal the pre-fill total
 * exactly — not approximately. This is the cent-ledger rule engine/
 * execution.ts implements (see its module comment): a fill's cash transfer
 * IS the change in round2(units * price), so this can never drift. */
function assertConserved(before: PortfolioState, after: PortfolioState, ticker: string, price: number): void {
  const beforeTotal = round2(before.cash + round2((before.holdings[ticker]?.units ?? 0) * price));
  const afterTotal = round2(after.cash + round2((after.holdings[ticker]?.units ?? 0) * price));
  expect(afterTotal).toBe(beforeTotal);
}

describe("engine/execution", () => {
  test("buy by notional sizes deterministic fractional units, rounded down to 6dp", () => {
    const portfolio = createInitialPortfolio(1000);
    const result = executeOrder({ ticker: "AAPL", side: "BUY", sizing: { kind: "notional", usd: 100 } }, 33.333333, portfolio, "2024-01-02");
    expect("fill" in result).toBe(true);
    if ("fill" in result) {
      expect(result.fill.units).toBeCloseTo(3.0, 1);
      expect(result.fill.notional).toBeLessThanOrEqual(100);
      expect(result.fill.cashAfter).toBeCloseTo(1000 - result.fill.notional, 6);
      assertConserved(portfolio, applyFill(portfolio, result.fill), "AAPL", 33.333333);
    }
  });

  test("buy fails with an actionable reason when cash is insufficient", () => {
    const portfolio = createInitialPortfolio(50);
    const result = executeOrder({ ticker: "NVDA", side: "BUY", sizing: { kind: "units", units: 10 } }, 100, portfolio, "2024-01-02");
    expect("failed" in result).toBe(true);
    if ("failed" in result) {
      expect(result.failed.reason).toMatch(/insufficient cash/i);
    }
  });

  test("sell more units than held fails and reports the actual held amount", () => {
    let portfolio: PortfolioState = createInitialPortfolio(1000);
    const buy = executeOrder({ ticker: "MSFT", side: "BUY", sizing: { kind: "units", units: 5 } }, 50, portfolio, "2024-01-02");
    if ("fill" in buy) portfolio = applyFill(portfolio, buy.fill);

    const sell = executeOrder({ ticker: "MSFT", side: "SELL", sizing: { kind: "units", units: 10 } }, 55, portfolio, "2024-01-03");
    expect("failed" in sell).toBe(true);
    if ("failed" in sell) {
      expect(sell.failed.reason).toMatch(/only 5 held/);
    }
  });

  test("no short selling: selling a ticker never held fails", () => {
    const portfolio = createInitialPortfolio(1000);
    const result = executeOrder({ ticker: "TSLA", side: "SELL", sizing: { kind: "units", units: 1 } }, 200, portfolio, "2024-01-02");
    expect("failed" in result).toBe(true);
  });

  test("selling the full position removes the holding entirely", () => {
    let portfolio: PortfolioState = createInitialPortfolio(1000);
    const buy = executeOrder({ ticker: "AMD", side: "BUY", sizing: { kind: "units", units: 4 } }, 100, portfolio, "2024-01-02");
    if ("fill" in buy) portfolio = applyFill(portfolio, buy.fill);
    expect(portfolio.holdings.AMD).toBeDefined();

    const sell = executeOrder({ ticker: "AMD", side: "SELL", sizing: { kind: "units", units: 4 } }, 110, portfolio, "2024-01-03");
    if ("fill" in sell) portfolio = applyFill(portfolio, sell.fill);
    expect(portfolio.holdings.AMD).toBeUndefined();
    expect(portfolio.cash).toBeCloseTo(1000 - 400 + 440, 6);
  });

  test("repeated buys compute a correctly weighted average cost", () => {
    let portfolio: PortfolioState = createInitialPortfolio(1000);
    const buy1 = executeOrder({ ticker: "IBM", side: "BUY", sizing: { kind: "units", units: 2 } }, 100, portfolio, "2024-01-02");
    if ("fill" in buy1) portfolio = applyFill(portfolio, buy1.fill);
    const buy2 = executeOrder({ ticker: "IBM", side: "BUY", sizing: { kind: "units", units: 2 } }, 200, portfolio, "2024-01-03");
    if ("fill" in buy2) portfolio = applyFill(portfolio, buy2.fill);
    expect(portfolio.holdings.IBM!.units).toBe(4);
    expect(portfolio.holdings.IBM!.avgCost).toBe(150);
  });

  test("a micro BUY that would round to $0 notional is rejected, not filled for free shares", () => {
    const portfolio = createInitialPortfolio(1000);
    const result = executeOrder({ ticker: "AAPL", side: "BUY", sizing: { kind: "units", units: 0.000001 } }, 100, portfolio, "2024-01-02");
    expect("failed" in result).toBe(true);
    if ("failed" in result) expect(result.failed.reason).toMatch(/minimum tradable fill size/);
  });

  test("a micro SELL that would round to $0 notional is rejected, not filled for free cash", () => {
    let portfolio: PortfolioState = createInitialPortfolio(1000);
    const buy = executeOrder({ ticker: "AAPL", side: "BUY", sizing: { kind: "units", units: 10 } }, 100, portfolio, "2024-01-02");
    if ("fill" in buy) portfolio = applyFill(portfolio, buy.fill);
    const result = executeOrder({ ticker: "AAPL", side: "SELL", sizing: { kind: "units", units: 0.000001 } }, 100, portfolio, "2024-01-03");
    expect("failed" in result).toBe(true);
  });

  test("conservation: a single BUY fill EXACTLY preserves cash + rounded position value at the fill price", () => {
    const portfolio = createInitialPortfolio(1000);
    const result = executeOrder({ ticker: "AAPL", side: "BUY", sizing: { kind: "notional", usd: 333.33 } }, 61.7, portfolio, "2024-01-02");
    expect("fill" in result).toBe(true);
    if ("fill" in result) {
      expect(result.fill.notional).toBeLessThanOrEqual(333.33);
      const after = applyFill(portfolio, result.fill);
      // Cash moved by exactly the fill's notional, and the position's stored
      // `.value` was computed with the SAME round2(units * price) — so cash
      // + holdings.value must equal the pre-fill cash exactly, to the cent.
      expect(round2(after.cash + (after.holdings.AAPL?.value ?? 0))).toBe(1000);
    } else {
      throw new Error("expected a fill");
    }
  });

  test("conservation: a single SELL fill EXACTLY preserves cash + rounded position value at the fill price", () => {
    let portfolio: PortfolioState = createInitialPortfolio(1000);
    const buy = executeOrder({ ticker: "AAPL", side: "BUY", sizing: { kind: "units", units: 5 } }, 60, portfolio, "2024-01-02");
    if ("fill" in buy) portfolio = applyFill(portfolio, buy.fill);
    const valueBefore = round2(portfolio.cash + round2(portfolio.holdings.AAPL!.units * 65));

    const sell = executeOrder({ ticker: "AAPL", side: "SELL", sizing: { kind: "units", units: 2 } }, 65, portfolio, "2024-01-03");
    if ("fill" in sell) {
      portfolio = applyFill(portfolio, sell.fill);
      const valueAfter = round2(portfolio.cash + round2(portfolio.holdings.AAPL!.units * 65));
      expect(valueAfter).toBe(valueBefore);
    } else {
      throw new Error("expected a fill");
    }
  });

  test("round trip: buying then selling the exact same units at the same price returns to the starting cash", () => {
    let portfolio: PortfolioState = createInitialPortfolio(1000);
    const buy = executeOrder({ ticker: "MSFT", side: "BUY", sizing: { kind: "units", units: 3.5 } }, 71.23, portfolio, "2024-01-02");
    if ("fill" in buy) portfolio = applyFill(portfolio, buy.fill);
    const sell = executeOrder({ ticker: "MSFT", side: "SELL", sizing: { kind: "units", units: 3.5 } }, 71.23, portfolio, "2024-01-03");
    if ("fill" in sell) portfolio = applyFill(portfolio, sell.fill);
    expect(portfolio.cash).toBe(1000);
    expect(portfolio.holdings.MSFT).toBeUndefined();
  });

  test("floorUnits is idempotent across the full 6dp value space: a persisted holding's own unit count must round-trip through floorUnits unchanged", () => {
    const scale = 1e6;
    let failures = 0;
    let firstFailure: number | null = null;
    for (let i = 0; i < 5_000_000; i++) {
      const x = i / scale;
      if (floorUnits(x) !== x) {
        failures++;
        if (firstFailure === null) firstFailure = x;
      }
    }
    expect({ failures, firstFailure }).toEqual({ failures: 0, firstFailure: null });
  });

  test("regression: floorUnits(0.000249) used to shave a dust unit off an already-quantized value", () => {
    expect(floorUnits(0.000249)).toBe(0.000249);
  });

  describe("round 13: canonical-decimal flooring never rounds a raw request upward", () => {
    test("reviewer repro: floorUnits(277359992.498531) is idempotent — units*1e6's float noise (277359992498530.97) no longer shaves a micro-share off an already-quantized value", () => {
      expect(floorUnits(277359992.498531)).toBe(277359992.498531);
    });

    test("reviewer repro: floorCents(608501453.42) is idempotent — usd*100's float noise (60850145341.99999) no longer under-budgets an all-cash BUY by $0.01", () => {
      expect(floorCents(608501453.42)).toBe(608501453.42);
    });

    test("floorUnits still floors a genuinely fractional value at large scale, not just snaps representation noise to the nearest tick", () => {
      // 99,999,999 units (~1e8) rather than MAX_UNITS (1e9) itself: at
      // MAX_UNITS's own scaled magnitude (1e15) adjacent doubles are
      // already ~0.25-0.5 ticks apart, so a "0.9-of-a-tick-past-exact"
      // input can't even be constructed distinctly from the noise band
      // there — this scale keeps the offset itself exactly representable
      // (noiseBound here is ~0.044 ticks, two orders of magnitude below the
      // offsets used) while still being far above any realistic position.
      const tickCount = 99_999_999_000_001;
      const scale = 1e6;
      const exact = tickCount / scale;
      expect(floorUnits((tickCount + 0.9) / scale)).toBe(exact); // 0.9 of a tick past `exact` — not noise
      expect(floorUnits((tickCount + 0.1) / scale)).toBe(exact); // even a small-but-real fraction still floors down
    });

    test("floorCents still floors a genuinely fractional value near the MAX_MONEY_USD scale, not just snaps representation noise to the nearest cent", () => {
      const centCount = 99_999_999_901; // near MAX_MONEY_USD * 100 = 1e11
      const exact = centCount / 100;
      const genuinelyFractional = exact + 0.009; // 0.9 of a cent past `exact` — not noise
      expect(floorCents(genuinelyFractional)).toBe(exact);
    });

    test("floorUnits is idempotent across a deterministic sample spanning the FULL 0..MAX_UNITS domain, not just the dense 0..5 sample above", () => {
      const scale = 10 ** UNIT_DECIMALS;
      const maxTicks = MAX_UNITS * scale;
      const ticks = deterministicTicks(0x9e3779b9, 2_000_000, maxTicks);
      let failures = 0;
      let firstFailure: number | null = null;
      for (const t of ticks) {
        const x = t / scale;
        if (floorUnits(x) !== x) {
          failures++;
          if (firstFailure === null) firstFailure = x;
        }
      }
      expect({ failures, firstFailure }).toEqual({ failures: 0, firstFailure: null });
    });

    test("floorCents is idempotent across a deterministic sample spanning the FULL 0..MAX_MONEY_USD domain", () => {
      const scale = 100;
      const maxTicks = MAX_MONEY_USD * scale;
      const ticks = deterministicTicks(0x1234abcd, 2_000_000, maxTicks);
      let failures = 0;
      let firstFailure: number | null = null;
      for (const t of ticks) {
        const x = t / scale;
        if (floorCents(x) !== x) {
          failures++;
          if (firstFailure === null) firstFailure = x;
        }
      }
      expect({ failures, firstFailure }).toEqual({ failures: 0, firstFailure: null });
    });

    test("nextDown neighbors floor downward while canonical unit/cent grid values remain idempotent", () => {
      const unitGrids = [0.000249, 277_359_992.498531, MAX_UNITS];
      for (const grid of unitGrids) {
        expect(floorUnits(grid)).toBe(grid);
        const below = adjacent(grid, -1);
        expect(floorUnits(below)).toBeLessThanOrEqual(below);
        expect(floorUnits(below)).toBeLessThan(grid);
      }
      const moneyGrids = [608_501_453.42, MAX_MONEY_USD];
      for (const grid of moneyGrids) {
        expect(floorCents(grid)).toBe(grid);
        const below = adjacent(grid, -1);
        expect(floorCents(below)).toBeLessThanOrEqual(below);
        expect(floorCents(below)).toBeLessThan(grid);
      }
    });

    test("accepted BUY fills never exceed raw units or raw notional requests", () => {
      const unitsRaw = 277_359_992.4985309;
      const largeExisting: PortfolioState = {
        cash: 900_000_000,
        holdings: { AAPL: { units: 100_000_000, avgCost: 1, lastClose: 1, value: 100_000_000 } },
        holdingsValue: 100_000_000,
        netWorth: MAX_MONEY_USD,
      };
      const unitsResult = executeOrder({ ticker: "AAPL", side: "BUY", sizing: { kind: "units", units: unitsRaw } }, 1, largeExisting, "2024-01-02");
      expect("fill" in unitsResult).toBe(true);
      if ("fill" in unitsResult) expect(unitsResult.fill.units).toBeLessThanOrEqual(unitsRaw);

      const notionalRaw = 608_501_453.4199998;
      const notionalResult = executeOrder({ ticker: "MSFT", side: "BUY", sizing: { kind: "notional", usd: notionalRaw } }, 1, createInitialPortfolio(MAX_MONEY_USD), "2024-01-02");
      expect("fill" in notionalResult).toBe(true);
      if ("fill" in notionalResult) expect(notionalResult.fill.notional).toBeLessThanOrEqual(notionalRaw);
    });

    test("only the exact persisted unit count is a full exit; an adjacent raw oversell is rejected", () => {
      const price = MIN_PRICE_USD;
      const heldUnits = 900_000_000;
      const portfolio: PortfolioState = {
        cash: 0,
        holdings: { AAPL: { units: heldUnits, avgCost: price, lastClose: price, value: heldUnits * price } },
        holdingsValue: heldUnits * price,
        netWorth: heldUnits * price,
      };
      const fullExit = executeOrder({ ticker: "AAPL", side: "SELL", sizing: { kind: "units", units: heldUnits } }, price, portfolio, "2024-01-02");
      expect("fill" in fullExit).toBe(true);
      if ("fill" in fullExit) {
        const after = applyFill(portfolio, fullExit.fill);
        expect(after.holdings.AAPL).toBeUndefined();
      }
      const oversell = executeOrder({ ticker: "AAPL", side: "SELL", sizing: { kind: "units", units: adjacent(heldUnits, 1) } }, price, portfolio, "2024-01-03");
      expect("failed" in oversell).toBe(true);
      if ("failed" in oversell) expect(oversell.failed.reason).toMatch(/only .* held/);
    });
  });

  test("selling the exact persisted unit count of a dust-prone 6dp holding clears the position with no leftover dust", () => {
    let portfolio: PortfolioState = createInitialPortfolio(1000);
    const buy = executeOrder({ ticker: "DUST", side: "BUY", sizing: { kind: "units", units: 0.000249 } }, 100, portfolio, "2024-01-02");
    if ("fill" in buy) portfolio = applyFill(portfolio, buy.fill);
    expect(portfolio.holdings.DUST!.units).toBe(0.000249);

    const sell = executeOrder({ ticker: "DUST", side: "SELL", sizing: { kind: "units", units: 0.000249 } }, 105, portfolio, "2024-01-03");
    expect("fill" in sell).toBe(true);
    if ("fill" in sell) {
      portfolio = applyFill(portfolio, sell.fill);
      expect(portfolio.holdings.DUST).toBeUndefined(); // not left holding 0.000001 dust
    }
  });

  test("a full-position sell sized by the position's own notional value never leaves dust or a spurious oversell rejection", () => {
    let portfolio: PortfolioState = createInitialPortfolio(1000);
    const buy = executeOrder({ ticker: "AAPL", side: "BUY", sizing: { kind: "notional", usd: 100 } }, 33.333333, portfolio, "2024-01-02");
    if ("fill" in buy) portfolio = applyFill(portfolio, buy.fill);
    const held = portfolio.holdings.AAPL!.units;
    const fullValue = held * 33.333333; // deliberately not the rounded `.value` field, to exercise division noise

    const sell = executeOrder({ ticker: "AAPL", side: "SELL", sizing: { kind: "notional", usd: fullValue } }, 33.333333, portfolio, "2024-01-03");
    expect("fill" in sell).toBe(true);
    if ("fill" in sell) {
      portfolio = applyFill(portfolio, sell.fill);
      expect(portfolio.holdings.AAPL).toBeUndefined();
    }
  });

  test("regression: a $0.015 BUY at $100/share is never filled for $0.015 of assets at $0.01 of cash — it buys only what $0.01 covers", () => {
    const portfolio = createInitialPortfolio(1000);
    const result = executeOrder({ ticker: "AAPL", side: "BUY", sizing: { kind: "notional", usd: 0.015 } }, 100, portfolio, "2024-01-02");
    expect("fill" in result).toBe(true);
    if ("fill" in result) {
      expect(result.fill.notional).toBe(0.01); // floored to the whole-cent budget, never $0.02
      // The units bought must themselves be worth exactly $0.01 at this
      // price, not $0.015 — i.e. cash and holdings value move by the same
      // amount (see assertConserved), never letting units outrun cash.
      const after = applyFill(portfolio, result.fill);
      expect(after.holdings.AAPL!.value).toBe(0.01);
      assertConserved(portfolio, after, "AAPL", 100);
    }
  });

  test("regression: two 0.00014-unit BUYs followed by a same-price full exit ends at EXACTLY the starting cash (round 5's $0.01 arbitrage)", () => {
    let portfolio: PortfolioState = createInitialPortfolio(1000);
    const buy1 = executeOrder({ ticker: "AAPL", side: "BUY", sizing: { kind: "units", units: 0.00014 } }, 100, portfolio, "2024-01-02");
    if ("fill" in buy1) portfolio = applyFill(portfolio, buy1.fill);
    const buy2 = executeOrder({ ticker: "AAPL", side: "BUY", sizing: { kind: "units", units: 0.00014 } }, 100, portfolio, "2024-01-03");
    if ("fill" in buy2) portfolio = applyFill(portfolio, buy2.fill);
    expect(portfolio.holdings.AAPL!.units).toBe(0.00028);

    const sell = executeOrder({ ticker: "AAPL", side: "SELL", sizing: { kind: "units", units: 0.00028 } }, 100, portfolio, "2024-01-04");
    expect("fill" in sell).toBe(true);
    if ("fill" in sell) portfolio = applyFill(portfolio, sell.fill);
    expect(portfolio.cash).toBe(1000); // not 1000.01 — no value created from nothing
    expect(portfolio.holdings.AAPL).toBeUndefined();
  });

  test("property: a deterministic sequence of buys/sells at a CONSTANT price never gains or loses net worth", () => {
    let portfolio: PortfolioState = createInitialPortfolio(1000);
    const price = 47.8317; // an intentionally "ugly" price to stress rounding
    const unitSizes = [0.1, 0.03, 1.7, 0.000123, 0.5, 2.25, 0.000001, 0.9999, 3, 0.0001];
    for (let i = 0; i < unitSizes.length; i++) {
      const side = i % 2 === 0 ? "BUY" : "SELL";
      const netWorthBefore = round2(portfolio.cash + round2((portfolio.holdings.XYZ?.units ?? 0) * price));
      const order = { ticker: "XYZ", side, sizing: { kind: "units" as const, units: unitSizes[i]! } } as const;
      const result = executeOrder(order, price, portfolio, `2024-02-${String(1 + i).padStart(2, "0")}`);
      if ("fill" in result) {
        portfolio = applyFill(portfolio, result.fill);
        const netWorthAfter = round2(portfolio.cash + round2((portfolio.holdings.XYZ?.units ?? 0) * price));
        expect(netWorthAfter).toBe(netWorthBefore); // price never moved: value can only ever be conserved, exactly
      }
    }
  });

  test("property: a deterministic sequence of notional buys/sells at a CONSTANT price never gains or loses net worth", () => {
    let portfolio: PortfolioState = createInitialPortfolio(1000);
    const price = 19.997;
    const usdSizes = [40, 0.015, 100, 7.777, 0.02, 250];
    for (let i = 0; i < usdSizes.length; i++) {
      const held = portfolio.holdings.ABC?.units ?? 0;
      const side = i % 3 === 2 && held > 0 ? "SELL" : "BUY";
      const netWorthBefore = round2(portfolio.cash + round2(held * price));
      const order = { ticker: "ABC", side, sizing: { kind: "notional" as const, usd: usdSizes[i]! } } as const;
      const result = executeOrder(order, price, portfolio, `2024-03-${String(1 + i).padStart(2, "0")}`);
      if ("fill" in result) {
        portfolio = applyFill(portfolio, result.fill);
        const netWorthAfter = round2(portfolio.cash + round2((portfolio.holdings.ABC?.units ?? 0) * price));
        expect(netWorthAfter).toBe(netWorthBefore);
      }
    }
  });

  test("long-run conservation: a deterministic sequence of buys/sells EXACTLY preserves value at each fill's own price", () => {
    let portfolio: PortfolioState = createInitialPortfolio(1000);
    const prices = [50.11, 50.5, 49.9, 51.2, 50.75, 52.0, 48.6, 50.0];
    for (let i = 0; i < prices.length; i++) {
      const price = prices[i]!;
      const side = i % 3 === 2 ? "SELL" : "BUY";
      const held = portfolio.holdings.XYZ?.units ?? 0;
      if (side === "SELL" && held <= 0) continue;
      const valueBefore = round2(portfolio.cash + round2(held * price));
      const order = side === "BUY" ? { ticker: "XYZ", side: "BUY" as const, sizing: { kind: "notional" as const, usd: 40 } } : { ticker: "XYZ", side: "SELL" as const, sizing: { kind: "units" as const, units: held } };
      const result = executeOrder(order, price, portfolio, `2024-01-${String(2 + i).padStart(2, "0")}`);
      if ("fill" in result) {
        portfolio = applyFill(portfolio, result.fill);
        const valueAfter = round2(portfolio.cash + round2((portfolio.holdings.XYZ?.units ?? 0) * price));
        expect(valueAfter).toBe(valueBefore); // exact — no cent-scale drift permitted in either direction
      }
    }
  });

  test("regression (round 6): a $10.009 BUY at $1/share with exactly $10.00 cash fills for exactly $10.00 — its FLOORED budget, not the raw request, is what must be checked against cash", () => {
    const portfolio = createInitialPortfolio(10.0);
    const result = executeOrder({ ticker: "AAPL", side: "BUY", sizing: { kind: "notional", usd: 10.009 } }, 1, portfolio, "2024-01-02");
    expect("fill" in result).toBe(true);
    if ("fill" in result) {
      expect(result.fill.notional).toBe(10.0);
      expect(result.fill.cashAfter).toBe(0);
    }
  });

  test("a $10.01 BUY with exactly $10.00 cash still fails — the floored-budget fix doesn't waive the cash check itself", () => {
    const portfolio = createInitialPortfolio(10.0);
    const result = executeOrder({ ticker: "AAPL", side: "BUY", sizing: { kind: "notional", usd: 10.01 } }, 1, portfolio, "2024-01-02");
    expect("failed" in result).toBe(true);
    if ("failed" in result) expect(result.failed.reason).toMatch(/insufficient cash/i);
  });

  describe("defensive safe-range checks (round 6: a 1e306 budget used to hang maxBuyTicks/maxSellTicks' binary search)", () => {
    test("a price below MIN_PRICE_USD is rejected outright, not sized against", () => {
      const portfolio = createInitialPortfolio(1000);
      const result = executeOrder({ ticker: "AAPL", side: "BUY", sizing: { kind: "notional", usd: 10 } }, 0.001, portfolio, "2024-01-02");
      expect("failed" in result).toBe(true);
      if ("failed" in result) expect(result.failed.reason).toMatch(/safe range/);
    });

    test("a price above MAX_MONEY_USD is rejected outright", () => {
      const portfolio = createInitialPortfolio(1000);
      const result = executeOrder({ ticker: "AAPL", side: "BUY", sizing: { kind: "notional", usd: 10 } }, MAX_MONEY_USD + 1, portfolio, "2024-01-02");
      expect("failed" in result).toBe(true);
      if ("failed" in result) expect(result.failed.reason).toMatch(/safe range/);
    });

    test("an oversized notional (> MAX_MONEY_USD) is rejected instead of driving maxBuyTicks' binary search toward Infinity", () => {
      const portfolio: PortfolioState = { ...createInitialPortfolio(1000), cash: 1e306 };
      const result = executeOrder({ ticker: "AAPL", side: "BUY", sizing: { kind: "notional", usd: 1e306 } }, 1, portfolio, "2024-01-02");
      expect("failed" in result).toBe(true);
      if ("failed" in result) expect(result.failed.reason).toMatch(/safe range/);
    });

    test("oversized portfolio cash alone (finite but beyond MAX_MONEY_USD, e.g. from a corrupted run directory) is rejected rather than sized against", () => {
      const portfolio: PortfolioState = { ...createInitialPortfolio(1000), cash: 1e306 };
      const result = executeOrder({ ticker: "AAPL", side: "BUY", sizing: { kind: "units", units: 1 } }, 1, portfolio, "2024-01-02");
      expect("failed" in result).toBe(true);
      if ("failed" in result) expect(result.failed.reason).toMatch(/safe range/);
    });
  });

  // Round 7: the round-6 defense above bounded price and cash/notional each
  // INDIVIDUALLY to [MIN_MONEY_USD, MAX_MONEY_USD] = [$0.01, $1e9], but their
  // CROSS-PRODUCT still overflowed maxBuyTicks/maxSellTicks' binary-search
  // bound past Number.MAX_SAFE_INTEGER: a BUY at cash/notional=$1e9,
  // price=$0.01 and a SELL from 1e11 held units at notional=$5e8,
  // price=$0.01 both hung past a 3s timeout (reviewer repro). Fixed by
  // splitting the price floor into a separate, tighter MIN_PRICE_USD and
  // adding a defensive MAX_UNITS ceiling on held units, so every accepted
  // combination of price/cash/notional/existingUnits — not just each bound
  // alone — keeps the search's tick count representable exactly. Every test
  // below carries an explicit timeout well under the default 5s so a
  // reintroduced hang fails that test instead of hanging the whole suite.
  describe("paired-extrema safe-range checks (round 7: individually-safe bounds whose CROSS-PRODUCT still overflowed the binary search)", () => {
    test("BUY at the accepted boundary (cash/notional=MAX_MONEY_USD, price=MIN_PRICE_USD) returns promptly, does not overspend, conserves value, and never persists units above MAX_UNITS (round 8 reviewer repro)", () => {
      const portfolio = createInitialPortfolio(MAX_MONEY_USD);
      const price = MIN_PRICE_USD;
      const result = executeOrder({ ticker: "AAPL", side: "BUY", sizing: { kind: "notional", usd: MAX_MONEY_USD } }, price, portfolio, "2024-01-02");
      expect("fill" in result).toBe(true);
      if ("fill" in result) {
        expect(result.fill.notional).toBeLessThanOrEqual(MAX_MONEY_USD); // never overspends the budget
        expect(result.fill.cashAfter).toBeGreaterThanOrEqual(0); // never goes negative (no leverage)
        const after = applyFill(portfolio, result.fill);
        assertConserved(portfolio, after, "AAPL", price);
        // Round 8 P0: maxBuyTicks' cent-rounding slack used to accept
        // 1,000,000,000.004999 units here, above MAX_UNITS=1e9.
        expect(after.holdings.AAPL!.units).toBeLessThanOrEqual(MAX_UNITS);
        // The invariant must hold for FOLLOW-ON orders too, not just this fill:
        // a held position at/under MAX_UNITS must remain sellable.
        const sell = executeOrder({ ticker: "AAPL", side: "SELL", sizing: { kind: "units", units: 1 } }, price, after, "2024-01-03");
        expect("fill" in sell).toBe(true);
      }
    }, 3000);

    test("a units-sized BUY that would push a near-ceiling position past MAX_UNITS is rejected, and the position remains sellable", () => {
      const price = MIN_PRICE_USD;
      const existingUnits = MAX_UNITS - 5;
      const portfolio: PortfolioState = {
        cash: 1000,
        holdings: { AAPL: { units: existingUnits, avgCost: price, lastClose: price, value: round2(existingUnits * price) } },
        holdingsValue: round2(existingUnits * price),
        netWorth: round2(1000 + existingUnits * price),
      };
      const result = executeOrder({ ticker: "AAPL", side: "BUY", sizing: { kind: "units", units: 10 } }, price, portfolio, "2024-01-02");
      expect("failed" in result).toBe(true);
      if ("failed" in result) expect(result.failed.reason).toMatch(/MAX_UNITS/);

      const sell = executeOrder({ ticker: "AAPL", side: "SELL", sizing: { kind: "units", units: 1 } }, price, portfolio, "2024-01-03");
      expect("fill" in sell).toBe(true);
    }, 3000);

    test("a notional BUY into a near-ceiling position is capped to the remaining MAX_UNITS headroom instead of overshooting it, and the position remains sellable", () => {
      const price = MIN_PRICE_USD;
      const existingUnits = MAX_UNITS - 5;
      const portfolio: PortfolioState = {
        cash: MAX_MONEY_USD,
        holdings: { AAPL: { units: existingUnits, avgCost: price, lastClose: price, value: round2(existingUnits * price) } },
        holdingsValue: round2(existingUnits * price),
        netWorth: round2(MAX_MONEY_USD + existingUnits * price),
      };
      const result = executeOrder({ ticker: "AAPL", side: "BUY", sizing: { kind: "notional", usd: 1000 } }, price, portfolio, "2024-01-02");
      expect("fill" in result).toBe(true);
      if ("fill" in result) {
        const after = applyFill(portfolio, result.fill);
        expect(after.holdings.AAPL!.units).toBeLessThanOrEqual(MAX_UNITS);
        const sell = executeOrder({ ticker: "AAPL", side: "SELL", sizing: { kind: "units", units: 1 } }, price, after, "2024-01-03");
        expect("fill" in sell).toBe(true);
      }
    }, 3000);

    test("an empty portfolio (existingUnits=0) buying by units at the exact MAX_UNITS boundary is accepted at exactly MAX_UNITS, one unit past it is rejected", () => {
      const portfolio = createInitialPortfolio(MAX_MONEY_USD);
      const price = MIN_PRICE_USD;
      const atCeiling = executeOrder({ ticker: "AAPL", side: "BUY", sizing: { kind: "units", units: MAX_UNITS } }, price, portfolio, "2024-01-02");
      expect("fill" in atCeiling).toBe(true);
      if ("fill" in atCeiling) {
        expect(atCeiling.fill.units).toBeLessThanOrEqual(MAX_UNITS);
        const after = applyFill(portfolio, atCeiling.fill);
        expect(after.holdings.AAPL!.units).toBeLessThanOrEqual(MAX_UNITS);
      }

      const overCeiling = executeOrder({ ticker: "AAPL", side: "BUY", sizing: { kind: "units", units: MAX_UNITS + 1 } }, price, portfolio, "2024-01-02");
      expect("failed" in overCeiling).toBe(true);
      if ("failed" in overCeiling) expect(overCeiling.failed.reason).toMatch(/MAX_UNITS/);
    }, 3000);

    test("BUY just inside the accepted boundary (price = MIN_PRICE_USD + one cent) also returns promptly and conserves value", () => {
      const portfolio = createInitialPortfolio(MAX_MONEY_USD);
      const price = round2(MIN_PRICE_USD + 0.01);
      const result = executeOrder({ ticker: "AAPL", side: "BUY", sizing: { kind: "notional", usd: MAX_MONEY_USD } }, price, portfolio, "2024-01-02");
      expect("fill" in result).toBe(true);
      if ("fill" in result) {
        expect(result.fill.notional).toBeLessThanOrEqual(MAX_MONEY_USD);
        assertConserved(portfolio, applyFill(portfolio, result.fill), "AAPL", price);
      }
    }, 3000);

    test("a held position at exactly MAX_UNITS is PARTIALLY sellable by notional (exercises maxSellTicks' binary search, not the full-exit fast path): prompt return, no shorting, exact conservation", () => {
      const price = MIN_PRICE_USD;
      const portfolio: PortfolioState = {
        cash: 0,
        holdings: { AAPL: { units: MAX_UNITS, avgCost: price, lastClose: price, value: round2(MAX_UNITS * price) } },
        holdingsValue: round2(MAX_UNITS * price),
        netWorth: round2(MAX_UNITS * price),
      };
      // Strictly less than the position's full value ($MAX_UNITS * price) so
      // this can't take the isFullExit or oversell-rejection shortcuts —
      // maxSellTicks' binary search actually has to run with heldTicks at
      // its max (MAX_UNITS / TICK).
      const usd = round2((MAX_UNITS * price) / 2);
      const result = executeOrder({ ticker: "AAPL", side: "SELL", sizing: { kind: "notional", usd } }, price, portfolio, "2024-01-02");
      expect("fill" in result).toBe(true);
      if ("fill" in result) {
        expect(result.fill.units).toBeLessThanOrEqual(MAX_UNITS); // never sells more than held (no shorting)
        expect(result.fill.notional).toBeLessThanOrEqual(usd);
        assertConserved(portfolio, applyFill(portfolio, result.fill), "AAPL", price);
      }
    }, 3000);

    test("a held position just under MAX_UNITS sold PARTIALLY also returns promptly with exact conservation", () => {
      const price = MIN_PRICE_USD;
      const units = MAX_UNITS - 1; // arbitrary near-extremum, not the exact ceiling
      const portfolio: PortfolioState = {
        cash: 0,
        holdings: { AAPL: { units, avgCost: price, lastClose: price, value: round2(units * price) } },
        holdingsValue: round2(units * price),
        netWorth: round2(units * price),
      };
      const usd = round2((units * price) / 2);
      const result = executeOrder({ ticker: "AAPL", side: "SELL", sizing: { kind: "notional", usd } }, price, portfolio, "2024-01-02");
      expect("fill" in result).toBe(true);
      if ("fill" in result) {
        expect(result.fill.units).toBeLessThanOrEqual(units);
        expect(result.fill.notional).toBeLessThanOrEqual(usd);
        assertConserved(portfolio, applyFill(portfolio, result.fill), "AAPL", price);
      }
    }, 3000);

    test("reviewer repro: BUY with cash/notional=1e9 at price=0.01 is REJECTED (price is below MIN_PRICE_USD) instead of hanging", () => {
      const portfolio: PortfolioState = { ...createInitialPortfolio(1000), cash: 1e9 };
      const result = executeOrder({ ticker: "AAPL", side: "BUY", sizing: { kind: "notional", usd: 1e9 } }, 0.01, portfolio, "2024-01-02");
      expect("failed" in result).toBe(true);
      if ("failed" in result) expect(result.failed.reason).toMatch(/safe range/);
    }, 3000);

    test("reviewer repro: SELL from 1e11 held units at notional=5e8, price=0.01 is REJECTED (held units exceed MAX_UNITS) instead of hanging", () => {
      const price = 0.01;
      const portfolio: PortfolioState = {
        cash: 0,
        holdings: { AAPL: { units: 1e11, avgCost: price, lastClose: price, value: 1e9 } },
        holdingsValue: 1e9,
        netWorth: 1e9,
      };
      const result = executeOrder({ ticker: "AAPL", side: "SELL", sizing: { kind: "notional", usd: 5e8 } }, price, portfolio, "2024-01-02");
      expect("failed" in result).toBe(true);
      if ("failed" in result) expect(result.failed.reason).toMatch(/safe range/);
    }, 3000);

    test("a held position just above MAX_UNITS (corrupted/adversarial state) is rejected rather than sized against", () => {
      const price = MIN_PRICE_USD;
      const units = MAX_UNITS + 1;
      const portfolio: PortfolioState = {
        cash: 0,
        holdings: { AAPL: { units, avgCost: price, lastClose: price, value: round2(units * price) } },
        holdingsValue: round2(units * price),
        netWorth: round2(units * price),
      };
      const result = executeOrder({ ticker: "AAPL", side: "SELL", sizing: { kind: "notional", usd: 100 } }, price, portfolio, "2024-01-02");
      expect("failed" in result).toBe(true);
      if ("failed" in result) expect(result.failed.reason).toMatch(/safe range/);
    }, 3000);

    test("a negative held-units value (corrupted state) is rejected rather than sized against", () => {
      const price = MIN_PRICE_USD;
      const portfolio: PortfolioState = {
        cash: 0,
        holdings: { AAPL: { units: -5, avgCost: price, lastClose: price, value: -round2(5 * price) } },
        holdingsValue: -round2(5 * price),
        netWorth: -round2(5 * price),
      };
      const result = executeOrder({ ticker: "AAPL", side: "SELL", sizing: { kind: "notional", usd: 100 } }, price, portfolio, "2024-01-02");
      expect("failed" in result).toBe(true);
      if ("failed" in result) expect(result.failed.reason).toMatch(/safe range/);
    }, 3000);
  });

  // Round 9: `valueDelta` computed round2(newUnits*price) - round2(existingUnits*price)
  // in plain doubles. Subtracting two large independently-rounded dollar
  // values suffers catastrophic cancellation, so the result need not itself
  // be a whole-cent amount even when both position values conceptually are
  // — e.g. the exact reviewer repro below returned notional
  // 0.019999980926513672 instead of a cent-quantized $0.02. Fixed by
  // computing position values in exact BigInt cents (`positionValueCents`,
  // engine/portfolio.ts) and subtracting BEFORE ever converting to a
  // `number`. Every test below asserts fill.notional is not just "close to"
  // the expected value but bit-for-bit the cent-quantized amount, and that
  // it equals the actual cash moved.
  describe("cent-exact value deltas at large position scale (round 9: catastrophic cancellation in round2(a)-round2(b))", () => {
    function assertCentQuantized(n: number): void {
      expect(Math.abs(n * 100 - Math.round(n * 100))).toBeLessThan(1e-9);
    }

    test("reviewer repro: BUY 50,000,000 units at $20 (exactly MAX_MONEY_USD) then SELL 0.001 units returns an exact $0.02, not a fractional-cent float", () => {
      let portfolio = createInitialPortfolio(MAX_MONEY_USD);
      const buy = executeOrder({ ticker: "AAPL", side: "BUY", sizing: { kind: "units", units: 50_000_000 } }, 20, portfolio, "2024-01-02");
      expect("fill" in buy).toBe(true);
      if (!("fill" in buy)) return;
      expect(buy.fill.notional).toBe(1_000_000_000);
      expect(buy.fill.cashAfter).toBe(0);
      portfolio = applyFill(portfolio, buy.fill);
      // applyFill's stored position `.value` uses the same exact helper as
      // valueDelta — must agree with the fill, not just be "close."
      expect(portfolio.holdings.AAPL?.value).toBe(1_000_000_000);

      const cashBefore = portfolio.cash;
      const sell = executeOrder({ ticker: "AAPL", side: "SELL", sizing: { kind: "units", units: 0.001 } }, 20, portfolio, "2024-01-03");
      expect("fill" in sell).toBe(true);
      if (!("fill" in sell)) return;
      assertCentQuantized(sell.fill.notional);
      expect(sell.fill.notional).toBe(0.02);
      expect(sell.fill.cashAfter).toBe(0.02);
      // fill.notional IS the cash moved — not an approximation of it.
      expect(sell.fill.notional).toBe(round2(Math.abs(sell.fill.cashAfter - cashBefore)));
      portfolio = applyFill(portfolio, sell.fill);
      expect(portfolio.holdings.AAPL?.value).toBe(999_999_999.98);
    });

    // These two round-9 scenarios (MAX_UNITS at $100,000 and at MAX_MONEY_USD
    // — $1e14 and $1e18 positions respectively) are now unreachable via
    // executeOrder's ACCEPTED path: round 11's resulting-position domain gate
    // rejects a SELL whose remaining position (still ~MAX_UNITS after
    // trimming a single 1e-6 tick) would leave the $MAX_MONEY_USD domain,
    // before ever computing a fill to return. That's correct — this is
    // exactly the "already-validated fill" contract applyFill assumes;
    // exercising the underlying BigInt-exact SELL arithmetic at scale is
    // still covered in-domain by "reviewer repro: BUY 50,000,000 units at $20
    // (exactly MAX_MONEY_USD) then SELL 0.001 units..." below.
    test("MAX_UNITS held at price $100,000: selling a single 1e-6 tick is REJECTED (the remaining ~MAX_UNITS position, still ~$1e14, would leave the domain)", () => {
      const price = 100_000;
      const portfolio: PortfolioState = {
        cash: 0,
        holdings: { AAPL: { units: MAX_UNITS, avgCost: price, lastClose: price, value: MAX_UNITS * price } },
        holdingsValue: MAX_UNITS * price,
        netWorth: MAX_UNITS * price,
      };
      const result = executeOrder({ ticker: "AAPL", side: "SELL", sizing: { kind: "units", units: 0.000001 } }, price, portfolio, "2024-01-02");
      expect("failed" in result).toBe(true);
      if ("failed" in result) expect(result.failed.reason).toMatch(/domain/i);
    });

    test("MAX_UNITS held at price MAX_MONEY_USD ($1e9): selling a single 1e-6 tick is REJECTED (the remaining ~MAX_UNITS position, still ~$1e18, would leave the domain)", () => {
      const price = MAX_MONEY_USD;
      const portfolio: PortfolioState = {
        cash: 0,
        holdings: { AAPL: { units: MAX_UNITS, avgCost: price, lastClose: price, value: MAX_UNITS * price } },
        holdingsValue: MAX_UNITS * price,
        netWorth: MAX_UNITS * price,
      };
      const result = executeOrder({ ticker: "AAPL", side: "SELL", sizing: { kind: "units", units: 0.000001 } }, price, portfolio, "2024-01-02");
      expect("failed" in result).toBe(true);
      if ("failed" in result) expect(result.failed.reason).toMatch(/domain/i);
    }, 3000);
  });

  // Round 10: `positionValue`/`valuePortfolio`/`applyFill` used to convert a
  // BigInt cents value to a `number` unconditionally, assuming (wrongly)
  // that it was always bounded by the portfolio's own net worth. Reviewer
  // repro: BUY MAX_UNITS at MIN_PRICE_USD ($1) with MAX_MONEY_USD cash — a
  // reachable, individually-accepted state per the round 7/8 tests above —
  // then mark/sell that SAME position at an equally-accepted price near
  // MAX_MONEY_USD ($1e9): MAX_UNITS * $1e9 = $1e18, past both the ~$90.07
  // trillion point where BigInt->Number stops being exact AND the engine's
  // own $MAX_MONEY_USD domain. Before this fix, valuePortfolio/applyFill
  // silently persisted a wrong value (a phantom ~$128 gain on a partial
  // sell), and a full exit returned $1e18 cash that the very next order's
  // own cash-bound precondition then rejected as "corrupted." Every one of
  // these transitions must now be either cent-exact or cleanly
  // rejected/thrown — never silently wrong.
  describe("money domain closed under valuation and SELL transitions (round 10)", () => {
    function maxUnitsAtOneDollar(): PortfolioState {
      const portfolio = createInitialPortfolio(MAX_MONEY_USD);
      const buy = executeOrder({ ticker: "AAPL", side: "BUY", sizing: { kind: "units", units: MAX_UNITS } }, MIN_PRICE_USD, portfolio, "2024-01-02");
      if (!("fill" in buy)) throw new Error("setup BUY unexpectedly failed");
      const after = applyFill(portfolio, buy.fill);
      expect(after.holdings.AAPL!.units).toBe(MAX_UNITS);
      expect(after.holdings.AAPL!.value).toBe(MAX_MONEY_USD); // MAX_UNITS * $1, exactly MAX_MONEY_USD
      expect(after.cash).toBe(0);
      return after;
    }

    test("valuePortfolio: marking MAX_UNITS at an extreme price ($1e9) throws a clean domain error instead of persisting a lossy value", () => {
      const portfolio = maxUnitsAtOneDollar();
      expect(() => valuePortfolio(portfolio, () => MAX_MONEY_USD)).toThrow(/domain/i);
    });

    test("round 11 regression: a tiny partial SELL at the extreme price is REJECTED up front (the REMAINING position would leave the domain), not accepted and left for applyFill to throw on", () => {
      // Reviewer's round-11 repro: the fill's own delta ($2,000) is small and
      // exact, and cash stays trivially inside the domain, so round 10's
      // cash-only post-fill check let this through — but the ~999,999,999.999998
      // units LEFT BEHIND, marked at $1e9, is ~$1e18: outside the domain.
      // executeOrder must reject the order itself so applyFill never has to
      // throw on a fill this function already called "accepted".
      const portfolio = maxUnitsAtOneDollar();
      const sell = executeOrder({ ticker: "AAPL", side: "SELL", sizing: { kind: "units", units: 0.000002 } }, MAX_MONEY_USD, portfolio, "2024-01-03");
      expect("failed" in sell).toBe(true);
      if ("failed" in sell) {
        expect(sell.failed.reason).toMatch(/domain/i);
        expect(sell.failed.reason).toMatch(/remaining/i);
      }
      // Nothing was mutated: the position/cash are exactly as before the
      // rejected order (the day-level regression in tests/day.test.ts checks
      // that later orders in the same day still fill after a rejection like
      // this one).
      expect(portfolio.holdings.AAPL!.units).toBe(MAX_UNITS);
      expect(portfolio.cash).toBe(0);
    });

    test("full exit: a SELL of the entire position at the extreme price is REJECTED up front (cash would leave the domain), not accepted and corrupted", () => {
      const portfolio = maxUnitsAtOneDollar();
      const sell = executeOrder({ ticker: "AAPL", side: "SELL", sizing: { kind: "units", units: MAX_UNITS } }, MAX_MONEY_USD, portfolio, "2024-01-03");
      expect("failed" in sell).toBe(true);
      if ("failed" in sell) expect(sell.failed.reason).toMatch(/domain/i);
    });

    test("a subsequent valid order: after the full exit is rejected, the portfolio is untouched and a normal-priced SELL still fills correctly", () => {
      const portfolio = maxUnitsAtOneDollar();
      const rejected = executeOrder({ ticker: "AAPL", side: "SELL", sizing: { kind: "units", units: MAX_UNITS } }, MAX_MONEY_USD, portfolio, "2024-01-03");
      expect("failed" in rejected).toBe(true);
      // The position/cash are exactly as they were before the rejected order.
      expect(portfolio.holdings.AAPL!.units).toBe(MAX_UNITS);
      expect(portfolio.cash).toBe(0);

      const sell = executeOrder({ ticker: "AAPL", side: "SELL", sizing: { kind: "units", units: 1 } }, MIN_PRICE_USD, portfolio, "2024-01-04");
      expect("fill" in sell).toBe(true);
      if ("fill" in sell) {
        expect(sell.fill.notional).toBe(1);
        expect(sell.fill.cashAfter).toBe(1);
        const after = applyFill(portfolio, sell.fill);
        expect(after.holdings.AAPL!.units).toBe(MAX_UNITS - 1);
        expect(after.cash).toBe(1);
        expect(after.holdings.AAPL!.value).toBe(MAX_UNITS - 1); // (MAX_UNITS-1) units * $1
      }
    });

    test("round 11 regression: reviewer's BUY-side repro — a tiny BUY into a large, valid position (500,000,000 AAPL units @ $2 = exactly MAX_MONEY_USD, $1e9 cash) is REJECTED up front when the resulting position would leave the domain, not accepted and left for applyFill to throw on", () => {
      const price = 2;
      const existingUnits = 500_000_000; // exactly $1e9 at $2/share — in-domain, at the boundary
      const portfolio: PortfolioState = {
        cash: MAX_MONEY_USD,
        holdings: { AAPL: { units: existingUnits, avgCost: price, lastClose: price, value: existingUnits * price } },
        holdingsValue: existingUnits * price,
        netWorth: MAX_MONEY_USD + existingUnits * price,
      };
      // 0.005 units @ $2 is a $0.01 order — comfortably affordable — but
      // pushes the resulting position to $1,000,000,000.01, one cent past
      // MAX_MONEY_USD.
      const buy = executeOrder({ ticker: "AAPL", side: "BUY", sizing: { kind: "units", units: 0.005 } }, price, portfolio, "2024-01-02");
      expect("failed" in buy).toBe(true);
      if ("failed" in buy) expect(buy.failed.reason).toMatch(/domain/i);
      // Nothing was mutated.
      expect(portfolio.holdings.AAPL!.units).toBe(existingUnits);
      expect(portfolio.cash).toBe(MAX_MONEY_USD);
    });

    test("round 11 regression: fills accepted right AT the money-domain boundary (not over it) still apply via applyFill without throwing, for both BUY and SELL", () => {
      const price = 2;
      const existingUnits = 499_999_999; // one unit short of the $1e9-at-$2 boundary
      let portfolio: PortfolioState = {
        cash: MAX_MONEY_USD,
        holdings: { AAPL: { units: existingUnits, avgCost: price, lastClose: price, value: existingUnits * price } },
        holdingsValue: existingUnits * price,
        netWorth: MAX_MONEY_USD + existingUnits * price,
      };
      const buy = executeOrder({ ticker: "AAPL", side: "BUY", sizing: { kind: "units", units: 1 } }, price, portfolio, "2024-01-02");
      expect("fill" in buy).toBe(true);
      if (!("fill" in buy)) return;
      portfolio = applyFill(portfolio, buy.fill); // must not throw
      expect(portfolio.holdings.AAPL!.units).toBe(500_000_000);
      expect(portfolio.holdings.AAPL!.value).toBe(MAX_MONEY_USD); // exactly at the boundary, still in-domain

      const sell = executeOrder({ ticker: "AAPL", side: "SELL", sizing: { kind: "units", units: 1 } }, price, portfolio, "2024-01-03");
      expect("fill" in sell).toBe(true);
      if (!("fill" in sell)) return;
      const after = applyFill(portfolio, sell.fill); // must not throw
      expect(after.holdings.AAPL!.units).toBe(499_999_999);
    });

    test("ordinary in-domain appreciation still marks and conserves exactly (the fix doesn't reject realistic gains, only the out-of-domain extreme)", () => {
      let portfolio = createInitialPortfolio(1000);
      const buy = executeOrder({ ticker: "AAPL", side: "BUY", sizing: { kind: "notional", usd: 1000 } }, 33.333333, portfolio, "2024-01-02");
      expect("fill" in buy).toBe(true);
      if (!("fill" in buy)) return;
      portfolio = applyFill(portfolio, buy.fill);

      const marked = valuePortfolio(portfolio, () => 40); // ordinary appreciation, nowhere near the domain
      expect(marked.netWorth).toBeGreaterThan(portfolio.netWorth);

      const sell = executeOrder({ ticker: "AAPL", side: "SELL", sizing: { kind: "units", units: marked.holdings.AAPL!.units } }, 40, marked, "2024-01-03");
      expect("fill" in sell).toBe(true);
      if ("fill" in sell) {
        const after = applyFill(marked, sell.fill);
        expect(after.holdings.AAPL).toBeUndefined();
        expect(after.netWorth).toBe(after.cash);
        expect(after.cash).toBe(marked.netWorth); // full exit at the marked price recovers exactly the marked net worth
      }
    });
  });
});
