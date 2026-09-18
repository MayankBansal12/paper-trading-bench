# Pi / GPT-6 Astra evaluation

The opt-in route `pi/openai-codex/gpt-6-astra` runs the installed **Pi coding-agent
CLI 0.85.1** under **Node 22.23.1**, using Pi's host OpenAI Codex OAuth account.
It is separate from the four default OpenCode routes. Select it explicitly:

```sh
pnpm bench run --run-id astra-smoke --smoke=true \
  --model pi/openai-codex/gpt-6-astra \
  --data-dir datasets/historical/nasdaq100_2025q2-2026q1_v1 \
  --start 2025-04-01 --end 2025-04-03
pnpm bench verify --dir results/studies/astra-smoke
pnpm bench eval --eval-id astra-annual \
  --models pi/openai-codex/gpt-6-astra --concurrency=1 \
  --data-dir datasets/historical/nasdaq100_2025q2-2026q1_v1
```

Run from a clean, committed revision. Preserve this source, the installed Pi
package, Node, Bun, sandbox filter and dataset for resume/replay. Package contents,
Node binary, worker, exact catalog entry and reasoning setting are hashed into
the immutable runtime. Runtime drift requires a new cohort. All live attempts,
including failed smoke runs, must be preserved and published through results PRs.

Each day starts a fresh ephemeral CLI session. **Medium reasoning** is explicitly
pinned, matching this host's Pi setting at qualification. SSE is selected so every
request carries the complete audited context. Pi's automatic retries, compaction,
context-file discovery, extensions, skills, themes, prompt templates and built-in
coding tools are disabled. The only extension is the benchmark's four-tool bridge.
The v12 portfolio prompt replaces Pi's coding prompt. This is a different agent
client and prompt wrapper from OpenCode; label comparisons accordingly.

The host gateway uses `pi auth print-bearer-token` internally to refresh OAuth;
credentials are never printed to the benchmark log or passed into the sandbox.
The sandbox receives a synthetic JWT carrying only a session gateway capability.
Pi's native zstd request body is decoded with a 2 MiB output bound and checked for
the exact model, medium reasoning, prompt and tool schemas before forwarding to
the fixed Codex Responses endpoint. No API-key fallback is used.

Successful `submit_day` terminates the CLI. The gateway also refuses further
provider calls once a submission exists. Replay checks raw completed provider
responses, resolved model, token usage, tool arguments/results, original context,
sandbox state and the normal accounting/journal chain. Schema errors can be
corrected within an attempt; the host retains the existing two-attempt and
three-consecutive-invalid-day policy. Quota errors do not get hidden Pi retries.

Provider token counts are retained when present. **Subscription cost is unavailable**,
not a proven zero API price; the shared usage completeness field therefore remains
`unavailable` even when all token fields are measured.

`bun scripts/qualify-pi.ts` exercises the real CLI/sandbox with synthetic SSE and
zero live inference: success, schema correction, quota refusal, watchdog, and
rejection of tampered evidence. It requires the pinned local installation and a
configured Pi account, but replaces credential resolution and provider forwarding
for every fixture. Temporary diagnostic attempts are written under `/tmp`.

For a fresh cohort, `run` and `eval` accept `--pause-on-quota=true`. This freezes
`quota-pause-v1` in the configuration: explicit provider quota failures suspend
execution until the reported reset plus five minutes (or six hours plus five
minutes without a reset). The failed attempt still counts toward the two-attempt
limit. Resume uses the recorded policy; it does not retrofit older cohorts.
Serial evaluation stops admitting quarters while one is paused.

`scripts/astra-recovery.py` is the BB scheduled watchdog. Its external JSON config
pins the source checkout/revision, dataset, artifact directory, publication branch,
and cohort IDs. It qualifies a three-day smoke, runs the annual evaluation, replays
each settled checkpoint and publishes immutable audit checksums through a results
PR. It launches a supervised worker only after cooldown, avoids duplicate workers,
and pauses the automation after verified completion or an unexpected blocker.
Credentials remain in the existing host Pi account; configuration contains paths
and identities only. Keep the host and BB running for scheduled execution.

The adapter also accepts the explicit route `pi/openai-codex/gpt-5.6-sol`.
The selected model is pinned through catalog qualification, sandbox configuration,
gateway requests, provider responses and replay. Cross-model replay is rejected.
Use `bun scripts/qualify-pi.ts pi/openai-codex/gpt-5.6-sol` for the synthetic
real-client qualification (zero live inference).

`scripts/pi-sequence.py` coordinates separately pinned cohorts without changing
an existing run's implementation. Its `cohorts` list orders Astra before Sol.
Only a worker's verified, published completion advances the queue. On a quota
pause the coordinator re-arms the same BB automation with `--at` using the
recorded `notBefore` timestamp (provider reset plus the frozen five-minute buffer).
There is no recurring 15-minute poll. A systemd service supervises active work;
the machine and BB must remain available. Unexpected blockers stop the queue.

### User-confirmed early quota resets

A provider's recorded reset can become obsolete after the user resets their account
quota. `manual-quota-reset.json` authorizes skipping the wait only for listed,
already-recorded quota-failure hashes in one run. Later quota failures still pause;
failed attempts are never erased or refunded. This does not alter wall-clock time.

For an existing pinned cohort, the explicit user-requested scheduling-only
continuation is an exception to the ordinary new-cohort rule. Keep the original
manifest unchanged. A separate receipt binds the old and continued implementation
hashes, unchanged config/plan hash, and (for evaluation) both orchestrator hashes.
The guard rejects changes outside quota handling, its receipt validator, and the
runner's identity-check call. Trading/model/prompt/data/journal/accounting code and
sandbox binaries must remain identical. Publish both source identities, the user
reset authorization, prior artifact hashes and replay receipts; do not label the
continuation as having one unchanged implementation. Keep the old source checkout.
