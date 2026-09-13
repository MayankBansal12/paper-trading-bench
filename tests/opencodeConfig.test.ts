import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { makeClientConfig } from "../src/opencode/config.ts";
import { textHash as hashText } from "../src/core/hash.ts";

test("official client config isolates ambient resources and exact prompt plugin records its actual output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bench-config-test-"));
  try {
    const setup = await makeClientConfig(
      dir,
      "opencode/muse-spark-1.3-contributor-free",
      "Historical trading only.",
      "http://127.0.0.1:43210/mcp",
      "1.18.30",
    );
    const config = setup.config as any;
    expect(config.model).toBe(config.small_model);
    expect(config.permission["*"]).toBe("deny");
    expect(Object.keys(config.permission)).toHaveLength(5);
    expect(setup.env.OPENCODE_TEST_HOME).toBe(join(dir, "home"));
    expect(setup.env.OPENCODE_PURE).toBe("false");
    expect(setup.env.HOME).toBeUndefined();
    const plugin = await import(
      pathToFileURL(join(dir, "benchmark-plugin.mjs")).href
    );
    const hooks = await plugin.default({ directory: dir, worktree: dir });
    await expect(plugin.default({ directory: "/wrong" })).rejects.toThrow(
      /escaped isolation/,
    );
    await hooks.config(config);
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
          providerID: "opencode",
          id: "muse-spark-1.3-contributor-free",
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
    expect(audit.resolvedModel.id).toBe("muse-spark-1.3-contributor-free");
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
