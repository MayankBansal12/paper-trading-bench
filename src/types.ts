// Core domain types — see PRODUCT.md for the canonical schema.
// Kept dependency-free so any layer can import this without circular issues.

export type PortfolioStatus = "active" | "terminated";

export interface Holding {
  units: number;
  avg_cost: number;
  last_traded_price: number;
  value: number;
}

export type Holdings = Record<string, Holding>;

export interface PortfolioState {
  start_date: string;          // YYYY-MM-DD
  created_at: string;          // ISO 8601
  updated_at: string;          // ISO 8601
  opening_balance: number;
  current_balance: number;
  holdings_value: number;
  holdings: Holdings;
  net_worth: number;
  net_pnl: number;
  status: PortfolioStatus;
  model?: string;              // which model produced this state (for results/CLI)
}

export type TransactionSide = "BUY" | "SELL";

export interface TransactionEntry {
  date: string;        // YYYY-MM-DD
  side: TransactionSide;
  ticker: string;      // uppercase
  units: number;
  price: number;
  cash_remaining: number;
}

export interface PriceCacheEntry {
  ticker: string;
  date: string;        // YYYY-MM-DD
  price: number;
  fetched_at: string;  // ISO 8601
}

export type PriceCache = Record<string, PriceCacheEntry>;

/** What a tool returns to the model. Mirrors the spec's "feedback loop" requirement. */
export type ToolResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string; context?: Record<string, unknown> };

export interface SessionConfig {
  model: string;             // e.g. "minimax-m2.7", "kimi-k2.6"
  date: string;              // YYYY-MM-DD — the simulated trading day
  portfolioPath: string;     // absolute
}
