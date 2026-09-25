// Copy installed clients into a private runtime. No login or model inference.
import { cp, mkdir, readFile, readdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { isPiModel, piClientVersion, piNodeVersion, piRoute } from "../src/pi/route.ts";
import { isClaudeModel, claudeClientVersion } from "../src/claude/route.ts";
import { claudeBinaryPath } from "../src/claude/sandbox.ts";
import { studyRoute } from "../src/study/routes.ts";

const model = process.argv[2];
if (!model) throw Error("Usage: pnpm runtime:pin MODEL [DIRECTORY]");
studyRoute(model);
if (Bun.version !== "1.3.14") throw Error("Use Bun 1.3.14 to prepare this runtime");
const out = resolve(process.argv[3] ?? `.runtime/${model.replaceAll(/[^a-zA-Z0-9.-]/g, "-")}`);
if (await Bun.file(join(out, "manifest.json")).exists()) throw Error("Runtime already exists; reuse its env.sh or choose a new directory");
await mkdir(join(out, "bin"), { recursive: true });
const digest = async (p: string) => createHash("sha256").update(await readFile(p)).digest("hex");
const versions: Record<string, string> = {};
const run = (args: string[]) => {
  const p = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode) throw Error(`Could not inspect ${basename(args[0]!)}`);
  return p.stdout.toString().trim();
};
const binary = async (name: string, source: string) => {
  await cp(await realpath(source), join(out, "bin", name));
  if (await digest(source) !== await digest(join(out, "bin", name))) throw Error(`Copy changed: ${name}`);
};
await binary("bun", process.execPath);
if (isClaudeModel(model)) {
  const source = claudeBinaryPath(claudeClientVersion(model));
  versions.claude = run([source, "--version"]);
  if (versions.claude !== `${claudeClientVersion(model)} (Claude Code)`) throw Error("Wrong Claude Code version");
  await binary("claude", source);
} else {
  const opencode = Bun.which("opencode");
  if (!opencode) throw Error("Install native OpenCode first");
  const version = run([opencode, "--version"]);
  const allowed = isPiModel(model) ? ["1.18.30", "1.18.31"] : ["1.18.30"];
  if (!allowed.includes(version)) throw Error("Unqualified OpenCode version: " + version);
  versions.opencode = version;
  await binary("opencode", opencode);
}
if (isPiModel(model)) {
  const node = Bun.which("node"), pi = Bun.which("pi");
  if (!node || !pi || run([node, "--version"]) !== piNodeVersion(model)) throw Error(`Use Node ${piNodeVersion(model)} and Pi ${piClientVersion(model)}`);
  const root = resolve(dirname(await realpath(pi)), "../..");
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (pkg.name !== "@earendil-works/pi-coding-agent" || pkg.version !== piClientVersion(model)) throw Error("Wrong Pi package/version");
  versions.pi = pkg.version; versions.node = piNodeVersion(model);
  await binary("node", node);
  // Preserve nested versions. Fill any hoisted dependencies missing from the copy.
  const privateRoot = join(out, "pi");
  await cp(root, privateRoot, { recursive: true, dereference: true });
  const visited = new Map<string, string>();
  async function packageRoot(source: string, name: string) {
    const require = createRequire(join(source, "package.json"));
    for (const base of require.resolve.paths(name) ?? []) {
      const path = join(base, name, "package.json");
      if (await Bun.file(path).exists()) return realpath(dirname(path));
    }
  }
  async function content(source: string): Promise<string> {
    const hash = createHash("sha256");
    async function walk(dir: string) {
      for (const e of (await readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
        if (e.name === "node_modules") continue;
        const p = join(dir,e.name);
        if ((await stat(p)).isDirectory()) await walk(p);
        else hash.update(p.slice(source.length)).update(await readFile(p));
      }
    }
    await walk(source);return hash.digest("hex");
  }
  async function visit(source: string, dest: string) {
    if (visited.has(dest)) {
      if (visited.get(dest) !== await content(source)) throw Error("Conflicting dependency at " + dest);
      return;
    }
    const identity = await content(source);
    if (identity !== await content(dest)) throw Error("Package changed while copying: " + dest);
    visited.set(dest, identity);
    const p = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
    for (const name of Object.keys({ ...p.dependencies, ...p.optionalDependencies })) {
      const child = await packageRoot(source, name);
      if (!child) {
        if (Object.hasOwn(p.optionalDependencies ?? {}, name)) continue;
        throw Error("Missing installed dependency: " + name);
      }
      let target = await packageRoot(dest,name);
      if (!target?.startsWith(privateRoot + "/") || await content(child) !== await content(target)) {
        target = join(dest,"node_modules",name);
        await mkdir(dirname(target),{recursive:true});
        await cp(child,target,{recursive:true,dereference:true});
      }
      await visit(child,target);
    }
  }
  await visit(root,privateRoot);
  await symlink("../pi/dist/bundle/cli.js", join(out, "bin/pi"));
  const source = process.env.BENCH_PI_MODELS_STORE ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent"), "models-store.json");
  const store = JSON.parse(await readFile(source, "utf8")), route = piRoute(model);
  const entries = store[route.provider]?.models?.filter((m: any) => m.id === route.model) ?? [];
  if (entries.length !== 1) throw Error("Exact model missing from Pi catalog; provide BENCH_PI_MODELS_STORE from the recorded official catalog");
  await writeFile(join(out, "models-store.json"), JSON.stringify({ [route.provider]: { models: entries } }, null, 2));
}
const hashes: Record<string, string> = {};
async function hashTree(dir: string) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await hashTree(path);
    else hashes[path.slice(out.length + 1)] = await digest(path);
  }
}
await hashTree(out);
const quote = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
await writeFile(join(out, "env.sh"), `export PATH=${quote(join(out, 'bin'))}:"$PATH"\n` +
  (isPiModel(model) ? `export BENCH_PI_MODELS_STORE=${quote(join(out, 'models-store.json'))}\n` : '') +
  (isClaudeModel(model) ? `export CLAUDE_CODE_BINARY=${quote(join(out, 'bin/claude'))}\n` : ''));
await writeFile(join(out, "manifest.json"), JSON.stringify({ model, versions, hashes }, null, 2) + "\n");
console.log(`Pinned ${model}. Activate with: source ${quote(join(out, "env.sh"))}`);
