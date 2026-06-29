// Shared tool response formatting. Every tool returns ToolResult so the
// model can always see a clean {ok, data|error, context} shape.
//
// We keep this dependency-free so it can be imported by any tool file
// without circular issues.

import type { ToolResult } from "../types.ts";

export function ok<T>(data: T): ToolResult<T> {
  return { ok: true, data };
}

export function err(message: string, context?: Record<string, unknown>): ToolResult<never> {
  return { ok: false, error: message, ...(context ? { context } : {}) };
}

/** Format a tool result for the model — short, structured, and actionable on errors. */
export function formatResult<T>(r: ToolResult<T>): string {
  if (r.ok) return JSON.stringify(r.data, null, 2);
  const ctx = r.context ? `\nContext: ${JSON.stringify(r.context)}` : "";
  return `Error: ${r.error}${ctx}`;
}
