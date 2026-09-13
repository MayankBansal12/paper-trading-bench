import { createHash } from "node:crypto";

export const QUALIFIED_OPENCODE_CLIENT_VERSION = "1.18.30";
export const QUALIFIED_ZEN_PROVIDER = "opencode";
export const QUALIFIED_ZEN_MODEL = "muse-spark-1.3-contributor-free";
export const QUALIFIED_ZEN_MODEL_ID = QUALIFIED_ZEN_PROVIDER + "/" + QUALIFIED_ZEN_MODEL;

export interface CatalogModelEvidence {
  id: string;
  providerID: string;
  name: string;
  status: string;
  api: { id?: string; url?: string; npm?: string };
  cost: { input: number; output: number; cache: { read: number; write: number }; tiers?: unknown[] };
  capabilities?: { toolcall?: boolean };
  [key: string]: unknown;
}
export interface CatalogQualificationAttempt {
  attempt: number;
  checkedAt: string;
  stdoutSha256?: string;
  matched: boolean;
  error?: string;
}
export interface OpenCodeQualificationEvidence {
  checkedAt: string;
  clientVersion: string;
  versionCommand: "opencode --version";
  catalogCommand: "opencode models opencode --verbose --refresh";
  catalogAttempts: CatalogQualificationAttempt[];
  catalogOutputSha256: string;
  exactModel: string;
  catalogEntry: CatalogModelEvidence;
  zeroCostProven: true;
  noInference: true;
}

function extractJsonObject(text: string, start: number): string {
  let depth = 0, quoted = false, escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") quoted = false;
      continue;
    }
    if (char === "\"") quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return text.slice(start, index + 1);
  }
  throw new Error("OpenCode verbose catalog contains an incomplete JSON entry");
}

export function parseQualifiedCatalogEntry(output: string): CatalogModelEvidence {
  const marker = QUALIFIED_ZEN_MODEL_ID + "\n";
  const markerAt = output.indexOf(marker);
  if (markerAt < 0) throw new Error("Exact model " + QUALIFIED_ZEN_MODEL_ID + " is absent from the refreshed OpenCode catalog");
  const objectAt = output.indexOf("{", markerAt + marker.length);
  if (objectAt < 0) throw new Error("Exact model catalog entry has no verbose metadata");
  const parsed = JSON.parse(extractJsonObject(output, objectAt)) as CatalogModelEvidence;
  if (parsed.id !== QUALIFIED_ZEN_MODEL || parsed.providerID !== QUALIFIED_ZEN_PROVIDER) throw new Error("Exact model catalog identity does not match the requested ID");
  return parsed;
}

export function assertZeroCostCatalogEntry(entry: CatalogModelEvidence): void {
  const cost = entry?.cost;
  if (entry.status !== "active") throw new Error("Exact model catalog entry is not active");
  if (!entry.name?.toLowerCase().includes("free")) throw new Error("Exact model catalog name does not identify a free entry");
  if (entry.api?.url !== "https://opencode.ai/zen/v1" || entry.api?.npm !== "@ai-sdk/openai") throw new Error("Exact model is not routed through the qualified OpenCode Zen provider adapter");
  if (entry.capabilities?.toolcall !== true) throw new Error("Exact model catalog entry does not prove tool-call support");
  if (!cost || cost.input !== 0 || cost.output !== 0 || cost.cache?.read !== 0 || cost.cache?.write !== 0
    || (cost.tiers !== undefined && (!Array.isArray(cost.tiers) || cost.tiers.length !== 0))) {
    throw new Error("Exact model catalog pricing is absent, tiered, or nonzero");
  }
}

async function command(argv: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  clearTimeout(timer);
  if (exitCode !== 0) throw new Error(argv.join(" ") + " failed with exit " + exitCode + ": " + stderr.slice(0, 1000));
  return { stdout, stderr };
}

/** Official-client runtime/catalog gate. It may refresh three times to expose
 * transient catalog omissions, but performs no inference and accepts only a
 * currently returned exact active zero-price entry. Every attempt is retained. */
export async function qualifyOfficialOpenCode(timeoutMs = 30_000): Promise<OpenCodeQualificationEvidence> {
  const version = (await command(["opencode", "--version"], Math.min(timeoutMs, 5_000))).stdout.trim();
  if (version !== QUALIFIED_OPENCODE_CLIENT_VERSION) throw new Error("OpenCode " + version + " is not qualified; required " + QUALIFIED_OPENCODE_CLIENT_VERSION);
  const attempts: CatalogQualificationAttempt[] = [];
  let accepted: { outputSha256: string; entry: CatalogModelEvidence } | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const catalog = await command(["opencode", "models", "opencode", "--verbose", "--refresh"], timeoutMs);
      const outputSha256 = createHash("sha256").update(catalog.stdout).digest("hex");
      try {
        const entry = parseQualifiedCatalogEntry(catalog.stdout);
        assertZeroCostCatalogEntry(entry);
        attempts.push({ attempt, checkedAt: new Date().toISOString(), stdoutSha256: outputSha256, matched: true });
        accepted = { outputSha256, entry };
        break;
      } catch (error) {
        attempts.push({ attempt, checkedAt: new Date().toISOString(), stdoutSha256: outputSha256, matched: false, error: error instanceof Error ? error.message : String(error) });
      }
    } catch (error) {
      attempts.push({ attempt, checkedAt: new Date().toISOString(), matched: false, error: error instanceof Error ? error.message : String(error) });
    }
    if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 250 * attempt));
  }
  if (!accepted) throw new Error("Official OpenCode qualification failed after 3 no-inference catalog attempts: " + attempts.map(item => item.error).join(" | "));
  return {
    checkedAt: new Date().toISOString(), clientVersion: version,
    versionCommand: "opencode --version", catalogCommand: "opencode models opencode --verbose --refresh",
    catalogAttempts: attempts, catalogOutputSha256: accepted.outputSha256, exactModel: QUALIFIED_ZEN_MODEL_ID,
    catalogEntry: accepted.entry, zeroCostProven: true, noInference: true,
  };
}
