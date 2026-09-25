import { expect, test } from "bun:test";
import { claudeCredential } from "../src/claude/credential.ts";

test("Claude host login guard returns scoped headers and refuses expiry without inference", async () => {
  const signal = new AbortController().signal;
  const valid = claudeCredential(() => 1000, async () => ({ token: "fixture", expiresAt: 601000 }));
  expect((await valid.authorize(signal)).get("authorization")).toBe("Bearer fixture");
  for (const expiresAt of [0, NaN, 1000, 301000]) {
    const expired = claudeCredential(() => 1000, async () => ({ token: "fixture", expiresAt }));
    await expect(expired.authorize(signal)).rejects.toThrow("BENCH_AUTH_PAUSE");
  }
  const controller = new AbortController(); controller.abort();
  await expect(valid.authorize(controller.signal)).rejects.toThrow();
});
