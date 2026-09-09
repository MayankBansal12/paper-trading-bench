import { applyComparisonFlags, getComparisonProfile, validateComparisonConfig } from "../config/comparison.ts";
import { resolve } from "node:path";
import { parseFlags } from "./args.ts";
import { assertInRange, assertKnownFlags, assertNoPositionals, parseDateFlag, parseIntFlag, parsePositiveFinite, parsePositiveInt } from "./validate.ts";
import { defaultDataDir, defaultWindow, isThreeMonthWindow, MONTHLY_CONTRIBUTION, monthlyDeposits, parseBooleanFlag } from "./experiment.ts";
import type { AgentPort, RunConfig } from "../domain/types.ts";

const DEFAULT_LIMITS = { maxTurns: 12, maxToolCalls: 20, timeoutMs: 120_000 };
export const BENCHMARK_STARTING_CAPITAL = MONTHLY_CONTRIBUTION;
const KNOWN_FLAGS = ["model", "provider", "agent", "seed", "start", "end", "starting-capital", "universe-version", "max-turns", "max-tool-calls", "timeout-ms", "run-id", "data-dir", "warmup-bars", "smoke", "free-only", "comparison", "preflight", "help"] as const;

function printRunUsage(): void {
  console.error("Usage: pnpm run run -- [--provider=opencode] [--model=mimo-v2.5-free] [--agent=opencode|pi|fake]");
  console.error("  --data-dir=<snapshot> --start=YYYY-MM-DD --end=YYYY-MM-DD [--seed=1] [--run-id=<id>]");
  console.error("  [--max-turns=12] [--max-tool-calls=20] [--timeout-ms=120000] [--free-only=true]");
  console.error("  [--comparison=202606-202608-v6] [--preflight]  # frozen settings; validate without a model call");
  console.error("Default: last three completed UTC calendar months; $500 initially and $500 at the start of months 2 and 3.");
  console.error("Historical data with at least 60 warm-up bars is required for a benchmark. Download a snapshot first with data:import.");
  console.error("--smoke permits shorter/synthetic qualification windows. --warmup-bars=0 is allowed only for smoke tests.");
  console.error("--seed is a replicate label, not a model sampling seed. --free-only=false explicitly permits a paid model.");
}

export async function runRun(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) { printRunUsage(); return; }
  const { flags, positionals } = parseFlags(argv);
  assertKnownFlags(flags, KNOWN_FLAGS, "run");
  assertNoPositionals(positionals, "run");
  applyComparisonFlags(flags);
  const preflightOnly = parseBooleanFlag("preflight", flags.get("preflight"));
  const agentKind = flags.get("agent") ?? "opencode";
  if (agentKind !== "fake" && agentKind !== "pi" && agentKind !== "opencode") throw new Error(`--agent must be "fake", "pi", or "opencode", got "${agentKind}"`);
  const smoke = parseBooleanFlag("smoke", flags.get("smoke"));
  const freeOnly = parseBooleanFlag("free-only", flags.get("free-only"), true);
  const defaults = defaultWindow();
  const start = parseDateFlag("start", flags.get("start")) ?? defaults.start;
  const end = parseDateFlag("end", flags.get("end")) ?? defaults.end;
  if (start > end) throw new Error(`--start (${start}) must be <= --end (${end})`);
  const rawCapital = parsePositiveFinite("starting-capital", flags.get("starting-capital"), MONTHLY_CONTRIBUTION);
  const capital = Math.round(rawCapital * 100) / 100;
  assertInRange("starting-capital", capital, 0.01, 1e9);
  const warmupBars = parseIntFlag("warmup-bars", flags.get("warmup-bars"), 100);
  if (!Number.isSafeInteger(warmupBars) || warmupBars < 0) throw new Error("--warmup-bars must be a nonnegative safe integer");
  if (!smoke && (!isThreeMonthWindow(start, end) || capital !== MONTHLY_CONTRIBUTION || warmupBars < 60)) {
    throw new Error("A benchmark requires three complete calendar months, $500 initial capital, and at least 60 warm-up bars. Use --smoke for qualification runs.");
  }
  const provider = flags.get("provider") ?? "opencode";
  const model = flags.get("model") ?? (agentKind === "fake" ? "fake" : "mimo-v2.5-free");
  const limits = {
    maxTurns: parsePositiveInt("max-turns", flags.get("max-turns"), DEFAULT_LIMITS.maxTurns),
    maxToolCalls: parsePositiveInt("max-tool-calls", flags.get("max-tool-calls"), DEFAULT_LIMITS.maxToolCalls),
    timeoutMs: parsePositiveInt("timeout-ms", flags.get("timeout-ms"), DEFAULT_LIMITS.timeoutMs),
  };
  const seed = parseIntFlag("seed", flags.get("seed"), 1);
  if (![seed, ...Object.values(limits)].every(Number.isSafeInteger) || limits.timeoutMs > 2_147_483_647) throw new Error("Seed and limits must be safe integers; timeout must fit a 32-bit timer.");
  const dataDir = resolve(flags.get("data-dir") ?? defaultDataDir(start, end));
  // Delayed imports keep --help and malformed flags independent of fixtures/SDK.
  const { loadDataset, validateDatasetWindow } = await import("../data/dataset.ts");
  const { UNIVERSE_VERSION, getUniverse } = await import("../config/universe.ts");
  const dataset = await loadDataset(dataDir).catch((error) => {
    throw new Error(`Cannot load dataset ${dataDir}. Download it with: pnpm run data:import -- --start=${start} --end=${end} --out=${dataDir}`, { cause: error });
  });
  if (!smoke && dataset.kind !== "historical") throw new Error("A benchmark requires historical data; use --smoke for synthetic fixtures.");
  const universeVersion = flags.get("universe-version") ?? UNIVERSE_VERSION;
  const dates = validateDatasetWindow(dataset, start, end, warmupBars, getUniverse(universeVersion));
  const contributions = monthlyDeposits(dates);
  const { EXECUTION_CONVENTION } = await import("../engine/execution.ts");
  const { AGENT_PROTOCOL_VERSION } = await import("../agent/protocolVersion.ts");
  const config: RunConfig = { model, provider, freeOnly, agent: agentKind, seed, startDate: start, endDate: end, startingCapital: capital,
    universeVersion, limits, executionConvention: EXECUTION_CONVENTION, fixtureVersion: dataset.version,
    protocolVersion: AGENT_PROTOCOL_VERSION, runId: flags.get("run-id"), dataDir, contributions, warmupBars,
    experiment: smoke ? "smoke" : "three-month",
    ...(flags.has("comparison") ? { comparisonProfile: flags.get("comparison") } : {}) };
  validateComparisonConfig(config);
  if (preflightOnly) {
    console.log(JSON.stringify({ config, sessions: dates.length, ...(config.comparisonProfile ? { memory: getComparisonProfile(config.comparisonProfile).memory } : {}) }, null, 2));
    console.error("[preflight] Configuration and dataset validated. No agent started or run artifacts written.");
    return;
  }
  const { FakeAgent } = await import("../agent/fakeAgent.ts");
  const { PiAgent } = await import("../agent/piAgent.ts");
  const { OpenCodeAgent } = await import("../opencode/agent.ts");
  const agent: AgentPort = agentKind === "fake" ? new FakeAgent() : agentKind === "opencode" ? new OpenCodeAgent(model, provider, { freeOnly }) : new PiAgent(model, provider, { freeOnly });
  const { runBatch } = await import("../run/orchestrator.ts");
  console.error(`[run] ${config.experiment} agent=${agent.name} seed=${seed} range=${start}..${end} days=${dates.length} principal=$${capital + contributions.reduce((sum, c) => sum + c.amount, 0)}`);
  const { runId, dir, summary } = await runBatch(config, {
    name: agent.name,
    async decide(context) {
      console.error(`[decision] ${context.date} starting; cash=$${context.portfolio.cash.toFixed(2)} netWorth=$${context.portfolio.netWorth.toFixed(2)}`);
      const decision = await agent.decide(context);
      console.error(`[decision] ${context.date} ${decision.outcome ?? (decision.boundedStop ? "budget_cutoff" : "completed")} tools=${decision.usage.toolCalls} elapsedMs=${decision.elapsedMs ?? 0}`);
      return decision;
    },
  });
  console.error(`[run] runId=${runId} dir=${dir}`);
  if (summary.status !== "completed") process.exitCode = 1;
  console.error(`[run] status=${summary.status} days=${summary.metrics.daysRun} netWorth=$${summary.metrics.endingNetWorth.toFixed(2)} return=${summary.metrics.totalReturnPct.toFixed(2)}% trades=${summary.metrics.tradeCount} failed=${summary.metrics.failedOrderCount}`);
}
