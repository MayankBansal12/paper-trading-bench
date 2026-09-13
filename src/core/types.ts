import type { AgentDecision, DailyRecord } from "../domain/types.ts";
export interface StudyLimits {
  maxTurns: null;
  maxToolCalls: null;
  timeoutMs: number;
}
export const TOKEN_FIELDS = [
  "promptTokens",
  "completionTokens",
  "inputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "totalTokens",
] as const;
export type LiveUsage = Record<(typeof TOKEN_FIELDS)[number], number | null> & {
  turns: number;
  toolCalls: number;
  failedToolCalls: number;
  costUsd: number | null;
  attemptedToolCalls: number;
  admittedToolCalls: number;
  refusedToolCalls: number;
  successfulToolCalls: number;
  pendingToolCalls: number;
  completeness: "complete" | "unavailable";
  missingSteps: number;
};
export interface LiveDecision extends Omit<AgentDecision, "usage"> {
  outcome: "completed" | "budget_cutoff" | "provider_error" | "harness_error";
  terminalReason: string | undefined;
  elapsedMs: number;
  submittedOrders: AgentDecision["orders"];
  trace: any[];
  effectiveSystemPrompt: string;
  promptHash: string;
  usage: LiveUsage;
}
export type StudyRecord = Omit<DailyRecord, "usage" | "decision" | "rationale">;
export function validateUsage(u: LiveUsage) {
  if (!u || !["complete", "unavailable"].includes(u.completeness))
    throw new Error("Invalid usage status");
  for (const k of [
    "turns",
    "toolCalls",
    "failedToolCalls",
    "attemptedToolCalls",
    "admittedToolCalls",
    "refusedToolCalls",
    "successfulToolCalls",
    "pendingToolCalls",
    "missingSteps",
  ] as const)
    if (!Number.isSafeInteger(u[k]) || u[k] < 0)
      throw new Error("Invalid usage counter");
  for (const k of TOKEN_FIELDS)
    if (u[k] !== null && (!Number.isSafeInteger(u[k]) || u[k]! < 0))
      throw new Error("Invalid token counter");
  if (u.costUsd !== null && (!Number.isFinite(u.costUsd) || u.costUsd < 0))
    throw new Error("Invalid cost");
  if (
    (u.completeness === "complete") !==
    (u.missingSteps === 0 &&
      TOKEN_FIELDS.every((k) => u[k] !== null) &&
      u.costUsd !== null)
  )
    throw new Error("Inconsistent usage completeness");
}
