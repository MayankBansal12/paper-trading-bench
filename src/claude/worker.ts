// The only application code mounted into the model's namespace. No repository imports.
import { readFile, readlink, mkdir, writeFile, unlink } from "node:fs/promises";
const launch = JSON.parse(await readFile("/runtime/launch.json", "utf8"));
const emit = (value: unknown) =>
  new Promise<void>((resolve, reject) =>
    process.stdout.write(JSON.stringify(value) + "\n", (error) =>
      error ? reject(error) : resolve(),
    ),
  );
const checks: Record<string, unknown> = {};
checks.status = await readFile("/proc/self/status", "utf8");
checks.namespaces = Object.fromEntries(
  await Promise.all(
    ["mnt", "pid", "net", "user", "ipc", "uts"].map(async (n) => [
      n,
      await readlink(`/proc/self/ns/${n}`),
    ]),
  ),
);
checks.cwd = process.cwd();
for (const name of ["home", "home/.claude"]) await mkdir(`/work/${name}`, { recursive: true });
await writeFile("/work/write-probe", "scratch");
await unlink("/work/write-probe");
checks.scratch = "writable";
for (const path of ["/runtime/worker.ts", "/runtime/launch.json", "/runtime/claude"]) {
  try {
    await writeFile(path, "poison");
    checks[`write:${path}`] = "ACCESSIBLE";
  } catch {
    checks[`write:${path}`] = "denied";
  }
}
for (const path of launch.forbiddenPaths as string[]) {
  try {
    await readFile(path);
    checks[path] = "ACCESSIBLE";
  } catch {
    checks[path] = "denied";
  }
}
try {
  await fetch("http://169.254.169.254/", { signal: AbortSignal.timeout(400) });
  checks.external = "ACCESSIBLE";
} catch {
  checks.external = "denied";
}
try {
  await fetch("https://api.anthropic.com/", { signal: AbortSignal.timeout(800) });
  checks.anthropic = "ACCESSIBLE";
} catch {
  checks.anthropic = "denied";
}
await emit({ type: "sandbox_state", checks });
const bridge = Bun.serve({
  idleTimeout: 0, // The host session deadline, not Bun's 10s default, bounds inference.
  hostname: "127.0.0.1",
  port: 8765,
  maxRequestBodySize: 4 * 1024 * 1024,
  async fetch(req) {
    const url = new URL(req.url);
    try {
      const headers = new Headers(req.headers);
      headers.delete("host");
      return await fetch("http://gateway" + url.pathname + url.search, {
        unix: "/gateway.sock",
        method: req.method,
        headers,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : await req.arrayBuffer(),
        redirect: "manual",
      });
    } catch {
      return new Response("Gateway unavailable", { status: 502 });
    }
  },
});
if (launch.probe) {
  const r = await fetch("http://127.0.0.1:8765/probe", {
    headers: { authorization: `Bearer ${launch.capability}` },
  });
  await emit({ type: "sandbox_probe", status: r.status, body: await r.text() });
  bridge.stop(true);
  process.exit(0);
}
await writeFile(
  "/work/mcp.json",
  JSON.stringify({
    mcpServers: {
      trading: {
        type: "http",
        url: "http://127.0.0.1:8765/mcp",
        headers: { authorization: `Bearer ${launch.capability}` },
      },
    },
  }),
);
const child = Bun.spawn(
  [
    "/runtime/claude",
    "-p",
    "--bare",
    "--model", launch.model,
    "--effort", launch.effort,
    "--system-prompt", launch.system,
    "--tools", "",
    "--strict-mcp-config",
    "--mcp-config", "/work/mcp.json",
    "--allowedTools", launch.allowedTools.join(","),
    "--setting-sources", "",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--permission-mode", "dontAsk",
    "--output-format", "stream-json",
    "--verbose",
  ],
  {
    cwd: "/work",
    env: {
      PATH: "/runtime",
      HOME: "/work/home",
      CLAUDE_CONFIG_DIR: "/work/home/.claude",
      LANG: "C.UTF-8",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8765",
      ANTHROPIC_API_KEY: launch.capability,
      DISABLE_TELEMETRY: "1",
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      MAX_MCP_OUTPUT_TOKENS: "500000",
    },
    stdin: new TextEncoder().encode(launch.prompt),
    stdout: "pipe",
    stderr: "pipe",
  },
);
let complete = false,
  bytes = 0,
  pending = "";
const decoder = new TextDecoder();
const pump = (async () => {
  for await (const chunk of child.stdout) {
    bytes += chunk.length;
    if (bytes > 16 * 1024 * 1024) {
      child.kill();
      throw new Error("Output cap exceeded");
    }
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop()!;
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        throw new Error("Malformed Claude event");
      }
      await emit({ type: "claude_event", event });
      if (
        event.type === "user" &&
        Array.isArray(event.message?.content) &&
        event.message.content.some(
          (p: any) =>
            p.type === "tool_result" &&
            !p.is_error &&
            JSON.stringify(p.content).includes('\\"submitted\\":true'),
        )
      ) {
        complete = true;
        child.kill("SIGTERM");
      }
    }
  }
  if (pending.trim()) throw new Error("Truncated Claude event");
})();
const errors = (async () => {
  let n = 0;
  for await (const chunk of child.stderr) {
    n += chunk.length;
    if (n > 65536) {
      child.kill();
      break;
    }
    process.stderr.write(chunk);
  }
})();
await Promise.all([pump, errors]);
const code = await child.exited;
await emit({ type: "claude_terminal", exitCode: code, completedSubmission: complete });
bridge.stop(true);
process.exit(complete ? 0 : code);
