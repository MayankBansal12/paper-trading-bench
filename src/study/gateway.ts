import { randomUUID } from "node:crypto";
import { chmod } from "node:fs/promises";
import { contentHash } from "../run/persist.ts";
import { STUDY_TOOLS, POLICY } from "./protocol.ts";
import { SessionTools, toolDefinitions } from "./tools.ts";
import { QUALIFIED_ZEN_MODEL } from "../opencode/qualification.ts";
export async function serveGateway(
  socket: string,
  tools: SessionTools,
  apiKey: string,
  deadline: number,
  audit: (event: any) => void,
  forward: typeof fetch = fetch,
  onBudgetCutoff: (reason: string) => void = () => {},
) {
  const capability = randomUUID();
  let closed = false, inferences = 0;
  const abort = new AbortController();
  const deny = (reason: string, status = 403) => {
    audit({ type: "gateway_denied", reason });
    return new Response("Request denied", { status });
  };
  const server = Bun.serve({
    unix: socket,
    maxRequestBodySize: 2 * 1024 * 1024,
    async fetch(req, server) {
      server.timeout(req, 0); // Host session deadline bounds slow inference on this Unix socket.
      if (closed || Date.now() >= deadline) return deny("expired");
      if (req.headers.get("authorization") !== `Bearer ${capability}`)
        return deny("unauthorized");
      const url = new URL(req.url);
      if (url.search || req.method !== "POST") return deny("method/path");
      const raw = await req.text();
      if (closed || Date.now() >= deadline) return deny("expired");
      let body: any;
      try {
        body = JSON.parse(raw);
      } catch {
        return deny("invalid-json", 400);
      }
      if (url.pathname === "/mcp") {
        if (Buffer.byteLength(raw) > POLICY.maxRequestBytes)
          return deny("mcp-size", 413);
        const reply = (result: any) =>
          Response.json({ jsonrpc: "2.0", id: body.id, result });
        if (body.id === undefined) return new Response(null, { status: 202 });
        if (body.method === "initialize")
          return reply({
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "study-session", version: "10" },
          });
        if (body.method === "ping") return reply({});
        if (body.method === "tools/list")
          return reply({ tools: toolDefinitions });
        if (body.method === "tools/call") {
          const response = reply(tools.call(body.params?.name, body.params?.arguments ?? {}));
          if (tools.boundedReason) onBudgetCutoff(tools.boundedReason);
          return response;
        }
        return deny("unknown-rpc", 400);
      }
      if (
        !["/inference/chat/completions", "/inference/responses"].includes(
          url.pathname,
        )
      )
        return deny("route");
      if (body.model !== QUALIFIED_ZEN_MODEL) return deny("model");
      // Provider-hosted retrieval is also outside the experiment. No URL media,
      // uploaded files, response continuations, external MCP or server-side tools.
      const contentSafe = (value: any): boolean =>
        value == null ||
        typeof value === "string" ||
        (Array.isArray(value) &&
          value.every(
            (part) =>
              part &&
              ["text", "input_text", "output_text"].includes(part.type) &&
              typeof part.text === "string" &&
              Object.keys(part).every((k) =>
                ["type", "text", "cache_control"].includes(k),
              ),
          ));
      if (
        body.messages !== undefined &&
        (!Array.isArray(body.messages) ||
          body.messages.some(
            (m: any) =>
              !m ||
              !["system", "developer", "user", "assistant", "tool"].includes(
                m.role,
              ) ||
              !contentSafe(m.content) ||
              Object.keys(m).some(
                (k) =>
                  ![
                    "role",
                    "content",
                    "tool_calls",
                    "tool_call_id",
                    "name",
                    "reasoning_content",
                    "reasoning",
                  ].includes(k),
              ),
          ))
      )
        return deny("external-content");
      if (
        body.input !== undefined &&
        typeof body.input !== "string" &&
        (!Array.isArray(body.input) ||
          body.input.some(
            (m: any) =>
              !m ||
              !(
                (m.type === "function_call" &&
                  typeof m.arguments === "string") ||
                (m.type === "function_call_output" &&
                  typeof m.output === "string") ||
                m.type === "reasoning" ||
                (["message", undefined].includes(m.type) &&
                  contentSafe(m.content))
              ),
          ))
      )
        return deny("external-content");
      if (
        [
          "previous_response_id",
          "conversation",
          "file_ids",
          "attachments",
          "web_search_options",
          "plugins",
          "background",
        ].some((k) => body[k] !== undefined)
      )
        return deny("external-state");
      if (body.store === true) return deny("remote-storage");
      if (
        body.tools !== undefined &&
        (!Array.isArray(body.tools) ||
          body.tools.some(
            (t: any) =>
              t?.type !== "function" ||
              !(STUDY_TOOLS as readonly string[]).some(
                (n) => `trading_${n}` === (t.function?.name ?? t.name),
              ),
          ))
      )
        return deny("tool-allowlist");
      const sequence = ++inferences;
      audit({
        type: "inference_request",
        sequence,
        route: url.pathname,
        model: body.model,
        bodyHash: contentHash(body),
        tools: (body.tools ?? []).map((t: any) => t.function?.name ?? t.name),
      });
      const headers = new Headers();
      for (const [name, value] of req.headers)
        if (
          name === "user-agent" ||
          name === "accept" ||
          name.startsWith("x-opencode-") ||
          name.startsWith("x-stainless-")
        )
          headers.set(name, value);
      headers.set("authorization", `Bearer ${apiKey}`);
      headers.set("content-type", "application/json");
      headers.set("accept-encoding", "identity");
      try {
        const response = await forward(
          "https://opencode.ai/zen/v1" +
            url.pathname.slice("/inference".length),
          {
            method: "POST",
            headers,
            body: raw,
            redirect: "error",
            signal: abort.signal,
          },
        );
        audit({
          type: "inference_response",
          sequence,
          status: response.status,
        });
        const outHeaders = new Headers(response.headers);
        outHeaders.delete("content-length");
        outHeaders.delete("content-encoding");
        outHeaders.delete("set-cookie");
        return new Response(response.body, {
          status: response.status,
          headers: outHeaders,
        });
      } catch {
        audit({ type: "inference_transport_error" });
        return new Response("Inference transport failed", { status: 502 });
      }
    },
  });
  await chmod(socket, 0o666);
  return {
    capability,
    baseURL: "http://127.0.0.1:8765/inference",
    mcpURL: "http://127.0.0.1:8765/mcp",
    count: () => inferences,
    close: () => {
      closed = true;
      tools.revoke();
      abort.abort();
      server.stop(true);
    },
  };
}
