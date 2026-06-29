// Entrypoint — CLI router. Real implementation lands in Phase 7.
// Kept here in Phase 1 so `bun run src/index.ts` exits cleanly with usage
// before any other phase ships.

const args = process.argv.slice(2);
const subcommand = args[0];

if (subcommand === "results") {
  // Wired in Phase 7.
  console.error("'results' command not yet implemented (Phase 7).");
  process.exit(1);
}

if (subcommand === "start") {
  // Wired in Phase 7.
  console.error("'start' command not yet implemented (Phase 7).");
  process.exit(1);
}

console.error("Usage:");
console.error("  pnpm run start -- --model=<model-id>");
console.error("  pnpm run results");
process.exit(1);
