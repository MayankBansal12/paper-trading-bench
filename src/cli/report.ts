// `report` subcommand: compares one or more runs, grouped into comparable
// cohorts. Pass explicit --dirs, or omit it to discover every run under
// results/runs/.

import { resolve } from "node:path";
import { parseFlags } from "./args.ts";
import { assertKnownFlags, assertNoPositionals } from "./validate.ts";
import { buildComparison, discoverRunDirs, renderMarkdownTable } from "../report/compare.ts";
import { writeFileAtomic } from "../utils/fs.ts";
import { REPORTS_DIR, RUNS_DIR } from "../utils/paths.ts";

const KNOWN_FLAGS = ["dirs", "help"] as const;

function printReportUsage(): void {
  console.error("Usage: pnpm run report -- [--dirs=<dir1,dir2>]   # default: scan results/runs/");
  console.error("Runs are grouped into cohorts by universe/fixture/execution-convention/date-range/");
  console.error("capital/limits — only runs in the same cohort are shown side by side.");
}

export async function runReport(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    printReportUsage();
    return;
  }

  const { flags, positionals } = parseFlags(argv);
  assertKnownFlags(flags, KNOWN_FLAGS, "report");
  assertNoPositionals(positionals, "report");
  const dirsFlag = flags.get("dirs");
  const dirs = dirsFlag
    ? dirsFlag.split(",").map((d) => resolve(d))
    : await discoverRunDirs(RUNS_DIR);

  if (dirs.length === 0) {
    console.error(`[report] No runs found under ${RUNS_DIR}. Pass --dirs=<dir1,dir2> or run \`pnpm run run\` first.`);
    return;
  }

  const cohorts = await buildComparison(dirs);
  const markdown = renderMarkdownTable(cohorts, RUNS_DIR);
  console.log(markdown);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await writeFileAtomic(resolve(REPORTS_DIR, `${stamp}.json`), JSON.stringify(cohorts, null, 2) + "\n");
  await writeFileAtomic(resolve(REPORTS_DIR, `${stamp}.md`), markdown + "\n");
  console.error(`[report] wrote results/reports/${stamp}.{json,md}`);
}
