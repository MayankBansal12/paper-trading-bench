# Fable 5.1

Native Claude Code 2.1.296 on RedmiBook, exact `claude-fable-5-1`, medium effort.

Smoke passed **3/3 valid days**, with no retried days. Pinned replay and review passed; two tool errors were corrected within the first attempt. The fresh **251-session annual is running**, with two valid days in this checkpoint. Final profit is pending.

Quota pauses resume at the provider reset plus five minutes. Committed days are skipped and all failed attempts remain counted. Login or storage problems pause safely; terminal integrity failures stay blocked. The service and timer survive thread exit and reboot.

[Checkpoint](checkpoint.json) records source/runtime/dataset identities, checks and audit checksums. Raw logs and private runtime archives remain on RedmiBook. Compact evidence is copied back automatically. Subscription cost is unavailable.

Validation: 377 Bun tests, 14 native adapter/auth tests, 10 Python tests and typecheck passed. The native sandbox passed success, correction, quota and timeout fixtures without provider calls. Earlier setup and disk-related test failures are retained and disclosed in the checkpoint.
