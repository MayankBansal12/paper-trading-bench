> Historical v7 document. The current v11 contract and commands are in [docs/STUDY_ENVIRONMENT.md](docs/STUDY_ENVIRONMENT.md). Original bytes are preserved in the v10 source archive.

# Implementation status and cohort roadmap

## Implemented for the active Nasdaq profile

- Versioned security-level Nasdaq-100 membership effective 2026-06-01, frozen through 2026-08-31, with official sources, both Alphabet share classes, and explicit HON/EA exclusions; v1/v2 remain unchanged.
- Hash-verified Yahoo raw snapshot with 100 warm-up sessions, 64 evaluation sessions, source responses, canonical membership snapshot, split/dividend reconstruction, corporate-action policy, and fail-closed missing/unsupported data.
- Immutable comparison registry preserving `202606-202608-v6` and adding `nasdaq100-20260601-20260831-v7` with locked data, dates, funding, budgets, execution, prompt, behavior rules, and exact live-model/runtime policy.
- Neutral v7 prompt with allocation/no-trade freedom and explicit cash/contribution/open-gap/liquidity/drawdown/balance responsibility; frozen v5/v6 builders and hashes retained.
- Existing causal atomic engine semantics retained: prior-close observation, complete queued batch, next-open fills, close valuation, and zero execution for failed attempts.
- Separate return/excess, risk, concentration, cash/capital deployment, holdings/turnover, operational, liquidity, and causal dip analytics; no composite intelligence score.
- Cash and matched security-equal-weight buy-and-hold controls. No unmatched market-cap NDX series.
- Official OpenCode 1.18.30 gate for only `opencode/muse-spark-1.3-contributor-free`, with refreshed catalog/zero-price evidence before inference; no Muse Pi route or paid fallback.
- Deterministic/offline regression coverage and durable no-call qualification artifacts.

## Validation sequence

The validation record in `docs/VALIDATION.md` is authoritative. Every release of this profile runs, in order:

1. TypeScript typecheck, complete offline tests, and diff whitespace checks.
2. Byte-identical no-network snapshot rebuild and registered profile no-call preflight.
3. Full three-month deterministic fake-agent control, separately labeled.
4. No-inference OpenCode version/catalog/zero-pricing qualification.
5. Smallest separately labeled one-session Muse live smoke.
6. Full three-month Muse profile only if every earlier gate passes.

Failures are retained and reported. If the exact catalog entry disappears, pricing cannot be proven zero, the runtime drifts, or credentials/provider access fail, no alternate live model runs.

Qualification outcome (2026-09-12): all six gates completed. The deterministic control, one-session exact-Muse smoke, and 64-session exact-Muse run all reconciled. Two transient absent-catalog attempts were retained with zero inference and later recovered after fresh qualification. Exact metrics and artifact identities are recorded in `docs/VALIDATION.md`.

## Next experiment versions

These are future versioned profiles, not changes to the current identity:

1. Predeclare multiple non-overlapping rising, falling, range-bound, and high-volatility three-month periods before inspecting model results.
2. Run multiple replicate labels and report distributions/uncertainty rather than one winner.
3. Add point-in-time constituent archives and a second market/action source; preserve revisions as distinct dataset identities.
4. Add issuer-verified spin-off, merger, delisting, rights, and cash-in-lieu accounting before restoring excluded securities.
5. Add separately versioned spread, slippage, market-impact/liquidity caps, fees, and tax scenarios with matched controls.
6. Add reproducible technical controls/ablations such as momentum and mean reversion without changing the model prompt.
7. Investigate historical-memory contamination using separately identified anonymized/held-out experiments.
8. Qualify future free models only through exact provider/runtime evidence and new profile identities.

More indicators or richer prose do not substitute for point-in-time data, action accounting, execution realism, pre-registration, and repeated regimes.
