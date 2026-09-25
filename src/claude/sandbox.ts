import { resolve, join } from "node:path";
import { readFile, readlink, mkdir, mkdtemp, writeFile, chmod, rm, copyFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { contentHash } from "../core/hash.ts";
import { CLAUDE_VERSION } from "./route.ts";
export const CLAUDE_SANDBOX_POLICY = "bwrap-systemd-user-unix-gateway-claude-v1";
const sha = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
async function run(args: string[]) {
  const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return { out: out.trim(), code };
}
export function claudeBinaryPath(version = CLAUDE_VERSION) {
  return process.env.CLAUDE_CODE_BINARY ?? resolve(homedir(), ".local/share/claude/versions", version);
}
export async function claudeSandboxIdentity(clientVersion = CLAUDE_VERSION) {
  const files = ["scripts/sandbox/launch-claude.sh", "src/claude/worker.ts", ".sandbox/seccomp.bpf"];
  const hashes = Object.fromEntries(await Promise.all(files.map(async (p) => [p, await sha(resolve(p))])));
  const bwrap = await run(["/usr/bin/bwrap", "--version"]);
  if (bwrap.code !== 0 || bwrap.out !== "bubblewrap 0.9.0") throw new Error("Unqualified bubblewrap version");
  const version = await run([claudeBinaryPath(clientVersion), "--version"]);
  if (version.code !== 0 || version.out !== `${clientVersion} (Claude Code)`)
    throw new Error(`Claude Code ${clientVersion} is required`);
  const identity = {
    policy: CLAUDE_SANDBOX_POLICY,
    bwrap: bwrap.out,
    hashes,
    claudeVersion: clientVersion,
    claudeHash: await sha(claudeBinaryPath(clientVersion)),
    bunVersion: Bun.version,
    bunHash: await sha(process.execPath),
    bwrapHash: await sha("/usr/bin/bwrap"),
    kernel: (await readFile("/proc/sys/kernel/osrelease", "utf8")).trim(),
    limits: { memoryBytes: 2147483648, tasks: 128, tmpBytes: 67108864, workBytes: 268435456 },
  };
  return { ...identity, id: contentHash(identity) };
}
export interface ClaudeBundle {
  dir: string;
  evidence: Awaited<ReturnType<typeof claudeSandboxIdentity>> & Record<string, unknown>;
  dispose: () => Promise<void>;
}
export async function prepareClaudeBundle(clientVersion = CLAUDE_VERSION): Promise<ClaudeBundle> {
  const evidence = await claudeSandboxIdentity(clientVersion);
  const dir = await mkdtemp(join(tmpdir(), "claude-immutable-runtime-"));
  try {
    for (const [source, name, hash] of [
      [process.execPath, "bun", evidence.bunHash],
      [claudeBinaryPath(clientVersion), "claude", evidence.claudeHash],
      [resolve("src/claude/worker.ts"), "worker.ts", evidence.hashes["src/claude/worker.ts"]],
      [resolve("scripts/sandbox/launch-claude.sh"), "launch.sh", evidence.hashes["scripts/sandbox/launch-claude.sh"]],
      [resolve(".sandbox/seccomp.bpf"), "seccomp.bpf", evidence.hashes[".sandbox/seccomp.bpf"]],
    ] as const) {
      await copyFile(source, join(dir, name));
      if ((await sha(join(dir, name))) !== hash) throw new Error("Runtime changed during preparation");
      await chmod(join(dir, name), 0o555);
    }
    await chmod(dir, 0o555);
    return {
      dir,
      evidence,
      dispose: async () => {
        await chmod(dir, 0o755);
        await rm(dir, { recursive: true, force: true });
      },
    };
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
}
export function forbiddenPaths() {
  const home = homedir();
  return [
    join(home, ".claude", ".credentials.json"),
    join(home, ".claude.json"),
    join(home, ".bashrc"),
    resolve("README.md"),
    resolve("datasets/historical/nasdaq100_2025q2-2026q1_v1/manifest.json"),
    "/etc/shadow",
    "/proc/1/root" + home,
    "/run/user/" + process.getuid!() + "/bus",
  ];
}
export async function launchClaudeSandbox(setup: string, socket: string, timeoutMs: number, bundle: ClaudeBundle) {
  await chmod(setup, 0o755);
  await chmod(socket, 0o666);
  await writeFile(join(setup, "passwd"), "sandbox:x:1000:1000::/work/home:/nonexistent\n", { mode: 0o444 });
  await chmod(join(setup, "launch.json"), 0o444);
  const unit = "claude-bench-" + randomUUID();
  const child = Bun.spawn(
    [
      "systemd-run", "--user", "--quiet", "--pipe", "--wait", "--collect", `--unit=${unit}`,
      "-p", "MemoryMax=2G", "-p", "TasksMax=128",
      "-p", `RuntimeMaxSec=${Math.ceil(timeoutMs / 1000) + 10}`, "-p", "KillMode=control-group",
      "/bin/sh", join(bundle.dir, "launch.sh"),
      join(bundle.dir, "seccomp.bpf"), join(bundle.dir, "bun"), join(bundle.dir, "claude"),
      setup, socket, join(bundle.dir, "worker.ts"), String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    ],
    {
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid!()}`, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=/run/user/${process.getuid!()}/bus` },
    },
  );
  const hostNamespaces = Object.fromEntries(
    await Promise.all(["mnt", "pid", "net", "user", "ipc", "uts"].map(async (n) => [n, await readlink(`/proc/self/ns/${n}`)])),
  );
  return {
    process: child,
    evidence: { ...bundle.evidence, hostNamespaces, unit },
    stop: async () => {
      await run(["systemctl", "--user", "kill", "--kill-whom=all", "--signal=KILL", unit + ".service"]);
    },
  };
}
export function validateClaudeSandboxState(checks: any, evidence: any) {
  if (
    !checks || checks.cwd !== "/work" ||
    !/^NoNewPrivs:\s+1$/m.test(checks.status) ||
    !/^Seccomp:\s+2$/m.test(checks.status) ||
    !/^CapEff:\s+0+$/m.test(checks.status)
  ) throw new Error("Sandbox process security assertions failed");
  for (const n of ["mnt", "pid", "net", "user", "ipc", "uts"])
    if (!checks.namespaces?.[n] || checks.namespaces[n] === evidence.hostNamespaces[n])
      throw new Error("Namespace isolation missing: " + n);
  if (checks.scratch !== "writable") throw new Error("Sandbox scratch unavailable");
  for (const k of [...forbiddenPaths(), "external", "anthropic", "write:/runtime/worker.ts", "write:/runtime/launch.json", "write:/runtime/claude"])
    if (checks[k] !== "denied") throw new Error("Forbidden sandbox access succeeded or was not probed: " + k);
}
export async function qualifyClaudeSandbox(prepared?: ClaudeBundle) {
  const bundle = prepared ?? (await prepareClaudeBundle());
  const dir = await mkdtemp(join(tmpdir(), "claude-probe-"));
  const socket = join(dir, "gateway.sock");
  const capability = randomUUID();
  const server = Bun.serve({
    unix: socket,
    fetch(req) {
      return new Response("scoped-gateway", {
        status: new URL(req.url).pathname === "/probe" && req.headers.get("authorization") === `Bearer ${capability}` ? 200 : 403,
      });
    },
  });
  try {
    await chmod(socket, 0o600);
    await writeFile(join(dir, "launch.json"), JSON.stringify({ probe: true, capability, forbiddenPaths: forbiddenPaths() }));
    const r = await launchClaudeSandbox(dir, socket, 15000, bundle);
    const timer = setTimeout(() => void r.stop(), 20000);
    try {
      const [out, err, code] = await Promise.all([
        new Response(r.process.stdout as ReadableStream<Uint8Array>).text(),
        new Response(r.process.stderr as ReadableStream<Uint8Array>).text(),
        r.process.exited,
      ]);
      if (code !== 0) throw new Error("Sandbox probe failed: " + err);
      const events = out.trim().split("\n").map((s) => JSON.parse(s));
      const checks = events.find((e) => e.type === "sandbox_state")?.checks;
      validateClaudeSandboxState(checks, r.evidence);
      const probe = events.find((e) => e.type === "sandbox_probe");
      if (probe?.status !== 200 || probe.body !== "scoped-gateway") throw new Error("Scoped gateway probe failed");
      return { ...r.evidence, checks, probe, qualified: true };
    } finally {
      clearTimeout(timer);
      await r.stop();
    }
  } finally {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
    if (!prepared) await bundle.dispose();
  }
}
