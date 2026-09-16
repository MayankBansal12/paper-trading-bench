// No inference: exercise the real pinned Pi CLI and sandbox against synthetic SSE.
import { writeFile, rm } from "node:fs/promises";
import { setup } from "../tests/studyTestSupport.ts";
import { preparePiRuntime, decidePi } from "../src/pi/agent.ts";
import { validateAccepted } from "../src/study/accept.ts";
import { PI_MODEL, PI_MODEL_ID } from "../src/pi/route.ts";
const runtime = await preparePiRuntime();
let s = setup();
let count = 0,
  scenario = "success";
const forward = (async (_url: any, init: any) => {
  const request = JSON.parse(init.body);
  count++;
  if (scenario === "quota")
    return Response.json(
      {
        error: {
          code: "usage_limit_reached",
          message: "Synthetic quota exhausted",
        },
      },
      { status: 429 },
    );
  if (scenario === "watchdog")
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener(
        "abort",
        () => reject(new Error("fixture aborted")),
        { once: true },
      );
    });
  const name =
    scenario === "correction" && count === 1
      ? "trading_price_history"
      : count === 1
        ? "trading_market_snapshot"
        : "trading_submit_day";
  const args =
    scenario === "correction" && count === 1
      ? { tickers: ["AAPL"], lookback: 999 }
      : count === 1
        ? { tickers: ["AAPL"] }
        : {
            orders: [],
            journal: {
              text: "Hold after reviewing eligible prior prices.",
              tickers: ["AAPL"],
            },
          };
  const item = {
    id: `fc_${count}`,
    type: "function_call",
    call_id: `call_${count}`,
    name,
    arguments: JSON.stringify(args),
    status: "completed",
  };
  const response = {
    id: `resp_${count}`,
    model: PI_MODEL,
    status: "completed",
    output: [item],
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
  const events = [
    {
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, arguments: "", status: "in_progress" },
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: item.id,
      delta: item.arguments,
    },
    {
      type: "response.function_call_arguments.done",
      output_index: 0,
      item_id: item.id,
      arguments: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ];
  return new Response(
    events
      .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}) as typeof fetch;
try {
  const evidence = [];
  for (scenario of ["success", "correction", "quota", "watchdog"]) {
    count = 0;
    if (scenario !== "success") s = setup();
    if (scenario === "watchdog")
      s = {
        ...s,
        view: { ...s.view, limits: { ...s.view.limits, timeoutMs: 3000 } },
      };
    const result = await decidePi(
      s.view,
      s.store,
      [],
      s.view.horizon,
      () => {},
      {
        ...runtime,
        credential: {
          mode: "oauth",
          authorize: async () =>
            new Headers({ authorization: "Bearer synthetic-test" }),
        },
      },
      forward,
    );
    await writeFile(
      `/tmp/pi-qualification-${scenario}.json`,
      JSON.stringify(result, null, 2),
    );
    if (scenario === "success" || scenario === "correction") {
      if (result.outcome !== "completed")
        throw new Error(scenario + ": " + result.reason);
      validateAccepted(result, s.view, false, [], s.view.horizon, PI_MODEL_ID);
      if (count !== 2) throw new Error("Unexpected provider call count");
      for (const mutate of [
        (a: any) => {
          a.decision.usage.totalTokens++;
        },
        (a: any) => {
          a.decision.trace.find(
            (e: any) => e.type === "inference_request",
          ).body.reasoning.effort = "high";
        },
        (a: any) => {
          a.decision.trace.find(
            (e: any) =>
              e.type === "pi_event" && e.event.type === "tool_execution_end",
          ).event.toolCallId = "forged";
        },
      ]) {
        const changed = structuredClone(result);
        mutate(changed);
        let rejected = false;
        try {
          validateAccepted(
            changed,
            s.view,
            false,
            [],
            s.view.horizon,
            PI_MODEL_ID,
          );
        } catch {
          rejected = true;
        }
        if (!rejected) throw new Error("Tampered Pi evidence accepted");
      }
    } else {
      if (result.outcome === "completed" || count !== 1)
        throw new Error("Failed transport retried inside Pi or was accepted");
      if (scenario === "watchdog" && result.outcome !== "budget_cutoff")
        throw new Error("Watchdog not enforced");
    }
    evidence.push({
      scenario,
      passed: true,
      syntheticResponses: count,
      outcome: result.outcome,
      usage: result.decision.usage,
    });
    await rm(s.dir, { recursive: true, force: true });
  }
  console.log(
    JSON.stringify({
      passed: true,
      inferenceCalls: 0,
      evidence,
      runtime: runtime.bundle.evidence,
    }),
  );
} finally {
  await runtime.dispose();
  await rm(s.dir, { recursive: true, force: true });
}
