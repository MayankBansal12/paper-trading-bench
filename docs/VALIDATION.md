# Validation record — 2026-09-09

This branch implements the contract in PRODUCT.md. It is a benchmark harness validation, not evidence that any strategy will make money.

## Automated verification

- Bun 1.3.14; TypeScript 5.9.3; Pi SDK 0.80.2; official OpenCode client 1.18.29.
- `pnpm test`: **278 passed, 0 failed, 3,925 assertions**, across 22 files.
- `pnpm typecheck`: passed.
- `git diff --check`: passed.
- CI installs pinned dependencies and runs the offline suite; model credentials are not needed.

The tests cover causal observations, Wilder RSI initialization, calendar/warm-up/data corruption, raw split/dividend reconstruction, deposits and flow-adjusted returns, corporate-action entitlements, execution conservation, failed-decision atomicity, hard deadlines, invalid and refused tools, cached-token accounting, prompt/model isolation, and authoritative-artifact replay.

Adversarial regressions include a 99.5% first-day loss followed by all remaining scheduled contributions; deleted failed-attempt evidence after successful retries; altered decision context or prompt; malformed model usage; interrupted writes and orphan recovery; provider errors after queued buys; and a transport that ignores cancellation or loops forever.

## Historical data qualification

The frozen Yahoo snapshot covers June 1 through August 31, 2026: **64 exchange sessions**, with 250 earlier sessions per instrument. Universe `v2` contains 49 equities; HON is explicitly excluded because its spin-offs are not represented correctly by Yahoo's combined split factors.

Dataset SHA-256:

```text
79066938c91b2968c034edb8cb8a29bf4b416fac39befead9a28f47dbf6550ea
```

Source responses, transformation policy, action records, exclusion evidence, and hashes are retained in `datasets/historical/202606_202608`. Rebuilding from the frozen snapshot with network access forbidden reproduced identical bytes and identity. The rejected original 50-stock snapshot is retained separately in `datasets/quarantine/202606_202608_HON_unsupported`.

The downloaded snapshots are local artifacts and are not checked into Git. Re-fetching Yahoo can produce revised source history; use the retained snapshots for exact reproduction.

## Complete deterministic control

```sh
pnpm run run -- --agent=fake --start=2026-06-01 --end=2026-08-31 --data-dir=datasets/historical/202606_202608 --run-id=qualified-control-v4 --max-tool-calls=100
pnpm report -- --dirs=results/runs/fake/seed-1/qualified-control-v4
```

Artifact format `credible-accounting-v4`: **completed 64/64 sessions**, principal **$1,500**, final value **$1,544.01**, cash **$292.26**, 33 holdings, 87 fills, and 27 rejected orders. Report loading revalidated the entire ledger. The fake agent is a deterministic integration control, not a model-performance baseline or an investment strategy recommendation.

## Free API qualification

Direct Zen API requests to free models returned a restriction requiring the official OpenCode client. The adapter uses that actual client with isolated configuration, exact captured prompts, and the six trading tools; it does not spoof client identity or fall back to a paid model.

Preliminary MiMo testing completed one day with two buys, eight tool calls, six model turns, and reported cost **$0**. Its captured prompt and tool ledger were checked, but these preliminary artifacts predate the final v4 integrity/runtime gates and are not scored as final benchmark results. A subsequent real-client timeout returned in 120,005 ms against a 120,000 ms limit with zero executable orders and reported cost $0. Offline delayed-authentication tests also verify that late setup cannot launch a client or mutate an already returned result.

The first final-v4 MiMo day also completed successfully: two fills, eight audited tool attempts, five fully metered requests, 93,603 total tokens (61,184 cache-read tokens), 240,924 ms elapsed, and reported cost **$0**. Every runtime audit matched the exact prompt, model, six-tool permissions, and isolated working directory.

## Completed free-model historical run

The final run `results/runs/mimo-v2.5-free/seed-1/qualified-mimo-v4-202606-202608` completed **64/64 sessions** through August 31. `loadValidatedSummary` independently replayed the complete v4 ledger successfully. The immutable configuration used free MiMo, OpenCode 1.18.29, 12 turns, 20 attempted tools, and a 300,000 ms deadline per daily decision.

| Measurement | Validated result |
|---|---:|
| Contributed principal | $1,500.00 |
| Final portfolio value | $1,746.15 |
| Dollar profit | $246.15 |
| Time-weighted return | 18.5855% |
| Maximum drawdown | -10.8619% |
| Cash | $12.84 |
| Fills / rejected orders | 30 / 3 |
| Completed decisions / failed attempts | 64 / 2 |
| Reported total tokens, including failed attempts | 8,444,670 |
| Reported API cost | $0.00 |

Final holdings: IBM 1.813966 shares ($424.23), TSLA 1.899358 shares ($698.87), and QCOM 3.579376 shares ($610.21). Holdings total $1,733.31; adding $12.84 cash reconciles to final equity.

The July 1 and August 3 deposits were each exactly $500. Provider errors on July 9 and August 28 each recovered on one retry using the unchanged configuration. All failed-attempt evidence and reported usage remain included; no date was skipped and no failed decision executed orders. Cash control ended at $1,500; the equally funded buy-and-hold baseline ended at $1,555.63 (3.098% time-weighted return).

Revalidate and render the final report without calling a model:

```sh
pnpm report -- --dirs=results/runs/mimo-v2.5-free/seed-1/qualified-mimo-v4-202606-202608
```

These figures establish that the full experiment ran and reconciled under its declared assumptions. A single historical model run is not evidence of general trading ability; retain the universe/data-selection, ex-date dividend, missing execution-cost, and historical-memory limitations in PRODUCT.md.
