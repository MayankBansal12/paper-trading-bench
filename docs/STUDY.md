# Same tools. Different investment habits.

Ten models, four independent quarterly accounts each, April 2025–March 2026. Each quarter starts fresh.

## What did an average session look like?

The usual routine was **inspect prices, then submit a decision**. The main difference was how widely a model looked before acting. Tool calls are not reasoning steps: one model response can request several tools, and every submission also counts as a call.

**Astra, Muse and Luna 6 started with price history on about nine out of ten valid days.** They typically queried a smaller set of stocks; median returned breadth was eight names for Astra and seven for Muse and Luna. Their sessions averaged 2.18, 2.41 and 2.80 calls respectively. This resembles checking a shortlist rather than rescreening the entire market.

**Sol 5.6, Sol 6 and DeepSeek usually started with a market snapshot.** Both Sols had a median returned breadth of 96 stocks. DeepSeek’s was 33, but it averaged the most calls—5.49 a day, including 726 price-history calls across its valid sessions. The Sols averaged 3.81 and 3.34 calls. For example, Sol 5.6 used **snapshot → history → submission** on September 30; DeepSeek used **snapshot → three history requests → submission** on September 10. These illustrate workflows, not measured sequence frequencies. Broader queries exposed more candidates; exposure does not prove influence.

**Opus 5.5 was the exception:** 195 of 251 sessions called only `submit_day`. Its average was 1.26 calls. It often retained an already-invested, diversified core using the supplied context. No extra queries does not mean no supplied information or reasoning. Opus 5 usually opened with history; Sonnet and GLM mixed history and snapshots more evenly. They averaged 2.79, 2.25 and 2.97 calls respectively.

## Did models revisit their journals?

**Extra journal retrieval was uncommon; journal access was not.** Up to three prior committed journals were supplied automatically. We can measure requests for more history, not whether a model mentally “read” or relied on every supplied entry.

GLM explicitly requested journals on **20/250 valid days**, Sol 5.6 on **17/250**. DeepSeek and Muse did so on 12 days each; Sol 6 and Luna 6 on ten; Astra on seven; Opus 5.5 on three; Opus 5 on one. **Sonnet made no explicit journal calls.** That does not establish that Sonnet ignored its automatically supplied history.

Requests also differ from retrievals. Luna made ten requests in valid sessions, but only nine succeeded. Its eleventh request, counted across all attempts, belonged to the preserved failed attempt. Counting only the tool name would miss this distinction.

## What did they say before buying, selling or holding?

The journals show **different conditions for acting**, rather than one shared strategy. These are submitted explanations written before execution—not access to private reasoning.

- **Astra required confirmation and limited the bet in its May 8 NVDA entry.** After the prior close reached 117.06, above its 115 threshold, it bought a $4,000 starter. Its journal explained that one close was not sustained confirmation.
- **Opus 5 revised a sell condition on April 9.** LIN had fallen 10.5% below its recorded cost, beyond its earlier 8% trim condition. It postponed the sale, saying it would not sell into the panic, and changed the trigger to a close below 408.65. These are separate episodes, not a same-date comparison.
- **Sol 5.6 followed a price rule even on a profitable position.** On September 26, it exited MU after the prior close fell below 157; the sale still realized a $1,651 gain. Selling after weakness did not necessarily mean selling at a loss.
- **Sonnet’s September 4 journal explained a $3,500 ISRG add as buying weakness.** Luna 6 also adjusted retained holdings: 133 adds and 54 trims, but only five full exits. Sol 5.6 made 108 sells, every one a full exit.

A HOLD label alone says very little about exposure. On April 10, **Astra held with roughly 90% cash; Opus 5 held with roughly 10% cash; Luna 6 bought $13,000.** They faced the same rebound with very different existing portfolios.

## Which recognizable strategies emerged?

**The closest matches were momentum trading, breakout confirmation, selective dip buying and holding a core portfolio.** These labels describe observed behavior; they do not establish that a model implemented a formal strategy consistently.

| Closest observed style | Models | What distinguished their approach |
|---|---|---|
| **Momentum / relative-strength rotation** | Sol 5.6, Sol 6 | Compare stronger candidates and exit weakening positions. Sol 5.6 replaced whole positions; Sol 6 made more additions. Selling could also lead to [holding cash](https://mayankbansal12.github.io/paper-trading-bench/study.html#case-sol6-style). |
| **Breakout confirmation with cautious sizing** | Astra 6 | Wait for a price threshold, start small, and retain cash while conditions remain uncertain. Its [NVDA starter](https://mayankbansal12.github.io/paper-trading-bench/study.html#case-astra) illustrates this. |
| **Selective, concentrated entries** | Muse 1.3 | Wait, then make larger purchases when price, range and volume conditions qualify. Its [Alphabet addition](https://mayankbansal12.github.io/paper-trading-bench/study.html#case-muse-style) concentrated the portfolio despite substantial cash. |
| **Dip buying within a retained core** | Sonnet 5, GLM Flash | Add selectively to chosen holdings on weakness, while retaining exit rules. Sonnet's [ISRG add](https://mayankbansal12.github.io/paper-trading-bench/study.html#case-sonnet) fits; GLM also used [renewed-strength conditions](https://mayankbansal12.github.io/paper-trading-bench/study.html#case-glm-style). |
| **Active sizing around core holdings** | Luna 6 | Keep core positions while adjusting their size: 133 additions and 54 trims, versus five full exits. |
| **Staged dip buying with discretionary rules** | Opus 5 | Began Q2 with defensive stocks and about half in cash, then bought megacaps in stages. Its [April LIN decision](https://mayankbansal12.github.io/paper-trading-bench/study.html#case-opus) delayed a planned trim; later basket-level rules could still prompt exits. |
| **Buy-and-hold with selective risk reductions** | Opus 5.5 | Retain a broadly invested core—206 HOLD sessions—with occasional [trims and exits](https://mayankbansal12.github.io/paper-trading-bench/study.html#case-opus55-style). |
| **Active momentum rotation with flexible thresholds** | DeepSeek | Repeatedly investigate candidates, rotate and reenter; sometimes [relax a previously stated threshold](https://mayankbansal12.github.io/paper-trading-bench/study.html#case-deepseek). |

**Models blended these approaches.** The strongest evidence is for price-based decisions with discretionary judgment, rather than one fixed strategy throughout the run.

## How consistent were they over time?

**Some habits persisted; others changed substantially.** Sol 5.6 made no partial sells in any quarter. Astra’s quarterly cash averages stayed at about 54–58%. Those are stronger population-level observations than a few persuasive journal excerpts.

Sonnet’s quarterly average cash moved from 23%, to 15%, to 12%, then 45%. GLM went from 13% and 8% in the first two quarters to 30% and 55% later. Opus 5’s full exits increased from 14 in Q2 2025 to 65 in Q1 2026. The models’ activity changed with the period, but these observations cannot isolate whether that was deliberate adaptation, changing opportunities or inconsistent rules. 

The close review of 30 selected rule/action cases found **22 directionally aligned responses, six discretionary interpretations or changes, and two execution mismatches**. This is evidence of both follow-through and exceptions—not a compliance rate for all decisions. For example, DeepSeek bought NVDA on December 24 despite its observed close of 189.21 remaining below an earlier 190 entry threshold.

## Did they buy after falls or rises?

A **ticker-day** is one stock on one session date. These comparisons cover only tool-returned histories with enough closes to measure the change; purchases include additions to existing holdings. Within that coverage, sharp one-day falls more often accompanied sales or no action than purchases. After falls of at least 3%, purchases were rare: **Astra 0/121, Sol 5.6 0/1,319, Sol 6 0/389, DeepSeek 0/552 and Muse 0/174**. Sonnet bought in 9 of 120 such ticker-days; Opus 5 in 4 of 242; Opus 5.5 in 2 of 35; GLM in 2 of 121; Luna in 1 of 138.

The covered data also show purchases at recent highs. A **20-close high** is the highest close in the latest 20 returned sessions, including the last close. Astra bought in 31/96 such ticker-days; Sol 5.6 in 159/2,225 and Sol 6 in 136/990. **These fractions are not a fair aggressiveness ranking:** Sol 5.6 queried far more stocks, creating many more opportunities to do nothing. Opus 5.5 had only 21 covered high-price observations, so its 20 purchases there cannot describe its mostly query-free year.

The defensible conclusion is narrower: **some covered purchases followed recent strength, while some models also bought selected weakness.** Tool receipts establish that a price was available, not that the model noticed it or acted because of it. Journal examples add stated reasons. Price-only data do not corroborate their occasional news or fundamental claims.

## What else do tool calls reveal?

**More calls can mean more investigation—or more friction.** DeepSeek had 141 tool errors within valid sessions; GLM had 153; Luna had 86. Astra had none. Recoverable tool errors, rejected trade orders and an entirely failed attempt are different events. They should not all be counted as investment decisions or HOLDs.

For Luna, all HOLD sessions still had successful market receipts. Its tool errors therefore do not justify describing those HOLDs as decisions made without market data. Likewise, Opus 5.5’s submit-only days do not prove an outage: it submitted accepted decisions without additional tool queries.

The activity leaderboard is not the performance leaderboard. DeepSeek made the most calls but earned less than the other nine models. Opus 5 earned the most with a moderate call count. This single run does not establish that more or fewer queries cause better returns.

## Were profits made by selling winners or keeping them?

**All ten finished with positive net profit, yet each had negative summed realized trading P&L.** Gains in positions still open at the ends of the four quarters, plus dividends, outweighed the realized trading losses.

That is consistent with keeping some winners while selling weaker positions, but does not prove every loss was a sensible stop or that retaining those shares was optimal. Quarter-end holdings were marked to market, not forced to sell; a different liquidation convention would change the realized/unrealized split.

**Nine of ten models had more loss-making sales than profitable sales.** Luna was the exception, but its 33 winning sales earned $3,514 while 26 losing sales lost $8,282. Sales include partial reductions, not just full exits. Opus 5’s sales realized a net loss of $13,244, while quarter-end open gains totaled $44,951 and dividends $875, producing its $32,583 net result (figures rounded). Sale proceeds themselves are not earnings.

The comparison below uses actual executed cash and a weighted-average historical cost basis, adjusts for splits, and separates dividends. Both independent accounting calculations reconcile every quarter. Dollar outcomes sum four independent accounts, with $600,000 total funding per model.

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

## What this study supports

The clearest differences were **search breadth, willingness to deploy cash, whether models adjusted or replaced holdings, and the conditions they gave for acting**. Identical HOLD labels concealed different exposures and timing. We have evidence for these behaviors in this market sample—not permanent model personalities or a proven best strategy.

Luna 6 replaces Luna 5.6; Terra is excluded. Query coverage and runtime differences limit comparisons. [The viewer](https://mayankbansal12.github.io/paper-trading-bench/) provides the per-model numbers; supporting sessions and methods are expandable below.
