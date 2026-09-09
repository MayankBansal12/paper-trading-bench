# Remaining work

The implemented scope is the historical, monthly-funded, sequential technical-analysis experiment described in PRODUCT.md. Tests and saved qualification evidence should establish correctness before results are used to compare models.

Further improvements, in priority order:

1. Add independently verified spin-off, merger, delisting, and cash-in-lieu accounting, including assets outside the trading universe. Restore excluded instruments only when their full economic value is represented.
2. Add a second data source and issuer/action cross-checks. Preserve point-in-time revisions and historical universe membership to reduce retrospective-data and selection bias.
3. Offer realistic commission, spread, slippage, liquidity, and tax assumptions as explicitly versioned execution scenarios, with matched baselines.
4. Evaluate multiple market regimes and repeated model runs. Report distributions and uncertainty, not a ranking from a single three-month path. Separate harness differences from model differences.
5. Investigate historical-memory contamination with anonymized instruments/dates and genuinely held-out periods, while documenting the changed task those controls create.
6. Add additional reproducible technical-analysis controls and ablations (indicator-only, buy-and-hold, momentum, mean reversion), using identical observations and cash-flow rules.
7. Pin and continuously qualify official-client versions and model catalogs; add free-provider availability checks that never silently incur paid fallback charges.

Do not treat more indicators, richer prose, or additional charts as substitutes for reliable data, accounting, and experimental controls.
