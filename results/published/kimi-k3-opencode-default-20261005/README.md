# Kimi K3 through OpenCode Go

Snapshot: 20261005T083120920141Z. Supervisor phase: **smoke**; status: **running**.
OpenCode 1.18.30, exact `opencode-go/kimi-k3`, native default reasoning with no override. Source `361051d4eda8ce784e3437171d41d20eb9086604`; one independent quarter at a time. The full evaluation plans 251 sessions across four quarters. Incomplete coverage has no annual score.

| Run | Valid | Invalid | Last committed day |
|---|---:|---:|---|
| kimi-k3-opencode-default-20261005-smoke | 1 | 0 | 2025-04-01 |

Source PR: https://github.com/MayankBansal12/paper-trading-bench/pull/26.
Checks and known setup failures are recorded in the [checkpoint](20261005T083120920141Z.json). Catalog checks alone are not live qualification. Recorded verification results distinguish artifact integrity from valid-day coverage. The prior Pi/RedmiBook attempts are separate.

Audit bundle on this host: `/home/ai/.bb/thread-storage/thr_dtnr7yc9jp/kimi-k3-20261005/audit/20261005T083120920141Z.tar.gz`; SHA-256 `a1b9cd1cf65a6f418d560c50f06fb3718a910a92324218d65a803b64c3cefdbf`. It includes source, pinned client, sandbox assets, catalog evidence, logs and supervisor configuration. Raw records and credentials are not committed to Git. Host credentials are not included in the bundle.

Quota pauses resume after the recorded reset and buffer, without refunding attempts. The persistent supervisor verifies/reviews settled execution. Final publication is triggered when its service stops. Active snapshots retain open attempts; final replay remains pending until execution settles.
