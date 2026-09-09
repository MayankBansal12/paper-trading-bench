// Hermetic Pi SDK session construction shared by the real agent
// (agent/piAgent.ts) and its offline boundary test
// (tests/piSessionBoundary.test.ts). Resource discovery is fully disabled —
// no ambient project/user extensions, skills, prompt templates, or context
// files — and the active tool set is restricted to an explicit allowlist, so
// a host machine with an installed web/shell/custom extension can never
// smuggle an extra tool into a benchmark session regardless of what's on
// disk outside this repo.

import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  getAgentDir,
  type CreateAgentSessionResult,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { PROJECT_ROOT } from "../utils/paths.ts";
import { TRADING_TOOL_NAMES } from "./tools.ts";

type CreateOptions = Parameters<typeof createAgentSession>[0] & object;

export interface HermeticSessionOptions {
  model: CreateOptions["model"];
  thinkingLevel: CreateOptions["thinkingLevel"];
  /** Inline extension factories to load — in production this is exactly the
   * one factory that registers the 6 trading tools (see agent/piAgent.ts).
   * Exposed as a parameter (rather than hardcoded) only so the boundary test
   * can additionally inject a simulated ambient/malicious extension and
   * prove it never becomes active. */
  extensionFactories: ExtensionFactory[];
}

export async function createHermeticAgentSession(opts: HermeticSessionOptions): Promise<CreateAgentSessionResult> {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 2 } });

  const resourceLoader = new DefaultResourceLoader({
    cwd: PROJECT_ROOT,
    agentDir: getAgentDir(),
    settingsManager,
    // No ambient discovery of ANY kind — only the inline factories we pass
    // explicitly are ever loaded (see resource-loader.ts: noExtensions only
    // suppresses disk-discovered project/user extensions; inline
    // `extensionFactories` still load, which is exactly the boundary we want).
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: opts.extensionFactories,
  });
  await resourceLoader.reload();

  return createAgentSession({
    cwd: PROJECT_ROOT,
    model: opts.model,
    thinkingLevel: opts.thinkingLevel,
    authStorage,
    modelRegistry,
    resourceLoader,
    sessionManager: SessionManager.inMemory(PROJECT_ROOT),
    settingsManager,
    // Explicit allowlist: only these names can ever be registered/active,
    // regardless of what any extension (ambient or inline) tries to add.
    tools: [...TRADING_TOOL_NAMES],
  });
}
