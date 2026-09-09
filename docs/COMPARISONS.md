# Controlled model and harness comparisons

The first series uses preset `202606-202608-v6`. Its definition is checked into `src/config/comparison.ts`. Treat it as immutable: changed dates, data, budgets, or rules require a new named series, not edits to an existing comparison.

| Setting | Frozen value |
|---|---|
| Evaluation | June 1–August 31, 2026; 64 exchange sessions |
| Dataset SHA-256 | `79066938c91b2968c034edb8cb8a29bf4b416fac39befead9a28f47dbf6550ea` |
| Universe | v2, 49 stocks; HON excluded for unsupported spin-offs |
| Funding | $500 initially; $500 July 1; $500 August 3 |
| Market history | Up to 100 prior bars through the observation close; indicators use the full available prefix |
| Memory | Five prior trading days; each rationale excerpt at most 1,200 characters |
| New rationale instruction | Decision, Evidence, Risk, Invalidation; at most 1,200 characters |
| Daily budget | 12 model turns, 20 attempted tools, 300,000 ms |
| Tool set | Portfolio, universe, OHLCV, indicators, buy, sell |
| Execution | Unknown next-session opening price, queue order, immediate executed-sale proceeds |
| Protocol | `v6-explicit-timing-bounded-memory` |

The current portfolio and actual recent fills/rejections remain available independently of the rationale excerpt. Long model responses are retained verbatim in artifacts and usage; only their inclusion in later prompts is truncated. A response exceeding the requested format/length does not itself become a failed decision. No long-term journal, extra tools, position limits, or stop-loss rules are introduced.

## Running and retrying

```sh
# No inference, no credentials needed, no run artifacts written.
pnpm run run -- --comparison=202606-202608-v6 --preflight

# Future authorized comparison run; not executed as part of preparing the preset.
pnpm run run -- --comparison=202606-202608-v6 --agent=opencode --model=mimo-v2.5-free --seed=1
```

`--data-dir` may locate a copy of the same immutable snapshot. Downloading Yahoo again is not guaranteed to reproduce it; a changed hash must fail rather than be silently substituted. Date, budget, universe, capital, warm-up, and smoke flags cannot override the preset. The CLI and runner also validate the pinned protocol and execution convention.

Model, provider, adapter, replicate (`--seed`), run ID and explicit free/paid policy may vary. Paid access still requires `--free-only=false`; the official OpenCode adapter retains its free allowlist. An equal replicate label is not a shared random seed or a guarantee of deterministic outputs.

Retry an interrupted run with exactly the same command. Use a new replicate or run ID for a new independent run. Never overwrite or resume a v5 run with v6 instructions. Historical v5 replay remains supported using its original prompt builders; the v5 result stays in a separate cohort.

## Qualification and interpretation

1. Run no-call preflight, then a short, separately labeled smoke qualification for each new model/adapter. A full-profile preflight does not test authentication, provider compatibility, or actual tool use. Smoke runs deliberately use unprofiled shorter windows and are not comparison scores.
2. Compare models through the **same adapter**, using this preset and retained dataset. Check actual runtime/model evidence; settings shared across adapters do not guarantee identical provider reasoning defaults or inference behavior.
3. Compare supported adapters as a separate harness experiment, preferably holding the model/provider constant. Reports intentionally keep different adapters in separate cohorts; inspect these alongside one another as harness results rather than pooling them as model-only scores.
4. Repeat runs and add separately frozen rising, falling and sideways windows selected before inspecting model results. This one historical window is qualification evidence, not proof of general trading ability.

Free Zen models currently require the actual OpenCode client. Pi's direct provider path is not an interchangeable route to those free endpoints. Use a provider/model that supports the intended adapter and qualify it first; do not bypass provider restrictions or silently substitute a different model.

Report every registered attempt, including failures and timeouts: final portfolio, contributions, net profit, time-weighted return, drawdown, concentration, fills/rejections, failed attempts, tokens and reported cost. Incomplete runs are not completed benchmark results. The report already retains failed-attempt resource usage and separates incompatible protocol, dataset, funding and budget settings.

This series preserves the original simulation limitations: selected surviving stocks, unsupported spin-offs/delistings, ex-date dividend cash, no fees/slippage, retrospective data corrections, and possible pretrained historical knowledge.
