import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderCredential } from "../opencode/credentials.ts";

export interface ClaudeToken { token: string; expiresAt: number }
async function readToken(): Promise<ClaudeToken> {
  try {
    const path = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), ".credentials.json");
    const oauth = JSON.parse(await readFile(path, "utf8"))?.claudeAiOauth;
    if (typeof oauth?.accessToken !== "string" || !oauth.accessToken || !oauth.scopes?.includes("user:inference"))
      throw new Error("missing subscription login");
    return { token: oauth.accessToken, expiresAt: Number(oauth.expiresAt) };
  } catch {
    throw new Error("BENCH_AUTH_PAUSE: log in with Claude Code on the host");
  }
}
/** Host-only credentials. Authentication never starts an auxiliary model call. */
export function claudeCredential(now = Date.now, read = readToken): ProviderCredential {
  return {
    mode: "oauth",
    async authorize(signal) {
      signal.throwIfAborted();
      const cred = await read();
      if (!Number.isFinite(cred.expiresAt) || cred.expiresAt - now() <= 5 * 60_000)
        throw new Error("BENCH_AUTH_PAUSE: refresh the host Claude Code login before continuing");
      signal.throwIfAborted();
      return new Headers({ authorization: `Bearer ${cred.token}`, "anthropic-beta": "oauth-2025-04-20" });
    },
  };
}
