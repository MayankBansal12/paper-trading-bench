import { Check } from "typebox/value";
import { toolDefinitions } from "../study/tools.ts";
import { canonical, contentHash, textHash } from "../core/hash.ts";
import type { LiveUsage } from "../core/types.ts";
import type { StudyAttempt } from "../study/agent.ts";
import type { JournalEntry } from "../study/journal.ts";
import { STUDY_TOOLS, availableHistoryBars, systemPrompt, dailyPrompt, type SessionView, type SessionHorizon } from "../study/protocol.ts";
import { validateClaudeSandboxState } from "./sandbox.ts";
import { checkClaudeRequest } from "./gateway.ts";
import { SessionTools } from "../study/tools.ts";
import { CLAUDE_MODEL_ID, CLAUDE_PROVIDER, CLAUDE_EFFORT, CLAUDE_MCP_PREFIX, claudeRoute, claudeClientVersion } from "./route.ts";

const integer = (n: any) => Number.isSafeInteger(n) && n >= 0;
export interface ClaudeResponse {
  id?: string;
  model: string;
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number };
  content: any[];
}
/** Reconstructs each Anthropic SSE response from raw chunks; throws unless it is one complete, error-free message. */
export function claudeResponses(trace: any[]): ClaudeResponse[] {
  return trace.filter((e) => e.type === "inference_request").map((r) => {
    const status = trace.find((e) => e.type === "inference_response" && e.sequence === r.sequence)?.status;
    if (status !== 200) throw new Error("Claude provider response was not HTTP 200");
    const text = Buffer.concat(trace.filter((e) => e.type === "inference_chunk" && e.sequence === r.sequence).map((e) => Buffer.from(e.base64, "base64"))).toString("utf8");
    const events = text.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)));
    if (events.some((e) => e.type === "error")) throw new Error("Claude provider stream reported an error");
    const start = events.filter((e) => e.type === "message_start"), stop = events.filter((e) => e.type === "message_stop");
    if (start.length !== 1 || stop.length !== 1 || events[0].type !== "message_start" || events.at(-1).type !== "message_stop")
      throw new Error("Claude provider stream missing a unique complete message");
    const message = start[0].message;
    const blocks = new Map<number, any>();
    const partial = new Map<number, string>();
    for (const e of events) {
      if (e.type === "content_block_start") blocks.set(e.index, structuredClone(e.content_block));
      else if (e.type === "content_block_delta") {
        const b = blocks.get(e.index);
        if (!b) throw new Error("Claude delta without block");
        if (e.delta.type === "text_delta") b.text = (b.text ?? "") + e.delta.text;
        else if (e.delta.type === "thinking_delta") b.thinking = (b.thinking ?? "") + e.delta.thinking;
        else if (e.delta.type === "signature_delta") b.signature = e.delta.signature;
        else if (e.delta.type === "input_json_delta") partial.set(e.index, (partial.get(e.index) ?? "") + e.delta.partial_json);
      } else if (e.type === "content_block_stop") {
        const b = blocks.get(e.index);
        if (b?.type === "tool_use") b.input = partial.get(e.index) ? JSON.parse(partial.get(e.index)!) : {};
      }
    }
    const delta = events.filter((e) => e.type === "message_delta");
    const last = delta.at(-1);
    const usage = { ...message.usage, ...(last?.usage ?? {}) };
    return {
      id: message.id, model: message.model, stop_reason: last?.delta?.stop_reason ?? null,
      usage: {
        input_tokens: usage.input_tokens, output_tokens: usage.output_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0, cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      },
      content: [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b),
    };
  });
}
export function claudeUsage(trace: any[]): LiveUsage {
  let responses: ClaudeResponse[] = [];
  let available = true;
  try { responses = claudeResponses(trace); } catch { available = false; }
  const requests = trace.filter((e) => e.type === "inference_request").length;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const r of responses) {
    for (const [k, v] of [["input", r.usage.input_tokens], ["output", r.usage.output_tokens], ["cacheRead", r.usage.cache_read_input_tokens], ["cacheWrite", r.usage.cache_creation_input_tokens]] as const) {
      if (!integer(v)) available = false; else tokens[k] += v;
    }
    if (!["end_turn", "tool_use"].includes(r.stop_reason ?? "")) available = false;
  }
  const calls = responses.flatMap((r) => r.content.filter((p) => p.type === "tool_use"));
  const attempts = trace.filter((e) => e.type === "tool_attempt");
  const results = trace.filter((e) => e.type === "tool_result");
  const failed = results.filter((e) => e.result?.isError).length;
  return {
    completeness: "unavailable",
    missingSteps: Math.max(1, requests - responses.length),
    turns: requests,
    inputTokens: available ? tokens.input : null,
    promptTokens: available ? tokens.input + tokens.cacheRead + tokens.cacheWrite : null,
    completionTokens: available ? tokens.output : null,
    cacheReadTokens: available ? tokens.cacheRead : null,
    cacheWriteTokens: available ? tokens.cacheWrite : null,
    totalTokens: available ? tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output : null,
    costUsd: null,
    toolCalls: calls.length,
    attemptedToolCalls: calls.length,
    admittedToolCalls: attempts.length,
    refusedToolCalls: calls.length - attempts.length,
    successfulToolCalls: results.length - failed,
    failedToolCalls: failed,
    pendingToolCalls: calls.length - results.length,
  };
}
export function validateClaudeAccepted(a: StudyAttempt, view: SessionView, past: JournalEntry[], horizon: SessionHorizon, expectedModel = CLAUDE_MODEL_ID) {
  const CLAUDE_MODEL = claudeRoute(expectedModel).model;
  const CLAUDE_VERSION = claudeClientVersion(expectedModel);
  const trace = a.decision.trace;
  const protocol = trace.find((e) => e.type === "protocol");
  const system = systemPrompt(view.limits);
  if (protocol?.provider !== CLAUDE_PROVIDER || protocol.model !== CLAUDE_MODEL || a.decision.effectiveSystemPrompt !== system || a.decision.promptHash !== textHash(system))
    throw new Error("Claude model or prompt drift");
  const q = trace.filter((e) => e.type === "model_qualification");
  const runtime = a.sandbox as any;
  if (q.length !== 1 || q[0].evidence.exactModel !== expectedModel || q[0].evidence.clientVersion !== CLAUDE_VERSION || q[0].evidence.noInference !== true ||
      q[0].evidence.effort !== CLAUDE_EFFORT || q[0].evidence.clientHash !== runtime?.claudeHash || runtime?.claudeVersion !== CLAUDE_VERSION)
    throw new Error("Claude runtime qualification drift");
  const state = trace.filter((e) => e.type === "sandbox_state");
  if (state.length !== 1) throw new Error("Claude missing sandbox state");
  validateClaudeSandboxState(state[0].checks, a.sandbox);
  const terminal = trace.filter((e) => e.type === "claude_terminal");
  if (terminal.length !== 1 || terminal[0].completedSubmission !== true) throw new Error("Claude missing completed submission termination");
  if (canonical(claudeUsage(trace)) !== canonical(a.decision.usage)) throw new Error("Claude usage differs on replay");
  const requests = trace.filter((e) => e.type === "inference_request");
  const responses = claudeResponses(trace);
  if (!requests.length || requests.length !== responses.length) throw new Error("Claude request/response count differs");
  const prompt = dailyPrompt(view, horizon.start, horizon.end, horizon.contributions, past);
  const probe = new SessionTools(view, { audit() {}, submit: (_s: unknown, x: unknown) => x, entries: () => [] } as any, past, Date.now() + 1e9);
  requests.forEach((r, i) => {
    if (r.model !== CLAUDE_MODEL || r.body?.model !== CLAUDE_MODEL || r.route !== "/v1/messages" || r.bodyHash !== contentHash(r.body))
      throw new Error("Claude inference identity drift");
    const checked = checkClaudeRequest(r.body, probe, prompt, CLAUDE_MODEL);
    if (checked.reason || contentHash(checked.forward) !== r.forwardedBodyHash) throw new Error("Claude replay request context differs: " + (checked.reason ?? "forwarded body"));
    if (responses[i]!.model !== CLAUDE_MODEL) throw new Error("Provider resolved a different Claude model: " + responses[i]!.model);
    if (!["tool_use", "end_turn"].includes(responses[i]!.stop_reason ?? "")) throw new Error("Claude response incomplete");
  });
  const calls = responses.flatMap((r) => r.content.filter((p) => p.type === "tool_use"));
  const brokers = trace.filter((e) => e.type === "tool_attempt");
  const results = trace.filter((e) => e.type === "tool_result");
  if (results.length !== brokers.length || new Set(calls.map((c) => c.id)).size !== calls.length) throw new Error("Claude tool execution coverage differs");
  for (const b of brokers) {
    const c = calls.find((x) => x.id === b.providerCallId);
    if (!c || c.name !== CLAUDE_MCP_PREFIX + b.name || canonical(c.input) !== canonical(b.arguments)) throw new Error("Claude broker call not in provider response");
  }
  for (const c of calls) {
    if (brokers.some((b) => b.providerCallId === c.id)) continue;
    const name = String(c.name).slice(CLAUDE_MCP_PREFIX.length);
    const definition = toolDefinitions.find((d) => d.name === name);
    if (!definition || !(STUDY_TOOLS as readonly string[]).includes(name)) throw new Error("Claude unknown tool call");
    const schema = structuredClone(definition.inputSchema) as any;
    if (name === "price_history") { schema.properties.lookback.maximum = availableHistoryBars(view); schema.properties.tickers.maxItems = view.universe.length; }
    if (Check(schema, c.input)) throw new Error("Claude schema-valid tool call lacks broker evidence");
  }
  const submissionIndex = trace.findIndex((e) => e.type === "tool_result" && e.name === "submit_day" && !e.result.isError);
  if (submissionIndex < 0 || trace.slice(submissionIndex + 1).some((e) => e.type === "inference_request" || e.type === "tool_attempt"))
    throw new Error("Claude continued after accepted submission");
}
