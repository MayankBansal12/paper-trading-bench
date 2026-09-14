import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { makeClientConfig, gatewayClientAuth } from "../src/opencode/config.ts";
import { QUALIFIED_ROUTES } from "../src/opencode/qualification.ts";
import { catalogFixture } from "./opencodeFixtures.ts";
import { textHash as hashText } from "../src/core/hash.ts";

for (const route of QUALIFIED_ROUTES) test(`${route.id}: isolated config and per-request audit`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "bench-config-test-"));
  try {
    const setup = await makeClientConfig(
      dir,
      route.id,
      "Historical trading only.",
      "http://127.0.0.1:43210/mcp",
      "1.18.30",
      { baseURL: "http://127.0.0.1:8765/inference", catalogEntry: catalogFixture(route) },
    );
    const config = setup.config as any;
    expect(config.model).toBe(config.small_model);
    expect(config.enabled_providers).toEqual([route.provider]);
    expect(Object.keys(config.provider)).toEqual([route.provider]);
    expect(config.provider[route.provider].options.baseURL).toBe("http://127.0.0.1:8765/inference");
    expect(JSON.stringify(config)).not.toMatch(/reasoningEffort|reasoning_effort|variant/);
    expect(setup.env[route.authEnv]).toBeUndefined();
    expect(config.permission["*"]).toBe("deny");
    expect(Object.keys(config.permission)).toHaveLength(5);
    expect(setup.env.OPENCODE_TEST_HOME).toBe(join(dir, "home"));
    expect(setup.env.OPENCODE_PURE).toBe("false");
    expect(setup.env.HOME).toBeUndefined();
    const plugin = await import(
      pathToFileURL(join(dir, "benchmark-plugin.mjs")).href
    );
    const hooks = await plugin.default({ directory: dir, worktree: dir });
    const params = { maxOutputTokens: 16384, options: { defaultOption: true } };
    await hooks["chat.params"]({ model: { providerID: route.provider } }, params);
    expect(params.maxOutputTokens).toBe(route.provider === "openai" ? undefined : 16384);
    expect(params.options).toEqual({ defaultOption: true });
    const auth = gatewayClientAuth(route.id, "offline-capability");
    expect(auth).toEqual(route.auth === "oauth" ? {
      openai: { type: "oauth", access: "offline-capability", refresh: "host-gateway-only", expires: Number.MAX_SAFE_INTEGER },
    } : undefined);
    await expect(plugin.default({ directory: "/wrong" })).rejects.toThrow(
      /escaped isolation/,
    );
    await hooks.config(config);
    const configAudit = JSON.parse(await readFile(join(dir, "client-config-audit.json"), "utf8"));
    expect(configAudit.enabled_providers).toEqual([route.provider]);
    expect(configAudit.baseURL).toBe(config.provider[route.provider].options.baseURL);
    expect(await hooks.provider.models()).toEqual({ [route.model]: catalogFixture(route) });
    await hooks.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            callID: "invalid-attempt",
            tool: "invalid",
            state: { status: "pending", input: { tool: "unknown" } },
          },
        },
      },
    });
    expect(
      JSON.parse((await readFile(join(dir, "tool-parts.jsonl"), "utf8")).trim())
        .callID,
    ).toBe("invalid-attempt");
    const output = {
      system: [
        "Coding assistant",
        "Today's date: 2099-01-01",
        "ambient instruction",
      ],
    };
    await hooks["experimental.chat.system.transform"](
      {
        model: {
          providerID: route.provider,
          id: route.model,
        },
        sessionID: "offline",
      },
      output,
    );
    expect(output.system).toEqual([setup.effectiveSystemPrompt]);
    const audit = JSON.parse(
      await readFile(join(dir, "system-prompt.json"), "utf8"),
    );
    expect(audit.effectiveSystemPrompt).toBe(setup.effectiveSystemPrompt);
    expect(audit.promptHash).toBe(hashText(setup.effectiveSystemPrompt));
    expect(audit.toolAllowlist).toHaveLength(4);
    expect(audit.runtime.cliVersion).toBe("1.18.30");
    expect(audit.resolvedModel.id).toBe(route.model);
    expect(audit.workspace.directory).toBe(dir);
    await expect(
      hooks["tool.execute.before"](
        { tool: "bash", callID: "bad" },
        { args: {} },
      ),
    ).rejects.toThrow(/non-trading/);
    await expect(
      hooks["experimental.chat.system.transform"](
        { model: { providerID: "opencode", id: "paid-model" } },
        output,
      ),
    ).rejects.toThrow(/model switched/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
