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
