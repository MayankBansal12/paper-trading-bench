import { QUOTA_PAUSE_POLICY } from "../study/availability.ts";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseFlags } from "./args.ts";
import {
  assertKnownFlags,
  assertNoPositionals,
  parsePositiveInt,
  parseDateFlag,
} from "./validate.ts";
import { parseBooleanFlag } from "./experiment.ts";
import { loadDataset } from "../data/dataset.ts";
import { POLICY, STUDY_PROTOCOL } from "../study/protocol.ts";
import {
  runStudy,
  prepareStudyData,
  type StudyConfig,
} from "../study/runner.ts";
import { deterministicControl } from "../study/control.ts";
import { qualifySandbox } from "../study/sandbox.ts";
import { studyRoute } from "../study/routes.ts";
import { writeFileAtomic } from "../utils/fs.ts";
export const HELP = `Paper portfolio environment (${STUDY_PROTOCOL})
  pnpm bench eval --eval-id ID --data-dir DIR [--models MODEL_IDS] [--concurrency N] [--preflight=true | --resume=true | --verify=true] [--control=true]
    April 2025–March 2026: four independent quarters per model, each with $50,000 fresh cash and empty memory.
    Defaults to all jobs concurrently. Use --concurrency=1 for serial execution; preserve this value on resume/verify.
  pnpm bench run --run-id ID --data-dir DIR --start DATE --end DATE [--preflight=true] [--control=true] [--smoke=true] [--model MODEL_ID] [--history=100] [--timeout-ms=${POLICY.defaultTimeoutMs}]
  pnpm bench resume --dir results/studies/ID
  pnpm bench inspect --dir results/studies/ID
  pnpm bench verify --dir results/studies/ID
  pnpm bench review --dir results/studies/ID [--analysis=true] [--gaps=true] [--comparisons=true] [--ndx-data-dir DIR]
  pnpm bench qualify --data-dir DIR --ndx-data-dir DIR --start DATE --end DATE
  pnpm bench sandbox-check

Fresh context, four tools and one final submission per day. Unlimited turns/tools.
Starts with $50,000; each later represented month receives $50,000. Future opens remain unknown.
Control/smoke qualify the environment, not scored model comparisons.
Historical protocols require their frozen archived source.`;
export async function environmentCLI(command: string, argv: string[]) {
  if (["help", "--help", "-h"].includes(command) || argv.includes("--help")) {
    console.log(HELP);
    return;
  }
  if (command === "eval") {
    const { evaluationCLI } = await import("./evaluation.ts");
    return evaluationCLI(argv);
  }
  const { flags, positionals } = parseFlags(argv);
  assertNoPositionals(positionals, command);
  if (command === "sandbox-check") {
    assertKnownFlags(flags, ["model"], command);
    if (flags.has("model")) {
      const { prepareModelRuntime } = await import("../study/model.ts");
      const runtime = await prepareModelRuntime(flags.get("model"));
      try { console.log(JSON.stringify(runtime.sandboxQualification, null, 2)); }
      finally { await runtime.dispose(); }
    } else console.log(JSON.stringify(await qualifySandbox(), null, 2));
    return;
  }
  if (["resume", "inspect", "verify", "review"].includes(command)) {
    assertKnownFlags(
      flags,
      command === "review"
        ? ["dir", "analysis", "gaps", "comparisons", "ndx-data-dir"]
        : ["dir"],
      command,
    );
    if (!flags.get("dir")) throw new Error("--dir is required");
    const dir = resolve(flags.get("dir")!),
      c: StudyConfig = JSON.parse(
        readFileSync(join(dir, "manifest.json"), "utf8"),
      ).config;
    if (dir !== resolve("results/studies", c.runId))
      throw new Error("Run directory/config mismatch");
    const result = await runStudy(c, {
      readOnly: command !== "resume",
      ...(command === "resume" && c.kind === "control"
        ? { control: deterministicControl }
        : {}),
    });
    if (command === "review") {
      const { writeStudyReview } = await import("../study/report.ts");
      await writeStudyReview(c, result, {
        analysis: parseBooleanFlag("analysis", flags.get("analysis")),
        gaps: parseBooleanFlag("gaps", flags.get("gaps")),
        comparisons: parseBooleanFlag("comparisons", flags.get("comparisons")),
        ndxDir: flags.get("ndx-data-dir"),
      });
      console.error(join(dir, "review.md"));
    }
    console.log(JSON.stringify(result.summary, null, 2));
    if (command === "resume" && executionFailed(c, result.summary)) process.exitCode = 1;
    return;
  }
  if (!["run", "qualify"].includes(command)) throw new Error(HELP);
  assertKnownFlags(
    flags,
    command === "qualify"
      ? ["data-dir", "ndx-data-dir", "start", "end", "history"]
      : [
          "run-id",
          "data-dir",
          "start",
          "end",
          "history",
          "timeout-ms",
          "control",
          "smoke",
          "model",
          "preflight",
          "pause-on-quota",
          "continue-checkpoint",
        ],
    command,
  );
  if (flags.has("model")) studyRoute(flags.get("model")!);
  const start = parseDateFlag("start", flags.get("start")),
    end = parseDateFlag("end", flags.get("end"));
  if (
    !start ||
    !end ||
    !flags.get("data-dir") ||
    (command === "run" && !flags.get("run-id"))
  )
    throw new Error("Required: --run-id, --data-dir, --start, --end");
  const dataDir = resolve(flags.get("data-dir")!),
    market = await loadDataset(dataDir);
  const control = parseBooleanFlag("control", flags.get("control")),
    smoke = parseBooleanFlag("smoke", flags.get("smoke"));
  if (control && smoke) throw new Error("Choose control or smoke");
  // Field order matches the evaluation child-config literal so resumed runs
  // hash identically; contentHash is key-order sensitive.
  const c: StudyConfig = {
    ...(parseBooleanFlag("pause-on-quota", flags.get("pause-on-quota")) ? { availabilityPolicy: QUOTA_PAUSE_POLICY } : {}),
    protocol: STUDY_PROTOCOL,
    kind:
      command === "qualify"
        ? "quarter"
        : control
          ? "control"
          : smoke
            ? "smoke"
            : "environment",
    runId: flags.get("run-id") ?? "qualification",
    ...(flags.has("model") ? { model: flags.get("model")! } : {}),
    dataDir,
    datasetHash: market.version,
    universeVersion: "dataset",
    start,
    end,
    history: parsePositiveInt("history", flags.get("history"), 100),
    limits: {
      maxTurns: null,
      maxToolCalls: null,
      timeoutMs: parsePositiveInt(
        "timeout-ms",
        flags.get("timeout-ms"),
        POLICY.defaultTimeoutMs,
      ),
    },
    policy: POLICY,
    ...(flags.has("continue-checkpoint") ? { continuation: JSON.parse(readFileSync(resolve(flags.get("continue-checkpoint")!), "utf8")) } : {}),
  };
  const prepared = await prepareStudyData(c);
  if (smoke && prepared.dates.length > 5)
    throw new Error("Live smoke is limited to five sessions");
  if (command === "qualify") {
    const ndx = flags.get("ndx-data-dir");
    if (ndx)
      c.reference = {
        dataDir: resolve(ndx),
        datasetHash: (await loadDataset(resolve(ndx))).version,
      };
    const { qualifyStudyProfile } = await import("../study/profile.ts");
    await qualifyStudyProfile(c, market);
    console.log(
      JSON.stringify({ eligible: true, config: c, modelCalls: 0 }, null, 2),
    );
    return;
  }
  if (parseBooleanFlag("preflight", flags.get("preflight"))) {
    // A continuation/recovery preflight authenticates the frozen parent and its fit without any model call.
    let continuation: object | undefined;
    if (c.continuation) {
      const { loadParentPrefix, continuationFits } = await import("../study/segment.ts");
      const parent = loadParentPrefix(c.continuation);
      if (!continuationFits(parent, c as any, prepared.dates)) throw new Error("Continuation parent does not match this quarter");
      continuation = {
        version: c.continuation.version, inheritedDays: parent.days.length, remainingDates: prepared.dates.slice(parent.days.length),
        carriedFailures: parent.carried.length, consecutiveInvalidDays: parent.consecutiveInvalidDays,
        ...(c.continuation.recovery ? { recovery: { boundaryDate: c.continuation.recovery.boundaryDate,
          supersededDays: c.continuation.recovery.supersededDays.map((d) => d.date), supersededAttempts: c.continuation.recovery.supersededAttempts.length } } : {}),
      };
    }
    console.log(
      JSON.stringify(
        { config: c, sessions: prepared.dates.length, ...(continuation ? { continuation } : {}), modelCalls: 0 },
        null,
        2,
      ),
    );
    return;
  }
  const result = await runStudy(
    c,
    control ? { control: deterministicControl } : {},
  );
  console.log(JSON.stringify(result.summary, null, 2));
  console.error(result.dir);
  if (executionFailed(c, result.summary)) process.exitCode = 1;
}

// Accounting every day is enough to complete a cohort, but a smoke qualifies
// the live route only when every planned day produced a valid decision.
function executionFailed(
  config: StudyConfig,
  summary: Awaited<ReturnType<typeof runStudy>>["summary"],
) {
  return summary.status !== "completed" ||
    (config.kind === "smoke" &&
      (summary.totalDays < 1 || summary.validDays !== summary.totalDays));
}
