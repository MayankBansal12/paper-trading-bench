// `run` subcommand: runs (or resumes) a batch for one model/seed over a
// configurable date range against the fixed universe.

import { parseFlags } from "./args.ts";
import { assertInRange, assertKnownFlags, assertNoPositionals, parseDateFlag, parseIntFlag, parsePositiveFinite, parsePositiveInt } from "./validate.ts";
import { UNIVERSE_VERSION } from "../config/universe.ts";
import { EXECUTION_CONVENTION } from "../engine/execution.ts";
import { MAX_MONEY_USD, MIN_MONEY_USD } from "../engine/money.ts";
import { round2 } from "../engine/portfolio.ts";
import { FIXTURE_VERSION } from "../data/ohlcv.ts";
import { AGENT_PROTOCOL_VERSION } from "../agent/protocolVersion.ts";
import { runBatch } from "../run/orchestrator.ts";
import { FakeAgent } from "../agent/fakeAgent.ts";
import { PiAgent, DEFAULT_MODEL } from "../agent/piAgent.ts";
import type { AgentPort, RunConfig } from "../domain/types.ts";

const DEFAULT_LIMITS = { maxTurns: 8, maxToolCalls: 20, timeoutMs: 60_000 };
export const BENCHMARK_STARTING_CAPITAL = 1000;

const KNOWN_FLAGS = [
  "model", "agent", "seed", "start", "end", "starting-capital",
  "universe-version", "max-turns", "max-tool-calls", "timeout-ms", "run-id", "help",
] as const;

function printRunUsage(): void {
  console.error("Usage: pnpm run run -- --model=minimax-m3 [--agent=pi|fake] [--seed=1]");
  console.error("                        [--start=YYYY-MM-DD] [--end=YYYY-MM-DD] [--run-id=<id>]");
  console.error("                        [--starting-capital=1000] [--universe-version=v1]");
  console.error("                        [--max-turns=8] [--max-tool-calls=20] [--timeout-ms=60000]");
  console.error("");
  console.error(`The comparable benchmark uses --starting-capital=${BENCHMARK_STARTING_CAPITAL} (the default). A`);
  console.error("different value still runs, but \`report\` will not cohort it against $1,000 runs.");
  console.error(`--starting-capital must be between $${MIN_MONEY_USD} and $${MAX_MONEY_USD} once rounded to cents.`);
  console.error("opencode-go models: minimax-m3, deepseek-v4-pro, ... (any id Pi's catalog resolves)");
}

export async function runRun(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    printRunUsage();
    return;
  }

  const { flags, positionals } = parseFlags(argv);
  assertKnownFlags(flags, KNOWN_FLAGS, "run");
  assertNoPositionals(positionals, "run");

  const agentKind = flags.get("agent") ?? "pi";
  if (agentKind !== "fake" && agentKind !== "pi") {
    throw new Error(`--agent must be "fake" or "pi", got "${agentKind}"`);
  }
  const model = flags.get("model") ?? (agentKind === "fake" ? "fake" : DEFAULT_MODEL);
  const runId = flags.get("run-id");

  // Rounded to 2dp BEFORE bound-checking: cash always rounds to 2dp (see
  // engine/portfolio.ts createInitialPortfolio), so the stored config's
  // startingCapital must match the actual opening cash exactly — a sub-cent
  // --starting-capital could otherwise diverge from createInitialPortfolio's
  // rounded value and from isTerminated()'s threshold check, which both use
  // this field verbatim. Checking the RAW pre-round value against [MIN, MAX]
  // isn't enough either: "0.001" is positive/finite raw but rounds to $0
  // (NaN metrics downstream), and "1e307" is finite raw but round2(1e307)
  // overflows to Infinity — both must be caught on the NORMALIZED value.
  const startingCapital = round2(parsePositiveFinite("starting-capital", flags.get("starting-capital"), BENCHMARK_STARTING_CAPITAL));
  assertInRange("starting-capital", startingCapital, MIN_MONEY_USD, MAX_MONEY_USD);

  const config: RunConfig = {
    model,
    seed: parseIntFlag("seed", flags.get("seed"), 1),
    agent: agentKind,
    startDate: parseDateFlag("start", flags.get("start")),
    endDate: parseDateFlag("end", flags.get("end")),
    startingCapital,
    universeVersion: flags.get("universe-version") ?? UNIVERSE_VERSION,
    limits: {
      maxTurns: parsePositiveInt("max-turns", flags.get("max-turns"), DEFAULT_LIMITS.maxTurns),
      maxToolCalls: parsePositiveInt("max-tool-calls", flags.get("max-tool-calls"), DEFAULT_LIMITS.maxToolCalls),
      timeoutMs: parsePositiveInt("timeout-ms", flags.get("timeout-ms"), DEFAULT_LIMITS.timeoutMs),
    },
    executionConvention: EXECUTION_CONVENTION,
    fixtureVersion: FIXTURE_VERSION,
    protocolVersion: AGENT_PROTOCOL_VERSION,
    runId,
  };

  if (config.startDate && config.endDate && config.startDate > config.endDate) {
    throw new Error(`--start (${config.startDate}) must be <= --end (${config.endDate})`);
  }
  if (config.startingCapital !== BENCHMARK_STARTING_CAPITAL) {
    console.error(
      `[run] WARNING: --starting-capital=${config.startingCapital} differs from the $${BENCHMARK_STARTING_CAPITAL} benchmark default — this run will not be cohorted against $${BENCHMARK_STARTING_CAPITAL} runs by \`report\`.`,
    );
  }

  const agent: AgentPort = agentKind === "fake" ? new FakeAgent() : new PiAgent(model);

  console.error(`[run] agent=${agent.name} seed=${config.seed} range=${config.startDate ?? "earliest"}..${config.endDate ?? "latest"}`);
  const { runId: resolvedRunId, dir, summary } = await runBatch(config, agent);
  console.error(`[run] runId=${resolvedRunId} dir=${dir}`);
  console.error(
    `[run] status=${summary.status} days=${summary.metrics.daysRun} netWorth=$${summary.metrics.endingNetWorth.toFixed(2)} return=${summary.metrics.totalReturnPct.toFixed(2)}% maxDD=${summary.metrics.maxDrawdownPct.toFixed(2)}% sharpe=${summary.metrics.sharpe ?? "n/a"} trades=${summary.metrics.tradeCount} failed=${summary.metrics.failedOrderCount}`,
  );
}
