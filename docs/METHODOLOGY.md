# Methodology

## Experiment

Each model has four independent accounts: 2025 Q2, Q3, Q4 and 2026 Q1. Their
62, 64, 64 and 61 sessions total 251 days. Each quarter starts with $50,000,
empty holdings and empty journals. The first trading session of the next two
months adds $50,000 each: $150,000 per quarter, $600,000 across four accounts.
Portfolios and memory never carry between quarters.

Every day starts a new client session. Its context contains the date, portfolio,
eligible ticker names, previous-close marks for held stocks and up to three recent
committed journals. Prices for unheld stocks require a tool query or a price
previously recorded in a journal.
The model has four tools:

| Tool | Purpose |
|---|---|
| `market_snapshot` | Previous closes for eligible stocks |
| `price_history` | Historical OHLCV bars, up to the advertised limit (maximum 252 sessions) |
| `journal` | Search original committed notes |
| `submit_day` | Submit ordered trades and a journal; empty orders mean HOLD |

There is no browsing or news tool. The tools expose no future prices.
Supplied market data ends at the previous close. Orders execute in their
submitted order at the next open; the day's close values the resulting portfolio.
The engine handles dividends and splits. It does not force quarter-end liquidation.

Fractional shares and dollar-sized orders are supported. No shorting, borrowing,
fees, slippage or market impact are simulated. A rejected order does not become a
fill. Submitted journals are stated explanations, not access to private reasoning.

## Failures and memory

An attempt has a 60-minute watchdog, with no fixed turn or tool-call limit.
Each request has a size limit: 2 MiB for Pi/OpenCode and 4 MiB for Claude Code.
A history-tool response can reach 512 KiB, so accumulated query output can hit
the request limit before the watchdog. These limits differ by client.
Recoverable tool errors can be corrected within the attempt. At most two attempts
are allowed per day. After both fail, that day is invalid and holdings carry
forward without new orders. Three consecutive invalid days stop the quarter.
Failed attempts remain in the evidence and their journals are not preloaded.
The stored outcome `harness_error` is broad: inspect its recorded reason and
provider responses to distinguish quota, transport, client and audit failures.

Quota-aware runs pause until the provider's reset plus five minutes. The shared
supervisor checks login and storage before a new attempt; this does not refund
an attempt that has already started. It never restarts a completed or blocked run.

## Measures

- **Net profit:** ending equity minus contributions, summed across four accounts.
- **Average quarterly profit:** net profit divided by four.
- **Quarterly TWR:** daily returns adjusted for external deposits, compounded within
  that quarter. The reported average is the arithmetic mean of four quarterly TWRs.
- **Realized P&L:** executed sale proceeds minus allocated weighted-average cash
  cost. Splits preserve cost. Dividends are reported separately.
- **Unrealized P&L:** quarter-end value of open holdings minus their remaining cost.
- **Risk:** cash exposure, issuer concentration, daily volatility and drawdown are
  separate measures. GOOG and GOOGL combine as Alphabet for issuer exposure.

The four accounts do not form a continuous annual equity curve. Usage observations
and catalog price estimates are distinct from actual subscription charges; missing
cost is not zero.

## Verification and comparison

Each run records its exact model, source revision, runtime and dataset hashes.
Events form a hash chain; daily commits reference accepted submissions and fills.
Replay verifies the saved decisions without asking the model to decide again.
New decisions require a fresh run. Reproduce historical runs with their recorded
source, not whichever revision is currently on `main`.

Continuations record their parent and boundary state. Supplemental recoveries keep
original failures and disclose extra attempts; they do not turn the original into
an uninterrupted run. The results manifest records selected quarters and exceptions.

Tools exposed only past market data, but some journals introduced unsupported news
and fundamental explanations. The experiment cannot rule out training-data
familiarity or isolate its effect on decisions.

These are observations from one market sample, with differing clients and source
revisions. Supported securities do not prove historical index membership. Results
do not isolate model weights or establish a stable ranking. Rerunning a model can
produce different decisions.
