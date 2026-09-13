import { hashText, type LiveUsage } from "../agent/trace.ts";
import { QUALIFIED_OPENCODE_CLIENT_VERSION, QUALIFIED_ZEN_MODEL_ID } from "./qualification.ts";
import { TRADING_TOOL_NAMES } from "../agent/tools.ts";

type ToolPart = { type: "tool"; callID: string; tool: string; state: { status: string; input?: unknown; output?: unknown; error?: unknown } };
type McpAttempt = { name: string; args: unknown; result?: unknown; refused?: boolean; matched?: boolean };
export interface ClientToolAudit {
  errors: string[];
  boundedReason?: string;
  attempts: Array<{ callID: string; name: string; arguments: unknown; status: string; failed: boolean; reachedMcp: boolean }>;
}
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

/** Reconcile official SDK tool parts with independent MCP execution evidence.
 * SDK callID is the attempt identity; repeated pending/running/final updates
 * count once. MCP RPC ids are a separate namespace, so match name+arguments
 * with multiplicity. Counters are replaced, never added to the provisional
 * event/MCP counters. Caller must fail the day when errors or boundedReason exist.
 */
export function reconcileClientTools(trace: unknown[], usage: LiveUsage, maxToolCalls: number, toolNames: readonly string[] = TRADING_TOOL_NAMES): ClientToolAudit {
  const errors: string[] = [];
  const latest = new Map<string, ToolPart>();
  const mcp: McpAttempt[] = [];
  const allowed = new Set<string>(toolNames.map((name) => `trading_${name}`));
  const terminal = (part: ToolPart) => ["completed", "error"].includes(part.state.status);
  const ingest = (raw: unknown) => {
    if (!object(raw) || raw.type !== "tool") return;
    if (typeof raw.callID !== "string" || !raw.callID || typeof raw.tool !== "string" || !object(raw.state)
      || !["pending", "running", "completed", "error"].includes(raw.state.status)) {
      errors.push("Malformed SDK tool-part audit"); return;
    }
    const part = raw as ToolPart;
    const old = latest.get(part.callID);
    if (old && old.tool !== part.tool && old.tool !== "invalid" && part.tool !== "invalid") errors.push(`SDK callID changed tool: ${part.callID}`);
    if (old && terminal(old) && terminal(part) && (old.state.status !== part.state.status || canonical(old.state.input) !== canonical(part.state.input))) {
      errors.push(`Conflicting terminal SDK tool parts: ${part.callID}`);
    }
    // File audits are read after stdout; their older intermediate snapshots
    // must not overwrite the terminal record already seen on stdout.
    if (!old || !terminal(old) || terminal(part)) latest.set(part.callID, part);
  };
  for (const entry of trace) {
    if (!object(entry)) continue;
    if (entry.type === "opencode_event" && object(entry.event) && entry.event.type === "tool_use") ingest(entry.event.part);
    if (entry.type === "client_audit" && entry.file === "tool-parts.jsonl") {
      if (!Array.isArray(entry.data)) errors.push("Missing parsed SDK tool-parts audit");
      else for (const part of entry.data) ingest(part);
    }
    if (entry.type === "tool_attempt") mcp.push({ name: String(entry.name), args: entry.arguments ?? {} });
    if (entry.type === "tool_result" || entry.type === "tool_refused") {
      const attempt = mcp.find((item) => item.name === entry.name && item.result === undefined && !item.refused);
      if (!attempt) errors.push(`MCP result without attempt: ${String(entry.name)}`);
      else if (entry.type === "tool_refused") attempt.refused = true;
      else attempt.result = entry.result;
    }
  }
  const attempts: ClientToolAudit["attempts"] = [];
  let successful = 0, failed = 0, pending = 0;
  for (const part of latest.values()) {
    const isAllowed = allowed.has(part.tool as `trading_${typeof TRADING_TOOL_NAMES[number]}`);
    const matching = isAllowed ? mcp.find((item) => !item.matched && `trading_${item.name}` === part.tool && canonical(item.args) === canonical(part.state.input ?? {})) : undefined;
    if (matching) matching.matched = true;
    if (!isAllowed) errors.push(`Unexpected non-trading SDK tool: ${part.tool}`);
    const unfinished = !terminal(part) || (!!matching && matching.result === undefined && !matching.refused);
    const resultError = !!matching && object(matching.result) && matching.result.isError === true;
    const didFail = !isAllowed || part.state.status === "error" || !!matching?.refused || resultError;
    if (unfinished) { pending++; errors.push(`Unfinished SDK/MCP tool attempt: ${part.callID}`); }
    else if (didFail) failed++;
    else if (matching) successful++;
    else errors.push(`Completed SDK trading call has no MCP execution evidence: ${part.callID}`);
    attempts.push({ callID: part.callID, name: part.tool, arguments: part.state.input,
      status: part.state.status, failed: didFail, reachedMcp: !!matching });
  }
  for (const [index, item] of mcp.entries()) if (!item.matched) {
    errors.push(`MCP call has no matching SDK attempt: ${item.name}`);
    // Preserve observed MCP-only attempts in failed artifacts instead of
    // resetting their usage to zero. Synthetic IDs are explicitly labeled;
    // such artifacts remain ineligible because reconciliation failed.
    const unfinished = item.result === undefined && !item.refused;
    const didFail = !!item.refused || (object(item.result) && item.result.isError === true);
    if (unfinished) pending++;
    else if (didFail) failed++;
    else successful++;
    attempts.push({ callID: `unmatched-mcp:${index}`, name: `trading_${item.name}`, arguments: item.args,
      status: unfinished ? "pending" : didFail ? "error" : "completed", failed: didFail, reachedMcp: true });
  }
  const total = attempts.length;
  usage.toolCalls = total;
  usage.attemptedToolCalls = total;
  usage.refusedToolCalls = Math.max(0, total - maxToolCalls, mcp.filter((item) => item.refused).length);
  usage.admittedToolCalls = total - usage.refusedToolCalls;
  usage.successfulToolCalls = successful;
  usage.failedToolCalls = failed;
  usage.pendingToolCalls = pending;
  const boundedReason = total > maxToolCalls ? `Max attempted tool calls (${maxToolCalls}) exceeded: ${total}` : undefined;
  const result = { errors: [...new Set(errors)], boundedReason, attempts };
  trace.push({ type: "tool_reconciliation", ...result });
  return result;
}

/** Validate every observed request, not only the final overwritten prompt file.
 * This adapter's hook/config behavior is qualified against official 1.18.30;
 * upgrading the client requires explicitly qualifying a new version.
 */
export function validateClientRuntimeAudits(
  decision: import("../agent/trace.ts").LiveDecision,
  expectedModel: string,
  expectedDir?: string,
  toolNames: readonly string[] = TRADING_TOOL_NAMES,
): string[] {
  const errors: string[] = [];
  if (expectedModel !== QUALIFIED_ZEN_MODEL_ID) errors.push("Expected model is not the exact qualified free Muse Spark model");
  if (hashText(decision.effectiveSystemPrompt) !== decision.promptHash) errors.push("Decision prompt hash is inconsistent");
  const audits = (file: string) => decision.trace.filter((e): e is Record<string, any> => object(e) && e.type === "client_audit" && e.file === file).map((e) => e.data);
  const configs = audits("client-config-audit.json");
  const requestFiles = audits("system-prompts.jsonl");
  const singletons = audits("system-prompt.json");
  const allowed = toolNames.map((name) => `trading_${name}`).sort();
  const exactPermissions = { "*": "deny", ...Object.fromEntries(allowed.map((name) => [name, "allow"])) };
  if (configs.length !== 1 || !object(configs[0])) errors.push("Missing or duplicate runtime config audit");
  if (requestFiles.length !== 1 || !Array.isArray(requestFiles[0]) || requestFiles[0].length === 0) errors.push("Missing complete per-request prompt audit");
  if (singletons.length !== 1 || !object(singletons[0])) errors.push("Missing final observed prompt audit");
  if (decision.usage.costUsd !== 0) errors.push("Free-only decision reported nonzero cost");
  const config = object(configs[0]) ? configs[0] : undefined;
  const directory = expectedDir ?? config?.workspace?.directory;
  if (typeof directory !== "string" || !directory.startsWith("/")) errors.push("Missing isolated runtime directory");
  const runtimeCheck = (record: Record<string, any>) => {
    if (record.runtime?.cliVersion !== QUALIFIED_OPENCODE_CLIENT_VERSION || record.runtime?.versionSource !== "caller preflight opencode --version") errors.push("Unqualified or unobserved official client version");
    if (typeof record.runtime?.versions?.bun !== "string" || typeof record.runtime?.executable !== "string") errors.push("Missing runtime process identity");
    if (!object(record.workspace) || record.workspace.directory !== directory || record.workspace.processCwd !== directory) errors.push("Official client runtime escaped isolated directory");
  };
  if (config) {
    runtimeCheck(config);
    if (config.model !== expectedModel || config.small_model !== expectedModel || config.agent?.model !== expectedModel) errors.push("Runtime main/small/agent model drift");
    if (canonical(config.permission) !== canonical(exactPermissions) || canonical(config.agent?.permission) !== canonical(exactPermissions)) errors.push("Runtime tool permissions differ from exact six-tool allowlist");
    if (config.agent?.mode !== "primary" || config.agent?.prompt !== decision.effectiveSystemPrompt) errors.push("Runtime trading agent prompt/mode drift");
    if (canonical(config.mcpNames) !== canonical(["trading"])) errors.push("Unexpected runtime MCP server");
    const expectedPlugin = typeof directory === "string" ? new URL(`file://${directory}/benchmark-plugin.mjs`).href : "";
    if (!Array.isArray(config.plugins) || canonical(config.plugins) !== canonical([expectedPlugin])) errors.push("Unexpected runtime plugin configuration");
  }
  const requests = Array.isArray(requestFiles[0]) ? requestFiles[0] : [];
  const stepStarts = decision.trace.filter((entry) => object(entry) && entry.type === "opencode_event" && entry.event?.type === "step_start").length;
  const stepFinishes = decision.trace.filter((entry) => object(entry) && entry.type === "opencode_event" && entry.event?.type === "step_finish").length;
  if (requests.length !== decision.usage.turns || requests.length !== stepStarts || stepStarts !== stepFinishes) errors.push("Request audit count differs from fully metered client steps");
  const session = requests[0]?.sessionID;
  for (const record of [...requests, ...singletons]) {
    if (!object(record)) { errors.push("Malformed request prompt audit"); continue; }
    runtimeCheck(record);
    if (record.model !== expectedModel || record.resolvedModel?.providerID + "/" + record.resolvedModel?.id !== expectedModel) errors.push("Observed request model drift");
    const cost = record.resolvedModel?.cost;
    if (!object(cost) || cost.input !== 0 || cost.output !== 0 || cost.cache?.read !== 0 || cost.cache?.write !== 0 || (cost.tiers?.length ?? 0) !== 0) errors.push("Observed model has unverified/nonzero pricing");
    if (record.effectiveSystemPrompt !== decision.effectiveSystemPrompt || record.promptHash !== decision.promptHash
      || canonical(record.system) !== canonical([decision.effectiveSystemPrompt])) errors.push("Observed request prompt drift");
    if (!Array.isArray(record.toolAllowlist) || canonical([...record.toolAllowlist].sort()) !== canonical(allowed)) errors.push("Observed request tool allowlist drift");
    if (typeof session !== "string" || record.sessionID !== session) errors.push("Unexpected request session identity");
  }
  if (requests.length && object(singletons[0]) && canonical(singletons[0]) !== canonical(requests.at(-1))) errors.push("Final prompt audit does not match last request");
  return [...new Set(errors)];
}
