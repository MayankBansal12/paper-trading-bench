import { describe, expect, test } from "bun:test";
import { cashBaseline, buyAndHoldBaseline } from "../src/engine/baselines.ts";
import { executeOrder } from "../src/engine/execution.ts";
import { applyFill, createInitialPortfolio, round2, valuePortfolio } from "../src/engine/portfolio.ts";
import { closeOn, openOn, calendarDates } from "../src/data/ohlcv.ts";
import { UNIVERSE_V1 } from "../src/config/universe.ts";
import type { OrderRequest, PortfolioState } from "../src/domain/types.ts";

describe("engine/baselines", () => {
  test("cash baseline never grows or shrinks", async () => {
    const dates = (await calendarDates(UNIVERSE_V1)).slice(0, 10);
    const curve = cashBaseline(1000, dates);
    expect(curve.length).toBe(10);
    expect(curve.every((p) => p.netWorth === 1000)).toBe(true);
  });

  test("buy-and-hold invests once on day one's OPEN and mark-to-markets at CLOSE afterward", async () => {
    const dates = (await calendarDates(UNIVERSE_V1)).slice(0, 5);
    const { equityCurve: curve, tradeCount } = await buyAndHoldBaseline(1000, UNIVERSE_V1, dates);
    expect(curve.length).toBe(5);
    expect(curve[0]!.date).toBe(dates[0]);
    expect(tradeCount).toBe(UNIVERSE_V1.length); // every ticker has a day-one bar in the fixtures

    // Recompute day 5's expected value independently by driving the SAME
    // production fill/valuation primitives (engine/execution.ts,
    // engine/portfolio.ts — unit-tested for correctness on their own in
    // execution.test.ts) over the fixtures, to cross-check baselines.ts's
    // orchestration (which tickers, which dates, open-then-close) rather
    // than re-deriving the rounding arithmetic by hand.
    const perTicker = 1000 / UNIVERSE_V1.length;
    let portfolio: PortfolioState = createInitialPortfolio(1000);
    for (const ticker of UNIVERSE_V1) {
      const p0 = await openOn(ticker, dates[0]!);
      if (p0 === undefined) continue;
      const order: OrderRequest = { ticker, side: "BUY", sizing: { kind: "notional", usd: perTicker } };
      const result = executeOrder(order, p0, portfolio, dates[0]!);
      if ("fill" in result) portfolio = applyFill(portfolio, result.fill);
    }
    const lastDate = dates[dates.length - 1]!;
    const closes: Record<string, number> = {};
    for (const ticker of Object.keys(portfolio.holdings)) closes[ticker] = await closeOn(ticker, lastDate);
    portfolio = valuePortfolio(portfolio, (t) => closes[t]!);
    expect(curve[curve.length - 1]!.netWorth).toBe(portfolio.netWorth);
  });

  test("buy-and-hold's day-one deployment is EXACTLY starting capital when marked at its own fill price (no synthetic deployment gain)", async () => {
    const dates = (await calendarDates(UNIVERSE_V1)).slice(0, 1);
    const perTicker = 1000 / UNIVERSE_V1.length;
    let portfolio: PortfolioState = createInitialPortfolio(1000);
    const opens: Record<string, number> = {};
    for (const ticker of UNIVERSE_V1) {
      const p0 = await openOn(ticker, dates[0]!);
      if (p0 === undefined) continue;
      opens[ticker] = p0;
      const order: OrderRequest = { ticker, side: "BUY", sizing: { kind: "notional", usd: perTicker } };
      const result = executeOrder(order, p0, portfolio, dates[0]!);
      if ("fill" in result) portfolio = applyFill(portfolio, result.fill);
    }
    // Mark-to-market at the SAME prices the day-one fills executed at (not
    // the close) — every fill's cash transfer exactly equals its position's
    // rounded value at that price (see engine/execution.ts's cent-ledger
    // rule), so cash + holdings value at fill price must sum to EXACTLY
    // starting capital: no $0.50-style synthetic gain from deploying cash.
    const markedAtOpen = valuePortfolio(portfolio, (t) => opens[t]!);
    expect(markedAtOpen.netWorth).toBe(1000);
  });

  test("buy-and-hold net worth on day one (valued at day one's close) is close to starting capital", async () => {
    const dates = (await calendarDates(UNIVERSE_V1)).slice(0, 1);
    const { equityCurve: curve } = await buyAndHoldBaseline(1000, UNIVERSE_V1, dates);
    expect(curve[0]!.netWorth).toBeGreaterThan(990);
    // Day one's open != close, so netWorth can land on either side of 1000
    // (still tight, since the whole universe moves at most a few % intraday).
    expect(curve[0]!.netWorth).toBeLessThan(1010);
  });

  test("tradeCount reflects actual accepted fills, not universe.length, when per-ticker sizing is below the minimum tradable notional", async () => {
    const dates = (await calendarDates(UNIVERSE_V1)).slice(0, 1);
    // $0.20 split 50 ways is $0.004/ticker, which rounds to $0.00 notional
    // (below MIN_NOTIONAL_USD's $0.01) for every ticker regardless of price,
    // so every fill is rejected.
    const { tradeCount, equityCurve } = await buyAndHoldBaseline(0.2, UNIVERSE_V1, dates);
    expect(tradeCount).toBe(0); // NOT UNIVERSE_V1.length
    expect(equityCurve[0]!.netWorth).toBeCloseTo(0.2, 2); // untouched cash, since nothing filled
  });

  test("turnoverPct reflects the actual day-one deployment (~100% of starting capital), then 0 on every later date", async () => {
    const dates = (await calendarDates(UNIVERSE_V1)).slice(0, 5);
    const { turnoverPct, tradeCount } = await buyAndHoldBaseline(1000, UNIVERSE_V1, dates);
    expect(turnoverPct).toHaveLength(5);
    expect(tradeCount).toBe(UNIVERSE_V1.length); // every ticker fills on day one
    // Deploying essentially the full $1,000 on day one across 50 tickers is
    // ~100% turnover of starting-of-day net worth — NOT the 0% an all-zero
    // turnover series would (incorrectly) report.
    expect(turnoverPct[0]!).toBeGreaterThan(95);
    expect(turnoverPct[0]!).toBeLessThanOrEqual(100);
    expect(turnoverPct.slice(1)).toEqual([0, 0, 0, 0]); // buy-and-hold never trades again
  });

  test("turnoverPct is 0 throughout when every day-one fill is rejected (nothing was actually deployed)", async () => {
    const dates = (await calendarDates(UNIVERSE_V1)).slice(0, 3);
    const { turnoverPct } = await buyAndHoldBaseline(0.2, UNIVERSE_V1, dates);
    expect(turnoverPct).toEqual([0, 0, 0]);
  });
});
