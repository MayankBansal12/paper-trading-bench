# Pi / GPT-6 Astra results — September 16, 2026

Annual outcome: **incomplete**. Valid days: **51/251**; invalid days: 12; retried days: 12; completed quarters: 0/4. The annual score remains unavailable.

## Qualified live smoke

April 1–3, 2025: **3/3 valid decisions**, zero retries, zero invalid days, five fills and no rejected orders. Starting capital was $50,000; closing equity was **$50,372.93**, a **$372.93 (0.746%)** gain. The account retained $25,000 cash and held TMUS, ORLY, EXC, CCEP and ROP. Replay passed using the exact recorded source. This three-day smoke qualifies the adapter; it is not a scored annual comparison.

## Preserved failed smoke

The first smoke at `f118891` exposed an adapter audit bug: Codex streamed completed function-call items but omitted them from the terminal response's output array. The original validator rejected real Pi submissions. We stopped that run, retained all four attempts (three failed and one interrupted), and replayed it using its original source. Coverage is zero valid days, one committed invalid day, one partially attempted day and one unattempted day. No old manifest, event hash or day commit was rewritten. The fix at `94d8edd` started a separately named smoke and a fresh annual cohort.

## Conditions and evidence

- Exact route: `pi/openai-codex/gpt-6-astra`; Pi 0.85.1, Node 22.23.1, medium reasoning, host Codex OAuth, SSE.
- Four independent quarters: April 2025–March 2026, 62/64/64/61 sessions. Each starts with $50,000 and receives two further $50,000 deposits. Concurrency: 2.
- The existing v12 four-tool environment, prior-close cutoff, journal rules and accounting are retained. Pi uses a different agent client and prompt wrapper from OpenCode, so comparisons must identify the adapter.
- Subscription cost is unavailable. Measured token counts remain recorded. These results do not establish historical Nasdaq-100 membership eligibility.
- [Provenance and bundle locations](provenance.json), [qualified smoke summary](smoke-summary.json), [original failed smoke summary](original-smoke-summary.json).
- Audit bundles are local on host `afdasf`, with committed SHA-256 receipts. They contain raw logs, the frozen dataset and pinned source snapshots; those raw files are not in Git. This is not an off-host backup.
- The supervised annual driver verifies the run, generates per-quarter reviews, creates a separate final audit bundle and updates this results PR when the process finishes. Its [publication script](publication-script.py) is retained for review.

## Checks

Typecheck passed; final full suite **318 passed, 0 failed**. Pi-focused gateway/accounting tests: **5 passed**. The real Pi CLI passed synthetic success, schema correction, quota refusal, watchdog and tamper-rejection checks without inference. Both live-smoke artifacts replayed with their own source; only the second passed live qualification.

Two earlier test invocations were unsuccessful: one detected source changing during replay; another accidentally discovered duplicate tests in a nested checkout and hit fixture-path failures. The checkout was moved outside the repository and the final suite ran against stable source. The original live smoke remains failed/incomplete evidence, not a successful run.

[Annual verification report](annual-summary.json) and [execution/replay outcomes](annual-execution.json).
