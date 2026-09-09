// Filesystem helpers. Atomic write is the only nontrivial one —
// we need it because the spec says portfolio state must only be written
// after a fully successful session, and we want no partial writes
// even if the process is killed mid-session.

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Ensure a directory exists (mkdir -p). */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/**
 * Write file atomically: write to `<path>.tmp`, then rename over `<path>`.
 * POSIX rename is atomic on the same filesystem, so a reader either sees
 * the old content or the new content — never a partial write.
 */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}
