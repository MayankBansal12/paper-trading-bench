# Paper Trading Bench

How do language models invest when they have the same trading tools?

**[Results & session viewer](https://mayankbansal12.github.io/paper-trading-bench/)** ·
**[Behavior study](https://mayankbansal12.github.io/paper-trading-bench/study.html)** ·
[Methodology](docs/METHODOLOGY.md) · [Setup](docs/SETUP.md)

Ten models, four independent quarterly accounts, April 2025–March 2026. Each model
has 251 sessions and $600,000 in total funding. Every day starts a fresh agent
session with its portfolio, previous prices and three recent journals. Orders
execute at the next open; holdings are valued at the close.

## Explore locally

```sh
pnpm install --frozen-lockfile
pnpm results:check
pnpm viewer:build
pnpm viewer                 # http://127.0.0.1:4173
```

The viewer reads [compact evidence](results/README.md), including all selected
sessions and failed attempts. Results are sorted by net profit. Raw provider logs,
datasets and credentials stay outside Git.

## Run a model

Follow [Setup](docs/SETUP.md) to pin a native client, qualify the sandbox and obtain
the frozen data. A supervised run checks a three-day smoke before the annual.
Run from a clean commit; resuming requires the recorded source and runtime.

```sh
pnpm supervise --id example --model pi/openai-codex/gpt-6-luna \
  --data-dir /path/to/dataset
```

Use `pnpm viewer:raw --port 4174` to inspect local raw runs. Checks:
`pnpm typecheck`, `pnpm test`, `pnpm test:supervisor`, `pnpm results:check`.

These results describe one market sample, not a stable ranking. Selection and
continuation differences are disclosed in the [results manifest](results/current/manifest.json).
Changes go through pull requests; see [AGENTS.md](AGENTS.md).
