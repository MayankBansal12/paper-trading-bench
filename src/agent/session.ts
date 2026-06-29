// Session creation. Wires the pi SDK with our tool extension, in-memory
// session manager, model registry pointing at opencode-go, and the system
// prompt. Returns the AgentSession handle.
//
// We use the "opencode-go" built-in provider (catalog ships in pi-ai) and
// look up the requested model by id. Falls back to kimi-k2.6 if the id
// isn't recognized.

import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import { PROJECT_ROOT } from "../utils/paths.ts";
import { buildSystemPrompt } from "../prompts/system.ts";
import { createTradingToolsExtension, type TradingContext } from "../tools/registry.ts";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

export const DEFAULT_MODEL = "kimi-k2.6";

export async function createTradingSession(
  modelId: string,
  ctx: TradingContext,
): Promise<AgentSession> {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  // Look up the model in the opencode-go catalog. If pi's catalog has a
  // newer version of the same id (e.g. kimi-k2.7) we'll use whatever exists.
  // The Model type is parameterized by API (openai-completions, openai-responses, etc.)
  // and the overloads make the union messy; cast through `unknown` for the fallback chain.
  let model: unknown = getModel("opencode-go", modelId as Parameters<typeof getModel>[1]);
  if (!model) {
    model = getModel("opencode-go", DEFAULT_MODEL);
  }
  if (!model) {
    model = modelRegistry.getAvailable().find((m) => m.provider === "opencode-go");
  }
  if (!model) {
    throw new Error(
      `No opencode-go model found (requested: ${modelId}). Run \`pi --list-models\` to see what's available.`,
    );
  }

  // Build a resource loader that registers our tool extension.
  // We use in-memory settings to disable compaction (we want full history in
  // a single session) and tweak retries for the opencode-go provider.
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 2 },
  });

  const resourceLoader = new DefaultResourceLoader({
    cwd: PROJECT_ROOT,
    agentDir: getAgentDir(),
    settingsManager,
    extensionFactories: [createTradingToolsExtension(ctx)],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: PROJECT_ROOT,
    model: model as Parameters<typeof createAgentSession>[0] extends { model?: infer M } ? M : never,
    thinkingLevel: "medium",
    authStorage,
    modelRegistry,
    resourceLoader,
    sessionManager: SessionManager.inMemory(PROJECT_ROOT),
    settingsManager,
    // No built-in tools — we ONLY want our 7 trading tools available to the model.
    noTools: "builtin",
  });

  return session;
}

export { buildSystemPrompt };
