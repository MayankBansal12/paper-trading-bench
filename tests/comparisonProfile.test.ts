import { describe, expect, test } from "bun:test";
import { applyComparisonFlags, COMPARISON_PROFILE_ID, getComparisonProfile, validateComparisonConfig } from "../src/config/comparison.ts";
import { AGENT_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION } from "../src/agent/protocolVersion.ts";
import { EXECUTION_CONVENTION } from "../src/engine/execution.ts";
import { cohortKeyOf } from "../src/report/compare.ts";
import { deriveRunId } from "../src/run/state.ts";
import { runBatch } from "../src/run/orchestrator.ts";
import type { RunConfig } from "../src/domain/types.ts";

const config = (): RunConfig => ({ ...getComparisonProfile(COMPARISON_PROFILE_ID).config,
  comparisonProfile: COMPARISON_PROFILE_ID, model: "test", agent: "pi", seed: 1 });
describe("frozen comparison settings", () => {
  test("pins protocol, execution, dataset, calendar, funding and budgets", () => {
    const c = config();
    expect(c.protocolVersion).toBe(AGENT_PROTOCOL_VERSION);
    expect(c.executionConvention).toBe(EXECUTION_CONVENTION);
    expect(c.limits).toEqual({ maxTurns: 12, maxToolCalls: 20, timeoutMs: 300000 });
    expect(c.startingCapital + c.contributions!.reduce((n, d) => n + d.amount, 0)).toBe(1500);
    expect(c.fixtureVersion).toMatch(/^[a-f0-9]{64}$/);
    expect(() => validateComparisonConfig(c)).not.toThrow();
    expect(() => validateComparisonConfig({ ...c, model: "another", agent: "opencode", provider: "opencode", seed: 2 })).not.toThrow();
    expect(() => getComparisonProfile("typo")).toThrow(/Unknown comparison/);
  });
  test("cannot mutate the shared preset through a returned copy", () => {
    getComparisonProfile(COMPARISON_PROFILE_ID).config.limits.maxTurns = 999;
    expect(config().limits.maxTurns).toBe(12);
  });
  test("CLI refuses overrides and only fills the locked flags", () => {
    for (const key of ["start", "end", "max-turns", "max-tool-calls", "timeout-ms", "starting-capital", "universe-version", "warmup-bars", "smoke"]) {
      expect(() => applyComparisonFlags(new Map([["comparison", COMPARISON_PROFILE_ID], [key, "anything"]]))).toThrow(/locks/);
    }
    const flags = new Map([["comparison", COMPARISON_PROFILE_ID], ["agent", "pi"], ["seed", "2"], ["model", "another"], ["data-dir", "/snapshot"]]);
    applyComparisonFlags(flags);
    expect(flags.get("timeout-ms")).toBe("300000"); expect(flags.get("start")).toBe("2026-06-01");
    expect(flags.get("model")).toBe("another"); expect(flags.get("data-dir")).toBe("/snapshot");
  });
  test("mismatched snapshot and settings fail closed, including the API path before any agent call", async () => {
    const c = config();
    for (const patch of [{ fixtureVersion: "a".repeat(64) }, { contributions: [] }, { protocolVersion: LEGACY_PROTOCOL_VERSION },
      { limits: { ...c.limits, timeoutMs: 120000 } }, { warmupBars: 60 }, { agent: "fake" as const }]) {
      expect(() => validateComparisonConfig({ ...c, ...patch })).toThrow();
    }
    let calls = 0;
    await expect(runBatch({ ...c, fixtureVersion: "wrong" }, { name: "must-not-run", async decide() { calls++; throw new Error("must not run"); } })).rejects.toThrow(/fixtureVersion/);
    expect(calls).toBe(0);
  });
  test("legacy live protocols are refused before a model call, even without a profile", async () => {
    let calls = 0;
    await expect(runBatch({ ...config(), comparisonProfile: undefined, protocolVersion: LEGACY_PROTOCOL_VERSION },
      { name: "must-not-run", async decide() { calls++; throw new Error("must not run"); } })).rejects.toThrow(/historical protocols are available for report replay only/);
    expect(calls).toBe(0);
  });
  test("cohorts separate protocols and harnesses while allowing different models/replicates", () => {
    const c = config();
    expect(cohortKeyOf(c)).toBe(cohortKeyOf({ ...c, model: "other", seed: 2 }));
    expect(cohortKeyOf(c)).not.toBe(cohortKeyOf({ ...c, agent: "opencode" }));
    expect(cohortKeyOf(c)).not.toBe(cohortKeyOf({ ...c, protocolVersion: LEGACY_PROTOCOL_VERSION }));
    expect(deriveRunId(c)).not.toBe(deriveRunId({ ...c, comparisonProfile: undefined }));
  });
  test("CLI preflight validates fixtures without constructing a live agent or writing run artifacts", () => {
    const p = Bun.spawnSync(["bun", "src/index.ts", "run", "--preflight", "--agent=pi", "--model=not-a-model", "--smoke", "--data-dir=fixtures/ohlcv", "--universe-version=v1", "--start=2024-01-02", "--end=2024-01-03", "--warmup-bars=0"], { stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(0);
    const result = JSON.parse(p.stdout.toString());
    expect(result.sessions).toBe(2); expect(result.config.protocolVersion).toBe(AGENT_PROTOCOL_VERSION);
    expect(p.stderr.toString()).toContain("No agent started or run artifacts written");
  });
});
