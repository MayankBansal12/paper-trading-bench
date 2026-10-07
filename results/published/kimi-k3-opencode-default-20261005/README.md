# Kimi K3 through OpenCode Go

**Cancelled at the user’s request.** The supervisor and publication services are stopped and masked; all saved attempts and audit bundles remain unchanged. No further evaluation is scheduled. See the [cancellation record](user-cancel.json).

User-requested pause: automatic startup is disabled and no Kimi worker is active. The run had already stopped after audit errors, with 10 valid and 12 invalid annual days. Saved artifacts are unchanged; see [pause record](user-pause.json).

Snapshot: 20261005T092909307642Z. Supervisor phase: **annual**; status: **blocked**.
OpenCode 1.18.30, exact `opencode-go/kimi-k3`, native default reasoning with no override. Source `361051d4eda8ce784e3437171d41d20eb9086604`; one independent quarter at a time. The full evaluation plans 251 sessions across four quarters. Incomplete coverage has no annual score.

| Run | Valid | Invalid | Last committed day |
|---|---:|---:|---|
| kimi-k3-opencode-default-20261005-opencode-go-kimi-k3-5e91873c26c8-2025-Q2 | 10 | 3 | 2025-04-17 |
| kimi-k3-opencode-default-20261005-opencode-go-kimi-k3-5e91873c26c8-2025-Q3 | 0 | 3 | 2025-07-03 |
| kimi-k3-opencode-default-20261005-opencode-go-kimi-k3-5e91873c26c8-2025-Q4 | 0 | 3 | 2025-10-03 |
| kimi-k3-opencode-default-20261005-opencode-go-kimi-k3-5e91873c26c8-2026-Q1 | 0 | 3 | 2026-01-06 |
| kimi-k3-opencode-default-20261005-smoke | 3 | 0 | 2025-04-03 |

Source PR: https://github.com/MayankBansal12/paper-trading-bench/pull/26.
Checks and known setup failures are recorded in the [checkpoint](20261005T092909307642Z.json). Catalog checks alone are not live qualification. Recorded verification results distinguish artifact integrity from valid-day coverage. The prior Pi/RedmiBook attempts are separate.

Audit bundle on this host: `/home/ai/.bb/thread-storage/thr_dtnr7yc9jp/kimi-k3-20261005/audit/20261005T092909307642Z.tar.gz`; SHA-256 `ad1b7171f003e1f52889ebe4912750291a0ff039c4801509e395301c20d23d3b`. It includes source, pinned client, sandbox assets, catalog evidence, logs and supervisor configuration. Raw records and credentials are not committed to Git. Host credentials are not included in the bundle.

Quota pauses resume after the recorded reset and buffer, without refunding attempts. The persistent supervisor verifies/reviews settled execution. Final publication is triggered when its service stops. Active snapshots retain open attempts; final replay remains pending until execution settles.
