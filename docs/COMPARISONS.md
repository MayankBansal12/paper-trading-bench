# Controlled comparisons

Historical record: previous `results/runs` artifacts were cleared at user request on 2026-09-13. Their measurements below describe earlier protocols, not current v9 results. See [the active environment](STUDY_ENVIRONMENT.md).
Comparison identities live in the registry in `src/config/comparison.ts`. An existing profile is immutable: changed membership, data, dates, funding, prompt, budgets, execution, runtime policy, or behavior rules require a new profile ID. Reports fail closed or form separate cohorts; they never pool incompatible runs.

## Registry

| Setting | `202606-202608-v6` (historical) | `nasdaq100-20260601-20260831-v7` (active) |
|---|---|---|
| Evaluation | 2026-06-01…2026-08-31, 64 sessions | 2026-06-01…2026-08-31, 64 sessions |
| Dataset hash | `79066938…f6550ea` | `abc104ae…23b2de7` |
| Universe | v2, 49-stock legacy subset | v3, 99 supported start-of-period Nasdaq-100 securities |
| Membership | legacy basket | effective 2026-06-01, frozen through 2026-08-31; security-level GOOG/GOOGL |
| Exclusions | HON | HON unsupported distribution/reverse split; EA missing open; no substitutes |
| Funding | $500 + $500 July 1 + $500 August 3 | same |
| Warm-up | 100 sessions | 100 sessions |
| Memory | five prior days; 1,200 chars/rationale | same bounded memory |
| Prompt | `v6-explicit-timing-bounded-memory` | `v7-neutral-portfolio-responsibility` |
| Daily budget | 12 turns / 20 attempts / 300,000 ms | same |
| Execution | prior-close observation / queued next-open fills / close valuation | same causal atomic convention |
| Behavior rules | none; never backfilled | `dip-behavior-v1`, locked thresholds/windows |
| Live model policy | historical replay only under current runner | exact official OpenCode Zen Muse free path |

The v6 builder and prompt hashes are preserved; no historical v5/v6 result acquires v7 analytics by reinterpretation. New real inference requires v7.

## Active profile procedure

Run these gates in order:

```sh
# Frozen profile/data; no agent, credentials, artifacts, or inference.
pnpm run run -- --comparison=nasdaq100-20260601-20260831-v7 --preflight

# Current official client/catalog and explicit zero-price evidence; no inference.
pnpm model:preflight

# One-session qualification, separately labeled and not a benchmark result.
pnpm run run -- --agent=opencode --provider=opencode --model=muse-spark-1.3-contributor-free --free-only=true --smoke --data-dir=datasets/historical/nasdaq100_202606_202608_v2 --universe-version=v3 --start=2026-06-01 --end=2026-06-01 --warmup-bars=100 --run-id=muse-live-smoke-v7

# Only after every prior gate passes.
pnpm run run -- --comparison=nasdaq100-20260601-20260831-v7 --seed=1 --run-id=muse-nasdaq100-202606-202608-v7-r1
```

The exact live path is `opencode/muse-spark-1.3-contributor-free` through official OpenCode 1.18.30. `muse-spark-1.3-free`, Pi, other providers/models, ambiguous pricing, and paid fallback are refused. Catalog qualification is repeated before every daily inference and stored with the decision evidence. All failed attempts remain on disk; retry never hides them.

A deterministic full-period fake run may test the harness, but comparison profiles reject fake agents. Label controls separately.

## Equal circumstances

Within a cohort, every run must share universe and membership source, dataset and action policy, evaluation and warm-up, contributions, execution convention, prompt protocol, behavior rules, limits, and adapter class. Model and replicate labels may differ only in a profile that permits them. The active profile intentionally locks provider/model/adapter because only one free Muse route is currently qualified.

The controls use identical sessions and cash flows:

- Cash retains all principal.
- Security-equal-weight buy-and-hold purchases all 99 supported securities at the first open and allocates each contribution equally at that contribution open. It never rebalances and retains dividends.

No official NDX benchmark is added because a reproducible, point-in-time, market-cap-weighted total-return series with matched action/cash-flow/execution semantics is not frozen here. Label the equal-weight control accurately.

## Reporting and pre-registered dip behavior

Do not rank models with one synthetic score. Report return/excess, risk, concentration, cash/capital use, turnover/holdings, operations, liquidity diagnostics, and dip events separately.

`dip-behavior-v1` uses the equal-weight control. A trigger occurs at close on a flow-adjusted daily loss of at least 2% or drawdown of at least 5%; five following sessions are suppressed. Model exposure change, net buys, model/reference returns, and excess return are measured over the next five sessions. Trigger-day trading is excluded because its decision was made before the triggering close. Terminal windows without five later sessions are retained but have null forward values.

Incomplete/failed runs are operational evidence, not completed scores. Include all failures, rejections, turns, tools, tokens, elapsed time, and reported cost. Preserve final holdings and cash so accounting can be reconciled.

## Cohort roadmap

A single June–August 2026 path is a qualification experiment. Before examining candidate model outputs, define additional versioned profiles for:

- rising, falling, high-volatility, and range-bound periods;
- multiple non-overlapping time windows;
- multiple replicate labels per model/runtime;
- future eligible free models only after separately proving their exact catalog/runtime path.

Report distributions and uncertainty across predeclared profiles. Separate model comparisons from adapter/runtime experiments. Never select periods, exclusions, dip thresholds, or replicates after seeing which model wins.
