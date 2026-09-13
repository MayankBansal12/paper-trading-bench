# Frozen market-data protocol

`loadDataset(dataDir)` returns an immutable, hash-verified `MarketDataset`. The registered Nasdaq snapshot is `datasets/historical/nasdaq100_202606_202608_v2`, manifest SHA-256 `abc104ae3f2cb258e1c9c9bc996a9f46c14ca83771da5c9acbeb7eaab23b2de7`.

## Registered identity

- Universe: `v3`, 99 supported securities from Nasdaq-100 membership effective 2026-06-01 and frozen through 2026-08-31.
- Coverage: 2026-01-06…2026-08-31, 164 exchange sessions.
- Evaluation: 2026-06-01…2026-08-31, 64 sessions; exactly 100 preceding warm-up sessions.
- Membership evidence: `sources/universe-v3.json`, SHA-256 `329f6e120d711d54bf53a01c5b2c83557e5395dfeed3948cb7a2fb389f8ced05`, byte-identical to the checked-in canonical record.
- Price files: 99; source snapshots: 101; importer: `yahoo-raw-v3`.
- Actions over coverage: 148 dividends and four splits. Evaluation splits are CRWD 4-for-1 on July 2, KLAC 10-for-1 on June 12, and MNST 2-for-1 on August 11.
- Adjustment convention: `raw-as-traded-ohlcv;split-events;dividend-cash-on-ex-date-v1`.

HON is excluded because the June 29 distribution/reverse-split combination is unsupported. EA is excluded because July 20 has no finite source open. There are no substitutes and no price imputations. Both GOOG and GOOGL remain separate eligible securities.

## Validation

Loading verifies the manifest schema and SHA, every transformed bar file, every source snapshot, membership record/definition/exclusions, exchange calendar, coverage/evaluation bounds, one bar per security/session, finite OHLCV domains, and action policy. Any mismatch fails before inference.

`validateDatasetWindow(dataset, start, end, warmupBars, universe)` rejects missing universe members, insufficient history, truncated periods, and out-of-range dates. Historical runs must explicitly identify the loaded manifest hash in `RunConfig.fixtureVersion`.

Yahoo quote OHLCV is retrospectively split-adjusted. Import reconstructs raw as-traded OHLCV using every supported split on or after the retained coverage start, including events after evaluation when present. A pre-coverage split cannot affect a retained raw bar or holding and is discarded. Adjusted close is ignored. Indicators normalize history only for splits already effective by the decision date, preventing future-action leakage.

Splits alter held units and basis before orders on the effective session. Dividends credit cash to ex-date holders before that session’s orders. Capital-gain distributions, exotic split factors, spin-offs, rights, mergers, cash-in-lieu, missing bars, duplicate events, or unsupported domains fail closed.

## Import and no-network rebuild

A new network import writes only to a nonexistent destination and stages/validates before publication:

```sh
pnpm data:import -- --start=2026-06-01 --end=2026-08-31 --history-start=2026-01-06 --out=datasets/historical/<new-version> --universe-version=v3
```

Provider history can be revised. A fresh import that differs is a new dataset and requires a new profile; never overwrite `v2` or relax the registered hash.

Rebuild the retained raw snapshots without network access:

```sh
pnpm data:import -- --from-snapshot=datasets/historical/nasdaq100_202606_202608_v2 --out=/tmp/nasdaq100-rebuilt
```

The rebuilt `manifest.json` and all descendants must be byte-identical. The importer refuses an existing output path.

Downloaded snapshots are ignored by Git because provider redistribution restrictions may apply. Preserve the retained directory as an experiment artifact and back it up with its hash. Synthetic fixtures under `fixtures/ohlcv` exist only for deterministic tests/smokes and cannot qualify as a historical benchmark.
