# Fable 5

Native Claude Code 2.1.296 on RedmiBook, exact `claude-fable-5`, medium effort. **251 valid days, zero invalid, one retried day; 252 annual attempts.** Smoke passed 3/3. Pinned replay and all four final reviews passed.

Total profit: **+$29,554.83** on $600,000 contributed across four independent quarters. Average profit per quarter: **+$7,388.71**; mean quarterly TWR: **8.25%**. These accounts do not form one compounded annual portfolio.

| Quarter | Net profit | TWR |
|---|---:|---:|
| 2025-Q2 | +$28,416.22 | 25.46% |
| 2025-Q3 | +$9,722.56 | 9.64% |
| 2025-Q4 | −$661.17 | 4.40% |
| 2026-Q1 | −$7,922.78 | -6.51% |

Annual observed usage: **3,828,743 tokens**. The interrupted attempt has no token total, so usage is incomplete; subscription cost is unavailable. Smoke usage is separate. Original counters and discrepancies are retained.

A host restart left two dead-process locks at 237 days. Original artifacts were checksummed; pinned replay verified every saved day, and the unchanged runtime passed four offline sandbox scenarios. Only the two dead locks were removed. The same cohort resumed, retaining March 12 attempt 1 as interrupted; attempt 2 completed. No completed day was rerun. Original day/identity bytes, event prefixes and the blocked audit remain preserved. [Recovery evidence](recovery.json).

[Checkpoint](checkpoint.json) and [independent checks](verification.json) bind the compact files to their original events, day chains, accounting, journals and exact provider responses. Every accepted request/response is Fable 5 at medium effort; no alternate model or gateway denial was observed. This verifies provider-reported identity, not provider internals.

Source: `543a96170ffa56777d5022264a2ead38379ee3ae`. Runtime: `2215d4523c30a8e14d6233a4092f7f2ac946e86b17c360dd17cae83d59e34f1c`; same binary/worker/sandbox bytes as Fable 5.1, with a different model route and cohort. Dataset: `5960ed91303695159a2293d9583be4a80e9f1f5284a0b61db3c6c063d79bc901`.

Original setup checks: 378 Bun tests, 15 adapter/auth tests, 10 Python tests, both TypeScript configurations and dataset preflight passed. Earlier offline setup failures are retained. Final handoff checks cover transfer/audit checksums, event/day chains, acceptance, opening journals, exact identity, cash/units and four-quarter accounting. No new benchmark inference was used for handoff.

Raw audit remains on RedmiBook at `claude-bench-fable5/archives/final-resume-20261013.tar.gz`, SHA-256 `72cad4876733fc45c7fb4b4c6eea9a9f743e88a7a77b96fdeee92eef913f7899`. The old `final.tar.gz` is the preserved blocked snapshot. Raw logs, datasets, runtimes and credentials stay out of Git. Fable 5.1 and the ranked comparison viewer are unchanged. Nothing was merged.
