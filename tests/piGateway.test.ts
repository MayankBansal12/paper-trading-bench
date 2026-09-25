import { test, expect } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { setup } from "./studyTestSupport.ts";
import { serveGateway } from "../src/study/gateway.ts";
import { systemPrompt } from "../src/study/protocol.ts";
import { PI_MODEL, PI_MODEL_ID } from "../src/pi/route.ts";

test("Pi gateway decodes bounded zstd, pins context/model/tools/reasoning and keeps OAuth host-side", async () => {
  const s = setup(),
    trace: any[] = [];
  let forwarded = 0;
  const server = await serveGateway(
    join(s.dir, "pi.sock"),
    s.tools,
    {
      mode: "oauth",
      authorize: async () =>
        new Headers({
          authorization: "Bearer host-only-fixture",
          "chatgpt-account-id": "host-account",
        }),
    },
    Date.now() + 10000,
    (e) => trace.push(e),
    (async (url: any, init: any) => {
      forwarded++;
      expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
      expect(init.headers.get("authorization")).toBe(
        "Bearer host-only-fixture",
      );
      expect(init.headers.get("content-encoding")).toBeNull();
      expect(JSON.parse(init.body).model).toBe(PI_MODEL);
      return Response.json({ ok: true });
    }) as typeof fetch,
    () => {},
    PI_MODEL_ID,
  );
  const body = {
    model: PI_MODEL,
    reasoning: { effort: "medium" },
    instructions: systemPrompt(s.view.limits),
    input: [{ role: "user", content: s.tools.prompt() }],
    tools: s.tools.definitions.map((d) => ({
      type: "function",
      name: `trading_${d.name}`,
      description: d.description,
      parameters: d.inputSchema,
    })),
  };
  const request = (value: any) =>
    fetch("http://gateway/inference/responses", {
      unix: join(s.dir, "pi.sock"),
      method: "POST",
      headers: {
        authorization: `Bearer ${server.capability}`,
        "content-encoding": "zstd",
      },
      body: zstdCompressSync(Buffer.from(JSON.stringify(value))),
    });
  try {
    expect((await request(body)).status).toBe(200);
    expect((await request({ ...body, model: "gpt-5.6-luna" })).status).toBe(
      403,
    );
    expect(
      (await request({ ...body, reasoning: { effort: "high" } })).status,
    ).toBe(403);
    expect((await request({ ...body, instructions: "changed" })).status).toBe(
      403,
    );
    const changed = structuredClone(body);
    changed.tools[0]!.parameters = { type: "object" } as any;
    expect((await request(changed)).status).toBe(403);
    expect(
      (await request({ ...body, padding: "x".repeat(3 * 1024 * 1024) })).status,
    ).toBe(400);
    expect(forwarded).toBe(1);
    expect(JSON.stringify(trace)).not.toContain("host-only-fixture");
  } finally {
    server.close();
    await rm(s.dir, { recursive: true, force: true });
  }
});
