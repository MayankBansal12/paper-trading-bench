import {
  prepareModelRuntime as prepareOpenCode,
  decideStudy as decideOpenCode,
} from "./agent.ts";
import { preparePiRuntime, decidePi } from "../pi/agent.ts";
import { isPiModel } from "../pi/route.ts";
export async function prepareModelRuntime(model?: string, expected?: any) {
  return isPiModel(model)
    ? { kind: "pi" as const, ...(await preparePiRuntime(model, expected)) }
    : { kind: "opencode" as const, ...(await prepareOpenCode(model)) };
}
export async function decideStudy(
  ...args: [
    ...(Parameters<typeof decideOpenCode> extends [...infer A, unknown]
      ? A
      : never),
    Awaited<ReturnType<typeof prepareModelRuntime>>,
  ]
) {
  const [view, journal, past, horizon, audit, runtime] = args;
  return runtime.kind === "pi"
    ? decidePi(view, journal, past, horizon, audit, runtime)
    : decideOpenCode(view, journal, past, horizon, audit, runtime);
}
