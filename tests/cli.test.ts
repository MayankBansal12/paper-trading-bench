// Subprocess tests exercising the EXACT documented `pnpm run run -- ...` /
// `pnpm run report -- ...` invocations end-to-end (README.md, PRODUCT.md).
// pnpm forwards the conventional `--` end-of-options separator as a literal
// leading argument (unlike npm, which strips it) — these tests run the real
// CLI through pnpm, not just unit-test parseFlags(), so a regression in that
// forwarding behavior (or in how we handle it) is actually caught.

import { describe, expect, test, afterAll } from "bun:test";
import { rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { PROJECT_ROOT } from "../src/utils/paths.ts";
import { resolveRunDir } from "../src/run/state.ts";
import { UNIVERSE_VERSION } from "../src/config/universe.ts";
import { EXECUTION_CONVENTION } from "../src/engine/execution.ts";
import { FIXTURE_VERSION } from "../src/data/ohlcv.ts";
import { AGENT_PROTOCOL_VERSION } from "../src/agent/protocolVersion.ts";
import type { RunConfig } from "../src/domain/types.ts";

const START = "2024-01-02";
const END = "2024-01-03";

function pnpm(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["pnpm", ...args], { cwd: PROJECT_ROOT, stdout: "pipe", stderr: "pipe" });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function runIdConfig(runId: string): RunConfig {
  return {
    model: "demo",
    seed: 1,
    agent: "fake",
    startDate: START,
    endDate: END,
    startingCapital: 1000,
    universeVersion: UNIVERSE_VERSION,
    limits: { maxTurns: 8, maxToolCalls: 20, timeoutMs: 60_000 },
    executionConvention: EXECUTION_CONVENTION,
    fixtureVersion: FIXTURE_VERSION,
    protocolVersion: AGENT_PROTOCOL_VERSION,
    runId,
  };
}

// "cli-subprocess-out-of-range" is asserted below to leave NO directory
// behind — resolveDateRange's empty-intersection check now runs before the
// lock/config.json are ever written (see run/orchestrator.ts) — this cleanup
// entry is a defensive no-op if that ever regresses.
const cleanupRunIds = [
  "cli-subprocess-fake",
  "cli-subprocess-out-of-range",
  "cli-subprocess-subcent-capital",
  "cli-subprocess-huge-capital",
];

describe("CLI: exact documented pnpm invocations", () => {
  test("`pnpm run run -- --help` exits 0 without the `--` separator becoming an unknown flag", () => {
    const { exitCode, stderr } = pnpm(["run", "run", "--", "--help"]);
    expect(exitCode).toBe(0);
    expect(stderr).not.toMatch(/Unknown flag/);
  });

  test("`pnpm run report -- --help` exits 0 without the `--` separator becoming an unknown flag", () => {
    const { exitCode, stderr } = pnpm(["run", "report", "--", "--help"]);
    expect(exitCode).toBe(0);
    expect(stderr).not.toMatch(/Unknown flag/);
  });

  test("`pnpm run run -- --agent=fake --smoke ...` completes a labeled qualification run", async () => {
    const config = runIdConfig("cli-subprocess-fake");
    const { dir } = resolveRunDir(config);
    const { exitCode, stderr } = pnpm([
      "run", "run", "--",
      "--agent=fake", "--model=demo", "--smoke", "--data-dir=fixtures/ohlcv", "--warmup-bars=0",
      `--start=${START}`, `--end=${END}`,
      "--run-id=cli-subprocess-fake",
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toMatch(/status=completed/);
    expect(dir).toContain("cli-subprocess-fake");
    const saved = JSON.parse(await readFile(`${dir}/summary.json`, "utf8"));
    expect(saved.config.experiment).toBe("smoke");
    expect(saved.config.startingCapital).toBe(500);
    expect(saved.config.warmupBars).toBe(0);
    expect(saved.finalPortfolio.cash).toBe(500);
  });

  test("`pnpm run report -- --dirs=<dir>` (the documented comparison form) completes against a real run dir", () => {
    const config = runIdConfig("cli-subprocess-fake");
    const { dir } = resolveRunDir(config);
    const { exitCode, stdout } = pnpm(["run", "report", "--", `--dirs=${dir}`]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/smoke:/);
    expect(stdout).toMatch(/Returns exclude contributions/);
    expect(stdout).toMatch(/Cash:/);
  });

  test("`pnpm run run -- --agent=fake --wat=1` rejects the typo'd flag, not the `--` separator", () => {
    const { exitCode, stderr } = pnpm(["run", "run", "--", "--agent=fake", "--wat=1"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/Unknown flag\(s\) for `run`: --wat/);
    expect(stderr).not.toMatch(/--`,/); // the bare "--" must never itself appear as an unknown flag
  });

  test("a stray positional argument is rejected, not silently ignored", () => {
    const { exitCode, stderr } = pnpm(["run", "run", "--", "--agent=fake", "garbage"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/Unexpected positional argument\(s\).*garbage/);
  });

  test("an impossible calendar date (2024-99-98) is rejected instead of producing a completed zero-day run", () => {
    const { exitCode, stderr } = pnpm([
      "run", "run", "--",
      "--agent=fake", "--model=demo", "--smoke", "--data-dir=fixtures/ohlcv", "--warmup-bars=0",
      "--start=2024-99-98", "--end=2024-99-99",
      "--run-id=cli-subprocess-impossible-date",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/real calendar date/);
  });

  test("a wholly out-of-range date window is rejected with an actionable available-range message, and leaves no run directory behind", () => {
    const config = runIdConfig("cli-subprocess-out-of-range");
    const { dir } = resolveRunDir(config);
    const { exitCode, stderr } = pnpm([
      "run", "run", "--",
      "--agent=fake", "--model=demo", "--smoke", "--data-dir=fixtures/ohlcv", "--warmup-bars=0",
      "--start=2030-01-01", "--end=2030-01-02",
      "--run-id=cli-subprocess-out-of-range",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/outside dataset coverage/);
    expect(existsSync(dir)).toBe(false); // rejected before the lock/config.json were ever written
  });

  test("--starting-capital=0.001 (rounds to $0) is rejected up front, not accepted and logged as capital 0", () => {
    const config = runIdConfig("cli-subprocess-subcent-capital");
    (config as { startingCapital: number }).startingCapital = 0.001;
    const { dir } = resolveRunDir(config);
    const { exitCode, stderr } = pnpm([
      "run", "run", "--",
      "--agent=fake", "--model=demo", "--smoke", "--data-dir=fixtures/ohlcv", "--warmup-bars=0",
      `--start=${START}`, `--end=${END}`,
      "--starting-capital=0.001",
      "--run-id=cli-subprocess-subcent-capital",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/starting-capital.*between/);
    expect(existsSync(dir)).toBe(false); // rejected before the lock/config.json were ever written
  });

  test("--starting-capital=1e307 (overflows to Infinity once normalized) is rejected up front, not accepted as an infinite-capital run", () => {
    const config = runIdConfig("cli-subprocess-huge-capital");
    (config as { startingCapital: number }).startingCapital = 1e307;
    const { dir } = resolveRunDir(config);
    const { exitCode, stderr } = pnpm([
      "run", "run", "--",
      "--agent=fake", "--model=demo", "--smoke", "--data-dir=fixtures/ohlcv", "--warmup-bars=0",
      `--start=${START}`, `--end=${END}`,
      "--starting-capital=1e307",
      "--run-id=cli-subprocess-huge-capital",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/starting-capital.*between/);
    expect(existsSync(dir)).toBe(false); // rejected before the lock/config.json were ever written
  });
}, 60_000);

afterAll(async () => {
  for (const runId of cleanupRunIds) {
    const { dir } = resolveRunDir(runIdConfig(runId));
    await rm(dir, { recursive: true, force: true });
  }
});
