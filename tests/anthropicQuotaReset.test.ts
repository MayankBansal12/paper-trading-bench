import { test, expect } from "bun:test";
import { quotaPause } from "../src/study/availability.ts";
const recordedAt = "2026-09-20T13:06:35.152Z";
const fiveHour = "1789920600", sevenDay = "1790215200";
function pause(headers: Record<string,string>, error: any = { type: "rate_limit_error" }) {
  const trace = [
    { type: "inference_response", sequence: 1, status: 429, headers },
    { type: "inference_chunk", sequence: 1, base64: Buffer.from(JSON.stringify({ error })).toString("base64") },
  ];
  return quotaPause({ trace: () => trace } as any, { kind: "result", payload: { outcome: "harness_error" }, scope: { attempt: 1 }, recordedAt, hash: "retained-result" } as any);
}
const headers = {
  "anthropic-ratelimit-unified-5h-status": "rejected",
  "anthropic-ratelimit-unified-5h-reset": fiveHour,
  "anthropic-ratelimit-unified-7d-status": "allowed",
  "anthropic-ratelimit-unified-7d-reset": sevenDay,
  "anthropic-ratelimit-unified-status": "rejected",
  "anthropic-ratelimit-unified-reset": fiveHour,
  "retry-after": "11005",
};
test("real Opus response uses exhausted 5h reset instead of available weekly reset", () => {
  expect(pause(headers)).toMatchObject({ notBefore: "2026-09-20T16:15:00.000Z", failedAttempt: 1, resultEventHash: "retained-result" });
});
test("both exhausted buckets require the later rejected reset", () => {
  expect(pause({ ...headers, "anthropic-ratelimit-unified-7d-status": "rejected" })?.notBefore).toBe("2026-09-24T02:05:00.000Z");
});
test("available five-hour bucket cannot extend an exhausted weekly reset", () => {
  expect(pause({ ...headers, "anthropic-ratelimit-unified-5h-status": "allowed", "anthropic-ratelimit-unified-5h-reset": "1791000000", "anthropic-ratelimit-unified-7d-status": "rejected", "anthropic-ratelimit-unified-reset": sevenDay })?.notBefore).toBe("2026-09-24T02:05:00.000Z");
});
test("unified reset works when older provider responses omit bucket statuses", () => {
  expect(pause({ "anthropic-ratelimit-unified-reset": fiveHour, "anthropic-ratelimit-unified-7d-reset": sevenDay })?.notBefore).toBe("2026-09-20T16:15:00.000Z");
});
test("available buckets alone defer to Retry-After, never their future reset", () => {
  expect(pause({ "anthropic-ratelimit-unified-7d-status": "allowed", "anthropic-ratelimit-unified-7d-reset": sevenDay, "retry-after": "60" })?.notBefore).toBe("2026-09-20T13:12:35.152Z");
});
test("malformed or stale reset cannot override a valid Retry-After", () => {
  for (const value of ["invalid", "1789000000"]) expect(pause({ "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": value, "retry-after": "60" })?.notBefore).toBe("2026-09-20T13:12:35.152Z");
});
test("missing usable reset retains the documented cooldown", () => {
  expect(pause({})?.notBefore).toBe("2026-09-20T19:11:35.152Z");
});
test("Codex quota reset behavior remains unchanged and overload is not account quota", () => {
  expect(pause({}, { type: "usage_limit_reached", resets_at: Number(fiveHour) })?.notBefore).toBe("2026-09-20T16:15:00.000Z");
  expect(pause(headers, { type: "overloaded_error" })).toBeUndefined();
});
