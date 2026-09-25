import { test, expect } from "bun:test";
import { assertStorage } from "../src/study/storage.ts";
import { studyRoute } from "../src/study/routes.ts";
import { PI_LUNA6_MODEL_ID, PI_THINKING } from "../src/pi/route.ts";

test("Luna selects only the exact Codex route with medium reasoning", () => {
  expect(studyRoute(PI_LUNA6_MODEL_ID)).toMatchObject({provider: "openai-codex", model: "gpt-6-luna", cost: null});
  expect(PI_THINKING).toBe("medium");
  expect(() => studyRoute("pi/openai-codex/luna")).toThrow();
});

test("storage guard blocks admission before consuming an attempt", () => {
  const before = process.env.BENCH_MIN_FREE_BYTES;
  try {
    process.env.BENCH_MIN_FREE_BYTES = String(Number.MAX_SAFE_INTEGER);
    expect(() => assertStorage(".")).toThrow("BENCH_STORAGE_PAUSE");
    process.env.BENCH_MIN_FREE_BYTES = "1";
    expect(() => assertStorage(".")).not.toThrow();
    process.env.BENCH_MIN_FREE_BYTES = "garbage";
    expect(() => assertStorage(".")).toThrow("Invalid");
  } finally {
    if (before === undefined) delete process.env.BENCH_MIN_FREE_BYTES;
    else process.env.BENCH_MIN_FREE_BYTES = before;
  }
});


test("storage admission failure creates no attempt and recovery uses the original budget", async () => {
  const { config } = await import("./studyTestSupport.ts");
  const { runStudy } = await import("../src/study/runner.ts");
  const { deterministicControl } = await import("../src/study/control.ts");
  const { rm } = await import("node:fs/promises");
  const c = await config("2024-04-02", "2024-04-02");
  const before = process.env.BENCH_MIN_FREE_BYTES;
  let calls = 0;
  const control: typeof deterministicControl = async (...args) => { calls++; return deterministicControl(...args); };
  try {
    process.env.BENCH_MIN_FREE_BYTES = String(Number.MAX_SAFE_INTEGER);
    await expect(runStudy(c, { control })).rejects.toThrow("BENCH_STORAGE_PAUSE");
    expect(calls).toBe(0);
    expect((await runStudy(c, { readOnly: true })).summary.attempts).toBe(0);
    process.env.BENCH_MIN_FREE_BYTES = "1";
    const result = await runStudy(c, { control });
    expect(result.summary.validDays).toBe(1);
    expect(result.summary.attempts).toBe(1);
    expect(calls).toBe(1);
  } finally {
    if (before === undefined) delete process.env.BENCH_MIN_FREE_BYTES;
    else process.env.BENCH_MIN_FREE_BYTES = before;
    await rm(`results/studies/${c.runId}`, { recursive: true, force: true });
  }
});
