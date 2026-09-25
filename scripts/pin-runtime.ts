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
  if (!opencode || run([opencode, "--version"]) !== "1.18.30") throw Error("Install native OpenCode 1.18.30 first");
  versions.opencode = "1.18.30";
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
  // Resolve the installed dependency graph before copying. pnpm may hoist siblings
  // outside Pi's directory; copying just that directory would omit required code.
  const graph = new Map<string, { root: string; version: string }>();
  async function visit(source: string) {
    const p = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
    const existing = graph.get(p.name);
    if (existing) {
      if (existing.root !== source) throw Error(`Multiple installed copies of ${p.name}; use an isolated npm install for pinning`);
      return;
    }
    graph.set(p.name, { root: source, version: p.version });
    const require = createRequire(join(source, "package.json"));
    for (const name of Object.keys({ ...p.dependencies, ...p.optionalDependencies })) {
      let child: string | undefined;
      for (const base of require.resolve.paths(name) ?? []) {
        const path = join(base, name, "package.json");
        if (await Bun.file(path).exists()) { child = await realpath(dirname(path)); break; }
      }
      if (!child) {
        if (Object.hasOwn(p.optionalDependencies ?? {}, name)) continue;
        throw Error(`Missing installed dependency: ${name}`);
      }
      await visit(child);
    }
  }
  await visit(root);
  for (const [name, entry] of graph) {
    const dest = name === pkg.name ? join(out, "pi") : join(out, "pi/node_modules", name);
    await cp(entry.root, dest, { recursive: true, dereference: true,
      filter: (source) => !source.slice(entry.root.length).split('/').includes('node_modules') });
  }
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
