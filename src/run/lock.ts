// Basic mutual exclusion for a run directory: exclusive-create a lock file
// so two processes can never interleave writes to the same run. Not
// lease/expiry-aware (v0 scope) — a lock left behind by a killed process
// must be removed manually; the error message says so.

import { open, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { ensureDir } from "../utils/fs.ts";

function lockFile(dir: string): string {
  return resolve(dir, ".lock");
}

export async function acquireRunLock(dir: string): Promise<() => Promise<void>> {
  await ensureDir(dir);
  const path = lockFile(dir);
  try {
    const handle = await open(path, "wx");
    await handle.writeFile(`pid=${process.pid} startedAt=${new Date().toISOString()}\n`);
    await handle.close();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `Run directory ${dir} is locked by another process (${path}). If no other run is actually in progress (e.g. a previous run crashed), delete ${path} and retry.`,
      );
    }
    throw err;
  }
  return async () => {
    await rm(path, { force: true });
  };
}
