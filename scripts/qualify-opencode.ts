import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { qualifyOfficialOpenCode, QUALIFIED_ZEN_MODEL_ID } from "../src/opencode/qualification.ts";

function outputPath(argv: string[]): string {
  const flag = argv.find(argument => argument.startsWith("--out="));
  if (flag) return resolve(flag.slice("--out=".length));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve("results", "qualifications", `opencode-muse-${stamp}.json`);
}

const out = outputPath(process.argv.slice(2));
const evidence = await qualifyOfficialOpenCode();
const artifact = {
  schemaVersion: 1,
  purpose: "no-call-live-model-qualification",
  exactModel: QUALIFIED_ZEN_MODEL_ID,
  inferenceCalls: 0,
  evidence,
};
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(artifact, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ out, ...artifact }, null, 2));
console.error("[model-preflight] Exact active zero-cost catalog/runtime evidence written; no inference performed.");
