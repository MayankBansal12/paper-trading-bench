// Custom error classes for the benchmark. Each carries a `message` that's
// safe to surface to the model — the spec requires "actionable feedback" so
// the model can replan (e.g. "you only hold 2 units of NVDA" on a failed sell).

export class BenchmarkError extends Error {
  /** Optional structured context the model can use to replan. */
  context?: Record<string, unknown>;
  constructor(message: string, context?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
    this.context = context;
  }
}

export class InsufficientCashError extends BenchmarkError {
  constructor(needed: number, available: number) {
    super(
      `Insufficient cash: need $${needed.toFixed(2)} but only have $${available.toFixed(2)} available. Sell existing holdings to free cash.`,
      { needed, available },
    );
  }
}

export class InvalidHoldingError extends BenchmarkError {
  constructor(ticker: string, requested: number, held: number) {
    super(
      `Cannot sell ${requested} units of ${ticker}: only ${held} held.`,
      { ticker, requested, held },
    );
  }
}

export class InvalidTickerError extends BenchmarkError {
  constructor(ticker: string, reason: string) {
    super(`Invalid ticker "${ticker}": ${reason}`, { ticker, reason });
  }
}

export class PriceUnavailableError extends BenchmarkError {
  constructor(ticker: string, date: string) {
    super(
      `No EOD price available for ${ticker} on ${date} (market may be closed or ticker delisted).`,
      { ticker, date },
    );
  }
}
