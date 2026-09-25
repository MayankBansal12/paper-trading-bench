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
for (const name of ["home", "config", "data", "cache", "state", "extra-config"])
  await mkdir(`/work/${name}`, { recursive: true });
await writeFile("/work/write-probe", "scratch");
await unlink("/work/write-probe");
checks.scratch = "writable";
for (const path of ["/runtime/worker.ts", "/work/benchmark-plugin.mjs"]) {
  try {
    await writeFile(path, "poison");
    checks[`write:${path}`] = "ACCESSIBLE";
  } catch {
    checks[`write:${path}`] = "denied";
  }
}
for (const path of [
  "/home/ai/.env",
  "/home/ai/code/paper-trading-bench/README.md",
  "/proc/1/root/home/ai",
  "/etc/shadow",
  "/var/run/docker.sock",
]) {
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
await emit({ type: "sandbox_state", checks });
const bridge = Bun.serve({
  idleTimeout: 0, // The host session deadline, not Bun's 10s default, bounds inference.
  hostname: "127.0.0.1",
  port: 8765,
  maxRequestBodySize: 2 * 1024 * 1024,
  async fetch(req) {
    const url = new URL(req.url);
    try {
      const response = await fetch(
        "http://gateway" +
          (url.pathname === "/inference/codex/responses"
            ? "/inference/responses"
            : url.pathname) +
          url.search,
        {
          unix: "/gateway.sock",
          method: req.method,
          headers: req.headers,
          body: ["GET", "HEAD"].includes(req.method)
            ? undefined
            : await req.arrayBuffer(),
          redirect: "manual",
          // The host's attempt deadline bounds this request and its response stream.
        },
      );

      return response;
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

await mkdir("/work/pi", { recursive: true });
await writeFile("/work/pi/settings.json", JSON.stringify(launch.settings));
await writeFile("/work/pi/models.json", JSON.stringify(launch.models));
await writeFile("/work/pi/models-store.json", JSON.stringify(launch.catalog));
await writeFile(
  "/work/pi/auth.json",
  JSON.stringify({
    "openai-codex": { type: "api_key", key: launch.capability },
  }),
);
const child = Bun.spawn(
  [
    "/runtime/node",
    "/runtime/pi/dist/bundle/cli.js",
    "--offline",
    "--mode",
    "json",
    "--print",
    "--no-session",
    "--no-builtin-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-approve",
    "--extension",
    "/work/benchmark-plugin.mjs",
    "--provider",
    "openai-codex",
    "--model",
    launch.settings.defaultModel,
    "--thinking",
    "medium",
    "--tools",
    launch.definitions.map((d: any) => "trading_" + d.name).join(","),
    "--system-prompt",
    launch.system,
    "--",
    launch.prompt,
  ],
  {
    cwd: "/work",
    env: {
      PATH: "/runtime",
      HOME: "/work/home",
      LANG: "C.UTF-8",
      PI_CODING_AGENT_DIR: "/work/pi",
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
    },
    stdin: "ignore",
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
        throw new Error("Malformed Pi event");
      }
      // Full message_end includes the exact model and usage. Deltas repeat that growing message;
      // retaining terminal messages avoids quadratic log volume without dropping provider raw traffic.
      if (event.type !== "message_update")
        await emit({ type: "pi_event", event });
      if (
        event.type === "tool_execution_end" &&
        event.toolName === "trading_submit_day" &&
        !event.isError &&
        event.result?.details?.benchmarkResult?.content?.some((p: any) =>
          p.text?.includes('"submitted":true'),
        )
      ) {
        complete = true;
        child.kill("SIGTERM");
      }
    }
  }
  if (pending.trim()) throw new Error("Truncated Pi event");
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
await emit({
  type: "pi_terminal",
  exitCode: code,
  completedSubmission: complete,
});
bridge.stop(true);
process.exit(complete ? 0 : code);
