import { randomUUID } from "node:crypto";
import { chmod } from "node:fs/promises";
import { contentHash, canonical } from "../core/hash.ts";
import { systemPrompt, STUDY_TOOLS, POLICY } from "../study/protocol.ts";
import type { SessionTools } from "../study/tools.ts";
import type { ProviderCredential } from "../opencode/credentials.ts";
import { CLAUDE_MODEL, CLAUDE_OPUS_MODEL, CLAUDE_OPUS55_MODEL, CLAUDE_FABLE51_MODEL, CLAUDE_FABLE5_MODEL, CLAUDE_EFFORT, CLAUDE_MCP_PREFIX, claudeClientVersion } from "./route.ts";

export const CLAUDE_SDK_SYSTEM = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages?beta=true";
// Claude Code otherwise persists MCP results above its default size to a file the tool-less model cannot read.
const MAX_RESULT_CHARS = POLICY.maxResponseBytes;
const BODY_KEYS = ["model", "messages", "system", "tools", "metadata", "max_tokens", "thinking", "context_management", "output_config", "stream"];
const DATE_REMINDER = /^<system-reminder>\nToday's date is (\d{4}-\d{2}-\d{2})\.\n<\/system-reminder>$/;
// Native Opus5 client format observed in a network-isolated2.1.274 fixture.
const OPUS_DATE_REMINDER = /^Today's date is (\d{4}-\d{2}-\d{2})\.$/;
const billing = (version: string) =>
  new RegExp(`^x-anthropic-billing-header: cc_version=${version.replaceAll(".", "\\.")}\\.[0-9a-f]{3}; cc_entrypoint=sdk-cli;$`);
// Native Opus5.5 client2.1.280 (network-isolated fixture2026-09-22): plain date message carrying the
// session effort as a per-message output_config, and a native max_tokens of128000.
const OPUS55_MAX_TOKENS = 128000;
const OPUS55_MESSAGE_KEYS = ["role", "content", "output_config"];
const FORWARD_HEADERS = ["accept", "anthropic-version", "user-agent", "x-app", "anthropic-dangerous-direct-browser-access"];
const REPORT_HEADERS = /^(retry-after|anthropic-ratelimit-.*|request-id|x-should-retry)$/;

export interface ClaudeGatewayOptions {
  socket: string;
  tools: SessionTools;
  credential: ProviderCredential;
  deadline: number;
  audit: (event: any) => void;
  forward?: typeof fetch;
  onBudgetCutoff?: (reason: string) => void;
  dailyPrompt: string;
  model?: string;
}
const textOf = (content: any): string[] | undefined =>
  typeof content === "string" ? [content]
    : Array.isArray(content) && content.every((p) => p?.type === "text" && typeof p.text === "string") ? content.map((p) => p.text) : undefined;

/** Validates one Claude Code Messages request against the exact benchmark context; returns a reason on rejection. */
export function checkClaudeRequest(body: any, tools: SessionTools, dailyPrompt: string, model = CLAUDE_MODEL): { reason?: string; forward?: any; rewrite?: unknown } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { reason: "invalid-request-object" };
  if (Object.keys(body).some((k) => !BODY_KEYS.includes(k))) return { reason: "external-state" };
  if (body.model !== model) return { reason: "model" };
  if (body.stream !== true) return { reason: "stream" };
  if (body.thinking?.type !== "adaptive" || body.output_config?.effort !== CLAUDE_EFFORT || Object.keys(body.output_config).length !== 1)
    return { reason: "claude-effort-drift" };
  const opus55 = model === CLAUDE_OPUS55_MODEL;
  const fable = model === CLAUDE_FABLE51_MODEL || model === CLAUDE_FABLE5_MODEL;
  // Genuine 2.1.296, captured without provider inference: adaptive updates and an
  // empty system message carrying effort. No new instructions or real date are admitted.
  if (fable && ![{ type: "adaptive", display: "updates" }, { type: "adaptive" }]
      .some((allowed) => canonical(body.thinking) === canonical(allowed)))
    return { reason: "claude-effort-drift" };
  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > (opus55 ? OPUS55_MAX_TOKENS : 64000)) return { reason: "max-tokens" };
  const system = body.system;
  if (
    !Array.isArray(system) || system.length !== 3 ||
    system.some((p: any) => p?.type !== "text" || typeof p.text !== "string") ||
    !billing(claudeClientVersion(model)).test(system[0].text) || system[1].text !== CLAUDE_SDK_SYSTEM ||
    system[2].text !== systemPrompt(tools.view.limits)
  ) return { reason: "effective-system-prompt" };
  if (!Array.isArray(body.messages) || !body.messages.length) return { reason: "missing-messages" };
  const messages = structuredClone(body.messages);
  let rewrite: unknown;
  for (const [i, m] of messages.entries()) {
    if (!m || typeof m !== "object") return { reason: "external-content" };
    if ((opus55 || fable) && (Object.keys(m).some((k) => !OPUS55_MESSAGE_KEYS.includes(k)) ||
        ("output_config" in m && canonical(m.output_config) !== canonical({ effort: CLAUDE_EFFORT }))))
      return { reason: "external-content" };
    if (m.role === "system") {
      if (fable) {
        if (!Array.isArray(m.content) || m.content.length !== 0 ||
            canonical(m.output_config) !== canonical({ effort: CLAUDE_EFFORT }))
          return { reason: "external-content" };
        continue;
      }
      const t = textOf(m.content);
      const match = t?.length === 1 ? DATE_REMINDER.exec(t[0]!) : null;
      const opusPlain = (model === CLAUDE_OPUS_MODEL || opus55) && t?.length === 1 ? OPUS_DATE_REMINDER.exec(t[0]!) : null;
      if (!match && !opusPlain) return { reason: "external-content" };
      // Preserve the native wrapper while replacing only the host date with the simulated date.
      const replaced = opusPlain ? `Today's date is ${tools.view.scope.date}.`
        : `<system-reminder>\nToday's date is ${tools.view.scope.date}.\n</system-reminder>`;
      rewrite = { from: t![0], to: replaced };
      if (typeof m.content === "string") m.content = replaced;
      else m.content[0].text = replaced;
      continue;
    }
    if (i === 0) {
      const t = m.role === "user" ? textOf(m.content) : undefined;
      if (!t || t.length !== 1 || t[0]!.trim() !== dailyPrompt.trim()) return { reason: "effective-daily-prompt" };
      continue;
    }
    if ((m.role !== "user" && m.role !== "assistant") || !Array.isArray(m.content)) return { reason: "external-content" };
    for (const p of m.content) {
      const allowed = m.role === "user" ? ["tool_result"] : ["text", "thinking", "redacted_thinking", "tool_use"];
      if (!allowed.includes(p?.type)) return { reason: "external-content" };
      if (p.type === "tool_use" && !(STUDY_TOOLS as readonly string[]).some((n) => `${CLAUDE_MCP_PREFIX}${n}` === p.name))
        return { reason: "tool-allowlist" };
    }
  }
  if (!Array.isArray(body.tools) || body.tools.length !== tools.definitions.length) return { reason: "tool-allowlist" };
  for (const d of tools.definitions) {
    const actual = body.tools.find((t: any) => t?.name === `${CLAUDE_MCP_PREFIX}${d.name}`);
    if (!actual || actual.description !== d.description || canonical(actual.input_schema) !== canonical(d.inputSchema) ||
        Object.keys(actual).some((k) => !["name", "description", "input_schema", "cache_control"].includes(k)))
      return { reason: "claude-tool-schema-drift" };
  }
  return { forward: { ...body, messages }, rewrite };
}

/** Incrementally reconstructs tool_use blocks from an Anthropic SSE stream. */
export class ToolUseStream {
  private buffer = "";
  private blocks = new Map<number, { id: string; name: string; json: string }>();
  readonly completed: Array<{ id: string; name: string; args: unknown }> = [];
  push(chunk: string) {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop()!;
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      let e: any;
      try { e = JSON.parse(line.slice(5)); } catch { continue; }
      if (e.type === "content_block_start" && e.content_block?.type === "tool_use")
        this.blocks.set(e.index, { id: e.content_block.id, name: e.content_block.name, json: "" });
      else if (e.type === "content_block_delta" && e.delta?.type === "input_json_delta")
        { const b = this.blocks.get(e.index); if (b) b.json += e.delta.partial_json; }
      else if (e.type === "content_block_stop" && this.blocks.has(e.index)) {
        const b = this.blocks.get(e.index)!;
        this.blocks.delete(e.index);
        try { this.completed.push({ id: b.id, name: b.name, args: b.json ? JSON.parse(b.json) : {} }); } catch { /* malformed input is never bound */ }
      }
    }
  }
}

export async function serveClaudeGateway(o: ClaudeGatewayOptions) {
  const { tools, audit, deadline } = o;
  const forward = o.forward ?? fetch;
  const onCutoff = o.onBudgetCutoff ?? (() => {});
  const capability = "sk-ant-bench-" + randomUUID();
  let closed = false, inferences = 0;
  const abort = new AbortController();
  const pending: Array<{ id: string; name: string; args: unknown }> = [];
  const deny = (reason: string, status = 403, detail?: unknown) => {
    audit({ type: "gateway_denied", reason, ...(detail === undefined ? {} : { detail }) });
    return new Response("Request denied", { status });
  };
  const socketOptions: { unix: string } = Object.assign({ unix: o.socket }, { idleTimeout: 0 });
  const server = Bun.serve({
    ...socketOptions,
    maxRequestBodySize: 4 * 1024 * 1024,
    async fetch(req, server) {
      server.timeout(req, 0);
      if (closed || Date.now() >= deadline) return deny("expired");
      const url = new URL(req.url);
      if (url.pathname === "/api/hello" && req.method === "HEAD") return new Response(null, { status: 200 });
      const bearer = req.headers.get("authorization");
      if (bearer !== `Bearer ${capability}` && req.headers.get("x-api-key") !== capability) return deny("unauthorized", 403, { method: req.method, path: url.pathname });
      if (url.pathname === "/mcp" && req.method === "GET") {
        audit({ type: "mcp_transport_probe", method: "GET", status: 405 });
        return new Response("POST only", { status: 405, headers: { allow: "POST" } });
      }
      if (req.method !== "POST") return deny("method/path");
      let raw: string;
      try {
        if (req.headers.get("content-encoding")) return deny("unsupported-encoding");
        raw = await req.text();
        if (Buffer.byteLength(raw) > 4 * 1024 * 1024) return deny("request-size", 413);
      } catch { return deny("invalid-request", 400); }
      let body: any;
      try { body = JSON.parse(raw); } catch { return deny("invalid-json", 400); }
      if (!body || typeof body !== "object" || Array.isArray(body)) return deny("invalid-request-object", 400);
      if (url.pathname === "/mcp") {
        if (url.search) return deny("method/path");
        if (Buffer.byteLength(raw) > POLICY.maxRequestBytes) return deny("mcp-size", 413);
        const reply = (result: any) => Response.json({ jsonrpc: "2.0", id: body.id, result });
        if (body.id === undefined) return new Response(null, { status: 202 });
        if (body.method === "initialize")
          return reply({ protocolVersion: body.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "study-session", version: "11" } });
        if (body.method === "ping") return reply({});
        if (body.method === "tools/list")
          return reply({ tools: tools.definitions.map((d) => ({ ...d, _meta: { "anthropic/maxResultSizeChars": MAX_RESULT_CHARS } })) });
        if (body.method === "tools/call") {
          const wanted = canonical(body.params?.arguments ?? {});
          const at = pending.findIndex((p) => p.name === `${CLAUDE_MCP_PREFIX}${body.params?.name}` && canonical(p.args) === wanted);
          if (at < 0) return deny("missing-provider-call-binding");
          const binding = pending.splice(at, 1)[0]!;
          audit({ type: "provider_tool_binding", callID: binding.id, tool: binding.name, args: binding.args });
          const response = reply(tools.call(body.params?.name, body.params?.arguments ?? {}, binding.id));
          if (tools.boundedReason) onCutoff(tools.boundedReason);
          return response;
        }
        if (body.method === "server/discover") {
          audit({ type: "mcp_transport_probe", method: "server/discover", status: "method-not-found" });
          return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
        }
        return deny("unknown-rpc", 400, { rpc: body.method });
      }
      if (url.pathname !== "/v1/messages" || url.search !== "?beta=true") return deny("route", 403, { method: req.method, path: url.pathname, search: url.search });
      if (tools.submission()) {
        audit({ type: "submission_finalization", reason: "client requested continuation after final submission; no provider request sent" });
        return new Response("Decision submitted", { status: 409, headers: { "x-bench-submitted": "true" } });
      }
      const checked = checkClaudeRequest(body, tools, o.dailyPrompt, o.model);
      if (checked.reason)
        return deny(checked.reason, 403, {
          system: Array.isArray(body.system) ? body.system.map((p: any) => ({ length: p?.text?.length, hash: contentHash(p?.text), head: String(p?.text).slice(0, 100) })) : null,
          expectedSystemHash: contentHash(systemPrompt(tools.view.limits)),
          tools: Array.isArray(body.tools) ? body.tools.map((t: any) => t?.name) : null,
          messageShapes: Array.isArray(body.messages) ? body.messages.map((m: any) => ({ role: m?.role, content: typeof m?.content === "string" ? "string" : Array.isArray(m?.content) ? m.content.map((p: any) => p?.type) : null })) : null,
        });
      const sequence = ++inferences;
      const forwarded = JSON.stringify(checked.forward);
      audit({
        type: "inference_request", sequence, route: url.pathname, model: body.model,
        bodyHash: contentHash(body), body, forwardedBodyHash: contentHash(checked.forward),
        ...(checked.rewrite ? { rewrite: checked.rewrite } : {}),
        tools: (body.tools ?? []).map((t: any) => t.name),
      });
      const headers = new Headers();
      for (const name of FORWARD_HEADERS) { const v = req.headers.get(name); if (v) headers.set(name, v); }
      for (const [name, value] of req.headers) if (name.startsWith("x-stainless-")) headers.set(name, value);
      const beta = new Set((req.headers.get("anthropic-beta") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
      headers.set("content-type", "application/json");
      headers.set("accept-encoding", "identity");
      let stage = "authorize";
      try {
        const auth = await o.credential.authorize(abort.signal);
        stage = "forward";
        auth.forEach((value, name) => name === "anthropic-beta" ? value.split(",").forEach((b) => beta.add(b.trim())) : headers.set(name, value));
        headers.set("anthropic-beta", [...beta].join(","));
        const response = await forward(ANTHROPIC_MESSAGES_URL, { method: "POST", headers, body: forwarded, redirect: "error", signal: abort.signal });
        const reported: Record<string, string> = {};
        response.headers.forEach((value, name) => { if (REPORT_HEADERS.test(name)) reported[name] = value; });
        audit({ type: "inference_response", sequence, status: response.status, headers: reported });
        const outHeaders = new Headers(response.headers);
        for (const h of ["content-length", "content-encoding", "set-cookie"]) outHeaders.delete(h);
        const parser = new ToolUseStream();
        const decoder = new TextDecoder();
        let bytes = 0;
        const stream = response.body?.pipeThrough(new TransformStream({
          transform(chunk, controller) {
            bytes += chunk.length;
            if (bytes > POLICY.maxOutputBytes) {
              onCutoff("Provider response exceeded byte bound");
              controller.error(new Error("Response too large"));
              return;
            }
            audit({ type: "inference_chunk", sequence, base64: Buffer.from(chunk).toString("base64") });
            parser.push(decoder.decode(chunk, { stream: true }));
            for (const c of parser.completed.splice(0)) pending.push(c);
            controller.enqueue(chunk);
          },
        }));
        return new Response(stream, { status: response.status, headers: outHeaders });
      } catch (e) {
        // Which host step failed (credential broker vs provider fetch); the bounded message never includes credentials.
        audit({ type: "inference_transport_error", stage, error: String((e as Error)?.message ?? e).replace(/Bearer\s+\S+|sk-[\w-]+/g, "[redacted]").slice(0, 200) });
        return new Response("Inference transport failed", { status: 502 });
      }
    },
  });
  await chmod(o.socket, 0o666);
  return {
    capability,
    count: () => inferences,
    close: () => { closed = true; tools.revoke(); abort.abort(); server.stop(true); },
  };
}
