// Core domain types for the v0 batch benchmark. Dependency-free so every
// layer (data, engine, agent, run, report) can import without cycles.

export type OrderSide = "BUY" | "SELL";

/** A single daily OHLCV bar. All prices in USD, 2dp. Volume is share count. */
export interface OhlcvBar {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Indicators {
  sma20: number | null;
  sma50: number | null;
  rsi14: number | null;
}

export interface Holding {
  units: number; // fractional, rounded to UNIT_DECIMALS
  avgCost: number;
  lastClose: number;
  value: number;
}

export type Holdings = Record<string, Holding>;

export interface PortfolioState {
  cash: number;
  holdings: Holdings;
  holdingsValue: number;
  netWorth: number;
}

/** Order sizing is always deterministic: either a notional USD amount or an
 * explicit unit count. Both are rounded the same way (see engine/execution.ts). */
export type OrderSizing =
  | { kind: "notional"; usd: number }
  | { kind: "units"; units: number };

export interface OrderRequest {
  ticker: string;
  side: OrderSide;
  sizing: OrderSizing;
}

export interface Fill {
  date: string;
  ticker: string;
  side: OrderSide;
  units: number;
  price: number;
  /** The cash this fill moved: the change in the position's own rounded
   * value at `price` (see engine/execution.ts's cent-ledger rule), NOT
   * necessarily the order's requested USD amount. */
  notional: number;
  cashAfter: number;
}

export interface FailedOrder {
  date: string;
  ticker: string;
  side: OrderSide;
  reason: string;
}

export type ToolResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string; context?: Record<string, unknown> };

/** Bounded resource budget for a single day's agent decision. */
export interface RunLimits {
  maxTurns: number;
  maxToolCalls: number;
  timeoutMs: number;
}

export interface UsageStats {
  turns: number;
  toolCalls: number;
  failedToolCalls: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  inputTokens?: number;
  attemptedToolCalls?: number;
  admittedToolCalls?: number;
  refusedToolCalls?: number;
  successfulToolCalls?: number;
  pendingToolCalls?: number;
}

export interface DecisionContext {
  date: string;
  universe: readonly string[];
  portfolio: PortfolioState;
  bars: Record<string, OhlcvBar[]>; // as-of bars per ticker STRICTLY BEFORE `date`, bounded lookback, ascending
  indicators: Record<string, Indicators>; // computed from `bars`, i.e. also strictly before `date`
  /** `date`'s own open price is DELIBERATELY not part of this context — an
   * agent decides its whole day-D batch of orders having observed nothing
   * newer than D-1's close. Orders are queued as OrderRequests and executed
   * against D's open only AFTER decide() returns (see run/day.ts), so no
   * order can ever condition on a D-open price learned from an earlier
   * order's fill within the same decision. */
  recentDays: DailyRecord[]; // most recent N days of this run, oldest first
  limits: RunLimits;
  horizon?: { startDate: string | null; endDate: string | null };
  contributions?: Contribution[];
}

export type DecisionOutcome = "completed" | "budget_cutoff" | "provider_error" | "harness_error";

export interface Contribution { date: string; amount: number }
export type CorporateActionEvent =
  | { type: "split"; date: string; ticker: string; ratio: number }
  | { type: "dividend"; date: string; ticker: string; amount: number };

export interface AgentDecision {
  submittedOrders?: OrderRequest[];
  outcome?: DecisionOutcome;
  terminalReason?: string | null;
  elapsedMs?: number;
  trace?: unknown[];
  effectiveSystemPrompt?: string;
  promptHash?: string;
  /** Orders the agent wants placed for `date`, in the order it queued them.
   * Sizing is exactly as requested — execution (price, cash/holdings
   * sufficiency, fill units) happens entirely in run/day.ts after decide()
   * returns, never inside the agent itself. */
  orders: OrderRequest[];
  /** Orders the agent attempted that were rejected before ever becoming one
   * of `orders` (e.g. an unknown ticker or malformed sizing at the tool
   * boundary) — merged into DailyRecord.failedOrders alongside anything
   * that fails at replay time. */
  failedOrders: FailedOrder[];
  rationale: string;
  usage: UsageStats;
  boundedStop: boolean; // true if the agent was cut off by a limit
  boundedReason: string | null;
}

export interface AgentPort {
  readonly name: string;
  decide(ctx: DecisionContext): Promise<AgentDecision>;
}

export interface DailyRecord {
  priorAttemptHashes?: string[];
  contextHash?: string;
  artifactVersion?: string;
  outcome?: DecisionOutcome;
  contribution?: number;
  corporateActions?: CorporateActionEvent[];
  submittedOrders?: OrderRequest[];
  decision?: AgentDecision;
  integrityHash?: string;
  date: string;
  portfolioBefore: PortfolioState;
  portfolioAfter: PortfolioState;
  fills: Fill[];
  failedOrders: FailedOrder[];
  rationale: string;
  usage: UsageStats;
  turnoverPct: number; // sum(|notional|) / netWorth at start of day, *100
  terminated: boolean;
  boundedStop: boolean;
  boundedReason: string | null;
}

export interface RunConfig {
  /** Named, immutable comparison preset; pinned settings are checked during preflight. */
  comparisonProfile?: string;
  provider?: string;
  freeOnly?: boolean;
  dataDir?: string;
  contributions?: Contribution[];
  warmupBars?: number;
  experiment?: "three-month" | "smoke";
  model: string;
  /** Replicate label, NOT a model-sampling seed — the Pi SDK exposes no seed
   * parameter, so this only distinguishes repeated runs of the same
   * model/config on disk (results/runs/.../seed-<seed>/...). It does not make
   * model output deterministic. */
  seed: number;
  agent: "fake" | "pi" | "opencode";
  startDate: string | null; // inclusive; null = earliest fixture date
  endDate: string | null; // inclusive; null = latest fixture date
  startingCapital: number;
  universeVersion: string;
  limits: RunLimits;
  /** Identifies the causal execution convention (see engine/execution.ts).
   * Part of a run's canonical identity: changing it must never silently
   * reinterpret an existing run directory's data. */
  executionConvention: string;
  /** Identifies the fixture/data snapshot (see data/ohlcv.ts). Part of a
   * run's canonical identity for the same reason as executionConvention. */
  fixtureVersion: string;
  /** Identifies the agent-facing protocol: the tool set/semantics
   * (agent/tools.ts), the system/day prompt text (agent/prompt.ts), the
   * FakeAgent strategy (agent/fakeAgent.ts), and the per-day harness
   * contract (run/day.ts) — together, what can change a decision or how a
   * day is scored (see agent/protocolVersion.ts). Part of a run's canonical
   * identity for the same reason as executionConvention. */
  protocolVersion: string;
  runId?: string; // explicit override; otherwise derived deterministically
}

export type RunStatus = "active" | "terminated" | "completed" | "failed";

export interface RunState {
  attemptHashes?: string[];
  datasetVersion?: string;
  artifactVersion?: string;
  failure?: { date: string; reason: string };
  config: RunConfig;
  status: RunStatus;
  completedDates: string[]; // ascending, dates fully persisted so far
  lastNetWorth: number;
  createdAt: string;
  updatedAt: string;
}

export interface EquityPoint {
  contribution?: number;
  date: string;
  netWorth: number;
}

export interface Metrics {
  totalContributions?: number;
  netProfit?: number;
  timeWeightedReturnPct?: number;
  startingCapital: number;
  endingNetWorth: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  dailyVolatilityPct: number;
  annualizedVolatilityPct: number;
  sharpe: number | null; // rf = 0
  avgTurnoverPct: number;
  tradeCount: number;
  failedOrderCount: number;
  boundedStopCount: number;
  daysRun: number;
}

export interface RunSummary {
  datasetVersion?: string;
  artifactVersion?: string;
  datasetKind?: "historical" | "synthetic";
  finalPortfolio?: PortfolioState;
  totalContributions?: number;
  netProfit?: number;
  timeWeightedReturnPct?: number;
  attemptCount?: number;
  failedAttemptCount?: number;
  integrityHash?: string;
  resolvedCoverage?: { firstDate: string; lastDate: string; tradingDays: number };
  config: RunConfig;
  status: RunStatus;
  equityCurve: EquityPoint[];
  metrics: Metrics;
  usageTotals: UsageStats;
  baselines: {
    cash: { equityCurve: EquityPoint[]; metrics: Metrics };
    buyAndHold: { equityCurve: EquityPoint[]; metrics: Metrics };
  };
}

export interface AttemptRecord {
  failurePhase?: "validation" | "execution";
  contextHash: string;
  artifactVersion: string;
  date: string;
  attempt: number;
  outcome: DecisionOutcome;
  reason: string | null;
  decision?: AgentDecision;
  usage: UsageStats;
}
