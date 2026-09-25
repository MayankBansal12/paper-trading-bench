import { statfsSync, readdirSync, lstatSync } from "node:fs";

/** Operational admission gate, checked before beginning an attempt. Never refunds one. */
export function assertStorage(path: string) {
  const raw = process.env.BENCH_MIN_FREE_BYTES;
  if (!raw) return;
  const minimum = Number(raw);
  if (!Number.isSafeInteger(minimum) || minimum <= 0)
    throw new Error("Invalid BENCH_MIN_FREE_BYTES");
  const root = process.env.BENCH_STORAGE_ROOT;
  const allowance = Number(process.env.BENCH_MAX_STORAGE_BYTES);
  if (root && Number.isSafeInteger(allowance) && allowance > 0) {
    const used = (dir: string): number => readdirSync(dir).reduce((total, name) => {
      const file = `${dir}/${name}`, st = lstatSync(file);
      return total + (st.isDirectory() ? used(file) : st.blocks * 512);
    }, 0);
    const bytes = used(root);
    if (bytes >= allowance)
      throw new Error(`BENCH_STORAGE_PAUSE used=${bytes} allowance=${allowance} path=${root}`);
  }
  const fs = statfsSync(path);
  const free = fs.bavail * fs.bsize;
  if (free < minimum)
    throw new Error(`BENCH_STORAGE_PAUSE free=${free} required=${minimum} path=${path}`);
}
