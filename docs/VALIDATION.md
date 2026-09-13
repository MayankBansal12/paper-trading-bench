# Benchmark validation

## Session recovery and streaming qualification (PR #6)

The host gateway's default Bun idle timeout could truncate inference streams after a ten-second pause even with a sixty-minute attempt watchdog. A real OpenCode/sandbox fixture with a twelve-second pause reproduced the failure before the fix (four provider requests, no submission, then watchdog cutoff). Setting the gateway server's `idleTimeout: 0` made the same fixture complete in one provider request. The host attempt deadline remains authoritative. Reproduce without remote inference with `bun scripts/qualify-submission.ts --slow-stream-fixture`; the separate `--watchdog-fixture` verifies hard cancellation.

Recovery/history changes are covered by 219 offline tests: exact history bounds; one retry across resume; invalid-day accounting without orders; consecutive-invalid-day stop/reset; and reports aligned by decision date. Corporate-action verification rebuilt all 16,236 bars and 152 events from the registered frozen Yahoo snapshots and exercised all 61 evaluation-period events through opening context and accounting. This verifies reproducibility and accounting, not independent issuer confirmation of every event.

## Stack review for PRs #3 and #4 (2026-09-13)

Reviewed the session/tool and provider boundaries, journal-to-order binding, failure handling, deterministic cash/accounting, atomic recovery, reporting, CI and repository contents. PR #3's reviewed head is `37d77b8`; PR #4's reviewed implementation is `6add2eb` and includes that parent commit.

Corrections made during review:

- Model journal text renders literally, so Markdown links/images, HTML and fence escapes cannot become active report content.
- Provider requests must contain exactly the expected user context and an unambiguous system context; extra user messages or competing message/instruction fields are rejected. Non-object gateway requests are rejected and audited.
- A failed `resume` exits nonzero. Offline inspection can validate an incomplete prefix, with its incompleteness explicitly reported.
- Reviews and analysis show every failed/interrupted attempt separately from committed-day portfolio metrics. Failed provider requests count toward turns even when no SDK completion arrives.
- Local scripted-provider qualification uses a dummy key and needs no real inference credential.

| Final review check | Result |
|---|---|
| PR #3 typecheck and complete suite | 343 passed, 0 failed, 4,554 assertions |
| PR #4 typecheck and complete suite | 206 passed, 0 failed, 1,260 assertions |
| Final 64-session deterministic control | 56 fills, 0 rejects, $1,540.08 ending equity; identical replay and all 64 archived daily ledgers match |
| Actual official client and sandbox, scripted provider | Successful submission uses one request; watchdog case records both requests and one tool, with no orders |
| Archived provider-context compatibility | All 44 previously valid requests still pass; both already-invalid development requests remain rejected |
| Cleanup integrity | 40 redundant retired files matched the retained source archive byte-for-byte; historical evidence unchanged; active document links resolve |

The control uses implementation `6add2eb`, run ID `stack-review-final-control-20260913`, and the unchanged frozen June–August dataset. Reproduce with `pnpm typecheck`, `pnpm test`, the README control/verify commands, and `bun scripts/qualify-submission.ts` (also `--watchdog-fixture`). The latter requires the qualified Linux sandbox and official client, but performs no remote inference.

Obsolete product/planning documents, the one-off agent workflow and the partial copied retired tree were removed. The current contract, this validation record, data/fixture guides, frozen runnable archives and raw qualification evidence remain. Historical evidence below describes its original source; it is not relabeled as a live result for the reviewed implementation.

No new live-model cohort was run during this review. The earlier live smoke still completed only two of three days: successful live contribution-boundary completion remains unqualified, and the configurable watchdog can still end an attempt. These are documented experiment limits, not evidence of a completed live run or model superiority. Neither PR was merged during review.

## Initial v11 qualification

The initially qualified implementation is `9254544`, based on `7f077b6` / parent PR #3. The live smoke is frozen at `c94d997`; it was not resumed after the final failed-attempt accounting fix. Direct-provider phase 5 remains deferred.

[Machine-readable evidence](../results/qualifications/v11-simplification-20260913/evidence.json) and [reproduction instructions / raw archives](../results/qualifications/v11-simplification-20260913/README.md) accompany this PR.

| Check | Result |
|---|---|
| Final typecheck | Passed |
| Current offline suite | **200 passed, 0 failed, 1,227 assertions** |
| Preserved v10 suite, original source/fixtures/build policy | **341 passed, 0 failed, 4,547 assertions** |
| Final deterministic control | **64 days, 56 fills, 0 rejects**, $1,540.08 ending equity; identical replay |
| Archived ledger equivalence | Every daily portfolio, contribution, corporate action, fill and rejection matches all 64 original v10 control days |
| Original v10 daily artifacts | All 64 remain byte-identical |
| Sandbox | Qualified namespaces, seccomp, capabilities, mounts, denied host/egress access, scoped gateway and immutable runtime |
| Exact model route | Refreshed official OpenCode 1.18.30 catalog confirms active `opencode/muse-spark-1.3-contributor-free`, tool support and zero input/output/cache prices |
| Scripted official-client completion | One local provider-fixture request, explicit `submit_day`, literal preload and four effective tools verified; no extra inference turn |
| Scripted watchdog failure | One observed tool retained, no submission or execution, unavailable usage explicit; zero remote inference |

Offline acceptance coverage includes causal future-price/action mutation; contributions/splits/dividends and holdings preloads; ordered sells funding later buys; dollar sizing versus fixed-share cash failures; bounded history/payloads and unlimited calls; original journal ticker/date/text retrieval; forged/foreign/future evidence; exact provider context and denied tools; unavailable token usage; incomplete submissions; duplicate delivery; atomic publication; and crash recovery before/after the completed result and day commit.

The core now emits 66 authoritative files for a 64-day control (manifest, event log, 64 day commits). Four optional review/analysis artifacts are derived separately. No accepted-result, per-attempt-result or journal-text mirrors are authoritative.

## Small live smoke: partial

One three-session cohort used only the qualified free route, starting July 30, 2026, with a new simulated $500 portfolio and an empty journal. No paid or fallback model was used.

- **July 30 committed:** 8 model turns, 9 observed broker calls, four fills, no execution rejects. Missing numeric usage on three steps remains `null` / unavailable; it did not erase the complete authorized submission.
- **July 31 committed:** 4 turns, 4 broker calls, existing holdings and the previous original note preloaded; empty orders held the portfolio. Reported usage was complete.
- **August 3 did not commit:** the 300,000 ms watchdog fired after 27 model turns and 4 observed broker calls without `submit_day`. No fills or contribution were committed for that day. The due $500 contribution was present in that attempt's pretrade context. Its failure, prompt, raw traffic and tool results remain in the archive.

The committed two-day prefix replays identically. Existing-position continuity was exercised live; **a successful live contribution-boundary decision remains unqualified**. Offline contribution/recovery checks pass. This small smoke supports no financial-superiority claim, and incomplete usage cannot support token/cost-efficiency comparisons.

The timeout exposed a reporting defect: interrupted client audits could leave provisional tool counters at zero despite retained broker calls. Final source `9254544` reconciles observed calls on the failure path. Both successful submission and this failure path were checked with the actual official client and sandbox against scripted local provider responses. The live cohort remains bound to its original source snapshot; no additional live cohort was run for that metadata fix.

One Bun idle-request timeout diagnostic is preserved. It did not prevent the two completed days from passing independent provider-context/client/tool reconciliation. The host watchdog remains a real operational constraint.

## Overnight gaps

The evaluator derives gaps as `(execution open / split-consistent observed previous close - 1) × 100`. [Derived dataset summary](../results/qualifications/v11-simplification-20260913/dataset-gap-summary.json): 99 securities × 64 sessions = **6,336 stored-dataset security-days**; absolute median **0.8119%**, p95 **4.7164%**, **19.3340%** exceed 2%, maximum **29.4890%**. These are not actual model fills or independently verified market-wide estimates.

Per-order review separately joins the observed close, actual opening fill, gap, requested dollars/shares, resulting share quantity and any rejection. The previous-close/next-open uncertainty is part of the environment; future execution/valuation outcomes never enter that same decision context.
