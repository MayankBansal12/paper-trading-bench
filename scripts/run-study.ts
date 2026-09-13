import { parseFlags } from "../src/cli/args.ts";
import {
  assertKnownFlags,
  assertNoPositionals,
  parseDateFlag,
  parsePositiveInt,
} from "../src/cli/validate.ts";
import { parseBooleanFlag } from "../src/cli/experiment.ts";
import { loadDataset } from "../src/data/dataset.ts";
import { POLICY, STUDY_PROTOCOL } from "../src/study/protocol.ts";
import {
  runStudy,
  prepareStudyData,
  type StudyConfig,
} from "../src/study/runner.ts";
import { qualifySandbox } from "../src/study/sandbox.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const { flags, positionals } = parseFlags(process.argv.slice(2));
assertNoPositionals(positionals, "study");
assertKnownFlags(
  flags,
  [
    "run-id",
    "data-dir",
    "ndx-data-dir",
    "start",
    "end",
    "universe-version",
    "smoke",
    "history",
    "max-tool-calls",
    "timeout-ms",
    "preflight",
    "verify",
    "sandbox-check",
  ],
  "study",
);
if (flags.has("sandbox-check")) {
  console.log(JSON.stringify(await qualifySandbox(), null, 2));
} else if (flags.has("verify")) {
  const c = JSON.parse(
    readFileSync(resolve(flags.get("verify")!, "config.json"), "utf8"),
  );
  if (resolve(flags.get("verify")!) !== resolve("results/studies", c.runId))
    throw new Error("Verification directory/config mismatch");
  console.log(JSON.stringify(await runStudy(c, { readOnly: true }), null, 2));
} else {
  const start = parseDateFlag("start", flags.get("start")),
    end = parseDateFlag("end", flags.get("end"));
  if (!start || !end || !flags.get("data-dir") || !flags.get("run-id"))
    throw new Error("Required: --start, --end, --data-dir, --run-id");
  const dataDir = resolve(flags.get("data-dir")!);
  const dataset = await loadDataset(dataDir);
  const ndxDir = flags.get("ndx-data-dir");
  const reference = ndxDir
    ? {
        dataDir: resolve(ndxDir),
        datasetHash: (await loadDataset(resolve(ndxDir))).version,
      }
    : undefined;
  const config: StudyConfig = {
    protocol: STUDY_PROTOCOL,
    kind: parseBooleanFlag("smoke", flags.get("smoke")) ? "smoke" : "quarter",
    runId: flags.get("run-id")!,
    dataDir,
    datasetHash: dataset.version,
    ...(reference ? { reference } : {}),
    universeVersion: flags.get("universe-version") ?? "dataset",
    start,
    end,
    history: parsePositiveInt("history", flags.get("history"), 100),
    limits: {
      maxTurns: null,
      maxToolCalls: parsePositiveInt(
        "max-tool-calls",
        flags.get("max-tool-calls"),
        24,
      ),
      timeoutMs: parsePositiveInt(
        "timeout-ms",
        flags.get("timeout-ms"),
        300000,
      ),
    },
    policy: POLICY,
  };
  if (parseBooleanFlag("preflight", flags.get("preflight"))) {
    const p = await prepareStudyData(config);
    console.log(
      JSON.stringify(
        { config, sessions: p.dates.length, modelCalls: 0 },
        null,
        2,
      ),
    );
  } else {
    const result = await runStudy(config);
    console.log(JSON.stringify(result.summary, null, 2));
    console.error(result.dir);
    if (result.summary.status !== "completed") process.exitCode = 1;
  }
}
