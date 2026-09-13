# Agent action log and quarterly study plan

Status: the action-log tool and annual orchestration are proposed, not implemented. The history-limit fix is implemented. The 60-minute watchdog, one automatic retry and invalid-run counts are implemented in the active environment contract. An exhausted day is marked invalid, accounted without new orders, and followed by the next trading day. Three consecutive invalid days stop the quarter/run; a valid day resets that streak.

## Agent action log

Purpose: let the agent compare its stated intentions with actual execution before making its next decision.

- Derive receipts from committed day files and their referenced submission events. Keep the existing ledger authoritative; do not create a second independent log that can drift.
- Add one read-only tool: `action_log(date?, ticker?, cursor?)`. Default to the last committed trading day; allow exact past-date or ticker filters with stable pagination for older history.
- Each receipt identifies the committed date and host order ID, side, ticker, requested units or dollars, actual filled units and price, cash movement, and filled/rejected status with the exact rejection reason. Preserve batch execution order, including repeated orders for the same ticker.
- Include deposits, dividends and splits as separate typed entries. A valid committed empty order batch is explicitly a hold. An invalid day gets a separate failure-status entry showing that no decision was accepted and no orders executed, along with its automatic cash flows and valuation.
- Preload a small previous-day summary with counts of submitted/filled/rejected orders and a pointer to `action_log`. Keep detailed rows behind the tool and original journals unchanged.
- Also preload explicit receipts for today’s already-effective automatic adjustments to prior holdings, before the decision: dividend cash credited, split ratio, and shares before/after. State that dividend cash uses the ex-date convention. Derive these from the same portfolio preparation used by the context so the explanation cannot disagree with visible cash or shares. This makes a split visible on its effective morning, rather than waiting for tomorrow’s past-day log.
- The `action_log` tool exposes committed dates strictly earlier than the decision date, from this run, including host-generated invalid-day status. The opening-context adjustment receipts above may describe actions already effective today; they expose no execution-day prices, fills, or future actions. Exclude future outcomes and all uncommitted submissions or model notes, including those from failed attempts on the current day. Evaluator reports retain all attempts separately.
- Bound each response to 32 entries within the existing response byte limit, with an explicit next cursor and deterministic ordering. Cap the previous-day preload so a long order batch cannot flood context.
- Extend the effective tool allowlist, gateway/client configuration, provider audits, replay verification and documentation together. The additional tool and context change require a new implementation identity/cohort.

Acceptance scenarios: a fixed-share buy rejected after an opening gap; successful sell funding a later buy; mixed fills/rejections and repeated ticker orders; hold days; contribution/split/dividend entries; same-morning adjustment receipts matching visible cash, shares and split-adjusted history; exact-once recovery; pagination; unavailable future/foreign/failed-attempt receipts; and identical offline replay.

## Four-quarter study

Target: study each model across an entire year, with one run/report per calendar quarter and an annual comparison of results and behavior. Use four independent quarterly runs. Each quarter starts with $500 cash, no holdings, and an empty journal/action history. The first trading day of months two and three adds $500 each. No portfolio or model memory carries across quarter boundaries.

Freeze each quarter's dates, starting eligible stock list, market data, reference data, funding, execution rules, and timeout/retry policy before scored model runs. Verify that the price dataset contains every required member of the declared list. The existing v3 loader already checks its canonical list; generic quarterly qualification still needs equivalent membership validation.

Report planned trading days, days attempted, committed decisions, days recovered on retry, exhausted days, and days never attempted. Preserve failures alongside portfolio results so incomplete quarters cannot look like complete studies.

Compare returns with external deposits removed, drawdown, cash allocation, concentration, turnover, buy/sell frequency, rejection rate and stated strategy changes supported by journal/action evidence. Keep numerical activity and stated reasons distinct from claims about hidden reasoning.

Annual reports aggregate the four independent quarter outcomes and completion coverage, including total contributions, net profit, risk/return statistics per quarter, and behavior patterns across quarters. Four fully funded quarters receive $6,000 total. Do not concatenate reset dollar balances or label their aggregation as the realized growth of one continuous portfolio. Do not silently exclude invalid days or stopped quarters from annual completion/reliability reporting.

A model route requires its own qualification before comparison; current execution supports only the qualified OpenCode Muse route. Annual orchestration, additional adapters, action-log access, and membership-gate repairs remain planned work.
