# Benchmark contract

## Scope and claim boundary

The product is a reproducible, sequential **technical price/volume portfolio-management benchmark** over a frozen Nasdaq-100-derived security set. It measures how a specified model manages one constrained paper portfolio under the declared data, prompt, execution, funding, and runtime contract. It does not measure general investing intelligence, fundamental research, news understanding, live execution skill, or future profitability.

The registered cohort is designed to admit later immutable periods, market regimes, and replicate labels. One June–August 2026 result must never be presented as general model superiority.

## Registered period, funding, and freedom

Profile `nasdaq100-20260601-20260831-v7` covers all 64 exchange sessions from June 1 through August 31, 2026. It begins with $500 and adds $500 before the July 1 and August 3 opens, for $1,500 total principal.

The model may buy, sell, hold, remain entirely in cash, choose any eligible security, choose sizes, concentrate or diversify, and choose its turnover. Long-only fractional shares are available; leverage and shorting are not. No instruction forces a trade, full investment, indicator screen, tool sequence, position limit, stop loss, or particular strategy. The model is responsible for available cash, scheduled contributions, portfolio balance, concentration, drawdown exposure, liquidity discipline, and next-open uncertainty.

Each day has 12 model turns, 20 attempted tool calls (invalid calls count), and 300,000 ms. A replicate seed labels independent runs; it is not a provider sampling seed.

## Causal information and atomic execution

For execution session D, observations end at the preceding exchange session’s close. The model can inspect its cash/holdings, the fixed universe, OHLCV history, SMA20, SMA50, and RSI14. Indicators are initialized from the complete retained prefix, while prompt history is bounded. D’s open and later prices are unavailable during the decision.

The only tools are `get_portfolio`, `get_universe`, `get_ohlcv`, `get_indicators`, `buy`, and `sell` (`trading_`-prefixed through OpenCode MCP). The model has no news, web, shell, filesystem, delegation, connectors, or ambient tools.

A completed decision produces a queued order batch. Orders execute sequentially at D’s open only after the response finishes; the portfolio is valued at D’s close. Queued orders do not mutate intradecision portfolio tools. A sale can fund only later queued buys, and its proceeds can differ from prior-close estimates. Fractional units round down to six decimals; cash follows the cent ledger. Defensive finite-number, maximum-money, and maximum-unit bounds remain active.

A provider error, timeout, budget cutoff, malformed decision, prompt/runtime mismatch, or execution-validation failure executes no orders. The attempt and its usage remain durable; resume retries the same session from the preceding committed state. Deposits and actions are not double-applied.

## Universe identity

Universe `v3` is security-level Nasdaq-100 membership effective June 1, 2026, frozen through the period. Its sources and construction are part of experiment identity:

1. Nasdaq’s official component-weights snapshot as of May 1, 2026: 101 securities representing 100 issuers.
2. Nasdaq’s announced LITE addition and CSGP removal effective May 18.
3. The June quarterly changes effective June 22 are recorded but do not change the already frozen eligibility set.

Both GOOG and GOOGL are eligible because both share classes are constituents. Equal-weight controls weight each eligible security, not each issuer.

Two start-of-period constituents are excluded for predeclared data/accounting support reasons, with no replacements:

- HON: its June 29 Honeywell Aerospace distribution plus 1-for-2 reverse split cannot be faithfully represented by split/dividend-only accounting.
- EA: Yahoo has no finite opening observation for July 20; missing execution prices are not imputed or forward-filled.

The supported tradable set therefore contains 99 securities. Canonical record `src/config/universes/nasdaq100-2026-06-01-v3.json` has SHA-256 `329f6e120d711d54bf53a01c5b2c83557e5395dfeed3948cb7a2fb389f8ced05`. It is copied into and hash-verified with the dataset. Historical `v1` and `v2` lists are unchanged.

## Frozen market dataset

Dataset directory `datasets/historical/nasdaq100_202606_202608_v2` has manifest SHA-256 `abc104ae3f2cb258e1c9c9bc996a9f46c14ca83771da5c9acbeb7eaab23b2de7`. Coverage is January 6 through August 31, 2026: exactly 100 warm-up sessions followed by 64 evaluation sessions for all 99 securities.

The importer preserves source responses and validates symbol identity, USD currency, New York exchange timezone, instrument type, exchange calendar completeness, one bar per security/session, finite positive OHLC, OHLC bounds, volume, actions, and every file hash. It retains 101 source snapshots including membership evidence. The coverage contains 152 supported actions (148 dividends and four splits); the evaluation contains 58 dividends and the CRWD 4-for-1, KLAC 10-for-1, and MNST 2-for-1 splits.

Yahoo quote OHLCV is reconstructed to raw as-traded values using supported later split events; adjusted close is never an execution price. Prior history is normalized only for splits effective by the decision date. Splits change held units/basis and dividends credit cash to ex-date holders. Exotic split factors, capital-gain distributions, source gaps, unsupported events, or incompatible policy metadata fail closed. Pre-coverage events are discarded only because no retained raw bar or holding can precede coverage.

The local snapshot can be rebuilt with networking disabled; the rebuild must be byte-identical. A fresh provider download may contain retrospective revisions and is a new dataset identity, never a silent substitute.

## Prompt protocol identity

Active protocol `v7-neutral-portfolio-responsibility` states the freedom and responsibilities above without suggesting securities, forcing turnover, reserving tools for trading, or prescribing an indicator-first process. It explicitly states observation-close/unknown-open timing, ordered cash effects, supported actions/contributions, liquidity diagnostics, and atomic failure.

The exact v7 system prompt SHA-256 is `3142fe7bb527324545001f6078f49f8d44ae6400c0eb04a20a86140a31eae062`; the registered representative daily prompt SHA-256 is `3f254137e16f44fb48b6a7fd28650ad6c512cc9c642f26bd70998d927b725ef9`.

Frozen v5 and v6 builders remain selectable only for historical replay. Their hashes and semantics are unchanged. Live runs require v7, so existing artifacts cannot silently resume into a new prompt.

## Controls and reporting

The cash control receives the same deposits and holds cash. The equal-weight buy-and-hold control buys every eligible security equally at the first open and invests each later contribution equally at that session’s open; it never rebalances and retains dividend cash. It shares dataset, action, funding, calendar, and fill conventions with the model. It is intentionally a transparent security-equal-weight control, not official market-cap-weighted NDX; no unmatched index series is introduced.

Flow-adjusted return removes external deposits. Registered reports expose, without a composite score:

- ending equity, profit, time-weighted return, and excess versus cash/equal weight;
- maximum drawdown, volatility, Sharpe, return/drawdown, return/volatility, tracking error, and information ratio;
- risky-asset HHI, effective position count, largest weight, holdings count, and final weights;
- average/final/min/max invested percentage, fully-cash days, and contribution-day net purchases;
- trade/no-trade days, buys/sells, unique holdings, gross/net notional, and turnover;
- fills/rejections/failed attempts, turns/tools/tokens/time per decision and per fill;
- filled shares divided by reported session volume, including zero-volume flags;
- every pre-registered dip trigger and causal next-five-session exposure, trading, and relative return behavior.

A dip triggers at an equal-weight control close when its flow-adjusted daily return is at or below -2% or its flow-adjusted drawdown is at or below -5%. After a trigger, five subsequent sessions are suppressed. Behavior is measured over the next five sessions, excluding the trigger session because that day’s model decision preceded the triggering close. Incomplete terminal windows are retained with null forward measurements.

## Model/runtime evidence

Real inference is permitted only through official OpenCode 1.18.30 and exact catalog ID `opencode/muse-spark-1.3-contributor-free`, with `freeOnly=true`. Before inference, the harness refreshes `opencode models opencode --verbose`, requires an active entry named free at the OpenCode Zen endpoint, requires tool-call support, and requires zero input/output/cache prices with no pricing tiers. The catalog stdout hash and resolved entry are retained in traces.

`@earendil-works/pi-ai` 0.80.2 does not supply this model, so Muse is never routed through Pi. Any missing catalog entry, nonzero/ambiguous price, wrong client, wrong provider/model, runtime drift, prompt drift, extra tool, or nonzero reported cost fails closed. No other live model is attempted. Offline Pi transport tests and deterministic fake controls do not perform real inference and remain allowed.

## Known experimental limits

There are no fees, spreads, slippage, market impact, taxes, borrowing, shorting, delisting claims, spin-off/rights/merger/cash-in-lieu accounting, or intraday liquidity constraints. Dividend timing uses ex-date cash. Liquidity is diagnostic rather than enforced. The fixed supported universe has exclusion and survivorship effects, data may have retrospective corrections, and pretrained models may remember the historical period. Short-window annualization is descriptive and unstable. Hashes detect accidental incompatibility; they are not signatures against an adversary rewriting all evidence.
