# Fable 5.1

Native Claude Code 2.1.296 on RedmiBook, exact `claude-fable-5-1`, medium effort.

Completed **251/251 valid days**, zero invalid, with **+$23,611.45 net profit** on $600,000 total contributions. Average profit per quarter: **+$5,902.86**. Mean quarterly time-weighted return: **6.13%**.

| Independent quarter | Valid days | Net profit | Time-weighted return |
|---|---:|---:|---:|
| 2025 Q2 | 62 | +$14,665.61 | 9.59% |
| 2025 Q3 | 64 | +$13,357.62 | 11.00% |
| 2025 Q4 | 64 | −$2,035.23 | 1.26% |
| 2026 Q1 | 61 | −$2,376.55 | 2.67% |

Each quarter starts a fresh account with $150,000 total funding. Dollar profits are summed; mean quarterly TWR is not an annual compounded return. Deposit timing can produce a positive TWR alongside a dollar loss.

Smoke passed **3/3**; smoke and annual passed pinned replay and review. The annual used **253 attempts** and made **398 fills**, with no rejected execution orders. Two dates succeeded on attempt 2: July 21 after an invalid usage counter, and October 17 after HTTP 429. The quota pause resumed at the recorded reset plus five minutes. Both failures and the uncommitted July submission remain in the evidence.

Observed annual usage: **9,153,931 tokens**, including cache reads/writes, across 550 recorded provider requests. Token totals are unavailable for the two failed attempts, so this is incomplete. Subscription cost is unavailable. Tool events record **563 requests and 38 recoverable errors**; the failed July attempt reports inconsistent counters (including negative values), preserved as recorded rather than used for these tool totals. Smoke usage is separate.

[Checkpoint](checkpoint.json) records the source/runtime/dataset identities, quarterly metrics, failures and audit checksums. [Verification](verification.json) records 13,386 handoff checks: all six transferred file hashes, 16,307 original event records, 254 day hashes including smoke, acceptance anchors, opening journals, exact request model/effort, cash, holdings, funding and quarterly returns reconcile. The final raw archive checksum was rechecked on RedmiBook. No new inference or runtime replay was run for this handoff.

The five [compact files](compact/) are gzip-compressed JSONL, unchanged after decompression. Each row contains one original day accounting record and all its attempts, including journals, submissions, ordered tool calls, receipt summaries, request identities and observed usage. They omit bulk price responses and provider streams. Raw audit and private runtime archives stay on RedmiBook; this result has not been imported into the comparison viewer.

Final audit: `RedmiBook: claude-bench-fable51/archives/final.tar.gz` (19,032,912 bytes), SHA-256 `acc04150a1e9cda732ea0610c57ebbe880197b362d7c5fe041f090ae81a9bd46`.

Pre-run checks: 377 Bun tests, 14 native adapter/auth tests, 10 Python tests and typecheck passed. Native sandbox success, correction, quota and timeout fixtures passed without provider calls. Earlier fixture and ENOSPC test failures remain disclosed in the checkpoint. The final update changes only result evidence; the clean execution source remains `c6a5c3c4e9795387586435637c672d0b71c96e64`.
