import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { contentHash } from "../run/persist.ts";

/** Source and dependency identity is frozen before the first attempt. */
export function implementationIdentity() {
  const root = resolve(".");
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? walk(join(dir, e.name))
        : e.isFile()
          ? [join(dir, e.name)]
          : [],
    );
  const files = [
    ...walk("src"),
    ...walk("scripts/sandbox"),
    "scripts/run-study.ts",
    "scripts/run-study-year.ts",
    "scripts/qualify-study-control.ts",
    "package.json",
    "pnpm-lock.yaml",
  ]
    .filter((f) => /\.(ts|json|yaml|sh|c)$/.test(f))
    .sort();
  const hashes = Object.fromEntries(
    files.map((file) => [
      relative(root, resolve(file)),
      createHash("sha256").update(readFileSync(file)).digest("hex"),
    ]),
  );
  return { hashes, hash: contentHash(hashes) };
}
