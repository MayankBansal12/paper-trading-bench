import { expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { decideStudy } from "../src/study/agent.ts";
import { JournalStore } from "../src/study/journal.ts";
import { makeView,scopeFor } from "../src/study/protocol.ts";

test("whole official adapter bounds stalled auth and freezes its returned failed decision", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-deadline-test-"));
  const originalCreate = AuthStorage.create;
  const originalSpawn = Bun.spawn;
  const priorKey = process.env.OPENCODE_API_KEY;
  let entered = false;
  let release!: (value: string) => void;
  const auth = new Promise<string>((resolve) => { release = resolve; });
  try {
    // Only version and no-inference catalog qualification commands run. Any
    // later client launch leaves a marker, proving late auth cannot start it.
    await writeFile(join(dir, "opencode"), `#!/bin/sh
if [ "$1" = "--version" ]; then echo 1.18.30; exit 0; fi
if [ "$1" = "models" ]; then
  printf 'opencode/muse-spark-1.3-contributor-free\n{"id":"muse-spark-1.3-contributor-free","providerID":"opencode","name":"Muse Spark 1.3 Free","status":"active","api":{"url":"https://opencode.ai/zen/v1","npm":"@ai-sdk/openai"},"cost":{"input":0,"output":0,"cache":{"read":0,"write":0},"tiers":[]},"capabilities":{"toolcall":true}}\n'
  exit 0
fi
echo started > "$BENCH_DEADLINE_MARKER"
exit 77
`, { mode: 0o755 });
    Bun.spawn = ((command: any, options: any) => {
      if (Array.isArray(command) && command[0] === "opencode") return originalSpawn([join(dir, "opencode"), ...command.slice(1)], options);
      return originalSpawn(command, options);
    }) as typeof Bun.spawn;
    process.env.BENCH_DEADLINE_MARKER = join(dir, "launched");
    delete process.env.OPENCODE_API_KEY;
    AuthStorage.create = (() => ({ getApiKey: async () => { entered = true; return auth; } })) as typeof AuthStorage.create;
    const start = performance.now();
    const scope=scopeFor("deadline", "2024-03-01", 1);
    const journal=new JournalStore(dir);journal.begin(scope);
    const attempt = await decideStudy(makeView({
      date: "2024-03-01", universe: ["AAPL"], bars: { AAPL: [{date:"2024-02-29",open:10,high:10,low:10,close:10,volume:100}]}, indicators: {}, recentDays: [],
      portfolio: { cash: 500, holdings: {}, holdingsValue: 0, netWorth: 500 },
      limits: { timeoutMs: 100, maxTurns: null, maxToolCalls: 1 },
    },scope),journal,[],{start:scope.date,end:scope.date,contributions:[]});
    const result=attempt.decision;
    expect(entered).toBe(true);
    expect(performance.now() - start).toBeLessThan(350);
    expect(result.outcome).toBe("budget_cutoff");
    expect(result.terminalReason).toContain("Hard session timeout");
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
