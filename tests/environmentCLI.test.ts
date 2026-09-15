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

test("each qualified route is selectable through the unchanged five-session smoke path", async () => {
  const { QUALIFIED_MODEL_IDS } = await import("../src/opencode/qualification.ts");
  for (const model of QUALIFIED_MODEL_IDS) {
    const script = `import { mock } from "bun:test";
      mock.module(${JSON.stringify(resolve("src/data/dataset.ts"))}, () => ({ loadDataset: async () => ({ version: "offline" }) }));
      mock.module(${JSON.stringify(resolve("src/study/runner.ts"))}, () => ({
        prepareStudyData: async config => ({ dates: [config.start] }),
        runStudy: async config => {
          if (config.model !== ${JSON.stringify(model)} || config.kind !== "smoke") throw Error("Route lost");
          return { summary: { status: "completed", model: config.model }, dir: "/offline" };
        },
      }));
      const { environmentCLI } = await import(${JSON.stringify(resolve("src/cli/environment.ts"))});
      await environmentCLI("run", ["--run-id=offline-smoke", "--data-dir=/offline", "--start=2025-04-01", "--end=2025-04-01", "--smoke=true", ${JSON.stringify("--model=" + model)}]);`;
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(0); expect(err.trim()).toBe("/offline");
    expect(JSON.parse(out).model).toBe(model);
  }
});

test("single-run preparation rejects unknown routes and control/model mixing before reading data", async () => {
  const { prepareStudyData } = await import("../src/study/runner.ts");
  await expect(prepareStudyData({ kind: "smoke", model: "openai/unknown" } as any)).rejects.toThrow("Unqualified");
  await expect(prepareStudyData({ kind: "control", model: "openai/gpt-5.6-luna" } as any)).rejects.toThrow("Control cannot select");
});
