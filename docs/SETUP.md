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

Pi and Claude use medium effort. OpenCode retains its recorded native defaults.
Opus 5.5's newer client requests a larger output cap than Opus 5. These differences
are part of the result provenance. Historical Pi/Go sandbox dependencies may differ;
new private Pi setups here use OpenCode 1.18.30 as an inert sandbox dependency.

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

Preflight and synthetic Pi qualification make no model calls. A live three-day
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

Inspect raw runs with `pnpm viewer --port 4173`. Verify an annual using the original
source and flags, adding `--verify=true` to its `bench eval` command. Keep raw logs,
dataset snapshots and source/runtime pins in a checksummed archive outside Git.
