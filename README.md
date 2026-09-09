# PaperTrader

A deterministic, offline-reproducible batch benchmark for evaluating LLMs
(via the Pi SDK + opencode-go, e.g. `minimax-m3`, `deepseek-v4-pro`) on
financial decision-making over a fixed 50-ticker universe of US large-cap
equities.

See [PRODUCT.md](./PRODUCT.md) for the full spec, including what changed
from the original single-session baseline (`git log` has the phase history).

---

## Stack

- **Language:** TypeScript (strict, `noUncheckedIndexedAccess`)
- **Runtime:** Bun
- **Package manager:** pnpm — `pnpm-lock.yaml` is canonical; every dependency
  is pinned to an exact version
- **Agent harness:** Pi SDK — `@earendil-works/pi-coding-agent`
- **Market data:** local synthetic OHLCV fixtures (`fixtures/ohlcv/`) — no
  network calls at run time

---

## Quick start

```bash
pnpm install

# Generate the OHLCV fixtures (deterministic — same output every time).
# Already committed under fixtures/ohlcv/, only needed if you change
# scripts/generate-fixtures.ts or the universe.
pnpm run fixtures:generate

# Dry run with the offline, zero-token fake agent (no network, no cost):
pnpm run run -- --agent=fake --model=demo --start=2024-01-02 --end=2024-04-30

# Real run against an opencode-go model (network + paid tokens):
pnpm run run -- --model=minimax-m3 --start=2024-01-02 --end=2024-06-28
pnpm run run -- --model=deepseek-v4-pro --seed=2

# Compare every run under results/runs/:
pnpm run report

# typecheck / test (tests use only the fake agent — no network, no cost)
pnpm run typecheck
pnpm run test
```

### `run` flags

| Flag | Default | Meaning |
|---|---|---|
| `--model` | `minimax-m3` (or `fake` if `--agent=fake`) | opencode-go model id, or any label when `--agent=fake` |
| `--agent` | `pi` | `pi` (real Pi SDK session) or `fake` (deterministic offline rule agent) |
| `--seed` | `1` | A REPLICATE LABEL, not a model-sampling seed (the Pi SDK exposes no seed param) — isolates state on disk (same model, different seed, different run directory), does not make model output deterministic |
| `--start` / `--end` | full fixture range | Inclusive date batch (`YYYY-MM-DD`) |
| `--starting-capital` | `1000` | USD — the comparable benchmark requires `1000`; a different value still runs but `report` won't cohort it against `$1,000` runs |
| `--run-id` | derived from config | Override the deterministic run id (must be alphanumeric/`_`/`-`, no path separators); overrides only ever accept a monotonic `--end` extension, nothing else may differ |
| `--max-turns` / `--max-tool-calls` / `--timeout-ms` | `8` / `20` / `60000` | Per-day agent budget |

`run --help` / `report --help` print usage and exit without touching the
network or a run directory. Unknown flags and invalid values (non-finite
numbers, malformed dates, non-integer seed/limits) are rejected up front.

Re-running the exact same command resumes from the last completed day
instead of restarting — see "Resume & idempotency" in PRODUCT.md.

---

## Project layout

```
src/
├── index.ts                    # CLI router (run | report)
├── cli/
│   ├── run.ts                  # parses flags, builds RunConfig + agent, calls runBatch
│   ├── report.ts               # discovers/compares run summaries
│   ├── args.ts                 # minimal --flag=value / --flag value parser (handles pnpm's `--` separator)
│   └── validate.ts             # known-flag/positional/date/numeric flag validation
├── config/
│   └── universe.ts             # UNIVERSE_V1 — 50 tickers, frozen + versioned
├── domain/
│   └── types.ts                # every shared type (dependency-free)
├── data/
│   ├── ohlcv.ts                # as-of fixture loader — the no-look-ahead choke point (asOfBefore/openOn/closeOn)
│   └── indicators.ts           # SMA/RSI, pure functions of a bar window
├── engine/
│   ├── execution.ts            # order sizing/validation + fill (execution-price convention)
│   ├── portfolio.ts            # valuation, fill application, decimal flooring
│   ├── money.ts                # exact cents + supported money/unit domain
│   ├── sizing.ts               # integer-tick binary-search sizing
│   ├── calendar.ts             # resolves --start/--end against the fixture calendar
│   ├── metrics.ts              # return, drawdown, vol, Sharpe, turnover
│   └── baselines.ts            # cash + equal-weight buy-and-hold
├── agent/
│   ├── boundary.ts             # AgentPort — the fake/live seam
│   ├── fakeAgent.ts            # deterministic offline rule agent (tests + --agent=fake)
│   ├── piAgent.ts              # real Pi SDK + opencode-go wiring (loaded by CLI tests, never invoked)
│   ├── piSession.ts            # hermetic session builder — no ambient extensions, explicit tool allowlist
│   ├── tools.ts                 # 6 tools; bulk technical screen + queued orders, no D-open leak
│   ├── prompt.ts                # system + daily prompt for the real agent
│   ├── protocolVersion.ts      # AGENT_PROTOCOL_VERSION — folded into run identity
│   └── limits.ts               # TurnBudget — bounded turns/tool calls/time
├── run/
│   ├── state.ts                # canonical run identity, isolated paths, config guard + endDate extension
│   ├── lock.ts                 # one-writer-per-run-directory mutual exclusion
│   ├── day.ts                  # simulates one trading day (asof-before-D / exec-open-D / eod-close-D)
│   ├── persist.ts              # daily snapshot I/O + derived (rebuilt-not-appended) transactions.jsonl
│   └── orchestrator.ts         # the batch loop: resume, crash-recovery, checkpoint, true no-op, summarize
├── report/
│   └── compare.ts              # aggregates run summaries into JSON + markdown
└── utils/
    ├── paths.ts, dates.ts, errors.ts, fs.ts

scripts/
└── generate-fixtures.ts        # deterministic synthetic OHLCV generator

fixtures/ohlcv/                 # committed, generated fixture data (see README.md there)
tests/                          # bun:test — no network, no paid model calls; FakeAgent for pipeline
                                 # tests, plus offline hermetic-session (piSessionBoundary) and
                                 # real-subprocess CLI (cli.test.ts) tests
```

All source files stay under the 200 LOC soft / 300 LOC hard limit.

---

## How a batch run works

1. Resolve `--start`/`--end` against the fixture trading calendar.
2. Acquire an exclusive lock on the run directory
   (`results/runs/<model>/seed-<seed>/<runId>/`); load `state.json` if it
   exists (resume) or initialize a fresh one. `config.json`'s identity
   (model, seed, agent, dates, capital, universe, limits, execution
   convention, fixture version, protocol version) is validated against any
   new invocation — only a monotonic `--end` extension is allowed to differ.
3. Adopt any "orphan" `daily/<date>.json` left by a crash between that
   file's write and its `state.completedDates` commit, instead of
   re-simulating (and re-spending a real model call on) an already-decided day.
4. For each remaining date:
   - Build indicators/OHLCV strictly BEFORE D (no look-ahead of D's own bar).
   - Ask the agent (`AgentPort.decide`) what to do, under the day's turn/tool-call/time budget.
     The real Pi agent first receives all 50 as-of technical snapshots through one
     bulk `get_indicators()` call, then its `buy()`/`sell()` tools only QUEUE an
     `OrderRequest` — no price, fill, or portfolio mutation happens in-session.
   - Execute every queued order at D's OPEN, through `engine/execution.ts`,
     strictly AFTER the agent has committed to its whole day-D batch.
   - Mark-to-market at D's CLOSE; write `daily/<date>.json`, checkpoint `state.json`.
   - Stop early if net worth drops below 1% of starting capital.
5. Rebuild `transactions.jsonl` from the committed daily records (a pure,
   idempotent derivation — never appended, so a crash can never duplicate a fill).
6. Compute the equity curve, metrics, and both baselines over the full
   requested range; write `summary.json`.

## Testing without network or paid model calls

`tests/*.test.ts` (bun:test) exercise the as-of/as-of-before data loaders,
indicators, execution/sizing (including micro-order and conservation
invariants), metrics, baselines, the fake agent, `TurnBudget`/tool budget
gating, and the full orchestrator (fresh run, no-op idempotent re-run,
resume-from-checkpoint, endDate extension vs. shrink rejection, isolated
per-seed state, mismatched-config guard including limits, crash-recovery of
an orphan daily record, concurrent-write locking, bounded-stop propagation)
— entirely through `FakeAgent`. CLI subprocess tests load `agent/piAgent.ts`
through command wiring, but never instantiate it or make a paid model call;
the fake/live split (`agent/boundary.ts`) is what makes that possible.

```bash
pnpm run test
```

## Development

```bash
pnpm run typecheck
pnpm run test
pnpm run run -- --agent=fake --model=demo --end=2024-01-31   # fast, free smoke run
```
