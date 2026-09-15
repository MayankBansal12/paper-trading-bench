import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const QUALIFIED_OPENCODE_CLIENT_VERSION = "1.18.30";
export const QUALIFIED_ZEN_PROVIDER = "opencode";
export const QUALIFIED_ZEN_MODEL = "muse-spark-1.3-contributor-free";
export const QUALIFIED_ZEN_MODEL_ID =
  QUALIFIED_ZEN_PROVIDER + "/" + QUALIFIED_ZEN_MODEL;

/** Admission is conditional on a fresh, exact, active catalog check whose
 * published pricing matches the route's pinned cost exactly. The first three
 * routes pin zero cost; glm-5.3-flash is the first admitted paid route. */
export const QUALIFIED_ROUTES = Object.freeze([
  Object.freeze({ id: QUALIFIED_ZEN_MODEL_ID, provider: "opencode", model: QUALIFIED_ZEN_MODEL,
    apiURL: "https://opencode.ai/zen/v1", npm: "@ai-sdk/openai", authEnv: "OPENCODE_API_KEY", auth: "api",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  Object.freeze({ id: "opencode/muse-spark-1.2-contributor-free", provider: "opencode", model: "muse-spark-1.2-contributor-free",
    apiURL: "https://opencode.ai/zen/v1", npm: "@ai-sdk/openai", authEnv: "OPENCODE_API_KEY", auth: "api",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  Object.freeze({ id: "openai/gpt-5.6-luna", provider: "openai", model: "gpt-5.6-luna",
    apiURL: "", npm: "@ai-sdk/openai", authEnv: "OPENAI_API_KEY", auth: "oauth",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  Object.freeze({ id: "opencode-go/glm-5.3-flash", provider: "opencode-go", model: "glm-5.3-flash",
    apiURL: "https://opencode.ai/zen/go/v1", npm: "@ai-sdk/openai-compatible", authEnv: "OPENCODE_API_KEY", auth: "api",
    cost: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 } }),
]);
export type QualifiedRoute = (typeof QUALIFIED_ROUTES)[number];
export const QUALIFIED_MODEL_IDS: readonly string[] = Object.freeze(QUALIFIED_ROUTES.map(r => r.id));
export function qualifiedRoute(model: string): QualifiedRoute {
  const route = QUALIFIED_ROUTES.find(r => r.id === model);
  if (!route) throw new Error(`Unqualified model route: ${model}; refuses anything except ${QUALIFIED_MODEL_IDS.join(", ")}`);
  return route;
}

export interface CatalogModelEvidence {
  id: string;
  providerID: string;
  name: string;
  status: string;
  api: { id?: string; url?: string; npm?: string };
  cost: {
    input: number;
    output: number;
    cache: { read: number; write: number };
    tiers?: unknown[];
  };
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
  catalogCommand: string;
  catalogAttempts: CatalogQualificationAttempt[];
  catalogOutputSha256: string;
  exactModel: string;
  catalogEntry: CatalogModelEvidence;
  pricingProven: true;
  noInference: true;
}

function extractJsonObject(text: string, start: number): string {
  let depth = 0,
    quoted = false,
    escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return text.slice(start, index + 1);
  }
  throw new Error("OpenCode verbose catalog contains an incomplete JSON entry");
}

export function parseQualifiedCatalogEntry(
  output: string,
  model: string = QUALIFIED_ZEN_MODEL_ID,
): CatalogModelEvidence {
  const route = qualifiedRoute(model);
  const normalized = output.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const matches = lines.flatMap((line, index) => line === route.id ? [index] : []);
  if (matches.length !== 1)
    throw new Error(`Exact model ${route.id} is absent or duplicated in the refreshed OpenCode catalog`);
  const metadata = lines.slice(matches[0]! + 1).join("\n").trimStart();
  if (!metadata.startsWith("{"))
    throw new Error("Exact model catalog entry has no verbose metadata");
  const parsed = JSON.parse(
    extractJsonObject(metadata, 0),
  ) as CatalogModelEvidence;
  if (
    parsed.id !== route.model ||
    parsed.providerID !== route.provider
  )
    throw new Error(
      "Exact model catalog identity does not match the requested ID",
    );
  return parsed;
}

export function assertCatalogEntry(
  entry: CatalogModelEvidence, model: string = QUALIFIED_ZEN_MODEL_ID,
): void {
  const route = qualifiedRoute(model);
  if (entry?.id !== route.model || entry.providerID !== route.provider || entry.api?.id !== route.model)
    throw new Error("Exact model catalog identity does not match the requested ID");
  for (const key of ["options", "headers"] as const) {
    const value = entry[key];
    if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length))
      throw new Error("Exact model catalog has non-default options or headers");
  }
  if (entry.status !== "active")
    throw new Error("Exact model catalog entry is not active");
  if (route.provider === "opencode" && !entry.name?.toLowerCase().includes("free"))
    throw new Error("Exact model catalog name does not identify a free entry");
  if (
    entry.api?.url !== route.apiURL ||
    entry.api?.npm !== route.npm
  )
    throw new Error(
      "Exact model is not routed through the qualified provider adapter",
    );
  if (entry.capabilities?.toolcall !== true)
    throw new Error(
      "Exact model catalog entry does not prove tool-call support",
    );
  const cost = entry?.cost;
  if (
    !cost ||
    cost.input !== route.cost.input ||
    cost.output !== route.cost.output ||
    cost.cache?.read !== route.cost.cacheRead ||
    cost.cache?.write !== route.cost.cacheWrite ||
    (cost.tiers !== undefined &&
      (!Array.isArray(cost.tiers) || cost.tiers.length !== 0))
  ) {
    throw new Error(
      "Exact model catalog pricing does not match the pinned route cost",
    );
  }
}

async function command(
  argv: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  const child = Bun.spawn(argv, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timer);
  if (exitCode !== 0)
    throw new Error(
      argv.join(" ") +
        " failed with exit " +
        exitCode,
    );
  return { stdout, stderr };
}

/** Official-client runtime/catalog gate. It may refresh three times to expose
 * transient catalog omissions, but performs no inference and accepts only a
 * currently returned exact active zero-price entry. Every attempt is retained. */
export async function qualifyOfficialOpenCode(
  timeoutMs = 30_000,
  model: string = QUALIFIED_ZEN_MODEL_ID,
  runCommand: typeof command = command,
): Promise<OpenCodeQualificationEvidence> {
  const route = qualifiedRoute(model);
  const version = (
    await runCommand(["opencode", "--version"], Math.min(timeoutMs, 5_000))
  ).stdout.trim();
  if (version !== QUALIFIED_OPENCODE_CLIENT_VERSION)
    throw new Error(
      "OpenCode " +
        version +
        " is not qualified; required " +
        QUALIFIED_OPENCODE_CLIENT_VERSION,
    );
  const attempts: CatalogQualificationAttempt[] = [];
  let accepted:
    | { outputSha256: string; entry: CatalogModelEvidence }
    | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const catalog = await runCommand(
        ["opencode", "models", route.provider, "--verbose", "--refresh"],
        timeoutMs,
      );
      const outputSha256 = createHash("sha256")
        .update(catalog.stdout)
        .digest("hex");
      try {
        const entry = parseQualifiedCatalogEntry(catalog.stdout, model);
        assertCatalogEntry(entry, model);
        attempts.push({
          attempt,
          checkedAt: new Date().toISOString(),
          stdoutSha256: outputSha256,
          matched: true,
        });
        accepted = { outputSha256, entry };
        break;
      } catch (error) {
        attempts.push({
          attempt,
          checkedAt: new Date().toISOString(),
          stdoutSha256: outputSha256,
          matched: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } catch (error) {
      attempts.push({
        attempt,
        checkedAt: new Date().toISOString(),
        matched: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (attempt < 3)
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
  }
  if (!accepted)
    throw new Error(
      "Official OpenCode qualification failed after 3 no-inference catalog attempts: " +
        attempts.map((item) => item.error).join(" | "),
    );
  return {
    checkedAt: new Date().toISOString(),
    clientVersion: version,
    versionCommand: "opencode --version",
    catalogCommand: `opencode models ${route.provider} --verbose --refresh`,
    catalogAttempts: attempts,
    catalogOutputSha256: accepted.outputSha256,
    exactModel: model,
    catalogEntry: accepted.entry,
    pricingProven: true,
    noInference: true,
  };
}

/** Durable catalog-only evidence, separate from model transcripts. */
export async function writeQualification(evidence: OpenCodeQualificationEvidence, out?: string) {
  assertCatalogEntry(evidence.catalogEntry, evidence.exactModel);
  const path = out ?? resolve("results/qualifications",
    `${evidence.exactModel.replaceAll("/", "-")}-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ schemaVersion: 1, purpose: "no-call-live-model-qualification",
    exactModel: evidence.exactModel, inferenceCalls: 0, evidence }, null, 2) + "\n", { flag: "wx" });
  return path;
}
