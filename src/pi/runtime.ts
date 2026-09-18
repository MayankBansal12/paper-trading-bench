import { createHash } from "node:crypto";
import { readFile, realpath, readdir, cp, chmod } from "node:fs/promises";
import { resolve, dirname, join, relative } from "node:path";
import { homedir } from "node:os";
import { contentHash, textHash } from "../core/hash.ts";
import { prepareSandboxRuntime, qualifySandbox } from "../study/sandbox.ts";
import {
  piRoute,
  PI_PROVIDER,
  PI_VERSION,
  PI_THINKING,
  PI_MODEL_ID,
} from "./route.ts";
import type { ProviderCredential } from "../opencode/credentials.ts";
const bytesHash = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export async function treeHash(root: string): Promise<string> {
  const hashes: Record<string, string> = {};
  async function visit(dir: string) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else hashes[relative(root, path)] = bytesHash(await readFile(path));
    }
  }
  await visit(root);
  return contentHash(hashes);
}
async function command(args: string[]) {
  const p = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  });
  const timer = setTimeout(() => p.kill(), 30_000);
  try {
    const [text, code] = await Promise.all([
      new Response(p.stdout).text(),
      p.exited,
    ]);
    if (code !== 0)
      throw new Error(
        "Pi host authentication command failed; reauthenticate Pi on the host",
      );
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}
let authQueue: Promise<unknown> = Promise.resolve();
export function piCredential(node: string, cli: string): ProviderCredential {
  return {
    mode: "oauth",
    async authorize(signal) {
      // Pi owns refresh/rotation. Serialize refresh across quarterly jobs in this process.
      const pending = authQueue.then(async () => {
        signal.throwIfAborted();
        const token = await command([
          node,
          cli,
          "auth",
          "print-bearer-token",
          "--provider",
          PI_PROVIDER,
          "--min-expiry",
          "2m",
        ]);
        let account: unknown;
        try {
          account = JSON.parse(
            Buffer.from(token.split(".")[1]!, "base64url").toString(),
          )["https://api.openai.com/auth"]?.chatgpt_account_id;
        } catch {}
        if (typeof account !== "string" || !account)
          throw new Error("Pi OAuth account claim unavailable");
        signal.throwIfAborted();
        return new Headers({
          authorization: `Bearer ${token}`,
          "chatgpt-account-id": account,
          originator: "pi",
        });
      });
      authQueue = pending.catch(() => {});
      return pending;
    },
  };
}
export async function preparePiRuntime(modelId = PI_MODEL_ID, expected?: any) {
  const route = piRoute(modelId);
  const started = Date.now();
  const entry = await realpath(Bun.which("pi") ?? "/missing-pi");
  const root = resolve(dirname(entry), "../..");
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (
    pkg.name !== "@earendil-works/pi-coding-agent" ||
    pkg.version !== PI_VERSION
  )
    throw new Error(`Pi ${PI_VERSION} is required`);
  const agentDir =
    process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");
  const store = JSON.parse(
    await readFile(join(agentDir, "models-store.json"), "utf8"),
  );
  const matches =
    store[PI_PROVIDER]?.models?.filter((m: any) => m.id === route.model) ?? [];
  if (matches.length !== 1)
    throw new Error("Exact Pi model missing/duplicated in host Pi catalog");
  let model = matches[0];
  if (expected?.pi?.catalogHash && process.env.BENCH_PINNED_CATALOGS) {
    if (!/^[a-f0-9]{64}$/.test(expected.pi.catalogHash)) throw new Error("Invalid pinned catalog hash");
    model = JSON.parse(await readFile(join(process.env.BENCH_PINNED_CATALOGS, expected.pi.catalogHash + ".json"), "utf8"));
    if (contentHash(model) !== expected.pi.catalogHash || model.id !== route.model)
      throw new Error("Pinned catalog does not match recorded model");
  }
  if (
    model.provider !== PI_PROVIDER ||
    model.api !== "openai-codex-responses" ||
    model.baseUrl !== "https://chatgpt.com/backend-api" ||
    model.reasoning !== true
  )
    throw new Error("Pi route metadata drift");
  const ready = JSON.parse(
    await command([
      "pi",
      "auth",
      "check",
      "--provider",
      PI_PROVIDER,
      "--json",
      "--no-refresh",
    ]),
  );
  if (ready.status !== "ready" || ready.authType !== "oauth")
    throw new Error("Pi OpenAI Codex OAuth is not ready");
  const nodeVersion = await command([Bun.which("node")!, "--version"]);
  if (nodeVersion !== "v22.23.1")
    throw new Error("Pi adapter requires qualified Node v22.23.1");
  if (model.headers && Object.keys(model.headers).length)
    throw new Error("Pi model-specific headers are not qualified");
  const packageHash = await treeHash(root);
  const bundle = await prepareSandboxRuntime(expected);
  try {
    await chmod(bundle.dir, 0o755);
    await cp(root, join(bundle.dir, "pi"), {
      recursive: true,
      dereference: true,
    });
    if ((await treeHash(join(bundle.dir, "pi"))) !== packageHash)
      throw new Error("Pi package changed while freezing runtime");
    await cp(Bun.which("node")!, join(bundle.dir, "node"));
    await chmod(join(bundle.dir, "node"), 0o555);
    await chmod(join(bundle.dir, "worker.ts"), 0o755);
    await cp(resolve("src/pi/worker.ts"), join(bundle.dir, "worker.ts"));
    await chmod(join(bundle.dir, "worker.ts"), 0o555);
    const { id: oldId, ...base } = bundle.evidence;
    const pi = {
      version: PI_VERSION,
      packageHash,
      nodeVersion,
      nodeHash: bytesHash(await readFile(join(bundle.dir, "node"))),
      workerHash: bytesHash(await readFile(join(bundle.dir, "worker.ts"))),
      thinking: PI_THINKING,
      model: modelId,
      catalogHash: contentHash(model),
      auth: "host-pi-oauth",
      transport: "sse",
      subscriptionCost: "unavailable",
    };
    const identity = { ...base, pi };
    bundle.evidence = { ...identity, id: contentHash(identity) };
    await chmod(bundle.dir, 0o555);
    const sandboxQualification = await qualifySandbox(bundle);
    return {
      bundle,
      sandboxQualification,
      setupMs: Date.now() - started,
      qualification: {
        exactModel: modelId,
        clientVersion: PI_VERSION,
        model,
        noInference: true,
        thinking: PI_THINKING,
        packageHash,
      },
      credential: piCredential(
        join(bundle.dir, "node"),
        join(bundle.dir, "pi/dist/bundle/cli.js"),
      ),
      dispose: bundle.dispose,
    };
  } catch (e) {
    await bundle.dispose();
    throw e;
  }
}
