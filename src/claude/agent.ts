import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { contentHash, textHash } from "../core/hash.ts";
import { initialStudyDecision, type StudyAttempt } from "../study/agent.ts";
import { SessionTools } from "../study/tools.ts";
import type { JournalStore, JournalEntry } from "../study/journal.ts";
import { dailyPrompt, openingPortfolio, systemPrompt, STUDY_PROTOCOL, type SessionHorizon, type SessionView } from "../study/protocol.ts";
import { serveClaudeGateway } from "./gateway.ts";
import { claudeCredential } from "./credential.ts";
import { claudeUsage } from "./audit.ts";
import { prepareClaudeBundle, qualifyClaudeSandbox, launchClaudeSandbox, forbiddenPaths, claudeBinaryPath } from "./sandbox.ts";
import { CLAUDE_MODEL_ID, CLAUDE_PROVIDER, CLAUDE_EFFORT, CLAUDE_MCP_PREFIX, claudeRoute, claudeClientVersion } from "./route.ts";
import { STUDY_TOOLS } from "../study/protocol.ts";

export async function prepareClaudeRuntime(modelId = CLAUDE_MODEL_ID) {
  claudeRoute(modelId);
  const clientVersion = claudeClientVersion(modelId);
  await claudeCredential().authorize(AbortSignal.timeout(5000));
  const started = Date.now();
  const bundle = await prepareClaudeBundle(clientVersion);
  try {
    const sandboxQualification = await qualifyClaudeSandbox(bundle);
    return {
      bundle,
      sandboxQualification,
      setupMs: Date.now() - started,
      qualification: {
        exactModel: modelId,
        clientVersion,
        clientHash: bundle.evidence.claudeHash,
        noInference: true,
        effort: CLAUDE_EFFORT,
        auth: "host-claude-subscription-oauth",
        subscriptionCost: "unavailable",
        clientBinary: claudeBinaryPath(clientVersion),
      },
      credential: claudeCredential(),
      dispose: bundle.dispose,
    };
  } catch (e) {
    await bundle.dispose();
    throw e;
  }
}
export async function decideClaude(
  view: SessionView,
  journal: JournalStore,
  past: JournalEntry[],
  horizon: SessionHorizon,
  audit: (e: any) => void = () => {},
  runtime: Awaited<ReturnType<typeof prepareClaudeRuntime>>,
  forward: typeof fetch = fetch,
): Promise<StudyAttempt> {
  const model = claudeRoute(runtime.qualification.exactModel).model;
  const started = Date.now(),
    deadline = started + view.limits.timeoutMs,
    decision = initialStudyDecision(view);
  const record = (e: any) => {
    decision.trace.push(e);
    audit(e);
  };
  const tools = new SessionTools(view, journal, past, deadline, (e) => decision.trace.push(e));
  let dir: string | undefined,
    gateway: Awaited<ReturnType<typeof serveClaudeGateway>> | undefined,
    run: Awaited<ReturnType<typeof launchClaudeSandbox>> | undefined,
    cutoff: string | undefined;
  const stop = (reason: string) => {
    cutoff ??= reason;
    tools.revoke();
    gateway?.close();
    void run?.stop();
  };
  const timer = setTimeout(() => stop("Hard session timeout"), view.limits.timeoutMs);
  try {
    record({ type: "model_qualification", evidence: runtime.qualification });
    record({ type: "runtime_setup", setupMs: runtime.setupMs, sandboxQualification: runtime.sandboxQualification });
    dir = await mkdtemp(join(tmpdir(), "study-claude-"));
    const system = systemPrompt(view.limits),
      prompt = dailyPrompt(view, horizon.start, horizon.end, horizon.contributions, past);
    gateway = await serveClaudeGateway({
      socket: join(dir, "gateway.sock"), tools, credential: runtime.credential, deadline,
      audit: record, forward, onBudgetCutoff: stop, dailyPrompt: prompt, model,
    });
    decision.effectiveSystemPrompt = system;
    decision.promptHash = textHash(system);
    record({
      type: "protocol", version: STUDY_PROTOCOL, model, provider: CLAUDE_PROVIDER,
      viewHash: contentHash(view), systemPrompt: system, promptHash: decision.promptHash,
      dailyPrompt: prompt, openingPortfolio: openingPortfolio(view),
    });
    await writeFile(
      join(dir, "launch.json"),
      JSON.stringify({
        capability: gateway.capability, prompt, system, model, effort: CLAUDE_EFFORT,
        allowedTools: STUDY_TOOLS.map((n) => CLAUDE_MCP_PREFIX + n), forbiddenPaths: forbiddenPaths(),
      }),
    );
    run = await launchClaudeSandbox(dir, join(dir, "gateway.sock"), Math.max(1, deadline - Date.now()), runtime.bundle);
    record({ type: "sandbox_evidence", evidence: run.evidence });
    const pump = (async () => {
      let pending = "", bytes = 0;
      const decoder = new TextDecoder();
      for await (const chunk of run!.process.stdout as ReadableStream<Uint8Array>) {
        bytes += chunk.length;
        if (bytes > 32 * 1024 * 1024) {
          stop("Claude output cap exceeded");
          throw new Error("Claude output cap exceeded");
        }
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop()!;
        for (const line of lines) if (line.trim()) record(JSON.parse(line));
      }
      if (pending.trim()) throw new Error("Truncated Claude worker event");
    })();
    const stderr = (async () => {
      let bytes = 0;
      for await (const chunk of run!.process.stderr as ReadableStream<Uint8Array>) {
        bytes += chunk.length;
        if (bytes > 65536) {
          stop("Claude stderr cap exceeded");
          break;
        }
        record({ type: "client_stderr", text: new TextDecoder().decode(chunk) });
      }
    })();
    const [code] = await Promise.all([run.process.exited, pump, stderr]);
    if (cutoff || tools.boundedReason || tools.integrityError || code !== 0 || !tools.submission())
      throw new Error(cutoff ?? tools.boundedReason ?? tools.integrityError ?? "Claude Code did not submit a complete decision");
    decision.orders = tools.orders();
    decision.rationale = tools.submission()!.journal.text;
    decision.outcome = "completed";
  } catch (e) {
    decision.terminalReason = cutoff ?? (e instanceof Error ? e.message : "Claude attempt failed");
    decision.outcome = cutoff ? "budget_cutoff" : "harness_error";
    decision.orders = [];
  } finally {
    clearTimeout(timer);
    tools.revoke();
    gateway?.close();
    await run?.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
  decision.usage = claudeUsage(decision.trace);
  decision.submittedOrders = tools.orders();
  decision.elapsedMs = Date.now() - started;
  decision.boundedStop = !!cutoff;
  decision.boundedReason = cutoff ?? null;
  record({ type: "terminal", outcome: decision.outcome, reason: decision.terminalReason });
  return {
    outcome: decision.outcome, reason: decision.terminalReason, scope: view.scope, viewHash: contentHash(view),
    decision, journalEntries: journal.entries(view.scope), sandbox: run?.evidence, submission: tools.submission(),
  };
}
