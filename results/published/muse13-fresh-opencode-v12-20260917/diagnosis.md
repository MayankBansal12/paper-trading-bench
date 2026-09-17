# Live blocker and bounded diagnosis

The exact free route returned **HTTP 403 `FreeTierError`** on all six smoke
attempts. The provider message was: “OpenCode's free tier can only be used from
within OpenCode.” The genuine OpenCode 1.18.30 CLI was running in the qualified
sandbox, with requested and resolved model both
`opencode/muse-spark-1.3-contributor-free`.

Coverage: **0 valid / 3 invalid smoke days, 6 failed attempts**. No trading tool
calls, accepted submissions or annual sessions occurred. Tokens and measured cost
are unavailable, not zero. Refreshed catalog prices were zero. Smoke integrity
replay passed; live qualification failed.

The client-config, system-prompt and tool-definition audit files exist and attest
the exact model and four tools. The generic “Missing/failed sandbox client audit”
label is triggered by CLI exit code 1 after the provider refusal; it is not evidence
that the model identity audit was missing.

## Native metadata comparison

An offline fixture ran the same official pinned CLI and recorded incoming metadata
before gateway filtering and outgoing metadata at the provider boundary. It made
**zero provider calls**. All five identity fields matched exactly:

- `user-agent`: the native `opencode/1.18.30` value with its SDK/runtime suffix.
- `x-opencode-client`: `cli`.
- `x-opencode-project`, `x-opencode-session`, and `x-opencode-request`: actual native values.

The remaining differences are transport fields: host/connection/content length,
response compression disabled for audit capture, and replacement of the local
scoped capability with the existing host Zen credential. Code inspection confirms
the original request body is forwarded unchanged after validation.

The official [request builder](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/session/llm/request.ts)
and [stream handoff](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/session/llm.ts)
confirm the header construction. The v1.18.31 and current development builders
use the same identity headers. The [default plugin list](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/plugin/index.ts)
contains no separate Zen attestation plugin disabled by the harness. The
[official route documentation](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/web/src/content/docs/zen.mdx)
matches the exact `/zen/v1/responses` endpoint and OpenAI SDK adapter used.

No required native metadata loss was identified. The current provider enforcement
rejects this pinned gateway-mediated OpenCode client. Public sources do not
establish whether this is an eligibility restriction or a provider defect, or a
supported compatibility correction. **Provider-side acceptance or eligibility
clarification is required before another live qualification.** No client identity
was spoofed, credential switched, sandbox weakened, or alternate route attempted.

The terminal cohort and clean source `ab465d63ff8e34d63ad667315503d9e033f61fee`
remain unchanged. The supervisor has exited and no retry or annual launch is
scheduled. Any future runtime change requires a new clean source/cohort; this
terminal cohort must not be retried.

## Retained diagnostic attempts

One initial offline fixture failed before any request because its horizon argument
was incomplete. Its receipt is preserved. The corrected header fixture and the
full-metadata fixture both used synthetic responses with no provider calls and
confirmed the quota stop behavior. All outcomes, scripts and the exact
instrumentation patch are in the checksummed archives. The instrumented copy is
separate from the evaluation source.

Checks completed: typecheck; 325 Bun tests; 4 Python supervisor tests; exact route
catalog and sandbox qualification; 251-session dataset preflight; five historical
replays; failed smoke replay; native metadata equality. These passes do not
establish successful live model access.

[All checkpoint locations/checksums and provenance](provenance.json).
[Detailed metadata comparison](003-native-metadata-summary.json).
