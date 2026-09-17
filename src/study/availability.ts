import type { JournalEvent, JournalStore } from "./journal.ts";
import { QUALIFIED_ZEN_MODEL_ID } from "../opencode/qualification.ts";
import { isPiModel } from "../pi/route.ts";

/** Opt-in scheduling policy, frozen in every child config. It never refunds an attempt. */
export const QUOTA_PAUSE_POLICY = Object.freeze({
  version: "quota-pause-v1",
  fallbackCooldownMs: 6 * 60 * 60 * 1000,
  resetBufferMs: 5 * 60 * 1000,
});
export const ZEN_QUOTA_PAUSE_POLICY = Object.freeze({
  ...QUOTA_PAUSE_POLICY,
  version: "zen-rate-limit-pause-v1",
});
export type AvailabilityPolicy = typeof QUOTA_PAUSE_POLICY | typeof ZEN_QUOTA_PAUSE_POLICY;
export function availabilityPolicy(model: string = QUALIFIED_ZEN_MODEL_ID): AvailabilityPolicy {
  if (model === QUALIFIED_ZEN_MODEL_ID) return ZEN_QUOTA_PAUSE_POLICY;
  if (isPiModel(model)) return QUOTA_PAUSE_POLICY;
  throw new Error("Unqualified availability policy or model");
}
export interface QuotaPause {
  reason: "provider-usage-limit";
  notBefore: string;
  failedAttempt: number;
  resultEventHash: string;
}
export function quotaPause(store: JournalStore, event?: JournalEvent, policy: AvailabilityPolicy = QUOTA_PAUSE_POLICY): QuotaPause | undefined {
  if (!event || event.kind !== "result" || event.payload.outcome === "completed") return;
  const trace = store.trace(event.scope);
  const responses = trace.filter(e => e.type === "inference_response" && e.status === 429);
  const recorded = Date.parse(event.recordedAt);
  let reset: number | undefined;
  let found = false;
  for (const response of responses) {
    if (policy.version === ZEN_QUOTA_PAUSE_POLICY.version) {
      // Every Zen 429 pauses, including missing or unrecognized error bodies.
      // Interpret only Retry-After as a header reset; retain no other headers.
      const value = response.retryAfter;
      const seconds = typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
      const headerAt = Number.isFinite(seconds) ? recorded + seconds * 1000 : Date.parse(value ?? "");
      const raw = Buffer.concat(trace.filter(e => e.type === "inference_chunk" && e.sequence === response.sequence)
        .map(e => Buffer.from(e.base64, "base64"))).toString("utf8");
      let error: any;
      try { error = JSON.parse(raw)?.error; } catch {}
      const absolute = Number(error?.resets_at) * 1000;
      const relative = recorded + Number(error?.resets_in_seconds) * 1000;
      const candidates = [headerAt, absolute, relative].filter(n => Number.isFinite(n) && n > recorded);
      const candidate = candidates.length ? Math.max(...candidates) : recorded + policy.fallbackCooldownMs;
      found = true;
      reset = Math.max(reset ?? 0, candidate + policy.resetBufferMs);
      continue;
    }
    const raw = Buffer.concat(trace.filter(e => e.type === "inference_chunk" && e.sequence === response.sequence)
      .map(e => Buffer.from(e.base64, "base64"))).toString("utf8");
    try {
      const error = JSON.parse(raw)?.error;
      if (!["usage_limit_reached", "insufficient_quota", "usage_not_included"].includes(error?.type ?? error?.code)) continue;
      found = true;
      const at = Number(error.resets_at) * 1000;
      const relative = recorded + Number(error.resets_in_seconds) * 1000;
      const candidate = Number.isFinite(at) && at > recorded ? at
        : Number.isFinite(relative) && relative > recorded ? relative
        : recorded + QUOTA_PAUSE_POLICY.fallbackCooldownMs;
      reset = Math.max(reset ?? 0, candidate + QUOTA_PAUSE_POLICY.resetBufferMs);
    } catch { /* A generic 429 is not proof of account quota exhaustion. */ }
  }
  if (!found || reset === undefined) return;
  return { reason: "provider-usage-limit", notBefore: new Date(reset).toISOString(),
    failedAttempt: event.scope.attempt, resultEventHash: event.hash };
}
