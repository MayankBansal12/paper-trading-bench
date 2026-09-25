import { readFile, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { QualifiedRoute } from "./qualification.ts";

export interface ProviderCredential {
  readonly mode: "api" | "oauth";
  authorize(signal: AbortSignal): Promise<Headers>;
}

// Mirrors official OpenCode 1.18.30 plugin/openai/codex.ts. Only the host
// gateway calls this module; credentials never enter client config or audits.
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
function claims(token: string) {
  try {
    const value = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }
  catch { return {}; }
}
function accountId(token: string): string | undefined {
  const c = claims(token);
  return c.chatgpt_account_id ?? c["https://api.openai.com/auth"]?.chatgpt_account_id ?? c.organizations?.[0]?.id;
}
async function readAuth(path: string) {
  try {
    const auth = JSON.parse(await readFile(path, "utf8"));
    if (auth && typeof auth === "object" && !Array.isArray(auth)) return auth;
  } catch {}
  throw new Error("Host OpenCode auth store unavailable or invalid");
}
function oauth(auth: any) {
  const a = auth.openai;
  if (a?.type !== "oauth" || !text(a.refresh) || !text(a.access) || !Number.isFinite(a.expires))
    throw new Error("Luna requires host OpenCode OpenAI OAuth; run opencode auth login on the host. No API-key fallback.");
  return a;
}
export async function loadProviderCredential(route: Pick<QualifiedRoute, "provider">, options: {
  env?: Record<string, string | undefined>;
  authPath?: string;
  legacyAuthPath?: string;
  forward?: typeof fetch;
} = {}): Promise<ProviderCredential> {
  const env = options.env ?? process.env;
  const authPath = options.authPath ?? join(env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "opencode/auth.json");
  const forward = options.forward ?? fetch;
  if (route.provider === "opencode") {
    let key = env.OPENCODE_API_KEY;
    if (!key) {
      try { const a = (await readAuth(authPath)).opencode; if (a?.type === "api" && text(a.key)) key = a.key; } catch {}
    }
    if (!key) {
      try {
        const a = (await readAuth(options.legacyAuthPath ?? join(env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent"), "auth.json"))).opencode;
        if (a?.type === "api_key" && text(a.key) && !a.key.startsWith("!")) key = a.key;
      } catch {}
    }
    if (!key) throw new Error("OpenCode credential unavailable");
    const bearer = key;
    return { mode: "api", authorize: async () => new Headers({ authorization: `Bearer ${bearer}` }) };
  }
  if (route.provider === "opencode-go") {
    let key = env.OPENCODE_GO_API_KEY;
    if (!key) {
      try { const a = (await readAuth(authPath))["opencode-go"]; if (a?.type === "api" && text(a.key)) key = a.key; } catch {}
    }
    if (!key) throw new Error("OpenCode Go credential unavailable");
    const bearer = key;
    return { mode: "api", authorize: async () => new Headers({ authorization: `Bearer ${bearer}` }) };
  }
  oauth(await readAuth(authPath)); // Fail before preparing any sandbox.
  return {
    mode: "oauth",
    async authorize(signal) {
      let current = oauth(await readAuth(authPath));
      if (current.expires <= Date.now() + 30_000) {
        // Serialize refreshes across all quarters and benchmark processes. This
        // separate lock never contains tokens. A stale lock fails closed.
        const lockPath = authPath + ".bench-refresh.lock";
        const lockDeadline = Date.now() + 35_000;
        for (;;) {
          signal.throwIfAborted();
          try { const lock = await open(lockPath, "wx", 0o600); await lock.close(); break; }
          catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= lockDeadline)
              throw new Error("Host OAuth refresh lock unavailable; check for an active refresh or stale .bench-refresh.lock");
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        }
        const temporary = authPath + ".bench-" + randomUUID();
        try {
          current = oauth(await readAuth(authPath));
          if (current.expires <= Date.now() + 30_000) {
            const response = await forward(TOKEN_URL, {
              method: "POST", redirect: "error",
              signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: current.refresh, client_id: CLIENT_ID }).toString(),
            });
            if (!response.ok) throw new Error("refresh failed");
            const tokens = await response.json() as any;
            if (!text(tokens.access_token) || !text(tokens.refresh_token) ||
                (tokens.expires_in !== undefined && (!Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0)))
              throw new Error("invalid refresh response");
            const latest = await readAuth(authPath);
            if (JSON.stringify(oauth(latest)) !== JSON.stringify(current))
              throw new Error("auth changed during refresh");
            current = { ...current, access: tokens.access_token, refresh: tokens.refresh_token,
              expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
              accountId: accountId(tokens.id_token ?? "") ?? accountId(tokens.access_token) ?? current.accountId };
            const file = await open(temporary, "wx", 0o600);
            try { await file.writeFile(JSON.stringify({ ...latest, openai: current })); await file.sync(); }
            finally { await file.close(); }
            await rename(temporary, authPath);
          }
        } catch {
          // Neither HTTP bodies nor parser/transport exceptions may expose tokens.
          throw new Error("Host OpenAI OAuth refresh failed; reauthenticate with opencode auth login on the host");
        } finally {
          await rm(temporary, { force: true });
          await rm(lockPath, { force: true });
        }
      }
      const headers = new Headers({ authorization: `Bearer ${current.access}`, originator: "opencode" });
      if (text(current.accountId)) headers.set("ChatGPT-Account-Id", current.accountId);
      const c = claims(current.access);
      const residency = c.chatgpt_compute_residency ?? c["https://api.openai.com/auth"]?.chatgpt_compute_residency;
      if (text(residency)) headers.set("x-openai-internal-codex-residency", residency);
      return headers;
    },
  };
}
