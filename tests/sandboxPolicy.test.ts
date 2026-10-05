import { expect, test } from "bun:test";
import { sandboxPolicy, SANDBOX_POLICY } from "../src/study/sandbox.ts";

test("sandbox launchers have distinct recorded policies and reject unknown settings", () => {
  expect(sandboxPolicy("user")).toBe(SANDBOX_POLICY);
  expect(sandboxPolicy("system")).toBe("bwrap-systemd-unix-gateway-v1");
  expect(sandboxPolicy("system")).not.toBe(sandboxPolicy("user"));
  expect(() => sandboxPolicy("auto")).toThrow("must be user or system");
  expect(() => sandboxPolicy("")).toThrow("must be user or system");
});
