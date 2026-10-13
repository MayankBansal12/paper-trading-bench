# Fable 5

Native Claude Code 2.1.296 on RedmiBook, exact `claude-fable-5`, medium effort. This is a fresh cohort, separate from Fable 5.1.

Smoke passed **3/3 valid**, with exact model identity, pinned replay and review. The annual run resumed after a host restart. Latest provisional coverage: **241 valid / 0 invalid / 10 remaining**, checked 2026-10-13T03:10:25.053104+00:00. No final annual score is available.

A host restart left two locks owned by a dead process at 237 valid days. Pinned read-only replay verified those days with no quarter errors. After copying the locks and checksumming the existing artifacts, only the two dead locks were removed and operational supervision resumed. The March 12 first attempt is retained as interrupted; its second attempt completed. No committed day was rerun. All original day/identity bytes and event-log prefixes remain unchanged. The blocked snapshot and audit stay separate from the resumed evidence. [Recovery checks and provenance](recovery.json).

The plan has 251 sessions across four independent quarters, with $600,000 total funding and serial execution. A systemd user service survives this chat and resumes after the provider's recorded quota reset plus five minutes. Completed days are skipped and failed attempts remain counted. Authentication or storage problems pause before a new attempt; terminal integrity failures stop the cohort. Compact final evidence is transferred back automatically.

[Checkpoint](checkpoint.json) records coverage, source/runtime/dataset identities, qualification and audit checksums. Source is pinned at `543a96170ffa56777d5022264a2ead38379ee3ae`. Fable 5 and 5.1 use identical binary/worker/sandbox bytes, hence the same runtime ID; the exact requested model, source and run IDs differ. No model alias or fallback is allowed.

Checks: **378 Bun tests**, **15 targeted adapter/auth tests**, **10 Python tests**, both TypeScript configs, frozen dataset preflight and four native sandbox scenarios passed. Two initial local validation commands failed because of dependency-directory and working-directory setup; their logs and hashes are retained. These were offline checks, not trading attempts.

Raw logs, datasets, private runtimes and credentials stay out of Git. The base audit is on RedmiBook at `claude-bench-fable5/archives/base.tar.gz`, SHA-256 `f1ad6ba195b4bc870a7c4c5ed44c2fc134751529595a62b6fdf7a6bd4028cb59`. Other audit locations/checksums are in the checkpoint. These provisional results are not ranked in the comparison viewer. Nothing was merged.
