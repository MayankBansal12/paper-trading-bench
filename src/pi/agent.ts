import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { contentHash, textHash } from "../core/hash.ts";
import { initialStudyDecision, type StudyAttempt } from "../study/agent.ts";
import { SessionTools } from "../study/tools.ts";
import { JournalStore, type JournalEntry } from "../study/journal.ts";
import {
  dailyPrompt,
  openingPortfolio,
  systemPrompt,
  STUDY_PROTOCOL,
  type SessionHorizon,
  type SessionView,
} from "../study/protocol.ts";
import { launchSandbox } from "../study/sandbox.ts";
import { serveGateway } from "../study/gateway.ts";
import { makePiConfig } from "./config.ts";
import { preparePiRuntime } from "./runtime.ts";
import { piUsage } from "./audit.ts";
import { PI_MODEL_ID, PI_MODEL, PI_PROVIDER } from "./route.ts";
export { preparePiRuntime } from "./runtime.ts";
export async function decidePi(
  view: SessionView,
  journal: JournalStore,
  past: JournalEntry[],
  horizon: SessionHorizon,
  audit: (e: any) => void = () => {},
  runtime: Awaited<ReturnType<typeof preparePiRuntime>>,
  forward: typeof fetch = fetch,
): Promise<StudyAttempt> {
  const started = Date.now(),
    deadline = started + view.limits.timeoutMs,
    decision = initialStudyDecision(view);
  const record = (e: any) => {
    decision.trace.push(e);
    audit(e);
  };
  const tools = new SessionTools(view, journal, past, deadline, (e) =>
    decision.trace.push(e),
  );
  let dir: string | undefined,
    gateway: Awaited<ReturnType<typeof serveGateway>> | undefined,
    run: Awaited<ReturnType<typeof launchSandbox>> | undefined,
    cutoff: string | undefined;
  const stop = (reason: string) => {
    cutoff ??= reason;
    tools.revoke();
    gateway?.close();
    void run?.stop();
  };
  const timer = setTimeout(
    () => stop("Hard session timeout"),
    view.limits.timeoutMs,
  );
  try {
    record({ type: "model_qualification", evidence: runtime.qualification });
    record({
      type: "runtime_setup",
      setupMs: runtime.setupMs,
      sandboxQualification: runtime.sandboxQualification,
    });
    dir = await mkdtemp(join(tmpdir(), "study-pi-"));
    gateway = await serveGateway(
      join(dir, "gateway.sock"),
      tools,
      runtime.credential,
      deadline,
      record,
      forward,
      stop,
      PI_MODEL_ID,
    );
    const system = systemPrompt(view.limits),
      prompt = dailyPrompt(
        view,
        horizon.start,
        horizon.end,
        horizon.contributions,
        past,
      );
    decision.effectiveSystemPrompt = system;
    decision.promptHash = textHash(system);
    record({
      type: "protocol",
      version: STUDY_PROTOCOL,
      model: PI_MODEL,
      provider: PI_PROVIDER,
      viewHash: contentHash(view),
      systemPrompt: system,
      promptHash: decision.promptHash,
      dailyPrompt: prompt,
      openingPortfolio: openingPortfolio(view),
    });
    await makePiConfig(
      dir,
      gateway.capability,
      runtime.qualification.model,
      tools.definitions,
      system,
      prompt,
    );
    run = await launchSandbox(
      dir,
      join(dir, "gateway.sock"),
      Math.max(1, deadline - Date.now()),
      runtime.bundle,
    );
    record({ type: "sandbox_evidence", evidence: run.evidence });
    const pump = (async () => {
      let pending = "",
        bytes = 0;
      const decoder = new TextDecoder();
      for await (const chunk of run!.process
        .stdout as ReadableStream<Uint8Array>) {
        bytes += chunk.length;
        if (bytes > 32 * 1024 * 1024) {
          stop("Pi output cap exceeded");
          throw new Error("Pi output cap exceeded");
        }
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop()!;
        for (const line of lines) if (line.trim()) record(JSON.parse(line));
      }
      if (pending.trim()) throw new Error("Truncated Pi worker event");
    })();
    const stderr = (async () => {
      let bytes = 0;
      for await (const chunk of run!.process
        .stderr as ReadableStream<Uint8Array>) {
        bytes += chunk.length;
        if (bytes > 65536) {
          stop("Pi stderr cap exceeded");
          break;
        }
        record({
          type: "client_stderr",
          text: new TextDecoder().decode(chunk),
        });
      }
    })();
    const [code] = await Promise.all([run.process.exited, pump, stderr]);
    if (
      cutoff ||
      tools.boundedReason ||
      tools.integrityError ||
      code !== 0 ||
      !tools.submission()
    )
      throw new Error(
        cutoff ??
          tools.boundedReason ??
          tools.integrityError ??
          "Pi did not submit a complete decision",
      );
    decision.orders = tools.orders();
    decision.rationale = tools.submission()!.journal.text;
    decision.outcome = "completed";
  } catch (e) {
    decision.terminalReason =
      cutoff ?? (e instanceof Error ? e.message : "Pi attempt failed");
    decision.outcome = cutoff ? "budget_cutoff" : "harness_error";
    decision.orders = [];
  } finally {
    clearTimeout(timer);
    tools.revoke();
    gateway?.close();
    await run?.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
  decision.usage = piUsage(decision.trace);
  decision.submittedOrders = tools.orders();
  decision.elapsedMs = Date.now() - started;
  decision.boundedStop = !!cutoff;
  decision.boundedReason = cutoff ?? null;
  record({
    type: "terminal",
    outcome: decision.outcome,
    reason: decision.terminalReason,
  });
  return {
    outcome: decision.outcome,
    reason: decision.terminalReason,
    scope: view.scope,
    viewHash: contentHash(view),
    decision,
    journalEntries: journal.entries(view.scope),
    sandbox: run?.evidence,
    submission: tools.submission(),
  };
}
