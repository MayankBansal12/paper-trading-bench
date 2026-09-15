# April 2025–March 2026 evaluation

The benchmark evaluation launches four separate runs of each qualified model concurrently, one per calendar quarter. Use `pnpm bench eval` (also `pnpm study:run`). Dates are fixed, so neither command accepts `--start` or `--end`.

| Quarter | Evaluation dates | Sessions |
| --- | --- | ---: |
| 2025 Q2 | April 1–June 30, 2025 | 62 |
| 2025 Q3 | July 1–September 30, 2025 | 64 |
| 2025 Q4 | October 1–December 31, 2025 | 64 |
| 2026 Q1 | January 1–March 31, 2026 | 61 |
| Total per model | April 2025–March 2026 | 251 |

January 1 is a holiday; the last quarter's first decision is January 2. All exchange sessions must be present. Missing history or a truncated quarter aborts preparation for the entire model/quarter matrix before any inference or run artifact is created.

## Running and resuming

Supply a frozen historical dataset that covers every quarter and at least 100 price observations before April 1, 2025 for every selected security. All models receive the same dataset hash, dates, universe, history and policies. Historical price observations before a quarter remain available as warmup; simulated portfolio state and model memory never cross the boundary.

```sh
# Validate all four quarters without inference.
pnpm bench eval --eval-id apr2025-mar2026 --data-dir /path/to/frozen/year-dataset --preflight=true

# Execute the same schedule with a deterministic control, without remote inference.
pnpm bench eval --eval-id apr2025-mar2026-control --data-dir /path/to/frozen/year-dataset --control=true

# Execute every currently qualified model.
pnpm study:run --eval-id apr2025-mar2026 --data-dir /path/to/frozen/year-dataset

# Explicitly resume each child from only its own durable state.
pnpm bench eval --eval-id apr2025-mar2026 --data-dir /path/to/frozen/year-dataset --resume=true

# Replay all existing children and derive the report without inference.
pnpm bench eval --eval-id apr2025-mar2026 --data-dir /path/to/frozen/year-dataset --verify=true
```

Omit `--models` to run all three qualified routes, or pass a comma-separated subset. Unknown/unqualified routes are rejected, and there is no paid fallback. The model runtime checks the selected exact free route before inference. `--control=true` selects a separate control cohort and cannot produce model-labeled results.

The lower-level `bench run` command remains available for a single supplied environment/control/smoke window. It does not produce this annual evaluation. Do not pass a year-long range to it and reinterpret its continuous portfolio as independent quarters.

## Model-route qualification

| Exact route | Provider | Host authentication |
| --- | --- | --- |
| `opencode/muse-spark-1.3-contributor-free` | OpenCode Zen (`opencode`) | `OPENCODE_API_KEY` or official API-key auth entry |
| `opencode/muse-spark-1.2-contributor-free` | OpenCode Zen (`opencode`) | Same Zen credential |
| `openai/gpt-5.6-luna` | OpenAI (`openai`), Codex OAuth transport | OpenCode's host `openai` OAuth auth entry |

All routes require official client **1.18.30**, an exact model/provider/API ID match from `opencode models <provider> --verbose --refresh`, active status, tool-call capability, and explicit zero input, output, cache-read and cache-write prices with no pricing tiers. The Zen adapter additionally requires its free catalog name and exact Zen endpoint. Luna requires the official OpenAI adapter and its observed empty catalog API URL; the host gateway pins its OAuth destination to `https://chatgpt.com/backend-api/codex/responses`. The registry never treats a similarly named model or another provider as an equivalent route.

```sh
# Refresh and retain separate evidence JSON for every route, without inference.
pnpm model:preflight

# Qualify one route, optionally choosing the evidence filename.
pnpm model:preflight --model openai/gpt-5.6-luna \
  --out results/qualifications/luna-catalog.json

# Existing live smoke path, with explicit route selection (at most five sessions).
pnpm bench run --run-id luna-smoke --smoke=true --model openai/gpt-5.6-luna \
  --data-dir /path/to/frozen/dataset --start 2025-04-01 --end 2025-04-03

# Run only the requested qualified subset.
pnpm bench eval --eval-id two-models --data-dir /path/to/frozen/year-dataset \
  --models opencode/muse-spark-1.2-contributor-free,openai/gpt-5.6-luna
```

Catalog qualification makes **no inference calls**. Each artifact in `results/qualifications/` retains the version, command, attempt timestamps, output hashes and accepted catalog entry. Up to three catalog attempts expose transient omissions; missing or nonzero evidence fails closed. Runtime preparation repeats this check and writes fresh evidence. Committed catalog evidence is a dated observation, not a replacement for the runtime gate. Live smokes are a separate, explicitly invoked step; adding these routes did not run them.

All routes use default reasoning settings: no selected variant or reasoning-level override is supplied. The isolated client receives the freshly qualified catalog metadata, including OAuth pricing and limits. Config and per-request audits check the exact main/small/agent model, enabled provider, adapter, costs, tool capability, prompt and tool allowlist. Each child manifest freezes its selected route for resume.

### Host credentials and sandbox transport

For Zen, load the existing host `.env` containing `OPENCODE_API_KEY` or use the official `opencode` API credential in the host auth store. The prior plain Pi API-key entry remains supported. Credential values are never put in the client config or audit records.

For Luna, run `opencode auth login` on the host and select OpenAI's ChatGPT/Codex OAuth login if authentication is absent. The already authenticated host needs no additional API key. The broker reads `${XDG_DATA_HOME:-~/.local/share}/opencode/auth.json`, refreshes expired OAuth credentials on the host, and atomically persists rotated tokens with mode `0600`, preserving other provider entries. Benchmark refreshes are serialized across quarters/processes. Authentication or refresh failure stops forwarding; no paid API-key fallback is available for OAuth-qualified pricing. An API-key route would require its own fresh zero-cost qualification; an `OPENAI_API_KEY` alone cannot substitute for this OAuth route. See [OpenAI authentication](https://learn.chatgpt.com/docs/auth) and the [pinned OpenCode OAuth implementation](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/plugin/openai/codex.ts).

The isolated home receives a synthetic OAuth record containing a session-scoped gateway capability and a noncredential refresh marker. This selects the official OAuth request format without copying host access/refresh tokens. `OPENAI_API_KEY` inside that sandbox also holds only the capability; Zen uses `OPENCODE_API_KEY` the same way. Default auth plugins remain disabled. The worker can contact only its Unix-socket gateway, which inserts the real credential in host-side outbound headers. The gateway restricts Luna to the Responses endpoint and the selected exact model. The OAuth transport preserves the official client's output-token setting without changing reasoning defaults or prompt text.

Refresh errors omit response bodies and credential values. If a killed process leaves `auth.json.bench-refresh.lock`, confirm no benchmark refresh is active before removing that lock; it contains no credential. Host OAuth credentials are never mounted into the sandbox, written into `results/`, logged, or committed. The implementation and authentication tests are offline and use synthetic credentials; live inference compatibility still requires a separately authorized smoke.

## Isolation and funding

Each model/quarter is a distinct run with its own run ID, directory, immutable manifest, event chain and daily commit chain. The same model has four runs active in parallel; each run processes its own trading sessions chronologically. All selected models are scheduled together: three models × four quarters gives 12 concurrent jobs. Every run starts independently with:

- $50,000 cash, no positions or cost bases.
- Empty journals and decision history, fresh attempt counters and zero consecutive failures.
- Its own model runtime and daily isolated client sessions.
- $50,000 deposits on the first exchange session of its second and third months.

No ending balances, P&L, holdings, evidence receipts, journals or failures are supplied to another child. Only that child's own state is restored during explicit resume. A stopped/failed quarter does not stop or delay its concurrently running peers. A new evaluation refuses pre-existing child directories; configuration, data or implementation drift requires a new evaluation ID.

Quarter-end positions remain marked at the closing price for that quarter's result. There is no forced liquidation: every other quarter already has its own independently initialized account.

## Reports and completion

`results/evaluations/<eval-id>/manifest.json` freezes the complete plan, child identities, funding, implementation and orchestration hash before the first child runs. `summary.json` is a derived report updated as each child finishes, retaining chronological quarter order regardless of completion order. Report writes are serialized to prevent concurrent runs from overwriting each other. The evaluation lock stays held until all selected model/quarter runs and their report writes settle. Full prompts, decisions, tools, journals and accounting remain in the separate `results/studies/<child-run-id>/` directories. Existing review and verification commands work on each child.

Quarter rows retain completion, valid/invalid/retried/unattempted coverage, contribution-adjusted TWR, drawdown, turnover, fills, rejections and closing portfolio. All four fully funded quarters receive $600,000 per model. Year reporting sums their ending equities and profits, reports profit divided by contributed capital, and labels the arithmetic mean quarterly TWR. It never compounds the independent account balances or presents them as a continuous annual equity curve.

If any quarter is missing, errored, stopped or incomplete, the year score is `null`; completed quarter results remain visible. A fully accounted quarter may contain explicit invalid decision days under the existing two-attempt/three-consecutive-invalid-day policy.

## Historical-data readiness

The previous `muse-spark-free-2026-full` run was a single continuous January 2–August 31, 2026 environment study. It did not complete four quarters and is not a result for this evaluation.

Its retained dataset, `datasets/historical/nasdaq100_2026q1-q3_v1`, starts coverage on April 1, 2025 and has no earlier warmup bars. It fails the new preflight. None of the retained datasets currently covers the required April 2025 start with its preceding history; a new frozen dataset is required before a model rerun. Do not shorten the evaluation, fabricate price history or silently drop securities to get past this guard.

The environment's frozen supported-security universe does not establish membership as of each historical quarter. Complete pre-quarter membership/reference qualification remains a separate requirement for scored Nasdaq-100 comparisons, enforced by `bench qualify`. This launcher does not claim that eligibility.
