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

# Refresh catalog evidence for all four qualified routes; no inference.
pnpm model:preflight
pnpm sandbox:check
pnpm bench run --run-id muse-v12-smoke --smoke=true \
  --data-dir /path/to/frozen/dataset --start 2026-07-30 --end 2026-08-03
pnpm bench resume --dir results/studies/muse-v12-smoke
pnpm bench inspect --dir results/studies/muse-v12-smoke
```

Qualified model routes are `opencode/muse-spark-1.3-contributor-free` and `opencode/muse-spark-1.2-contributor-free` through OpenCode Zen, `openai/gpt-5.6-luna` through OpenCode's OpenAI provider with host Codex OAuth, and **catalog-priced** `opencode-go/glm-5.3-flash` through OpenCode Go. All use official OpenCode **1.18.30** and its default reasoning settings. Fresh catalog evidence must prove each exact active route's tool support and pinned input/output/cache prices; the first three pin zero cost. `eval` defaults to all four routes (16 model/quarter jobs); `--models` selects a qualified subset. Add `--concurrency=1` for serial execution on a laptop; otherwise all selected jobs run concurrently. Single runs and the existing `--smoke=true` path accept `--model MODEL_ID`, defaulting to Muse 1.3. Provider credentials remain on the host; the sandbox receives only a scoped gateway capability. See [qualification and authentication](docs/EVALUATION.md#model-route-qualification) for evidence commands and OAuth setup.

The benchmark evaluation uses **April 2025–March 2026**, with **four independent quarterly runs for each qualified model**. Use `pnpm study:run --eval-id ID --data-dir DIR` (or `pnpm bench eval`); add `--preflight=true` to validate all quarters without inference. Each run starts with $50,000, no holdings, empty journals, its own runtime and fresh failure counters. `--concurrency` bounds active model/quarter runs without changing their state isolation, and is frozen for resume/verification. See the [evaluation contract](docs/EVALUATION.md) and [machine setup and execution runbook](docs/EVAL_RUNBOOK.md). The frozen `nasdaq100_2025q2-2026q1_v1` dataset includes the required warmup; transfer it separately because datasets are gitignored.

Initial cash is $50,000; the first represented session of each later month receives $50,000. The core accepts any valid supplied date range. `bench qualify` separately checks calendar-quarter membership/NDX eligibility. Smoke/control results do not qualify as scored comparative studies.

The model is never told the run's start or end date. Earlier cohorts cited the approaching quarter end in their notes even when told to ignore it, so the prompt now describes an ongoing account, and the session context lists only deposits already received; future deposits, which would reveal the quarter's length, stay host-side. The funding rule (first trading session of each following month) is still stated. The date range remains an evaluation/reporting boundary. Performance includes cash plus the closing value of unsold holdings; the engine never automatically liquidates them. Holding cash for investment reasons remains allowed. This prompt change alters the implementation identity and applies to new cohorts; existing runs retain their original prompts and require their original source for replay.

The v12 journal changes apply to new cohorts only. A query such as `MU trim sell` now matches all three keywords anywhere in a note or its tags. Ticker filters also find symbols mentioned only in prose. Pages fill a 12,000-character note budget, and optional tags are capped at eight lowercase slugs (for example `phase-defensive`). The investment mandate, cash wording and execution timing retain their prior behavior. v12 bundles retrieval, tags and the three-note preload, so a comparison with v11 cannot isolate each memory change's individual behavioral effect. Existing v11 runs require their original source for replay or resume. See the [journal contract](docs/STUDY_ENVIRONMENT.md#journal-retrieval-and-tags-v12) for exact matching and bounds.

A run has an immutable manifest, one durable checksummed `events.jsonl`, and atomic `days/YYYY-MM-DD.json` commits. The log retains prompts, raw traffic, tool calls/results, submissions and failures. Commits reference the exact submission/result events and contain the execution ledger. **Audit logs and original journal memory are implemented.** A separate model-facing `action_log` tool for retrieving actual fills/rejections remains planned; the current four tools do not expose it. Journal views and reports are derived. Changed engine, dependency, runtime, data or protocol identity requires a new cohort; reporting-only source changes do not prevent replay.

See the [current contract and command guide](docs/STUDY_ENVIRONMENT.md), [validation and known limitations](docs/VALIDATION.md), and [historical archive](archive/README.md). Dataset snapshots are ignored local inputs; the retained June–August 2026 archive is suitable for environment qualification, not a full-calendar-quarter membership claim. No live-data fetch is part of a decision.

The [read-only viewer](docs/VIEWER.md) groups runs by model cohort, shows year/quarter stats, and drills into individual sessions and agent tool traces: `bun scripts/visualizer.ts --port 4173`.

The [September 15 Luna validation](results/published/luna-main-20260915/README.md) preserves historical replay evidence, current live-smoke outcomes, and audit-bundle checksums. Agent changes and run evidence must go through PRs; see [AGENTS.md](AGENTS.md).

Pi's GPT-6 Astra route is available explicitly as `--models pi/openai-codex/gpt-6-astra`.
It uses the pinned Pi CLI, host Codex OAuth and medium reasoning; see the
[Pi/Astra adapter and execution guide](docs/PI_ASTRA.md). It is not included in the
four-model OpenCode default selection.
