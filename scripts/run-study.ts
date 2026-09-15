import { environmentCLI } from "../src/cli/environment.ts";
await environmentCLI("eval",process.argv.slice(2));
