import { readFileSync } from "node:fs";
import { parseFlags } from "./args.ts";
import { assertKnownFlags, assertNoPositionals, parsePositiveInt } from "./validate.ts";
import { parseBooleanFlag } from "./experiment.ts";
import { CONTROL_MODEL, EVALUATION_MODELS, prepareEvaluation, runEvaluation } from "../study/evaluation.ts";
import { POLICY } from "../study/protocol.ts";

export async function evaluationCLI(argv: string[]) {
  const { flags, positionals } = parseFlags(argv);
  assertNoPositionals(positionals, "eval");
  assertKnownFlags(flags, ["eval-id", "data-dir", "models", "control", "history", "timeout-ms", "concurrency", "preflight", "resume", "verify", "pause-on-quota", "continue-checkpoint"], "eval");
  if (!flags.get("eval-id") || !flags.get("data-dir"))
    throw new Error("Required: --eval-id, --data-dir. Evaluation is fixed to April 2025–March 2026, in four independent quarters.");
  const control = parseBooleanFlag("control", flags.get("control"));
  if (control && flags.has("models")) throw new Error("Choose --control=true or --models");
  const preflight = parseBooleanFlag("preflight", flags.get("preflight"));
  const resume = parseBooleanFlag("resume", flags.get("resume"));
  const readOnly = parseBooleanFlag("verify", flags.get("verify"));
  if ([preflight, resume, readOnly].filter(Boolean).length > 1)
    throw new Error("Choose one of --preflight, --resume or --verify");
  const input = {
    ...(flags.has("continue-checkpoint") ? { continuation: JSON.parse(readFileSync(flags.get("continue-checkpoint")!, "utf8")) } : {}),
    pauseOnQuota: parseBooleanFlag("pause-on-quota", flags.get("pause-on-quota")),
    evalId: flags.get("eval-id")!, dataDir: flags.get("data-dir")!,
    models: control ? [CONTROL_MODEL] : flags.get("models")?.split(",").map(m => m.trim()) ?? EVALUATION_MODELS,
    history: parsePositiveInt("history", flags.get("history"), 100),
    timeoutMs: parsePositiveInt("timeout-ms", flags.get("timeout-ms"), POLICY.defaultTimeoutMs),
    ...(flags.has("concurrency") ? { concurrency: parsePositiveInt("concurrency", flags.get("concurrency"), 1) } : {}),
  };
  if (preflight) {
    console.log(JSON.stringify({ plan: await prepareEvaluation(input), modelCalls: 0 }, null, 2));
    return;
  }
  const result = await runEvaluation(input, { resume, readOnly });
  console.log(JSON.stringify(result.report, null, 2));
  console.error(result.dir);
  if (result.report.status !== "completed") process.exitCode = 1;
}
