# Portfolio and journal environment

Current contract: `v11-portfolio-journal-submit`. The four-tool interface and atomic persistence replace v10. A direct inference adapter remains deferred. See [validation and known limitations](VALIDATION.md). Source/evidence for older cohorts remain archived. Never resume them under v11.

## Session contract

Each fresh attempt preloads:

1. Simulated date, previous trading-session close cutoff, and supplied date range.
2. Cash, holdings (units, average cost, observable close and value), holdings value and net worth, after due contributions/actions.
3. Known funding schedule: $500 initially and $500 on the first represented session of each later month.
4. Eligible canonical tickers.
5. The last committed original journal note verbatim, with its identity/date/tags, or an explicit first-day marker.

No failed-attempt note, foreign run, future note, conversation transcript, evaluator outcome or model-generated summary is memory. A note is stated reasons, not private internal reasoning. Original free text remains searchable. Frozen source security names normalize to ticker aliases; ambiguous issuer names can match multiple eligible share classes. Ticker tags remain canonical symbols.

## Four tools

| Tool | Inputs and bounds |
|---|---|
| `market_snapshot` | Optional unique ticker list; otherwise all eligible securities. Previous close and cutoff only. |
| `price_history` | Required unique ticker list (1–8) and integer lookback (1–252). Returns batched OHLCV. No caller-selected end date. |
| `journal` | Optional ticker/company name, exact past date and case-insensitive literal text, combined as filters; integer cursor. Up to four original notes per page and explicit next cursor. |
| `submit_day` | Up to 128 orders, in execution order, plus `{text, tickers, evidence_refs?}`. Each order has canonical ticker, `BUY`/`SELL`, and exactly one positive `notionalUsd` or `units`. Empty orders means hold. |

Journal text must be nonblank and at most 2,000 characters. Ticker tags can be empty for general cash notes. Up to 16 optional evidence references must identify current-session opening context/portfolio or successful read-tool responses. Seven-section memos, nested claims, separate summaries and model-generated request IDs are gone. The prompt asks for reasons, changes, sizing/cash considerations and reconsideration conditions; analytical depth is evaluated offline rather than a prose-schema gate.

The host records every supplied context/read receipt separately from the model's explicit citations. Neither a receipt nor a tag proves attention, causal influence or factual entailment. Provider call identity, host order IDs, actual submissions, fills and cash remain available for analysis.

Turns and attempted tool calls have no count ceiling. Calls are counted. Each attempt has a configurable watchdog, default 300,000 ms, allowed 1–3,600,000 ms. Requests are bounded to 32 KiB, tool responses to 512 KiB, histories to 252 bars, journal reads to 12,000 text characters, and client output to 16 MiB. A run permits up to three failed attempts for a date through explicit resume. These operational bounds can still interrupt a session.

## Observation and execution timing

The previous-close/next-open gap is an **environment constraint**, documented in the study rather than eliminated. Market context and all market replies end at the previous trading session close. The execution-day open remains unknown until the complete decision is submitted and authorized. Orders execute in the supplied order at that open, then the host marks the portfolio at that day's close.

A sell funds only later buys. Long-only fractional shares and existing cent-ledger rounding apply; no leverage, shorts, fees, modeled slippage or target-weight execution. Dollar orders express requested amounts, while realized shares depend on the unknown open. Fixed-share buys may fail the cash check after an upward gap. Other fills in a valid ordered batch follow the deterministic engine's existing rejection policy. Schema-invalid or partial submissions execute nothing.

On a split morning, prior observations and holdings use post-split share units. Evaluator `tradeAnalysis` recomputes each ordered fill/rejection and reports observed close, actual execution open and gap in those same units. `review --gaps=true` derives a full dataset security-day gap calculation with dataset identity and its formula; those observations are not actual model fills or independently verified market-wide estimates. Nothing from these reports is served during the same decision.

Frozen Yahoo snapshots may contain retrospective revisions. They establish reproducible stored inputs, not independently verified contemporaneous market data. Sandboxing also cannot remove historical knowledge learned during model training.

## Atomic persistence and recovery

```text
manifest.json          immutable config, funding, active dependency identity, repository revision
runtime.json           immutable sandbox/runtime identity for model runs
events.jsonl           one append-only, fsynced SHA-256 event chain
days/YYYY-MM-DD.json    one atomically published commit per day
review.md              generated on request
analysis.json          optional derived behavior analysis
dataset-gaps.json      optional derived dataset audit
```

The whole final order batch and journal are validated and fsynced before acknowledgement. Orders and journal receive host identities bound to the actual provider tool call. Identical delivery retries return the stored result; conflicting reuse fails. A successful `submit_day` ends model work without an additional inference response. The official client finishes its current tool/step; the worker then stops it and collects audits. The gateway refuses to forward a continuation after submission.

A durable complete result records successful integrity validation. The runner then deterministically executes and atomically creates the day file without replacement, under a run lock. The commit binds prior commit, submission event, completed result event and accounting record. Only this contiguous committed prefix supplies portfolio/journal memory. There are no separate authoritative accepted records, per-attempt result files, journal text files or automatic summaries.

After a crash following the completed result, resume reconstructs and publishes the same deterministic day without another decision or duplicate deposit/fill. After a crash before the integrity result, even a persisted submission cannot execute: its raw evidence remains, the failed attempt is excluded from memory, and a fresh attempt starts from the last committed state. A partial/truncated event append is refused for quarantine rather than silently discarded. Hashes detect corruption; they are not authenticity against a privileged actor who rewrites all data and every root. Preserve independent copies of evidence roots.

Numeric token metadata may be `null` with usage completeness `unavailable`. Missing usage alone does not erase an otherwise complete authorized submission; such attempts cannot support token/cost-efficiency comparisons. Invalid numeric metadata, inconsistent totals, malformed/unfinished streams, unknown tools, missing client/broker evidence, wrong model/prompt, failed sandbox checks or unauthorized gateway calls still invalidate a day. A terminal prose response without `submit_day` is incomplete.

## Runtime and qualification

Only official OpenCode **1.18.30** and **`opencode/muse-spark-1.3-contributor-free`** through the qualified OpenCode Zen route are allowed. Refreshed catalog evidence must identify the exact active model, zero input/output/cache prices and tool-call support. Runtime prompt/model/pricing/tool audits and independent broker reconciliation remain required. There is no paid or fallback model.

Trusted Bun/OpenCode/worker/filter/launcher files are copied, fingerprinted and prepared once outside the daily watchdog, then mounted read-only across attempts. Every attempt still receives a fresh sandbox, scratch directories, scoped gateway capability and isolation probes. Setup timing is retained separately. Credentials stay on the host; the client receives only the gateway capability. OpenCode API credentials can come from `OPENCODE_API_KEY`, the official auth file, or a plain API-key entry in the previous Pi auth file; no Pi SDK or shell credential evaluation remains.

The existing Bubblewrap/systemd boundary retains separate namespaces, no capabilities, seccomp/no-new-privileges, 2 GiB memory, 128 tasks, restricted descriptors/processes/files/CPU and bounded tmpfs. Only trusted runtime files and the scoped socket are mounted; no repository, host home, dataset, journal, evaluator files or host credential. The gateway permits only the four trading tools and the exact model route; hosted retrieval, external state/files/media, other tools and arbitrary destinations are denied. The authenticated optional MCP GET probe receives a normal POST-only 405; it is recorded as transport negotiation.

## Commands and study profiles

`pnpm bench help` is the one command guide. `run`, `resume`, `inspect`, `verify`, `review`, `qualify`, and `sandbox-check` use the same active core. The old `study:run` and `study:control` scripts are thin aliases. Data import and no-inference model qualification remain separate preparation commands. Use `bun --env-file=/path/to/existing/.env src/index.ts …` when loading a local host credential file.

`resume` exits nonzero when a session fails to commit. `inspect` and `verify` can successfully validate an incomplete committed prefix; their summary still says `incomplete`.

`review` identifies run completeness and every failed/interrupted attempt. `analysis.json` separates committed-day metrics from all-attempt operational history. Journal prose is rendered literally so model text cannot add active links, images or report headings.

`run --preflight=true` validates without inference. `run --control=true` runs the unchanged mechanical v10 order policy. `run --smoke=true` limits a live qualification to at most five sessions. `review --analysis=true --gaps=true` derives behavior, fills and gaps offline; `--comparisons=true` adds cash, equal-weight, risk/return metrics and an optional `--ndx-data-dir` reference. These descriptive calculations do not assert scored-study eligibility. `qualify --data-dir … --ndx-data-dir … --start … --end …` separately enforces complete calendar-quarter coverage, original pre-quarter membership evidence, supported securities/actions without exclusions, and frozen NDX reference data. The core does not claim a supplied ordinary date range qualifies for comparison. Annual launchers and legacy comparative CLI are archived; offline NDX/equal-weight/metric helpers remain outside the core.

The retained 99-security June–August 2026 archive (hash `abc104ae3f2cb258e1c9c9bc996a9f46c14ca83771da5c9acbeb7eaab23b2de7`) supports environment smoke/control. It is not a full calendar quarter. Adding a new adapter/model/data track requires separate qualification and a new cohort.
