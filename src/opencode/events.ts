import type { LiveDecision } from "../agent/trace.ts";

const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** OpenCode's JSON event stream, retained alongside validated step accounting.
 * A successful terminal requires a complete started step and explicit usage.
 * Some providers include reasoning in output, others report it separately;
 * the reported total must reconcile with exactly one of those conventions. */
export async function readEvents(stream: ReadableStream<Uint8Array>, decision: LiveDecision, maxTurns: number | null, stop: (reason: string) => void) {
  let pending = "";
  let finalReason: string | undefined;
  let error: string | undefined;
  let rationale = "";
  let bytes = 0;
  let activeStep = false;
  let completedSteps = 0;
  let terminalSeen = false;
  const decoder = new TextDecoder();
  const fail = (message: string) => { error ??= message; };
  const handle = (line: string) => {
    if (!line.trim()) return;
    let event: unknown;
    try { event = JSON.parse(line); }
    catch { decision.trace.push({ type: "opencode_malformed_event", raw: line }); fail("Malformed client JSON event"); return; }
    decision.trace.push({ type: "opencode_event", event });
    if (!object(event) || typeof event.type !== "string") { fail("Malformed client event schema"); return; }
    const part = event.part;
    if (event.type === "error") fail(JSON.stringify(event.error ?? event));
    if (event.type === "step_start") {
      if (activeStep) fail("Client started a step before finishing the previous step");
      if (terminalSeen) fail("Client started another step after terminal stop");
      activeStep = true;
      decision.usage.turns++;
      rationale = "";
      finalReason = undefined;
      if (maxTurns !== null && decision.usage.turns > maxTurns) stop(`Max turns (${maxTurns}) exceeded`);
    }
    if (event.type === "text") {
      if (!activeStep) fail("Client text appeared outside an active step");
      else if (!object(part) || typeof part.text !== "string") fail("Malformed client text part");
      else rationale += part.text;
    }
    if (event.type === "tool_use") {
      // Complete call counting, exact allowlist and MCP matching are handled
      // by reconcileClientTools, including SDK rejections before MCP.
      if (!object(part) || !String(part.tool).startsWith("trading_")) {
        decision.usage.attemptedToolCalls++;
        decision.usage.refusedToolCalls++;
        const reason = `Unexpected non-trading tool: ${object(part) ? part.tool : "malformed"}`;
        fail(reason);
        stop(reason);
      }
      if (!object(part) || part.type !== "tool" || typeof part.callID !== "string" || !part.callID || !object(part.state) || !["pending", "running", "completed", "error"].includes(part.state.status)) fail("Malformed client tool part");
      if (!activeStep) fail("Client tool call appeared outside an active step");
    }
    if (event.type === "step_finish") {
      if (!activeStep) { fail("Client finished a step without a matching start"); return; }
      activeStep = false;
      if (!object(part) || typeof part.reason !== "string" || !part.reason) { fail("Missing client finish reason"); return; }
      const tokens = part.tokens;
      if (!object(tokens) || !object(tokens.cache) || ![tokens.input, tokens.output, tokens.reasoning, tokens.total, tokens.cache.read, tokens.cache.write].every(count)
        || typeof part.cost !== "number" || !Number.isFinite(part.cost) || part.cost < 0) {
        fail("Missing or invalid usage in client event"); return;
      }
      const prompt = tokens.input + tokens.cache.read + tokens.cache.write;
      const base = prompt + tokens.output;
      let completion: number;
      if (tokens.total === base + tokens.reasoning) completion = tokens.output + tokens.reasoning;
      else if (tokens.total === base && tokens.reasoning <= tokens.output) completion = tokens.output;
      else { fail("Client token total does not reconcile with prompt, output and reasoning"); return; }
      const usage = decision.usage;
      const additions = { inputTokens: tokens.input, cacheReadTokens: tokens.cache.read, cacheWriteTokens: tokens.cache.write,
        promptTokens: prompt, completionTokens: completion, totalTokens: tokens.total };
      if (Object.entries(additions).some(([key, value]) => !count(value) || !count(usage[key as keyof typeof additions] + value)) || !Number.isFinite(usage.costUsd + part.cost)) {
        fail("Client usage total exceeds supported numeric range"); return;
      }
      for (const [key, value] of Object.entries(additions)) usage[key as keyof typeof additions] += value;
      usage.costUsd += part.cost;
      completedSteps++;
      finalReason = part.reason;
      terminalSeen ||= finalReason === "stop";
    }
  };
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > 16 * 1024 * 1024) { stop("Client trace exceeded 16 MiB"); break; }
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop()!;
    for (const line of lines) handle(line);
  }
  pending += decoder.decode();
  if (pending.trim()) handle(pending);
  if (activeStep) fail("Client stream ended with an unfinished step");
  if (completedSteps === 0) fail("Client stream contains no complete step with validated usage");
  return { finalReason, error, rationale };
}
