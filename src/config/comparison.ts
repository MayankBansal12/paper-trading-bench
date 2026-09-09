import type { RunConfig } from "../domain/types.ts";
import { AGENT_PROTOCOL_VERSION, MAX_RATIONALE_CHARS, RECENT_DAY_LIMIT } from "../agent/protocolVersion.ts";

/** Immutable experiment identity; a different window/snapshot/protocol needs a new profile ID. */
export const COMPARISON_PROFILE_ID = "202606-202608-v6";
const PROFILE = {
  id: COMPARISON_PROFILE_ID,
  config: {
    startDate: "2026-06-01", endDate: "2026-08-31", startingCapital: 500,
    universeVersion: "v2", warmupBars: 100, experiment: "three-month",
    limits: { maxTurns: 12, maxToolCalls: 20, timeoutMs: 300_000 },
    contributions: [{ date: "2026-07-01", amount: 500 }, { date: "2026-08-03", amount: 500 }],
    fixtureVersion: "79066938c91b2968c034edb8cb8a29bf4b416fac39befead9a28f47dbf6550ea",
    executionConvention: "asof-before-D_exec-open-D_eod-close-D_v8",
    protocolVersion: "v6-explicit-timing-bounded-memory",
  } satisfies Partial<RunConfig>,
  memory: { recentDays: 5, maxRationaleChars: 1200 },
};

export function getComparisonProfile(id: string): typeof PROFILE {
  if (id !== PROFILE.id) throw new Error(`Unknown comparison profile: ${id}. Available: ${PROFILE.id}`);
  if (PROFILE.config.protocolVersion !== AGENT_PROTOCOL_VERSION || PROFILE.memory.recentDays !== RECENT_DAY_LIMIT || PROFILE.memory.maxRationaleChars !== MAX_RATIONALE_CHARS) {
    throw new Error("Comparison profile requires its original runtime protocol; create a new profile for changed rules");
  }
  return structuredClone(PROFILE);
}

/** Apply locked settings before ordinary CLI parsing; reject overrides instead of silently ignoring them. */
export function applyComparisonFlags(flags: Map<string, string>): void {
  const id = flags.get("comparison");
  if (id === undefined) return;
  const { config } = getComparisonProfile(id);
  const locked = {
    start: config.startDate, end: config.endDate, "starting-capital": String(config.startingCapital),
    "universe-version": config.universeVersion, "warmup-bars": String(config.warmupBars), smoke: "false",
    "max-turns": String(config.limits.maxTurns), "max-tool-calls": String(config.limits.maxToolCalls), "timeout-ms": String(config.limits.timeoutMs),
  };
  for (const [key, value] of Object.entries(locked)) {
    if (flags.has(key)) throw new Error(`Comparison ${id} locks --${key}; omit that override or run without --comparison`);
    flags.set(key, value);
  }
}

/** Validate the actual loaded snapshot/config, including callers bypassing the CLI. */
export function validateComparisonConfig(config: RunConfig): void {
  if (config.comparisonProfile === undefined) return;
  const profile = getComparisonProfile(config.comparisonProfile);
  for (const [key, expected] of Object.entries(profile.config)) {
    if (JSON.stringify(config[key as keyof RunConfig]) !== JSON.stringify(expected)) {
      throw new Error(`Comparison ${profile.id} requires ${key}=${JSON.stringify(expected)}; actual configuration differs`);
    }
  }
  if (config.agent === "fake") throw new Error("Comparison profiles require a model adapter; use unprofiled smoke runs for fake controls");
}
