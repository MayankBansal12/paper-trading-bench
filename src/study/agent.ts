import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import type { LiveDecision } from "../agent/trace.ts";
import { contentHash, textHash } from "../run/persist.ts";
import {
  qualifyOfficialOpenCode,
  QUALIFIED_ZEN_MODEL,
  QUALIFIED_ZEN_MODEL_ID,
} from "../opencode/qualification.ts";
import { makeClientConfig } from "../opencode/config.ts";
import { readEvents } from "../opencode/events.ts";
import {
  reconcileClientTools,
  validateClientRuntimeAudits,
} from "../opencode/audit.ts";
import { launchSandbox, validateSandboxState } from "./sandbox.ts";
import { serveGateway } from "./gateway.ts";
import { SessionTools } from "./tools.ts";
import { assertFinalJournal } from "./memo.ts";
import { JournalStore, type JournalEntry } from "./journal.ts";
import {
  STUDY_PROTOCOL,
  STUDY_TOOLS,
  systemPrompt,
  dailyPrompt,
  openingPortfolio,
  type SessionHorizon,
  type SessionView,
} from "./protocol.ts";
export interface StudyAttempt {
  outcome: string;
  reason?: string;
  scope: SessionView["scope"];
  viewHash: string;
  decision: LiveDecision;
  journalEntries: JournalEntry[];
  sandbox?: unknown;
}
export function initialStudyDecision(view: SessionView): LiveDecision {
  return {
    orders: [],
    submittedOrders: [],
    failedOrders: [],
    rationale: "",
    outcome: "harness_error",
    boundedStop: false,
    boundedReason: null,
    terminalReason: undefined,
    elapsedMs: 0,
    trace: [],
    effectiveSystemPrompt: systemPrompt(view.limits),
    promptHash: "",
    usage: {
      turns: 0,
      toolCalls: 0,
      failedToolCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      attemptedToolCalls: 0,
      admittedToolCalls: 0,
      refusedToolCalls: 0,
      successfulToolCalls: 0,
      pendingToolCalls: 0,
    },
  };
}
export async function decideStudy(
  view: SessionView,
  journal: JournalStore,
  past: JournalEntry[],
  horizon: SessionHorizon,
  audit: (e: any) => void = () => {},
): Promise<StudyAttempt> {
  const started = Date.now(),
    deadline = started + view.limits.timeoutMs;
  const decision = initialStudyDecision(view);
  const tools = new SessionTools(view, journal, past, deadline, (e) => {
    decision.trace.push(e);
    audit(e);
  });
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
  const bounded = async <T>(pending: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              stop("Hard session timeout");
              reject(new Error("Hard session timeout"));
            },
            Math.max(0, deadline - Date.now()),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer!);
    }
  };
  try {
    const qualification = await bounded(
      qualifyOfficialOpenCode(Math.min(30000, view.limits.timeoutMs)),
    );
    if (cutoff || Date.now() >= deadline)
      throw new Error("Session expired during qualification");
    decision.trace.push({
      type: "model_qualification",
      evidence: qualification,
    });
    const apiKey =
      process.env.OPENCODE_API_KEY ??
      (await bounded(AuthStorage.create().getApiKey("opencode")));
    if (!apiKey) throw new Error("OpenCode credential unavailable");
    dir = await mkdtemp(join(tmpdir(), "study-runtime-"));
    gateway = await serveGateway(
      join(dir, "gateway.sock"),
      tools,
      apiKey,
      deadline,
      (e) => {
        decision.trace.push(e);
        audit(e);
      },
      fetch,
      stop,
    );
    const setup = await makeClientConfig(
      dir,
      QUALIFIED_ZEN_MODEL_ID,
      systemPrompt(view.limits),
      gateway.mcpURL,
      qualification.clientVersion,
      { toolNames: STUDY_TOOLS, runtimeDir: "/work", baseURL: gateway.baseURL },
    );
    // MCP authorization is scoped to this socket/session, not a provider credential.
    const config = setup.config as any;
    config.mcp.trading.headers = {
      Authorization: `Bearer ${gateway.capability}`,
    };
    decision.effectiveSystemPrompt = setup.effectiveSystemPrompt;
    decision.promptHash = textHash(setup.effectiveSystemPrompt);
    const prompt = dailyPrompt(
      view,
      horizon.start,
      horizon.end,
      horizon.contributions,
      { lastCommittedDate: past.at(-1)?.date ?? null, entries: past.length },
    );
    decision.trace.push({
      type: "protocol",
      version: STUDY_PROTOCOL,
      model: QUALIFIED_ZEN_MODEL,
      provider: "opencode",
      viewHash: contentHash(view),
      systemPrompt: decision.effectiveSystemPrompt,
      promptHash: decision.promptHash,
      dailyPrompt: prompt,
      openingPortfolio: openingPortfolio(view),
    });
    await writeFile(
      join(dir, "launch.json"),
      JSON.stringify({
        model: QUALIFIED_ZEN_MODEL_ID,
        prompt,
        env: {
          ...setup.env,
          PATH: "/runtime",
          LANG: "C.UTF-8",
          OPENCODE_API_KEY: gateway.capability,
          OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        },
      }),
    );
    if (cutoff || Date.now() >= deadline)
      throw new Error("Session expired during setup");
    run = await launchSandbox(
      dir,
      join(dir, "gateway.sock"),
      Math.max(1, deadline - Date.now()),
    );
    if (cutoff) {
      await run.stop();
      throw new Error(cutoff);
    }
    decision.trace.push({ type: "sandbox_evidence", evidence: run.evidence });
    audit({ type: "sandbox_evidence", evidence: run.evidence });
    const parsedPromise = readEvents(
      (run.process.stdout as ReadableStream<Uint8Array>).pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            audit({
              type: "client_stdout",
              base64: Buffer.from(chunk).toString("base64"),
            });
            controller.enqueue(chunk);
          },
        }),
      ),
      decision,
      view.limits.maxTurns,
      stop,
    );
    const stderrPromise = (async () => {
      let bytes = 0;
      for await (const c of run!.process.stderr as ReadableStream<Uint8Array>) {
        bytes += c.length;
        if (bytes > 65536) {
          stop("Stderr exceeded limit");
          break;
        }
        audit({ type: "client_stderr", text: new TextDecoder().decode(c) });
      }
    })();
    const [parsed, code] = await Promise.all([
      parsedPromise,
      run.process.exited,
      stderrPromise,
    ]);
    tools.revoke();
    gateway.close();
    const events = decision.trace
      .filter((e: any) => e.type === "opencode_event")
      .map((e: any) => e.event);
    const state = events.filter((e) => e.type === "sandbox_state");
    if (state.length !== 1) throw new Error("Missing/duplicate sandbox state");
    validateSandboxState(state[0].checks, run.evidence);
    const audits = events.filter((e) => e.type === "sandbox_audits");
    if (audits.length !== 1 || audits[0].exitCode !== 0)
      throw new Error("Missing/failed sandbox client audit");
    for (const [file, data] of Object.entries(audits[0].files))
      decision.trace.push({ type: "client_audit", file, data });
    const reconciled = reconcileClientTools(
      decision.trace,
      decision.usage,
      view.limits.maxToolCalls,
      STUDY_TOOLS,
    );
    if (reconciled.boundedReason) stop(reconciled.boundedReason);
    if (cutoff || tools.boundedReason)
      throw new Error(cutoff ?? tools.boundedReason);
    if (
      code !== 0 ||
      parsed.error ||
      parsed.finalReason !== "stop" ||
      !parsed.rationale.trim()
    )
      throw new Error(parsed.error ?? "Client did not finish normally");
    if (reconciled.errors.length) throw new Error(reconciled.errors.join("; "));
    const errors = validateClientRuntimeAudits(
      decision,
      QUALIFIED_ZEN_MODEL_ID,
      "/work",
      STUDY_TOOLS,
    );
    if (errors.length) throw new Error(errors.join("; "));
    const configAudit = audits[0].files["client-config-audit.json"];
    if (configAudit?.baseURL !== gateway.baseURL)
      throw new Error("Inference gateway configuration drift");
    if (gateway.count() !== decision.usage.turns)
      throw new Error("Inference gateway request count mismatch");
    assertFinalJournal(journal.entries(view.scope), tools.orders());
    decision.orders = tools.orders();
    decision.rationale = parsed.rationale.trim();
    decision.outcome = "completed";
  } catch (e) {
    decision.terminalReason =
      cutoff ?? tools.boundedReason ?? (e instanceof Error ? e.message : "Session failed");
    decision.outcome =
      cutoff || tools.boundedReason ? "budget_cutoff" : "harness_error";
    decision.orders = [];
  } finally {
    clearTimeout(timer);
    tools.revoke();
    gateway?.close();
    await run?.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
  decision.submittedOrders = tools.orders();
  decision.elapsedMs = Date.now() - started;
  decision.boundedStop = decision.outcome === "budget_cutoff";
  decision.boundedReason = decision.boundedStop
    ? (decision.terminalReason ?? "Budget exceeded")
    : null;
  audit({
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
  };
}
