# Paper Trading Bench

A paper-trading benchmark for studying how language models invest: what they buy,
sell and hold, how they use tools and journals, and how their portfolios perform.

Each model runs four independent quarters from April 2025 through March 2026:
251 trading sessions and $600,000 in total funding. Every day starts a fresh agent
session with its portfolio, past prices and three recent journals. Orders execute
at the next open; portfolios are valued at the close.

## Run locally

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm test:supervisor
```

[Setup](docs/SETUP.md) covers clients, login, data, sandbox checks and supervised
runs. [Methodology](docs/METHODOLOGY.md) defines the experiment and accounting.

```sh
# Validate a full year without making model calls.
pnpm bench eval --eval-id example --data-dir /path/to/dataset \
  --models pi/openai-codex/gpt-6-luna --concurrency=1 --preflight=true

# Run a three-day smoke, then the annual evaluation after verification.
pnpm supervise --id example --data-dir /path/to/dataset \
  --model pi/openai-codex/gpt-6-luna

# Inspect local raw runs.
pnpm viewer --port 4173
```

Run from a clean commit. Keep the same source, runtime, data and arguments when
resuming. Raw sessions and datasets stay outside Git; published results use
compact evidence with source identities and archive checksums.

Changes go through pull requests. See [AGENTS.md](AGENTS.md).
