import { getModel } from "@earendil-works/pi-ai/compat";
import { createHermeticAgentSession } from "./piSession.ts";
import { buildDailyPrompt, buildSystemPrompt } from "./prompt.ts";
import { buildTradingTools, type PiWorkingState } from "./tools.ts";
import { TurnBudget } from "./limits.ts";
import { hashText, initialDecision, type LiveDecision } from "./trace.ts";
import type { DecisionContext } from "../domain/types.ts";
import type { PiAgentOptions } from "./piAgent.ts";

type Request = { ctx: DecisionContext; modelId: string; provider: string; options: PiAgentOptions };
export async function runIsolatedDecision({ ctx, modelId, provider, options }: Request, snapshot: (decision: LiveDecision) => void): Promise<LiveDecision> {
  const decision = initialDecision(ctx, modelId, provider);
  const state: PiWorkingState = { date: ctx.date, universe: ctx.universe, bars: ctx.bars, indicators: ctx.indicators,
    portfolio: structuredClone(ctx.portfolio), decidedOrders: [], failedOrders: [], budget: new TurnBudget(ctx.limits, Date.now()), externalAccounting: true };
  let session: Awaited<ReturnType<typeof createHermeticAgentSession>>["session"] | undefined;
  let terminal: { outcome: LiveDecision["outcome"]; reason: string } | undefined;
  const record = (event: unknown) => decision.trace.push(JSON.parse(JSON.stringify(event)));
  const attempts = new Map<string, { name: string; args: any; refused: boolean; ended: boolean }>();
  let endEarly: () => void = () => {};
  const cutoff = new Promise<void>((resolve) => { endEarly = resolve; });
  const publish = () => {
    decision.submittedOrders = structuredClone(state.decidedOrders);
    decision.failedOrders = structuredClone(state.failedOrders);
    decision.usage.pendingToolCalls = [...attempts.values()].filter((a) => !a.ended).length;
    snapshot(decision);
  };
  const stop = (outcome: LiveDecision["outcome"], reason: string) => {
    terminal ??= { outcome, reason };
    // Signal cancellation, but never await a potentially noncooperative SDK.
    void session?.abort().catch(() => {});
    endEarly();
  };
  try {
    record({ type: "isolation_start", pid: process.pid });
    publish();
    if (options.offlineTransportModule) globalThis.fetch = (async () => { throw new Error("Network disabled in offline SDK test"); }) as unknown as typeof fetch;
    const model = getModel(provider as Parameters<typeof getModel>[0], modelId as Parameters<typeof getModel>[1]);
    if (!model) throw new Error(`Unknown model ${provider}/${modelId}; no fallback`);
    record({ type: "resolved_model", model });
    ({ session } = await createHermeticAgentSession({ model, thinkingLevel: "low", systemPrompt: buildSystemPrompt(ctx.limits),
      offline: !!options.offlineTransportModule,
      extensionFactories: [(pi) => {
        for (const tool of buildTradingTools(state)) pi.registerTool(tool);
        pi.on("tool_result", async (event) => {
          if ((event.details as { rejected?: boolean } | undefined)?.rejected) return { isError: true };
          return undefined;
        });
        pi.on("tool_call", async (event) => {
          const attempt = attempts.get(event.toolCallId);
          if (!attempt || attempt.refused || terminal) return { block: true, reason: terminal?.reason ?? "Tool attempt cap exceeded" };
          return undefined;
        });
      }],
    }));
    if (options.offlineTransportModule) {
      const fixture = await import(options.offlineTransportModule);
      await fixture.configure(session, ctx);
    }
    // Capture effective model input, after SDK prompt construction, at every request.
    const stream = session.agent.streamFn;
    session.agent.streamFn = async (model, context, streamOptions) => {
      decision.effectiveSystemPrompt = context.systemPrompt ?? "";
      decision.promptHash = hashText(decision.effectiveSystemPrompt);
      record({ type: "model_request", model: model.id, provider: model.provider,
        systemPrompt: context.systemPrompt, promptHash: decision.promptHash, messages: context.messages,
        tools: context.tools, thinkingLevel: "low" });
      publish();
      return stream(model, context, streamOptions);
    };
    session.subscribe((event) => {
      if (event.type === "turn_start") {
        if (decision.usage.turns >= ctx.limits.maxTurns) {
          stop("budget_cutoff", `max turns (${ctx.limits.maxTurns}) reached`);
          return;
        }
        decision.usage.turns++;
      }
      if (event.type === "message_update") {
        // Preserve partial output on an interrupted stream without copying all
        // prior chunks into every delta. Final SDK messages remain authoritative.
        const delta = event.assistantMessageEvent;
        if (delta.type === "text_delta" || delta.type === "thinking_delta" || delta.type === "toolcall_delta") {
          record({ type: "stream_delta", event: delta.type, contentIndex: delta.contentIndex, delta: delta.delta });
        }
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        const message = event.message;
        record({ type: "assistant", message });
        const usage = message.usage;
        decision.usage.inputTokens += usage.input;
        decision.usage.cacheReadTokens += usage.cacheRead;
        decision.usage.cacheWriteTokens += usage.cacheWrite;
        decision.usage.promptTokens = decision.usage.inputTokens + decision.usage.cacheReadTokens + decision.usage.cacheWriteTokens;
        decision.usage.completionTokens += usage.output;
        decision.usage.totalTokens += usage.totalTokens;
        decision.usage.costUsd += usage.cost.total;
        const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
        if (text) decision.rationale = text;
        for (const block of message.content) if (block.type === "toolCall") {
          if (attempts.has(block.id)) { stop("harness_error", `Duplicate tool call id: ${block.id}`); continue; }
          decision.usage.toolCalls++;
          decision.usage.attemptedToolCalls++;
          const refused = decision.usage.attemptedToolCalls > ctx.limits.maxToolCalls;
          if (refused) decision.usage.refusedToolCalls++;
          else decision.usage.admittedToolCalls++;
          attempts.set(block.id, { name: block.name, args: block.arguments, refused, ended: false });
          record({ type: "tool_attempt", id: block.id, name: block.name, arguments: block.arguments, admitted: !refused });
        }
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          terminal ??= { outcome: "provider_error", reason: message.errorMessage ?? `Provider terminal status: ${message.stopReason}` };
        } else if (message.stopReason === "length") {
          terminal ??= { outcome: "budget_cutoff", reason: "Provider output token limit reached" };
        }
      }
      if (event.type === "tool_execution_end") {
        const attempt = attempts.get(event.toolCallId);
        record({ type: "tool_result", id: event.toolCallId, name: event.toolName, isError: event.isError, result: event.result });
        if (attempt && !attempt.ended) {
          attempt.ended = true;
          if (event.isError || attempt.refused) {
            decision.usage.failedToolCalls++;
            if ((attempt.name === "buy" || attempt.name === "sell") && !state.failedOrders.some((f) => f.reason === `SDK rejection (${event.toolCallId})`)) {
              // Tool bodies already record semantic refusals; SDK validation/unknown
              // errors bypass the body and need their own ledger entry.
              const bodyRejected = event.result?.details?.side !== undefined;
              if (!bodyRejected) state.failedOrders.push({ date: ctx.date, ticker: String(attempt.args?.ticker ?? "(missing)"),
                side: attempt.name === "buy" ? "BUY" : "SELL", reason: `SDK rejection (${event.toolCallId}): ${JSON.stringify(event.result)}` });
            }
          } else decision.usage.successfulToolCalls++;
        }
        if (attempt?.refused) stop("budget_cutoff", `max tool calls (${ctx.limits.maxToolCalls}) reached`);
      }
      publish();
    });
    publish();
    await Promise.race([session.prompt(buildDailyPrompt(ctx)), cutoff]);
    const last = [...session.state.messages].reverse().find((m) => m.role === "assistant");
    if (!terminal && (!last || last.stopReason !== "stop" || !last.content.some((b) => b.type === "text" && b.text.trim()))) {
      terminal = { outcome: "harness_error", reason: "No complete final assistant rationale" };
    }
    if (!terminal && decision.usage.refusedToolCalls > 0) terminal = { outcome: "budget_cutoff", reason: `max tool calls (${ctx.limits.maxToolCalls}) reached` };
    if (!terminal && decision.usage.pendingToolCalls > 0) terminal = { outcome: "harness_error", reason: "Unfinished tool attempts" };
  } catch (error) {
    terminal ??= { outcome: "harness_error", reason: error instanceof Error ? error.message : String(error) };
  }
  publish();
  decision.outcome = terminal?.outcome ?? "completed";
  decision.terminalReason = terminal?.reason;
  decision.boundedStop = decision.outcome === "budget_cutoff";
  decision.boundedReason = decision.boundedStop ? decision.terminalReason ?? null : null;
  decision.orders = decision.outcome === "completed" ? structuredClone(state.decidedOrders) : [];
  return decision;
}
