import { randomUUID } from "node:crypto";
import { Check } from "typebox/value";
import { buildTradingTools, type PiWorkingState } from "../agent/tools.ts";
import type { LiveDecision } from "../agent/trace.ts";

/** A per-decision MCP endpoint with only the already-filtered historical context. */
export function serveTradingTools(state: PiWorkingState, decision: LiveDecision, stop: (reason: string) => void) {
  const route = `/${randomUUID()}`;
  const tools = buildTradingTools(state);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== route) return new Response(null, { status: 404 });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    let rpc: { id?: string | number; method?: string; params?: { name?: string; arguments?: unknown } };
    try { rpc = await request.json() as typeof rpc; } catch { return new Response(null, { status: 400 }); }
    const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: rpc.id, result });
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    if (rpc.method === "initialize") return reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "trading-bench", version: "1.0.0" } });
    if (rpc.method === "ping") return reply({});
    if (rpc.method === "tools/list") return reply({ tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })) });
    if (rpc.method !== "tools/call") return Response.json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Unknown method" } });
    const usage = decision.usage;
    usage.attemptedToolCalls++;
    const name = rpc.params?.name;
    const args = rpc.params?.arguments ?? {};
    decision.trace.push({ type: "tool_attempt", name, arguments: args });
    const error = (text: string) => ({ content: [{ type: "text", text }], isError: true });
    if (usage.admittedToolCalls >= state.budget.limits.maxToolCalls || Date.now() >= state.budget.deadlineAt()) {
      usage.refusedToolCalls++;
      const reason = "Tool-call or time budget exceeded";
      decision.trace.push({ type: "tool_refused", name, reason });
      stop(reason);
      return reply(error(reason));
    }
    usage.admittedToolCalls++;
    usage.toolCalls++;
    usage.pendingToolCalls++;
    const tool = tools.find((t) => t.name === name);
    let result;
    try {
      if (!tool) result = error(`Unknown trading tool: ${name}`);
      else if (!Check(tool.parameters, args)) {
        const reason = `Invalid arguments for ${name}`;
        const ticker = (rpc.params?.arguments as { ticker?: unknown } | undefined)?.ticker;
        if (name === "buy" || name === "sell") state.failedOrders.push({ date: state.date, side: name === "buy" ? "BUY" : "SELL",
          ticker: typeof ticker === "string" ? ticker : "(invalid)", reason });
        result = error(reason);
      }
      else result = await tool.execute(String(rpc.id), args as never, new AbortController().signal, undefined, undefined as never);
    } catch (cause) { result = error(cause instanceof Error ? cause.message : String(cause)); }
    usage.pendingToolCalls--;
    if ("isError" in result && result.isError) usage.failedToolCalls++;
    else usage.successfulToolCalls++;
    decision.trace.push({ type: "tool_result", name, result });
    return reply(result);
  } });
  return { url: `http://127.0.0.1:${server.port}${route}`, close: () => server.stop(true) };
}
