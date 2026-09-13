import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";

for (const [command, status, exitCode] of [
  ["resume", "incomplete", 1], ["resume", "completed", 0], ["inspect", "incomplete", 0],
  ["resume", "invalid", 1], ["inspect", "invalid", 0],
] as const) test(`${command} ${status} returns exit ${exitCode} with its summary`, async () => {
  const runId = "test-cli-" + randomUUID(), dir = resolve("results/studies", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ config: { runId } }));
  try {
    // Isolated subprocess: simulate the runner outcome without modifying shared test modules or making inference.
    const script = `import { mock } from "bun:test";
      mock.module(${JSON.stringify(resolve("src/study/runner.ts"))}, () => ({
        runStudy: async () => ({ summary: { status: ${JSON.stringify(status)}, failure: "watchdog fixture" } }),
        prepareStudyData: async () => { throw Error("unexpected preparation"); },
      }));
      const { environmentCLI } = await import(${JSON.stringify(resolve("src/cli/environment.ts"))});
      await environmentCLI(${JSON.stringify(command)}, ["--dir", ${JSON.stringify(dir)}]);`;
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(err).toBe("");
    expect(code).toBe(exitCode);
    expect(JSON.parse(out).status).toBe(status);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
