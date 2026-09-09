import { createHash } from "node:crypto";
import type { AgentDecision, DecisionContext, UsageStats } from "../domain/types.ts";
import { buildDailyPrompt, buildSystemPrompt } from "./prompt.ts";
import { AGENT_PROTOCOL_VERSION } from "./protocolVersion.ts";

export interface LiveUsage extends UsageStats {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  attemptedToolCalls: number;
  admittedToolCalls: number;
  refusedToolCalls: number;
  successfulToolCalls: number;
  pendingToolCalls: number;
}
export interface LiveDecision extends AgentDecision {
  outcome: "completed" | "budget_cutoff" | "provider_error" | "harness_error";
  terminalReason: string | undefined;
  elapsedMs: number;
  submittedOrders: AgentDecision["orders"];
  trace: unknown[];
  effectiveSystemPrompt: string;
  promptHash: string;
  usage: LiveUsage;
}
export const hashText = (text: string) => createHash("sha256").update(text).digest("hex");
export function initialDecision(ctx: DecisionContext, model: string, provider: string): LiveDecision {
  const effectiveSystemPrompt = buildSystemPrompt(ctx.limits);
  const dailyPrompt = buildDailyPrompt(ctx);
  return {
    orders: [], submittedOrders: [], failedOrders: [], rationale: "(decision did not complete)",
    boundedStop: false, boundedReason: null, outcome: "harness_error", terminalReason: undefined, elapsedMs: 0,
    effectiveSystemPrompt, promptHash: hashText(effectiveSystemPrompt),
    usage: { turns: 0, toolCalls: 0, failedToolCalls: 0, promptTokens: 0, completionTokens: 0,
      inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0,
      attemptedToolCalls: 0, admittedToolCalls: 0, refusedToolCalls: 0, successfulToolCalls: 0, pendingToolCalls: 0 },
    trace: [{ type: "protocol", version: AGENT_PROTOCOL_VERSION, provider, model,
      runtime: { bun: Bun.version, pi: "0.80.2" }, systemPrompt: effectiveSystemPrompt,
      promptHash: hashText(effectiveSystemPrompt), dailyPrompt, dailyPromptHash: hashText(dailyPrompt),
      contextHash: hashText(JSON.stringify(ctx)), policy: "atomic-day; incomplete decisions execute no orders" }],
  };
}
