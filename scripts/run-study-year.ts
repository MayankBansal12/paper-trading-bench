import { parseFlags } from "../src/cli/args.ts";
import {
  assertKnownFlags,
  assertNoPositionals,
  parsePositiveInt,
} from "../src/cli/validate.ts";
import { parseBooleanFlag } from "../src/cli/experiment.ts";
import { resolve, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { loadDataset } from "../src/data/dataset.ts";
import {
  prepareStudyData,
  runStudy,
  type StudyConfig,
} from "../src/study/runner.ts";
import { POLICY, STUDY_PROTOCOL } from "../src/study/protocol.ts";
import { implementationIdentity } from "../src/study/identity.ts";
import { durableCreate } from "../src/study/journal.ts";
import { contentHash } from "../src/run/persist.ts";
import { QUALIFIED_ZEN_MODEL_ID } from "../src/opencode/qualification.ts";
const { flags, positionals } = parseFlags(process.argv.slice(2));
assertNoPositionals(positionals, "study year");
assertKnownFlags(
  flags,
  ["year", "data-root", "suite-id", "execute"],
  "study year",
);
const year = parsePositiveInt("year", flags.get("year"), 0),
  id = flags.get("suite-id"),
  root = flags.get("data-root");
if (
  year < 2000 ||
  year > 2030 ||
  !id ||
  !/^[-A-Za-z0-9_]{1,100}$/.test(id) ||
  !root
)
  throw new Error(
    "Required: --year=2000..2030 --suite-id=<stable ID> --data-root=<Q1..Q4 archive root>",
  );
if (year >= new Date().getUTCFullYear())
  throw new Error("Annual studies require a completed calendar year");
const quarters: StudyConfig[] = [];
// Qualify every quarter before any inference or suite publication.
for (let q = 1; q <= 4; q++) {
  const dataDir = resolve(root, `Q${q}`, "market"),
    ndxDir = resolve(root, `Q${q}`, "ndx");
  const market = await loadDataset(dataDir),
    ndx = await loadDataset(ndxDir);
  const start = new Date(Date.UTC(year, (q - 1) * 3, 1))
      .toISOString()
      .slice(0, 10),
    end = new Date(Date.UTC(year, q * 3, 0)).toISOString().slice(0, 10);
  const config: StudyConfig = {
    protocol: STUDY_PROTOCOL,
    kind: "quarter",
    runId: `${id}-Q${q}`,
    dataDir,
    datasetHash: market.version,
    reference: { dataDir: ndxDir, datasetHash: ndx.version },
    universeVersion: "dataset",
    start,
    end,
    history: 100,
    limits: { maxTurns: null, maxToolCalls: 24, timeoutMs: 300000 },
    policy: POLICY,
  };
  await prepareStudyData(config);
  quarters.push(config);
}
const suite = {
  protocol: STUDY_PROTOCOL,
  year,
  id,
  model: QUALIFIED_ZEN_MODEL_ID,
  reset: "independent-quarter-portfolio-and-journal",
  startingCapitalPerQuarter: 500,
  monthlyContribution: 500,
  implementation: implementationIdentity(),
  quarters,
};
if (!parseBooleanFlag("execute", flags.get("execute")))
  console.log(
    JSON.stringify({ preflight: "passed", modelCalls: 0, suite }, null, 2),
  );
else {
  const path = resolve("results/studies/suites", `${id}.json`);
  if (existsSync(path)) {
    if (
      contentHash(JSON.parse(readFileSync(path, "utf8"))) !== contentHash(suite)
    )
      throw new Error("Immutable suite differs");
  } else durableCreate(path, suite);
  const results = [];
  for (const config of quarters) {
    const result = await runStudy(config);
    results.push({
      quarter: config.runId,
      status: result.summary.status,
      metrics: result.summary.metrics,
      ndx: result.summary.baselines.ndx,
      dir: result.dir,
    });
    if (result.summary.status !== "completed") {
      process.exitCode = 1;
      break;
    }
  }
  console.log(
    JSON.stringify(
      {
        suite: path,
        results,
        annualReturn: null,
        note: "Independent reset quarters are reported separately, not as a continuous annual account.",
      },
      null,
      2,
    ),
  );
}
