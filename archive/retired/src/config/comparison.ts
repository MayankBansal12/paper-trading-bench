import type { BehaviorAnalysisRules, RunConfig } from "../domain/types.ts";
import { AGENT_PROTOCOL_VERSION, MAX_RATIONALE_CHARS, RECENT_DAY_LIMIT, V6_PROTOCOL_VERSION } from "../agent/protocolVersion.ts";

/** Historical identity: never edit or reinterpret. */
export const COMPARISON_PROFILE_ID = "202606-202608-v6";
export const NASDAQ_COMPARISON_PROFILE_ID = "nasdaq100-20260601-20260831-v7";
export const DEFAULT_COMPARISON_PROFILE_ID = NASDAQ_COMPARISON_PROFILE_ID;

export const NASDAQ_BEHAVIOR_RULES: BehaviorAnalysisRules = Object.freeze({
  version: "dip-behavior-v1",
  reference: "equal-weight-buy-and-hold",
  dailyLossThresholdPct: 2,
  drawdownThresholdPct: 5,
  cooldownSessions: 5,
  forwardSessions: 5,
  liquidityMetric: "filled-shares-over-session-volume",
});

type LockedConfig = Pick<RunConfig, "startDate" | "endDate" | "startingCapital" | "universeVersion" | "warmupBars" | "experiment" | "limits" | "contributions" | "fixtureVersion" | "executionConvention" | "protocolVersion"> & Pick<RunConfig, "behaviorAnalysis">;
export interface ComparisonProfile {
  id: string;
  description: string;
  dataDir: string;
  config: LockedConfig;
  memory: { recentDays: number; maxRationaleChars: number };
  promptProtocol: { version: string; systemPromptSha256: string; representativeDailyPromptSha256: string };
  modelPolicy?: { provider: "opencode"; model: string; agent: "opencode"; freeOnly: true; clientVersion: string };
}

const PROFILES: Readonly<Record<string, ComparisonProfile>> = Object.freeze({
  [COMPARISON_PROFILE_ID]: Object.freeze({
    id: COMPARISON_PROFILE_ID,
    description: "Immutable legacy 49-security v6 comparison.",
    dataDir: "datasets/historical/202606_202608",
    config: Object.freeze({
      startDate: "2026-06-01", endDate: "2026-08-31", startingCapital: 500,
      universeVersion: "v2", warmupBars: 100, experiment: "three-month",
      limits: Object.freeze({ maxTurns: 12, maxToolCalls: 20, timeoutMs: 300_000 }),
      contributions: [{ date: "2026-07-01", amount: 500 }, { date: "2026-08-03", amount: 500 }],
      fixtureVersion: "79066938c91b2968c034edb8cb8a29bf4b416fac39befead9a28f47dbf6550ea",
      executionConvention: "asof-before-D_exec-open-D_eod-close-D_v8",
      protocolVersion: V6_PROTOCOL_VERSION,
      behaviorAnalysis: undefined,
    }),
    memory: Object.freeze({ recentDays: 5, maxRationaleChars: 1200 }),
    promptProtocol: Object.freeze({
      version: V6_PROTOCOL_VERSION,
      systemPromptSha256: "a452ac7af54a4a8be72648504e45047f15982630f7b8f8bd4df4e47fd02c92fe",
      representativeDailyPromptSha256: "1456f4bfc88672aed679643842b22bd250c3bac38a103661eba46dea60bda839",
    }),
  }),
  [NASDAQ_COMPARISON_PROFILE_ID]: Object.freeze({
    id: NASDAQ_COMPARISON_PROFILE_ID,
    description: "Nasdaq-100 start-of-period supported-security benchmark, June-August 2026.",
    dataDir: "datasets/historical/nasdaq100_202606_202608_v2",
    config: Object.freeze({
      startDate: "2026-06-01", endDate: "2026-08-31", startingCapital: 500,
      universeVersion: "v3", warmupBars: 100, experiment: "three-month",
      limits: Object.freeze({ maxTurns: 12, maxToolCalls: 20, timeoutMs: 300_000 }),
      contributions: [{ date: "2026-07-01", amount: 500 }, { date: "2026-08-03", amount: 500 }],
      fixtureVersion: "abc104ae3f2cb258e1c9c9bc996a9f46c14ca83771da5c9acbeb7eaab23b2de7",
      executionConvention: "asof-before-D_exec-open-D_eod-close-D_v8",
      protocolVersion: AGENT_PROTOCOL_VERSION,
      behaviorAnalysis: NASDAQ_BEHAVIOR_RULES,
    }),
    memory: Object.freeze({ recentDays: RECENT_DAY_LIMIT, maxRationaleChars: MAX_RATIONALE_CHARS }),
    promptProtocol: Object.freeze({
      version: AGENT_PROTOCOL_VERSION,
      systemPromptSha256: "3142fe7bb527324545001f6078f49f8d44ae6400c0eb04a20a86140a31eae062",
      representativeDailyPromptSha256: "3f254137e16f44fb48b6a7fd28650ad6c512cc9c642f26bd70998d927b725ef9",
    }),
    modelPolicy: Object.freeze({
      provider: "opencode", model: "muse-spark-1.3-contributor-free", agent: "opencode", freeOnly: true, clientVersion: "1.18.30",
    }),
  }),
});

export const COMPARISON_PROFILE_IDS = Object.freeze(Object.keys(PROFILES));

export function getComparisonProfile(id: string): ComparisonProfile {
  const profile = PROFILES[id];
  if (!profile) throw new Error("Unknown comparison profile: " + id + ". Available: " + COMPARISON_PROFILE_IDS.join(", "));
  return structuredClone(profile);
}

/** Apply locked settings before ordinary CLI parsing; reject overrides instead of silently ignoring them. */
export function applyComparisonFlags(flags: Map<string, string>): void {
  const id = flags.get("comparison");
  if (id === undefined) return;
  const { config } = getComparisonProfile(id);
  const locked = {
    start: config.startDate!, end: config.endDate!, "starting-capital": String(config.startingCapital),
    "universe-version": config.universeVersion, "warmup-bars": String(config.warmupBars), smoke: "false",
    "max-turns": String(config.limits.maxTurns), "max-tool-calls": String(config.limits.maxToolCalls), "timeout-ms": String(config.limits.timeoutMs),
  };
  for (const [key, value] of Object.entries(locked)) {
    if (flags.has(key)) throw new Error("Comparison " + id + " locks --" + key + "; omit that override or run without --comparison");
    flags.set(key, value);
  }
}

/** Validate actual loaded config, including callers bypassing the CLI. */
export function validateComparisonConfig(config: RunConfig): void {
  if (config.comparisonProfile === undefined) return;
  const profile = getComparisonProfile(config.comparisonProfile);
  for (const [key, expected] of Object.entries(profile.config)) {
    if (JSON.stringify(config[key as keyof RunConfig]) !== JSON.stringify(expected)) {
      throw new Error("Comparison " + profile.id + " requires " + key + "=" + JSON.stringify(expected) + "; actual configuration differs");
    }
  }
  if (config.agent === "fake") throw new Error("Comparison profiles require a model adapter; use a separately labeled deterministic control");
  if (profile.modelPolicy) {
    const policy = profile.modelPolicy;
    if (config.provider !== policy.provider || config.model !== policy.model || config.agent !== policy.agent || config.freeOnly !== policy.freeOnly) {
      throw new Error("Comparison " + profile.id + " requires exact zero-cost model path " + policy.provider + "/" + policy.model + " via the official OpenCode client");
    }
  }
}
