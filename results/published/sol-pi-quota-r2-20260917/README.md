# Quota-aware GPT-5.6 Sol evaluation

State: **running**, phase: **annual**.

Recorded valid days: **163/251**; invalid days: 0; retried days: 7; complete quarters: 0/4. No annual score is available yet.

This is a user-authorized scheduling-only continuation after an external quota reset. Original manifests, completed days and failed attempts are unchanged. The continuation receipt pins the old/new source and runtime identities; prior quota failures alone may bypass their obsolete wait. Original per-quarter binaries and catalog metadata are restored privately after host package drift; only the launcher dispatch path changes. Trading workers, prompts, data, accounting, isolation flags and retry limits are byte-identical.

This is a **scheduling-only continuation of the same cohort**. Earlier cohorts and their attempts remain
unchanged in [the prior results PR](https://github.com/MayankBansal12/paper-trading-bench/pull/18).

The pinned `quota-pause-v1` scheduling policy pauses the entire serial queue after
an explicit provider usage-limit response. It waits for the recorded reset plus
five minutes, or six hours plus five minutes if no reset is supplied. The failed
attempt remains counted; no manifest, chain, invalid day, or retry allowance is
rewritten. Each day still allows at most two attempts.

The exact-time BB coordinator avoids duplicate workers, resumes the same pinned
cohort at its recorded quota reset plus buffer, verifies every settled checkpoint, and publishes
evidence. It pauses itself after verified completion or an unexpected blocker.
The live model smoke must pass before the annual run starts. The annual dataset is
April 2025–March 2026, in four independent accounts (62/64/64/61 sessions), with one
quarter active at a time. Pi 0.85.1 and medium reasoning remain pinned.

[Provenance and all audit-bundle checksums](provenance.json). Raw logs, datasets and
source snapshots are in immutable local audit archives on `afdasf`, not in Git.
Local archives are not an off-host backup. Subscription charges are unavailable.
Every checkpoint summary is labelled separately; a paused or failed run is not a
complete annual result. A successful integrity replay does not establish live
provider availability or historical Nasdaq-100 membership eligibility.

Implementation checks: see the linked implementation PR and committed tests.
The quota-pause tests cover provider reset parsing, no inference during cooldown,
retained attempts across resume, and refusal to grant a third attempt. Live replay
outcomes are captured in the checkpoint summaries and archived execution receipts.

Live continuation confirmed: provider returned HTTP 200, June 5 completed and the next day began. See [live observation](011-live-continuation.json). The counts above describe the last settled replay; this live observation is not an annual score.
