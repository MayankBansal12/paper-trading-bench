# Paper portfolio environment

A small, repeatable simulation for studying LLM portfolio decisions, stated reasons, and performance over time. Current protocol: **`v12-portfolio-journal-submit`**. v12 improves deterministic journal retrieval and recent memory; old runs keep their frozen source and semantics.

Every trading day starts a fresh session with its date and observation cutoff, available cash, holdings and previous-close values, known funding schedule, eligible tickers, and the latest three committed journals **verbatim**, newest first. The model has four tools:

- `market_snapshot(tickers?)`: compact previous closes.
- `price_history(tickers, lookback)`: exactly the requested OHLCV bars through the host cutoff, bounded by the advertised session limit (`--history`, default 100). Any eligible ticker batch is allowed if its complete response fits 512 KiB; oversized requests are rejected with guidance to split the batch.
- `journal(ticker?, date?, query?, cursor?)`: original committed notes, newest first, with combined ticker/date/keyword filters and frozen company-name aliases. All query keywords must match text or optional tags; empty searches include a recent date/ticker index.
- `submit_day(orders, journal)`: one ordered batch and a short free-text note with optional search tags. Empty orders means hold. No extra inference turn confirms it.

Turns and tool calls are unlimited. Each attempt has a configurable 60-minute host watchdog and one automatic retry. Two failed attempts mark that trading day invalid and carry existing positions forward without new orders. The run stops only after three consecutive invalid trading days; valid, retried, invalid and unattempted days remain counted. Payload/history bounds, fresh sandbox and exact model/tool/prompt checks remain. The model chooses its allocation and trading style. No browsing, financial reports, indicators, summarizing model, embeddings, strategy judge, or target-weight execution is added.

**The overnight gap is an environment constraint.** Decisions observe prices only through the previous trading session close. The day's opening price becomes available to execution only after all decisions finish; closing prices then value the portfolio. Dollar orders specify amounts, with share quantities determined by the unknown open. Fixed-share buys can fail for insufficient cash after a gap. Evaluator reports join each order and actual fill to the split-consistent observed close and opening gap. Outcomes never enter the same day's decision context.

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test

# No inference: validate inputs or run the deterministic accounting control.
pnpm bench run --run-id control-v12 --control=true \
  --data-dir /path/to/frozen/dataset --start 2026-06-01 --end 2026-08-31
pnpm bench verify --dir results/studies/control-v12
pnpm bench review --dir results/studies/control-v12 --analysis=true --gaps=true

# Exact free Muse/OpenCode route only; OPENCODE_API_KEY is host-side.
pnpm model:preflight
pnpm sandbox:check
pnpm bench run --run-id muse-v12-smoke --smoke=true \
  --data-dir /path/to/frozen/dataset --start 2026-07-30 --end 2026-08-03
pnpm bench resume --dir results/studies/muse-v12-smoke
pnpm bench inspect --dir results/studies/muse-v12-smoke
```

The benchmark evaluation now uses **April 2025–March 2026**, with **four separate quarterly runs executing in parallel for each qualified model**. Use `pnpm study:run --eval-id ID --data-dir DIR` (or `pnpm bench eval`); add `--preflight=true` to validate all quarters without inference. Each run starts with $50,000, no holdings, empty journals, its own runtime and fresh failure counters. See the [evaluation contract and commands](docs/EVALUATION.md) for funding, resume, reporting and data-readiness requirements. The retained January–August dataset lacks pre-April 2025 warmup and is rejected.

Initial cash is $50,000; the first represented session of each later month receives $50,000. The core accepts any valid supplied date range. `bench qualify` separately checks calendar-quarter membership/NDX eligibility. Smoke/control results do not qualify as scored comparative studies.

The prompt asks for an ongoing investment horizon: the end date is an evaluation/reporting boundary, and investments should still be assessed through the final session. Quarter-end alone is no reason to liquidate or avoid new positions. Performance includes cash plus the closing value of unsold holdings; the engine never automatically liquidates them. Holding cash for investment reasons remains allowed. This prompt clarification changes the implementation identity and applies to new cohorts; existing runs retain their original prompts and require their original source for replay.

The v12 journal changes apply to new cohorts only. A query such as `MU trim sell` now matches all three keywords anywhere in a note or its tags. Ticker filters also find symbols mentioned only in prose. Pages fill a 12,000-character note budget, and optional tags are capped at eight lowercase slugs (for example `phase-defensive`). The investment mandate, cash wording and execution timing retain their prior behavior. v12 bundles retrieval, tags and the three-note preload, so a comparison with v11 cannot isolate each memory change's individual behavioral effect. Existing v11 runs require their original source for replay or resume. See the [journal contract](docs/STUDY_ENVIRONMENT.md#journal-retrieval-and-tags-v12) for exact matching and bounds.

A run has an immutable manifest, one durable checksummed `events.jsonl`, and atomic `days/YYYY-MM-DD.json` commits. The log retains prompts, raw traffic, tool calls/results, submissions and failures. Commits reference the exact submission/result events and contain the execution ledger. **Audit logs and original journal memory are implemented.** A separate model-facing `action_log` tool for retrieving actual fills/rejections remains planned; the current four tools do not expose it. Journal views and reports are derived. Changed engine, dependency, runtime, data or protocol identity requires a new cohort; reporting-only source changes do not prevent replay.

See the [current contract and command guide](docs/STUDY_ENVIRONMENT.md), [validation and known limitations](docs/VALIDATION.md), and [historical archive](archive/README.md). Dataset snapshots are ignored local inputs; the retained June–August 2026 archive is suitable for environment qualification, not a full-calendar-quarter membership claim. No live-data fetch is part of a decision.
