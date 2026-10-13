# Setup

## Prerequisites

Use Linux with systemd user services, Bubblewrap 0.9.0, GCC and libseccomp development
headers. Use Bun 1.3.14 and pnpm 11.15.1. Install prerequisites through your normal
package manager; the repository does not change shared clients automatically.

```sh
pnpm install --frozen-lockfile
pnpm sandbox:provision
```

The sandbox denies host files and direct network access. A scoped Unix socket
connects it to the host gateway. Credentials stay on the host. Run the sandbox
check on each execution machine; having `bwrap` installed is not sufficient.

## Clients and models

Install and log in with the native client before pinning it. These are the recorded
client versions; catalog presence does not prove current entitlement.

| Model | Exact route | Client | Node |
|---|---|---|---|
| Astra 6 | `pi/openai-codex/gpt-6-astra` | Pi 0.85.1 | 22.23.1 |
| Sol 5.6 | `pi/openai-codex/gpt-5.6-sol` | Pi 0.85.1 | 22.23.1 |
| Sol 6 | `pi/openai-codex/gpt-6-sol` | Pi 0.87.0 | 24.13.0 |
| Luna 6 | `pi/openai-codex/gpt-6-luna` | Pi 0.87.0 | 24.13.0 |
| Muse 1.3 | `pi/opencode-go/muse-spark-1.3-contributor` | Pi 0.85.1 | 24.13.0 |
| GLM Flash | `opencode-go/glm-5.3-flash` | OpenCode 1.18.30 | — |
| DeepSeek Flash | `opencode-go/deepseek-v4.1-flash` | OpenCode 1.18.30 | — |
| Sonnet 5 | `claude-code/anthropic/claude-sonnet-5` | Claude Code 2.1.274 | — |
| Opus 5 | `claude-code/anthropic/claude-opus-5` | Claude Code 2.1.274 | — |
| Opus 5.5 | `claude-code/anthropic/claude-opus-5-5` | Claude Code 2.1.280 | — |
| Fable 5 | `claude-code/anthropic/claude-fable-5` | Claude Code 2.1.296 | — |
| Fable 5.1 | `claude-code/anthropic/claude-fable-5-1` | Claude Code 2.1.296 | — |

Fable 5 and 5.1 use the captured native 2.1.296 request format: adaptive thinking,
a 64,000-token output cap and medium effort. The client may include an empty
system message carrying that same effort.
The client may remove `thinking.display` after a provider rejection; the model and
effort checks remain exact. This is a new cohort, not a runtime upgrade of old runs.

Pi and Claude use medium effort, enforced by their gateways. Some historical
provenance summaries omit the request-level reasoning field; an empty field does
not establish that reasoning was disabled. OpenCode retains its recorded native defaults.
Opus 5.5's newer client requests a larger output cap than Opus 5. These differences
are part of the result provenance. Historical Pi/Go sandbox dependencies may differ;
private Pi setups accept OpenCode 1.18.30 or 1.18.31 as an inert sandbox dependency,
recording the exact binary hash. OpenCode inference routes require 1.18.30.

Pi uses its host Codex OAuth login. Go uses the host OpenCode auth store or
`OPENCODE_GO_API_KEY`. Claude uses its host subscription login (`claude`, then
`/login`). An expired Claude login pauses execution; no auxiliary model refresh
call is made. No credentials belong in this repository.

```sh
pnpm runtime:pin pi/openai-codex/gpt-6-luna
source .runtime/pi-openai-codex-gpt-6-luna/env.sh
```

Pinning copies installed executables and Pi's complete dependency graph; it does
not install or update the shared clients. `BENCH_PI_MODELS_STORE` can point to a
separately verified catalog. Sol 6 and Luna 6 used the unchanged official pi-ai
0.87.1 catalog with the Pi 0.87.0 client. No model alias or fallback is allowed.
`CLAUDE_CODE_BINARY` selects a private Claude binary. A new runtime requires a new
cohort and smoke qualification.

## Data and qualification

Keep the frozen dataset outside Git. The selected study uses
`nasdaq100_2025q2-2026q1_v1`, with dataset identity
`5960ed91303695159a2293d9583be4a80e9f1f5284a0b61db3c6c063d79bc901`.
It contains warmup history plus all four quarters. Use the results archive index
to locate the original snapshot. A newly downloaded dataset is a different input.
The loader verifies its manifest and file hashes.

```sh
pnpm bench eval --eval-id example --models pi/openai-codex/gpt-6-luna \
  --data-dir /path/to/dataset --concurrency=1 --preflight=true
pnpm bench sandbox-check --model pi/openai-codex/gpt-6-luna
pnpm runtime:check pi/openai-codex/gpt-6-luna
```

For Claude, run `bun scripts/qualify-claude.ts EXACT_ROUTE NEW_OUTPUT_DIR`
after pinning the client. It exercises success, tool correction, quota timing,
timeout and replay rejection using synthetic responses in the real sandbox.
It does not read the host login or call the provider.

Preflight and synthetic client qualification make no model calls. A live three-day
smoke must still pass exact identity, three valid days, replay and review before
annual results are collected. The supervisor handles that sequence.

## Run and resume

Use a clean, committed checkout dedicated to this evaluation. Budget at least
10 GiB free: 6 GiB for results and a 4 GiB reserve, plus private runtime space.

```sh
pnpm supervise --id example --model pi/openai-codex/gpt-6-luna \
  --data-dir /path/to/dataset
```

Progress is in `results/supervision/example/state.json`. Repeating the same command
resumes the recorded cohort; a lock prevents two supervisors owning it. Completed
days are skipped, interrupted attempts remain counted, and terminal states stay
stopped. Quota waits use the recorded reset time. Login and storage waits recheck
every minute. Verification and review must pass before completion is recorded.

For execution across logouts/reboots, run this command in a systemd user service
with `WorkingDirectory` set to the pinned checkout, private runtime variables in
`Environment`, `Restart=on-failure`, and `WantedBy=default.target`. Enable it with
`systemctl --user enable --now YOUR-UNIT`; enable user lingering if needed. Keep the
machine awake. Host services and login setup are operational prerequisites, not
part of the model's sandbox.

A blocked state needs diagnosis before further inference. Gateway denials retain
their reason (for example, request size versus invalid compression); they are not
quota waits. A code or runtime correction requires a separately identified run.
Use the recorded implementation to inspect the old evidence.

Inspect raw runs with `pnpm viewer:raw --port 4174`. Verify an annual using the original
source and flags, adding `--verify=true` to its `bench eval` command. Keep raw logs,
dataset snapshots and source/runtime pins in a checksummed archive outside Git.

## Reproduce the published inputs

Repository access is required for release assets. From a clone:

```sh
gh release download evidence-2026-09-25 --pattern nasdaq100_2025q2-2026q1_v1.tar.gz --dir /tmp/bench-inputs
mkdir -p datasets/historical
tar -xzf /tmp/bench-inputs/nasdaq100_2025q2-2026q1_v1.tar.gz -C datasets/historical
```

Verify the archive SHA-256 against `results/archives.json`; the preflight also
checks the dataset's internal identity. For historical replay, download
`historical-sources.bundle` from the same release, verify its checksum, and fetch
it into your clone (`git fetch /path/to/historical-sources.bundle 'refs/archive-publication/*:refs/archive-publication/*'`).
Check out the exact source revision in `results/current/provenance.json` and use
its recorded runtime and raw audit bundle. A newer checkout cannot stand in for
the historical implementation. Compact evidence is enough to reproduce the
published analysis, but not full provider-stream replay.
