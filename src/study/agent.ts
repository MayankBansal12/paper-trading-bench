import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { TOKEN_FIELDS, type LiveDecision } from "../core/types.ts";
import { contentHash, textHash } from "../core/hash.ts";
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
import {
  launchSandbox,
  validateSandboxState,
  prepareSandboxRuntime,
  qualifySandbox,
} from "./sandbox.ts";
import { serveGateway } from "./gateway.ts";
import { SessionTools } from "./tools.ts";
import { JournalStore, type Submission, type JournalEntry } from "./journal.ts";
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
  submission?: Submission;
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
      completeness: "complete",
      missingSteps: 0,
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
export async function prepareModelRuntime() {
  const started = Date.now();
  const qualification = await qualifyOfficialOpenCode();
  let apiKey = process.env.OPENCODE_API_KEY;
  if (!apiKey) {
    try {
      const auth = JSON.parse(
        await readFile(
          join(homedir(), ".local/share/opencode/auth.json"),
          "utf8",
        ),
      );
      if (auth.opencode?.type === "api") apiKey = auth.opencode.key;
    } catch {}
  }
  if (!apiKey) {
    try {
      const auth = JSON.parse(
        await readFile(
          join(
            process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent"),
            "auth.json",
          ),
          "utf8",
        ),
      );
      if (
        auth.opencode?.type === "api_key" &&
        typeof auth.opencode.key === "string" &&
        !auth.opencode.key.startsWith("!")
      )
        apiKey = auth.opencode.key;
    } catch {}
  }
  if (!apiKey) throw new Error("OpenCode credential unavailable");
  const bundle = await prepareSandboxRuntime();
  try {
    const sandboxQualification = await qualifySandbox(bundle);
    return {
      qualification,
      apiKey,
      bundle,
      sandboxQualification,
      setupMs: Date.now() - started,
      dispose: bundle.dispose,
    };
  } catch (e) {
    await bundle.dispose();
    throw e;
  }
}
export async function decideStudy(
  view: SessionView,
  journal: JournalStore,
  past: JournalEntry[],
  horizon: SessionHorizon,
  audit: (e: any) => void = () => {},
  runtime: Awaited<ReturnType<typeof prepareModelRuntime>>,
): Promise<StudyAttempt> {
  const started = Date.now(),
    deadline = started + view.limits.timeoutMs;
  const decision = initialStudyDecision(view);
  const tools = new SessionTools(view, journal, past, deadline, (e) => {
    decision.trace.push(e);
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
  try {
    const { qualification, apiKey } = runtime;
    const qualificationEvent = {
      type: "model_qualification",
      evidence: qualification,
    };
    decision.trace.push(qualificationEvent);
    audit(qualificationEvent);
    audit({
      type: "runtime_setup",
      setupMs: runtime.setupMs,
      sandboxQualification: runtime.sandboxQualification,
    });
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
      past,
    );
    const protocol = {
      type: "protocol",
      version: STUDY_PROTOCOL,
      model: QUALIFIED_ZEN_MODEL,
      provider: "opencode",
      viewHash: contentHash(view),
      systemPrompt: decision.effectiveSystemPrompt,
      promptHash: decision.promptHash,
      dailyPrompt: prompt,
      openingPortfolio: openingPortfolio(view),
    };
    decision.trace.push(protocol);
    audit(protocol);
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
      runtime.bundle,
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
    for (const event of decision.trace.filter((e) =>
      ["opencode_event", "opencode_malformed_event"].includes(e.type),
    ))
      audit(event);
    tools.revoke();
    gateway.close();
    const events = decision.trace
      .filter((e: any) => e.type === "opencode_event")
      .map((e: any) => e.event);
    const state = events.filter((e) => e.type === "sandbox_state");
    if (state.length !== 1) throw new Error("Missing/duplicate sandbox state");
    validateSandboxState(state[0].checks, run.evidence);
    const audits = events.filter((e) => e.type === "sandbox_audits");
    if (
      audits.length !== 1 ||
      (audits[0].exitCode !== 0 && audits[0].completedSubmission !== true)
    )
      throw new Error("Missing/failed sandbox client audit");
    for (const [file, data] of Object.entries(audits[0].files)) {
      const event = { type: "client_audit", file, data };
      decision.trace.push(event);
      audit(event);
    }
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
      !tools.submission() ||
      tools.integrityError
    )
      throw new Error(
        parsed.error ??
          tools.integrityError ??
          "Client did not submit a complete decision",
      );
    audit(decision.trace.at(-1));
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
    decision.orders = tools.orders();
    decision.rationale = tools.submission()!.journal.text;
    decision.outcome = "completed";
  } catch (e) {
    decision.terminalReason =
      cutoff ??
      tools.boundedReason ??
      (e instanceof Error ? e.message : "Session failed");
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
  if (decision.outcome !== "completed" && (gateway?.count() ?? 0) > 0) {
    decision.usage.completeness = "unavailable";
    decision.usage.missingSteps = Math.max(1, decision.usage.missingSteps);
    for (const k of TOKEN_FIELDS) decision.usage[k] = null;
    decision.usage.costUsd = null;
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
    submission: tools.submission(),
  };
}
