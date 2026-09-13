# v9 run integrity and environment audit

Audited 2026-09-13 UTC. **No observed sandbox escape, exposed host API key, future-price response, unauthorized executed tool, or contamination of committed state was found in these two runs.** This is an audit of retained evidence and current controls, with the coverage limitations below. No new model inference was used, and all 45 original run files remain byte-for-byte unchanged during the audit.

## Scope and outcomes

Both runs use Muse Spark 1.3 Contributor Free through the scoped OpenCode gateway. These are three-session smoke experiments, not a qualified quarter/year comparison. Older v8 studies were not included.

| Run | Date / attempt | Outcome | Broker calls | Queued orders | Executed fills |
| --- | --- | --- | ---: | ---: | ---: |
| Development v9 | July 30 / 1 | Usage validation error | 16 | 4 | 0 |
| Development v9 | July 30 / 2 | Inference budget cutoff | 21 | 3 | 0 |
| Corrected v9 r2 | July 30 / 1 | Completed | 12 | 4 | 4 |
| Corrected v9 r2 | July 31 / 1 | Completed, hold | 13 | 0 | 0 |
| Corrected v9 r2 | August 3 / 1 | Inference budget cutoff | 22 | 4 | 0 |
| Corrected v9 r2 | August 3 / 2 | Inference budget cutoff | 12 | 0 | 0 |
| Corrected v9 r2 | August 3 / 3 | Completed | 14 | 4 | 4 |

Development: [run configuration](../../studies/muse-v9-journal-20260730-0803/config.json). Corrected: [run configuration](../../studies/muse-v9-journal-20260730-0803-r2/config.json), [decision journal review](../../studies/muse-v9-journal-20260730-0803-r2/journal-review.md).

All four failed attempts executed zero orders. No attempt reached the 300-second deadline. Three stopped at the 12-request inference limit; the remaining failure was missing/invalid client token usage. In r2, the two August 3 failures lasted 100.544 and 133.635 seconds; the successful retry lasted 40.839 seconds. The 12 turns / 24 tools / 300 seconds allowance resets for each attempt, with up to three attempts per day; it is not a 300-second aggregate daily cap.

## Checks and evidence

- **Source and runtime:** All 75 implementation files per archived source matched the recorded hashes. Each run was replayed with its own source snapshot, preserving the development run's older schema. Every attempt's sandbox identity matched its run, and current Bun/OpenCode/bubblewrap/worker/seccomp identities matched the saved runtime. No active `trading-bench-*` systemd units were observed at audit time.
- **Tool boundary:** All 110 broker requests and results replayed exactly, including the four rejected calls. Independent host audit records matched persisted decision traces. Client calls reconciled to broker records, allowing the two explicitly aborted calls that never reached the broker. All 63 forwarded inference requests used the fixed model, `/inference/responses`, and the same ten trading/journal tool definitions. No executed shell, filesystem, browser, remote retrieval, or foreign MCP tool appeared. Builtin tool registry entries marked `permitted: false` are not exposed model tools.
- **Market causality:** Checked 106 successful receipt scopes, 1,320 returned OHLCV bars, and 703 price/indicator `asOf` fields. July 30 responses ended July 29; July 31 responses ended July 30; August 3 responses ended July 31. Today's opening price and close were unavailable before the decision. Indicators and portfolio marks replayed from the eligible historical prefix. Known calendar dates and scheduled contributions in the prompt are permitted context, not future-price observations.
- **Sandbox evidence:** All seven attempt probes passed: separate mount/PID/network/user/IPC/UTS namespaces, zero effective capabilities, no-new-privileges, seccomp, writable scratch, and denial of the tested host paths, metadata-network access, and writes to the mounted worker/plugin. Launch code mounts bounded scratch storage and selected read-only runtime files; the repository, host home, dataset and host credentials are absent. The host controls the only gateway and actual portfolio/journal persistence.
- **Memory and state:** Seven distinct client session IDs, with no reuse across attempts. System/daily prompts matched each archived protocol and the committed history metadata. All four journal reads returned only this run's committed earlier memo. Failed development notes and failed August 3 decisions never entered later memory. Journal hash chains, terminal payloads, order queues, and all three accepted decisions validated. Offline full-ledger verification reproduced the saved summary exactly, including eight fills and the August 3 contribution exactly once.
- **Secret/content scan:** Privately compared the one configured host secret value against all saved run artifacts and decoded embedded content: zero matches. Examined recorded prompts, tool arguments/results, model text and journal entries for host paths, host calendar date, external URLs/active markup, and instruction-override patterns: no matches. Retained evaluator security metadata contains host paths and timestamps by design; those records are not model prompt/tool content. This scan is evidence for the configured value and recorded content, not a detector for every possible secret or encoding.
- **Adversarial regression checks:** 33 tests passed, zero failed, 136 assertions. Coverage includes mutated future prices/splits, poisoned indicators, forged session/journal identities, invalid receipt provenance, altered ledgers, rejected remote retrieval/continuations, budget revocation, and crash/retry behavior. [Test output](regressions.log).

The completed r2 ledger remains $993.43 ending equity on $1,000 contributed, eight fills, zero rejected executed orders, and -0.9509% time-weighted return. Its performance result was not changed by this audit.

## Wrong calls and journal quality

1. **Four journal schema errors in development.** One in attempt 1 and three in attempt 2 supplied seven evidence claims to the original six-claim schema. The broker rejected them without journal mutation. Generic error messages led the model to spend turns trying smaller/debug entries. The corrected run already has a maximum of eight claims, field-specific validation errors, and minimum substantive field lengths.
2. **Two aborted client calls in r2.** August 3 attempt 1 contains two `trading_journal_append` events with empty input, `Tool execution aborted`, and `interrupted: true`. Neither appears in the independent broker log; neither wrote a journal entry. They are client completion failures, not unauthorized broker actions.
3. **Placeholder notes were contained.** Development attempt 2 saved two plain notes and two structured test notes with fields such as `thesis: t`. Its older schema permitted these short fields, but the attempt failed and none was committed or exposed to r2. The current schema rejects these exact placeholders. Minimum length is not a semantic guarantee of a useful memo.
4. **Evidence provenance is not proof of the model's interpretation.** All 30 recorded structured evidence claims referenced valid information receipts; 21 belong to the three committed memos. The committed memos explain a momentum allocation, a hold, then an AAPL exit after its observed close broke below the moving averages. They also contain weak judgments: a one-day gain described as validating the entry, and $20 described as insufficient for diversification despite fractional shares being allowed. These are reasoning-quality observations, not environmental corruption. Some model summaries say “bought” or “sold” while orders are still queued; use the execution ledger to determine actual fills.

## Audit limitations and targeted follow-ups

- **Forced termination loses final client audits.** Both budget-killed August 3 attempts lack the final configuration and per-request system-prompt audit files that the worker emits after the client exits. They retain host broker/inference records and the initial sandbox probe. Therefore complete client prompt/configuration attestation is available for the accepted days, but cannot be asserted for these failed attempts. Development attempt 2 retains raw audit files but fails the request/fully-metered-step count check; the two r2 failures also have incomplete usage. Stream client audit events to the host as they occur to preserve this evidence on kill.
- **Denied requests have insufficient detail.** Seven denials are recorded only as `method/path`, one per attempt. The records do not establish their exact method or route, so they cannot be positively attributed to normal MCP transport behavior. Eight further denials are explicitly `inference-budget` and were not forwarded. Record sanitized method and pathname, status and sequence for denials; do not log authorization headers or raw query values.
- **No retained full inference request body.** The host records a body hash, model, route and tools; the client hook records the effective system prompt where available. This supports the checks above, but does not independently reconstruct every message on the provider wire. A host-side sanitized context manifest would strengthen auditing without retaining credentials.
- **Markdown rendering deserves hardening before adversarial journal use.** `src/study/review.ts` escapes HTML delimiters but preserves Markdown link/image syntax in model-authored text. None appeared in the audited content. Whether an image causes a network request depends on the viewer. Render model text as inert text or escape Markdown links/images before showing untrusted future journals; this is a reader-facing hardening opportunity, not an observed bench-state leak.

The audit does not prove resistance to an unknown kernel/runtime vulnerability, a compromised trusted host/provider, or a model recalling facts from training. It verifies date gating against the frozen imported dataset, not whether every vendor value was available without later revision at its historical timestamp.

## Reproducibility

Development source: `4f9c3b5f4d16e0334b9e3280787840d505a7c6122ec04d28182220719219a332`, [archive](../../qualifications/v9-journal-20260913-source.tar.gz).

Corrected source: `d56d702205462cb324f847736aaeb5131a73afc157e4211889f927fef8649396`, [archive](../../qualifications/v9-journal-20260913-r2-source.tar.gz).

[Machine-readable checks and the 45-file SHA-256 inventory](checks.json). The corrected source remains unchanged by this audit. With that implementation checked out, full ledger verification is:

```sh
bun scripts/run-study.ts --verify results/studies/muse-v9-journal-20260730-0803-r2
bun test tests/studyBoundary.test.ts tests/studyCausality.test.ts tests/studyRunner.test.ts
```
