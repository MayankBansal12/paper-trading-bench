// Shared per-session context passed to every tool handler. Holds the live
// in-memory portfolio state for the current session, plus the trading date.
//
// Tools are pure-ish: they may mutate `state` (buy/sell) but should NEVER
// persist to disk. Persistence is the orchestrator's job (Phase 6/7) —
// it calls savePortfolio() exactly once after a fully successful session.

import type { PortfolioState } from "../types.ts";

export interface TradingContext {
  /** Current in-memory portfolio. Mutated by buy/sell. */
  portfolio: PortfolioState;
  /** The trading day we're simulating (YYYY-MM-DD). */
  date: string;
  /** Model id running this session (for logging). */
  model: string;
}
