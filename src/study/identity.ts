import { readFileSync } from "node:fs";
import { dirname, relative, resolve, extname } from "node:path";
import { spawnSync } from "node:child_process";
import { contentHash, textHash } from "../core/hash.ts";
export function repositoryRevision() {
  return (
    spawnSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).stdout.trim() || "unknown"
  );
}
/** Fingerprint the active dependency closure. Offline review/profile/CLI edits do not alter a cohort. */
export function implementationIdentity(root = resolve(".")) {
  const hashes: Record<string, string> = {};
  const visit = (path: string) => {
    const file = relative(root, path);
    if (hashes[file]) return;
    const raw = readFileSync(path, "utf8");
    hashes[file] = textHash(raw);
    if (extname(path) === ".ts")
      for (const m of raw.matchAll(
        /(?:from\s*|import\s*\()(["'])(\.[^"']+)\1/g,
      ))
        visit(resolve(dirname(path), m[2]!));
  };
  for (const file of [
    "src/study/runner.ts",
    "src/study/worker.ts",
    "src/pi/worker.ts",
    "scripts/sandbox/launch.sh",
    "scripts/sandbox/seccomp.c",
    "package.json",
    "pnpm-lock.yaml",
  ])
    visit(resolve(root, file));
  const sorted = Object.fromEntries(
    Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)),
  );
  return { hashes: sorted, hash: contentHash(sorted) };
}
