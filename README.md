# Nasdaq-100 LLM Portfolio-Management Benchmark

The active protocol is **v10-unlimited-turns-portfolio-context**: a sandboxed model makes daily portfolio decisions from historical technical data and records a structured, receipt-linked decision memo. The evaluator joins those pretrade statements to actual fills and outcomes in `journal-review.md`.

See [environment, session context, tools, journal and commands](docs/STUDY_ENVIRONMENT.md).

## Environment

- Bun 1.3.14+, pnpm 11.15.1, official OpenCode client 1.18.30.
- Exact live route: `opencode/muse-spark-1.3-contributor-free`, requalified for zero pricing before inference. No alternate or paid fallback.
- Credential: `OPENCODE_API_KEY` in the host environment / `.env`, or the host authentication store. The real key stays outside the model sandbox.
- Linux Bubblewrap/systemd sandbox, 2 GiB memory, 128 tasks, disposable scratch, and a session-scoped inference/tool gateway.
- Unlimited model turns. Session defaults: 24 attempted tools, 300 seconds including setup; 100 history bars.

```sh
pnpm install --frozen-lockfile
pnpm sandbox:check
pnpm typecheck
pnpm test
pnpm model:preflight
```

A new host needs the privileged sandbox provisioned first with `pnpm sandbox:provision`; see the environment guide for requirements.

## Decisions and grading

The model sees the previous exchange close and earlier history, queues trades before today's open is known, and is valued after execution at today's close. Buy, sell, hold, cash retention, concentration and diversification are permitted. Trading is long-only with fractional shares. News, filings, general browsing, shell and filesystem tools are disabled.

Each daily conversation starts fresh with its current available cash, holdings and portfolio value already loaded. The snapshot includes due contributions/actions, uses observable previous-close marks and supplies a journal evidence receipt without consuming a tool call. Portfolio state persists through the host; committed decision memos persist through journal tools. The final memo must include thesis, receipt-linked evidence, allocation, alternatives, risks, invalidation conditions and changes from the previous thesis. Budget or validation failures execute no orders.

There is no combined intelligence score or LLM judge. Reports keep returns, dollar profit, risk, concentration, cash, turnover, operations and journal activity separate. Citation validation proves provenance, not factual support or hidden reasoning.

## Run and inspect a smoke

The retained market snapshot `datasets/historical/nasdaq100_202606_202608_v2` contains 99 supported securities and June–August 2026 prices plus warm-up. Its manifest hash is `abc104ae3f2cb258e1c9c9bc996a9f46c14ca83771da5c9acbeb7eaab23b2de7`. It is eligible for environment smoke/control checks.

```sh
# Add --preflight=true to validate data/configuration without model calls.
pnpm study:run -- --smoke=true --run-id=my-v10-portfolio-smoke \
  --data-dir=datasets/historical/nasdaq100_202606_202608_v2 \
  --start=2026-07-30 --end=2026-08-03

# Offline replay, no inference.
pnpm study:run -- --verify=results/studies/my-v10-portfolio-smoke
```

Inspect `results/studies/<runId>/journal-review.md`, `summary.json`, `journal/`, `accepted/`, `daily/` and `attempts/`. Attempts retain failures and usage. Resume the same configuration to retry the uncommitted date, at most three attempts per day. Changed code or configuration requires a new run identity.

## Scored studies

Scored quarters require full calendar-quarter coverage, qualified start-of-quarter Nasdaq membership, supported actions without exclusion lists, and a separately frozen NDX price-index archive. Four quarters run with independent portfolio/journal resets. Each starts with $500 and receives $500 at the start of months two and three. Cash, equal-weight holdings and a matched-funded NDX account provide references.

The study year and qualified quarter/NDX archives have not been selected/imported. The June–August snapshot is not a full calendar quarter. See the [study requirements](docs/STUDY_ENVIRONMENT.md#quarter-and-year-qualification).

Previous `results/runs` directories were cleared at user request on 2026-09-13. Older studies, reports and qualification evidence remain historical; they are not v10 results. [Historical validation](docs/VALIDATION.md) documents the former Muse/MiMo runs. Legacy live entrypoints are retired.

The simulator omits fees, spreads, slippage, market impact and taxes. Retrospective data revisions and pretrained historical knowledge remain limitations. Smoke results establish environment operation, not financial strategy performance.
