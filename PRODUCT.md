# PaperTrader — Product Spec

A paper trading benchmark for evaluating open source LLMs on financial decision-making and long-term memory across a simulated investment portfolio.

---

## What It Is

Each model is given $1,000 and runs autonomously every market working day for up to 60 days (or until its networth becomes <1%). It can buy and sell any stocks it wants using real end-of-day prices. The goal is to grow the portfolio and maximize the net worth.

---

## Stack

- **Language:** TypeScript
- **Runtime:** Bun
- **Package manager:** pnpm
- **Agent harness:** Pi SDK — `@earendil-works/pi-coding-agent` (single package, exports `createAgentSession`, `AuthStorage`, `ModelRegistry`, `SessionManager`)
- **After market prices:** `yahoo-finance2`

---

## Models

Open source models with opencode-go integration. Each model must support tool calling. Provider endpoints vary (OpenAI-compatible or Anthropic-compatible) — Pi's unified `pi-ai` layer (bundled inside `pi-coding-agent`) handles normalization.

---

## CLI Entry Point

```
pnpm run start --model="minimax-m2.7" // use that model for the session run
pnpm run results  // present the portfolio state in a detailed human-readable format
```

Starts or continues the session for the given model. Reads from and writes to `results/`.

---

## Structure for benchmark and results
All source code for benchmark- cli commands, agentic loop, tool implementations, and portfolio management — lives in `src/`. All results and artifacts live in `results/`.
Keep the src/ dir clean, organized and modular...no single file should contain majority of logic. 200 loc is a soft limit and 300 loc is hard limit for a single file. 

```
papertrader/
├── results/
│   ├── portfolio-state.json        # Live state — machine readable
│   ├── transactions.txt            # Append-only audit log
│   └── summaries/
│       └── YYYY-MM-DD.md           # One file per trading day
└── src/
    ├── index.ts                    # entrypoint
    and other files...
```

---

## Portfolio State (`results/portfolio-state.json`)

```json
{
  "start_date": "2026-07-01",
  "created_at": "2026-07-01T16:00:00Z",
  "updated_at": "2026-07-03T16:00:00Z",
  "opening_balance": 1000.00,
  "current_balance": 423.50,
  "holdings_value": 608.20,
  "holdings": {
    "NVDA": { "units": 2, "avg_cost": 131.20, "last_traded_price": 138.90, "value": 277.80 },
  },
  "net_worth": 1031.70,
  "net_pnl": 31.70,
  "status": "active"
}
```

`status` is `active` or `terminated`. Portfolio state is only written after a fully successful session.

---

## Transaction Log (`results/transactions.txt`)

Append-only. One line per trade.

```
2026-07-01 | BUY  | NVDA | 2 units @ $131.20 | cash remaining: $737.60
2026-07-03 | SELL | NVDA | 2 units @ $138.90 | cash remaining: $1015.40
```

---

## Daily Summary (`results/summaries/YYYY-MM-DD.md`)

Written by the model at the end of each session. Serves as both the memory unit for the next session and the artifact for human analysis.

```markdown
# 2026-07-01

## Decisions
...

## Reasoning
...

## Portfolio Snapshot
...

## Watchlist
...

## Outlook
...
```

---

## Tools

Seven tools. Only `buy` and `sell` mutate state.

| Tool | Description |
|---|---|
| `get_portfolio()` | Returns current cash, holdings, total value, P&L |
| `get_price(stock)` | Returns today's EOD price from cache |
| `search_news(query)` | Web search scoped to financial news |
| `buy(stock, units)` | Validates cash → executes → updates portfolio |
| `sell(stock, units)` | Validates holdings → executes → updates portfolio |
| `get_weekly_summary()` | Returns last 7 daily summary `.md` files as a block |


<!--| `get_stock_info(ticker)` | Sector, 52w high/low, market cap, P/E |  // deferred tool  -->

**Error responses are part of the feedback loop:**
- Insufficient cash → return current cash + current holdings so model knows what to sell
- Selling more units than held → return actual units held
- Invalid stock → say so explicitly

---

## What the Model Sees Each Session

- System prompt (role, rules, goal, starting conditions)
- Current portfolio state injected as context
- Last 7 daily summaries via `get_weekly_summary()`
- No raw transaction log — summaries are the memory layer

---

## Session Flow

```
1. Parse --model flag
3. Initialize Pi agent session (SessionManager.inMemory())
4. Register all 7 tools
5. Inject opening prompt with portfolio state + role context
6. Agentic loop runs — model calls tools freely
7. Inject wrap-up prompt → model writes daily summary in required format
8. Save summary to results/summaries/YYYY-MM-DD.md
9. Persist updated portfolio-state.json
```

---

## Termination Conditions

A session marks `status: terminated` if total portfolio value (cash + holdings at current prices) reaches <$10. 
Subsequent runs on a terminated portfolio exit immediately.

The model must sell existing holdings to free cash before buying — the insufficient cash error surfaces current holdings so it knows what to liquidate.

---

## Assumptions & Exclusions

- No transaction fees, brokerage charges or other charges accounted for
- EOD price = execution price (no slippage, no overnight gap)
- No short selling, no margin, no options
- No dividends or stock splits accounted for
- Models pick any publicly traded stock — no restricted universe
- Models can go with any strategy they want — no restrictions on risk, diversification, or sector allocation
