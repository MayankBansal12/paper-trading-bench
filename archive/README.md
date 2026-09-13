# Frozen historical implementation

`v10-7f077b6.tar.gz` contains the original source, scripts, tests, dependency lock and documentation from base commit `7f077b64ccb2ce2439486d6bde69a3fa76e7a940` (parent PR #3).

SHA-256: `1e2c6857a7a1c96dd187b881414d50c36de585cbdb6900ad3f318819da5f43e7`.

Every file moved into `retired/` was checked byte-for-byte against this archive before and after its move. The visible tree is for review; historical test names end in `.ts.txt` so the current test runner does not execute retired protocols. For complete historical execution, unpack the archive in a separate directory and install its own frozen dependencies. Do not run the partial retired tree or resume old cohorts with current source.

The existing qualification source archives under `results/qualifications` remain unchanged. Their hashes and original protocol evidence are retained. `tests/fixtures/v10-control-ledger.json` preserves 64 original daily ledger values and source-file SHA-256s, with minimal AAPL prices derived from the hash-verified original dataset, for a self-contained offline accounting equivalence test. The full market/source archive remains an ignored local input.

`v10-reproduction-inputs.tar.gz` contains the original synthetic fixtures and `pnpm-workspace.yaml` (both dependency build scripts explicitly disabled). Extract it alongside the source archive before installing the historical lockfile. SHA-256: `a8b9379aa357efd527b1d4c879c06099aa79b5aa05874e3326c563f84984eb91`.
