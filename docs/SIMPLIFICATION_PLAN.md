# Proposal: a focused portfolio and journal environment

Status: phases 1–4 implemented as `v11-portfolio-journal-submit`; qualification evidence is recorded in [SIMPLIFICATION_VALIDATION.md](SIMPLIFICATION_VALIDATION.md). Phase 5 remains deferred. The findings and proposal below preserve the reviewed v10 baseline.

## Goal and boundary

Give the model the information and actions needed to manage its portfolio, preserve its stated reasons, and let us inspect decisions over time. The daily environment should own context, permitted observations, orders, journal memory and durable state. Dataset preparation, benchmark eligibility and comparative reporting should run separately.

The first pass retains the current qualified Muse/OpenCode route, price information, funding schedule and execution convention. It changes neither the selected model nor the trading strategy the model is encouraged to use. Interface and acceptance-policy changes require a new cohort. Historical runs remain tied to their frozen source snapshots.

## What the repository shows

| Finding | Evidence | Proposed action |
| --- | --- | --- |
| Two user-facing run systems, one retired for live use | [src/index.ts](../src/index.ts), [legacy CLI](../src/cli/run.ts), [study CLI](../scripts/run-study.ts). Root help still advertises v7; the old live adapters throw retirement errors. | Publish one run/resume/inspect/verify entrypoint. Remove retired live flags and dependency paths from the active package after shared engine helpers are extracted. Preserve historical code in verified snapshots. |
| Current documentation disagrees about the active contract | [PRODUCT.md](../PRODUCT.md) and [PLAN.md](../PLAN.md) describe v7 as active, while [README](../README.md) describes v10. | One current environment contract and one command guide; mark old product/roadmap material historical. |
| The daily runner also implements study eligibility and reporting | [runner.ts](../src/study/runner.ts) is 749 lines. It validates calendar-quarter membership/NDX requirements, supports smoke/control/quarter modes, recovers attempts, executes portfolios and builds reports. | Extract dataset qualification and analysis. Core runs any valid supplied date range; a separate study profile decides whether results qualify for comparisons. |
| General coding-client integration creates much of the infrastructure | [config.ts](../src/opencode/config.ts) sets 28 OpenCode environment options and writes a plugin. [worker.ts](../src/study/worker.ts), [gateway.ts](../src/study/gateway.ts), [audit.ts](../src/opencode/audit.ts) bridge and reconcile several event systems. | Keep it isolated behind one adapter in the first pass. A direct inference loop is a separate feasibility project, not an assumed compatible replacement. |
| Trusted runtime setup repeats inside daily attempts | [sandbox.ts](../src/study/sandbox.ts) copies/hashes Bun and OpenCode on each launch; [agent.ts](../src/study/agent.ts) includes qualification/startup in the decision deadline. | Prepare and fingerprint one immutable runtime bundle before the day loop, then reuse read-only mounts. Retain a fresh sandbox/capability and isolation probes per attempt; preserve model/pricing checks. Record setup time separately. |
| Repeated discovery/lookups are avoidable | [Ten tools](../src/study/tools.ts): get_portfolio, get_universe, get_price, get_ohlcv, get_indicators, buy, sell and three journal tools. Portfolio is already preloaded and cannot change during the decision. Indicators already include lastClose. | Preload the eligible ticker list; remove redundant portfolio/universe/price lookup tools. Retain a compact market snapshot and batched price history. |
| Memo formatting is more rigid than the analysis requires | [memo.ts](../src/study/memo.ts): seven required sections, nested claim/reference limits, per-field minimum/maximum lengths and a separate text summary. The v9 development run had four rejected seven-claim submissions. | One short free-text journal note, ticker tags and optional evidence references. Keep nonblank/size/type validation; remove section-by-section prose rules and duplicated summary. |
| Finalization requires several independent steps | [tools.ts](../src/study/tools.ts), [agent.ts](../src/study/agent.ts): queue individual orders, append a matching final memo, then obtain a normal final model response. | One explicit final submission containing the ordered trade batch and journal. A validated submission ends model work; no additional prose turn is needed. |
| Journal search is literal and has two largely shared paths | [tools.ts](../src/study/tools.ts). A read-only check found AAPL in all three v9 memos; Apple matched none. | One journal query supporting ticker, date and text filters with pagination. Normalize names using frozen eligible security metadata; store ticker tags explicitly. No embeddings or summarizing model. |
| Validity is coupled to telemetry completeness | [events.ts](../src/opencode/events.ts) treats missing token totals as an error; [agent.ts](../src/study/agent.ts) prevents commitment on that parser error. | Separate a complete, authorized portfolio decision from usage completeness. Missing usage is null/unknown and excludes cost-efficiency comparisons; it does not alone erase a valid explicit submission. Incomplete submissions, unauthorized tools and invalid orders still fail. |
| The same decisions appear in many artifacts | [runner.ts](../src/study/runner.ts), [journal.ts](../src/study/journal.ts). The three-day v9 r2 run has 32 files; the 64-day v10 control has 389. Accepted records embed attempts that also have standalone results; journals and summaries repeat memo content. | One authoritative daily commit, one streamed event log, a run manifest and generated reports. Preserve failed attempts and crash recovery, but derive memo views and summaries instead of maintaining multiple authoritative copies. |
| Changes to unrelated source invalidate a run | [identity.ts](../src/study/identity.ts) hashes every source file, including retired adapters and reporting code. | Fingerprint the active engine/adapter build and its dependencies. Record the full repository revision for provenance separately. Reporting-only changes should not prevent resuming an unchanged simulation. |
| The active runner is still coupled to legacy helpers | [legacyConfig](../src/study/runner.ts), [shared trace helper](../src/agent/trace.ts), [audit imports](../src/opencode/audit.ts). | Extract the shared hash, accounting, context and trace types into the active core before archiving old adapters/prompts. Moving directories without removing imports is insufficient. |

Size measurements are orientation, not a target or a quality score: `src/study` has 14 TypeScript files / 2,863 lines; `src/opencode` has 6 / 575; `src/agent` has 13 / 973. Some of these modules contain essential protections or shared helpers and cannot simply be deleted.

## Proposed model experience

Every session starts with:

- Simulated session date and observation cutoff.
- Current cash, holdings, prior-close values and known cash-flow schedule.
- Eligible ticker list.
- The previous committed journal entry, verbatim; a clear first-day marker if none exists.
- A short statement of execution timing and the available actions.

No prior conversation transcript, failed-attempt journal or evaluator-only future outcome is included. Do not add an LLM-generated summary between the original journal and the next session.

Four tools:

| Tool | Contract |
| --- | --- |
| `market_snapshot(tickers?)` | Previous close and the same optional technical indicators, for selected tickers or the entire eligible universe. Compact results, labeled by cutoff. |
| `price_history(tickers, lookback)` | Batched OHLCV ending at the host-selected cutoff. No requested end date. |
| `journal(ticker?, date?, query?, cursor?)` | Read own committed history; combine supplied filters. Ticker aliases resolve to canonical symbols. Return full notes with IDs/dates and an explicit next cursor. |
| `submit_day(orders, journal)` | Submit all orders in execution order and a final journal note. An empty order list is a hold. Validate and persist the complete decision before executing it; no extra confirmation response from the model. |

Two separate market tools are intentional: one compact survey and one larger history response are easier to understand and bound than a single tool with many response modes.

`submit_day` preserves today's order sizing and sequencing. It does not introduce target-weight trading, new minimum positions or a preferred strategy. The host derives order IDs and memo links from the actual provider call and persisted attempt, so the model need not invent request IDs. Duplicate delivery must be idempotent; a conflicting second submission is rejected. This requires a durable submission record and recovery tests, not just renaming `journal_append`.

A minimal journal payload is:

```json
{
  "text": "Keep AMZN because the original thesis still holds. The observed evidence changed in these ways ... Keep this cash allocation because ... Reconsider if ...",
  "tickers": ["AMZN"],
  "evidence_refs": ["an-observation-receipt"]
}
```

The example is a shape, not a suggested trading thesis. Require text and ticker tags (an empty list is valid for a general cash note); evidence references are optional and validated when supplied. Keep one overall size bound and ordinary schema validation. The prompt asks for reasons, material changes, sizing/cash considerations and reconsideration conditions; missing analytical depth is visible to the evaluator instead of becoming a formatting failure.

Automatically link all supplied context and observed tool responses to the decision for inspection, but distinguish **available/seen evidence** from **evidence explicitly cited by the model**. Do not manufacture reasoning or claim that a receipt entails its prose. The host separately stores actual orders, fills and cash, so the model does not need to repeat the execution ledger in its note.

One final entry per session removes tentative persisted notes and their extra sealing rules from model memory. Raw intermediate model text and tool calls remain in the evaluator event log. If later experiments need persistent research notes beyond the final decision journal, add them deliberately as another track.

## Core loop and persistence

```text
Frozen dataset + committed portfolio/journal
                   |
            Build daily context
                   |
      Model <-> market and journal reads
                   |
        Validated final submission
                   |
     Execute at the unknown-to-model open
                   |
    Atomic day commit + next-day portfolio
                   |
         Offline behavior review
```

Suggested layout:

```text
run/
  manifest.json        # model, dataset, funding, timing and engine identity
  events.jsonl         # context, requests/results, submissions and failures
  days/YYYY-MM-DD.json # authoritative committed decision, journal, fills and state
  review.md            # generated on request
```

The event log preserves a validated submission before commitment; a restart can finish its deterministic commit without asking for a second decision. Each day file is created atomically under a run lock. Portfolio checkpoints, journal indexes and reports are rebuildable. Preserve hashes/checksums sufficient to detect changed data, conflicting commits and truncated logs. Do not replace durable transactions with unguarded JSON overwrites.

Move NDX/equal-weight comparisons, Sharpe/information ratios, quarter/year qualification and broad performance tables into optional offline commands. Keep the default review focused on what the model saw, what it submitted, its prior/current note, actual execution and cash/position changes. More advanced metrics can be computed later from the same ledger.

## Limits and acceptance

Keep unlimited turns. For the behavior-focused protocol, also propose removing the tool-count quota: it makes research and journal retrieval compete with order submission and adds accounting branches. Continue counting calls for analysis. Retain bounded payload/history sizes, one configurable host wall-clock watchdog and the existing sandbox resource protections. The remaining 300-second timeout is an operational watchdog; this plan does not claim it can never fire.

A complete, authorized submission, causal data and valid deterministic accounting determine whether a day can commit. Usage completeness and provider diagnostics are separate fields. A normal terminal provider response without a submission is not a valid decision; an interrupted partial submission never executes. Unknown usage is never silently converted to zero. Keep exact model/provider and zero-price qualification where the selected model requires it; do not introduce fallback models or paid calls.

With OpenCode retained, keep effective-prompt/tool attestation and broker/client reconciliation. Consolidate duplicate storage and stream audit events as they occur. Instrumentation failure that undermines confidence in what model/tools/context were used remains a validity failure; missing numeric token metadata alone is different.

## Runtime option, separate from the first pass

The largest potential reduction would be replacing the general coding client with a small provider adapter that only sends messages, receives function calls and invokes the four permitted handlers. That could eliminate the MCP bridge, generated plugin, coding-client discovery flags and much of the client-versus-broker reconciliation.

This is not yet established as compatible with the exact free Muse route. The current model/runtime contract expressly uses official OpenCode. First verify supported direct API access, identity/pricing, tool streaming and completion behavior for that same model. A successful prototype would be a separately qualified cohort.

Do not remove Bubblewrap/systemd while continuing to run the coding client. Under a direct API-only architecture, the model would have no local executable or shell tool: tool arguments are validated data handled by trusted code. Its different threat boundary may make a per-day coding-client sandbox unnecessary. That decision follows the adapter change and a boundary review; it is not the first cleanup step.

## Implementation sequence

1. **Clarify and isolate the active core.** One current contract/CLI; extract shared helpers; separate experiment profiles and offline reports. Require the refactored engine to reproduce archived v10 ledger values in offline equivalence tests; do not bypass source-identity checks or resume old runs with changed code. Preserve frozen snapshots before retiring legacy sources/tests.
2. **Introduce the four-tool interface and short journal as a new protocol.** Preload universe/previous note, add ticker tags and batched history, implement explicit final submission. Remove model-generated request IDs, duplicate final prose and the tool quota. Freeze the new contract; do not mix these runs with v10.
3. **Separate telemetry and simplify persistence.** Make usage completeness independent, stream one audit log, publish one atomic daily commit, derive journal/report views. Keep replay, idempotency and denied-tool checks. This is the riskiest step and should follow the smaller interface change.
4. **Qualify, then run a small model cohort.** Offline causal and recovery checks, full-period deterministic control, sandbox check, then a small live smoke crossing an existing-position day and a contribution boundary. Preserve every failure; compare behavior and reliability without claiming financial superiority from a short smoke.
5. **Optional transport experiment.** Evaluate the direct adapter only after the above core is stable and direct access is verified. Do not bundle a provider/client replacement into the initial cleanup.

Acceptance checks: future-price mutation cannot affect context or market replies; next-day/retry cash and holdings are correct; deposits/actions/fills execute once; forged/foreign/future journal references fail; ticker/date retrieval covers original thesis and later changes; a completed submission needs no follow-up model turn; incomplete submissions execute nothing; missing token metadata is explicit; raw traces permit reconstruction; unknown tools cannot run; old artifacts are unchanged.

No automatic journal summarizer, embedding database, strategy judge, extra indicators, target-weight execution, intraday exchange, live-data browsing or new frontend is needed for this first simplification.
