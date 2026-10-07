# Same tools, different habits

Twelve models each managed four separate quarterly accounts from April 2025 to March 2026: 251 trading days and $600,000 of total funding per model. Every day was a fresh session. We compare their recorded actions and explanations, not private reasoning.

<h2 id="latest-results">Updated October 7, 2026</h2>

**Sol 6.1 and Sonnet 5.5 are now included with complete session evidence.** Their profits were $13,746.63 and $25,482.34. All 48 quarterly accounts reconcile. Two additions change the story: Sol 6.1 joins Astra as a defensive model that gained in the final quarter; Sonnet 5.5 placed second without requesting market data or making a single sale.

## What each session starts with

The opening context supplies cash, held stocks' units, average costs and previous closes, the 96 eligible stock names, and up to three recent journals. **It supplies no prices for unheld stocks and no news.** Older prices may appear in the model's own notes. `market_snapshot` returns previous closes; `price_history` returns daily bars; `journal` searches older notes. `submit_day` ends the day with orders and a journal.

At each quarter's first session, holdings and journals are empty. A model that submits buys before making a query has chosen its basket without supplied price data.

## A typical day

Three workflows dominated, with different versions sometimes behaving very differently.

<!-- workflow-table -->

- **Check a shortlist, then decide.** Astra used exactly History → Submit on 208/251 days, Muse on 185/250, Sol 6.1 on 162/250 and Sonnet 5 on 135/251. Opus 5 and Luna also usually started with history but more often made another request.
- **Scan widely, then investigate.** Sol 5.6 and Sol 6 usually opened with all 96 previous closes, then requested history for a shortlist. That exact sequence occurred on 87 and 94 days. DeepSeek made more follow-ups: a median five calls per day, the most in the sample.
- **Act from the supplied context.** Sonnet 5.5 made **253 calls across 251 sessions, all submissions**. Two were corrections within a session. It bought on 14 days and held on 237. Opus 5.5 made no research call on 195 days: 178 holds and 17 trades. GLM's 31 query-free days were all holds.

`price_history` was the favorite research tool for ten models. Opus 5.5 slightly favored snapshots; Sonnet 5.5 made no research calls. History depth also differed: Sol 5.6 requested at least 20 bars in 96% of its history requests, Luna in 84%, Sol 6.1 in 64%, Sonnet 5 in 9% and Opus 5 in 5%.

**Turns measure interaction, not depth of thought.** A recorded model request can produce several tool calls. Valid-day averages range from Sonnet 5.5's 1.01 turns to DeepSeek's 3.52. More exchanges do not establish better research or decisions.

## Did they revisit their journals?

**Rarely beyond the supplied notes.** GLM requested extra journals on 20/250 valid days and Sol 5.6 on 17/250. Every other model did so on twelve days or fewer; neither Sonnet did. Automatic preloading is directly checked for seven models and follows the recorded protocol for the other five. Availability does not prove use.

Nine of twelve used the dedicated stock filter. Sol 5.6 made the most requests: **33 on 16 days**, compared with Sol 6.1's 15 on 11 and Astra's 9 on 7. DeepSeek searched stock symbols through keywords instead. Results were paginated with a 12,000-character note budget, so a request did not necessarily retrieve every entry. No accepted session asked for a later page.

<!-- journal-table -->

## What came before a trade?

**Sonnet 5.5 shows that querying was optional.** On [January 2](https://mayankbansal12.github.io/paper-trading-bench/study.html#case-sonnet55-start), it wrote “First session: no analysis done” and bought $10,000 each of Alphabet, Microsoft, Broadcom and Costco. Twelve of its fourteen buying days were quarter openings or monthly deposit days. On [March 2](https://mayankbansal12.github.io/paper-trading-bench/study.html#case-sonnet55-deposit), it added $48,000 to existing holdings after receiving $50,000. Held-stock marks were available, but it never requested price history. This was a model-selected buy-and-hold approach, not a predefined passive benchmark.

Opus 5.5 sometimes compared held marks with written price triggers: “MU closed 219 (>215 partial-profit rule)” ([October 27](https://mayankbansal12.github.io/paper-trading-bench/study.html#case-opus55-rule)). It also opened AAPL and WMT positions [without querying either stock's price that day](https://mayankbansal12.github.io/paper-trading-bench/study.html#case-opus55-wmt). These records show actions and stated explanations, not everything the model considered.

**All eleven models with queried history bought more often after a sharp rise than a sharp fall, and sold more often after a sharp fall.** Sonnet 5.5 has no observations for this comparison. Sol 6.1 bought after 17/195 observed rises of at least 3%, versus 0/147 falls, and sold after 42/147 falls.

<!-- price-table -->

The unit is a *covered ticker-day*: one stock on a day with at least two returned bars. Change compares the last two closes. Purchases include additions; partial sales count. Models selected what to query, so the comparison is conditional, not a controlled test. Sparse queries cannot describe Opus 5.5's entire year. Sonnet 5 bought after sharp falls most often: 9/120 observations, still less often than after rises (38/118).

## Stated rules and follow-through

Astra and Sol 6.1 both bought $4,000 of NVDA on May 8 after observing a close of 117.06. [Astra](https://mayankbansal12.github.io/paper-trading-bench/study.html#case-astra) cited clearance of 115; [Sol 6.1](https://mayankbansal12.github.io/paper-trading-bench/study.html#case-sol61-entry) described a recovery breakout, sized it as a pilot and specified review levels. That is a concrete similarity, not proof of a shared decision process.

Rules could also leave room for judgment. [Sol 5.6](https://mayankbansal12.github.io/paper-trading-bench/study.html#case-sol) exited MU below its 157 threshold despite realizing a $1,651 gain. [Opus 5](https://mayankbansal12.github.io/paper-trading-bench/study.html#case-opus) postponed a LIN trim and moved its trigger. [DeepSeek](https://mayankbansal12.github.io/paper-trading-bench/study.html#case-deepseek) bought NVDA below its earlier 190 entry line. On [March 31](https://mayankbansal12.github.io/paper-trading-bench/study.html#case-sol61-exit), Sol 6.1 exited MRVL after a breach of its review threshold rather than waiting for the lower exit threshold, citing a failed breakout.

The retained 30 hand-picked cases from the original ten models contain 22 aligned actions, six discretionary changes and two execution mismatches. This is illustration, not a compliance rate. The new examples above are outside that sample.

## Consistency depends on what we measure

**Astra remains the only model profitable in all four quarters.** Its profits were $8,876, $2,058, $2,446 and $2,441. It had the lowest quarterly TWR variation, 56.5% average cash and the smallest worst-quarter drawdown, 3.75%.

**Sol 6.1 was also defensive.** It averaged 46.7% cash; its largest issuer position reached 16.6% of equity, and its worst-quarter drawdown was 3.96%. Compared with Sol 6, full exits fell from 121 to 54 while trims rose from 6 to 53. Its smaller profit came with less invested exposure and smaller drawdowns in this sample; this does not isolate stock-selection skill.

**The market period changed the ranking.** All twelve made money in Q2 and Q3 2025. Q4 had four profitable models; Q1 had just two: Astra and Sol 6.1. Summing Q2–Q3 versus Q4–Q1 profits, Opus 5 fell from first to eleventh (+$42,563 then −$9,980). Astra rose from twelfth to first (+$10,934 then +$4,886), and Sol 6.1 from eleventh to second. These are separate accounts, not a continuous portfolio.

Some habits persisted: Sol 5.6 made only full exits, Astra held about 54–58% cash each quarter, and Sonnet 5.5 never sold. Others shifted: GLM's average cash rose from 13% and 8% in the first two quarters to 30% and 55% later. Different outcomes can reflect changing exposure, price conditions or decisions; one run cannot separate their causes.

## Distinct approaches

| Approach | Models | What the records show |
|---|---|---|
| Scan broadly, replace positions | Sol 5.6, Sol 6 | Whole-universe close scans; Sol 5.6's 108 sales were all exits. Sol 6 added and re-entered more. |
| Select strength, retain cash | Sol 6.1 | 47% average cash, 54 exits and 53 trims; history preceded every fill. |
| Frequent rotation | DeepSeek | 197 trading days, 650 fills; bought on 70 of 129 selling days. |
| Stay invested, stage purchases | Opus 5 | 14% average cash, 556 fills; bought on 63 of 112 selling days. |
| Hold a core with written triggers | Opus 5.5 | 206 holds; occasional sales, with no same-day purchases. |
| Resize a concentrated core | Luna 6 | 133 additions, 54 trims and five exits. |
| Add to chosen holdings | Sonnet 5, GLM Flash | 184 and 108 additions, respectively. |
| Buy mainly when funded, then hold | Sonnet 5.5 | 62 purchases, no sales or research calls; 237 holds. |
| Confirm, start small, keep cash | Astra 6 | 57% average cash, stable across quarters; small threshold-based entries in the cited examples. |
| Wait, then buy selectively | Muse 1.3 | 192 holds, 60% average cash and only eleven additions. |

These are observed habits, not permanent model personalities. Versions and client/source revisions differ.

## Cash, concentration and activity are different risks

**Cash does not guarantee diversification.** Muse kept the most average cash, yet its largest issuer reached 46.9% of the whole account. Astra's largest was 16.35%. The amount invested and how it is spread are separate choices.

**Quiet trading does not mean low exposure.** Sonnet 5.5 kept 85.4% invested, traded only fourteen days and had the deepest quarterly drawdown, 12.05%. Opus 5.5 kept 86.7% invested with a Q1 drawdown of 11.51%. Meanwhile Opus 5 and DeepSeek both traded about 10% of equity daily but finished first and last. Turnover measures activity, not quality; with no simulated fees, it is not an incurred trading-cost penalty.

## Profit: selling losers, keeping winners

The objective was total account value, not realized profit alone.

<!-- pnl-table -->
| Model | Realized | Unrealized | Dividends | Net profit |
|---|---:|---:|---:|---:|
| Opus 5 | $-13,244 | $44,951 | $875 | $32,583 |
| Sonnet 5.5 | $0 | $24,982 | $501 | $25,482 |
| Sol 6 | $-12,684 | $37,084 | $930 | $25,329 |
| Opus 5.5 | $-7,129 | $30,988 | $644 | $24,502 |
| Luna 6 | $-4,768 | $28,957 | $227 | $24,416 |
| Sol 5.6 | $-7,732 | $30,373 | $831 | $23,473 |
| GLM 5.3 Flash | $-10,771 | $32,968 | $408 | $22,604 |
| Astra 6 | $-886 | $16,501 | $206 | $15,820 |
| Sonnet 5 | $-10,418 | $25,647 | $535 | $15,764 |
| Sol 6.1 | $-5,441 | $18,769 | $419 | $13,747 |
| Muse Spark 1.3 | $-4,474 | $17,524 | $67 | $13,118 |
| DeepSeek 4.1 Flash | $-16,791 | $27,872 | $421 | $11,502 |
<!-- /pnl-table -->

**Eleven models had negative realized trading P&L but positive net profit.** Open gains and dividends outweighed losses realized on sales. Sonnet 5.5 is the exception: no sales meant **$0 realized**, with $24,982 open gains and $501 dividends.

Astra's **−$886 net realized P&L** was the smallest net realized loss: $7,803 of gains offset $8,689 of losses. Its losing trades did not cost just $886.

<!-- sell-selection-table -->

**All eleven sellers more readily sold holdings marked below cost.** On selling days, Sol 6.1 sold 71/185 losing position observations versus 36/522 gaining ones; Sol 5.6 sold 85/378 versus 23/766. These compare the previous close with opening average cost. Execution at the next open can change the sign, and selling while buying does not prove the proceeds funded the purchase.

Ten of the eleven sellers had more losing sales than winning ones. Luna was the exception: 33 wins and 26 losses, mostly partial trims. Sol 5.6's 26 winning exits averaged about $816, versus $353 lost on its 82 losing exits. Models were not forced to sell at quarter-end: remaining holdings were valued instead. Liquidating at those marks would reclassify open gains as realized.

## What this supports—and what it cannot

- Versions differed in research, exposure and position management. Sol 6.1 was more defensive than Sol 6; Sonnet 5.5 eliminated research and selling compared with Sonnet 5.
- More queries did not correspond to higher profit: query-free Sonnet 5.5 placed second, while the most active researcher, DeepSeek, finished last. That is not evidence that research is harmful.
- Positive profit does not establish an advantage over passive investing. No predefined buy-and-hold comparison is included. Four quarters and one selected run per model do not establish a stable ranking.

**Tools exposed only past market data, but some journals introduced unsupported news and fundamental explanations. The experiment cannot rule out training-data familiarity or isolate its effect on decisions.**

Examples include [Opus 5's tariff reference](https://mayankbansal12.github.io/paper-trading-bench/index.html#sessions/opus-5/2025-04-03), [DeepSeek's earnings calendar](https://mayankbansal12.github.io/paper-trading-bench/index.html#sessions/deepseek-4-1-flash/2025-04-24), and [Sonnet 5's earnings explanations](https://mayankbansal12.github.io/paper-trading-bench/index.html#sessions/sonnet-5/2025-11-03). The tools supplied none of this news. These could be prior knowledge, inference or hallucination; they do not establish future-price knowledge or deliberate cheating.

<details><summary>Selection and run details</summary>

Opus 5's newer Q2 repeat was selected after both results were known; the original made $26,578 and the selected one $22,130. Opus 5.5 includes seven supplemental dates after three invalid original days, which remain preserved. Sonnet 5's final twenty dates used a recorded continuation. Luna 6 replaces Luna 5.6; Terra is excluded.

All attempts and five selected invalid days remain, including Sol 6.1's December 17 non-submission. Recoverable tool errors are separate from invalid days. The October import rechecked event/day chains, actual journal context, exact accepted model/effort and archive checksums. The original replay/review outputs are retained; this import made no new inference or runtime replay. Clients, revisions and request-size limits differ; see [Methodology](METHODOLOGY.md).

</details>
