import { test, expect } from "bun:test";
import { piUsage, providerResponses } from "../src/pi/audit.ts";
import { studyRoute } from "../src/study/routes.ts";
import { PI_MODEL_ID } from "../src/pi/route.ts";
import { EVALUATION_MODELS } from "../src/study/evaluation.ts";
import { validateUsage } from "../src/core/types.ts";

test("Pi Astra is opt-in and subscription cost is never advertised as zero", () => {
  expect(studyRoute(PI_MODEL_ID).cost).toBeNull();
  expect(EVALUATION_MODELS).not.toContain(PI_MODEL_ID);
  expect(() => studyRoute("pi/openai-codex/astra")).toThrow("Unqualified");
  const trace = [
    { type: "inference_request" },
    {
      type: "pi_event",
      event: {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "toolUse",
          usage: {
            input: 10,
            output: 5,
            cacheRead: 20,
            cacheWrite: 0,
            totalTokens: 35,
          },
        },
      },
    },
  ];
  const usage = piUsage(trace);
  expect(usage.costUsd).toBeNull();
  expect(usage.promptTokens).toBe(30);
  expect(usage.totalTokens).toBe(35);
  expect(usage.completeness).toBe("unavailable");
  expect(() => validateUsage(usage)).not.toThrow();
});
test("Pi interrupted requests retain observed inference count without inventing tokens", () => {
  const usage = piUsage([{ type: "inference_request" }]);
  expect(usage.turns).toBe(1);
  expect(usage.totalTokens).toBeNull();
  expect(usage.missingSteps).toBe(1);
  expect(() => validateUsage(usage)).not.toThrow();
});
test("Pi replay requires one terminal completed response and handles split UTF-8 chunks", () => {
  const bytes = Buffer.from(
    'data: {"type":"response.completed","response":{"status":"completed","text":"é"}}\n\n',
  );
  const split = bytes.indexOf(Buffer.from("é")) + 1;
  const events = [
    { type: "inference_request", sequence: 1 },
    ...[bytes.subarray(0, split), bytes.subarray(split)].map((b) => ({
      type: "inference_chunk",
      sequence: 1,
      base64: b.toString("base64"),
    })),
  ];
  expect(providerResponses(events)[0].text).toBe("é");
  expect(() => providerResponses(events.slice(0, 2))).toThrow();
  expect(() => providerResponses([...events, ...events.slice(1)])).toThrow();
});
