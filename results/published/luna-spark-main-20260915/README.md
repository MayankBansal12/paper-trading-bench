# Luna and Spark validation after the September 15 merges

Validated `main` at `3d2f9302af41628994d20d1f79316e865e51d42c`
against the preserved `models-v12-2025q2-2026q1` cohort.

## Results

| Model | Historical records replay | Valid / planned days | Invalid days | Current live smoke |
| --- | --- | --- | --- | --- |
| Luna | Pass; four quarters complete | 251 / 251 | 0 | Pass: 1 valid day, 6 fills, no retry |
| Spark 1.3 | Pass; all four quarters stopped | 50 / 251 | 12 | Blocked: HTTP 429 `FreeUsageLimitError` |
| Spark 1.2 | Pass; quarters incomplete | 38 / 251 | 0 | Blocked: HTTP 429 `FreeUsageLimitError` |

Replay success means the saved evidence and accounting are consistent. It does
not turn invalid days into valid decisions or make unfinished models eligible for
an annual score. Both Spark annual scores remain unavailable. Spark 1.2 has two
interrupted attempts beyond its 38 committed days, and two quarters with no
attempts. Spark 1.3 reached the existing three-consecutive-invalid-day stop in
all four quarters. No attempts were erased, replaced or resumed to improve scores.

Luna's verified quarterly closing equity is $164,910.54 / $159,192.92 /
$147,683.69 / $133,501.00. All 251 days are valid; six days required a retry.
These are four independent portfolios, not one continuous-year account. These
results do not establish historical Nasdaq-100 membership eligibility.

The original annual `summary.json` was stale and showed running/pending coverage.
[historical-verification.json](historical-verification.json) is the freshly
reconstructed report. The original summary, manifests, event streams and day
commits remain byte-identical. The verifier returned exit 1 because the overall
evaluation is incomplete; it produced all 12 quarter results with no integrity
errors. Verification performed zero inference calls.

## What the merges changed

All 12 regenerated study configs match their saved configs, including dataset,
dates, funding, limits and journal policy. Source files controlling the prompts,
tools, cutoffs, memory, execution and accounting are unchanged. The sandbox
runtime identity also matches the historical runtime (`af47d0e2…`).

Seven adapter/acceptance files changed to support GLM pricing and transport. The
existing Luna/Spark routes retain their model IDs, adapters, auth selection and
zero-price pins. The cost check moved to route-aware acceptance; its evidence
field changed from `zeroCostProven` to `pricingProven`. The generated client has
additional headers only for the Go provider. Model-facing configuration matches,
but this is **not** the same implementation identity.

The historical implementation is `fa3300df…`; merged main is `57b356e2…`.
Annual manifests changed from v3 to v4. Continue to replay this cohort with its
original source; never bypass identity guards or rewrite its manifest to resume
with current main. Spark 1.3 Q3 records revision `c7b1b6f`, whose only difference
from `0070182` is a CLI edit outside the implementation closure; the implementation
and orchestrator hashes match. Both source snapshots are preserved.

## Fix discovered during live validation

Each Spark smoke received HTTP 429 with `FreeUsageLimitError` in both attempts,
then hit its 120-second-per-attempt watchdog. It produced one accounted **invalid**
day and no tool calls. Main's CLI returned exit 0 because accounting had completed.

This PR makes smoke `run` and `resume` fail unless every planned day is valid.
Ordinary cohort accounting and read-only verification retain their meaning.
The fix affects CLI exit status only, so the benchmark implementation hash stays
`57b356e2…`. It was checked against all three terminal smoke artifacts: Luna
returns 0; both Spark runs return 1; their files are unchanged. No additional live
calls were needed for that check.

Spark cannot be called operational while the provider refuses requests. When its
quota becomes available, qualify a separately named smoke and publish its evidence
through a new PR. Preserve these failures and the stopped historical quarters.

## Evidence and preservation

- [provenance.json](provenance.json): source/runtime/dataset identities, quarter
  roots, validation results and archive location/checksum.
- [historical-verification.json](historical-verification.json): the freshly
  reconstructed verification report for all 12 historical quarters.
- [artifact-files.sha256](artifact-files.sha256): 596 individual bundle file hashes.
- [audit-bundle.sha256](audit-bundle.sha256): checksum for the compressed bundle.

The remaining receipts (config-compatibility comparisons across all 12 children,
per-smoke HTTP/tool outcomes, sandbox and executable identities, and the corrected
CLI exit outcomes) are summarized in this README and in `provenance.json`; the
full receipts are preserved inside the checksummed local bundle.

The local bundle is `results/archives/luna-spark-main-20260915.tar.gz` on the
benchmark host. It contains the 12 historical runs, original evaluation records,
three new smoke runs, frozen dataset and three source snapshots. Raw artifacts
remain gitignored. **This is a local archive, not an off-host backup.** The PR
preserves compact evidence and checksums, not the large bundle itself. Retain or
copy the bundle with its checksum before removing this host or its working data.

## Reproduce historical replay

Requires Bun 1.3.14 and the dependencies in the pinned lockfile. Use the original
recorded dataset path; on another host, restore or mount the bundled dataset there.
Do not edit manifests to change their paths. Run the following from this repository:

```sh
sha256sum -c results/published/luna-spark-main-20260915/audit-bundle.sha256
audit_root=$(mktemp -d)
tar -xzf results/archives/luna-spark-main-20260915.tar.gz -C "$audit_root"
(cd "$audit_root" && sha256sum -c CONTENTS.sha256)
mkdir "$audit_root/replay"
tar -xf "$audit_root/sources/0070182e13d1bdf28198b74b9e03193a7abef7c5.tar" -C "$audit_root/replay"
cp -a "$audit_root/historical/results/." "$audit_root/replay/results/"
cd "$audit_root/replay"
pnpm install --frozen-lockfile
bun src/index.ts eval --eval-id models-v12-2025q2-2026q1 \
  --data-dir /home/ai/code/paper-trading-bench/datasets/historical/nasdaq100_2025q2-2026q1_v1 \
  --verify=true > replay.json
```

The last command returns 1 for incomplete Spark coverage; a produced report with
all 12 non-error quarters is the expected result. A thrown error or missing report
is a verification failure. Compare the parsed report with the committed
`historical-verification.json`. This path makes no model calls.

For the smoke artifacts, extract the `3d2f930…` source archive into a separate
checkout, copy `smoke/results/.` into its `results/`, install its pinned dependencies,
and run `bun src/index.ts verify --dir results/studies/RUN_ID` for each run listed
in `smoke-verification.json`. Integrity verification succeeds for both invalid
smokes too; their `validDays: 0` is why they fail live qualification.

## Checks

- Typecheck passed; full suite: **313 passed, 0 failed**.
- All 12 historical studies replayed at their matching original implementation.
- All three current-main smoke records replayed; only Luna passed live qualification.
- Sandbox qualification and all three refreshed exact-route catalog checks passed.
- New smoke-exit regression coverage and terminal-artifact checks passed.
- No benchmark implementation files or historical records changed in this PR.

Agent code changes and run evidence now have an explicit PR-only workflow in
[AGENTS.md](../../../AGENTS.md) and the [runbook](../../../docs/EVAL_RUNBOOK.md).
