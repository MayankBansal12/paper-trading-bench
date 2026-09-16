import { Check } from "typebox/value";
import { toolDefinitions } from "../study/tools.ts";
import { canonical, contentHash, textHash } from "../core/hash.ts";
import type { LiveUsage } from "../core/types.ts";
import type { StudyAttempt } from "../study/agent.ts";
import type { JournalEntry } from "../study/journal.ts";
import {
  STUDY_TOOLS,
  availableHistoryBars,
  systemPrompt,
  dailyPrompt,
  type SessionView,
  type SessionHorizon,
} from "../study/protocol.ts";
import { assertProviderContext } from "../opencode/context.ts";
import { validateSandboxState } from "../study/sandbox.ts";
import {
  PI_MODEL,
  PI_MODEL_ID,
  PI_PROVIDER,
  PI_VERSION,
  PI_THINKING,
} from "./route.ts";
const integer = (n: any) => Number.isSafeInteger(n) && n >= 0;
const id = (value: string) => value.split("|")[0];
export function piMessages(trace: any[]) {
  return trace
    .filter(
      (e) =>
        e.type === "pi_event" &&
        e.event.type === "message_end" &&
        e.event.message?.role === "assistant",
    )
    .map((e) => e.event.message);
}
export function piUsage(trace: any[]): LiveUsage {
  const messages = piMessages(trace);
  const starts = trace.filter(
    (e) => e.type === "pi_event" && e.event.type === "tool_execution_start",
  );
  const ends = trace.filter(
    (e) => e.type === "pi_event" && e.event.type === "tool_execution_end",
  );
  const tokens = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
  };
  let available =
    messages.length > 0 &&
    messages.every((m) => ["stop", "toolUse"].includes(m.stopReason));
  for (const m of messages)
    for (const k of Object.keys(tokens) as (keyof typeof tokens)[]) {
      if (!integer(m.usage?.[k])) available = false;
      else tokens[k] += m.usage[k];
    }
  const failed = ends.filter((e) => e.event.isError).length;
  return {
    // Subscription billing is not a proven API price. Keep measured tokens but cost unavailable.
    completeness: "unavailable",
    missingSteps: Math.max(
      1,
      trace.filter((e) => e.type === "inference_request").length -
        messages.length,
    ),
    turns: trace.filter((e) => e.type === "inference_request").length,
    inputTokens: available ? tokens.input : null,
    promptTokens: available
      ? tokens.input + tokens.cacheRead + tokens.cacheWrite
      : null,
    completionTokens: available ? tokens.output : null,
    cacheReadTokens: available ? tokens.cacheRead : null,
    cacheWriteTokens: available ? tokens.cacheWrite : null,
    totalTokens: available ? tokens.totalTokens : null,
    costUsd: null,
    toolCalls: starts.length,
    attemptedToolCalls: starts.length,
    admittedToolCalls: trace.filter((e) => e.type === "tool_attempt").length,
    refusedToolCalls:
      starts.length - trace.filter((e) => e.type === "tool_attempt").length,
    successfulToolCalls: ends.length - failed,
    failedToolCalls: failed,
    pendingToolCalls: starts.length - ends.length,
  };
}
export function providerResponses(trace: any[]) {
  const requests = trace.filter((e) => e.type === "inference_request");
  return requests.map((r) => {
    const bytes = Buffer.concat(
      trace
        .filter(
          (e) => e.type === "inference_chunk" && e.sequence === r.sequence,
        )
        .map((e) => Buffer.from(e.base64, "base64")),
    );
    const events = bytes
      .toString("utf8")
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter((line) => line && line !== "[DONE]")
      .map((line) => JSON.parse(line));
    const terminal = events.filter(
      (e) => e.type === "response.completed" || e.type === "response.done",
    );
    if (terminal.length !== 1 || terminal[0].response?.status !== "completed")
      throw new Error("Pi provider stream missing a unique completed response");
    // Codex may omit output from response.completed while emitting authoritative
    // response.output_item.done records. Reconstruct those items in wire order.
    const items = events.filter((e) => e.type === "response.output_item.done");
    if (
      items.some(
        (e, i) =>
          e.output_index !== i || !e.item || typeof e.item.id !== "string",
      ) ||
      new Set(items.map((e) => e.item.id)).size !== items.length
    )
      throw new Error(
        "Pi provider output item sequence is incomplete or duplicated",
      );
    const output = items.map((e) => e.item);
    const finalOutput = terminal[0].response.output;
    if (
      Array.isArray(finalOutput) &&
      finalOutput.length &&
      canonical(finalOutput) !== canonical(output)
    )
      throw new Error(
        "Pi terminal output differs from streamed completed items",
      );
    return { ...terminal[0].response, output };
  });
}
export function validatePiAccepted(
  a: StudyAttempt,
  view: SessionView,
  past: JournalEntry[],
  horizon: SessionHorizon,
) {
  const trace = a.decision.trace;
  const protocol = trace.find((e) => e.type === "protocol");
  const system = systemPrompt(view.limits);
  if (
    protocol?.provider !== PI_PROVIDER ||
    protocol.model !== PI_MODEL ||
    a.decision.effectiveSystemPrompt !== system ||
    a.decision.promptHash !== textHash(system)
  )
    throw new Error("Pi model or prompt drift");
  const q = trace.filter((e) => e.type === "model_qualification");
  const runtime = (a.sandbox as any)?.pi;
  if (
    q.length !== 1 ||
    q[0].evidence.exactModel !== PI_MODEL_ID ||
    q[0].evidence.clientVersion !== PI_VERSION ||
    q[0].evidence.noInference !== true ||
    q[0].evidence.thinking !== PI_THINKING ||
    q[0].evidence.packageHash !== runtime?.packageHash ||
    contentHash(q[0].evidence.model) !== runtime?.catalogHash
  )
    throw new Error("Pi runtime qualification drift");
  if (
    runtime?.model !== PI_MODEL_ID ||
    runtime.version !== PI_VERSION ||
    runtime.thinking !== PI_THINKING ||
    runtime.transport !== "sse"
  )
    throw new Error("Pi runtime identity drift");
  const state = trace.filter((e) => e.type === "sandbox_state");
  if (state.length !== 1) throw new Error("Pi missing sandbox state");
  validateSandboxState(state[0].checks, a.sandbox);
  const terminal = trace.filter((e) => e.type === "pi_terminal");
  if (terminal.length !== 1 || terminal[0].completedSubmission !== true)
    throw new Error("Pi missing completed submission termination");
  if (canonical(piUsage(trace)) !== canonical(a.decision.usage))
    throw new Error("Pi usage differs on replay");
  const requests = trace.filter((e) => e.type === "inference_request");
  const messages = piMessages(trace);
  const responses = providerResponses(trace);
  if (!requests.length || requests.length !== messages.length)
    throw new Error("Pi request/message count differs");
  for (let i = 0; i < requests.length; i++) {
    const r = requests[i],
      m = messages[i],
      response = responses[i];
    if (
      r.model !== PI_MODEL ||
      r.body?.model !== PI_MODEL ||
      r.route !== "/inference/responses" ||
      r.body.reasoning?.effort !== PI_THINKING ||
      r.bodyHash !== contentHash(r.body)
    )
      throw new Error("Pi inference identity drift");
    assertProviderContext(
      r.body,
      system,
      dailyPrompt(
        view,
        horizon.start,
        horizon.end,
        horizon.contributions,
        past,
      ),
      STUDY_TOOLS,
    );
    for (const definition of toolDefinitions) {
      const schema = structuredClone(definition.inputSchema) as any;
      if (definition.name === "price_history") {
        schema.properties.lookback.maximum = availableHistoryBars(view);
        schema.properties.tickers.maxItems = view.universe.length;
      }
      const effective = r.body.tools.find(
        (t: any) => t.name === `trading_${definition.name}`,
      );
      if (
        canonical(effective?.parameters) !== canonical(schema) ||
        effective.description !== definition.description
      )
        throw new Error("Pi replay tool-schema drift");
    }
    if (
      m.model !== PI_MODEL ||
      m.provider !== PI_PROVIDER ||
      m.api !== "openai-codex-responses" ||
      !["toolUse", "stop"].includes(m.stopReason) ||
      m.errorMessage
    )
      throw new Error("Pi assistant response identity or completion invalid");
    if (response.model !== PI_MODEL)
      throw new Error(
        "Provider resolved a different Astra model: " + response.model,
      );
    const u = response.usage,
      cached = u?.input_tokens_details?.cached_tokens ?? 0;
    if (
      !integer(u?.input_tokens) ||
      !integer(u?.output_tokens) ||
      !integer(cached) ||
      m.usage.input !== u.input_tokens - cached ||
      m.usage.cacheRead !== cached ||
      m.usage.output !== u.output_tokens ||
      m.usage.totalTokens !== u.input_tokens + u.output_tokens
    )
      throw new Error("Pi usage differs from raw provider response");
    const rawCalls = (response.output ?? []).filter(
      (o: any) => o.type === "function_call",
    );
    const calls = m.content.filter((p: any) => p.type === "toolCall");
    if (
      rawCalls.length !== calls.length ||
      rawCalls.some(
        (c: any, j: number) =>
          c.call_id !== id(calls[j].id) ||
          c.name !== calls[j].name ||
          canonical(JSON.parse(c.arguments)) !== canonical(calls[j].arguments),
      )
    )
      throw new Error("Pi tool calls differ from raw provider response");
  }
  const calls = messages.flatMap((m) =>
    m.content.filter((p: any) => p.type === "toolCall"),
  );
  const starts = trace
    .filter(
      (e) => e.type === "pi_event" && e.event.type === "tool_execution_start",
    )
    .map((e) => e.event);
  const ends = trace
    .filter(
      (e) => e.type === "pi_event" && e.event.type === "tool_execution_end",
    )
    .map((e) => e.event);
  const brokers = trace.filter((e) => e.type === "tool_attempt");
  const results = trace.filter((e) => e.type === "tool_result");
  if (
    calls.length !== starts.length ||
    starts.length !== ends.length ||
    results.length !== brokers.length ||
    new Set(calls.map((c: any) => c.id)).size !== calls.length
  )
    throw new Error("Pi tool execution coverage differs");
  calls.forEach((c: any, i: number) => {
    const start = starts[i],
      end = ends[i],
      broker = brokers.find((b) => b.providerCallId === c.id),
      result = broker ? results[brokers.indexOf(broker)] : undefined;
    if (
      !(STUDY_TOOLS as readonly string[]).some(
        (n) => `trading_${n}` === c.name,
      ) ||
      start.toolCallId !== c.id ||
      end.toolCallId !== c.id ||
      start.toolName !== c.name ||
      end.toolName !== c.name ||
      canonical(start.args) !== canonical(c.arguments)
    )
      throw new Error("Pi tool binding mismatch");
    if (!broker) {
      const definition = toolDefinitions.find(
        (d) => `trading_${d.name}` === c.name,
      );
      const schema = structuredClone(definition!.inputSchema) as any;
      if (c.name === "trading_price_history") {
        schema.properties.lookback.maximum = availableHistoryBars(view);
        schema.properties.tickers.maxItems = view.universe.length;
      }
      if (!end.isError || Check(schema, c.arguments))
        throw new Error(
          "Pi refused a schema-valid tool without broker evidence",
        );
      return;
    }
    if (
      `trading_${broker.name}` !== c.name ||
      canonical(broker.arguments) !== canonical(c.arguments)
    )
      throw new Error("Pi broker arguments mismatch");
    if (
      !!end.isError !== !!result!.result.isError ||
      (!end.isError &&
        canonical(end.result?.details?.benchmarkResult) !==
          canonical(result!.result))
    )
      throw new Error("Pi tool result differs from broker");
  });
  if (brokers.some((b) => !calls.some((c: any) => c.id === b.providerCallId)))
    throw new Error("Pi orphan broker call");
  const submissionIndex = trace.findIndex(
    (e) =>
      e.type === "tool_result" && e.name === "submit_day" && !e.result.isError,
  );
  if (
    submissionIndex < 0 ||
    trace
      .slice(submissionIndex + 1)
      .some((e) => e.type === "inference_request" || e.type === "tool_attempt")
  )
    throw new Error("Pi continued after accepted submission");
}
