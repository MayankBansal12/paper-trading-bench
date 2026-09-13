import { describe, expect, test } from "bun:test";
import { applyComparisonFlags, COMPARISON_PROFILE_ID, NASDAQ_COMPARISON_PROFILE_ID, getComparisonProfile, validateComparisonConfig } from "../src/config/comparison.ts";
import { AGENT_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION, V6_PROTOCOL_VERSION } from "../src/agent/protocolVersion.ts";
import { EXECUTION_CONVENTION } from "../src/engine/execution.ts";
import { cohortKeyOf } from "../src/report/compare.ts";
import { deriveRunId } from "../src/run/state.ts";
import { runBatch } from "../src/run/orchestrator.ts";
import type { RunConfig } from "../src/domain/types.ts";

const legacyConfig = (): RunConfig => ({ ...getComparisonProfile(COMPARISON_PROFILE_ID).config,
  comparisonProfile: COMPARISON_PROFILE_ID, model: "historical-model", agent: "pi", seed: 1 });
const nasdaqConfig = (): RunConfig => ({ ...getComparisonProfile(NASDAQ_COMPARISON_PROFILE_ID).config,
  comparisonProfile: NASDAQ_COMPARISON_PROFILE_ID, model: "muse-spark-1.3-contributor-free", provider: "opencode", freeOnly: true, agent: "opencode", seed: 1 });

describe("frozen comparison registry", () => {
  test("legacy v6 profile remains immutable and is not reinterpreted as active v7", () => {
    const c = legacyConfig();
    expect(c.protocolVersion).toBe(V6_PROTOCOL_VERSION);
    expect(c.universeVersion).toBe("v2");
    expect(c.fixtureVersion).toBe("79066938c91b2968c034edb8cb8a29bf4b416fac39befead9a28f47dbf6550ea");
    expect(c.behaviorAnalysis).toBeUndefined();
    expect(c.executionConvention).toBe(EXECUTION_CONVENTION);
    expect(() => validateComparisonConfig(c)).not.toThrow();
    expect(() => validateComparisonConfig({ ...c, model: "another", agent: "opencode", provider: "opencode", seed: 2 })).not.toThrow();
  });
  test("Nasdaq profile locks exact data, universe, funding, analysis, prompt, model, and runtime policy", () => {
    const c = nasdaqConfig();
    const profile = getComparisonProfile(NASDAQ_COMPARISON_PROFILE_ID);
    expect(c.protocolVersion).toBe(AGENT_PROTOCOL_VERSION);
    expect(c.universeVersion).toBe("v3");
    expect(c.fixtureVersion).toBe("abc104ae3f2cb258e1c9c9bc996a9f46c14ca83771da5c9acbeb7eaab23b2de7");
    expect(c.limits).toEqual({ maxTurns: 12, maxToolCalls: 20, timeoutMs: 300000 });
    expect(c.startingCapital + c.contributions!.reduce((sum, deposit) => sum + deposit.amount, 0)).toBe(1500);
    expect(c.behaviorAnalysis?.version).toBe("dip-behavior-v1");
    expect(profile.modelPolicy).toEqual({ provider: "opencode", model: "muse-spark-1.3-contributor-free", agent: "opencode", freeOnly: true, clientVersion: "1.18.30" });
    expect(profile.promptProtocol.systemPromptSha256).toBe("3142fe7bb527324545001f6078f49f8d44ae6400c0eb04a20a86140a31eae062");
    expect(() => validateComparisonConfig(c)).not.toThrow();
    for (const patch of [{ model: "other" }, { provider: "other" }, { freeOnly: false }, { agent: "pi" as const }]) {
      expect(() => validateComparisonConfig({ ...c, ...patch })).toThrow(/exact zero-cost model path/);
    }
  });
  test("returned profiles are clones and unknown IDs fail", () => {
    getComparisonProfile(NASDAQ_COMPARISON_PROFILE_ID).config.limits.maxTurns = 999;
    expect(nasdaqConfig().limits.maxTurns).toBe(12);
    expect(() => getComparisonProfile("typo")).toThrow(/Unknown comparison/);
  });
  test("CLI refuses locked overrides and preserves only non-identity selectors", () => {
    for (const id of [COMPARISON_PROFILE_ID, NASDAQ_COMPARISON_PROFILE_ID]) for (const key of ["start", "end", "max-turns", "max-tool-calls", "timeout-ms", "starting-capital", "universe-version", "warmup-bars", "smoke"]) {
      expect(() => applyComparisonFlags(new Map([["comparison", id], [key, "anything"]]))).toThrow(/locks/);
    }
    const flags = new Map([["comparison", NASDAQ_COMPARISON_PROFILE_ID], ["agent", "opencode"], ["seed", "2"], ["model", "muse-spark-1.3-contributor-free"], ["data-dir", "/snapshot"]]);
    applyComparisonFlags(flags);
    expect(flags.get("timeout-ms")).toBe("300000"); expect(flags.get("start")).toBe("2026-06-01");
    expect(flags.get("model")).toBe("muse-spark-1.3-contributor-free"); expect(flags.get("data-dir")).toBe("/snapshot");
  });
  test("mismatched Nasdaq snapshot/settings fail before any agent call", async () => {
    const c = nasdaqConfig();
    for (const patch of [{ fixtureVersion: "a".repeat(64) }, { contributions: [] }, { protocolVersion: LEGACY_PROTOCOL_VERSION },
      { limits: { ...c.limits, timeoutMs: 120000 } }, { warmupBars: 60 }, { agent: "fake" as const }]) {
      expect(() => validateComparisonConfig({ ...c, ...patch })).toThrow();
    }
    let calls = 0;
    await expect(runBatch({ ...c, agent: "fake", fixtureVersion: "wrong" }, { name: "must-not-run", async decide() { calls++; throw new Error("must not run"); } })).rejects.toThrow(/fixtureVersion/);
    expect(calls).toBe(0);
  });
  test("historical live protocols and alternate live model paths are refused before model calls", async () => {
    let calls = 0;
    const c = { ...nasdaqConfig(), comparisonProfile: undefined };
    await expect(runBatch({ ...c, protocolVersion: LEGACY_PROTOCOL_VERSION }, { name: "must-not-run", async decide() { calls++; throw new Error("must not run"); } })).rejects.toThrow(/Legacy live runs are retired/);
    await expect(runBatch({ ...c, model: "paid-or-other" }, { name: "must-not-run", async decide() { calls++; throw new Error("must not run"); } })).rejects.toThrow(/Legacy live runs are retired/);
    expect(calls).toBe(0);
  });
  test("cohorts separate protocols, harnesses, profiles, and analysis rules", () => {
    const c = legacyConfig();
    expect(cohortKeyOf(c)).toBe(cohortKeyOf({ ...c, model: "other", seed: 2 }));
    expect(cohortKeyOf(c)).not.toBe(cohortKeyOf({ ...c, agent: "opencode" }));
    expect(cohortKeyOf(c)).not.toBe(cohortKeyOf({ ...c, protocolVersion: LEGACY_PROTOCOL_VERSION }));
    expect(cohortKeyOf(nasdaqConfig())).not.toBe(cohortKeyOf(c));
    expect(deriveRunId(c)).not.toBe(deriveRunId({ ...c, comparisonProfile: undefined }));
  });
  test("CLI preflight validates fixtures without constructing a live agent or writing run artifacts", () => {
    const process = Bun.spawnSync(["bun", "src/index.ts", "run", "--preflight", "--agent=pi", "--model=not-a-model", "--smoke", "--data-dir=fixtures/ohlcv", "--universe-version=v1", "--start=2024-01-02", "--end=2024-01-03", "--warmup-bars=0"], { stdout: "pipe", stderr: "pipe" });
    expect(process.exitCode).toBe(0);
    const result = JSON.parse(process.stdout.toString());
    expect(result.sessions).toBe(2); expect(result.config.protocolVersion).toBe(AGENT_PROTOCOL_VERSION);
    expect(process.stderr.toString()).toContain("No agent started or run artifacts written");
  });
});
