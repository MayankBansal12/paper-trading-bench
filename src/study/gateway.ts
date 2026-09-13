import { randomUUID } from "node:crypto";
import { chmod } from "node:fs/promises";
import { contentHash, canonical } from "../core/hash.ts";
import { assertProviderContext } from "../opencode/context.ts";
import { OPENCODE_PROMPT_SUFFIX } from "../opencode/config.ts";
import { systemPrompt } from "./protocol.ts";
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
  let closed = false,
    inferences = 0;
  const abort = new AbortController();
  const bindings: Array<{ callID: string; tool: string; args: unknown }> = [];
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
      // The official MCP client probes an optional SSE stream. This stateless broker
      // implements POST only; a 405 is normal transport negotiation, not a tool attempt.
      if (!url.search && url.pathname === "/mcp" && req.method === "GET") {
        audit({ type: "mcp_transport_probe", method: "GET", status: 405 });
        return new Response("POST only", {
          status: 405,
          headers: { allow: "POST" },
        });
      }
      if (url.search || req.method !== "POST") return deny("method/path");
      const raw = await req.text();
      if (closed || Date.now() >= deadline) return deny("expired");
      let body: any;
      try {
        body = JSON.parse(raw);
      } catch {
        return deny("invalid-json", 400);
      }
      if (url.pathname === "/bind-call") {
        if (Buffer.byteLength(raw) > POLICY.maxRequestBytes)
          return deny("binding-size", 413);
        if (
          typeof body.callID !== "string" ||
          !body.callID ||
          body.callID.length > 160 ||
          !(STUDY_TOOLS as readonly string[]).some(
            (t) => `trading_${t}` === body.tool,
          )
        )
          return deny("invalid-call-binding");
        if (bindings.some((b) => b.callID === body.callID))
          return deny("duplicate-call-binding");
        bindings.push(body);
        audit({ type: "provider_tool_binding", ...body });
        return Response.json({ bound: true });
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
            serverInfo: { name: "study-session", version: "11" },
          });
        if (body.method === "ping") return reply({});
        if (body.method === "tools/list")
          return reply({ tools: toolDefinitions });
        if (body.method === "tools/call") {
          const bindingIndex = bindings.findIndex(
            (b) =>
              b.tool === `trading_${body.params?.name}` &&
              canonical(b.args) === canonical(body.params?.arguments ?? {}),
          );
          if (bindingIndex < 0) return deny("missing-provider-call-binding");
          const binding = bindings.splice(bindingIndex, 1)[0]!;
          const response = reply(
            tools.call(
              body.params?.name,
              body.params?.arguments ?? {},
              binding.callID,
            ),
          );
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
      if (tools.submission()) {
        audit({
          type: "submission_finalization",
          reason:
            "client requested continuation after final submission; no provider request sent",
        });
        return new Response("Decision submitted", {
          status: 409,
          headers: { "x-bench-submitted": "true" },
        });
      }
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
      try {
        assertProviderContext(
          body,
          systemPrompt(tools.view.limits) + OPENCODE_PROMPT_SUFFIX,
          tools.prompt(),
          STUDY_TOOLS,
        );
      } catch {
        return deny("effective-context-or-tools");
      }
      const sequence = ++inferences;
      audit({
        type: "inference_request",
        sequence,
        route: url.pathname,
        model: body.model,
        bodyHash: contentHash(body),
        body,
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
        let responseBytes = 0;
        const stream = response.body?.pipeThrough(
          new TransformStream({
            transform(chunk, controller) {
              responseBytes += chunk.length;
              if (responseBytes > POLICY.maxOutputBytes) {
                onBudgetCutoff("Provider response exceeded byte bound");
                controller.error(new Error("Response too large"));
                return;
              }
              audit({
                type: "inference_chunk",
                sequence,
                base64: Buffer.from(chunk).toString("base64"),
              });
              controller.enqueue(chunk);
            },
          }),
        );
        return new Response(stream, {
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
