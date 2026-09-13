import { describe, expect, test } from "bun:test";
import { TurnBudget, withTimeout, withTimeoutAndLateCleanup } from "../src/agent/limits.ts";
import { buildTradingTools, type PiWorkingState } from "../src/agent/tools.ts";
import { createInitialPortfolio } from "../src/engine/portfolio.ts";

const LIMITS = { maxTurns: 8, maxToolCalls: 20, timeoutMs: 5000 };

describe("agent/limits TurnBudget", () => {
  test("maxTurns is an inclusive cap: the Nth turn is allowed, the (N+1)th is not", () => {
    const budget = new TurnBudget(LIMITS, 0);
    for (let i = 0; i < LIMITS.maxTurns; i++) {
      budget.recordTurn();
      expect(budget.exceeded(0)).toBeNull(); // turns 1..8 all fine
    }
    budget.recordTurn(); // turn 9
    expect(budget.exceeded(0)).toMatch(/max turns/);
  });

  test("maxToolCalls is an inclusive cap: the Nth call is allowed, the (N+1)th is not", () => {
    const budget = new TurnBudget(LIMITS, 0);
    for (let i = 0; i < LIMITS.maxToolCalls; i++) {
      expect(budget.exceeded(0)).toBeNull();
      budget.recordToolCall(false);
    }
    expect(budget.exceeded(0)).toMatch(/max tool calls/);
  });

  test("time budget trips once elapsed >= timeoutMs", () => {
    const budget = new TurnBudget(LIMITS, 1000);
    expect(budget.exceeded(1000 + LIMITS.timeoutMs - 1)).toBeNull();
    expect(budget.exceeded(1000 + LIMITS.timeoutMs)).toMatch(/time budget/);
  });

  test("deadlineAt() is startedAt + timeoutMs, so setup and prompt can share one deadline", () => {
    const budget = new TurnBudget(LIMITS, 1000);
    expect(budget.deadlineAt()).toBe(1000 + LIMITS.timeoutMs);
  });

  test("exceededExcludingToolCalls: reaching maxToolCalls alone must NOT report exceeded (the model may still finish its turn)", () => {
    const budget = new TurnBudget(LIMITS, 0);
    for (let i = 0; i < LIMITS.maxToolCalls + 5; i++) budget.recordToolCall(false);
    // The tool-call cap IS reported by exceeded() (what budgetGate uses to
    // refuse the next actual tool call)...
    expect(budget.exceeded(0)).toMatch(/max tool calls/);
    // ...but must NOT be reported by exceededExcludingToolCalls() (what the
    // turn_start session-abort check uses) — a non-cooperative agent that
    // hammered past the tool cap must still be allowed to give its final
    // rationale instead of being cut off mid-turn.
    expect(budget.exceededExcludingToolCalls(0)).toBeNull();
  });

  test("exceededExcludingToolCalls: maxTurns and the wall-clock timeout still abort the session", () => {
    const budget = new TurnBudget(LIMITS, 1000);
    budget.recordTurn();
    expect(budget.exceededExcludingToolCalls(1000)).toBeNull();
    for (let i = 0; i < LIMITS.maxTurns; i++) budget.recordTurn();
    expect(budget.exceededExcludingToolCalls(1000)).toMatch(/max turns/);

    const timedOut = new TurnBudget(LIMITS, 1000);
    expect(timedOut.exceededExcludingToolCalls(1000 + LIMITS.timeoutMs)).toMatch(/time budget/);
  });

  test("recordRefusal/wasRefused: exactly N tool calls is not a refusal; attempting the (N+1)th is, and usage stays at N", () => {
    const tight = { maxTurns: 8, maxToolCalls: 3, timeoutMs: 5000 };
    const budget = new TurnBudget(tight, 0);
    for (let i = 0; i < tight.maxToolCalls; i++) {
      expect(budget.exceeded(0)).toBeNull(); // calls 1..3 all fine
      budget.recordToolCall(false);
    }
    // Cooperative stop at exactly the cap: budgetGate never ran, so nothing
    // durable was ever recorded — this day must NOT be reported as bounded.
    expect(budget.wasRefused()).toBeNull();

    // A non-cooperative (N+1)th attempt: agent/tools.ts's budgetGate calls
    // recordRefusal with the reason exceeded() gives it.
    const reason = budget.exceeded(0);
    expect(reason).toMatch(/max tool calls/);
    budget.recordRefusal(reason!);
    expect(budget.wasRefused()).toMatch(/max tool calls/);
    expect(budget.usage().toolCalls).toBe(tight.maxToolCalls); // the refused attempt is never counted as a call
  });

  test("recordRefusal only remembers the FIRST refusal reason", () => {
    const budget = new TurnBudget(LIMITS, 0);
    budget.recordRefusal("first reason");
    budget.recordRefusal("second reason");
    expect(budget.wasRefused()).toBe("first reason");
  });

  test("withTimeout rejects with the given reason once the promise outruns ms", async () => {
    const never = new Promise<void>(() => {});
    await expect(withTimeout(never, 5, "hard timeout (5ms)")).rejects.toThrow(/hard timeout/);
  });

  test("withTimeout resolves normally when the promise settles first", async () => {
    await expect(withTimeout(Promise.resolve(42), 5000, "should not fire")).resolves.toBe(42);
  });

  test("admitTurn: gates BEFORE counting — a refused (N+1)th turn is never recorded, so usage.turns can never exceed maxTurns even when hammered", () => {
    const tight = { maxTurns: 3, maxToolCalls: 20, timeoutMs: 5000 };
    const budget = new TurnBudget(tight, 0);
    for (let i = 0; i < tight.maxTurns; i++) {
      expect(budget.admitTurn()).toBe(true); // turns 1..3 admitted
    }
    for (let i = 0; i < 10; i++) {
      expect(budget.admitTurn()).toBe(false); // hammering past the cap: always refused
    }
    expect(budget.usage().turns).toBe(tight.maxTurns); // never inflated by a refused attempt
  });

  test("withTimeoutAndLateCleanup: setup that resolves BEFORE the timeout is returned normally and never cleaned up", async () => {
    let cleaned = 0;
    const value = { id: "on-time" };
    await expect(withTimeoutAndLateCleanup(Promise.resolve(value), 5000, "should not fire", () => cleaned++)).resolves.toBe(value);
    expect(cleaned).toBe(0);
  });

  test("withTimeoutAndLateCleanup: setup that resolves AFTER the timeout rejects on time, then cleans up the late value instead of leaking it", async () => {
    let resolveSetup!: (v: { id: string }) => void;
    const setup = new Promise<{ id: string }>((resolve) => {
      resolveSetup = resolve;
    });
    let cleaned: { id: string }[] = [];
    const call = withTimeoutAndLateCleanup(setup, 5, "hard timeout (5ms)", (v) => cleaned.push(v));
    await expect(call).rejects.toThrow(/hard timeout/);
    expect(cleaned).toEqual([]); // setup hasn't resolved yet — nothing to clean up
    resolveSetup({ id: "late" }); // simulates the setup work finishing after the caller gave up
    await Promise.resolve(); // let the .then() microtask run
    await Promise.resolve();
    expect(cleaned).toEqual([{ id: "late" }]);
  });

  test("withTimeoutAndLateCleanup: setup that REJECTS after the timeout is not passed to the cleanup callback", async () => {
    let rejectSetup!: (e: Error) => void;
    const setup = new Promise<{ id: string }>((_resolve, reject) => {
      rejectSetup = reject;
    });
    let cleaned = 0;
    const call = withTimeoutAndLateCleanup(setup, 5, "hard timeout (5ms)", () => cleaned++);
    await expect(call).rejects.toThrow(/hard timeout/);
    rejectSetup(new Error("late setup failure"));
    await Promise.resolve();
    await Promise.resolve();
    expect(cleaned).toBe(0);
  });
});

function workingState(overrides: Partial<PiWorkingState> = {}): PiWorkingState {
  return {
    date: "2024-03-01",
    universe: ["AAPL"],
    bars: { AAPL: [] },
    indicators: { AAPL: { sma20: null, sma50: null, rsi14: null } },
    portfolio: createInitialPortfolio(1000),
    decidedOrders: [],
    failedOrders: [],
    budget: new TurnBudget(LIMITS, Date.now()),
    ...overrides,
  };
}

describe("agent/tools budget gate", () => {
  test("usage.toolCalls never exceeds maxToolCalls even when the agent keeps hammering tools after the cap", async () => {
    const tight = { maxTurns: 8, maxToolCalls: 3, timeoutMs: 5000 };
    const state = workingState({ budget: new TurnBudget(tight, Date.now()) });
    const [getPortfolio] = buildTradingTools(state);
    // Call the (budget-gated, always-successful) get_portfolio tool 10 times —
    // far more than the cap of 3 — simulating a non-cooperative agent.
    for (let i = 0; i < 10; i++) {
      await getPortfolio!.execute!("call-" + i, {});
    }
    const usage = state.budget.usage();
    expect(usage.toolCalls).toBeLessThanOrEqual(tight.maxToolCalls);
    expect(usage.toolCalls).toBe(3); // exactly the cap: first 3 succeed, the rest are gated no-ops
  });

  test("get_indicators screens the full universe in one budgeted call without exposing today's data", async () => {
    const state = workingState({
      universe: ["AAPL", "MSFT"],
      bars: {
        AAPL: [{ date: "2024-02-29", open: 100, high: 102, low: 99, close: 101, volume: 1_000 }],
        MSFT: [{ date: "2024-02-29", open: 200, high: 202, low: 199, close: 201, volume: 2_000 }],
      },
      indicators: {
        AAPL: { sma20: 100, sma50: 95, rsi14: 55 },
        MSFT: { sma20: 205, sma50: 210, rsi14: 35 },
      },
    });
    const tool = buildTradingTools(state).find((candidate) => candidate.name === "get_indicators")!;
    const result = await tool.execute!("bulk", {}) as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      AAPL: { sma20: 100, sma50: 95, rsi14: 55, lastClose: 101, lastDate: "2024-02-29" },
      MSFT: { sma20: 205, sma50: 210, rsi14: 35, lastClose: 201, lastDate: "2024-02-29" },
    });
    expect(state.budget.usage().toolCalls).toBe(1);
  });

  test("buy/sell only QUEUE an order — no fill, no price, no portfolio mutation happens at the tool boundary", async () => {
    const state = workingState();
    const tools = buildTradingTools(state);
    const buy = tools.find((t) => t.name === "buy")!;
    const result = (await buy.execute!("call-1", { ticker: "AAPL", units: 1 })) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0]!.text);
    // The response proves the order was queued, not filled: no price, no
    // fill, no cash/holdings figure of any kind — an agent gets nothing back
    // that could reveal or help infer D's own open price.
    expect(payload).toEqual({ queued: true, ticker: "AAPL", side: "BUY", sizing: { kind: "units", units: 1 } });
    expect(state.decidedOrders).toEqual([{ ticker: "AAPL", side: "BUY", sizing: { kind: "units", units: 1 } }]);
    expect(state.portfolio).toEqual(createInitialPortfolio(1000)); // untouched
  });

  const REJECTION_CASES: Array<{ name: string; params: Record<string, unknown>; reasonPattern: RegExp }> = [
    { name: "unknown ticker", params: { ticker: "NOT_REAL", units: 1 }, reasonPattern: /not in the trading universe/ },
    { name: "both notionalUsd and units provided", params: { ticker: "AAPL", notionalUsd: 100, units: 1 }, reasonPattern: /exactly one of notionalUsd or units/ },
    { name: "neither notionalUsd nor units provided", params: { ticker: "AAPL" }, reasonPattern: /exactly one of notionalUsd or units/ },
    { name: "negative units", params: { ticker: "AAPL", units: -1 }, reasonPattern: /exactly one of notionalUsd or units/ },
    { name: "zero notionalUsd", params: { ticker: "AAPL", notionalUsd: 0 }, reasonPattern: /exactly one of notionalUsd or units/ },
  ];

  for (const { name, params, reasonPattern } of REJECTION_CASES) {
    test(`rejected trade call (${name}) is recorded once in failedOrders and counted as a failedToolCall`, async () => {
      const state = workingState();
      const tools = buildTradingTools(state);
      const buy = tools.find((t) => t.name === "buy")!;
      const result = (await buy.execute!("call-1", params)) as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(reasonPattern);
      expect(state.decidedOrders).toEqual([]); // never became a queued order
      expect(state.failedOrders).toHaveLength(1);
      expect(state.failedOrders[0]!.reason).toMatch(reasonPattern);
      const usage = state.budget.usage();
      expect(usage.toolCalls).toBe(1);
      expect(usage.failedToolCalls).toBe(1);
    });
  }

  test("budgetGate durably records a refusal only on the (N+1)th tool-call attempt — the exact distinction agent/piAgent.ts relies on to set boundedStop even when the session finishes normally", async () => {
    const tight = { maxTurns: 8, maxToolCalls: 2, timeoutMs: 5000 };
    const state = workingState({ budget: new TurnBudget(tight, Date.now()) });
    const tools = buildTradingTools(state);
    const getPortfolio = tools.find((t) => t.name === "get_portfolio")!;

    await getPortfolio.execute!("call-1", {});
    await getPortfolio.execute!("call-2", {});
    // Exactly N (2) successful calls: no refusal yet — a session that stops
    // cooperatively here must not be reported as bounded.
    expect(state.budget.wasRefused()).toBeNull();
    expect(state.budget.usage().toolCalls).toBe(2);

    await getPortfolio.execute!("call-3", {}); // the (N+1)th attempt: refused
    expect(state.budget.wasRefused()).toMatch(/max tool calls/);
    expect(state.budget.usage().toolCalls).toBe(2); // the refusal itself is never counted as a call
  });

  test("sentinel: get_portfolio never reflects an order queued earlier in the same session (no way to infer D-open by probing)", async () => {
    const state = workingState();
    const tools = buildTradingTools(state);
    const before = JSON.stringify(state.portfolio, null, 2);
    const buy = tools.find((t) => t.name === "buy")!;
    await buy.execute!("call-1", { ticker: "AAPL", notionalUsd: 500 });
    await buy.execute!("call-2", { ticker: "AAPL", notionalUsd: 200 }); // a second order, same ticker
    const getPortfolio = tools.find((t) => t.name === "get_portfolio")!;
    const after = (await getPortfolio.execute!("call-3", {})) as { content: Array<{ text: string }> };
    // Still yesterday's close — two queued orders for the same ticker never
    // change what get_portfolio reports, so a later order in this session
    // can't condition on anything learned from an earlier one's "fill".
    expect(after.content[0]!.text).toBe(before);
    expect(state.decidedOrders).toHaveLength(2);
  });
});
