// CLI router. Two subcommands:
//   - `start --model=<id>`  (or via env PAPER_MODEL) → runs one trading day
//   - `results`             → prints the human-readable report
//
// Flags parsing is intentionally minimal — no arg-parser library. Just
// enough for `pnpm run start -- --model=kimi-k2.6` and
// `pnpm run start -- --model kimi-k2.6`.

import { runStart } from "./cli/start.ts";
import { runResults } from "./cli/results.ts";

function parseModelFlag(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--model" && i + 1 < args.length) return args[i + 1];
    if (a.startsWith("--model=")) return a.slice("--model=".length);
  }
  return undefined;
}

function printUsage(): void {
  console.error("Usage:");
  console.error("  pnpm run start -- --model=<model-id>   # e.g. --model=kimi-k2.6");
  console.error("  pnpm run results");
  console.error("");
  console.error("Available models (opencode-go): kimi-k2.6, glm-5.1, glm-5.2,");
  console.error("  minimax-m2.7, minimax-m3, deepseek-v4-flash, deepseek-v4-pro, ...");
  console.error("Run `pi --list-models` to see the full catalog.");
}

const args = process.argv.slice(2);
const subcommand = args[0];

if (subcommand === "start") {
  const modelId = parseModelFlag(args.slice(1)) ?? process.env.PAPER_MODEL ?? "kimi-k2.6";
  runStart(modelId).catch((err) => {
    console.error("[start] FAILED:", err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
} else if (subcommand === "results") {
  runResults().catch((err) => {
    console.error("[results] FAILED:", err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
} else if (subcommand === "--help" || subcommand === "-h") {
  printUsage();
} else {
  printUsage();
  process.exit(1);
}
