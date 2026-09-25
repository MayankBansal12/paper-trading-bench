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
for (const path of [
  ...(launch.forbiddenPaths ?? []),"/runtime/worker.ts", "/work/benchmark-plugin.mjs"]) {
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
let child: ReturnType<typeof Bun.spawn> | undefined;
let completedSubmission = false,
  submissionToolComplete = false,
  stepStarts = 0,
  stepFinishes = 0;
const finishSubmission = () => {
  if (submissionToolComplete && stepStarts > 0 && stepStarts === stepFinishes) {
    completedSubmission = true;
    child?.kill("SIGTERM");
  }
};
const bridge = Bun.serve({
  idleTimeout: 0, // The host session deadline, not Bun's 10s default, bounds inference.
  hostname: "127.0.0.1",
  port: 8765,
  maxRequestBodySize: 2 * 1024 * 1024,
  async fetch(req) {
    const url = new URL(req.url);
    try {
      const response = await fetch(
        "http://gateway" + url.pathname + url.search,
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
      if (response.headers.get("x-bench-submitted") === "true")
        finishSubmission();
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
// A synthetic OAuth record selects OpenCode's native OAuth request layout.
// It contains only this socket's capability; refresh/access credentials stay host-side.
if (launch.auth) {
  await mkdir("/work/data/opencode", { recursive: true });
  await writeFile("/work/data/opencode/auth.json", JSON.stringify(launch.auth), { mode: 0o600 });
}
child = Bun.spawn(
  [
    "/runtime/opencode",
    "run",
    "--format",
    "json",
    "--agent",
    "bench",
    "-m",
    launch.model,
    "--dir",
    "/work",
    "--title",
    "trading-benchmark",
  ],
  {
    cwd: "/work",
    env: launch.env,
    stdin: new Blob([launch.prompt]),
    stdout: "pipe",
    stderr: "pipe",
  },
);
let outputBytes = 0,
  pending = "";
const decoder = new TextDecoder();
const pump = (async () => {
  for await (const chunk of child!.stdout as ReadableStream<Uint8Array>) {
    outputBytes += chunk.length;
    if (outputBytes > 16 * 1024 * 1024) {
      child!.kill();
      throw new Error("Output cap exceeded");
    }
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop()!;
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.type === "step_start") stepStarts++;
        if (event.type === "step_finish") stepFinishes++;
        if (
          event.type === "tool_use" &&
          event.part?.tool === "trading_submit_day" &&
          event.part.state?.status === "completed"
        ) {
          // MCP errors can still be SDK-completed parts. Require the broker's success marker.
          const output = event.part.state.output;
          if (typeof output === "string" && output.includes('"submitted":true'))
            submissionToolComplete = true;
        }
      } catch {} // The host parser independently rejects malformed events.
    }
    await new Promise<void>((resolve, reject) =>
      process.stdout.write(chunk, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
    finishSubmission();
  }
})();
const err = (async () => {
  let total = 0;
  for await (const chunk of child!.stderr as ReadableStream<Uint8Array>) {
    total += chunk.length;
    if (total > 65536) {
      child!.kill();
      break;
    }
    process.stderr.write(chunk);
  }
})();
await Promise.all([pump, err]);
const code = await child.exited;
const files: Record<string, unknown> = {};
for (const name of [
  "system-prompt.json",
  "system-prompts.jsonl",
  "client-config-audit.json",
  "tool-definitions.jsonl",
  "tool-attempts.jsonl",
  "tool-parts.jsonl",
]) {
  try {
    const data = await readFile(`/work/${name}`, "utf8");
    if (data.length > 4 * 1024 * 1024) throw new Error("Audit too large");
    files[name] = name.endsWith("jsonl")
      ? data
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((s) => JSON.parse(s))
      : JSON.parse(data);
  } catch {
    files[name] = null;
  }
}
await emit({
  type: "sandbox_audits",
  files,
  exitCode: code,
  completedSubmission,
});
bridge.stop(true);
process.exit(completedSubmission ? 0 : code);
