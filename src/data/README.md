# Historical dataset protocol

`loadDataset(dataDir?)` in `dataset.ts` returns an immutable `MarketDataset`.
Without a directory it loads the legacy 50-ticker synthetic test fixtures. Real
runs select a manifest directory explicitly. Every load verifies SHA-256 file
and source-snapshot hashes, schemas, action domains, shared session coverage,
and the versioned US exchange calendar. The dataset version is the SHA-256 of
manifest bytes, which contain all data and source hashes. No data is loaded at
module import time. `FIXTURE_VERSION` is a deprecated legacy fixture label;
credible run identity must use `dataset.version`.

Call `validateDatasetWindow(dataset, start, end, warmupBars, universe)` before
inference. Requested calendar boundaries must be inside declared coverage;
weekends/holidays do not shorten the declared range. All tickers must have every
session, and sufficient bars before the first evaluation session. The calendar
supports 2000–2030, including exchange holidays, known exceptional closures, and
early-close sessions. It is a frozen rule set, not a live exchange feed.

## Observation and accounting conventions

Stored OHLCV is reconstructed as traded. `openOn` and `closeOn` return raw prices.
`actionsOn` returns splits before dividends; cash dividends are credited on the
ex-date to prior holdings after any same-day split. Actual dividend payment-date
lag is intentionally omitted in this protocol.

`asOfBefore(ticker, date)` excludes the current and future sessions. It adjusts
prior prices and volume only for splits effective on or before the decision
date. Dividend gaps remain visible. Returned rows/actions are copies, so a
consumer cannot mutate the dataset. Current-day split information is part of the
pre-open accounting event, not a future observation.

Compute indicators from the **entire causal history prefix**, then independently
truncate bars for the prompt. RSI uses Wilder's initial arithmetic mean of the
first 14 changes and recursively smooths every later change. Both-zero averages
produce neutral RSI 50. SMA/RSI retain full precision; round only for display.
The seed is anchored at the frozen dataset's history start. At least 60 prior bars
are required by the historical importer; its default requested minimum is 100,
and its default one-year history typically provides about 250.

## Yahoo import and reproduction

```
bun scripts/import-yahoo.ts --start 2026-06-01 --end 2026-08-31 --out datasets/historical/202606_202608 --universe-version v2
bun scripts/import-yahoo.ts --from-snapshot datasets/historical/202606_202608 --out /tmp/identical-replay
```

Destinations must not exist. A staged dataset is validated before publication.
The importer can explicitly derive a versioned subset from authenticated raw
snapshots using `--from-snapshot DIR --universe-version v2`; its manifest records
the parent hash and exclusions. Normal snapshot replay has no network calls and
produces byte-identical manifest/data/source files. Custom `--tickers` and
`--universe-version` are mutually exclusive. BRK.B maps explicitly to Yahoo BRK-B.

Yahoo quote OHLC is split-adjusted. Adjusted-close additionally incorporates
cash distributions and is never used here. Volume is inversely split-adjusted;
older dividend amounts also reflect later splits. All later splits through the
snapshot time must be downloaded, even if they occur after evaluation ends,
to reconstruct raw prices/volumes/dividends correctly. The resulting dataset is
then trimmed to the historical coverage end. This source reconstruction does not
expose future actions to the decision API.

Empirical verification: Yahoo's Apple 2020-08-07 dividend is 0.205, whereas Apple
declared 0.82. Multiplication by the later 4-for-1 split restores the as-traded
cash dividend. The downloaded 2020-08-28 OHLC similarly reconstructs open
504.04998779296875 and close 499.2300109863281, retaining source precision.

Sources: [Yahoo adjustment convention](https://help.yahoo.com/kb/SLN28256.html),
[Yahoo historical prices](https://finance.yahoo.com/quote/AAPL/history/),
[Apple July 2020 issuer declaration](https://www.apple.com/newsroom/2020/07/apple-reports-third-quarter-results/),
[NYSE calendar](https://www.nyse.com/trade/hours-calendars).

## Supported universe and limitations

Universe v1 remains the original synthetic 50. Historical default v2 contains the
same equities except HON (49). Yahoo encodes Honeywell spin-off adjustments as
1.061 on 2025-10-30 and 0.9535 on 2026-06-29. Treating those as share ratios would
lose the SOLS/HONA distributions and mishandle the actual HON 1-for-2 reverse
split. The historical loader/converter reject nonstandard factors pending issuer
review; they are not approximated as cash or fictional share splits.

The rejected original 50-ticker snapshot is preserved under
`datasets/quarantine/202606_202608_HON_unsupported`, with issuer evidence in
`REJECTED.md`. The valid v2 snapshot excludes HON from warmup and evaluation and
records the exclusion reason and parent hash. NFLX's 2025-11-17 split is a genuine
10-for-1 share split, [confirmed by Netflix](https://ir.netflix.net/investor-news-and-events/financial-releases/press-release-details/2025/Netflix-Announces-Ten-For-One-Stock-Split/default.aspx).

The small-rational split gate is conservative screening, not a comprehensive
corporate-action detector. Other spin-offs, rights, mergers and capital-gain
distributions are unsupported. An unusual legitimate split may need additional
issuer review and implementation. Yahoo may revise source history; reproduce
experiments from frozen snapshots, not a fresh download. The fixed present-day
universe and exclusion policy introduce selection/survivorship bias; results
apply to this declared universe and window.
