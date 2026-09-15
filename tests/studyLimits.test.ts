import { test, expect } from "bun:test";
import { POLICY, scopeFor } from "../src/study/protocol.ts";

test("new-run preflight defaults to 60 minutes and keeps explicit shorter watchdogs", async () => {
  for (const timeout of [undefined, 12000]) {
    const child = Bun.spawn([
      process.execPath, "src/index.ts", "run", "--run-id", "limits-preflight",
      "--data-dir", "fixtures/ohlcv", "--start", "2024-06-28", "--end", "2024-06-28",
      "--preflight=true", ...(timeout === undefined ? [] : [`--timeout-ms=${timeout}`]),
    ], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.config.limits).toEqual({ maxTurns: null, maxToolCalls: null, timeoutMs: timeout ?? 3600000 });
    expect(result.config.policy.maxAttemptsPerDay).toBe(2);
    expect(result.modelCalls).toBe(0);
  }
});

test("one retry permits attempt two and rejects a third attempt", () => {
  expect(POLICY.maxAttemptsPerDay).toBe(2);
  expect(scopeFor("retry-boundary", "2025-02-03", 2).attempt).toBe(2);
  expect(() => scopeFor("retry-boundary", "2025-02-03", 3)).toThrow("Invalid session identity");
});
