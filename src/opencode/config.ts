import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { STUDY_TOOLS as TRADING_TOOL_NAMES } from "../study/protocol.ts";
import {
  QUALIFIED_OPENCODE_CLIENT_VERSION,
  qualifiedRoute,
  assertZeroCostCatalogEntry,
  type CatalogModelEvidence,
} from "./qualification.ts";

/** Select the official OAuth request format without giving the sandbox host tokens.
 * Default auth plugins remain disabled; only the host can refresh credentials. */
export function gatewayClientAuth(model: string, capability: string) {
  return qualifiedRoute(model).auth === "oauth" ? {
    openai: { type: "oauth", access: capability, refresh: "host-gateway-only", expires: Number.MAX_SAFE_INTEGER },
  } : undefined;
}

export const OPENCODE_PROMPT_SUFFIX =
  "\nTrading tool names use the trading_ prefix (for example trading_market_snapshot and trading_submit_day).";

/** Official OpenCode 1.18.30: custom agent.prompt still receives host-date
 * environment text. The supported system transform runs after construction.
 * --pure disables this plugin, so callers MUST omit --pure and use this isolated
 * environment with cwd=dir. No authentication values belong in this config.
 */
export async function makeClientConfig(
  dir: string,
  model: string,
  systemPrompt: string,
  mcpUrl: string,
  clientVersion?: string,
  options: {
    toolNames?: readonly string[];
    runtimeDir?: string;
    baseURL?: string;
    catalogEntry?: CatalogModelEvidence;
  } = {},
): Promise<{
  config: unknown;
  env: Record<string, string>;
  effectiveSystemPrompt: string;
}> {
  const route = qualifiedRoute(model);
  if (options.catalogEntry) assertZeroCostCatalogEntry(options.catalogEntry, model);
  if (clientVersion !== QUALIFIED_OPENCODE_CLIENT_VERSION) {
    throw new Error(
      "Official-client config requires qualified OpenCode " +
        QUALIFIED_OPENCODE_CLIENT_VERSION,
    );
  }
  const root = resolve(options.runtimeDir ?? dir);
  const allowed = (options.toolNames ?? TRADING_TOOL_NAMES).map(
    (name) => `trading_${name}`,
  );
  const permission = {
    "*": "deny",
    ...Object.fromEntries(allowed.map((name) => [name, "allow"])),
  };
  const effectiveSystemPrompt = systemPrompt + OPENCODE_PROMPT_SUFFIX;
  for (const name of [
    "home",
    "config",
    "data",
    "cache",
    "state",
    "extra-config",
  ]) {
    await mkdir(join(dir, name), { recursive: true });
  }
  const pluginPath = join(root, "benchmark-plugin.mjs");
  const source = `import { writeFile, appendFile, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
const expected = ${JSON.stringify(model)};
const provider = ${JSON.stringify(route.provider)};
// Use the freshly qualified metadata inside the isolated home. OAuth pricing and
// limits are supplied by the official host catalog; no credential is copied.
const catalogEntry = ${JSON.stringify(options.catalogEntry ?? null)};
const clientVersion = ${JSON.stringify(clientVersion ?? null)};
const runtime = { cliVersion: clientVersion, versionSource: clientVersion ? "caller preflight opencode --version" : "not provided",
  executable: process.execPath, versions: process.versions };
async function writeJson(path, data) {
  await writeFile(path + ".tmp", JSON.stringify(data, null, 2));
  await rename(path + ".tmp", path);
}
const exact = ${JSON.stringify(effectiveSystemPrompt)};
const allowed = ${JSON.stringify(allowed)};
const audit = ${JSON.stringify(join(root, "system-prompt.json"))};
const requests = ${JSON.stringify(join(root, "system-prompts.jsonl"))};
export default async function benchmarkPlugin(pluginInput = {}) {
  const workspace = { directory: pluginInput.directory, worktree: pluginInput.worktree, processCwd: process.cwd() };
  if (pluginInput.directory !== ${JSON.stringify(root)}) throw new Error("Benchmark client directory escaped isolation");
  return {
    ...(catalogEntry ? { provider: { id: provider, models: async () => ({ [catalogEntry.id]: catalogEntry }) } } : {}),
    "chat.headers": async (input, output) => {
      if (provider === "openai") output.headers["session-id"] = input.sessionID;
    },
    "chat.params": async (input, output) => {
      // Match the official Codex OAuth plugin's transport setting. Reasoning
      // options are left at the official client's defaults for every route.
      if (provider === "openai") output.maxOutputTokens = undefined;
    },
    event: async ({ event }) => {
      const part = event.properties?.part;
      if (event.type === "message.part.updated" && part?.type === "tool") {
        await appendFile(${JSON.stringify(join(root, "tool-parts.jsonl"))}, JSON.stringify(part) + "\\n");
      }
    },
    config: async (config) => {
      if (config.model !== expected || config.small_model !== expected) throw new Error("Benchmark model configuration drift");
      await writeJson(${JSON.stringify(join(root, "client-config-audit.json"))}, { runtime, workspace, model: config.model,
        small_model: config.small_model, enabled_providers: config.enabled_providers, permission: config.permission, agent: config.agent?.bench,
        mcpNames: Object.keys(config.mcp ?? {}), plugins: config.plugin, baseURL: config.provider?.[provider]?.options?.baseURL });
    },
    "experimental.chat.system.transform": async (input, output) => {
      const actualModel = input.model.providerID + "/" + input.model.id;
      if (actualModel !== expected) throw new Error("Benchmark model switched: " + actualModel);
      output.system.splice(0, output.system.length, exact);
      const evidence = { type: "effective_system_prompt", model: actualModel, sessionID: input.sessionID, runtime, workspace,
        resolvedModel: { id: input.model.id, providerID: input.model.providerID, name: input.model.name,
          api: input.model.api, limit: input.model.limit, cost: input.model.cost, capabilities: input.model.capabilities },
        effectiveSystemPrompt: output.system.join("\\n"), system: output.system,
        promptHash: createHash("sha256").update(output.system.join("\\n")).digest("hex"),
        toolAllowlist: allowed, captureBoundary: "official experimental.chat.system.transform after environment construction" };
      await writeJson(audit, evidence);
      await appendFile(requests, JSON.stringify(evidence) + "\\n");
    },
    "tool.definition": async (input, output) => {
      await appendFile(${JSON.stringify(join(root, "tool-definitions.jsonl"))}, JSON.stringify({ toolID: input.toolID,
        permitted: allowed.includes(input.toolID), description: output.description, parameters: output.parameters,
        captureBoundary: "registered definition hook; final permission filtering occurs later" }) + "\\n");
    },
    "tool.execute.before": async (input, output) => {
      await appendFile(${JSON.stringify(join(root, "tool-attempts.jsonl"))}, JSON.stringify({ ...input, args: output.args }) + "\\n");
      if (!allowed.includes(input.tool)) throw new Error("Benchmark refuses non-trading tool: " + input.tool);
      const bound = await fetch("http://127.0.0.1:8765/bind-call", {method:"POST", headers:{authorization:"Bearer " + process.env.BENCH_GATEWAY_TOKEN,"content-type":"application/json"}, body:JSON.stringify({callID:input.callID, tool:input.tool, args:output.args})});
      if (!bound.ok) throw new Error("Provider call binding failed");
    },
  };
}
`;
  await writeFile(join(dir, "benchmark-plugin.mjs"), source);
  const config = {
    $schema: "https://opencode.ai/config.json",
    model,
    small_model: model,
    default_agent: "bench",
    enabled_providers: [route.provider],
    ...(options.baseURL
      ? { provider: { [route.provider]: { options: { baseURL: options.baseURL } } } }
      : {}),
    share: "disabled",
    autoupdate: false,
    instructions: [],
    snapshot: false,
    compaction: { auto: false, prune: false },
    permission,
    plugin: [pathToFileURL(pluginPath).href],
    agent: {
      bench: {
        mode: "primary",
        model,
        prompt: effectiveSystemPrompt,
        permission,
      },
    },
    mcp: {
      trading: { type: "remote", url: mcpUrl, enabled: true, oauth: false },
    },
  };
  const env = {
    PWD: root,
    INIT_CWD: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    // OpenCode's supported home override prevents unconditional ~/.opencode
    // discovery in ConfigPaths.directories; HOME itself is never changed.
    OPENCODE_TEST_HOME: join(root, "home"),
    OPENCODE_CONFIG_DIR: join(root, "extra-config"),
    OPENCODE_CONFIG: "",
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DB: join(root, "state", "benchmark.db"),
    OPENCODE_PURE: "false",
    OPENCODE_PERMISSION: JSON.stringify(permission),
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    OPENCODE_DISABLE_CLAUDE_CODE: "true",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_AUTOCOMPACT: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
    OPENCODE_AUTO_SHARE: "false",
    OPENCODE_EXPERIMENTAL: "false",
    OPENCODE_EXPERIMENTAL_REFERENCES: "false",
    OPENCODE_ENABLE_EXA: "false",
    OPENCODE_EXPERIMENTAL_EXA: "false",
    OPENCODE_ENABLE_PARALLEL: "false",
    OPENCODE_EXPERIMENTAL_PARALLEL: "false",
    OPENCODE_WORKSPACE_ID: "",
    OPENCODE_EXPERIMENTAL_WORKSPACES: "false",
    OPENCODE_MODELS_PATH: "",
    OPENCODE_MODELS_URL: "",
    OPENCODE_PLUGIN_META_FILE: "",
  };
  return { config, env, effectiveSystemPrompt };
}
