# Synthetic OHLCV fixtures

These deterministic, seeded daily OHLCV arrays are test inputs, not real market observations. `scripts/generate-fixtures.ts` produces them for the fixed 50-security test universe and the exchange calendar. Regenerate with `pnpm fixtures:generate`.

The dataset loader validates the calendar and prices and includes their content hashes in dataset identity. Tests use these files for accounting, causal observation windows, tools and recovery. They cannot qualify as a historical model benchmark.

Import real data into a separate, ignored dataset directory; never replace fixtures with downloaded prices. See the [data guide](../../src/data/README.md) and [environment contract](../../docs/STUDY_ENVIRONMENT.md).
