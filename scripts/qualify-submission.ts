/** Official client + real sandbox + deterministic local provider fixture. No remote inference. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareModelRuntime, decideStudy } from "../src/study/agent.ts";
import { validateAccepted } from "../src/study/accept.ts";
import { loadDataset } from "../src/data/dataset.ts";
import { buildDecisionContext } from "../src/core/context.ts";
import { createInitialPortfolio } from "../src/engine/portfolio.ts";
import { makeView, scopeFor } from "../src/study/protocol.ts";
import { JournalStore } from "../src/study/journal.ts";
const watchdogFixture = process.argv.includes("--watchdog-fixture");
const slowStreamFixture = process.argv.includes("--slow-stream-fixture");
if (watchdogFixture && slowStreamFixture) throw new Error("Choose one fixture mode");
const config = {
  start: "2024-04-02",
  end: "2024-04-02",
  history: 60,
  limits: {
    maxTurns: null,
    maxToolCalls: null,
    timeoutMs: watchdogFixture ? 8000 : 30000,
  },
  contributions: [],
} as const;
const market = await loadDataset();
const view = makeView(
  buildDecisionContext(
    { ...config, contributions: [] },
    config.start,
    ["AAPL"],
    createInitialPortfolio(500),
    [],
    market,
  ),
  scopeFor("adapter-fixture", config.start, 1),
);
// Provider traffic is intercepted below; this fixture must not need a genuine credential.
process.env.OPENCODE_API_KEY = "offline-fixture-only";
const runtime = await prepareModelRuntime(),
  originalFetch = globalThis.fetch;
const dir = mkdtempSync(join(tmpdir(), "v11-offline-adapter-")),
  store = new JournalStore(dir);
store.begin(view.scope);
let requests = 0;
try {
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url) !== "https://opencode.ai/zen/v1/responses")
      throw new Error("Unexpected offline provider route");
    requests++;
    if (watchdogFixture && requests === 2)
      return await new Promise<Response>((_resolve, reject) =>
        init.signal.addEventListener(
          "abort",
          () =>
            reject(new Error("Scripted provider wait interrupted by watchdog")),
          { once: true },
        ),
      );
    if (requests > 1) throw new Error("Extra inference after final submission");
    const submissionArgs = JSON.stringify({
      orders: [],
      journal: {
        text: "Offline scripted hold tests explicit completion without another inference turn.",
        tickers: [],
      },
    });
    const args = watchdogFixture
      ? JSON.stringify({ tickers: ["AAPL"] })
      : submissionArgs;
    const item = {
      id: "fc_offline",
      type: "function_call",
      call_id: "call_offline_final",
      name: watchdogFixture ? "trading_market_snapshot" : "trading_submit_day",
      arguments: args,
      status: "completed",
    };
    const response = {
      id: "resp_offline",
      object: "response",
      created_at: 1,
      model: "muse-spark-1.3-contributor-free",
      status: "completed",
      output: [item],
      usage: {
        input_tokens: 10,
        output_tokens: 10,
        total_tokens: 20,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    };
    const events = [
      {
        type: "response.created",
        response: {
          ...response,
          status: "in_progress",
          output: [],
          usage: null,
        },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, arguments: "", status: "in_progress" },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: item.id,
        output_index: 0,
        delta: args,
      },
      {
        type: "response.function_call_arguments.done",
        item_id: item.id,
        output_index: 0,
        arguments: args,
      },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response },
    ];
    const frames = events.map((e, i) =>
      `event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number: i })}\n\n`,
    );
    let streamTimer: ReturnType<typeof setTimeout>;
    const body = slowStreamFixture ? new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frames[0]!));
        // Reproduce a valid inference stream that pauses beyond Bun's default 10s.
        streamTimer = setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(frames.slice(1).join("")));
          controller.close();
        }, 12_000);
      },
      cancel() { clearTimeout(streamTimer); },
    }) : frames.join("");
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const result = await decideStudy(
    view,
    store,
    [],
    view.horizon,
    (e) => store.audit(view.scope, e),
    runtime,
  );
  writeFileSync(
    join(dir, "result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  const evidence = {
    label:
      "scripted provider fixture, official client and real sandbox; zero remote inference",
    dir,
    outcome: result.outcome,
    reason: result.reason,
    providerFixtureRequests: requests,
    slowStreamPauseMs: slowStreamFixture ? 12_000 : 0,
    orders: result.decision.orders,
    usage: result.decision.usage,
  };
  console.log(JSON.stringify(evidence, null, 2));
  if (watchdogFixture) {
    if (
      result.outcome !== "budget_cutoff" ||
      result.decision.usage.toolCalls !== 1 ||
      result.decision.usage.turns !== requests ||
      result.submission ||
      result.decision.orders.length
    )
      throw new Error("Failed-attempt tool accounting or atomicity differs");
  } else validateAccepted(result, view, false, [], view.horizon);
  if (!watchdogFixture && requests !== 1)
    throw new Error("Submission required an extra inference");
} finally {
  globalThis.fetch = originalFetch;
  await runtime.dispose();
}
