// CLI router. Two subcommands:
//   - `run --model=<id> [--agent=fake|pi] [--start=YYYY-MM-DD] [--end=YYYY-MM-DD] ...`
//   - `report [--dirs=<dir1,dir2>|--all]`

import { runRun } from "./cli/run.ts";
import { runReport } from "./cli/report.ts";

function printUsage(): void {
  console.error("Usage:");
  console.error("  pnpm run run -- --model=minimax-m3 [--agent=pi|fake] [--seed=1]");
  console.error("                   [--start=YYYY-MM-DD] [--end=YYYY-MM-DD] [--run-id=<id>]");
  console.error("                   [--max-turns=8] [--max-tool-calls=20] [--timeout-ms=60000]");
  console.error("  pnpm run report -- [--dirs=<dir1,dir2>]   # default: scan results/runs/");
  console.error("");
  console.error("opencode-go models: minimax-m3, deepseek-v4-pro, ... (any id Pi's catalog resolves)");
}

const [subcommand, ...rest] = process.argv.slice(2);

if (subcommand === "run") {
  runRun(rest).catch((err) => {
    console.error("[run] FAILED:", err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
} else if (subcommand === "report") {
  runReport(rest).catch((err) => {
    console.error("[report] FAILED:", err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
} else if (subcommand === "--help" || subcommand === "-h") {
  printUsage();
} else {
  printUsage();
  process.exit(1);
}
