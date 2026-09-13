import { environmentCLI } from "../src/cli/environment.ts";
await environmentCLI("run",[...process.argv.slice(2),"--control=true"]);
