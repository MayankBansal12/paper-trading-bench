/** Native pinned client, real sandbox, synthetic provider responses: no host credentials or inference. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setup } from "../tests/studyTestSupport.ts";
import { prepareClaudeBundle, qualifyClaudeSandbox } from "../src/claude/sandbox.ts";
import { decideClaude } from "../src/claude/agent.ts";
import { claudeRoute, claudeClientVersion, CLAUDE_MCP_PREFIX } from "../src/claude/route.ts";
import { validateAccepted } from "../src/study/accept.ts";
import { quotaPause } from "../src/study/availability.ts";
const modelId = process.argv[2], out = process.argv[3];
if (!modelId || !out) throw new Error("Usage: bun scripts/qualify-claude.ts EXACT_ROUTE NEW_OUTPUT_DIR");
await mkdir(out); // Refuse to overwrite qualification evidence.
const model = claudeRoute(modelId).model, clientVersion = claudeClientVersion(modelId);
const bundle = await prepareClaudeBundle(clientVersion);
const reset = Math.floor(Date.now() / 1000) + 3600;
const summaries: unknown[] = [];
try {
  const runtime = {
    bundle, sandboxQualification: await qualifyClaudeSandbox(bundle), setupMs: 0,
    qualification: { exactModel: modelId, clientVersion, clientHash: bundle.evidence.claudeHash,
      noInference: true, effort: "medium", auth: "synthetic-offline", subscriptionCost: "unavailable", clientBinary: "private pin" },
    credential: { mode: "oauth" as const, authorize: async () => new Headers({ authorization: "Bearer offline-fixture" }) },
    dispose: bundle.dispose,
  };
  await writeFile(join(out, "sandbox.json"), JSON.stringify(runtime.sandboxQualification, null, 2));
  for (const scenario of ["success", "correction", "quota", "watchdog"]) {
    const s = setup();
    s.view = { ...s.view, limits: { ...s.view.limits, timeoutMs: scenario === "watchdog" ? 8000 : 30000 } };
    let calls = 0;
    const forward = (async (_url: any, init: any) => {
      calls++;
      if (scenario === "quota") return Response.json({ type: "error", error: { type: "rate_limit_error", message: "Synthetic usage limit" } },
        { status: 429, headers: { "anthropic-ratelimit-unified-5h-status": "rejected", "anthropic-ratelimit-unified-5h-reset": String(reset), "x-should-retry": "false" } });
      if (scenario === "watchdog") return await new Promise<Response>((_, reject) =>
        init.signal.addEventListener("abort", () => reject(new Error("Synthetic watchdog")), { once: true }));
      if (calls > 2) throw new Error("Unexpected post-submit inference");
      const name = calls === 1 ? "market_snapshot" : "submit_day";
      const args = calls === 1 ? { tickers: [scenario === "correction" ? "ZZZZ" : "AAPL"] } :
        { orders: [], journal: { text: "Synthetic hold after inspecting eligible prices.", tickers: ["AAPL"] } };
      const events = [
        { type: "message_start", message: { id: `msg_${calls}`, type: "message", model, role: "assistant", content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${calls}`, name: CLAUDE_MCP_PREFIX + name, input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(args) } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 40 } },
        { type: "message_stop" },
      ];
      return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const result = await decideClaude(s.view, s.store, [], s.view.horizon, () => {}, runtime, forward);
    await writeFile(join(out, scenario + ".json"), JSON.stringify(result, null, 2));
    const denied = result.decision.trace.filter(e => e.type === "gateway_denied");
    if (denied.length) throw new Error(scenario + ": " + JSON.stringify(denied));
    if (["success", "correction"].includes(scenario)) {
      validateAccepted(result, s.view, false, [], s.view.horizon, modelId);
      if (calls !== 2) throw new Error("Extra inference after submission");
      if (scenario === "correction" && result.decision.usage.failedToolCalls !== 1) throw new Error("Tool correction not exercised");
      for (const mutate of [
        (a: any) => { a.decision.trace.find((e: any) => e.type === "inference_request").body.model = "claude-haiku-4-5"; },
        (a: any) => { a.decision.usage.totalTokens++; },
        (a: any) => { a.decision.trace.find((e: any) => e.type === "inference_request").body.output_config.effort = "high"; },
      ]) {
        const changed = structuredClone(result); mutate(changed); let rejected = false;
        try { validateAccepted(changed, s.view, false, [], s.view.horizon, modelId); } catch { rejected = true; }
        if (!rejected) throw new Error("Tampered evidence accepted");
      }
    } else {
      if (result.submission || result.outcome === "completed" || result.decision.orders.length) throw new Error("Failed attempt executed");
      if (scenario === "watchdog" && result.outcome !== "budget_cutoff") throw new Error("Watchdog failed");
      if (scenario === "quota") {
        const pause = quotaPause({ trace: () => result.decision.trace } as any,
          { kind: "result", payload: { outcome: result.outcome }, scope: s.scope, recordedAt: new Date().toISOString(), hash: "fixture" } as any);
        if (pause?.notBefore !== new Date(reset * 1000 + 300000).toISOString()) throw new Error("Exact quota reset not retained");
      }
    }
    summaries.push({ scenario, outcome: result.outcome, requestsToStub: calls, providerRequests: 0, replayPassed: ["success", "correction"].includes(scenario), passed: true });
    console.log(JSON.stringify(summaries.at(-1)));
    await writeFile(join(out, "summary.json"), JSON.stringify({ modelId, clientVersion, runtime: bundle.evidence, scenarios: summaries }, null, 2));
  }
} finally { await bundle.dispose(); }
