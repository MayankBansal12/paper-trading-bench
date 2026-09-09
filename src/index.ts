const [subcommand, ...rest] = process.argv.slice(2);
function usage(): void {
  console.error("PaperTrader — three-month historical technical-analysis benchmark");
  console.error("  pnpm run data:import -- --start=YYYY-MM-DD --end=YYYY-MM-DD --out=<snapshot>");
  console.error("  pnpm run run -- --data-dir=<snapshot> [--provider=opencode] [--model=mimo-v2.5-free]");
  console.error("  pnpm run report -- [--dirs=<run1,run2>]");
  console.error("Use run --help or report --help for flags. Initial $500 plus $500 at the start of each later month.");
}
try {
  if (subcommand === "run") await (await import("./cli/run.ts")).runRun(rest);
  else if (subcommand === "report") await (await import("./cli/report.ts")).runReport(rest);
  else if (subcommand === "--help" || subcommand === "-h") usage();
  else { usage(); process.exitCode = 1; }
} catch (error) {
  console.error(`[${subcommand}] FAILED:`, error instanceof Error ? error.message : error);
  if (error instanceof Error && error.cause instanceof Error) console.error(error.cause.message);
  process.exitCode = 1;
}
export {};
