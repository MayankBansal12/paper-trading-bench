# Paper portfolio environment

A small, repeatable simulation for studying LLM portfolio decisions, stated reasons, and performance over time. Current protocol: **`v11-portfolio-journal-submit`**. It depends on the v10 environment introduced in PR #3; old runs keep their frozen source and semantics.

Every trading day starts a fresh session with its date and observation cutoff, available cash, holdings and previous-close values, known funding schedule, eligible tickers, and previous committed journal **verbatim**. The model has four tools:

- `market_snapshot(tickers?)`: compact previous closes.
- `price_history(tickers, lookback)`: bounded batched OHLCV through the host cutoff.
- `journal(ticker?, date?, query?, cursor?)`: original committed notes, with combined filters and frozen company-name aliases.
- `submit_day(orders, journal)`: one ordered batch and a short free-text note. Empty orders means hold. No extra inference turn confirms it.

Turns and tool calls are unlimited. A configurable host watchdog, payload/history bounds, fresh sandbox and exact model/tool/prompt checks remain. The model chooses its allocation and trading style. No browsing, financial reports, indicators, summarizing model, embeddings, strategy judge, or target-weight execution is added.

**The overnight gap is an environment constraint.** Decisions observe prices only through the previous trading session close. The day's opening price becomes available to execution only after all decisions finish; closing prices then value the portfolio. Dollar orders specify amounts, with share quantities determined by the unknown open. Fixed-share buys can fail for insufficient cash after a gap. Evaluator reports join each order and actual fill to the split-consistent observed close and opening gap. Outcomes never enter the same day's decision context.

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test

# No inference: validate inputs or run the deterministic accounting control.
pnpm bench run --run-id control-v11 --control=true \
  --data-dir /path/to/frozen/dataset --start 2026-06-01 --end 2026-08-31
pnpm bench verify --dir results/studies/control-v11
pnpm bench review --dir results/studies/control-v11 --analysis=true --gaps=true

# Exact free Muse/OpenCode route only; OPENCODE_API_KEY is host-side.
pnpm model:preflight
pnpm sandbox:check
pnpm bench run --run-id muse-v11-smoke --smoke=true \
  --data-dir /path/to/frozen/dataset --start 2026-07-30 --end 2026-08-03
pnpm bench resume --dir results/studies/muse-v11-smoke
pnpm bench inspect --dir results/studies/muse-v11-smoke
```

Initial cash is $500; the first represented session of each later month receives $500. The core accepts any valid supplied date range. `bench qualify` separately checks calendar-quarter membership/NDX eligibility. Smoke/control results do not qualify as scored comparative studies.

A run has an immutable manifest, one durable checksummed `events.jsonl`, and atomic `days/YYYY-MM-DD.json` commits. The log retains prompts, raw traffic, tool calls/results, submissions and failures. Commits reference the exact submission/result events and contain the execution ledger. Journal views and reports are derived. Changed engine, dependency, runtime, data or protocol identity requires a new cohort; reporting-only source changes do not prevent replay.

See the [current contract and command guide](docs/STUDY_ENVIRONMENT.md), [validation and known limitations](docs/VALIDATION.md), and [historical archive](archive/README.md). Dataset snapshots are ignored local inputs; the retained June–August 2026 archive is suitable for environment qualification, not a full-calendar-quarter membership claim. No live-data fetch is part of a decision.
