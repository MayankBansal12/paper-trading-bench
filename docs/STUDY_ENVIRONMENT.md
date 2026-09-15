# Portfolio and journal environment

Current contract: `v12-portfolio-journal-submit`. v12 adds deterministic keyword retrieval, optional tags and a three-note preload to the four-tool interface. A direct inference adapter remains deferred. See [validation and known limitations](VALIDATION.md). Source/evidence for older cohorts remain archived. Never resume them under v12.

## Record availability

| Record or capability | Current status |
|---|---|
| Host audit log | Implemented: `events.jsonl` retains context, provider traffic, tool requests/results, submissions and failures. |
| Original model journal | Implemented: one note per valid committed decision, latest three notes preloaded, older own notes searchable with `journal`. |
| Actual fills, rejections and portfolio accounting | Implemented in atomic day commits and evaluator reports. Opening context supplies the resulting portfolio. |
| Model-facing `action_log` tool and detailed adjustment receipts | Planned: the model cannot currently query its execution ledger or retrieve a structured fill/rejection receipt. |
| Annual orchestration | Implemented: four independent quarters per model; four qualified routes schedule 16 jobs. `--concurrency` bounds active runs; the default starts all selected jobs. |
| Qualified model routes | Muse Spark 1.3 Free and 1.2 Free via OpenCode Zen; GPT-5.6 Luna via the OpenAI provider with host Codex OAuth; catalog-priced GLM 5.3 Flash via OpenCode Go. Fresh catalog and runtime audits required. |

## Session contract

Each fresh attempt preloads:

1. Simulated date and previous trading-session close cutoff. The run's start and end dates are not shown.
2. Cash, holdings (units, average cost, observable close and value), holdings value and net worth, after due contributions/actions.
3. Deposits already received (`depositsReceived`), including today's. The system prompt states the rule: $50,000 initially and $50,000 on the first trading session of each following month. Future deposit dates are not listed.
4. Eligible canonical tickers.
5. The latest three committed original journal notes verbatim, newest first, with their identities, dates, tickers and optional tags, or an explicit first-day marker.

The investment mandate describes an ongoing account. The supplied date range bounds evaluation and reporting but is withheld from the model: neither the prompt nor the session context mentions a start date, end date or horizon. Earlier cohorts cited the approaching quarter end in their notes even when told to disregard it. In the final month the model may expect another deposit that the evaluation never reaches; this is an accepted consequence of withholding the end date. Cash remains a valid allocation for investment reasons. Performance uses cash plus holdings marked at the daily close, including on the final date; there is no forced liquidation or cash-only terminal valuation. This clarification changes the implementation identity and requires a new cohort. Earlier runs must be inspected/replayed with their original source and prompt; no existing evidence is rewritten. The prompt does not promise additional simulated dates beyond the supplied range.

Eligible tickers are supplied on every session as the complete allowed universe, with no ranking or recommended subset. This defines the available action space; it is not a stock recommendation. `market_snapshot` defaults to that same universe and orders outside it are rejected. Scored quarterly studies separately require membership evidence predating the quarter. A retrospectively filtered supported-data run remains an environment study.

No failed-attempt note, foreign run, future note, conversation transcript, evaluator outcome or model-generated summary is memory. A note is stated reasons, not private internal reasoning. Original free text remains searchable. Frozen source security names normalize to ticker aliases; ambiguous issuer names can match multiple eligible share classes. The tickers field retains canonical symbols; optional search tags are separate.

## Four tools

| Tool | Inputs and bounds |
|---|---|
| `market_snapshot` | Optional unique ticker list; otherwise all eligible securities. Previous close and cutoff only. |
| `price_history` | Required unique eligible ticker list (up to the loaded universe size) and integer lookback up to the advertised session limit (at most 252). Returns exactly that many OHLCV bars per ticker or rejects the request. No caller-selected end date. |
| `journal` | Optional ticker/company name, exact past date and whitespace-separated query keywords, combined as filters; integer cursor. All keywords must match text or tags, case-insensitively. Full notes newest first, a 12,000-character note budget per page, and explicit next cursor; zero matches include a bounded recent index. |
| `submit_day` | Up to 128 orders, in execution order, plus `{text, tickers, tags?, evidence_refs?}`. Each order has canonical ticker, `BUY`/`SELL`, and exactly one positive `notionalUsd` or `units`. Empty orders means hold. |

`--history` sets both the required warmup and the session history ceiling (default 100; allowed 60–252). The opening context's `priceHistory.maxLookback`, `maxTickers` and `maxResponseBytes`, together with the live tool schema, expose the available limits. There is no fixed eight-stock batch cap: large batches are accepted when their complete response fits 512 KiB. Oversized replies are rejected with instructions to request fewer tickers or bars; they are never truncated. A request for 120 bars in a 100-bar run is rejected with a validation error; it never silently returns 100. Start a new run with `--history=120` or higher to permit that lookback, provided the dataset has enough warmup. This history-contract fix changes the implementation identity; earlier cohorts still require their original source for replay/resume.

Journal text must be nonblank and at most 2,000 characters. The tickers array can be empty for general cash notes. Up to 16 optional evidence references must identify current-session opening context/portfolio or successful read-tool responses. Seven-section memos, nested claims, separate summaries and model-generated request IDs are gone. The prompt asks for reasons, changes, sizing/cash considerations and reconsideration conditions; analytical depth is evaluated offline rather than a prose-schema gate.

The host records every supplied context/read receipt separately from the model's explicit citations. Neither a receipt nor a tag proves attention, causal influence or factual entailment. Provider call identity, host order IDs, actual submissions, fills and cash remain available for analysis.

Turns and attempted tool calls have no count ceiling. Calls are counted. Each attempt has a configurable watchdog, default 3,600,000 ms (60 minutes), allowed 1–3,600,000 ms. Requests are bounded to 32 KiB, tool responses to 512 KiB, histories to 252 bars, journal reads to 12,000 text characters, and client output to 16 MiB. A date permits two attempts total (one original attempt plus one automatic retry), each with its own watchdog. If both fail, that trading day is committed as `invalid` with no orders: due deposits, dividends and splits still apply, and holdings are valued at the close. The run continues with its last valid journal and updated portfolio. A valid decision resets the consecutive-invalid-day count. Three consecutive invalid trading days stop the quarter/run with status `invalid`; later dates are not simulated. Weekends and exchange holidays are not trading days. The summary distinguishes accounted day commits from valid decisions and retains attempted, retried, invalid and unattempted counts plus each invalid date and reason. Resume never grants a third attempt. At the default, two full attempts can take up to two hours for one trading day. The host attempt deadline also bounds forwarded requests; the bridge has no separate five-minute cutoff. Both HTTP bridge and host gateway disable Bun’s default idle timeout so a pause in a valid stream cannot silently cut it short. The sandbox CPU allowance follows the remaining attempt budget. Other operational bounds can still interrupt a session.

## Journal retrieval and tags (v12)

The tool accepts multiple keywords in the existing query string; no extra keyword-array field is needed. For example:

```json
{"ticker": "MU", "query": "trim sell"}
```

Query matching trims outer whitespace, splits on whitespace and requires every keyword to occur as a substring in either the original text or an optional tag. Keywords can occur in any order, far apart, or across text and tags. Matching is case-insensitive; there is no stemming, synonym expansion, phrase syntax, fuzzy matching or semantic retrieval. A whitespace-only query is rejected with guidance to omit it when browsing.

Ticker/company-name filters resolve eligible symbols using the frozen aliases, then match either the declared tickers array or complete ticker tokens in the note's prose. Matching is case-insensitive and preserves internal dots/hyphens: `$MU` and `BRK.B` match their symbols; `momentum` does not match `MU`, and `BRK.B` does not match `BRK`. Company aliases resolve the filter; they do not add inferred ticker tags to stored notes.

Results are newest first. Pass the returned `nextCursor` with the same filters to continue; it is an offset in that filtered ordering. Pages contain complete original entries whose text totals at most 12,000 characters. An additional serialized-metadata budget can end a page earlier to keep the complete tool response below 512 KiB. Notes are never truncated, and there is no four-entry ceiling.

When no entries match, the reply retains `entries: []` and `nextCursor: null` and includes `availableIndex: {entries, totalEntries, truncated}` plus retry guidance. This index ignores the unsuccessful filters and lists at most 20 recent committed dates with their declared/prose-mentioned tickers and optional tags, bounded to 12,000 serialized characters. It includes no journal text, failed-attempt notes or future data. Use an indexed date, fewer keywords, or omit filters and paginate to browse older notes. A cursor beyond the matching results returns an empty page, `matchingEntries` and a hint to restart at cursor 0; it does not imply that the original filters had no matches. The first session explicitly reports that no committed notes exist.

The optional submission field `tags` accepts up to eight unique lowercase slugs, each 1–48 characters, with letters/digits separated by single hyphens. Examples: `phase-defensive`, `rule-tsla-428`. Tags are stored unchanged beside the note, searched alongside prose, included in preloads/read receipts, and shown in derived Markdown reviews and JSON analysis. Omitting tags or supplying an empty list is valid. Invalid tags reject the whole submission before persistence; notes retain free prose without a required Markdown template. Reports render original text and tags literally.

The opening context exposes `recentJournals` (up to three original entries, newest first) and `committedJournalEntries`. Invalid days contribute no entry; the preload uses the latest valid committed decisions. Tags and all preloaded metadata are covered by the context receipt hash.

These changes use a new protocol, policy/schema and implementation identity. They cannot be applied when resuming v11 runs; use the original source for those cohorts. The investment mandate and cash wording remain as before. Retrieval, tags and the preload are bundled in v12, so behavioral comparisons with v11 measure that bundle; they cannot attribute a change in cash allocation to any one component. No new cash-allocation instruction, conditional order type or journal-edit operation is introduced.

## Observation and execution timing

The previous-close/next-open gap is an **environment constraint**, documented in the study rather than eliminated. Market context and all market replies end at the previous trading session close. The execution-day open remains unknown until the complete decision is submitted and authorized. Orders execute in the supplied order at that open, then the host marks the portfolio at that day's close.

A sell funds only later buys. Long-only fractional shares and existing cent-ledger rounding apply; no leverage, shorts, fees, modeled slippage or target-weight execution. Dollar orders express requested amounts, while realized shares depend on the unknown open. Fixed-share buys may fail the cash check after an upward gap. Other fills in a valid ordered batch follow the deterministic engine's existing rejection policy. Schema-invalid or partial submissions execute nothing.

Share quantities support six decimal places. For example, a $100 order at a $1,000 opening price buys approximately 0.1 shares under the cent-ledger sizing rules. The $50,000 starting balance therefore does not exclude high-priced eligible stocks. A whole-share-only experiment would require explicit order/sizing rules and a new funding policy/cohort; increasing cash alone would not disable fractional orders.

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

A durable complete result records successful integrity validation. The runner then deterministically executes and atomically creates the day file without replacement, under a run lock. A valid-day commit binds the prior commit, submission event, completed result event and accounting record. An invalid-day commit binds both exhausted failure events and a zero-order accounting record, has no accepted submission, and creates no model journal entry. This contiguous prefix supplies portfolio state across both valid and invalid days; only valid committed decisions supply journal memory. There are no separate authoritative accepted records, per-attempt result files, journal text files or automatic summaries.

After a crash following the completed result, resume reconstructs and publishes the same deterministic day without another decision or duplicate deposit/fill. After a crash before the integrity result, even a persisted submission cannot execute: its raw evidence remains, the failed attempt is excluded from memory, and a fresh attempt starts from the last committed state if a retry remains. After the final failed attempt, resume reconstructs the invalid-day ledger without a third attempt, duplicate funding or failed orders executing. A partial/truncated event append is refused for quarantine rather than silently discarded. Hashes detect corruption; they are not authenticity against a privileged actor who rewrites all data and every root. Preserve independent copies of evidence roots.

Numeric token metadata may be `null` with usage completeness `unavailable`. Missing usage alone does not erase an otherwise complete authorized submission; such attempts cannot support token/cost-efficiency comparisons. Invalid numeric metadata, inconsistent totals, malformed/unfinished streams, unknown tools, missing client/broker evidence, wrong model/prompt, failed sandbox checks or unauthorized gateway calls still invalidate a day. A terminal prose response without `submit_day` is incomplete.

## Runtime and qualification

Official OpenCode **1.18.30** supports four qualified routes: **`opencode/muse-spark-1.3-contributor-free`**, **`opencode/muse-spark-1.2-contributor-free`** through OpenCode Zen, **`openai/gpt-5.6-luna`** through OpenAI with host Codex OAuth, and **`opencode-go/glm-5.3-flash`** through OpenCode Go. Every route uses default reasoning settings. Refreshed catalog evidence must identify the exact active model, pinned input/output/cache prices and tool-call support. The first three routes pin zero prices; GLM pins published nonzero prices. Runtime prompt/model/pricing/tool audits and independent broker reconciliation remain required. There is no fallback model. See [route qualification and host authentication](EVALUATION.md#model-route-qualification) for per-route commands and durable catalog evidence.

Trusted Bun/OpenCode/worker/filter/launcher files are copied, fingerprinted and prepared once outside the daily watchdog, then mounted read-only across attempts. Every attempt still receives a fresh sandbox, scratch directories, scoped gateway capability and isolation probes. Setup timing is retained separately. Credentials stay on the host; the client receives only the gateway capability. OpenCode API credentials can come from `OPENCODE_API_KEY`, the official auth file, or a plain API-key entry in the previous Pi auth file; no Pi SDK or shell credential evaluation remains. OpenAI OAuth access/refresh tokens stay in the host broker, which refreshes and persists them with restricted permissions. The isolated home receives only a synthetic OAuth record and provider env value containing its gateway capability; no host credential store is mounted.

The existing Bubblewrap/systemd boundary retains separate namespaces, no capabilities, seccomp/no-new-privileges, 2 GiB memory, 128 tasks, restricted descriptors/processes/files/CPU and bounded tmpfs. Only trusted runtime files and the scoped socket are mounted; no repository, host home, dataset, journal, evaluator files or host credential. The gateway permits only the four trading tools and the exact model route; hosted retrieval, external state/files/media, other tools and arbitrary destinations are denied. The authenticated optional MCP GET probe receives a normal POST-only 405; it is recorded as transport negotiation.

## Commands and study profiles

`pnpm bench help` is the one command guide. `eval`, `run`, `resume`, `inspect`, `verify`, `review`, `qualify`, and `sandbox-check` use the same active core. `study:run` now launches four separate quarterly runs concurrently for each model via `eval`; `study:control` remains a single-window control alias. Data import and no-inference model qualification remain separate preparation commands. Use `bun --env-file=/path/to/existing/.env src/index.ts …` when loading a local host credential file.

`run` and `resume` exit nonzero when the run remains incomplete or stops after three consecutive invalid days. A full date range can finish with status `completed` and explicit nonzero `invalidDays`; `validDays` counts actual accepted model decisions, while `committedDays` also includes invalid-day accounting. `inspect` and `verify` can successfully validate an incomplete committed prefix; their summary still says `incomplete`.

`review` identifies run completeness and every failed/interrupted attempt. `analysis.json` separates valid-decision activity from all-attempt operational history. Portfolio metrics and comparisons include market movement and cash flows on every accounted day, including invalid days. Invalid days do not count as deliberate model holds. Journal prose is rendered literally so model text cannot add active links, images or report headings.

Attempt diagnostics add descriptive failure categories (`timeout`, `runtime-limit`, `interrupted`, `provider-http-error`, `provider-error`, `no-submission`, `harness-error`, or `unclassified`) alongside the original outcome/reason. They separately retain tool-validation error counts, provider HTTP error statuses and gateway-denial counts. A successful attempt has no failure category even if it corrected tool arguments or recovered from a provider error. These are evaluator-only evidence labels, not proven root causes or a new retry policy. The v12 two-attempt/three-consecutive-invalid-day rules above still govern accounting. Quota pauses that preserve attempt allowance would require an explicitly versioned policy change before launching a new cohort.

`run --preflight=true` validates without inference. `run --control=true` runs the unchanged mechanical v10 order policy. `run --smoke=true` limits a live qualification to at most five sessions; `--model MODEL_ID` selects any qualified route and defaults to Muse 1.3. `review --analysis=true --gaps=true` derives behavior, fills and gaps offline; `--comparisons=true` adds cash, equal-weight, risk/return metrics and an optional `--ndx-data-dir` reference. These descriptive calculations do not assert scored-study eligibility. `qualify --data-dir … --ndx-data-dir … --start … --end …` separately enforces complete calendar-quarter coverage, original pre-quarter membership evidence, supported securities/actions without exclusions, and frozen NDX reference data. The core does not claim a supplied ordinary date range qualifies for comparison. The legacy comparative CLI is archived; the current `eval` launcher and its [April 2025–March 2026 contract](EVALUATION.md) run four independent quarters per model. Offline NDX/equal-weight/metric helpers remain outside the core.

The retained 99-security June–August 2026 archive (hash `abc104ae3f2cb258e1c9c9bc996a9f46c14ca83771da5c9acbeb7eaab23b2de7`) supports environment smoke/control. It is not a full calendar quarter. Adding a new adapter/model/data track requires separate qualification and a new cohort.

## Remaining planned work

The former standalone action-log/quarterly plan is consolidated here. These additions have not been implemented:

- Add read-only `action_log(date?, ticker?, cursor?)`, derived from committed day files and their referenced submissions. Default to the previous committed day; return at most 32 typed entries per page with stable order and an explicit next cursor. Each order receipt should include its host identity, requested dollars/shares, actual units/price/cash movement and filled/rejected status with the exact reason. Preserve repeated orders and execution order. Distinguish explicit holds, invalid days, deposits, dividends and splits.
- Preload a bounded previous-day execution summary and a pointer to that tool. Separately expose today's already-effective deposit/dividend/split adjustments from the same portfolio preparation used by opening context, including pre/post-split shares and the ex-date dividend convention. Expose no current-day fills, prices or future actions.
- Restrict ledger retrieval to this run's committed dates before the decision date. Exclude future, foreign and uncommitted submissions and failed-attempt notes. Keep original journals unchanged and the existing ledger authoritative. Update tool allowlists, gateway/client audits, replay verification and implementation identity together.
- Validate gap-induced rejection, ordered sells funding buys, mixed/repeated orders, hold/invalid days, corporate actions, same-morning adjustments, pagination, isolation and exact-once recovery before qualifying that tool.
- Qualify historical membership/reference evidence and complete supported-security coverage for scored comparisons. Concurrent independent quarterly runs, fresh account initialization, frozen data/config identities and annual aggregation are implemented in `eval`; see [the evaluation contract](EVALUATION.md).

Annual reporting retains per-quarter completion/retry/invalid-day coverage, deposit-adjusted returns, drawdown, turnover, fills, rejections and closing portfolios. Four fully funded independent quarters receive $600,000 total; their independent dollar balances cannot be concatenated into a continuous portfolio growth curve. Routes beyond the four-route registry, including Claude Code, need a separately qualified adapter. See the [execution runbook](EVAL_RUNBOOK.md) for source pinning, bounded scheduling, verification and results publication.
