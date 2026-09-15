import { test, expect } from "bun:test";
import { resolve } from "node:path";
import { QUALIFIED_MODEL_IDS } from "../src/opencode/qualification.ts";

for (const model of QUALIFIED_MODEL_IDS) test(`${model}: selected route reaches isolated launch with gateway-only credentials`, async () => {
  const script = `import { mock } from "bun:test";
    import { readFile, rm } from "node:fs/promises";
    import { join } from "node:path";
    let launch;
    mock.module(${JSON.stringify(resolve("src/study/sandbox.ts"))}, () => ({
      launchSandbox: async dir => {
        launch = JSON.parse(await readFile(join(dir, "launch.json"), "utf8"));
        throw Error("Offline sandbox launch inspected");
      },
      validateSandboxState: () => {}, prepareSandboxRuntime: async () => { throw Error("No real runtime"); }, qualifySandbox: async () => {},
    }));
    const { setup } = await import(${JSON.stringify(resolve("tests/studyTestSupport.ts"))});
    const { catalogFixture } = await import(${JSON.stringify(resolve("tests/opencodeFixtures.ts"))});
    const { qualifiedRoute } = await import(${JSON.stringify(resolve("src/opencode/qualification.ts"))});
    const { decideStudy } = await import(${JSON.stringify(resolve("src/study/agent.ts"))});
    const s = setup(), route = qualifiedRoute(${JSON.stringify(model)}), audits = [];
    try {
      const result = await decideStudy(s.view, s.store, [], { start: "2025-01-31", end: "2025-02-04", contributions: [] }, e => audits.push(e), {
        route, qualification: { clientVersion: "1.18.30", catalogEntry: catalogFixture(route) },
        credential: { mode: route.auth, authorize: async () => { throw Error("test-host-secret-must-never-be-used"); } },
        bundle: {}, sandboxQualification: {}, setupMs: 0,
      });
      if (result.reason !== "Offline sandbox launch inspected") throw Error(result.reason);
      console.log(JSON.stringify({ launch, audits }));
    } finally { await rm(s.dir, { recursive: true, force: true }); }`;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(err).toBe(""); expect(code).toBe(0);
  expect(out).not.toContain("test-host-secret");
  const { launch, audits } = JSON.parse(out);
  const provider = model.split("/")[0];
  expect(launch.model).toBe(model);
  const config = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT);
  expect(config.model).toBe(model);
  expect(config.enabled_providers).toEqual([provider]);
  expect(launch.env.BENCH_GATEWAY_TOKEN).toBeDefined();
  expect(config.mcp.trading.headers.Authorization).toBe(`Bearer ${launch.env.BENCH_GATEWAY_TOKEN}`);
  expect(launch.env.OPENCODE_DISABLE_DEFAULT_PLUGINS).toBe("true");
  if (provider === "openai") {
    expect(launch.auth.openai.access).toBe(launch.env.BENCH_GATEWAY_TOKEN);
    expect(launch.auth.openai.refresh).toBe("host-gateway-only");
  } else expect(launch.auth).toBeUndefined();
  const protocol = audits.find((a: any) => a.type === "protocol");
  expect(protocol.provider + "/" + protocol.model).toBe(model);
});
