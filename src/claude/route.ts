export const CLAUDE_MODEL_ID = "claude-code/anthropic/claude-sonnet-5";
export const CLAUDE_MODEL = "claude-sonnet-5";
export const CLAUDE_PROVIDER = "anthropic";
export const CLAUDE_VERSION = "2.1.274";
export const CLAUDE_EFFORT = "medium";
export const CLAUDE_MCP_PREFIX = "mcp__trading__";
export const CLAUDE_ROUTE = Object.freeze({
  id: CLAUDE_MODEL_ID,
  provider: CLAUDE_PROVIDER,
  model: CLAUDE_MODEL,
  apiURL: "https://api.anthropic.com",
  auth: "oauth",
  cost: null,
});
export const CLAUDE_OPUS_MODEL_ID = "claude-code/anthropic/claude-opus-5";
export const CLAUDE_OPUS_MODEL = "claude-opus-5";
// Opus5.5 is refused by the provider for clients older than 2.1.280 (live qualification 2026-09-22);
// it responds with the exact requested id, so no dated alias is admitted.
export const CLAUDE_OPUS55_MODEL_ID = "claude-code/anthropic/claude-opus-5-5";
export const CLAUDE_OPUS55_MODEL = "claude-opus-5-5";
export const CLAUDE_OPUS55_VERSION = "2.1.280";
export const CLAUDE_FABLE51_MODEL_ID = "claude-code/anthropic/claude-fable-5-1";
export const CLAUDE_FABLE51_MODEL = "claude-fable-5-1";
export const CLAUDE_FABLE51_VERSION = "2.1.296";
const PREFIX = "claude-code/anthropic/";
const CLIENT_VERSIONS: Readonly<Record<string, string>> = Object.freeze({
  [CLAUDE_MODEL_ID]: CLAUDE_VERSION,
  [CLAUDE_OPUS_MODEL_ID]: CLAUDE_VERSION,
  [CLAUDE_OPUS55_MODEL_ID]: CLAUDE_OPUS55_VERSION,
  [CLAUDE_FABLE51_MODEL_ID]: CLAUDE_FABLE51_VERSION,
});
export function isClaudeModel(model?: string): boolean {
  return model !== undefined && Object.hasOwn(CLIENT_VERSIONS, model);
}
/** Pinned native Claude Code version for an exact route id or its bare provider model. */
export function claudeClientVersion(model = CLAUDE_MODEL_ID): string {
  const version = CLIENT_VERSIONS[model.startsWith(PREFIX) ? model : PREFIX + model];
  if (!version) throw new Error("Unqualified Claude Code model: " + model);
  return version;
}
export function claudeRoute(model = CLAUDE_MODEL_ID) {
  if (!isClaudeModel(model)) throw new Error("Unqualified Claude Code model: " + model);
  return Object.freeze({ ...CLAUDE_ROUTE, id: model, model: model.slice(PREFIX.length) });
}
