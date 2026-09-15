import { resolve } from "node:path";
import { parseFlags } from "../src/cli/args.ts";
import { assertKnownFlags, assertNoPositionals } from "../src/cli/validate.ts";
import { qualifyOfficialOpenCode, qualifiedRoute, QUALIFIED_MODEL_IDS, writeQualification } from "../src/opencode/qualification.ts";

const { flags, positionals } = parseFlags(process.argv.slice(2));
assertNoPositionals(positionals, "model:preflight");
assertKnownFlags(flags, ["model", "out"], "model:preflight");
if (flags.has("out") && !flags.has("model")) throw new Error("--out requires a single --model");
const models = flags.has("model") ? [qualifiedRoute(flags.get("model")!).id] : QUALIFIED_MODEL_IDS;
for (const model of models) {
  const evidence = await qualifyOfficialOpenCode(30_000, model);
  const out = await writeQualification(evidence, flags.has("out") ? resolve(flags.get("out")!) : undefined);
  console.log(JSON.stringify({ out, exactModel: model, inferenceCalls: 0 }));
}
console.error("[model-preflight] Exact active catalog-priced route evidence written; no inference performed.");
