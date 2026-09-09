# Paper Trading Bench

Run a model through three months of historical trading days in one invocation. It starts with **$500**, receives **$500 on the first trading day of each subsequent month**, and decides to buy, sell, or hold each day. A completed benchmark contributes **$1,500** in total and reports final cash, holdings, profit, and returns adjusted for those deposits.

The model receives historical price/volume data, technical indicators, its portfolio, and recent decisions. It has no news, browsing, filesystem, or shell tools. Decisions use data through the previous trading day's close; queued orders execute at the next open after the decision finishes.

## Setup

Install Bun 1.3.14 or newer and pnpm, then:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
```

For free Zen qualification, install version **1.18.29** of the official [OpenCode client](https://opencode.ai/docs/cli/) and configure an OpenCode Zen credential through its supported authentication flow or `OPENCODE_API_KEY`. The default adapter uses that actual client: Zen currently rejects direct third-party API calls to its free models. It never substitutes a paid model. Both the main and auxiliary client models use the selected free model.

## Run a historical benchmark

The default period is the last three **completed UTC calendar months**. As of September 2026, that is June through August. Import the frozen dataset before running:

```sh
pnpm data:import -- --start=2026-06-01 --end=2026-08-31 --out=datasets/historical/202606_202608
pnpm run run -- --start=2026-06-01 --end=2026-08-31 --data-dir=datasets/historical/202606_202608 --model=mimo-v2.5-free
pnpm report
```

Importing uses the network; replay uses the frozen local market snapshot. The model provider still needs a network connection. The importer preserves source responses, hashes, corporate actions, exchange calendar, and adjustment conventions. Rebuild a snapshot offline with:

```sh
pnpm data:import -- --from-snapshot=datasets/historical/202606_202608 --out=datasets/rebuilt
```

The supported default universe is versioned separately from the original 50-stock universe. Honeywell is excluded because its 2025/2026 spin-offs cannot be represented faithfully by the split/dividend accounting implemented here. Unsupported corporate actions cause a data-validation error. See [PRODUCT.md](PRODUCT.md) for the selection and accounting limitations.

## Smoke tests and other adapters

Short or synthetic runs must be explicitly marked as smoke tests:

```sh
pnpm run run -- --agent=fake --smoke --start=2024-01-02 --end=2024-01-05 --data-dir=fixtures/ohlcv --warmup-bars=0
```

`--agent=opencode` is the default. `--agent=pi` uses the isolated Pi SDK adapter for supported provider APIs; free Zen models may reject that direct API path. `--provider` and `--model` identify the model explicitly, with no fallback. `--free-only=false --agent=pi` is required to permit a paid model; the official-client adapter currently supports only its qualified free allowlist. `--seed` labels a replicate; it does **not** guarantee provider sampling determinism.

Each daily decision has limits on model turns, attempted tool calls, and elapsed time. Invalid calls count. A timeout, provider failure, or incomplete decision executes no orders and stops the run with status `failed`. Re-run the same command to retry that date; already committed days and deposits are not repeated.

## Results and integrity

Runs are isolated under `results/runs/`. Each records its configuration, dataset identity, daily decisions and traces, transactions, failed attempts, state, and derived summary. The summary includes final cash and every holding, contributed principal, dollar profit, time-weighted return, drawdown, volatility, turnover, model usage, and matching cash and equal-weight buy-and-hold baselines.

Reports validate authoritative artifacts and replay the ledger before comparing results. They rebuild derived summaries, reject corrupt or legacy runs, and keep incompatible data, budgets, adapters, and experiment settings in separate cohorts. Explicit `--dirs` fails if any selected run is invalid. An incomplete run is not a completed three-month benchmark.

```sh
pnpm report -- --dirs=results/runs/<model>/<seed>/<run-id>
```

Historical replay can test decisions under the stated simulation rules; it cannot establish real-world trading performance. Fees, slippage, taxes, spin-offs, and delistings are not modeled. Historical data may contain retrospective corrections, the fixed universe has selection bias, and model training may contain knowledge of historical events. See [PRODUCT.md](PRODUCT.md) for the exact experiment contract, [validation evidence](docs/VALIDATION.md), and [PLAN.md](PLAN.md) for remaining work.
