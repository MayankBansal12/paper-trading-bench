// Canonical identifier for the agent-facing protocol: the tool set/semantics
// (agent/tools.ts), the system/day prompt text (agent/prompt.ts), the
// FakeAgent strategy (agent/fakeAgent.ts), and the per-day harness contract
// (run/day.ts) — together, everything that can change what decision gets
// made or how a day is scored. Stored in RunConfig and folded into a run's
// identity hash (run/state.ts) so a code change to any of those can never
// silently resume into — or silently mix into — an existing run directory's
// data. Bump the suffix any time their semantics change.
//
// v3: turn accounting (agent/limits.ts TurnBudget.admitTurn, used by
// agent/piAgent.ts's turn_start handler) now gates BEFORE counting a turn —
// a refused (N+1)th turn is no longer recorded in usage.turns, so
// usage.turns can never exceed maxTurns (v2 counted it first and only
// checked after, which could report turns > maxTurns).
//
// v4: get_indicators supports one-call universe screening (including the
// last observable close/date), and prompts reserve trade calls instead of
// exhausting the bounded session on ticker-by-ticker research.
export const AGENT_PROTOCOL_VERSION = "v4-bulk-indicator-screen";
