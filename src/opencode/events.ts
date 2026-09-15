import { TOKEN_FIELDS, type LiveDecision } from "../core/types.ts";

const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** OpenCode's JSON event stream, retained alongside validated step accounting.
 * Complete steps are required; absent numeric usage is separately unavailable.
 * Some providers include reasoning in output, others report it separately;
 * the reported total must reconcile with exactly one of those conventions. */
function eventReader(
  decision: LiveDecision,
  maxTurns: number | null,
  stop: (reason: string) => void,
) {
  let finalReason: string | undefined;
  let error: string | undefined;
  let rationale = "";
  let activeStep = false;
  let completedSteps = 0;
  let terminalSeen = false;
  const fail = (message: string) => {
    error ??= message;
  };
  const handle = (line: string) => {
    if (!line.trim()) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      decision.trace.push({ type: "opencode_malformed_event", raw: line });
      fail("Malformed client JSON event");
      return;
    }
    decision.trace.push({ type: "opencode_event", event });
    if (!object(event) || typeof event.type !== "string") {
      fail("Malformed client event schema");
      return;
    }
    const part = event.part;
    if (event.type === "error") fail(JSON.stringify(event.error ?? event));
    if (event.type === "step_start") {
      if (activeStep)
        fail("Client started a step before finishing the previous step");
      if (terminalSeen) fail("Client started another step after terminal stop");
      activeStep = true;
      decision.usage.turns++;
      rationale = "";
      finalReason = undefined;
      if (maxTurns !== null && decision.usage.turns > maxTurns)
        stop(`Max turns (${maxTurns}) exceeded`);
    }
    if (event.type === "text") {
      if (!activeStep) fail("Client text appeared outside an active step");
      else if (!object(part) || typeof part.text !== "string")
        fail("Malformed client text part");
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
      if (
        !object(part) ||
        part.type !== "tool" ||
        typeof part.callID !== "string" ||
        !part.callID ||
        !object(part.state) ||
        !["pending", "running", "completed", "error"].includes(
          part.state.status,
        )
      )
        fail("Malformed client tool part");
      if (!activeStep) fail("Client tool call appeared outside an active step");
    }
    if (event.type === "step_finish") {
      if (!activeStep) {
        fail("Client finished a step without a matching start");
        return;
      }
      activeStep = false;
      if (!object(part) || typeof part.reason !== "string" || !part.reason) {
        fail("Missing client finish reason");
        return;
      }
      const tokens = part.tokens;
      const values = [
        tokens?.input,
        tokens?.output,
        tokens?.reasoning,
        tokens?.total,
        tokens?.cache?.read,
        tokens?.cache?.write,
      ];
      if (
        values.some((v) => v != null && !count(v)) ||
        (part.cost != null &&
          (typeof part.cost !== "number" ||
            !Number.isFinite(part.cost) ||
            part.cost < 0)) ||
        (tokens != null && !object(tokens)) ||
        (tokens?.cache != null && !object(tokens.cache))
      ) {
        fail("Invalid usage in client event");
        return;
      }
      // Reported cost is validated for class and finiteness here; the free-only
      // zero assertion is enforced at acceptance against the route pin.
      const usage = decision.usage;
      if (values.some((v) => v == null) || part.cost == null) {
        usage.completeness = "unavailable";
        usage.missingSteps++;
        for (const k of TOKEN_FIELDS) usage[k] = null;
        if (part.cost == null) usage.costUsd = null;
      } else {
        const prompt = tokens.input + tokens.cache.read + tokens.cache.write;
        const base = prompt + tokens.output;
        let completion: number;
        if (tokens.total === base + tokens.reasoning)
          completion = tokens.output + tokens.reasoning;
        else if (tokens.total === base && tokens.reasoning <= tokens.output)
          completion = tokens.output;
        else {
          fail(
            "Client token total does not reconcile with prompt, output and reasoning",
          );
          return;
        }
        const additions = {
          inputTokens: tokens.input,
          cacheReadTokens: tokens.cache.read,
          cacheWriteTokens: tokens.cache.write,
          promptTokens: prompt,
          completionTokens: completion,
          totalTokens: tokens.total,
        };
        if (
          Object.entries(additions).some(
            ([key, value]) =>
              !count(value) ||
              (usage[key as keyof typeof additions] !== null &&
                !count(usage[key as keyof typeof additions]! + value)),
          )
        ) {
          fail("Client usage exceeds numeric range");
          return;
        }
        for (const k of TOKEN_FIELDS)
          if (usage[k] !== null) usage[k] += additions[k];
      }
      completedSteps++;
      finalReason = part.reason;
      terminalSeen ||= finalReason === "stop";
    }
  };
  return {
    handle,
    finish() {
      if (activeStep) fail("Client stream ended with an unfinished step");
      if (completedSteps === 0)
        fail("Client stream contains no complete client step");
      return { finalReason, error, rationale };
    },
  };
}

export async function readEvents(
  stream: ReadableStream<Uint8Array>,
  decision: LiveDecision,
  maxTurns: number | null,
  stop: (reason: string) => void,
) {
  const parser = eventReader(decision, maxTurns, stop),
    decoder = new TextDecoder();
  let bytes = 0,
    pending = "";
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > 16 * 1024 * 1024) {
      stop("Client trace exceeded 16 MiB");
      break;
    }
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop()!;
    for (const line of lines) parser.handle(line);
  }
  pending += decoder.decode();
  if (pending.trim()) parser.handle(pending);
  return parser.finish();
}
/** Numeric metadata is replayed independently; malformed/unfinished streams remain invalid. */
export function verifyClientTelemetry(decision: LiveDecision) {
  const copy: LiveDecision = {
    ...decision,
    trace: [],
    usage: {
      ...decision.usage,
      turns: 0,
      costUsd: 0,
      completeness: "complete",
      missingSteps: 0,
    },
  };
  for (const k of TOKEN_FIELDS) copy.usage[k] = 0;
  let stopped: string | undefined;
  const parser = eventReader(copy, null, (r) => {
    stopped = r;
  });
  for (const e of decision.trace) {
    if (e.type === "opencode_event") parser.handle(JSON.stringify(e.event));
    if (e.type === "opencode_malformed_event")
      throw new Error("Malformed client trace");
  }
  const result = parser.finish();
  if (result.error || stopped) throw new Error(result.error ?? stopped);
  for (const k of [
    ...TOKEN_FIELDS,
    "turns",
    "costUsd",
    "completeness",
    "missingSteps",
  ] as const)
    if (copy.usage[k] !== decision.usage[k])
      throw new Error("Client usage differs on replay");
}
