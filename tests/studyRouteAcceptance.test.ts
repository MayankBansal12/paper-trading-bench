import { test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { setup, payload } from "./studyTestSupport.ts";
import { initialStudyDecision, type StudyAttempt } from "../src/study/agent.ts";
import { validateAccepted } from "../src/study/accept.ts";
import { contentHash, textHash } from "../src/core/hash.ts";
import { OPENCODE_PROMPT_SUFFIX } from "../src/opencode/config.ts";
import { QUALIFIED_ROUTES } from "../src/opencode/qualification.ts";
import { catalogFixture } from "./opencodeFixtures.ts";
import { readEvents } from "../src/opencode/events.ts";
import { reconcileClientTools } from "../src/opencode/audit.ts";
import { STUDY_PROTOCOL, STUDY_TOOLS, dailyPrompt, openingPortfolio } from "../src/study/protocol.ts";

for (const route of QUALIFIED_ROUTES) test(`${route.id}: completed decisions and replay bind the configured route`, async () => {
  const s = setup();
  try {
    const args = payload(), callID = "offline-submit";
    expect(s.tools.call("submit_day", args, callID).isError).toBeUndefined();
    const decision = initialStudyDecision(s.view);
    decision.effectiveSystemPrompt += OPENCODE_PROMPT_SUFFIX;
    decision.promptHash = textHash(decision.effectiveSystemPrompt);
    const horizon = s.view.horizon;
    const daily = dailyPrompt(s.view, horizon.start, horizon.end, horizon.contributions, []);
    const protocol = { type: "protocol", version: STUDY_PROTOCOL, model: route.model, provider: route.provider,
      viewHash: contentHash(s.view), openingPortfolio: openingPortfolio(s.view), dailyPrompt: daily };
    decision.trace = [protocol, ...s.tools.trace];
    const priced = route.cost.output > 0;
    const parsed = await readEvents(new Response([
      { type: "step_start" },
      { type: "tool_use", part: { type: "tool", callID, tool: "trading_submit_day", state: { status: "completed", input: args } } },
      { type: "step_finish", part: { reason: "tool-calls", cost: priced ? 0.003 : 0,
        tokens: { input: 1, output: 1, reasoning: 0, total: 2, cache: { read: 0, write: 0 } } } },
    ].map(e => JSON.stringify(e)).join("\n")).body!, decision, null, reason => { throw Error(reason); });
    expect(parsed.error).toBeUndefined();
    expect(reconcileClientTools(decision.trace, decision.usage, null).errors).toEqual([]);
    const runtime = { cliVersion: "1.18.30", versionSource: "caller preflight opencode --version", executable: "/runtime/opencode", versions: { bun: "1.3.14" } };
    const workspace = { directory: "/work", processCwd: "/work" };
    const toolAllowlist = STUDY_TOOLS.map(t => `trading_${t}`);
    const permission = { "*": "deny", ...Object.fromEntries(toolAllowlist.map(t => [t, "allow"])) };
    const prompt = { runtime, workspace, model: route.id, resolvedModel: catalogFixture(route),
      effectiveSystemPrompt: decision.effectiveSystemPrompt, promptHash: decision.promptHash,
      system: [decision.effectiveSystemPrompt], toolAllowlist, sessionID: "offline" };
    const namespaces = Object.fromEntries(["mnt", "pid", "net", "user", "ipc", "uts"].map(n => [n, "sandbox-" + n]));
    const hostNamespaces = Object.fromEntries(Object.keys(namespaces).map(n => [n, "host-" + n]));
    const checks = { namespaces, status: "NoNewPrivs: 1\nSeccomp: 2\nCapEff: 0000", cwd: "/work", scratch: "writable",
      ...Object.fromEntries(["/home/ai/.env", "/home/ai/code/paper-trading-bench/README.md", "/proc/1/root/home/ai", "/etc/shadow", "/var/run/docker.sock", "external", "write:/runtime/worker.ts", "write:/work/benchmark-plugin.mjs"].map(p => [p, "denied"])) };
    decision.trace.push(
      { type: "model_qualification", evidence: { exactModel: route.id, clientVersion: "1.18.30", pricingProven: true,
        noInference: true, catalogCommand: `opencode models ${route.provider} --verbose --refresh`, catalogEntry: catalogFixture(route) } },
      { type: "inference_request", model: route.model, route: "/inference/responses", body: {
        model: route.model, instructions: decision.effectiveSystemPrompt, input: [{ role: "user", content: daily }],
        tools: STUDY_TOOLS.map(t => ({ type: "function", name: `trading_${t}` })),
      } },
      { type: "client_audit", file: "client-config-audit.json", data: {
        runtime, workspace, model: route.id, small_model: route.id, enabled_providers: [route.provider], permission,
        agent: { model: route.id, permission, mode: "primary", prompt: decision.effectiveSystemPrompt },
        mcpNames: ["trading"], plugins: ["file:///work/benchmark-plugin.mjs"],
      } },
      { type: "client_audit", file: "system-prompts.jsonl", data: [structuredClone(prompt)] },
      { type: "client_audit", file: "system-prompt.json", data: structuredClone(prompt) },
      { type: "opencode_event", event: { type: "sandbox_state", checks } },
    );
    decision.outcome = "completed";
    decision.rationale = args.journal.text;
    const attempt: StudyAttempt = { outcome: "completed", decision, scope: s.scope, viewHash: contentHash(s.view),
      journalEntries: s.store.entries(s.scope), submission: s.tools.submission(), sandbox: { hostNamespaces } };
    expect(() => validateAccepted(attempt, s.view, false, [], horizon, route.id)).not.toThrow();
    expect(() => validateAccepted(structuredClone(attempt), s.view, false, [], horizon, route.id)).not.toThrow();
    const other = QUALIFIED_ROUTES.find(r => r.id !== route.id)!;
    expect(() => validateAccepted(structuredClone(attempt), s.view, false, [], horizon, other.id)).toThrow();
    expect(() => validateAccepted(structuredClone(attempt), s.view, false, [], horizon, "unknown/model")).toThrow("Unqualified");
    const denied = structuredClone(attempt);
    denied.decision.trace.push({ type: "gateway_denied", reason: "request-size", detail: { stage: "decompress" } });
    expect(() => validateAccepted(denied, s.view, false, [], horizon, route.id))
      .toThrow("Tool/gateway request rejected: request-size at decompress");
    for (const cost of [...[NaN, Infinity, -1], ...(priced ? [] : [0.01])]) {
      const changed = structuredClone(attempt);
      changed.decision.usage.costUsd = cost;
      expect(() => validateAccepted(changed, s.view, false, [], horizon, route.id)).toThrow("pricing class");
    }
    for (const mutate of [
      (trace: any[]) => { trace.find(e => e.type === "model_qualification").evidence.exactModel = other.id; },
      (trace: any[]) => { trace.find(e => e.type === "model_qualification").evidence.noInference = false; },
      (trace: any[]) => { trace.find(e => e.type === "inference_request").body.model = other.model; },
      (trace: any[]) => { trace.find(e => e.type === "inference_request").route = "/other/responses"; },
      (trace: any[]) => { trace.find(e => e.file === "client-config-audit.json").data.enabled_providers = ["other"]; },
    ]) {
      const changed = structuredClone(attempt); mutate(changed.decision.trace);
      expect(() => validateAccepted(changed, s.view, false, [], horizon, route.id)).toThrow();
    }
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});
