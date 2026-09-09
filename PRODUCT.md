# Benchmark contract

## Objective

Measure how a specified model makes sequential technical-analysis decisions while managing a funded portfolio. A single command simulates three completed calendar months, one US equity trading session at a time. It is a historical experiment, not a live brokerage or a forecast of future returns.

- Initial cash is $500. Deposit another $500 before the first trading session of months two and three. Total contributed principal for a completed benchmark is $1,500.
- Default dates are the last three completed UTC calendar months. Explicit three-month periods are supported. Shorter windows and synthetic data require a `smoke` experiment label.
- Portfolio positions, cash, recent decisions, execution rejections, and contribution schedule carry across sessions. Each model decision has a fresh bounded context; no hidden provider conversation persists between days.
- End results include cash, each holding's shares, average cost, last close, value and portfolio weight, total contributions, final equity, and dollar profit.

## Information and execution timing

For session D, market observations stop at the close before D. SMA20 and SMA50 use closing prices; RSI14 uses Wilder smoothing initialized from the full available historical prefix. At least 60 earlier trading bars per ticker are required; the default warm-up requirement is 100. Prompt bars can be truncated independently of indicator initialization.

The only tools are `get_portfolio`, `get_universe`, `get_ohlcv`, `get_indicators`, `buy`, and `sell` (prefixed `trading_` in OpenCode MCP). No news, web search, shell, filesystem, delegation, or extra connector tools are available to the trading model. The harness may obtain historical snapshots before the run.

Orders are requests, not immediate fills. They execute in submitted order at D's open after a completed decision. A later sell cannot fund an earlier buy. The model cannot observe D's open or infer it from an intradecision fill. Actual rejections become available in subsequent daily context.

Fractional long-only shares are permitted. Units round down to six decimal places; cash uses the engine's cent ledger. No margin, short positions, fees, spread, slippage, market impact, or taxes. The entire universe is assumed tradable at the reported open. These assumptions must accompany any interpretation of returns.

## Data and universe

Historical datasets contain validated OHLCV bars, exchange sessions, actions, coverage/evaluation bounds, source snapshots, provenance, and content hashes. Missing, duplicate, invalid, or incomplete observations fail preflight. Synthetic fixtures remain useful for deterministic tests and are excluded from historical benchmark cohorts.

Yahoo's historical price series is retrospectively split-adjusted. Import reconstructs as-traded OHLCV and cash dividends using every subsequent supported split through the retrieval date, including splits after the evaluation period. Indicators use prices consistently adjusted for splits already effective by the decision date. Adjusted close is not substituted for tradable open/close prices. Splits change held shares and basis; dividends credit cash to pre-session holders on the ex-date. Crediting on ex-date rather than payment date is an explicit approximation that permits early reinvestment.

The original `v1` universe is frozen at 50 large-cap tickers. The supported default `v2` excludes Honeywell, retaining 49 tickers. Its 2025 Solstice and 2026 Aerospace spin-offs appear as combined nonstandard Yahoo split factors; treating those factors as share ratios would corrupt holdings. This version rejects unsupported actions instead of inventing prices or share entitlements. The exclusion is a data-support choice, not a return-based selection rule, but remains a restriction on the evaluated universe.

The universe is a fixed basket, not a historical constituent database: survivorship and selection bias remain. Source snapshots can contain later corrections and are not a point-in-time market-data archive. No news access does not erase historical facts from a pretrained model; prompting cannot guarantee absence of memorized future events.

## Contributions, baselines, and metrics

Deposits are external cash flows, not trading profit. Dollar profit is final equity minus contributed capital. Time-weighted returns, drawdown, volatility, and Sharpe use a flow-adjusted return series. Risk-free return is assumed zero; short-window annualized statistics are descriptive and unstable.

Cash and equal-weight buy-and-hold controls receive the same cash flows and corporate actions as the model over the same evaluated sessions. Buy-and-hold invests each contribution equally across the permitted universe. Identical snapshots, execution rules, date ranges, adapter/protocol versions, warm-up, funding, and limits define a comparison cohort.

## Failures and durable evidence

A provider error, exceeded budget, malformed terminal response, or harness failure is an unsuccessful attempt. Orders from that attempt never execute, and its daily contribution/action state is not committed. The run stops as `failed`; resume retries the same date from the prior committed portfolio. Failed-attempt usage and diagnostic evidence remain recorded.

Successful days are committed in calendar order. State cannot skip dates or silently switch data, budgets, funding, model, prompt protocol, or horizon. A contiguous validated daily artifact left by an interrupted commit can be adopted. Reports reconstruct decisions and accounting, validate causal context and hashes, and rebuild derived summary/transaction outputs. Legacy or inconsistent authoritative artifacts are excluded. Hashes detect inconsistency and accidental corruption; they are not signed attestations against an adversary rewriting all evidence.

## Model runtime

The OpenCode adapter uses the official client to access permitted Zen models, with isolated configuration and the six trading tools. The Pi adapter runs the real SDK in a disposable process. Both retain effective prompts, context identity, traces, submitted orders, terminal outcomes, timing, and model/tool/cache/cost usage when reported. Hard deadlines terminate the worker/client process. Neither adapter silently switches models.

Free-only qualification requires an explicit free-model allowlist and zero listed cost; provider availability and pricing can change. A replicate seed is a label, not a sampling guarantee. Replaying a stored decision ledger is deterministic; rerunning an LLM is not.
