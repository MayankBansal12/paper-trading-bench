// Offline hermeticity test for agent/piSession.ts. Never calls
// session.prompt() (no network, no tokens) — only constructs a session and
// inspects its tool registry, which is exactly what proves the boundary:
// even a malicious/ambient extension factory that tries to register a
// web-search/shell-like tool alongside the trading tools must never make it
// into the active tool set, or even the registry, because
// createHermeticAgentSession passes an explicit `tools` allowlist to
// createAgentSession — see agent/piSession.ts.

import { describe, expect, test } from "bun:test";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createHermeticAgentSession } from "../src/agent/piSession.ts";
import { TRADING_TOOL_NAMES } from "../src/agent/tools.ts";

const STUB_PARAMS = { type: "object" as const, properties: {} };

function stubTool(name: string) {
  return {
    name,
    label: name,
    description: "stub",
    parameters: STUB_PARAMS,
    execute: async () => ({ content: [{ type: "text" as const, text: "SHOULD NEVER RUN" }] }),
  };
}

const tradingFactory: ExtensionFactory = (pi) => {
  for (const name of TRADING_TOOL_NAMES) pi.registerTool(stubTool(name));
};

/** Simulates a host-installed ambient/malicious extension trying to smuggle
 * web-search and shell-like tools into the session. */
const maliciousFactory: ExtensionFactory = (pi) => {
  pi.registerTool(stubTool("web_search"));
  pi.registerTool(stubTool("shell"));
  pi.registerTool(stubTool("bash"));
};

describe("agent/piSession hermetic boundary", () => {
  test("an injected/ambient extra tool is neither registered nor active, only the 6 trading tools are", async () => {
    // getModel() is a synchronous local catalog lookup — no network call.
    const model = getModel("opencode-go", "minimax-m3" as Parameters<typeof getModel>[1]);
    expect(model).toBeTruthy();

    const { session } = await createHermeticAgentSession({
      model: model!,
      thinkingLevel: "low",
      extensionFactories: [tradingFactory, maliciousFactory],
    });
    try {
      const active = session.getActiveToolNames();
      expect(new Set(active)).toEqual(new Set(TRADING_TOOL_NAMES));
      for (const forbidden of ["web_search", "shell", "bash", "read", "edit", "write"]) {
        expect(active).not.toContain(forbidden);
      }

      // Not just inactive — never even registered, regardless of what any
      // extension (ambient or inline) tried to add.
      const registeredNames = session.getAllTools().map((t) => t.name);
      expect(new Set(registeredNames)).toEqual(new Set(TRADING_TOOL_NAMES));
      expect(registeredNames).not.toContain("web_search");
    } finally {
      session.dispose();
    }
  });

  test("with no trading factory at all, a malicious factory's tools still never become active (allowlist doesn't fall back to whatever got registered)", async () => {
    const model = getModel("opencode-go", "minimax-m3" as Parameters<typeof getModel>[1]);
    const { session } = await createHermeticAgentSession({
      model: model!,
      thinkingLevel: "low",
      extensionFactories: [maliciousFactory],
    });
    try {
      expect(session.getActiveToolNames()).toEqual([]);
      expect(session.getAllTools()).toEqual([]);
    } finally {
      session.dispose();
    }
  });
});
