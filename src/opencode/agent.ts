import { AGENT_PROTOCOL_VERSION } from "../agent/protocolVersion.ts";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import type { AgentPort, DecisionContext } from "../domain/types.ts";
import { ZEN_FREE_MODELS } from "../agent/piAgent.ts";
import { initialDecision, hashText, type LiveDecision } from "../agent/trace.ts";
import { TurnBudget } from "../agent/limits.ts";
import { buildDailyPrompt } from "../agent/prompt.ts";
import type { PiWorkingState } from "../agent/tools.ts";
import { serveTradingTools } from "./mcp.ts";
import { readEvents } from "./events.ts";
import { reconcileClientTools, validateClientRuntimeAudits } from "./audit.ts";
import { makeClientConfig } from "./config.ts";

/** Uses the official client, as required by Zen's free-model API. No impersonation or paid fallback. */
export class OpenCodeAgent implements AgentPort {
  readonly name: string;
  constructor(private readonly modelId = "mimo-v2.5-free", private readonly provider = "opencode", private readonly options: { freeOnly?: boolean } = {}) {
    this.name = `opencode:${provider}:${modelId}`;
    if (provider !== "opencode") throw new Error("The official-client adapter currently supports provider opencode only.");
    const model = getModel("opencode", modelId as Parameters<typeof getModel>[1]);
    if (!model) throw new Error(`Unknown Zen model ${modelId}; no fallback is used.`);
    if (!(ZEN_FREE_MODELS as readonly string[]).includes(modelId) || Object.values(model.cost).some((n) => n !== 0)) {
      throw new Error(`Free-only mode refuses ${provider}/${modelId}.`);
    }
  }
  async decide(ctx: DecisionContext): Promise<LiveDecision> {
    const startedAt = Date.now();
    const decision = initialDecision(ctx, this.modelId, this.provider);
    const state: PiWorkingState = { ...ctx, decidedOrders: [], failedOrders: [], budget: new TurnBudget(ctx.limits, startedAt), externalAccounting: true };
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let cutoff: string | undefined;
    const stop = (reason: string) => { cutoff ??= reason; child?.kill("SIGKILL"); };

    let dir: string | undefined;
    let mcp: ReturnType<typeof serveTradingTools> | undefined;
    const finalize = (value: LiveDecision): LiveDecision => {
      value.submittedOrders = structuredClone(state.decidedOrders);
      value.failedOrders = structuredClone(state.failedOrders);
      value.elapsedMs = Date.now() - startedAt;
      value.boundedStop = value.outcome === "budget_cutoff";
      value.boundedReason = value.boundedStop ? value.terminalReason ?? "Budget exceeded" : null;
      if (value.outcome !== "completed") value.orders = [];
      value.trace.push({ type: "terminal", outcome: value.outcome, reason: value.terminalReason, elapsedMs: value.elapsedMs });
      return value;
    };
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<LiveDecision>((resolve) => {
      timer = setTimeout(() => {
        stop(`Hard timeout (${ctx.limits.timeoutMs}ms)`);
        mcp?.close();
        resolve(finalize({ ...structuredClone(decision), outcome: "budget_cutoff", terminalReason: cutoff, orders: [] }));
      }, ctx.limits.timeoutMs);
    });
    const operation = async () => {
    try {
      dir = await mkdtemp(join(tmpdir(), "trading-bench-"));
      mcp = serveTradingTools(state, decision, stop);
      const versionProcess = Bun.spawn(["opencode", "--version"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      const versionTimer = setTimeout(() => versionProcess.kill("SIGKILL"), Math.min(5000, ctx.limits.timeoutMs));
      const clientVersion = (await new Response(versionProcess.stdout).text()).trim();
      const versionExit = await versionProcess.exited;
      clearTimeout(versionTimer);
      if (versionExit !== 0 || !/^\d+\.\d+\.\d+$/.test(clientVersion)) throw new Error("Cannot determine official OpenCode client version");
      if (clientVersion !== "1.18.29") throw new Error(`OpenCode ${clientVersion} is not qualified; this adapter requires 1.18.29.`);
      const setup = await makeClientConfig(dir, `${this.provider}/${this.modelId}`, decision.effectiveSystemPrompt, mcp.url, clientVersion);
      decision.effectiveSystemPrompt = setup.effectiveSystemPrompt;
      decision.promptHash = hashText(setup.effectiveSystemPrompt);
      decision.trace = [{ type: "protocol", version: AGENT_PROTOCOL_VERSION, adapter: "official-opencode-client", provider: this.provider, model: this.modelId,
        systemPrompt: decision.effectiveSystemPrompt, promptHash: decision.promptHash,
        dailyPrompt: buildDailyPrompt(ctx), contextHash: hashText(JSON.stringify(ctx)), config: setup.config }];
      const apiKey = process.env.OPENCODE_API_KEY ?? await AuthStorage.create().getApiKey("opencode");
      if (!apiKey) throw new Error("No OpenCode Zen credential is configured.");
      if (cutoff) throw new Error(cutoff);
      child = Bun.spawn(["opencode", "run", "--format", "json", "--agent", "bench", "-m", `${this.provider}/${this.modelId}`,
        "--dir", dir, "--title", "trading-benchmark", buildDailyPrompt(ctx)], {
        cwd: dir, env: { ...process.env, ...setup.env, PWD: dir, INIT_CWD: dir, OPENCODE_API_KEY: apiKey, OPENCODE_CONFIG_CONTENT: JSON.stringify(setup.config) },
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const events = readEvents(child.stdout as ReadableStream<Uint8Array>, decision, ctx.limits.maxTurns, stop).catch((error) => {
        child?.kill("SIGKILL");
        throw error;
      });
      const [exitCode, parsed, stderr] = await Promise.all([child.exited, events, new Response(child.stderr as ReadableStream<Uint8Array>).text()]);
      for (const file of ["system-prompt.json", "system-prompts.jsonl", "client-config-audit.json", "tool-definitions.jsonl", "tool-attempts.jsonl", "tool-parts.jsonl"]) {
        try {
          const data = await readFile(join(dir, file), "utf8");
          let parsed: unknown;
          try { parsed = file.endsWith("jsonl") ? data.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : JSON.parse(data); }
          catch { parsed = { incomplete: true, raw: data }; }
          decision.trace.push({ type: "client_audit", file, data: parsed });
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      const toolAudit = reconcileClientTools(decision.trace, decision.usage, ctx.limits.maxToolCalls);
      for (const attempt of toolAudit.attempts) {
        if (attempt.failed && !attempt.reachedMcp && ["trading_buy", "trading_sell"].includes(attempt.name)) {
          const args = attempt.arguments as { ticker?: unknown } | undefined;
          state.failedOrders.push({ date: ctx.date, side: attempt.name === "trading_buy" ? "BUY" : "SELL",
            ticker: typeof args?.ticker === "string" ? args.ticker : "(invalid)", reason: "Client rejected trade arguments before execution" });
        }
      }
      if (toolAudit.boundedReason) stop(toolAudit.boundedReason);
      if (cutoff) throw new Error(cutoff);
      if (toolAudit.errors.length) throw new Error(toolAudit.errors.join("; "));
      if (exitCode !== 0 || parsed.error || parsed.finalReason !== "stop" || !parsed.rationale.trim()) {
        decision.outcome = "provider_error";
        decision.terminalReason = parsed.error ?? `Client exited ${exitCode}; finish=${parsed.finalReason ?? "missing"}; ${stderr.slice(0, 1500)}`;
      } else if (this.options.freeOnly !== false && decision.usage.costUsd !== 0) {
        decision.outcome = "harness_error";
        decision.terminalReason = "Free-only client reported nonzero cost; run stopped.";
      } else {
        const runtimeErrors = validateClientRuntimeAudits(decision, `${this.provider}/${this.modelId}`, dir);
        if (runtimeErrors.length) throw new Error(runtimeErrors.join("; "));
        decision.outcome = "completed";
        decision.rationale = parsed.rationale.trim();
        decision.orders = state.decidedOrders;
      }
    } catch (error) {
      decision.outcome = cutoff ? "budget_cutoff" : "harness_error";
      decision.terminalReason = cutoff ?? (error instanceof Error ? error.message : String(error));
    } finally {
      child?.kill("SIGKILL");
      mcp?.close();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
    clearTimeout(timer!);
    return finalize(decision);
    };
    return Promise.race([operation(), deadline]);
  }
}
