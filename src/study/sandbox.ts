import { resolve, join } from "node:path";
import {
  readFile,
  readlink,
  mkdir,
  mkdtemp,
  writeFile,
  chmod,
  rm,
  copyFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { contentHash, textHash } from "../core/hash.ts";
export const SANDBOX_POLICY = "bwrap-systemd-unix-gateway-v2";
export interface SandboxProcess {
  process: ReturnType<typeof Bun.spawn>;
  stop: () => Promise<void>;
  evidence: Record<string, unknown>;
}
export async function sandboxIdentity() {
  const files = [
    "scripts/sandbox/launch.sh",
    "src/study/worker.ts",
    ".sandbox/seccomp.bpf",
  ];
  const hashes = Object.fromEntries(
    await Promise.all(
      files.map(async (p) => [
        p,
        createHash("sha256")
          .update(await readFile(resolve(p)))
          .digest("hex"),
      ]),
    ),
  );
  const version = Bun.spawn(["/usr/bin/bwrap", "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const v = (await new Response(version.stdout).text()).trim();
  if ((await version.exited) !== 0 || v !== "bubblewrap 0.9.0")
    throw new Error("Unqualified bubblewrap version");
  const binary = await readFile(Bun.which("opencode") ?? "/missing");
  const bun = await readFile(process.execPath);
  const identity = {
    policy: SANDBOX_POLICY,
    bwrap: v,
    hashes,
    opencodeHash: createHash("sha256").update(binary).digest("hex"),
    bunHash: createHash("sha256").update(bun).digest("hex"),
    bwrapHash: createHash("sha256")
      .update(await readFile("/usr/bin/bwrap"))
      .digest("hex"),
    kernel: (await readFile("/proc/sys/kernel/osrelease", "utf8")).trim(),
    limits: {
      memoryBytes: 2147483648,
      tasks: 128,
      tmpBytes: 67108864,
      workBytes: 134217728,
    },
  };
  return { ...identity, id: contentHash(identity) };
}
export interface PreparedSandboxRuntime {
  dir: string;
  evidence: Awaited<ReturnType<typeof sandboxIdentity>>;
  dispose: () => Promise<void>;
}
/** Copy and verify trusted executables once; daily launches mount these same files read-only. */
export async function prepareSandboxRuntime(): Promise<PreparedSandboxRuntime> {
  const evidence = await sandboxIdentity();
  const dir = await mkdtemp(join(tmpdir(), "study-immutable-runtime-"));
  try {
    for (const [source, name, hash] of [
      [process.execPath, "bun", evidence.bunHash],
      [Bun.which("opencode")!, "opencode", evidence.opencodeHash],
      [
        resolve("src/study/worker.ts"),
        "worker.ts",
        evidence.hashes["src/study/worker.ts"],
      ],
      [
        resolve("scripts/sandbox/launch.sh"),
        "launch.sh",
        evidence.hashes["scripts/sandbox/launch.sh"],
      ],
      [
        resolve(".sandbox/seccomp.bpf"),
        "seccomp.bpf",
        evidence.hashes[".sandbox/seccomp.bpf"],
      ],
    ]) {
      await copyFile(source!, join(dir, name!));
      if (
        createHash("sha256")
          .update(await readFile(join(dir, name!)))
          .digest("hex") !== hash
      )
        throw new Error("Runtime changed during preparation");
      await chmod(join(dir, name!), 0o555);
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
export async function launchSandbox(
  setup: string,
  socket: string,
  timeoutMs: number,
  runtime: PreparedSandboxRuntime,
): Promise<SandboxProcess> {
  await chmod(setup, 0o755);
  await chmod(socket, 0o666);
  await mkdir(join(setup, "readonly-config"), { recursive: true });
  await writeFile(join(setup, "readonly-config", ".gitignore"), "*\n");
  await chmod(join(setup, "readonly-config"), 0o755);
  await writeFile(
    join(setup, "passwd"),
    "sandbox:x:1000:1000::/work/home:/nonexistent\n",
    { mode: 0o444 },
  );
  for (const name of ["launch.json", "benchmark-plugin.mjs"])
    await chmod(join(setup, name), 0o444);
  const evidence = runtime.evidence;
  const unit = "trading-bench-" + randomUUID();
  const args = [
    "sudo",
    "-n",
    "systemd-run",
    "--quiet",
    "--pipe",
    "--wait",
    "--collect",
    `--unit=${unit}`,
    "-p",
    "MemoryMax=2G",
    "-p",
    "TasksMax=128",
    "-p",
    `RuntimeMaxSec=${Math.ceil(timeoutMs / 1000) + 10}`,
    "-p",
    "KillMode=control-group",
    "/bin/sh",
    join(runtime.dir, "launch.sh"),
    join(runtime.dir, "seccomp.bpf"),
    join(runtime.dir, "bun"),
    join(runtime.dir, "opencode"),
    setup,
    socket,
    join(runtime.dir, "worker.ts"),
  ];
  const child = Bun.spawn(args, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
  });
  const hostNamespaces = Object.fromEntries(
    await Promise.all(
      ["mnt", "pid", "net", "user", "ipc", "uts"].map(async (n) => [
        n,
        await readlink(`/proc/self/ns/${n}`),
      ]),
    ),
  );
  return {
    process: child,
    evidence: { ...evidence, hostNamespaces, unit },
    stop: async () => {
      const p = Bun.spawn(
        [
          "sudo",
          "-n",
          "systemctl",
          "kill",
          "--kill-whom=all",
          "--signal=KILL",
          unit,
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      await p.exited;
    },
  };
}
export function validateSandboxState(checks: any, evidence: any) {
  if (
    !checks ||
    checks.cwd !== "/work" ||
    !/^NoNewPrivs:\s+1$/m.test(checks.status) ||
    !/^Seccomp:\s+2$/m.test(checks.status) ||
    !/^CapEff:\s+0+$/m.test(checks.status)
  )
    throw new Error("Sandbox process security assertions failed");
  for (const n of ["mnt", "pid", "net", "user", "ipc", "uts"])
    if (
      !checks.namespaces?.[n] ||
      checks.namespaces[n] === evidence.hostNamespaces[n]
    )
      throw new Error("Namespace isolation missing: " + n);
  if (checks.scratch !== "writable")
    throw new Error("Sandbox scratch unavailable");
  for (const k of [
    "/home/ai/.env",
    "/home/ai/code/paper-trading-bench/README.md",
    "/proc/1/root/home/ai",
    "/etc/shadow",
    "/var/run/docker.sock",
    "external",
    "write:/runtime/worker.ts",
    "write:/work/benchmark-plugin.mjs",
  ])
    if (checks[k] !== "denied")
      throw new Error(
        "Forbidden sandbox access succeeded or was not probed: " + k,
      );
}
export async function qualifySandbox(prepared?: PreparedSandboxRuntime) {
  const runtime = prepared ?? (await prepareSandboxRuntime());
  const dir = await mkdtemp(join(tmpdir(), "study-probe-"));
  const socket = join(dir, "gateway.sock");
  const capability = randomUUID();
  const server = Bun.serve({
    unix: socket,
    fetch(req) {
      return new Response("scoped-gateway", {
        status:
          new URL(req.url).pathname === "/probe" &&
          req.headers.get("authorization") === `Bearer ${capability}`
            ? 200
            : 403,
      });
    },
  });
  try {
    await chmod(socket, 0o600);
    await writeFile(
      join(dir, "launch.json"),
      JSON.stringify({ probe: true, capability }),
    );
    await writeFile(join(dir, "benchmark-plugin.mjs"), "");
    const run = await launchSandbox(dir, socket, 10000, runtime);
    const timer = setTimeout(() => void run.stop(), 15000);
    try {
      const [out, err, code] = await Promise.all([
        new Response(run.process.stdout as ReadableStream<Uint8Array>).text(),
        new Response(run.process.stderr as ReadableStream<Uint8Array>).text(),
        run.process.exited,
      ]);
      if (code !== 0) throw new Error("Sandbox probe failed: " + err);
      const events = out
        .trim()
        .split("\n")
        .map((s) => JSON.parse(s));
      const checks = events.find((e) => e.type === "sandbox_state")?.checks;
      validateSandboxState(checks, run.evidence);
      const probe = events.find((e) => e.type === "sandbox_probe");
      if (probe?.status !== 200 || probe.body !== "scoped-gateway")
        throw new Error("Scoped gateway probe failed");
      return { ...run.evidence, checks, probe, qualified: true };
    } finally {
      clearTimeout(timer);
      await run.stop();
    }
  } finally {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
    if (!prepared) await runtime.dispose();
  }
}
