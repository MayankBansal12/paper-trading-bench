# Sandboxed quarterly study environment

Protocol: `v10-unlimited-turns-portfolio-context`. New inference uses `pnpm study:run` or `pnpm study:year`. V10 removes model-turn and aggregate HTTP-request count caps and preloads the observable opening portfolio with a citable receipt. Turn/token usage is still counted. Tool/time and sandbox limits remain. This is a new cohort: prior v8/v9 studies require their frozen source snapshots for replay. Previous runs under `results/runs` were cleared at user request on 2026-09-13; older study, report and qualification evidence remains.

## Trust boundary

The Linux implementation uses Bubblewrap 0.9.0, a seccomp filter, and a transient systemd service. Each daily attempt gets separate mount, PID, network, user, IPC and UTS namespaces. The client has no capabilities, cannot acquire privileges, and has a 2 GiB memory limit, 128-task limit, per-process CPU/file limits and a wall-clock deadline. The whole service is killed at cutoff. There is no automatic unsandboxed fallback.

Only the Bun/OpenCode executables, their read-only runtime libraries, the fixed worker, fixed client plugin/configuration, and one scoped Unix socket are mounted. `/work` and `/tmp` are disposable tmpfs mounts limited to 128 MiB and 64 MiB. The repository, host home, credentials, complete market archive, evaluator output, other attempts and journal storage are absent. The synthetic `/etc/passwd` points to the scratch home. It contains no host account data.

The model has ten permitted tools. Client permissions deny every other tool, and the host gateway checks the actual outbound inference tool list. The OS boundary also constrains the client if its application-level permissions fail. Qualifying a sandbox actually launches it and checks forbidden host reads, read-only mounts, network denial, namespace separation, privilege/seccomp state, scratch writes and the scoped socket.

There is no Internet route inside the namespace. A loopback HTTP bridge connects to the mounted Unix socket. Its host gateway permits only the session MCP endpoint and fixed OpenCode Zen inference paths for the exact qualified free model. Requests require an ephemeral session capability. The real provider credential stays in the host gateway. Alternate models, arbitrary routes, external/server-side tools, remote media inputs and response continuation IDs are rejected. Redirects are disabled; the provider response cannot set client cookies. Both HTTP servers defer to the host's session deadline rather than a shorter default idle timeout.

The trusted host controls the clock, archive, execution, gateway and durable journal. Kernel vulnerabilities, a compromised provider, or a privileged host operator are outside this isolation claim. Hashes detect accidental or partial tampering; they do not establish authenticity against a host actor who replaces the entire archive and every retained root. Preserve independent backups of manifests and journal/commit roots for that threat.

## Session clock and prices

The runner creates immutable `{runId, date, attempt, observationDate, reportCutoff}` scope from the exchange calendar. It never parses authority from model prose, the operating-system date, tool arguments, or a journal note. A retry retains the simulated date and committed portfolio/memory. The clock advances after a successful daily commit.

The execution convention remains: decide before session D opens, observe through the previous exchange close, queue orders, execute at D's open after the session ends, then value at D's close.

Consequently `get_price(ticker)` returns the **latest observable previous-session close**, with its actual `asOf` date and price type. It does not mislabel yesterday's close as today's market price. Providing D's open while also filling at that open would change the information/execution protocol. There is no caller-supplied date.

The broker receives a frozen eligible view. Every ticker must have the correct latest observable bar; future, stale, malformed or unordered bars fail closed. Indicators are recomputed from that same bounded history, ignoring any supplied precomputed values. Snapshot construction uses only splits effective by the session, not future adjustments. A test changes every future price and a future split and confirms that every current financial tool response stays identical.

| Tool | Contract |
|---|---|
| `get_universe()` | Entire eligible universe; no recommended candidates |
| `get_price(ticker)` | Latest observable close; no date argument |
| `get_ohlcv(ticker, lookback?)` | Bounded positive integer history, ending at the session cutoff |
| `get_indicators(ticker?)` | SMA20, SMA50 and RSI14 from that same eligible history; optional full-universe view |
| `get_portfolio()` | Observable pretrade state, including due cash flows/actions |
| `buy` / `sell` | Exactly one positive notional/units sizing field; queue-only receipt |
| `journal_append(text, requestId, decision?, evidenceIds?)` | Immutable current-attempt append; final entry requires structured `decision`; no date/path/run arguments |
| `journal_read(date, cursor?, limit?)` | Own committed past or current-attempt notes; rejects future dates |
| `journal_search(query, cursor?, limit?)` | Literal search across permitted past history, with bounded pagination |

Unknown fields, unknown tickers/tools and malformed numbers are rejected. Tool attempts, including invalid requests reaching the broker, consume budget. Client-side rejections are also reconciled from independent client audits. Order receipts reveal no execution price, fill estimate or current-day portfolio update. Execution rejections happen after the model session closes and cannot act as a price oracle.

Model turns are unlimited, represented by `limits.maxTurns: null` in immutable configuration. There is no `--max-turns` setting in the study CLI, no reserved final-turn allowance and no aggregate HTTP-request count cap. Inference requests and client steps remain counted and reconciled. Defaults are 24 attempted tools, 300 seconds including startup, 100 history bars, eight journal entries with a 2,000-character summary plus up to 5,000 characters of structured decision data, and a 12,000-character per-response journal-read limit (summary and decision data both count). Configurable limits have hard ceilings of 64 tools, 300 seconds and 252 history bars. Request/response/output sizes remain bounded. All models in a comparison must have the same limits. Budget exhaustion notifies the host to terminate the client immediately, preserving the specific cause instead of waiting through client retries. An unsuccessful day stops the run; explicit resume can retry at most three attempts for that date, preserving every failure.

## Fresh daily sessions and opening context

Every simulated day and retry launches a fresh OpenCode conversation in a fresh sandbox. Its opening context is the fixed system prompt, ten tool schemas, and a daily prompt with the session date, latest observable close date, run start/end, scheduled contributions, current opening portfolio, journal entry count and latest committed journal date. The system prompt contains execution rules, permitted information, budget and required memo fields.

The host carries cash/holdings forward and applies due contributions and supported corporate actions before constructing the opening context. The prompt preloads available `cash`, every holding's `units`, `avgCost`, `lastClose` and `value`, plus `holdingsValue` and `netWorth`. Marks end at the previous observable close; execution-day prices and queued fills are absent. The same state remains available through `get_portfolio`. A receipt named `<date>:<attempt>:opening-portfolio` carries the session date, observation cutoff and portfolio hash. It is valid journal evidence without any tool call, and is reconstructed and checked during replay. Retries receive the same committed financial state and a new attempt-scoped receipt.

The full universe, market history and indicators, prior memo text and previous conversation transcript are not preloaded. Market data and committed memos remain available through their tools. The previous committed memo is retrievable with `journal_read`; all older committed notes remain searchable. Failed-attempt notes stay evaluator-only. Each quarter starts with new capital and an empty journal.

A completed decision seals its memo and closes tools before execution. Orders fill sequentially at that day's open; the host marks holdings at that day's close, commits the day, and then advances the simulated clock. A timeout/budget failure executes no orders, does not advance the date, and stops the run for explicit resume.

## Journal and commit semantics

`journal-events.jsonl` is authoritative. Each event carries a scope, sequence, host audit timestamp, prior hash and content hash. Acknowledged appends are fsynced before acknowledgment. Entries carry receipt citations and the hash of the order queue at append time. Repeated request IDs are idempotent only for the identical text, citations and order batch.

After choosing its final orders or hold, the model must append a final decision memo. The last entry must match the accepted order batch and include `decision` with these required fields:

- `thesis`: the stated reason for the overall decision.
- `evidence`: 1–8 concrete claims, each citing 1–2 exact `receiptIds` from successful current-session information tools or the supplied opening-portfolio receipt.
- `allocation`: why these sizes, cash balance and concentration; planned amounts are distinct from actual fills.
- `alternatives`: considered alternatives, including hold, and why they were rejected.
- `risks`: uncertainty, contrary evidence and relevant exposure.
- `invalidation`: observable conditions to reconsider and the next review.
- `continuity`: what changed or remained valid since the prior memo, or an explicit first-session statement.

Each prose field and evidence claim requires at least 10 characters; schema errors identify the invalid field and remaining tool calls. The broker rejects fabricated receipts, order receipts used as information evidence, whitespace-only fields, and memos without any market/portfolio evidence. Receipt IDs are automatically included in the journal index. It validates provenance and structure, not whether each claim follows from the cited data. This is a decision justification, not private chain-of-thought or a reasoning-quality score. One final memo can cover the whole portfolio; intermediate notes are optional. Tool receipts report remaining tool calls.

The last entry must match the accepted order batch. It may add corrections as new entries; it cannot edit an earlier entry, even on the current date. The prompt requests a concise thesis/evidence/risk memo, not private chain-of-thought. No security rule can prove that a self-reported explanation is the model's actual internal cause.

On success, the runner durably publishes the accepted decision, seals the journal, executes the queue and publishes the daily hash-linked commit. The readable `journal/YYYY-MM-DD.txt` is a sealed rendering. The model never mounts either journal representation.

On interruption, acknowledged notes remain in evaluator history. A retry reads only committed past notes and its own new attempt. It cannot see failed-attempt text. A completed result saved before an interrupted commit is recovered without re-querying the model. An accepted decision is executed deterministically to reconstruct a missing daily commit; orders and deposits are not applied twice. Partial journal writes, missing seals and altered commits are quarantined by validation, not silently repaired.

A run lock prevents concurrent mutation. If the entire host runner is killed, a stale `.lock` intentionally blocks restart. After verifying that its recorded process is gone and no run remains active, the operator may remove that lock and resume. The runner then performs journal/accepted-decision recovery; never delete attempt files to retry.

## Durable evidence and replay

Each run under `results/studies/<runId>/` contains:

- `config.json` and `environment.json`: immutable policy, data and implementation/runtime identities;
- `sandbox-qualification-*.json`: actual namespace and denial probes;
- `attempts/<date>-<attempt>/start.json`, `audit.jsonl`, and `result.json` or interruption evidence;
- `accepted/<date>.json`: completed, validated decision, journal and full client trace;
- `journal-events.jsonl`, sealed readable journal files, and `daily/<date>.json`;
- `summary.json`: derived performance, controls, per-attempt failure/budget details, structured decision memos and descriptive behavior measures;
- `journal-review.md`: evaluator-only review linking each pretrade memo to tool evidence, queued orders, actual fills/rejections, contributions and end-of-day portfolio. Execution outcomes are never appended retrospectively to the model's pretrade memo.

Host audit records preserve broker calls/results, inference request identity/hashes and status, client output chunks, stderr and terminal outcomes. The parser checks complete model steps and token/cost accounting. Tool calls are reconciled between client events, plugin audits and the independent broker log. Verification re-executes every broker request against the reconstructed eligible data and journal; simply rehashing a fabricated price receipt does not make it valid.

Resume rejects changed code/dependencies, runtime, policy or source archives. Start a new cohort after a change. Read-only verification reconstructs decisions, journal seals, fills, cash flows and daily portfolios without inference or changing experiment records. Model runtime installation is not required for the offline replay itself; the code and frozen market archives must be available.

## Quarter and year qualification

Four runs use **independent quarter resets**: new $500 portfolio, empty journal and fresh client sessions for each quarter; add $500 before the first exchange session of the second and third months. Results are quarterly distributions, not the realized return of one continuously invested annual account. Only completed calendar years are accepted by the year launcher.

Scored quarters require full calendar-quarter coverage and enough warm-up history, the quarter's own membership evidence published before its start, complete supported securities/actions, and a separately frozen historical **NDX price-index** dataset. No XNDX reference is used. The old 99-security June–August archive is usable for environment smoke/control checks; it does not qualify as a full calendar quarter or a new annual study universe. Its declared HON/EA exclusions must not silently become a selection rule for future quarters.

Market and NDX archives use the existing hash-verified `manifest.json` format. The NDX archive must contain exactly security `NDX`, valid opens/closes for every required session, source snapshots, and no dividend/split events. Missing opens never fall back to previous closes. It remains evaluator-only. The hypothetical NDX account receives the same contributions at the same session opens and uses the same cent-ledger/fractional-unit accounting as the portfolio. Reports distinguish its funded return from raw first-open-to-final-close index return, and report portfolio dividend cash separately.

For each quarter's market manifest, `universeDefinition.effectiveDate` must equal its first exchange session, `frozenThrough` its calendar-quarter end, and `indexSymbol` must be `NDX`. `universeRecord` must be a verified source snapshot. Every membership source needs its `asOf` date and an explicit original `availableAt` timestamp before quarter start; declaring a fiscal/as-of date is insufficient. Scored quarters refuse exclusion lists. Ingestion review must still substantiate these source assertions and resolve unsupported corporate actions; schema validation alone cannot prove a data vendor correct.

Reports and general news are **disabled** in this technical-only protocol. Adding them requires a new versioned track and archived original records with qualified public-availability evidence. For an April–June track, a March-period report first made public in May is unavailable throughout Q2. SEC originals would be the filing source; current Company Facts, search results, restatements and retrospective summaries cannot be passed through as historical evidence. No filing/news ingestion or tool is enabled by this implementation.

The retained Yahoo snapshots support reproducibility and causal filtering, but were fetched retrospectively and can contain revisions. They are not contemporaneous point-in-time market archives. Likewise, sandboxing cannot remove historical knowledge already learned by a model. Prospective studies and independently qualified data remain necessary for stronger contamination claims.

## Commands

Provisioning requires a Linux host with working privileged namespaces, systemd, a compiler/libseccomp, Bun 1.3.14 and official OpenCode 1.18.30. The launcher uses noninteractive `sudo`; its paths and arguments come only from trusted runner code.

```sh
pnpm sandbox:provision
pnpm sandbox:check
pnpm typecheck
pnpm test

# Live, explicitly unscored smoke. Current credential is retrieved on the host.
pnpm study:run -- --smoke=true --run-id=my-v10-smoke \
  --data-dir=datasets/historical/nasdaq100_202606_202608_v2 \
  --start=2026-06-01 --end=2026-06-02

# Offline replay, no model calls.
pnpm study:run -- --verify=results/studies/my-v10-smoke

# Full-period deterministic environment control, no model calls.
pnpm study:control -- --run-id=my-v10-control \
  --data-dir=datasets/historical/nasdaq100_202606_202608_v2 \
  --start=2026-06-01 --end=2026-08-31

# Quarter preflight: archives must first pass the requirements above.
pnpm study:run -- --run-id=my-Q1 --start=2025-01-01 --end=2025-03-31 \
  --data-dir=datasets/study/2025/Q1/market \
  --ndx-data-dir=datasets/study/2025/Q1/ndx --preflight=true

# Year preflight reads Q1..Q4/{market,ndx}; it makes no model calls.
pnpm study:year -- --year=2025 --suite-id=muse-2025-replicate-1 \
  --data-root=datasets/study/2025
# With all four archives qualified, add --execute=true to freeze/run the suite.
```

The year in these archive commands is an example, not a selected or imported study year. Additional models require explicit qualification of their runtime, exact identity, pricing and tool protocol; they cannot silently substitute for Muse. Replicate IDs label independent runs and are not claims of a controllable provider sampling seed.

## Historical v8 qualification on 2026-09-12

[Machine-readable evidence](../results/qualifications/v8-environment-20260912/evidence.json) and a [source snapshot](../results/qualifications/v8-environment-20260912/qualified-source.tar.gz) preserve the qualified implementation. Automated verification: **331 tests passed, zero failed, 4,179 assertions; TypeScript check passed**.

The final [Muse smoke](../results/studies/muse-v8-sandbox-final/summary.json) completed both sessions with two durable journal entries, two journal read/search calls, eight fills, no failed attempts and $0 reported inference cost. Its decisions, tool replies, journal and portfolios independently replayed successfully under the then-current frozen v8 implementation. The [64-session deterministic control](../results/studies/v8-control-64-session-final/summary.json) completed with 64 journal entries, 56 fills, $1,500 contributed principal, zero model calls and identical replay.

An additional, separately identified development smoke completed four sessions across the July–August monthly contribution boundary, with four journal entries, no failed attempts and $0 reported cost. Development startup/transport failures remain preserved as unscored attempts; none executed trades. These smokes qualify environment operation, not financial strategy performance.

At that qualification, all 70 original v7 artifact hashes were unchanged and replay returned 64 days, $1,552.38 ending value and 5.4497% time-weighted return. Those prior `results/runs` artifacts were removed at user request on 2026-09-13; the validation document retains their historical measurements.

## V9 development checks on 2026-09-13

The first journal smoke (`muse-v9-journal-20260730-0803`) preserved two failed attempts and executed no trades: attempt 1 produced a structured memo in 71 seconds but one client step omitted total-token usage; attempt 2 reached the inference-turn cap while trying to diagnose an opaque six-claim schema limit. The corrected implementation allows eight evidence claims, returns field-specific validation messages, rejects placeholder prose fields, and immediately notifies the host of budget exhaustion. At that v9 revision, the daily 12-turn / 24-tool / 300-second budget was unchanged. A new run identity is required because the source changed.

### Corrected v9 smoke

[Decision review](../results/studies/muse-v9-journal-20260730-0803-r2/journal-review.md) · [Summary](../results/studies/muse-v9-journal-20260730-0803-r2/summary.json) · [Qualification evidence](../results/qualifications/v9-journal-20260913-evidence.json)

The corrected implementation passed 335 offline tests (zero failures, 4,206 assertions) and TypeScript checks. All three sessions completed and replayed identically without inference. There are three structured memos, 21 receipt-linked evidence claims, two committed prior-journal reads, eight fills and no order rejections. The $500 August contribution was applied exactly once; final equity was $993.43 on $1,000 principal. This is an unscored environment smoke.

Successful decisions used 6/6/7 turns, 12/13/14 tools and 33.0/23.0/40.8 seconds. The final day also required two preserved failed attempts, stopped at the 12-request cap after 100.5 and 133.6 seconds. The first queued four orders, all discarded; the second queued none. Those attempts contain five/eight client steps without total-token usage. The 300-second wall deadline was not the limiting factor. Increasing wall time would not resolve the observed malformed client usage or request-cap failures. Reported usage remains incomplete for these failed attempts; zero prices were independently qualified.

The journal exposes a coherent recorded sequence: buy four momentum positions, hold while observable trends remain intact, then exit AAPL when its prior-close trend breaks and use new contribution cash for ADP/ROP/WDAY. Sampled numeric claims match their cited data. Interpretations such as a one-day gain validating an entry remain claims to review, not automatic evidence of sound strategy. Both development and final-run failures remain visible.

## V10 change on 2026-09-13

The new cohort removes the gateway inference count cutoff, the aggregate HTTP-request cutoff, the study event-parser turn cutoff, and the accepted-decision turn ceiling. The legacy protocol's capped parser mode remains available for its archived behavior; v10 always passes `null`. Token/cost validation, tool accounting, sandbox isolation, final journal validation and the session deadline still apply. Removing the turn cap does not repair malformed provider/client usage events or guarantee completion before the wall-clock deadline.

Opening portfolio data is passed directly from the same frozen view used by financial tools. Its receipt can support a journal entry on its own; models do not need to spend a tool call fetching already supplied cash/holdings. Accepted model decisions validate the entire daily prompt and opening receipt against the reconstructed portfolio, horizon and eligible journal metadata. Old v9 artifacts are preserved as their own cohort.

V10 offline validation: **341 tests passed, zero failed, 4,547 assertions; TypeScript check passed**. Tests cross the old turn and aggregate-request ceilings with 300 synthetic requests/steps, check direct opening-receipt citations, reject changed opening prompts, and preserve future-data and deadline boundaries. The [64-session deterministic control](../results/studies/v10-control-64-session-20260913/summary.json) completed with 64 journal entries, 56 fills, zero order rejections and identical replay. No new model inference was used. [Evidence and frozen source](../results/qualifications/v10-unlimited-turns-20260913/evidence.json).
