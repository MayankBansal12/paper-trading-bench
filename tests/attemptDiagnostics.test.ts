import { expect, test } from "bun:test";
import { attemptDiagnostics } from "../src/report/attemptDiagnostics.ts";

const toolError = { type: "tool_result", result: { isError: true } };
const response = (status: number, sequence = 1) => ({ type: "inference_response", status, sequence });

test("recoverable tool and provider errors do not relabel successful submissions as failures", () => {
  expect(attemptDiagnostics("completed", null, [toolError, toolError, response(429), response(200, 2)]))
    .toEqual({ failureCategory: null, toolValidationErrors: 2, providerHttpErrors: [{ request: 1, status: 429 }], gatewayDenials: 0 });
});

test("deadline, host interruption, runtime limits, provider failures and missing submission remain distinct", () => {
  expect(attemptDiagnostics("budget_cutoff", "Hard session timeout", [response(200), toolError]).failureCategory).toBe("timeout");
  expect(attemptDiagnostics("budget_cutoff", "Output cap exceeded", []).failureCategory).toBe("runtime-limit");
  expect(attemptDiagnostics("interrupted", "Interrupted before complete integrity audit", []).failureCategory).toBe("interrupted");
  expect(attemptDiagnostics("harness_error", "Client did not submit a complete decision", [response(429)]).failureCategory).toBe("provider-http-error");
  expect(attemptDiagnostics("harness_error", "Client did not submit a complete decision", [response(429), response(200, 2)]).failureCategory).toBe("no-submission");
  expect(attemptDiagnostics("harness_error", "Prompt drift", [{ type: "gateway_denied" }])).toMatchObject({ failureCategory: "harness-error", gatewayDenials: 1 });
  expect(attemptDiagnostics("unfinished", null, [response(429)]).failureCategory).toBeNull();
  expect(attemptDiagnostics("other", "unknown", []).failureCategory).toBe("unclassified");
});
