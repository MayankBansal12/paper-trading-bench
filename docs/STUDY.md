# Same tools, different habits

Ten models each managed four separate quarterly accounts from April 2025 to March 2026: 251 trading days and $600,000 of total funding per model. Every trading day was a fresh session. This page compares what the models did. The viewer has the full numbers and every selected session.

## What each session starts with

Every session opens with the same information: the date, cash, and each holding's units, average cost and previous close. It also lists the 96 eligible stock names and includes up to three of the model's own most recent journals. **It contains no fresh prices for stocks the account doesn't own, and no news.** Older prices appear only if a model wrote them into a journal. Anything else must be requested. `market_snapshot` returns previous closes only. `price_history` returns daily bars, and `journal` searches older notes. The day ends with `submit_day`: orders plus a new journal. Journals are the only memory. They record what a model chose to write, not its private reasoning.

## A typical day

For most models, the usual day took two steps: request price history, then submit.

<!-- workflow-table -->

- **Check a shortlist, then decide.** Astra followed exactly this sequence on 208 of 251 days, Muse on 185 of 250 and Sonnet on 135 of 251. Opus 5 and Luna also usually started with history but more often made a second request.
- **Scan everything, then check a shortlist.** Sol 5.6 and Sol 6 usually began with a snapshot of all 96 closes, then requested history for a few names (87 and 94 days in exactly that order). DeepSeek followed the same pattern with more follow-ups. It made a median of five calls a day, the most of any model.
- **Decide from what's already on hand.** Opus 5.5 called only `submit_day` on 195 of 251 days: 178 holds and 17 trades. On those days its journals compare held-stock closes from the opening portfolio with price levels it had written earlier: "MU closed 219 (>215 partial-profit rule)" ([October 27](https://mayankbansal12.github.io/paper-trading-bench/study.html#case-opus55-rule)). GLM also had 31 query-free days, all of them holds.

`price_history` was the most-used research tool for nine models. Opus 5.5 used snapshots slightly more (36 calls vs 27). Call counts include the submission, and a call is not a reasoning step.

How far back models looked varied widely. Sol 5.6 requested at least 20 daily bars in 96% of its history requests and Luna in 84%. Opus 5 did so in 5% (usually 6–8 bars) and Sonnet in 9% (usually 10).

## Did they revisit their journals?

**Rarely beyond what was supplied.** The three most recent journals arrived automatically. Models made extra journal requests on few days: GLM on 20 of 250 and Sol 5.6 on 17 of 250. Every other model did so on 12 days or fewer, and Sonnet never did. We can count requests, but not whether a model relied on the journals it was given. Automatic preloading is confirmed from the original prompts for five models. For the other five, it follows from the recorded protocol.

## What came before a buy or a sell?

New queries were common, but not required before each trade. Opus 5.5 traded on 17 days without any research call. Its journals sometimes compared held-position marks with previously written price levels. On [May 1](https://mayankbansal12.github.io/paper-trading-bench/study.html#case-opus55-aapl) and [July 1](https://mayankbansal12.github.io/paper-trading-bench/study.html#case-opus55-wmt) it also opened AAPL and WMT positions without querying either stock's price that day. Those examples show how it acted from the available context; they do not reveal everything it considered.

**Within the covered observations, every model bought more often after a sharp rise than a sharp fall, and sold more often after a sharp fall.** The table counts *covered ticker-days*: a stock on a day when the model requested at least two daily bars for it. The one-day change compares the last returned close with the one before. Purchases include additions to existing holdings.

<!-- price-table -->

Models chose which stocks to request, often ones they were already considering, so these counts are not a random sample. Each row compares a model with itself. Counts that include both a buy and a sell appear on both sides. Opus 5.5's few requests can't describe its mostly query-free year. Buying after a fall was uncommon; Sonnet did it most (9 of 120).

## Stated rules and follow-through

Journals often set explicit conditions, and later sessions often acted on them. **Astra** waited until NVDA closed at 117.06, above its 115 line, then bought only a $4,000 starter ([May 8](https://mayankbansal12.github.io/paper-trading-bench/study.html#case-astra)). **Sol 5.6** exited MU when it closed below 157 even though the sale realized a $1,651 gain ([September 26](https://mayankbansal12.github.io/paper-trading-bench/study.html#case-sol)). **Opus 5** postponed a planned LIN trim during the April sell-off and moved its trigger ([April 9](https://mayankbansal12.github.io/paper-trading-bench/study.html#case-opus)). **DeepSeek** bought NVDA on [December 24](https://mayankbansal12.github.io/paper-trading-bench/study.html#case-deepseek) while its observed close of 189.21 was still below its earlier 190 entry line.

In 30 hand-picked cases, 22 actions matched the stated rule, 6 involved discretion or a changed rule, and 2 didn't execute as intended. These examples are illustrations, not a compliance rate.

## How consistent were they over time?

**Outcomes moved together by quarter.** All ten models made money in Q2 and Q3 2025. Q4 split four up and six down. In Q1 2026 nine of ten lost money; only Astra gained.

**Astra's defensive positioning stood out.** It was the only model profitable in all four quarters: **$8,876, $2,058, $2,446 and $2,441**, respectively. It also had the lowest variation in quarterly TWR in this sample. Average cash was **56.5%**, its largest issuer position was **16.35%** of equity, and its worst quarterly drawdown was **3.75%**, the smallest worst-quarter drawdown among the ten models. These results support a defensive, comparatively steady approach, with lower total profit than the leading models. They do not establish that the approach will outperform in other periods.

Some habits held in every quarter. Sol 5.6 never made a partial sale: all 108 of its sales were full exits. Astra's average cash stayed between 54% and 58%. Opus 5.5 held on 46–56 days each quarter. Other habits shifted. Opus 5's full exits rose from 14 to 24, 26 and then 65. GLM's average cash went from 13% to 8%, 30% and 55%, and Sonnet's from 23% to 15%, 12% and 45%. These data can't show whether the shifts were deliberate adaptation or reactions to different prices.

## Distinct approaches

| Approach | Models | What the records show |
|---|---|---|
| Scan broadly, replace whole positions | Sol 5.6, Sol 6 | Close-only scan of all 96, then history for a shortlist. Sol 5.6: 108 sales, all full exits. Sol 6: more additions (78) and re-entries (34). |
| Frequent rotation | DeepSeek | Traded on 197 of 250 days; 650 fills; 55 re-entries. Sold and bought on 70 of 129 selling days. |
| Stay invested, stage purchases | Opus 5 | 14% average cash; 556 fills; bought and sold on 63 of 112 selling days. |
| Hold a core; journals track written price triggers | Opus 5.5 | 206 holds; 195 query-free days; never bought on a selling day (0 of 19). |
| Build a concentrated core by resizing | Luna 6 | 133 additions and 54 trims, only 5 full exits. Alphabet and Nvidia averaged 19% and 16% of the account. |
| Add to chosen holdings | Sonnet 5, GLM Flash | Mostly additions (184 and 108). Sonnet bought and sold on the same day only twice in 33 selling days. |
| Keep cash, confirm, start small | Astra 6 | 57% average cash, stable in every quarter; entries often after a price threshold was reached. |
| Wait, then buy selectively | Muse 1.3 | 192 holds and 60% average cash; few additions (11); 49 full exits. |

Models blended these approaches. The labels describe observed behavior, not a formal strategy each model followed throughout.

## Profit: selling losers, keeping winners

The objective was total account value.

<!-- pnl-table -->
| Model | Realized | Unrealized | Dividends | Net profit |
|---|---:|---:|---:|---:|
| Opus 5 | $-13,244 | $44,951 | $875 | $32,583 |
| Sol 6 | $-12,684 | $37,084 | $930 | $25,329 |
| Opus 5.5 | $-7,129 | $30,988 | $644 | $24,502 |
| Luna 6 | $-4,768 | $28,957 | $227 | $24,416 |
| Sol 5.6 | $-7,732 | $30,373 | $831 | $23,473 |
| GLM 5.3 Flash | $-10,771 | $32,968 | $408 | $22,604 |
| Astra 6 | $-886 | $16,501 | $206 | $15,820 |
| Sonnet 5 | $-10,418 | $25,647 | $535 | $15,764 |
| Muse Spark 1.3 | $-4,474 | $17,524 | $67 | $13,118 |
| DeepSeek 4.1 Flash | $-16,791 | $27,872 | $421 | $11,502 |
<!-- /pnl-table -->

<!-- sell-selection-table -->

**All ten ended with positive net profit while their realized trading P&L was negative.** Gains still open at quarter-end ($16,501–$44,951 per model) and dividends outweighed the losses realized through sales.

Astra's **−$886 net realized P&L** was the smallest net realized loss. That is after **$7,803 of gains** offset **$8,689 of losses** on executed sales; it does not mean its losing trades cost only $886.

Their sale choices fit that pattern. On days when a model sold anything, it was far more likely to sell a holding showing a loss than one showing a gain. Opus 5 sold 35% of its losing positions on those days versus 6% of its gaining ones. For Sol 5.6 the figures were 22% versus 3%. Luna had the smallest gap (44% vs 28%). "Showing a gain or loss" means the previous close compared with the average cost in the opening portfolio. The sale happened at the next open, which could land on the other side.

Loss-making sales outnumbered profitable ones for nine models. Luna was the exception, mostly through partial trims: 33 profitable sales versus 26 at a loss. Sol 5.6 had few large wins and many small losses. Its 26 profitable exits averaged about $816, compared with about $353 for its 82 losing exits. Models were not forced to sell at quarter-end: open holdings were valued instead. Liquidation at those marks would move the open gain from unrealized to realized.

## What this study supports

- The clearest differences were how much models looked before acting, how much cash they kept, whether they resized or replaced holdings, and whether their journals recorded explicit price triggers.
- In the queried-stock sample, purchases were more frequent after sharp rises than falls. On selling days, all ten sold a larger fraction of losing holdings than gaining ones.
- More research did not line up with more profit. DeepSeek made the most calls and earned the least. Opus 5 earned the most with a moderate number of calls, and Opus 5.5 placed third with the fewest. This is one market sample; it doesn't establish cause or a stable ranking. No passive buy-and-hold comparison is included, so positive profit does not establish an advantage over passive investing.

## Could prior knowledge affect decisions?

**Tools exposed only past market data, but some journals introduced unsupported news and fundamental explanations. The experiment cannot rule out training-data familiarity or isolate its effect on decisions.**

Examples include [Opus 5's tariff-event reference on April 3](https://mayankbansal12.github.io/paper-trading-bench/index.html#sessions/opus-5/2025-04-03), [DeepSeek's earnings calendar on April 24](https://mayankbansal12.github.io/paper-trading-bench/index.html#sessions/deepseek-4-1-flash/2025-04-24), and [Sonnet's earnings explanations on November 3](https://mayankbansal12.github.io/paper-trading-bench/index.html#sessions/sonnet-5/2025-11-03). The market tools supplied none of that news or financial-report information. The statements could reflect prior knowledge, inference or hallucination; they do not establish knowledge of future prices or deliberate cheating.

<details><summary>Selection and run details</summary>

Opus 5's Q2 is a newer repeat, chosen after both outcomes were known: the original Q2 made $26,578 and the selected one $22,130. Opus 5.5 includes seven supplemental recovery dates after three invalid original days; the originals are preserved. Sonnet's last 20 dates ran as a recorded continuation. Luna 6 replaces Luna 5.6, and Terra is excluded.

Failed attempts and four invalid days remain in the evidence. Recorded causes include provider quota or overload, host storage failure, client non-submission and audit errors. Recoverable tool errors inside a successful session are not failed days. Clients, source revisions and request-size limits differ by model; see [Methodology](METHODOLOGY.md).

</details>
