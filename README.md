# PaperTrader

A paper trading benchmark for evaluating open-source LLMs on financial decision-making and long-term memory across a simulated investment portfolio.

Each model is given $1,000 and runs autonomously every market working day for up to 60 days (or until its net worth becomes <1%). It can buy and sell any stocks it wants using real end-of-day prices. The goal is to grow the portfolio and maximize the net worth.

See [PRODUCT.md](./PRODUCT.md) for the full spec.

---

## Stack

- **Language:** TypeScript
- **Runtime:** Bun
- **Package manager:** pnpm
- **Agent harness:** Pi SDK — `@earendil-works/pi-coding-agent`
- **Prices:** `yahoo-finance2` (with local JSON cache)
- **Schemas:** `typebox` (TypeBox — what Pi uses natively)

---

## Quick start

```bash
# install deps
pnpm install

# run one trading day with a specific model
pnpm run start -- --model=kimi-k2.6
# or any opencode-go model: minimax-m2.7, glm-5.1, glm-5.2,
#                            minimax-m3, deepseek-v4-flash, deepseek-v4-pro, ...

# show the current portfolio + recent transactions + recent summaries
pnpm run results

# typecheck
pnpm run typecheck
```

Models come from the [opencode-go](https://opencode.ai) provider. Run `pi --list-models` to see the full catalog, or `opencode models` to see everything opencode-go offers.

---

## Project layout

```
src/
├── index.ts                # CLI router (start | results)
├── cli/
│   ├── start.ts            # runStart(modelId) — full session orchestration
│   └── results.ts          # runResults() — pretty-print portfolio + history
├── agent/
│   ├── session.ts          # createTradingSession(model, ctx) — wires the pi SDK
│   ├── loop.ts             # runTradingDay(session, ctx, portfolio)
│   └── termination.ts      # shouldTerminate(portfolio) — net_worth < $10
├── prompts/
│   ├── system.ts           # Role, rules, starting conditions
│   ├── context.ts          # Opening prompt (portfolio + weekly summary)
│   └── wrapup.ts           # Wrap-up prompt (asks for daily summary markdown)
├── tools/
│   ├── format.ts           # ok() / err() / formatResult() helpers
│   ├── context.ts          # TradingContext type (live portfolio + date + model)
│   ├── portfolio.ts        # get_portfolio
│   ├── price.ts            # get_price
│   ├── news.ts             # search_news
│   ├── buy.ts              # buy(stock, units)
│   ├── sell.ts             # sell(stock, units)
│   ├── summary.ts          # get_weekly_summary
│   └── registry.ts         # buildAllTools + extension factory
├── state/
│   ├── portfolio.ts        # load/save/createInitial/termination helpers
│   └── valuation.ts        # recalculateHoldingsValue — pure function
├── log/
│   └── transactions.ts     # append-only transactions.txt with parser
├── summary/
│   └── manager.ts          # write/read/getWeeklySummaries
├── price/
│   ├── cache.ts            # Local JSON cache of EOD prices
│   └── fetcher.ts          # cache → yahoo-finance2 with friendly errors
├── news/
│   └── search.ts           # yahoo-finance2 search() (graceful empty on fail)
├── types.ts                # Core domain types
└── utils/
    ├── paths.ts            # Centralized RESULTS_DIR + filenames
    ├── dates.ts            # getToday / formatDate / parseDate / isMarketDay
    ├── errors.ts           # BenchmarkError + 4 typed subclasses
    └── fs.ts               # ensureDir + writeFileAtomic
```

All source files stay under 200 LOC (soft limit) and 300 LOC (hard limit) per the spec.

---

## How a trading day runs

1. CLI loads (or creates) the portfolio state from `results/portfolio-state.json`.
2. If already terminated (net worth < $10), exit immediately.
3. Build a `TradingContext` (portfolio + date + model).
4. Spin up a Pi `AgentSession` with the 7 trading tools registered and all built-in tools disabled (`noTools: "builtin"`).
5. Inject the system prompt + opening prompt (portfolio snapshot + weekly summary).
6. Model calls tools freely until it stops (agentic loop runs).
7. Inject the wrap-up prompt — model produces the daily summary markdown.
8. Save the daily summary to `results/summaries/YYYY-MM-DD.md` (FIRST).
9. Save the updated portfolio state to `results/portfolio-state.json` (atomic, after success).

A crash mid-session leaves the prior portfolio state intact (atomic write).

---

## How the 7 tools work

- `get_portfolio()` — read-only snapshot of cash, holdings, value, P&L
- `get_price(stock)` — EOD price from cache or yahoo-finance2
- `search_news(query)` — yahoo-finance2 search; empty list on failure
- `buy(stock, units)` — validates cash, fetches price, mutates state, appends log
- `sell(stock, units)` — validates holdings, fetches price, mutates state, appends log
- `get_weekly_summary()` — last 7 daily summary files (gaps skipped)

Error responses (insufficient cash, invalid holding, invalid ticker) include enough context for the model to replan — current cash, current holdings, etc.

---

## Termination

A portfolio is `terminated` when `cash + holdings_value < $10`. The `status` flag is set on save; subsequent runs exit immediately with a clean log line.

---

## Development

```bash
# typecheck (catches type errors; tsc 5.9+ with bun types)
pnpm run typecheck

# run a session with a specific model
pnpm run start -- --model=glm-5.2
pnpm run start -- --model=deepseek-v4-flash   # cheap & fast
pnpm run start -- --model=kimi-k2.6            # default
```
