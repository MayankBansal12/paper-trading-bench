// Dedicated subprocess entrypoint: no persistence or financial execution occurs here.
import { runIsolatedDecision } from "./piDecision.ts";
process.on("message", async (request: Parameters<typeof runIsolatedDecision>[0]) => {
  const result = await runIsolatedDecision(request, (decision) => process.send?.({ type: "snapshot", decision }));
  process.send?.({ type: "result", decision: result });
  // Parent kills the process after receiving the result; no unbounded cleanup wait.
});
