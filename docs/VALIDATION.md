# Validation record

Historical record: previous `results/runs` artifacts were cleared at user request on 2026-09-13. Their measurements below describe earlier protocols, not current v9 results. See [the active environment](STUDY_ENVIRONMENT.md).
This branch implements the contract in PRODUCT.md. It is a benchmark harness validation, not evidence that any strategy will make money.

## Nasdaq v7 qualification — 2026-09-12

Profile `nasdaq100-20260601-20260831-v7` is fully implemented and qualified. It freezes universe `v3`, dataset `abc104ae3f2cb258e1c9c9bc996a9f46c14ca83771da5c9acbeb7eaab23b2de7`, protocol `v7-neutral-portfolio-responsibility`, the 2026-06-01 through 2026-08-31 evaluation, funding, execution, behavior rules, budgets, and the exact OpenCode Muse runtime. Historical v5/v6 records below retain their original identities and results.

### Frozen data and no-call validation

- Canonical universe SHA-256: `329f6e120d711d54bf53a01c5b2c83557e5395dfeed3948cb7a2fb389f8ced05`.
- Membership: 101 official Nasdaq-100 securities effective 2026-06-01, frozen through 2026-08-31; 99 tradable after the documented HON and EA exclusions, with no replacements.
- Dataset: 99 OHLCV files and 101 retained source snapshots spanning 100 warm-up plus 64 evaluation sessions. Its 152 supported events comprise 148 dividends and four splits; evaluation splits are CRWD 4-for-1, KLAC 10-for-1, and MNST 2-for-1.
- A network-disabled rebuild from the retained snapshots was byte-identical and produced the same manifest hash. Registered profile preflight accepted exactly 64 evaluation sessions and $1,500 scheduled principal.
- The final no-inference qualification artifact is `results/qualifications/opencode-muse-2026-09-12T08-30-01-990Z.json`. It records official OpenCode client 1.18.30, exact active entry `opencode/muse-spark-1.3-contributor-free`, OpenCode Zen routing, tool-call support, zero input/output/cache pricing, and zero inference calls.

The harness originally pinned OpenCode 1.18.29. The live path was explicitly qualified and locked to the installed official client 1.18.30 instead of spoofing or weakening runtime checks. Muse was never routed through Pi 0.80.2, and no other or paid model was attempted.

### Deterministic full-period control

`results/runs/fake-deterministic-control/seed-1/nasdaq100-deterministic-control-v7` completed 64/64 sessions against the exact Nasdaq data and engine. Principal was $1,500; final value was $1,579.64; time-weighted return was 6.0231%; maximum drawdown was -7.0063%; 171 orders filled, 92 were rejected, and no attempt failed. Average invested capital was 86.6152%, final invested capital was 91.8513%, and cumulative turnover was 361.0738%.

The rendered control report is `results/reports/2026-09-12T07-52-51-317Z.{json,md}`. This fake-agent run is a deterministic integration control, not a model result or trading baseline.

### Separately labeled live smoke

`results/runs/muse-spark-1.3-contributor-free/seed-1/muse-live-smoke-v7-20260912-r1` completed the one-session smoke through the same official client path. It used four turns and eight reconciled tool calls, reported 55,627 tokens and cost $0, filled AMAT and MSFT, and ended at $505.35 with no failed attempt. The report is `results/reports/2026-09-12T07-54-48-488Z.{json,md}`. It is qualification evidence, not part of the three-month score.

### Completed exact-Muse historical run

Run `results/runs/muse-spark-1.3-contributor-free/seed-1/muse-nasdaq100-202606-202608-v7-r1` completed all 64 sessions under one immutable run ID. The report loader replayed and revalidated the complete ledger.

| Measurement | Validated result |
|---|---:|
| Contributed principal | $1,500.00 |
| Final portfolio value | $1,552.38 |
| Dollar profit | $52.38 |
| Time-weighted return | 5.4497% |
| Excess versus cash / equal weight | 5.4497% / 0.8951% |
| Equal-weight buy-and-hold return | 4.5546% |
| Maximum drawdown | -10.0920% |
| Annualized volatility / Sharpe | 23.2876% / 1.0135 |
| Average / final invested | 51.2145% / 39.3325% |
| Average risky HHI / maximum security weight | 0.5094 / 49.4072% |
| Cumulative turnover | 534.7001% |
| Fills / rejected orders | 26 / 0 |
| Trade / no-trade days | 20 / 44 |
| Completed decisions / failed attempts | 64 / 2 |
| Prompt / completion tokens | 2,660,666 / 142,305 |
| Reported cost | $0.00 |

Final cash was $941.79. Holdings were AAPL 1.260017 shares worth $399.24 and ADP 0.738570 shares worth $211.35; cash plus $610.59 holdings reconciles exactly to final equity.

Every committed day contains one exact-model qualification: 64/64 records name only `opencode/muse-spark-1.3-contributor-free`, official-client adapter `official-opencode-client`, client 1.18.30, and proven zero prices. All 64 decisions completed. Aggregate live usage was 226 turns, 381 attempted tools, 2,802,971 tokens, and reported cost $0.

Two transient catalog omissions are deliberately retained:

- June 23 attempt 1 made zero model calls, tools, tokens, or orders. Its terminal trace records the absent exact catalog entry. A validation-order defect caused the outer attempt reason to say prompt mismatch; that artifact remains unchanged, and the defect was fixed so qualification now establishes the effective prompt before validation.
- June 24 attempt 1 correctly reports the same absent catalog entry and likewise made zero model calls, tools, tokens, or orders.

Both sessions later completed after fresh exact-entry/zero-price qualification. No date was skipped, deposits were applied exactly once on July 1 and August 3, and failed attempts executed nothing.

The pre-registered dip rule produced one trigger at the June 5 equal-weight close: reference daily return -3.1944%, followed by the June 8–12 window. Model exposure fell 62.3624 percentage points, forward net buys were -$317.15, and model/reference forward returns were 9.0862%/1.9241%. This is descriptive behavior under the locked rule, not a post-hoc score.

The authoritative report is `results/reports/2026-09-12T08-28-17-274Z.{json,md}`. Re-render it without inference:

```sh
pnpm report -- --dirs=results/runs/muse-spark-1.3-contributor-free/seed-1/muse-nasdaq100-202606-202608-v7-r1
```

The complete offline suite passes with **300 tests, 0 failures, and 4,061 assertions across 26 files**; `pnpm typecheck` and `git diff --check` also pass. Tests cover frozen profile compatibility, dataset/action reconstruction, causal atomic accounting, prompt preservation, official-client runtime/zero-cost gates, reporting analytics, dip behavior, and adversarial artifact replay.

This is one technical price/volume portfolio-management run over one short historical path. It does not establish general model superiority, investing intelligence, or expected future returns. PRODUCT.md lists the remaining execution-cost, survivorship/exclusion, source-revision, unsupported-action, annualization, and historical-memory limitations; PLAN.md predeclares the cohort expansion needed for stronger claims.

## Historical v5/v6 record — 2026-09-09

The following evidence is preserved for its original datasets, universes, prompts, clients, and model routes. It is not reinterpreted as Nasdaq v7 evidence.

### Automated verification

- Bun 1.3.14; TypeScript 5.9.3; Pi SDK 0.80.2; official OpenCode client 1.18.29.
- Original v5 qualification: `pnpm test` **278 passed, 0 failed, 3,925 assertions**, across 22 files.
- `pnpm typecheck`: passed.
- `git diff --check`: passed.
- CI installs pinned dependencies and runs the offline suite; model credentials are not needed.

The tests cover causal observations, Wilder RSI initialization, calendar/warm-up/data corruption, raw split/dividend reconstruction, deposits and flow-adjusted returns, corporate-action entitlements, execution conservation, failed-decision atomicity, hard deadlines, invalid and refused tools, cached-token accounting, prompt/model isolation, and authoritative-artifact replay.

Adversarial regressions include a 99.5% first-day loss followed by all remaining scheduled contributions; deleted failed-attempt evidence after successful retries; altered decision context or prompt; malformed model usage; interrupted writes and orphan recovery; provider errors after queued buys; and a transport that ignores cancellation or loops forever.

### Historical data qualification

The frozen Yahoo snapshot covers June 1 through August 31, 2026: **64 exchange sessions**, with 250 earlier sessions per instrument. Universe `v2` contains 49 equities; HON is explicitly excluded because its spin-offs are not represented correctly by Yahoo's combined split factors.

Dataset SHA-256:

```text
79066938c91b2968c034edb8cb8a29bf4b416fac39befead9a28f47dbf6550ea
```

Source responses, transformation policy, action records, exclusion evidence, and hashes are retained in `datasets/historical/202606_202608`. Rebuilding from the frozen snapshot with network access forbidden reproduced identical bytes and identity. The rejected original 50-stock snapshot is retained separately in `datasets/quarantine/202606_202608_HON_unsupported`.

The downloaded snapshots are local artifacts and are not checked into Git. Re-fetching Yahoo can produce revised source history; use the retained snapshots for exact reproduction.

### Complete deterministic control

```sh
pnpm run run -- --agent=fake --start=2026-06-01 --end=2026-08-31 --data-dir=datasets/historical/202606_202608 --run-id=qualified-control-v4 --max-tool-calls=100
pnpm report -- --dirs=results/runs/fake/seed-1/qualified-control-v4
```

Artifact format `credible-accounting-v4`: **completed 64/64 sessions**, principal **$1,500**, final value **$1,544.01**, cash **$292.26**, 33 holdings, 87 fills, and 27 rejected orders. Report loading revalidated the entire ledger. The fake agent is a deterministic integration control, not a model-performance baseline or an investment strategy recommendation.

### Free API qualification

Direct Zen API requests to free models returned a restriction requiring the official OpenCode client. The adapter uses that actual client with isolated configuration, exact captured prompts, and the six trading tools; it does not spoof client identity or fall back to a paid model.

Preliminary MiMo testing completed one day with two buys, eight tool calls, six model turns, and reported cost **$0**. Its captured prompt and tool ledger were checked, but these preliminary artifacts predate the final v4 integrity/runtime gates and are not scored as final benchmark results. A subsequent real-client timeout returned in 120,005 ms against a 120,000 ms limit with zero executable orders and reported cost $0. Offline delayed-authentication tests also verify that late setup cannot launch a client or mutate an already returned result.

The first final-v4 MiMo day also completed successfully: two fills, eight audited tool attempts, five fully metered requests, 93,603 total tokens (61,184 cache-read tokens), 240,924 ms elapsed, and reported cost **$0**. Every runtime audit matched the exact prompt, model, six-tool permissions, and isolated working directory.

### Completed free-model historical run

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

### v6 comparison preparation — 2026-09-09

New decisions use protocol `v6-explicit-timing-bounded-memory`: exact observation/execution dates, an unknown-opening-price warning for dependent orders, four requested rationale fields, and a hard 1,200-character cap on each remembered rationale. The authoritative response is preserved in full. Market data, trading freedom, five-day memory window, contributions and accounting are unchanged.

The `202606-202608-v6` comparison preset pins the qualified dataset hash, dates, universe, funding, history depth, execution convention, protocol, and daily budgets (12 turns / 20 attempts / 300,000 ms). CLI and API preflight reject mismatches; `--preflight` performs dataset/configuration validation without agent startup. Model/provider availability still requires separate qualification.

Validation for this update:

- Full offline suite: **291 passed, 0 failed, 3,994 assertions**, across 24 files. Typecheck and diff checks pass.
- Regression tests cover explicit dates across weekends/holidays, bounded memory with full artifact preservation, original v5 prompt hashes, protocol separation, immutable preset settings, and rejection of old-protocol live runs before inference.
- The actual retained historical snapshot passes the v6 preset's no-call preflight with 64 sessions and $1,500 scheduled principal.
- The original **v5** MiMo run still passes strict 64-day ledger replay at **$1,746.15**; SHA-256 checks confirm all **70 run artifacts are byte-for-byte unchanged**.

No v6 live model run has been performed. The prior MiMo performance validates the original v5 experiment; it is not a v6 score and must not be pooled into the new protocol's cohort.
