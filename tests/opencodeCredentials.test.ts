import { test, expect } from "bun:test";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadProviderCredential } from "../src/opencode/credentials.ts";
import { QUALIFIED_ROUTES } from "../src/opencode/qualification.ts";

const zen = QUALIFIED_ROUTES[0]!, luna = QUALIFIED_ROUTES[2]!;
const go = QUALIFIED_ROUTES.find(r => r.provider === "opencode-go")!;
const token = (claims: unknown) => `test.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
const signal = () => new AbortController().signal;
async function fixture(auth: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "bench-auth-test-"));
  const authPath = join(dir, "auth.json");
  await writeFile(authPath, JSON.stringify(auth), { mode: 0o600 });
  return { dir, authPath, env: {}, legacyAuthPath: join(dir, "missing"),
    dispose: () => rm(dir, { recursive: true, force: true }) };
}

test("Zen uses host env, official auth, then plain legacy API keys without serializing credentials", async () => {
  const f = await fixture({ opencode: { type: "api", key: "test-store-key" } });
  try {
    const env = await loadProviderCredential(zen, { ...f, env: { OPENCODE_API_KEY: "test-env-key" } });
    expect((await env.authorize(signal())).get("authorization")).toBe("Bearer test-env-key");
    const store = await loadProviderCredential(zen, f);
    expect((await store.authorize(signal())).get("authorization")).toBe("Bearer test-store-key");
    expect(JSON.stringify(store)).toBe('{"mode":"api"}');
    await writeFile(f.authPath, "{}");
    await writeFile(f.legacyAuthPath, JSON.stringify({ opencode: { type: "api_key", key: "test-legacy-key" } }));
    expect((await (await loadProviderCredential(zen, f)).authorize(signal())).get("authorization")).toBe("Bearer test-legacy-key");
    await writeFile(f.legacyAuthPath, JSON.stringify({ opencode: { type: "api_key", key: "!do-not-evaluate" } }));
    await expect(loadProviderCredential(zen, f)).rejects.toThrow("unavailable");
  } finally { await f.dispose(); }
});

test("Luna keeps OAuth host-side, does no refresh on load, and cannot fall back to a paid API key", async () => {
  const access = token({ "https://api.openai.com/auth": { chatgpt_compute_residency: "us" } });
  const f = await fixture({ openai: { type: "oauth", access, refresh: "test-refresh", expires: Date.now() + 600000, accountId: "test-account" } });
  let calls = 0;
  const forward = (async () => { calls++; throw Error("No refresh expected"); }) as typeof fetch;
  try {
    const c = await loadProviderCredential(luna, { ...f, forward });
    const before = await readFile(f.authPath, "utf8");
    expect(calls).toBe(0);
    const headers = await c.authorize(signal());
    expect(headers.get("authorization")).toBe(`Bearer ${access}`);
    expect(headers.get("chatgpt-account-id")).toBe("test-account");
    expect(headers.get("x-openai-internal-codex-residency")).toBe("us");
    expect(await readFile(f.authPath, "utf8")).toBe(before);
    expect(JSON.stringify(c)).toBe('{"mode":"oauth"}');
    expect(calls).toBe(0);
    await writeFile(f.authPath, JSON.stringify({ openai: { type: "api", key: "test-paid-key" } }));
    await expect(loadProviderCredential(luna, { ...f, env: { OPENAI_API_KEY: "test-paid-key" }, forward })).rejects.toThrow("No API-key fallback");
  } finally { await f.dispose(); }
});

test("Go uses its dedicated host credential and never substitutes the Zen credential", async () => {
  const f = await fixture({ "opencode-go": { type: "api", key: "test-go-store" }, opencode: { type: "api", key: "test-zen-store" } });
  try {
    const env = await loadProviderCredential(go, { ...f, env: { OPENCODE_GO_API_KEY: "test-go-env", OPENCODE_API_KEY: "test-zen-env" } });
    expect((await env.authorize(signal())).get("authorization")).toBe("Bearer test-go-env");
    const store = await loadProviderCredential(go, f);
    expect((await store.authorize(signal())).get("authorization")).toBe("Bearer test-go-store");
    expect(JSON.stringify(store)).toBe('{"mode":"api"}');
    await writeFile(f.authPath, JSON.stringify({ opencode: { type: "api", key: "test-zen-store" } }));
    await expect(loadProviderCredential(go, { ...f, env: { OPENCODE_API_KEY: "test-zen-env" } })).rejects.toThrow("OpenCode Go credential unavailable");
  } finally { await f.dispose(); }
});

test("four OAuth runtimes serialize refresh, atomically preserve other providers, and reuse rotated credentials", async () => {
  const f = await fixture({ opencode: { type: "api", key: "test-zen-key" }, openai: {
    type: "oauth", access: "test-expired", refresh: "test-old-refresh", expires: 0,
  } });
  let calls = 0;
  const access = token({ "https://api.openai.com/auth": { chatgpt_account_id: "test-new-account" } });
  const forward = (async (url: any, init: any) => {
    calls++;
    expect(url).toBe("https://auth.openai.com/oauth/token");
    expect(init.redirect).toBe("error");
    expect(new URLSearchParams(init.body).get("refresh_token")).toBe("test-old-refresh");
    await new Promise(resolve => setTimeout(resolve, 30));
    return Response.json({ access_token: access, refresh_token: "test-rotated-refresh", expires_in: 3600 });
  }) as typeof fetch;
  try {
    const runtimes = await Promise.all(Array.from({ length: 4 }, () => loadProviderCredential(luna, { ...f, forward })));
    expect(calls).toBe(0);
    const headers = await Promise.all(runtimes.map(c => c.authorize(signal())));
    expect(calls).toBe(1);
    expect(headers.every(h => h.get("authorization") === `Bearer ${access}`)).toBe(true);
    expect(headers.every(h => h.get("chatgpt-account-id") === "test-new-account")).toBe(true);
    const saved = JSON.parse(await readFile(f.authPath, "utf8"));
    expect(saved.opencode.key).toBe("test-zen-key");
    expect(saved.openai.refresh).toBe("test-rotated-refresh");
    expect((await stat(f.authPath)).mode & 0o777).toBe(0o600);
    await runtimes[0]!.authorize(signal());
    expect(calls).toBe(1);
  } finally { await f.dispose(); }
});

test("failed OAuth refresh leaves the auth store intact and hides response and exception values", async () => {
  const f = await fixture({ openai: { type: "oauth", access: "test-expired", refresh: "test-secret-refresh", expires: 0 } });
  try {
    const before = await readFile(f.authPath, "utf8");
    for (const forward of [
      async () => new Response("test-secret-refresh", { status: 401 }),
      async () => { throw Error("test-secret-refresh"); },
      async () => new Response("invalid JSON containing test-secret-refresh"),
      async () => Response.json({ access_token: "test-secret-refresh", expires_in: -1 }),
    ]) {
      const c = await loadProviderCredential(luna, { ...f, forward: forward as typeof fetch });
      await expect(c.authorize(signal())).rejects.toThrow("Host OpenAI OAuth refresh failed; reauthenticate with opencode auth login on the host");
      expect(await readFile(f.authPath, "utf8")).toBe(before);
    }
  } finally { await f.dispose(); }
});
