# PaperTrader v0 — Implementation Notes

Phases 1–8 (see `git log`) built a single-session live baseline. This pass
("v0 batch rework") replaced most of that with a deterministic offline
batch benchmark per the v0 requirements — see PRODUCT.md for the "what
changed and why" narrative; this file tracks what was actually done and what
is intentionally deferred.

## What this pass built

| Area | Files | Notes |
|---|---|---|
| Universe | `src/config/universe.ts` | 50 tickers, frozen + versioned (`UNIVERSE_V1`) |
| Fixtures | `scripts/generate-fixtures.ts`, `fixtures/ohlcv/*.json` | Deterministic synthetic OHLCV, seeded PRNG — see fixtures README |
| Data | `src/data/ohlcv.ts`, `src/data/indicators.ts` | As-of loading (no look-ahead), SMA/RSI |
| Engine | `src/engine/*.ts` | Execution/sizing, valuation, calendar, metrics, baselines |
| Agent boundary | `src/agent/boundary.ts`, `fakeAgent.ts`, `limits.ts` | Fake/live seam; tests only touch the fake side |
| Real agent | `src/agent/piAgent.ts`, `piSession.ts`, `tools.ts`, `prompt.ts` | Pi SDK + opencode-go, 6 tools (no news/web), hermetic session |
| Run orchestration | `src/run/*.ts` | Isolated per-model/seed/run state, resume/idempotency, bounded per-day budget |
| Reporting | `src/report/compare.ts`, `src/cli/*.ts` | JSON + markdown comparison across runs |
| Tests | `tests/*.test.ts` | bun:test, FakeAgent + fixtures only — no network, no paid calls |

Removed entirely: the news/web search tool and `news/search.ts`, the
`yahoo-finance2` live-fetch price layer, the single shared
`portfolio-state.json`/`transactions.txt` files, and the daily-markdown
"weekly summary" memory mechanism (replaced by structured `daily/<date>.json`
records + a bounded window of recent days passed directly in the decision
context).

## Verification performed

- `pnpm run typecheck` (`tsc --noEmit`, strict mode): passes, 0 errors
- `pnpm run test` (`bun test`), as of round 6 (current — see that section
  below for what changed most recently): 149 tests / 0 failures, 3,389
  expectations, across 12 files — no-look-ahead data loading, indicator
  determinism, execution/sizing edge cases (insufficient cash, no shorting,
  weighted avg cost, cent-ledger conservation properties, safe-range
  defensive bounds), metrics (flat/rising/drawdown curves, finite-metric
  boundary checks), baselines, FakeAgent determinism + budget enforcement,
  offline Pi-session hermeticity, real-subprocess CLI behavior, and full
  orchestrator behavior (fresh run, idempotent re-run, resume-from-checkpoint
  mid-batch, isolated per-seed directories, mismatched-config guard,
  bounded-stop propagation into run metrics). This count has grown with each
  correction round below — see each round's own "Verification performed" for
  the count at that point in time.
- Manual smoke run (round 1): `pnpm run run -- --agent=fake --model=demo --start=2024-01-02 --end=2024-04-30`
  → 86 days, 51 trades, 18 rejected orders (insufficient cash under the
  fake agent's fixed 10%-of-cash sizing), reasonable-looking equity curve
  and baselines; `pnpm run report` aggregated it into a markdown table
- `wc -l` audit (current): no **source** file exceeds 300 lines — largest is
  `src/run/orchestrator.ts` at 231 lines. The 300-line limit is scoped to
  `src/` (see README.md); `tests/*.test.ts` are not subject to it and several
  now run longer (e.g. `tests/orchestrator.test.ts`, `tests/execution.test.ts`)
- No live Pi/opencode-go model calls were made anywhere in this pass —
  every run and test used `--agent=fake` / `FakeAgent`

`agent/piAgent.ts` itself was NOT exercised end-to-end (that would require
network access + paid tokens, excluded per the task constraints). It
typechecks and follows the same session-wiring pattern as the original
baseline's `agent/session.ts` (which was verified working in phase 6-8), but
a real run against `minimax-m3` / `deepseek-v4-pro` is the first thing to do
before trusting it in production.

## Deliberately out of scope for this pass

- **Real historical market data.** Fixtures are synthetic. Swapping in a
  real dataset only requires replacing `fixtures/ohlcv/*.json` — see the
  fixtures README — but sourcing/licensing one wasn't attempted here.
- **A real `--agent=pi` end-to-end run.** See above — paid model calls stay
  excluded from this pass. This is the ONLY thing that stays untested: the
  budget/limit/error-handling LOGIC itself (turn/tool-call caps, a
  non-cooperative agent hammering tools past the cap, budget vs. real-failure
  classification) is proven offline against a mocked `PiWorkingState`/tool
  harness (`tests/limits.test.ts`) — it is not "unverified robustness," it's
  robustness verified without spending a token.
- **CI wiring.** `pnpm run typecheck` / `pnpm run test` exist as scripts but
  aren't wired into a CI workflow file.
- **More than 2 opencode-go models pinned by name anywhere** — the CLI
  accepts any model id; only `minimax-m3` and `deepseek-v4-pro` were
  mentioned by name per the task, and neither was actually invoked (see
  above).

## Round 2 corrections (this pass)

An independent review of the first pass found four P0 defects (see
PRODUCT.md for the corrected behavior in each area) that are fixed here:

1. **Same-close execution leakage** → causal convention fixed: decisions use
   bars strictly before D, orders fill at D's open, EOD valuation at D's
   close, applied consistently to agent context, execution, termination, and
   the buy-and-hold baseline (`src/engine/execution.ts`, `src/run/day.ts`,
   `src/agent/tools.ts`, `src/engine/baselines.ts`). Sentinel tests in
   `tests/day.test.ts` prove D's own bar is withheld from decision context.
2. **Run identity/mutability** → `deriveRunId` now folds in `limits`, the
   execution convention, and the fixture version; a run directory is
   immutable except for a strictly-validated monotonic `--end` extension
   that rewrites `config.json`; `--run-id` is sanitized and asserted to
   resolve under `results/runs/`; an unknown `--model` fails loudly instead
   of silently substituting a different opencode-go model; `--seed` is
   documented as a replicate label, not a sampling seed.
3. **Crash-idempotency** → a run directory is now single-writer
   (`src/run/lock.ts`); an orphaned `daily/<date>.json` (written but not yet
   committed to `state.completedDates`) is adopted on resume instead of
   re-simulated; `transactions.jsonl` is derived/rebuilt from committed daily
   records every invocation instead of appended, so it can never duplicate a
   fill; a no-op rerun of a completed run no longer rewrites `state.json`.
4. **Fractional accounting conservation** → a fill below a $0.01 minimum
   notional is rejected instead of moving shares for ~$0; buy-and-hold is
   routed through the same `executeOrder`/`applyFill`/`valuePortfolio` engine
   agents use; an out-of-universe order becomes a `FailedOrder` centrally in
   `run/day.ts` instead of throwing and aborting the batch.

Also addressed: `PiAgent` now propagates real session failures (auth,
unknown model, unexpected SDK errors) instead of recording them as a
successful bounded-stop day, and disposes its session in a `finally`;
`TurnBudget`'s turn/tool-call caps were off-by-one (one turn short of
advertised, and a hammering agent could push `usage.toolCalls` past the
cap) — both fixed; a real Pi tool rejection now reaches
`DailyRecord.failedOrders`; `run --help` / `report --help` no longer fall
through to a live run; unknown flags and invalid values are rejected;
`report` groups runs into comparable cohorts (universe, fixture, execution
convention, date range, capital, limits) instead of presenting arbitrary
runs side by side; docs corrected (6 tools not 5, no byte-identical-state
overclaim, no "robustness unverified" overclaim).

## Round 3 corrections (this pass)

An independent review of round 2 found six more defects (two P0, four P1),
fixed here:

1. **Ambient/extension leakage into the real agent session** → `PiAgent`
   now builds its session exclusively through
   `agent/piSession.ts`'s `createHermeticAgentSession()`, which disables all
   ambient resource discovery (project/user extensions, skills, prompt
   templates, context files) and passes an explicit 6-name tool allowlist to
   `createAgentSession({ tools })`, instead of constructing
   `DefaultResourceLoader`/`createAgentSession` inline with only
   `noTools: "builtin"` (which still resolves ambient extensions and
   auto-activates their tools). `tests/piSessionBoundary.test.ts` proves an
   injected/ambient extra tool is neither registered nor active, offline.
2. **D-open price leakage** → `agent/tools.ts`'s `buy()`/`sell()` now only
   QUEUE an `OrderRequest` — no price, no fill, no portfolio mutation
   in-session — and `DecisionContext` no longer carries `executionPrices` at
   all (`domain/types.ts`); every order (fake or real agent) executes in
   `run/day.ts`, strictly after `decide()` returns for the whole day.
   Adversarial sentinel tests in `tests/limits.test.ts` prove `get_portfolio`
   never reflects an order queued earlier in the same session.
3. **`pnpm run run -- ...` / `pnpm run report -- ...` failing on the literal
   documented command** → `cli/args.ts#parseFlags` now drops exactly one
   leading `--` separator (pnpm forwards it as a literal argument; npm
   strips it) instead of parsing it as an unknown empty-named flag, and
   returns positionals separately so stray non-flag arguments are rejected
   instead of silently ignored. `tests/cli.test.ts` runs the exact
   documented `pnpm run run -- ...` / `pnpm run report -- ...` invocations
   as real subprocesses.
4. **Format-only date validation** → `cli/validate.ts#parseDateFlag` now
   round-trips through `Date.UTC` to reject impossible calendar dates (e.g.
   `2024-99-98`, `2024-02-30`, `2023-02-29`), and
   `engine/calendar.ts#resolveDateRange` throws with the available date
   range when the requested window doesn't intersect the fixture calendar at
   all, instead of silently producing a completed zero-day run.
5. **Metrics not seeded with starting capital** → `engine/metrics.ts`
   treats `startingCapital` as the pre-first-day equity point for both
   drawdown and daily-return calculations, so a first-day loss now shows up
   in `maxDrawdownPct`, not just `totalReturnPct`; buy-and-hold `tradeCount`
   now reflects actual accepted fills (`engine/baselines.ts`), not
   `universe.length`.
6. **Wall-clock budget not covering the whole decision, tool-cap abort
   cutting off the model's final rationale** → `PiAgent.decide()` now bounds
   hermetic session setup AND `session.prompt()` against one shared deadline
   (`TurnBudget.deadlineAt()`); the `turn_start` session-abort check now uses
   `TurnBudget.exceededExcludingToolCalls()`, which deliberately excludes the
   tool-call cap, so a model that used exactly N tool calls can still finish
   that turn with its rationale — only the actual (N+1)th tool call is
   refused, by `budgetGate` in `agent/tools.ts`.

Also addressed: `RunConfig.protocolVersion` (agent-facing tool/prompt/
harness semantics — `agent/protocolVersion.ts`) is now folded into
`deriveRunId`, the config-compatibility guard, and report cohorting, so a
protocol-changing code edit can never resume into or mix into an existing
run directory's data; `FIXTURE_VERSION` is now a content hash of every
fixture file's actual bytes (`data/ohlcv.ts`) instead of a manually-bumped
label, so it can never silently go stale; a no-op rerun of a completed run
now returns the existing `summary.json` verbatim instead of re-deriving and
rewriting `transactions.jsonl`/`summary.json` on every invocation; `report`
now surfaces `failedToolCalls` per run; PRODUCT.md's stale "no overnight
gap — execution price is the as-of close" claim and its description of
`asOf()` (rather than `asOfBefore()`) as the decision-context choke point
are corrected.

### Verification performed (round 3)

- `pnpm run typecheck`: passes, 0 errors
- `pnpm run test`: 109 tests / 0 failures across 12 files, including a new
  offline hermetic-session boundary test
  (`tests/piSessionBoundary.test.ts`) and real-subprocess CLI tests
  (`tests/cli.test.ts`) that run the exact documented `pnpm run run -- ...`
  / `pnpm run report -- ...` invocations
- `wc -l` audit: no source file exceeds 300 lines

## Rounds 4–5 corrections

No standalone notes were kept for these two passes (a gap this update
doesn't attempt to reconstruct in full) — what's below is inferred from the
surviving code/test comments, for continuity with round 6 below. The bulk of
the work was a cent-ledger overhaul in `engine/execution.ts`/`engine/
portfolio.ts`:

1. **A same-price buy/sell round trip could manufacture a $0.01 of cash from
   nothing.** The v1 rule floored each fill's own notional to cents while the
   aggregate position `.value` rounded to nearest — two independent rounding
   boundaries that could each drift by a cent per fill. The v2 rule (current)
   defines a fill's cash transfer as the CHANGE in the position's own
   `round2(units * price)`, the exact same computation `applyFill()` uses for
   the stored `.value` — so cash + holdings value at the fill price is
   conserved to the cent on every fill, not just approximately. `EXECUTION_CONVENTION`
   was bumped to its `_v2` suffix so a v1-derived run directory can never
   resume under v2 semantics (see `tests/orchestrator.test.ts`'s
   `executionConvention` guard tests). Regression:
   `tests/execution.test.ts`'s "round 5's $0.01 arbitrage" test.
2. **`floorUnits` could shave a dust unit off an already-quantized 6dp
   value** (e.g. `floorUnits(0.000249)` losing precision), which could leave
   an unsellable dust remainder when re-flooring a persisted holding's own
   unit count. Fixed with a small epsilon before flooring. Regression:
   `tests/execution.test.ts`'s `floorUnits(0.000249)` test.
3. **A sub-cent notional BUY could fill for more than its budget** (e.g. a
   $0.015 order at $100/share). Fixed by flooring the requested notional to
   a whole-cent budget before sizing units against it. Regression:
   `tests/execution.test.ts`'s "$0.015 BUY" test.

### Verification performed (rounds 4–5, reconstructed)

Not independently reproducible from this pass alone; current combined
suite state is reported under round 6 below.

## Round 6 corrections (this pass)

An independent review found four more defects (one P0, three P1), fixed
here:

1. **Starting capital wasn't bound-checked on its NORMALIZED value.**
   `cli/run.ts` validated the raw `--starting-capital` as positive/finite,
   then applied `round2()` — so `0.001` (positive/finite raw, but rounds to
   $0) was accepted and silently logged as capital 0, turning every
   downstream percentage metric into `NaN`; `1e307` rounded to `Infinity`;
   and a merely-finite value like `1e306` could drive `engine/execution.ts`'s
   `maxBuyTicks`/`maxSellTicks` binary search toward a non-terminating
   `Infinity` upper bound. Fixed by rounding FIRST, then bound-checking the
   normalized value against a new documented safe range
   (`MIN_MONEY_USD`/`MAX_MONEY_USD`, `engine/portfolio.ts`), plus defensive
   finite/safe-bound checks inside `executeOrder` itself so no
   programmatically-constructed config/order can hang regardless of what
   validation ran upstream. Regressions: `tests/cliValidate.test.ts`'s
   normalize-then-bound suite, `tests/cli.test.ts`'s subprocess tests
   (rejected before any run directory is created), `tests/metrics.test.ts`'s
   finite-at-the-boundary tests, `tests/execution.test.ts`'s defensive
   safe-range suite.
2. **The whole-cent BUY budget wasn't what got checked against cash.**
   `executeOrder` compared the raw pre-floor `order.sizing.usd` to
   `portfolio.cash`, contradicting the cent-ledger rule (rounds 4–5) that a
   notional request is first reduced with `floorCents` — so a $10.009
   request with exactly $10.00 cash was rejected even though its actual
   budget ($10.00) would fill in full. Fixed by computing the floored budget
   once and checking THAT against cash. This is part of the same
   accepted-fill semantics the rounds 4–5 overhaul already labeled
   `EXECUTION_CONVENTION`'s `_v2` suffix for (this working tree was never
   committed at an intermediate state where `_v2` shipped without this fix,
   so no further bump was needed) — `tests/orchestrator.test.ts`'s existing
   `_v1`-vs-`_v2` run-id/resume incompatibility tests still cover it.
   Regressions: `tests/execution.test.ts`'s `$10.009`/`$10.01` pair.
3. **`usage.turns` could exceed the advertised `maxTurns` cap.**
   `PiAgent`'s `turn_start` handler called `TurnBudget.recordTurn()`
   unconditionally, THEN checked whether the budget was exceeded — so the
   refused (N+1)th turn was still counted before being refused. Fixed with
   `TurnBudget.admitTurn()`, a gate-then-record method (mirroring
   `agent/tools.ts`'s `budgetGate` pattern for tool calls) that returns
   `false` without incrementing `turns` for a refused turn; `piAgent.ts`'s
   handler now checks `admitTurn()` first and only evaluates the
   timeout/turn-exceeded reason for an admitted turn. This changes the
   agent harness/usage contract, so `AGENT_PROTOCOL_VERSION` was bumped to
   `v3-gated-turn-accounting`. Regression: `tests/limits.test.ts`'s
   `admitTurn` hammering test (not exercised by an end-to-end `piAgent.ts`
   test, which would require network/paid tokens — same limitation as
   round 3's item 6).
4. **A setup that timed out could still leak its session.**
   `withTimeout(createHermeticAgentSession(...))` bounds the CALLER's wait,
   not the underlying setup work — if setup resolved with a live session
   AFTER the caller had already given up and returned a bounded result, that
   session never reached the `finally { session.dispose(); }` block (which
   only runs for a session `decide()` actually received). Fixed with
   `withTimeoutAndLateCleanup()` (`agent/limits.ts`), which attaches a
   fallback disposer to the setup promise so a late-resolving session is
   disposed via that hook instead of leaking. PRODUCT.md's "the Pi session
   is always disposed" claim, which was false in exactly this window, is now
   accurate again. Regressions: `tests/limits.test.ts`'s on-time/late-resolve/
   late-reject `withTimeoutAndLateCleanup` tests.

Also fixed in the same pass: `executeOrder`'s BUY branch had a real
`tsc --noEmit` type error (`order.sizing.usd` accessed where TypeScript
couldn't narrow `order.sizing` to the `"notional"` variant across the
`notionalBudget !== null` check) — restructured to narrow inside an explicit
`if (sizing.kind === "notional")` block instead of relying on a derived
nullable local.

### Verification performed (round 6)

- `pnpm run typecheck`: passes, 0 errors
- `pnpm run test`: 149 tests / 0 failures, 3,389 expectations, across 12
  files
- `wc -l` audit: no source file exceeds 300 lines; largest is
  `src/run/orchestrator.ts` at 231 lines

## Round 7 corrections (this pass)

An independent review found one more defect (P0), fixed here:

1. **`MIN_MONEY_USD`/`MAX_MONEY_USD` were each individually safe, but their
   CROSS-PRODUCT wasn't.** Round 6 bounded price and cash/notional/starting
   capital each independently to `[MIN_MONEY_USD, MAX_MONEY_USD]` =
   `[$0.01, $1e9]`, reasoning that this kept `maxBuyTicks`/`maxSellTicks`'
   `capBudget / (price * TICK)` binary-search bound far below double
   overflow (`Infinity`). It does — but overflow isn't the only failure
   mode: once that bound exceeds `Number.MAX_SAFE_INTEGER` (2**53-1 ≈
   9.007e15) without actually overflowing, `lo`/`hi`/`mid` stop being exact
   integers, `Math.floor((lo+hi)/2)` can equal an existing endpoint, and the
   search stalls without ever narrowing to `hi - lo <= 1` — a silent hang,
   not a thrown error. The reviewer's reproduction: a BUY at
   cash/notional=`$1e9`, price=`$0.01` (`hi` ≈ `1.00000000002e17`, ~11x over
   the safe-integer ceiling) and a SELL from `1e11` held units at
   notional=`$5e8`, price=`$0.01` (`maxSellTicks`' `heldTicks` has the same
   defect) both hung past a 3s `timeout`. Fixed by narrowing the domain
   rather than the arithmetic: split the price floor out of `MIN_MONEY_USD`
   into a separate, tighter `MIN_PRICE_USD` (`$1.00` — engine/portfolio.ts),
   and added a defensive `MAX_UNITS` ceiling (`1e9`) checked against
   `existingUnits` in `executeOrder` before either sizing path runs, since
   held units come from persisted/resumed state (or a directly-constructed
   `PortfolioState`), not from any CLI-validated input, and can't be bounded
   upstream the way price/cash/notional are. At those bounds the worst-case
   `hi` is ~`1.0e15` for BUY and ~`1.0e15` for SELL — both ~9x under the
   safe-integer ceiling. `MIN_PRICE_USD=$1.00` doesn't affect real runs: the
   fixture universe's minimum price (`IBM`) is `$20.17`. Also added an
   internal `assertSafeSearchBound()` canary inside `maxBuyTicks`/
   `maxSellTicks` themselves (throws if a future caller ever reaches them
   with an unsafe bound) as defense-in-depth beyond `executeOrder`'s
   caller-side validation. `MIN_PRICE_USD`/`MAX_UNITS` are validation-domain
   changes, not fill-arithmetic changes, so `EXECUTION_CONVENTION` was NOT
   bumped — the cent-ledger rule and `_v2` fill semantics are unchanged;
   only the previously-accepted-but-hang-prone price/held-units range
   shrank. Regressions: `tests/execution.test.ts`'s new "paired-extrema
   safe-range checks (round 7)" suite — BUY and SELL at/near
   `MIN_PRICE_USD`/`MAX_UNITS`/`MAX_MONEY_USD`, the reviewer's two exact
   reproductions (now rejected, not hung), and corrupted-holdings cases
   (negative units, units past `MAX_UNITS`) — every test in that suite
   carries an explicit 3s Bun test timeout so a reintroduced hang fails
   that test instead of hanging the whole suite.

### Verification performed (round 7)

- `pnpm run typecheck`: passes, 0 errors
- `pnpm run test`: 157 tests / 0 failures, 3,412 expectations, across 12
  files (up from 149/3,389 in round 6 — 8 new regressions, no prior test
  changed behavior)
- `wc -l` audit: no source file exceeds 300 lines; largest is
  `src/engine/execution.ts` at 264 lines
- Manually re-ran the reviewer's two literal reproductions (BUY at
  cash/notional=`$1e9`, price=`$0.01`; SELL from `1e11` held units at
  notional=`$5e8`, price=`$0.01`) under the fixed code: both return
  immediately with a `failed` result instead of hanging past 3s.

## Round 8 correction (this pass)

An independent review found one more defect (P0), fixed here:

1. **`MAX_UNITS` was checked as a PRECONDITION on a position's existing
   units, never as an INVARIANT on the RESULTING units of an accepted BUY.**
   Round 7 reasoned that `MAX_MONEY_USD / MIN_PRICE_USD` was a "natural
   ceiling" a real run's fill math could never cross, so `MAX_UNITS` only
   needed checking against `existingUnits` before sizing ran. That reasoning
   missed `maxBuyTicks`' own cent-rounding slack: a fill's transfer can round
   up to $0.01 above its true cost, so its binary search — bounded only by
   budget — could accept a tick count whose resulting holding lands past the
   ceiling it was supposed to respect. Reviewer's minimal repro:
   `createInitialPortfolio(MAX_MONEY_USD)`, then a notional BUY of
   `MAX_MONEY_USD` at `MIN_PRICE_USD` — `maxBuyTicks` returned a tick count
   whose holding was `1,000,000,000.004999` units, ~0.005 past
   `MAX_UNITS=1e9`; `applyFill` persisted it; a subsequent one-unit SELL then
   failed with "held units ... outside the supported safe range," an
   otherwise-valid position the engine itself had made unsellable. Fixed in
   `engine/execution.ts`: `maxBuyTicks`' binary search is now ALSO bounded by
   the position's remaining `MAX_UNITS` headroom (`unitsHeadroomTicks`, both
   as a cap on `hi` and as an explicit per-candidate condition in the loop —
   capping only `hi` would still let an earlier, budget-only `mid` above the
   headroom be accepted), which caps a notional BUY at the ceiling instead of
   overshooting it. A units-sized BUY has no search to bound, so it's
   rejected outright (`newUnits > MAX_UNITS`) instead. This check runs for
   BOTH sizing paths on the RESULTING holding, not just as a precondition on
   the pre-fill one. `engine/portfolio.ts`'s `MAX_UNITS` comment was revised:
   it no longer claims capital/price bounds alone prove the resulting unit
   count stays under the ceiling — they bound the search's input domain
   (representability/termination), not its output. This changes which BUYs
   are ACCEPTED (and what they fill for) at the extreme
   price/capital/held-units boundary — not just which are rejected — so
   `EXECUTION_CONVENTION` was bumped to `_v3` (round 7's `MIN_PRICE_USD`/
   `MAX_UNITS` changes narrowed only the REJECTED input range and did not
   bump it; this changes ACCEPTED-fill quantities, the same category of
   change rounds 4–5's cent-ledger overhaul bumped for). `PRODUCT.md` gained
   a paragraph on the `MAX_UNITS` invariant and its `_v3` history.
   Regressions: `tests/execution.test.ts`'s round 7 boundary test now also
   asserts `after.holdings.AAPL.units <= MAX_UNITS` and that a follow-up
   one-unit SELL succeeds (this is the exact reviewer repro — it fails
   without the fix), plus three new tests: a units-sized BUY that would
   cross the ceiling from a near-ceiling position (rejected), a notional BUY
   into a near-ceiling position (capped to the remaining headroom, not
   rejected), and an empty-portfolio units-sized BUY at exactly `MAX_UNITS`
   (accepted) vs. one unit past it (rejected) — all four confirmed to fail
   against the pre-fix code before being confirmed to pass against the fix.
   Inspected `maxSellTicks`/the SELL path for the same pattern: no
   equivalent defect — `maxSellTicks` already bounds `mid <= heldTicks`
   (selling more than held is structurally, not just budget-, infeasible),
   so it cannot produce a negative or over-held resulting position the way
   the BUY path could exceed `MAX_UNITS`.

### Verification performed (round 8)

- `pnpm run typecheck`: passes, 0 errors
- `pnpm run test`: 160 tests / 0 failures, 3,425 expectations, across 12
  files (up from 157/3,412 in round 7 — 3 new tests, 1 existing test
  strengthened, no other test changed behavior)
- `wc -l` audit: no source file exceeds 300 lines; largest is
  `src/engine/execution.ts` at 298 lines (up from 264 in round 7 — the file
  was trimmed for line budget after the fix landed, by tightening comment
  verbosity, not by cutting the fix's logic or its documentation of intent)
- Reverted the fix locally (keeping the new tests) and reran the suite to
  confirm all four round-8 assertions fail against the pre-fix code, then
  restored the fix and confirmed 160/160 pass again — the regressions
  actually exercise the defect, not just assert coincidentally-true facts.

## Round 9 correction (this pass)

An independent review found one more defect (P0), fixed here:

1. **`valueDelta` computed `round2(newUnits * price) - round2(existingUnits
   * price)` in plain floating-point doubles — subtracting two large,
   independently-rounded dollar values, which suffers catastrophic
   cancellation and need not itself land on a whole cent even when both
   position values conceptually are.** Reviewer's minimal repro:
   `createInitialPortfolio(MAX_MONEY_USD)`, BUY exactly 50,000,000 units at
   $20 (fills for exactly $1,000,000,000), then SELL 0.001 units at $20 —
   the position-value delta is a true $0.02, but the pre-fix code returned
   `fill.notional = 0.019999980926513672` while `cashAfter = 0.02`, so
   `Fill.notional` was not the cash actually moved and a fractional-cent
   value got persisted to transactions, breaking the documented whole-cent
   invariant. Worse cross-products existed too: `MAX_UNITS` held at
   price $100,000, selling one 1e-6 tick returned `$0.09375`
   (`cashAfter=$0.09`) instead of the exact $0.10 tick value; at price
   `MAX_MONEY_USD` ($1e9) the same tick returned $768 instead of the exact
   $1,000. Root cause: `round2(n) = Math.round(n*100)/100` is only
   cent-exact up to `n*100 < 2**53` (~9.007e15) of headroom in the RESULT,
   but the deeper problem is that `round2(units * price)` for a
   near-`MAX_UNITS` position needs ~20 significant decimal digits to stay
   exact, and a double carries only ~15-17 — the rounding error is baked in
   before the two `round2()` outputs are ever subtracted.

   Fixed by computing position values in exact integer cents via BigInt
   instead: `positionValueCents(units, price)` (new, `engine/portfolio.ts`)
   decomposes `price` into its exact IEEE754 bit-level rational value (every
   finite double is exactly `mantissa * 2**exponent`, so this is lossless
   regardless of how many decimal digits the price "looks like" it has —
   needed because `executeOrder`'s price convention is agnostic, and tests
   legitimately pass non-2dp prices like 33.333333) and snaps `units` to its
   exact intended micro-unit tick count (`Math.round(units * 1e6)`, an exact
   integer for any unit count up to `MAX_UNITS` — units is always already
   tick-grid-snapped by `roundUnits`/`floorUnits`, but the double that
   division returns can itself carry a tiny representational error near
   `MAX_UNITS` that reading it bit-exactly would reproduce instead of
   recovering the intended tick count). `valueDelta` (moved to the new
   `engine/sizing.ts` — see line-budget note below) now subtracts these two
   BigInt cent values BEFORE ever converting to a `number`; the conversion
   back happens only on the final delta, which is exact for every value this
   is called with on an ACCEPTED fill (bounded by portfolio cash <=
   `MAX_MONEY_USD` = 1e11 cents, ~80,000x under the ~9.007e15-cent point
   where `BigInt`->`Number` stops being exact, regardless of how large the
   underlying position values being subtracted are). `applyFill` and
   `valuePortfolio` (`engine/portfolio.ts`) — which had the SAME
   `round2(units * price)` pattern for a position's stored `.value`, just
   without the subtraction that made the bug user-visible — were switched to
   the same exact helper (`positionValue`) so a fill's cash movement and the
   resulting holdings-value movement stay the identical number at any scale,
   not just at the scale where `round2` happens to still be exact.
   `engine/baselines.ts` needed no change: it already routes buy-and-hold
   through the same `executeOrder`/`applyFill`/`valuePortfolio` functions.

   This changes which fills are ACCEPTED and what they cost/proceed for at
   the extreme unit-count/price boundary (a fill that previously rounded to
   a fractional-cent `notional` — itself a bug, not intended behavior — now
   rounds to the correct whole cent, which can differ from the old buggy
   value by more than a rounding tie), so `EXECUTION_CONVENTION` was bumped
   to `_v4`. `PRODUCT.md`'s cent-ledger section was rewritten (it previously
   described the CURRENT rule using the `_v2`-era `round2(a) - round2(b)`
   formula even though `EXECUTION_CONVENTION` had already moved to `_v3` —
   that stale formula description is what this round's fix actually
   replaces) and gained a paragraph on why `price` is read bit-exactly but
   `units` is snapped to its tick grid.

   Regressions (`tests/execution.test.ts`, new `describe` block): the exact
   $1e9/$20 BUY-then-SELL sequence, asserting `fill.notional` is
   cent-quantized, equals the actual `|cashAfter - cashBefore|`, equals the
   expected $0.02, and that `applyFill`'s stored `.value` agrees; the
   `MAX_UNITS`-at-$100,000 single-tick SELL returning exactly $0.10; the
   `MAX_UNITS`-at-`MAX_MONEY_USD` single-tick SELL returning exactly
   $1,000 (both confirmed to fail against the pre-fix code — $0.09375 and
   $768 respectively — before being confirmed to pass against the fix).
   Also rechecked (unchanged, still passing): `maxBuyTicks`/`maxSellTicks`'
   binary-search tests, all `MAX_UNITS` boundary tests from rounds 7-8, and
   `engine/baselines.ts`'s buy-and-hold conservation tests.

   `engine/execution.ts` was already at the 300-line source-file limit
   (298 lines) before this fix, so `maxBuyTicks`/`maxSellTicks`/`valueDelta`
   and their binary-search-termination machinery were extracted into a new
   `engine/sizing.ts` (105 lines); `execution.ts` is now 231 lines and
   `portfolio.ts` (which gained the BigInt helpers) is 256 lines — both
   comfortably under the limit. Neither extraction changed any external
   import (`executeOrder`/`EXECUTION_CONVENTION` are the only symbols
   consumed outside `engine/`).

### Verification performed (round 9)

- `pnpm run typecheck`: passes, 0 errors
- `pnpm run test`: 163 tests / 0 failures, 3,444 expectations, across 12
  files (up from 160/3,425 in round 8 — 3 new tests plus 2 strengthened
  assertions in the existing reviewer-repro test, no other test changed
  behavior)
- `wc -l` audit: no source file exceeds 300 lines (`execution.ts` 231,
  `sizing.ts` 105, `portfolio.ts` 256 — the split resolved round 8's
  near-limit `execution.ts`)
- A fake-agent `pnpm run run` (3 trading days) and `pnpm run report` against
  its output both completed normally, with the report's `exec=` cohort key
  showing `..._v4` as expected
- Verified by hand outside the test suite that the pre-fix `round2(a) -
  round2(b)` formula reproduces the reviewer's exact reported buggy values
  (`0.019999980926513672`, `$768` at `MAX_MONEY_USD`) before confirming the
  fixed code returns the exact expected values instead.

## Round 10 correction (this pass)

An independent review found one more defect (P0), fixed here:

1. **`positionValue()` (and `valuePortfolio`/`applyFill`, which persist its
   result) converted a BigInt cents value to a `number` unconditionally, on
   the theory — stated directly in its own doc comment — that every value it
   is ever called with "is bounded by the portfolio's own net worth (<=
   MAX_MONEY_USD)". That's only true for a BUY's fill transfer (capped by
   pre-fill cash); it is NOT true for a position's MARKED value or a SELL's
   proceeds, which grow with price and aren't bounded by cash on either
   side.** Reviewer's minimal, fully-reachable repro: start with
   `createInitialPortfolio(MAX_MONEY_USD)` ($1e9 cash), BUY exactly
   `MAX_UNITS` (1e9) at `MIN_PRICE_USD` ($1) — accepted per the round 7/8
   tests, spending all $1e9 — then mark or sell that SAME position at
   `MAX_MONEY_USD` ($1e9), an equally-accepted price. `MAX_UNITS *
   MAX_MONEY_USD` = $1e18: nine orders of magnitude past both the
   `$MAX_MONEY_USD` domain the engine documents everywhere else and the
   ~$90.07 trillion point where `BigInt -> Number` stops being exact
   (`Number.MAX_SAFE_INTEGER` cents). Before the fix: `valuePortfolio`
   silently stored a wrong mark; a partial SELL's stored remaining-position
   `.value` came out as `999999999999998080` dollars against a true
   `999999999999998.000002...` (a phantom **~$128 gain**, even though
   `Fill.notional`/`cashAfter` themselves were already exact — round 9's
   BigInt-subtraction fix keeps a DELTA exact regardless of the absolute
   values being subtracted, but never protected the absolute value itself);
   and a full exit returned exactly `$1e18` cash — mathematically correct,
   not a precision artifact — which then made the very NEXT order fail
   `executeOrder`'s own `cash > MAX_MONEY_USD` precondition as "corrupted,"
   even though nothing was actually corrupted.

   Fixed with a combination of both options the reviewer offered — exact
   BigInt-cents persistence AND tightened, explicitly-enforced bounds —
   rather than either alone:

   - **New `engine/money.ts`** (split out of `engine/portfolio.ts`, which
     was about to exceed 300 lines once this fix landed) holds
     `MAX_MONEY_CENTS` (the closed `[0, MAX_MONEY_USD]` domain every
     PERSISTED money value must stay inside — not just cash/notional/price
     INPUTS, which is all it bounded before), `centsToDollars` (converts
     BigInt cents to a `number`, throwing if the value is beyond
     `Number.MAX_SAFE_INTEGER` cents — a last-resort canary mirroring
     `sizing.ts`'s `assertSafeSearchBound`, never expected to actually fire
     since every real call site gates on the ~90,000x-tighter
     `MAX_MONEY_CENTS` first), `dollarsToCents` (lossless recovery of a
     `round2`-quantized dollar amount's exact cents), and
     `assertWithinMoneyDomain` (throws if a BigInt cents value exceeds
     `MAX_MONEY_CENTS`, with a descriptive label for the error message).
   - **`valuePortfolio`/`applyFill`** (`engine/portfolio.ts`) now compute
     each holding's mark/post-fill value via `positionValueCents`, gate it
     with `assertWithinMoneyDomain` BEFORE ever calling `centsToDollars`,
     and aggregate `holdingsValue`/`netWorth` by summing BigInt cents
     (never by summing already-converted `number`s, which can itself lose
     precision the same way `positionValue`-then-`+`-then-`round2` did).
     The AGGREGATE (holdingsValue/netWorth) is deliberately NOT re-gated
     against `MAX_MONEY_CENTS`: an existing round 7 regression
     (`tests/execution.test.ts`, "a notional BUY into a near-ceiling
     position...") directly constructs a portfolio with near-`MAX_MONEY_USD`
     cash AND a near-`MAX_MONEY_USD` position simultaneously (netWorth
     ~$2e9) and expects `applyFill` to keep working — a multi-position
     portfolio's TOTAL legitimately exceeding `MAX_MONEY_USD` while every
     contributing value stays small and cent-exact is a real portfolio
     value, not a corrupted one; only the exact-precision floor inside
     `centsToDollars` still applies to that sum.
   - **`executeOrder`** (`engine/execution.ts`) now computes a SELL's exact
     post-fill cash in BigInt cents (`positionValueCents(existingUnits,
     price) - positionValueCents(newUnits, price)`, added to the current
     cash) and rejects the order outright if that would leave the
     `MAX_MONEY_CENTS` domain — BEFORE ever calling `valueDelta`/converting
     anything to a `number`. This is what actually fixes the "next order
     rejected as corrupted" symptom: the OFFENDING order is now rejected
     immediately, with a clear reason, instead of being accepted and
     silently pushing the ledger somewhere a later, unrelated order then
     pays for. A BUY needs no equivalent check — its transfer only ever
     DECREASES cash, and pre-fill cash is already validated `<=
     MAX_MONEY_USD` above.
   - `positionValue()`'s and `valueDelta()`'s doc comments (the two places
     the reviewer specifically flagged) were rewritten to state the
     corrected bound and point at `assertWithinMoneyDomain`/
     `MAX_MONEY_CENTS` instead of the disproven "bounded by net worth"
     claim.

   `EXECUTION_CONVENTION` bumped to `_v5`: the accepted/rejected set at this
   exact boundary changes (a SELL that used to be silently accepted with a
   corrupted cash figure is now cleanly rejected). `PRODUCT.md`'s cent-ledger
   section gained a "Correction (round 10, `_v5`)" paragraph stating the
   corrected bound and pointing at the new domain check; its `MAX_UNITS`/
   `positionValueCents` file references were updated from
   `engine/portfolio.ts` to the new `engine/money.ts`.

   Regressions (`tests/execution.test.ts`, new `describe` block "money
   domain closed under valuation and SELL transitions"), all built from the
   SAME reachable BUY-`MAX_UNITS`-at-`MIN_PRICE_USD` sequence: (1)
   `valuePortfolio` marking that position at `MAX_MONEY_USD` throws a clean
   domain error instead of persisting a lossy value; (2) a partial SELL at
   that price still fills exactly via `executeOrder` (`notional`/`cashAfter`
   both exactly `$2,000`, matching round 9's delta-is-always-exact
   guarantee), but `applyFill`-ing it throws instead of reproducing the old
   $128 phantom gain; (3) a full exit at that price is rejected UP FRONT
   with a domain-related reason, not accepted; (4) after that rejection the
   portfolio is provably untouched and a normal-priced follow-on SELL still
   fills correctly — no corrupted state leaks into later orders; (5) an
   ordinary in-domain appreciation (BUY at $33.33, mark at $40, full exit)
   still marks and conserves exactly, confirming the fix rejects only the
   out-of-domain extreme, not realistic gains. Also re-verified unchanged:
   every round 6-9 boundary/regression test, including the ones that
   directly construct large `existingUnits`/`.value` states and exercise
   `executeOrder` against them without ever going through
   `valuePortfolio`/`applyFill` — those remain accepted exactly as before,
   since the new domain gate lives in the PERSISTENCE path
   (`applyFill`/`valuePortfolio`) and the NEW SELL post-fill check, not in
   `executeOrder`'s existing precondition checks.

### Verification performed (round 10)

- `pnpm run typecheck`: passes, 0 errors
- `pnpm run test`: 168 tests / 0 failures, 3,478 expectations, across 12
  files (up from 163/3,444 in round 9 — 5 new tests in the "money domain
  closed under valuation and SELL transitions" block, no other test's
  behavior changed)
- `wc -l` audit: no source file exceeds 300 lines (`money.ts` 220 — new,
  split out of `portfolio.ts` — `portfolio.ts` 151, `execution.ts` 258,
  `sizing.ts` 113)
- A fake-agent `pnpm run run -- --agent=fake --model=round10-verify
  --seed=1 --end=2024-01-05` (4 trading days) and `pnpm run report --
  --dirs=<its run dir>` both completed normally, with the report's `exec=`
  cohort key showing `..._v5` as expected; the verification run/report
  artifacts were deleted afterward (not committed).
- Verified by hand outside the test suite (re-deriving the pre-fix formula
  in a scratch script, not by reverting source) that the OLD
  `Number(positionValueCents(...))/100` conversion for the
  BUY-`MAX_UNITS`-at-`MIN_PRICE_USD`-then-mark/sell-at-`MAX_MONEY_USD`
  sequence is indeed lossy at this magnitude — it returns
  `999999999999998100` instead of the true `999999999999998.000002` for the
  partial-sell remaining-position value (same order of magnitude and same
  ~$100-scale phantom drift as the reviewer's independently-reported
  `999999999999998080`; the exact trailing digits depend on repro details
  not fully specified in the finding, but the defect — and its fix — are
  the same), and that a full exit's exact `cashAfter` is genuinely `$1e18`,
  which the pre-existing `cash > MAX_MONEY_USD` precondition would reject on
  the next order. Confirmed the fixed code throws/rejects cleanly at each of
  those points instead (see the round 10 regression tests).

## Round 11 correction (this pass)

An independent review found one more defect (P0), fixed here:

1. **Round 10's post-fill money-domain gate in `executeOrder`
   (`engine/execution.ts`) checked only a SELL's post-fill CASH — it never
   checked the RESULTING POSITION a fill leaves behind, and never checked a
   BUY's resulting position at all.** Reviewer's two minimal, independently
   reachable repros: (1) BUY `MAX_UNITS` at `MIN_PRICE_USD` ($1, spending all
   `MAX_MONEY_USD` cash), then SELL `0.000002` units at `$1e9`/share — the
   fill's own proceeds ($2,000) stay trivially in-domain, so round 10's cash
   check passed it, but the ~999,999,999.999998 units LEFT BEHIND, marked at
   `$1e9`, is ~$1e18 — `applyFill` then throws on a fill `executeOrder`
   already called "accepted". (2) A valid portfolio holding 500,000,000 AAPL
   units worth exactly `$1e9` (at `$2`/share) plus `$1e9` cash — every value
   individually in-domain — can BUY `0.005` units for a $0.01 order (trivially
   affordable, and MAX_UNITS is nowhere close), landing the resulting
   position at `$1,000,000,000.01`; `executeOrder` never checked a BUY's
   resulting position at all, so this was accepted and `applyFill` threw.
   Both turn a per-order condition into a batch-aborting exception
   (`run/day.ts`'s `runOneDay` has no try/catch around `executeOrder`/
   `applyFill` — nothing catches it), which for a real Pi agent means an
   already-paid-for model decision has to be repeated instead of just that
   one order being recorded as failed.

   Fixed by computing the fill's EXACT resulting position value — in BigInt
   cents via `positionValueCents`, before ever converting to a `number` —
   for BOTH BUY and SELL, and rejecting the order as a `FailedOrder` if that
   persisted position would leave the `MAX_MONEY_CENTS` domain, mirroring
   the SELL cash check's own pattern:
   - **BUY** (`engine/execution.ts`): after the existing `MAX_UNITS`
     ceiling check on `newUnits`, a new check computes
     `positionValueCents(newUnits, price)` and rejects if it exceeds
     `MAX_MONEY_CENTS` — `MAX_UNITS` alone doesn't imply this, since a
     position can leave the VALUE domain at a unit count far below the
     `MAX_UNITS` ceiling once price is large (repro (2) above: 500,000,000
     units is 0.5 of `MAX_UNITS`, but already `$1e9` at `$2`/share).
   - **SELL**: the same check, computed against `newUnits` (the REMAINING
     position after the sell, not the amount sold), placed before the
     existing round-10 cash check. For a full-position exit `newUnits` is
     always exactly `0`, so `positionValueCents(0, price)` is always `0` and
     this can never reject a full exit (only the pre-existing cash check
     can, as documented since round 10).
   `applyFill`'s own `assertWithinMoneyDomain` calls are untouched and stay
   as defense-in-depth — the fix moves the PRIMARY gate to `executeOrder`,
   the only place that can turn a rejection into an ordinary `FailedOrder`
   instead of a thrown exception.

   `EXECUTION_CONVENTION` bumped to `_v6`: the accepted/rejected set at this
   boundary changes again (a BUY or partial SELL that used to be silently
   accepted with an unpersistable resulting position is now cleanly
   rejected up front). `PRODUCT.md`'s cent-ledger section gained a
   "Correction (round 11, `_v6`)" paragraph, and two round-10-era
   inaccuracies the reviewer also flagged were corrected in the same pass:
   the round-10 correction paragraph previously said the `MAX_MONEY_USD`
   domain applies to "aggregate holdings value plus cash" — that's wrong,
   `valuePortfolio`/`applyFill` deliberately do NOT re-gate the aggregate
   (a multi-position portfolio's total can exceed `MAX_MONEY_USD` while
   every contributing value stays small and cent-exact, which is legitimate,
   not corrupted — see those functions' own comments); reworded to say the
   domain applies per scalar value (a single position's mark, a fill's own
   resulting cash), not to sums across positions. And the full-position-exit
   paragraph previously said exiting 100% of a position is "always
   allowed" — true only of the whole-cent NOTIONAL BUDGET cap it was
   describing (a full exit ignores that budget), not of the money-domain
   checks, which a full exit's proceeds can still fail (round 10) even
   though its remaining-position check can now never fire (round 11, since
   `newUnits` is always `0`); reworded to state both exemptions precisely.

   Regressions: `tests/execution.test.ts`'s round-10 "money domain closed
   under valuation and SELL transitions" describe block gained two new
   tests reproducing the reviewer's exact BUY-side and SELL-side repros
   above (each asserting `executeOrder` returns `failed` with a
   domain-related reason and leaves the portfolio untouched), plus one
   proving a fill accepted right AT the boundary (not over it) still
   `applyFill`s without throwing for both BUY and SELL — so the fix rejects
   only the genuinely out-of-domain outcome, not the boundary itself. The
   pre-existing round-10 test that exercised repro (1) directly (partial
   SELL from `MAX_UNITS`-at-`MIN_PRICE_USD` at an extreme price) was updated
   from "fills, then `applyFill` throws" to "rejected outright by
   `executeOrder`, nothing throws" — that's precisely the bug this round
   fixes. Two round-9 tests ("MAX_UNITS held at price $100,000/`$1e9`:
   selling a single 1e-6 tick...") that exercised `valueDelta`'s BigInt
   exactness on a position ALREADY far outside the domain (`$1e14`/`$1e18`,
   constructed directly as a `PortfolioState` rather than reached through
   `executeOrder`) were updated the same way: round 11 correctly rejects a
   SELL whose remaining position is still that far out of domain, so these
   are now genuine rejections, not fills — the underlying BigInt-exact SELL
   arithmetic they wanted to cover remains verified in-domain by the
   `$1e9`-boundary `MAX_UNITS`-at-`$20`-then-partial-SELL regression a few
   tests earlier in the same file. `tests/day.test.ts` gained a new
   `runOneDay`-level regression (the reviewer's explicit ask): construct a
   portfolio holding a large, in-domain AAPL position (sized off the day's
   own open/close prices so end-of-day `valuePortfolio` can never itself
   approach the domain), submit a decision with an oversized AAPL BUY
   followed by an ordinary MSFT BUY in the same batch, and assert the AAPL
   order is recorded as an ordinary `FailedOrder` (not a thrown exception)
   while the MSFT order placed after it still fills — proving one order's
   money-domain rejection never aborts the rest of the day.

### Verification performed (round 11)

- `pnpm run typecheck`: passes, 0 errors
- `pnpm run test`: 171 tests / 0 failures, 3,489 expectations, across 12
  files (up from 168/3,478 in round 10 — net +3 tests: 2 new regressions in
  the "money domain closed under valuation and SELL transitions" block, 1
  new `runOneDay`-level regression in `tests/day.test.ts`; 3 pre-existing
  tests updated in place to assert the corrected rejection behavior, no
  count change from those)
- `wc -l` audit: no source file exceeds 300 lines (`execution.ts` grew from
  258 to 298 lines for the two new resulting-position gates and their doc
  comments — the largest source file, but still under the limit; `money.ts`
  220, `portfolio.ts` 151 unchanged)

## Round 12: scale-sensitive flooring (`floorUnits`/`floorCents`) and the same defect pattern in `FULL_POSITION_DUST_TOLERANCE`

> Historical note: round 13 supersedes this ULP-snapping design. A number immediately below a tick is genuine input, not provable representation noise. The scaled neighbor demonstrated by review is 0.125 tick, not the 0.25–0.5 estimate below.

The reviewer found `floorUnits`/`floorCents` (`engine/portfolio.ts`) added a
FIXED `QUANTIZE_EPSILON = 1e-7` after scaling to absorb IEEE-754
representation noise near a tick boundary — but a fixed absolute epsilon is
wrong once the scaled value's own ULP exceeds it. Exact in-domain repros:
`floorUnits(277359992.498531)` returned `277359992.49853` (`units * 1e6`
evaluates to `277359992498530.97`, whose ULP there is ~0.06 — bigger than the
`1e-7` epsilon — so the noise wasn't absorbed and the already-quantized value
was shaved by a micro-share); `floorCents(608501453.42)` returned
`608501453.41` (`usd * 100` evaluates to `60850145341.99999`, same pattern,
one cent short). A deterministic 2,000,000-sample probe found 23,989
`floorUnits` idempotence failures over `0..MAX_UNITS` and 94,403 `floorCents`
failures over `0..MAX_MONEY_USD`. The reviewer also asked to check for the
same defect pattern elsewhere: `FULL_POSITION_DUST_TOLERANCE` in
`engine/execution.ts` (originally `engine/sizing.ts` after this fix) had the
identical shape — a fixed `1e-7` absolute tolerance comparing a SELL's
`rawUnits` against `existingUnits`, which can also reach `MAX_UNITS` (1e9,
whose own ULP is ~2.2e-7, already past the fixed tolerance) — misclassifying
an intended full-position exit as a rejected oversell at that scale.

Fixed by replacing the fixed epsilon with a scale-aware quantizer:
`quantizeFloor(n, decimals)` (`engine/portfolio.ts`) computes `scaled = n *
10**decimals`, then snaps to `Math.round(scaled)` ONLY if
`|scaled - Math.round(scaled)| <= NOISE_ULPS * |scaled| * Number.EPSILON`
(`NOISE_ULPS = 2`) — i.e. only if the value sits within a couple of
representation ULPs of an integer tick — otherwise it floors normally
(`Math.floor(scaled)`). `NOISE_ULPS = 2` is chosen so the bound never reaches
0.5 ticks even at this engine's largest scaled value (`floorUnits` at
`MAX_UNITS / UNIT_DECIMALS` scales to `1e15`, where the bound is `~0.444`
ticks — comfortably under the point where "floor" would degrade into
"round"; `floorCents` at `MAX_MONEY_USD / CASH_DECIMALS` only scales to
`1e11`, far looser). `floorCents`/`floorUnits` are now both thin wrappers
around `quantizeFloor`. `FULL_POSITION_DUST_TOLERANCE`'s equality check
(`engine/sizing.ts`'s new `fullExitTolerance`) uses the same `NOISE_ULPS`
constant (exported from `engine/portfolio.ts`), taking the LOOSER of the
original fixed `1e-7` floor (dominant, and behavior-preserving, at this
benchmark's realistic low-thousands-of-units scale) and the scale-relative
bound (dominant only defensively, near `MAX_UNITS`).

`fullExitTolerance` (and its constant) moved from `engine/execution.ts` to
`engine/sizing.ts` — not just for line-count headroom (execution.ts was
already at 298/300 lines before this round's doc-comment additions), but
because it's the same kind of pure tick-sizing arithmetic `sizing.ts`
already owns (`TICK`, `maxBuyTicks`, `maxSellTicks`, `valueDelta`), with no
knowledge of `OrderRequest`/`PortfolioState`.

While fixing the reviewer's numeric-domain finding, also corrected a stale
claim the reviewer flagged in `engine/money.ts`'s `MAX_MONEY_CENTS` doc
comment: it listed "aggregate holdings value, net worth" as values that
"must stay inside" the `MAX_MONEY_CENTS` domain — wrong, and contradicted by
`engine/portfolio.ts`'s own `valuePortfolio`/`applyFill` comments and
`PRODUCT.md`'s round-10 correction, both of which correctly state the
domain is enforced PER SCALAR (a single position's mark, a fill's own
resulting cash), not on the aggregate — a multi-position portfolio's total
can legitimately exceed `MAX_MONEY_USD` while every contributing value stays
small and cent-exact. Reworded to match.

`EXECUTION_CONVENTION` bumped to `_v7`: because the accepted BUY budget
(`floorCents`) and SELL full-exit classification (`fullExitTolerance`) both
change at the extreme end of the supported price/units domain, an existing
run directory computed under `_v6` must not be silently resumed as if
nothing changed. `PRODUCT.md`'s cent-ledger section gained a "Correction
(round 12, `_v7`)" paragraph.

Regressions added to `tests/execution.test.ts` (new "round 12: scale-aware
flooring" describe block): the two exact reviewer repros above (asserted as
idempotence, `floorUnits`/`floorCents` round-tripping their own already-
quantized input unchanged); two "genuinely fractional value still floors"
neighbor cases (constructed in the tick-integer domain, at a large-but-not-
extreme scale where an intended sub-tick offset stays exactly representable
— at `MAX_UNITS`'s own scaled magnitude, `1e15`, adjacent doubles are
already ~0.25-0.5 ticks apart, so a deliberately-tiny fractional offset
can't even be constructed distinctly from the noise band right at that
absolute edge); two deterministic 2,000,000-sample idempotence fuzzes
spanning the FULL `0..MAX_UNITS`/`0..MAX_MONEY_USD` domains (replacing the
prior single dense-but-narrow "full 6dp value space" test, which the
reviewer correctly noted only covered `0..5`); a `fullExitTolerance` unit
test proving it's unchanged (`1e-7`) at realistic scale and grows — but
stays under half a tick — near `MAX_UNITS`; and an `executeOrder`-level
regression proving a full-exit SELL within the new noise band (beyond the
old fixed tolerance) is accepted while a genuine 1-tick oversell at the same
scale is still correctly rejected.

### Verification performed (round 12)

- `pnpm run typecheck`: passes, 0 errors
- `pnpm run test`: 180 tests / 0 failures, 3,504 expectations, across 12
  files (up from 171/3,489 in round 11 — net +9 tests, all new, in the
  "round 12: scale-aware flooring" describe block)
- `wc -l` audit: no source file exceeds 300 lines (`execution.ts` shrank
  from 298 to 287 lines — `fullExitTolerance`/`FULL_POSITION_DUST_TOLERANCE`
  moved to `sizing.ts`, net line growth from the `_v7` doc-comment update
  more than offset by that move; `sizing.ts` grew from 113 to 138;
  `portfolio.ts` grew from 151 to 180 for `quantizeFloor`/`NOISE_ULPS`;
  `money.ts` grew from 220 to 227 for the corrected aggregate-domain
  comment)
- `git diff --check`: clean (no whitespace errors)


## Round 13: true raw-order flooring and exact full exits (`_v8`)

The reviewer demonstrated that round 12's proximity heuristic could round
raw input upward: `floorUnits(277359992.4985309)` became
`277359992.498531`, and `floorCents(608501453.4199998)` became
`608501453.42`. The same ambiguity affected tolerance-based full exits.
No epsilon can distinguish a genuine adjacent input from arithmetic noise
once both are represented as a `number`.

Raw sizes now use canonical-decimal flooring. `decimalFloor` parses the
shortest round-tripping decimal from `Number#toString()` into BigInt ticks,
then floors at two or six decimal places. Already-canonical inputs take a
fast path and remain idempotent; sub-tick inputs always produce a result
less than or equal to the raw number. Persisted/internal quantities continue
to use `roundUnits`, an explicitly separate normalization path whose
provenance is known. Unit-sized full exits require exact equality with the
persisted holding; a raw value even one representable double above it is an
oversell and is rejected. `EXECUTION_CONVENTION` bumped from `_v7` to
`_v8` so existing artifacts cannot mix sizing semantics.

Regression coverage includes canonical grid idempotence across the full
supported domain, `nextDown` neighbors at representative and maximum
unit/cent ticks, the two exact reviewer inputs, accepted BUY fills bounded
by their raw unit/notional requests, exact full exit, and adjacent oversell
rejection. Validation: `pnpm run test` passes 180 tests with 3,519
expectations; `pnpm run typecheck` passes.


## Live protocol v4: bulk universe screen

Paid smoke runs under the prior protocol showed both models consuming their
bounded sessions on ticker-by-ticker indicator calls and describing intended
trades after no order-call capacity remained. The six-tool boundary is
unchanged, but `get_indicators` now accepts an omitted ticker to return all
50 tickers' as-of SMA20/SMA50/RSI14 and last observable close/date in one
call. Prompts explicitly reserve at least two calls for orders and restrict
OHLCV research to finalists. `AGENT_PROTOCOL_VERSION` is
`v4-bulk-indicator-screen`, preventing old results from sharing a cohort or
resume directory. Offline validation passes 181 tests / 3,521 expectations.
