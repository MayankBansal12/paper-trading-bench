# Reproducible evaluation execution

This is the shared preparation for a model evaluation on another host. The current
runtime is OpenCode; the Claude Code adapter will be developed and qualified on
`mayank-RedmiBook-15` before Sonnet can use the same execution/reporting flow.

## Pull requests for agent work and run evidence

Deliver every agent code change through a branch and PR; never push directly to
`main`. Run each evaluation from a clean, pinned revision. Include every live
benchmark run in a results PR, including smoke tests, interrupted runs and provider
failures. The PR should identify its source, commands, exact model, dataset/runtime
hashes, coverage and replay result, and link the checksummed audit bundle. A failed
smoke is evidence to retain, not a result to quietly replace with a successful retry.

Historical results remain tied to their original implementation after merges.
Use a separate checkout of that source and verify a copy of the artifacts. Publish
the newly derived summary in the results PR; do not rewrite the frozen manifests
or replay guards. A stale orchestrator `summary.json` is not authoritative coverage.
Check day commits and reconstruct the summary with the pinned verifier.

Compare saved child configs and the source that controls prompts, tools, data
cutoffs, journals and accounting before claiming comparable conditions. Matching
configs alone do not prove behavior is unchanged, and neither a matching config
nor a successful replay proves a provider is currently available. Confirm current
availability with a separate bounded smoke. Preserve an incomplete model's partial
results and leave its annual score unavailable.

## 1. Freeze the checkout and runtime

Use a dedicated worktree at the reviewed commit, then record `git rev-parse HEAD`
and confirm a clean source tree. Keep that checkout for the entire run and replay.
Changing active source, data or runtime during an evaluation is not an upgrade of
the existing cohort; it requires a new cohort. Existing v3 annual manifests use
their original scheduler source; newly launched evaluations use v4.

Required versions for the current adapter:

| Component | Qualified version |
| --- | --- |
| Bun | 1.3.14 (also the CI version) |
| pnpm | 11.15.1 |
| OpenCode | 1.18.30 |
| Bubblewrap | 0.9.0 |
| Platform | Linux with namespaces, systemd and seccomp |

Install dependencies with `pnpm install --frozen-lockfile`. The sandbox setup uses
`scripts/sandbox/provision.sh` to install `libseccomp-dev`, build the seccomp filter
with GCC and check Bubblewrap. The existing launcher uses noninteractive privileged
`systemd-run` and `systemctl` commands. Resolve those machine prerequisites locally
and run `pnpm sandbox:check`; an available `bwrap` binary alone does not prove that
the complete launcher works. A rootless launcher needs its own qualification.

RedmiBook preflight on 2026-09-15 found Claude Code 2.1.266 with a subscription login,
GitHub authentication, Bubblewrap 0.9.0, and the checkout at
`/home/mayank/code/Paper-Trading-Bench`. Bun was 1.1.22, libseccomp development
metadata was missing, and noninteractive sudo required a password. These are
dated observations, not a replacement for preflight. Use benchmark-local pinned
executables where possible. The laptop has approximately 8 GB RAM; start with
`--concurrency=1` for a single model's four quarters.

## 2. Copy and validate the frozen data

Transfer `datasets/historical/nasdaq100_2025q2-2026q1_v1` from the existing benchmark
host, including its manifest, OHLCV files and source snapshots. Git does not contain
this directory. Verify the transferred archive checksum and run dataset preflight;
the loader checks every registered file hash. Compare every child config's
`datasetHash` against the source dataset's preflight. Keep the recorded absolute
dataset path available for later replay on the execution host.

The 2026-09-15 no-inference preflight accepted all four quarters with dataset hash
`5960ed91303695159a2293d9583be4a80e9f1f5284a0b61db3c6c063d79bc901`.
Use that frozen identity for the current cohort rather than treating a new download
under the same directory name as equivalent data.

Example for the currently implemented GLM route:

```sh
pnpm typecheck
pnpm test
pnpm bench eval --eval-id glm-annual-v4 \
  --data-dir /path/to/nasdaq100_2025q2-2026q1_v1 \
  --models opencode-go/glm-5.3-flash --concurrency=1 --preflight=true
pnpm model:preflight --model opencode-go/glm-5.3-flash
pnpm sandbox:check
```

The annual data preflight must contain 62 / 64 / 64 / 61 sessions, totaling 251,
with 100 warmup observations per eligible security. Its four quarters each start
with $50,000 and have two further $50,000 deposits. No portfolio or journal crosses
a quarter boundary. This supported-security environment evaluation does not by
itself qualify historical Nasdaq-100 membership; `bench qualify` remains separate.

## 3. Qualify a small live smoke

```sh
pnpm bench run --run-id glm-adapter-smoke --smoke=true \
  --model opencode-go/glm-5.3-flash \
  --data-dir /path/to/nasdaq100_2025q2-2026q1_v1 \
  --start 2025-04-01 --end 2025-04-03
pnpm bench verify --dir results/studies/glm-adapter-smoke
pnpm bench review --dir results/studies/glm-adapter-smoke --analysis=true
```

Check actual valid decisions, exact requested/resolved model, four trading tools,
usage availability, durable accepted submissions and successful replay. A process
that exited successfully or created three day files is insufficient: day files can
also represent explicit invalid-day accounting. Smoke `run` and `resume` exit
nonzero unless every planned day is valid; ordinary cohort completion still counts
invalid days as accounted sessions. Read-only `verify` checks artifact integrity,
so it can succeed for an invalid smoke; inspect its coverage too. Use a fresh
evaluation ID for the full run; smoke state is never adopted as quarterly model memory.

For Claude Code, first implement the adapter, local subscription transport,
model/prompt/tool audits, stream/usage parsing and sandbox support. Test fresh
daily sessions, tool-error correction, no extra inference after submission, and
interrupted recovery. The installed CLI's `--bare` mode skips subscription OAuth
discovery, so that flag alone is not a validated authentication setup. Pin the
tested client and actual model identity rather than relying on a moving alias.

### Error interpretation

Recoverable tool-validation errors are returned to the model for correction within
the same attempt. There is no tool-call count limit, and two tool errors do not by
themselves invalidate a day. The current policy exhausts **two failed attempts**
before invalid-day accounting, and stops after three consecutive invalid days.

Reviews/analysis distinguish timeout, runtime limit, interruption, provider HTTP
failure, missing submission and harness failure, while retaining the original
reason and separate error observations. These labels do not change the v12 policy.
Before launching the Claude cohort, its qualification must exercise subscription
limits/auth failures and watchdog behavior. If infrastructure waits should pause
without consuming an attempt, implement and version that policy before the run;
do not grant fresh attempts by deleting logs or restarting under a new name and
silently replacing a failed result.

## 4. Launch, monitor and resume

```sh
pnpm bench eval --eval-id glm-annual-v4 \
  --data-dir /path/to/nasdaq100_2025q2-2026q1_v1 \
  --models opencode-go/glm-5.3-flash --concurrency=1

# After a process interruption, with the same source, runtime and flags:
pnpm bench eval --eval-id glm-annual-v4 \
  --data-dir /path/to/nasdaq100_2025q2-2026q1_v1 \
  --models opencode-go/glm-5.3-flash --concurrency=1 --resume=true
```

Use a persistent BB terminal or supervised machine job, and keep the laptop awake
and connected. The concurrency flag bounds whole quarter jobs, not model turns or
tool calls. The immutable plan records it, so preserve it on resume and verify.
Resume reconstructs committed state and honors the existing attempt allowance;
a terminal stopped quarter remains stopped.

Monitor the annual `summary.json`, child day commits and latest event timestamps.
Queued jobs remain `pending`; they are not stalled processes. An open provider
stream and fresh chunks show activity, while a quiet process may be waiting or
stalled. Neither an incomplete count nor the viewer's refresh timer proves model
liveness. The viewer reads locally available study folders, including symlinks;
cross-host artifacts must be copied to it or served from the execution host.

## 5. Verify and publish results

```sh
pnpm bench eval --eval-id glm-annual-v4 \
  --data-dir /path/to/nasdaq100_2025q2-2026q1_v1 \
  --models opencode-go/glm-5.3-flash --concurrency=1 --verify=true
```

Verify every child with its pinned source and generate per-child `review` with
`--analysis=true`. Preserve the original manifests, runtime identity, event logs,
daily commits and the exact source commit. Package the full audit records as an
artifact bundle with a checksum; raw `results/studies` and `results/evaluations`
directories remain gitignored. Publish compact derived material in a results PR,
for example under `results/published/<eval-id>/`:

- Annual and four-quarter summaries with complete/invalid/retried/unattempted coverage.
- Contribution-adjusted returns, closing equity/profit, fills and rejected orders.
- Exact model/client, source commit, dataset hash, concurrency and failure policy.
- Verification commands/results and checksums plus the audit-bundle location.
- Usage/cost values with unavailable metadata left explicit; subscription usage
  should not be presented as a proven zero-priced API route.

The year score remains unavailable when a quarter is missing, errored, stopped or
unfinished. Sum independent quarter profits and label mean quarterly TWR; do not
concatenate four fresh portfolios into a continuous annual equity curve.
