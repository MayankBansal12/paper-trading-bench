import { describe, expect, test } from "bun:test";
import { runOneDay } from "../src/run/day.ts";
import { asOf, openOn, closeOn, calendarDates } from "../src/data/ohlcv.ts";
import { createInitialPortfolio, floorUnits } from "../src/engine/portfolio.ts";
import { EXECUTION_CONVENTION } from "../src/engine/execution.ts";
import { centsToDollars, MAX_MONEY_CENTS, MAX_MONEY_USD, positionValueCents } from "../src/engine/money.ts";
import { FIXTURE_VERSION } from "../src/data/ohlcv.ts";
import { AGENT_PROTOCOL_VERSION } from "../src/agent/protocolVersion.ts";
import { UNIVERSE_V1 } from "../src/config/universe.ts";
import type { AgentDecision, AgentPort, DecisionContext, PortfolioState, RunConfig } from "../src/domain/types.ts";

const LIMITS = { maxTurns: 8, maxToolCalls: 20, timeoutMs: 5000 };

function config(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    model: "test",
    seed: 1,
    agent: "fake",
    startDate: null,
    endDate: null,
    startingCapital: 1000,
    universeVersion: "v1",
    limits: LIMITS,
    executionConvention: EXECUTION_CONVENTION,
    fixtureVersion: FIXTURE_VERSION,
    protocolVersion: AGENT_PROTOCOL_VERSION,
    ...overrides,
  };
}

/** Records every DecisionContext it's handed and returns a fixed decision (or an
 * override the test supplies), so a test can inspect exactly what the agent saw. */
class SpyAgent implements AgentPort {
  readonly name = "spy";
  seen: DecisionContext[] = [];
  constructor(private readonly build: (ctx: DecisionContext) => AgentDecision) {}
  async decide(ctx: DecisionContext): Promise<AgentDecision> {
    this.seen.push(ctx);
    return this.build(ctx);
  }
}

function noopDecision(): AgentDecision {
  return { orders: [], failedOrders: [], rationale: "noop", usage: { turns: 1, toolCalls: 0, failedToolCalls: 0, promptTokens: 0, completionTokens: 0 }, boundedStop: false, boundedReason: null };
}

describe("run/day causal convention", () => {
  test("decision context bars never include the current date D — only strictly earlier dates", async () => {
    const dates = await calendarDates(UNIVERSE_V1);
    const d = dates[59]!; // deep enough for full lookback
    const spy = new SpyAgent(noopDecision);
    await runOneDay(spy, config(), d, UNIVERSE_V1, createInitialPortfolio(1000), []);
    const ctx = spy.seen[0]!;
    for (const ticker of UNIVERSE_V1) {
      for (const bar of ctx.bars[ticker]!) {
        expect(bar.date < d).toBe(true);
      }
    }
  });

  test("sentinel: the decision context for D excludes D's own bar, which `asOf` (look-ahead-capable) would include", async () => {
    const dates = await calendarDates(UNIVERSE_V1);
    const d = dates[10]!;
    const spy = new SpyAgent(noopDecision);
    await runOneDay(spy, config(), d, UNIVERSE_V1, createInitialPortfolio(1000), []);
    const ctx = spy.seen[0]!;

    for (const ticker of ["AAPL", "MSFT", "NVDA"]) {
      const lookAheadCapable = await asOf(ticker, d); // includes D's own bar
      const dOwnBar = lookAheadCapable[lookAheadCapable.length - 1]!;
      expect(dOwnBar.date).toBe(d); // sanity: asOf really does include D

      const decisionBars = ctx.bars[ticker]!;
      // The decision context must be a strict prefix of the look-ahead-capable
      // series — same bars, minus D's own — proving D's bar was withheld.
      expect(decisionBars).toEqual(lookAheadCapable.slice(0, -1));
      expect(decisionBars.find((b) => b.date === d)).toBeUndefined();
    }
  });

  test("orders fill at D's OPEN, not D's close", async () => {
    const dates = await calendarDates(UNIVERSE_V1);
    const d = dates[5]!;
    const openPrice = (await openOn("AAPL", d))!;
    const closePrice = await closeOn("AAPL", d);
    expect(openPrice).not.toBe(closePrice); // sanity: fixture actually has intraday movement

    const spy = new SpyAgent((ctx) => ({
      orders: [{ ticker: "AAPL", side: "BUY", sizing: { kind: "units", units: 1 } }],
      failedOrders: [],
      rationale: "buy",
      usage: { turns: 1, toolCalls: 1, failedToolCalls: 0, promptTokens: 0, completionTokens: 0 },
      boundedStop: false,
      boundedReason: null,
    }));
    const record = await runOneDay(spy, config(), d, UNIVERSE_V1, createInitialPortfolio(1000), []);
    expect(record.fills[0]!.price).toBe(openPrice);
  });

  test("end-of-day net worth and termination check use D's CLOSE", async () => {
    const dates = await calendarDates(UNIVERSE_V1);
    const d = dates[5]!;
    const closePrice = await closeOn("AAPL", d);
    const spy = new SpyAgent((ctx) => ({
      orders: [{ ticker: "AAPL", side: "BUY", sizing: { kind: "notional", usd: 500 } }],
      failedOrders: [],
      rationale: "buy",
      usage: { turns: 1, toolCalls: 1, failedToolCalls: 0, promptTokens: 0, completionTokens: 0 },
      boundedStop: false,
      boundedReason: null,
    }));
    const record = await runOneDay(spy, config(), d, UNIVERSE_V1, createInitialPortfolio(1000), []);
    expect(record.portfolioAfter.holdings.AAPL!.lastClose).toBe(closePrice);
  });

  test("an order for a ticker outside the universe is a FailedOrder, not a thrown error", async () => {
    const dates = await calendarDates(UNIVERSE_V1);
    const d = dates[5]!;
    const spy = new SpyAgent(() => ({
      orders: [{ ticker: "NOT_REAL", side: "BUY", sizing: { kind: "notional", usd: 100 } }],
      failedOrders: [],
      rationale: "bad ticker",
      usage: { turns: 1, toolCalls: 1, failedToolCalls: 0, promptTokens: 0, completionTokens: 0 },
      boundedStop: false,
      boundedReason: null,
    }));
    const record = await runOneDay(spy, config(), d, UNIVERSE_V1, createInitialPortfolio(1000), []);
    expect(record.fills).toEqual([]);
    expect(record.failedOrders).toHaveLength(1);
    expect(record.failedOrders[0]!.reason).toMatch(/not in the trading universe/);
  });

  test("a Pi tool rejection (decision.failedOrders) is merged into the daily record", async () => {
    const dates = await calendarDates(UNIVERSE_V1);
    const d = dates[5]!;
    const spy = new SpyAgent(() => ({
      orders: [],
      failedOrders: [{ date: d, ticker: "AAPL", side: "BUY", reason: "insufficient cash (rejected mid-session)" }],
      rationale: "tried and failed",
      usage: { turns: 1, toolCalls: 1, failedToolCalls: 1, promptTokens: 0, completionTokens: 0 },
      boundedStop: false,
      boundedReason: null,
    }));
    const record = await runOneDay(spy, config(), d, UNIVERSE_V1, createInitialPortfolio(1000), []);
    expect(record.failedOrders).toHaveLength(1);
    expect(record.failedOrders[0]!.reason).toMatch(/rejected mid-session/);
  });

  // Round 11 regression: executeOrder used to accept a fill whose RESULTING
  // position would leave the $MAX_MONEY_USD money domain, then hand it to
  // applyFill (src/engine/portfolio.ts), which throws — turning a per-order
  // condition into a batch-aborting exception that would force a real Pi
  // agent's already-paid-for decision to be repeated. This proves the fix at
  // the level runOneDay actually operates at: the offending order is
  // recorded as an ordinary FailedOrder, and every OTHER order in the same
  // day's batch — including ones placed after it — still executes normally.
  test("round 11 regression: an order whose resulting position would leave the money domain is recorded as a FailedOrder, not a thrown exception, and later orders in the same day still fill", async () => {
    const dates = await calendarDates(UNIVERSE_V1);
    const d = dates[5]!;
    const openPrice = (await openOn("AAPL", d))!;
    const closePrice = await closeOn("AAPL", d);
    // Sized off the HIGHER of the day's open/close so end-of-day
    // valuePortfolio (which marks at CLOSE) can never itself approach the
    // domain — only the deliberately oversized BUY below should be rejected.
    const worstPrice = Math.max(openPrice, closePrice);
    const existingUnits = floorUnits(900_000_000 / worstPrice);
    const existingCents = positionValueCents(existingUnits, worstPrice);
    expect(existingCents).toBeLessThan(MAX_MONEY_CENTS); // sanity: setup itself is in-domain

    const portfolioBefore: PortfolioState = {
      cash: MAX_MONEY_USD,
      holdings: {
        AAPL: { units: existingUnits, avgCost: worstPrice, lastClose: worstPrice, value: centsToDollars(existingCents) },
      },
      holdingsValue: centsToDollars(existingCents),
      netWorth: MAX_MONEY_USD + centsToDollars(existingCents),
    };

    const spy = new SpyAgent(() => ({
      orders: [
        // Requests the maximum representable notional — comfortably enough
        // to cross whatever headroom is left to the domain at D's open,
        // regardless of the day's actual intraday move.
        { ticker: "AAPL", side: "BUY", sizing: { kind: "notional", usd: MAX_MONEY_USD } },
        { ticker: "MSFT", side: "BUY", sizing: { kind: "notional", usd: 100 } },
      ],
      failedOrders: [],
      rationale: "push AAPL past the domain, then keep trading MSFT",
      usage: { turns: 1, toolCalls: 2, failedToolCalls: 0, promptTokens: 0, completionTokens: 0 },
      boundedStop: false,
      boundedReason: null,
    }));

    const record = await runOneDay(spy, config(), d, UNIVERSE_V1, portfolioBefore, []);

    const aaplFailure = record.failedOrders.find((f) => f.ticker === "AAPL");
    expect(aaplFailure).toBeDefined();
    expect(aaplFailure!.reason).toMatch(/domain/i);
    // The rejected AAPL order left the position untouched...
    expect(record.portfolioAfter.holdings.AAPL!.units).toBe(existingUnits);
    // ...and the MSFT order placed AFTER it in the same batch still filled —
    // one order's rejection never aborts the rest of the day.
    expect(record.fills.some((f) => f.ticker === "MSFT")).toBe(true);
  });
});
