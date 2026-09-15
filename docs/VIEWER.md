# Model, quarter and session viewer

```sh
bun scripts/visualizer.ts --port 4173 --dir results/studies
```

The dark-only viewer refreshes every five seconds. The sidebar lists model cohorts;
select one for its year overview, select a quarter for its timeline and accounting,
then select a session to inspect the committed journal, portfolio, executed/rejected
orders and every attempt's tool arguments and responses. Unfinished and unattempted
sessions are also selectable. Tool results are paired within their originating
attempt; discarded submissions are shown separately from the committed journal.

Model identities come from each run's `manifest.json`. New routes appear without
adding a hardcoded model name to the UI. Separate launch prefixes, datasets, model
routes and implementation/protocol identities are separate cohorts. Independent
quarter runs use a common run-ID prefix followed by `-2025-Q2`, `-2025-Q3`,
`-2025-Q4`, or `-2026-Q1`; the annual launcher already generates this convention.
Symbolic links to run directories in another local worktree are supported.

## Reading the numbers

- Starting capital comes from the recorded ledger, including for older cohorts.
- Deposits increase principal, not profit. Day P/L excludes that day's deposit.
- Return on principal and time-weighted return (TWR) have separate labels.
- The year result requires exactly one complete run for each of the four fixed
  quarters. Missing, stopped, duplicated and unfinished quarters leave it unavailable.
  Partial profit remains visible as **Profit to date**.
- Quarterly portfolios are independent. Year profit is their summed profit; mean
  quarterly TWR is an arithmetic mean, not a compounded annual return.
- Invalid days are accounted separately from deliberate model holds. Tool totals
  include all attempts for committed days; unfinished-day calls remain in session detail.
- **Last recorded activity** is a log timestamp. An incomplete run or a running
  refresh timer does not prove that the model process is alive.

The viewer derives read-only views; it does not verify event-chain integrity. Use
`pnpm bench verify --dir results/studies/RUN_ID` with the run's pinned source for
verification. A partial final event line is deferred until the next refresh;
malformed complete event lines produce an error instead of silently disappearing.
The HTTP server streams audit-log reads and caches completed snapshots so archived
runs do not get reparsed on every refresh.
