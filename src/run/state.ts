// Isolated per (model, seed, run) state: deterministic run ids so the same
// config always resolves to the same directory, config/state persistence,
// and a consistency check that fails loudly rather than silently corrupting
// a resumed run with an incompatible config. A run directory represents ONE
// immutable canonical benchmark config — the only mutation ever allowed is a
// strictly monotonic extension of `endDate` on an explicit --run-id, and
// that extension rewrites config.json so it's never left stale.

import { readFile } from "node:fs/promises";
import {
  runConfigFile,
  runDir as buildRunDir,
  runStateFile,
} from "../utils/paths.ts";
import { ensureDir, writeFileAtomic } from "../utils/fs.ts";
import type { RunConfig, RunState } from "../domain/types.ts";

/** Identity fields that can NEVER change for an existing run directory. */
const RIGID_FIELDS = [
  "model", "seed", "agent", "startDate", "startingCapital", "universeVersion",
  "executionConvention", "fixtureVersion", "protocolVersion",
] as const;

/** FNV-1a over the config's full canonical identity -> short hex id. Same config, same id, always. */
export function deriveRunId(config: RunConfig): string {
  const key = [
    config.model,
    config.seed,
    config.agent,
    config.startDate ?? "",
    config.endDate ?? "",
    config.startingCapital,
    config.universeVersion,
    config.limits.maxTurns,
    config.limits.maxToolCalls,
    config.limits.timeoutMs,
    config.executionConvention,
    config.fixtureVersion,
    config.protocolVersion,
  ].join("|");
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function resolveRunDir(config: RunConfig): { runId: string; dir: string } {
  const runId = config.runId ?? deriveRunId(config);
  return { runId, dir: buildRunDir(config.model, config.seed, runId) };
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function limitsEqual(a: RunConfig["limits"], b: RunConfig["limits"]): boolean {
  return a.maxTurns === b.maxTurns && a.maxToolCalls === b.maxToolCalls && a.timeoutMs === b.timeoutMs;
}

/**
 * On first run, writes config.json verbatim. On resume, verifies the stored
 * config's identity matches:
 *   - RIGID_FIELDS + limits must match EXACTLY — any difference is rejected,
 *     forcing a different --run-id rather than silently reinterpreting an
 *     existing run's data under new rules.
 *   - `endDate` may be extended (a later, non-null date replacing an earlier
 *     one) — the only mutation this function ever performs, and it rewrites
 *     config.json so the stored config is never stale. Shrinking or
 *     otherwise changing `endDate` is rejected.
 *
 * Returns the config that IS now stored on disk (either the original or the
 * extended one) so callers never operate on a value that diverges from
 * config.json.
 */
export async function ensureConfig(dir: string, config: RunConfig): Promise<RunConfig> {
  const existing = await readJson<RunConfig>(runConfigFile(dir));
  if (!existing) {
    await ensureDir(dir);
    await writeFileAtomic(runConfigFile(dir), JSON.stringify(config, null, 2) + "\n");
    return config;
  }

  const mismatched = RIGID_FIELDS.filter((k) => existing[k] !== config[k]);
  if (!limitsEqual(existing.limits, config.limits)) mismatched.push("limits" as (typeof RIGID_FIELDS)[number]);
  if (mismatched.length > 0) {
    throw new Error(
      `Run directory ${dir} already has an incompatible config (differs on: ${mismatched.join(", ")}). Use a different --run-id.`,
    );
  }

  if (existing.endDate === config.endDate) return existing;

  const isMonotonicExtension = existing.endDate !== null && config.endDate !== null && config.endDate > existing.endDate;
  if (!isMonotonicExtension) {
    throw new Error(
      `Run directory ${dir} already has endDate=${existing.endDate ?? "null"}; requested endDate=${config.endDate ?? "null"} is not a valid monotonic extension (must be a later, explicit date). Use a different --run-id.`,
    );
  }
  const extended: RunConfig = { ...existing, endDate: config.endDate };
  await writeFileAtomic(runConfigFile(dir), JSON.stringify(extended, null, 2) + "\n");
  return extended;
}

export async function loadRunState(dir: string): Promise<RunState | null> {
  return readJson<RunState>(runStateFile(dir));
}

export async function saveRunState(dir: string, state: RunState): Promise<void> {
  await writeFileAtomic(runStateFile(dir), JSON.stringify(state, null, 2) + "\n");
}
