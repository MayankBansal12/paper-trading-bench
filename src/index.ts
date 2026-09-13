import { environmentCLI } from "./cli/environment.ts";
const [command = "help", ...args] = process.argv.slice(2);
try {
  await environmentCLI(command, args);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
