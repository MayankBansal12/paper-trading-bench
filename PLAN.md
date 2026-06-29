# PaperTrader Implementation Plan (executed)

Built across 8 phases, each shipped as a separate commit on `feat/initial-impl`.

## Dependency Graph

```
Phase 1 (Scaffolding)
  ↓
Phase 2 (Types & Utils)
  ↓
Phase 3 (Data Layer) ←→ Phase 4 (External Services)
  ↘                  ↙
   Phase 5 (Tools)
       ↓
   Phase 6 (Agent & Prompts)
       ↓
   Phase 7 (CLI & Entry Point)
       ↓
   Phase 8 (Integration & Polish)
```

## Phases

| # | Phase | Model | Files | LOC (max) |
|---|---|---|---|---|
| 1 | Scaffold (package.json, tsconfig, .gitignore, results/) | minimax (inline) | 6 | 23 |
| 2 | Domain types and utilities | minimax (inline) | 5 | 58 |
| 3 | Data layer (state, valuation, log, summary) | minimax (inline) | 4 | 66 |
| 4 | External services (price cache, fetcher, news) | minimax (inline) | 3 | 84 |
| 5 | 7 tools + registry | minimax (inline) | 9 | 168 |
| 6 | Agent orchestration + prompts + loop | minimax (inline) | 7 | 100 |
| 7 | CLI router + start + results | minimax (inline) | 3 | 116 |
| 8 | Integration test + bug fixes + README | minimax (inline) | 1 | — |

**Total: 30 source files, 1713 LOC. Largest file: 168 LOC (tools/buy.ts). 0 files over 200 LOC.**

## Deviations from the original kimi plan

- **zod replaced by typebox**: pi's tool schema layer uses TypeBox, not zod. The kimi plan added zod unnecessarily. Corrected to use typebox.
- **--model format**: kept simple modelId (e.g. `kimi-k2.6`), pi's built-in `opencode-go` provider resolves it.
- **paths.ts PROJECT_ROOT**: original used `..` once, which resolved to `src/`. Corrected to `../..` to escape `utils/`.
- **Tool result shape**: pi's `AgentToolResult` requires `details: TDetails` (not optional). All 7 tools updated.
- **ctx mutation pattern**: tools hold a closure over `TradingContext` and mutate `ctx.portfolio` in place. `runTradingDay` reads back from ctx (not the original `initialPortfolio` arg).
- **recalculateHoldingsValue bug**: was clobbering `last_traded_price` for all holdings with the just-traded ticker's price. Fixed: each ticker keeps its own price unless the lookup explicitly provides a new one.
- **Termination check**: original was just `status === "terminated"`. Corrected to `shouldTerminate()` which also catches `net_worth < $10` even if the status flag is stale.

## Verification

- `pnpm run typecheck` (a.k.a. `tsc --noEmit`): passes
- `pnpm run start -- --model=kimi-k2.6`: full session runs, makes trades, writes summary + state
- `pnpm run start -- --model=deepseek-v4-flash`: 3 buys in 1 minute, correct accounting
- `pnpm run results`: pretty-prints portfolio with color-coded P&L
- Termination path: setting net worth to $5 then running `start` exits immediately
- `wc -l` audit: 0 files over 200 LOC
