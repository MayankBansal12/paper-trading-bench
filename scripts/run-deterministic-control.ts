import { resolve } from "node:path";
import { FakeAgent } from "../src/agent/fakeAgent.ts";
import { getComparisonProfile, NASDAQ_COMPARISON_PROFILE_ID } from "../src/config/comparison.ts";
import { runBatch } from "../src/run/orchestrator.ts";
import type { RunConfig } from "../src/domain/types.ts";

const runId = process.argv.slice(2).find(argument => argument.startsWith("--run-id="))?.slice("--run-id=".length) ?? "nasdaq100-deterministic-control-v7";
const profile = getComparisonProfile(NASDAQ_COMPARISON_PROFILE_ID);
const config: RunConfig = {
  ...profile.config,
  comparisonProfile: undefined,
  model: "fake-deterministic-control",
  provider: "offline",
  freeOnly: true,
  agent: "fake",
  seed: 1,
  runId,
  dataDir: resolve(profile.dataDir),
  // The fake agent represents one order as one tool call. This expanded cap
  // prevents its deliberately simple universe-wide strategy from truncating;
  // the run is an integration control and never a model-comparison row.
  limits: { ...profile.config.limits, maxToolCalls: 200 },
};
const result = await runBatch(config, new FakeAgent());
console.log(JSON.stringify({ runId: result.runId, dir: result.dir, status: result.summary.status,
  datasetVersion: result.summary.datasetVersion, sessions: result.summary.metrics.daysRun,
  metrics: result.summary.metrics, analytics: result.summary.analytics }, null, 2));
if (result.summary.status !== "completed") process.exitCode = 1;
