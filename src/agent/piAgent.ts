// Each decision runs in a disposable process. Parent owns the deadline and
// SIGKILLs the entire SDK process; it never awaits SDK abort/dispose/transport.
import { getModel } from "@earendil-works/pi-ai/compat";
import type { AgentPort, DecisionContext } from "../domain/types.ts";
import { initialDecision, type LiveDecision } from "./trace.ts";

export const DEFAULT_MODEL = "mimo-v2.5-free";
export const ZEN_FREE_MODELS = ["mimo-v2.5-free", "deepseek-v4-flash-free", "nemotron-3-ultra-free", "north-mini-code-free"] as const;
export interface PiAgentOptions {
  freeOnly?: boolean;
  /** Offline tests only: module exports configure(session). Runs inside isolation with fetch disabled. */
  offlineTransportModule?: string;
}
export class PiAgent implements AgentPort {
  readonly name: string;
  constructor(private readonly modelId = DEFAULT_MODEL, private readonly provider = "opencode", private readonly options: PiAgentOptions = {}) {
    this.name = `pi:${provider}:${modelId}`;
    const model = getModel(provider as Parameters<typeof getModel>[0], modelId as Parameters<typeof getModel>[1]);
    if (!model) throw new Error(`Unknown model "${modelId}" for provider "${provider}". No fallback is used.`);
    if (options.freeOnly && (provider !== "opencode" || !(ZEN_FREE_MODELS as readonly string[]).includes(modelId)
      || Object.values(model.cost).some((cost) => cost !== 0))) {
      throw new Error(`Free-only mode refuses ${provider}/${modelId}: explicit Zen free allowlist and zero SDK catalog cost are required.`);
    }
  }
  async decide(ctx: DecisionContext): Promise<LiveDecision> {
    if (!this.options.offlineTransportModule) throw new Error("Unsandboxed live adapter retired. Use pnpm study:run.");
    const startedAt = Date.now();
    let latest = initialDecision(ctx, this.modelId, this.provider);
    return new Promise((resolve) => {
      let settled = false;
      let child: ReturnType<typeof Bun.spawn> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (decision: LiveDecision) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child?.kill("SIGKILL");
        decision.elapsedMs = Date.now() - startedAt;
        if (decision.outcome !== "completed" || decision.boundedStop) decision.orders = [];
        decision.trace.push({ type: "terminal", outcome: decision.outcome, reason: decision.terminalReason,
          elapsedMs: decision.elapsedMs, isolation: "subprocess-sigkill",
          usageComplete: decision.outcome === "completed",
          usageConvention: "Usage/cost sums finalized SDK assistant messages; interrupted in-flight usage may be unavailable",
          effectivePromptObserved: decision.trace.some((e: any) => e.type === "model_request") });
        resolve(decision);
      };
      const fail = (outcome: LiveDecision["outcome"], reason: string) => finish({ ...latest, outcome, orders: [],
        terminalReason: reason, boundedStop: outcome === "budget_cutoff", boundedReason: outcome === "budget_cutoff" ? reason : null });
      timer = setTimeout(() => fail("budget_cutoff", `hard timeout (${ctx.limits.timeoutMs}ms)`), Math.max(0, ctx.limits.timeoutMs));
      try {
        child = Bun.spawn([process.execPath, new URL("./piWorker.ts", import.meta.url).pathname], {
          stdin: "ignore", stdout: "ignore", stderr: "ignore",
          ipc(message: { type: string; decision: LiveDecision }) {
            if (settled) return;
            if (message.type === "snapshot") latest = message.decision;
            if (message.type === "result") finish(message.decision);
          },
          onExit(_process, code, signal, error) {
            if (!settled) fail("harness_error", `Isolated SDK process exited before result (${code ?? signal ?? error?.message ?? "unknown"})`);
          },
        });
        child.send({ ctx, modelId: this.modelId, provider: this.provider, options: this.options });
      } catch (error) {
        fail("harness_error", error instanceof Error ? error.message : String(error));
      }
    });
  }
}
