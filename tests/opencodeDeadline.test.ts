import { expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { OpenCodeAgent } from "../src/opencode/agent.ts";

test("whole official adapter bounds stalled auth and freezes its returned failed decision", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-deadline-test-"));
  const originalCreate = AuthStorage.create;
  const originalSpawn = Bun.spawn;
  const priorKey = process.env.OPENCODE_API_KEY;
  let entered = false;
  let release!: (value: string) => void;
  const auth = new Promise<string>((resolve) => { release = resolve; });
  try {
    // Only the CLI version preflight runs. Any later client launch leaves a
    // marker, proving that late auth cannot start a request after cancellation.
    await writeFile(join(dir, "opencode"), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.18.29; exit 0; fi\necho started > "$BENCH_DEADLINE_MARKER"\nexit 77\n', { mode: 0o755 });
    Bun.spawn = ((command: any, options: any) => {
      if (Array.isArray(command) && command[0] === "opencode") return originalSpawn([join(dir, "opencode"), ...command.slice(1)], options);
      return originalSpawn(command, options);
    }) as typeof Bun.spawn;
    process.env.BENCH_DEADLINE_MARKER = join(dir, "launched");
    delete process.env.OPENCODE_API_KEY;
    AuthStorage.create = (() => ({ getApiKey: async () => { entered = true; return auth; } })) as typeof AuthStorage.create;
    const start = performance.now();
    const result = await new OpenCodeAgent("mimo-v2.5-free", "opencode", { freeOnly: true }).decide({
      date: "2024-03-01", universe: [], bars: {}, indicators: {}, recentDays: [],
      portfolio: { cash: 500, holdings: {}, holdingsValue: 0, netWorth: 500 },
      limits: { timeoutMs: 100, maxTurns: 1, maxToolCalls: 1 },
    });
    expect(entered).toBe(true);
    expect(performance.now() - start).toBeLessThan(350);
    expect(result.outcome).toBe("budget_cutoff");
    expect(result.terminalReason).toContain("Hard timeout");
    expect(result.orders).toEqual([]);
    const frozen = JSON.stringify(result);
    release("offline-sentinel-not-a-credential");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(JSON.stringify(result)).toBe(frozen);
    await expect(readFile(join(dir, "launched"))).rejects.toThrow();
  } finally {
    release?.("offline-sentinel-not-a-credential");
    AuthStorage.create = originalCreate;
    Bun.spawn = originalSpawn;
    if (priorKey === undefined) delete process.env.OPENCODE_API_KEY; else process.env.OPENCODE_API_KEY = priorKey;
    delete process.env.BENCH_DEADLINE_MARKER;
    await rm(dir, { recursive: true, force: true });
  }
});
