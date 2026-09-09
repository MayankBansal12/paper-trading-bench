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

Final full-window qualification is tracked under `results/runs/mimo-v2.5-free/seed-1/qualified-mimo-v4-202606-202608`; its completion and validated metrics will be recorded after the run terminates. Do not treat a running or failed partial portfolio as a completed three-month score.
