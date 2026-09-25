import { resolve } from "node:path";
import { quotaWasReset } from "./continuation.ts";
import type { JournalEvent, JournalStore } from "./journal.ts";

/** Opt-in scheduling policy, frozen in every child config. It never refunds an attempt. */
export const QUOTA_PAUSE_POLICY = Object.freeze({
  version: "quota-pause-v1",
  fallbackCooldownMs: 6 * 60 * 60 * 1000,
  resetBufferMs: 5 * 60 * 1000,
});
export interface QuotaPause {
  reason: "provider-usage-limit";
  notBefore: string;
  failedAttempt: number;
  resultEventHash: string;
}
export function quotaPause(store: JournalStore, event?: JournalEvent): QuotaPause | undefined {
  if (!event || event.kind !== "result" || event.payload.outcome === "completed") return;
  const trace = store.trace(event.scope);
  const responses = trace.filter(e => e.type === "inference_response" && e.status === 429);
  const recorded = Date.parse(event.recordedAt);
  let reset: number | undefined;
  let found = false;
  for (const response of responses) {
    const raw = Buffer.concat(trace.filter(e => e.type === "inference_chunk" && e.sequence === response.sequence)
      .map(e => Buffer.from(e.base64, "base64"))).toString("utf8");
    try {
      const error = JSON.parse(raw)?.error;
      const anthropic = error?.type === "rate_limit_error";
      if (!anthropic && !["usage_limit_reached", "insufficient_quota", "usage_not_included", "GoUsageLimitError"].includes(error?.type ?? error?.code)) continue;
      found = true;
      const h = (response as any).headers ?? {};
      const stamp = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 1e9 && n < 1e11 ? n * 1000 : Date.parse(String(v ?? "")); };
      // A response includes resets for available buckets too. Only rejected buckets
      // constrain this retry; e.g. an allowed weekly bucket must not extend a 5h pause.
      const rejectedResets = anthropic ? Object.entries(h)
        .filter(([k]) => /^anthropic-ratelimit-.*-reset$/.test(k) && h[k.replace(/-reset$/, "-status")] === "rejected")
        .map(([, v]) => stamp(v)).filter((n) => Number.isFinite(n) && n > recorded) : [];
      // The unified reset is the provider's representative limit, including older
      // responses which omit bucket statuses. Otherwise use Retry-After below.
      const unified = h["anthropic-ratelimit-unified-status"] === "allowed" ? NaN
        : stamp(h["anthropic-ratelimit-unified-reset"]);
      const at = anthropic ? (rejectedResets.length ? Math.max(...rejectedResets) : unified) : Number(error.resets_at) * 1000;
      const relative = anthropic ? recorded + Number(h["retry-after"]) * 1000 : recorded + Number(error.resets_in_seconds) * 1000;
      const received = Date.parse(response.receivedAt ?? "") || recorded;
      const retry = typeof response.retryAfter === "string" && /^\d+(\.\d+)?$/.test(response.retryAfter)
        ? received + Number(response.retryAfter) * 1000 : Date.parse(response.retryAfter ?? "");
      const candidate = !anthropic && Number.isFinite(retry) && retry > received ? retry
        : Number.isFinite(at) && at > recorded ? at
        : Number.isFinite(relative) && relative > recorded ? relative
        : recorded + QUOTA_PAUSE_POLICY.fallbackCooldownMs;
      reset = Math.max(reset ?? 0, candidate + QUOTA_PAUSE_POLICY.resetBufferMs);
    } catch { /* A generic 429 is not proof of account quota exhaustion. */ }
  }
  if (!found || reset === undefined) return;
  if (typeof event.scope.runId === "string" && quotaWasReset(resolve("results/studies", event.scope.runId), event)) return;
  return { reason: "provider-usage-limit", notBefore: new Date(reset).toISOString(),
    failedAttempt: event.scope.attempt, resultEventHash: event.hash };
}
