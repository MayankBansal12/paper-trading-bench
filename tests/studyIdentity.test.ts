import { test, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  rmSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { implementationIdentity } from "../src/study/identity.ts";
test("identity follows active dependencies and excludes reporting, archived clients, and documentation", () => {
  const before = implementationIdentity(),
    root = mkdtempSync(join(tmpdir(), "v11-identity-"));
  try {
    expect(before.hashes["src/core/execute.ts"]).toBeDefined();
    expect(before.hashes["src/study/worker.ts"]).toBeDefined();
    expect(
      Object.keys(before.hashes).some(
        (f) =>
          f.startsWith("archive/") ||
          f.includes("review.ts") ||
          f.includes("report.ts") ||
          f.includes("profile.ts"),
      ),
    ).toBe(false);
    for (const file of Object.keys(before.hashes)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      copyFileSync(file, join(root, file));
    }
    writeFileSync(join(root, "src/study/review.ts"), "report-only change");
    expect(implementationIdentity(root)).toEqual(before);
    appendFileSync(join(root, "src/core/execute.ts"), "\n// changed engine\n");
    expect(implementationIdentity(root).hash).not.toBe(before.hash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
