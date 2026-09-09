// Real agent implementation: wires the Pi SDK to an opencode-go model
// (e.g. minimax-m3, deepseek-v4-pro) with the 6 trading tools, via the
// hermetic session builder in agent/piSession.ts (no ambient resource
// discovery, explicit tool allowlist — see that file's boundary test). One
// session is created per day and disposed at the end — daily memory is
// passed in explicitly via DecisionContext.recentDays instead of a
// long-lived session, keeping token usage bounded and each day's state
// fully reproducible from its inputs.
//
// The whole decision — hermetic session setup AND session.prompt() — is
// bounded against a SINGLE deadline derived from ctx.limits.timeoutMs
// (TurnBudget.deadlineAt()), not a fresh full timeout per phase, so a slow
// setup can't let the combined wall-clock time exceed what was advertised.
//
// Error semantics: only a hard timeout or our own budget-triggered abort()
// counts as a "bounded stop" (recorded on the day, run continues). Anything
// else `session.prompt()` throws — bad auth, unknown provider/model,
// unexpected SDK failure — is a real failure and is rethrown so it aborts
// the batch instead of silently being recorded as a normal, successful day.
//
// NOT exercised by automated tests (would require network + paid tokens) —
// see agent/piSession.ts for the hermeticity test and agent/limits.ts /
// tests/limits.test.ts for the budget logic tests rely on instead.

import { getModel } from "@earendil-works/pi-ai/compat";
import { createHermeticAgentSession, type HermeticSessionOptions } from "./piSession.ts";
import { buildDailyPrompt, buildSystemPrompt } from "./prompt.ts";
import { buildTradingTools, type PiWorkingState } from "./tools.ts";
import { TurnBudget, withTimeout, withTimeoutAndLateCleanup } from "./limits.ts";
import type { AgentDecision, AgentPort, DecisionContext } from "../domain/types.ts";

export const DEFAULT_MODEL = "minimax-m3";
const MODEL_PROVIDER = "opencode-go";

function extractText(msg: unknown): string | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as { content?: Array<{ type: string; text?: string }> };
  if (!Array.isArray(m.content)) return null;
  const parts = m.content.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string);
  const out = parts.join("\n").trim();
  return out.length > 0 ? out : null;
}

function stripCodeFences(s: string | null): string {
  if (!s) return "(no rationale provided)";
  const m = /^```(?:\w+)?\s*\n([\s\S]*?)\n```\s*$/.exec(s);
  return (m ? m[1] : s)!.trim();
}

function boundedResult(state: PiWorkingState, rationale: string, reason: string): AgentDecision {
  return {
    orders: state.decidedOrders,
    failedOrders: state.failedOrders,
    rationale,
    usage: state.budget.usage(),
    boundedStop: true,
    boundedReason: reason,
  };
}

export class PiAgent implements AgentPort {
  readonly name: string;
  constructor(private readonly modelId: string = DEFAULT_MODEL) {
    this.name = `pi:${modelId}`;
  }

  async decide(ctx: DecisionContext): Promise<AgentDecision> {
    const startedAt = Date.now();
    const state: PiWorkingState = {
      date: ctx.date,
      universe: ctx.universe,
      bars: ctx.bars,
      indicators: ctx.indicators,
      portfolio: { ...ctx.portfolio },
      decidedOrders: [],
      failedOrders: [],
      budget: new TurnBudget(ctx.limits, startedAt),
    };
    const deadlineAt = state.budget.deadlineAt();
    const remainingMs = () => Math.max(0, deadlineAt - Date.now());
    const timeoutReason = `hard timeout (${ctx.limits.timeoutMs}ms)`;

    // Fail loudly on an unrecognized model instead of silently substituting
    // whatever opencode-go model happens to be first in the registry — a
    // silent substitution would make a run's `config.model` a lie.
    const model = getModel(MODEL_PROVIDER, this.modelId as Parameters<typeof getModel>[1]);
    if (!model) {
      throw new Error(`Unknown model "${this.modelId}" for provider "${MODEL_PROVIDER}". Check the model id — no fallback is used.`);
    }

    // Setup (resource discovery + session construction) is bounded against
    // the SAME deadline as the prompt itself — a slow setup eats into the
    // day's time budget instead of getting a fresh, unbounded allowance.
    if (remainingMs() <= 0) {
      return boundedResult(state, "(time budget exhausted before session setup could start)", `${timeoutReason} exceeded before session setup`);
    }
    let session: Awaited<ReturnType<typeof createHermeticAgentSession>>["session"];
    try {
      const setup = createHermeticAgentSession({
        model: model as HermeticSessionOptions["model"],
        thinkingLevel: "low",
        extensionFactories: [
          (pi) => {
            for (const tool of buildTradingTools(state)) pi.registerTool(tool);
          },
        ],
      });
      // `setup` is never cancelled by the timeout below — if it resolves
      // AFTER we've already returned a bounded result, that session would
      // otherwise never reach the `finally` disposal further down (this
      // function has already returned). withTimeoutAndLateCleanup disposes
      // it in that case instead of leaking it.
      ({ session } = await withTimeoutAndLateCleanup(setup, remainingMs(), timeoutReason, (result) => result.session.dispose()));
    } catch (e) {
      if (e instanceof Error && e.message.startsWith(timeoutReason)) {
        return boundedResult(state, "(session setup exceeded the day's time budget)", e.message);
      }
      throw e;
    }

    let boundedStop = false;
    let boundedReason: string | null = null;

    try {
      session.state.systemPrompt = buildSystemPrompt(ctx.limits);

      const unsub = session.subscribe((ev) => {
        if (ev.type !== "turn_start") return;
        // admitTurn() gates BEFORE counting (mirrors budgetGate in
        // agent/tools.ts for tool calls): a refused (N+1)th turn is never
        // added to usage.turns, so usage.turns can never exceed maxTurns.
        if (!state.budget.admitTurn()) {
          if (!boundedStop) {
            boundedStop = true;
            boundedReason = `max turns (${state.budget.limits.maxTurns}) reached`;
            state.budget.recordRefusal(boundedReason);
            session.abort().catch(() => {});
          }
          return;
        }
        // Deliberately excludes maxToolCalls: reaching the tool-call cap
        // must not abort the session mid-turn — the model is still entitled
        // to finish with its final rationale. Only the next actual tool
        // call attempt is refused, by budgetGate in agent/tools.ts.
        const reason = state.budget.exceededExcludingToolCalls(Date.now());
        if (reason && !boundedStop) {
          boundedStop = true;
          boundedReason = reason;
          session.abort().catch(() => {});
        }
      });

      try {
        const remaining = remainingMs();
        if (remaining <= 0) {
          boundedStop = true;
          boundedReason = `${timeoutReason} exceeded before prompt could start`;
        } else {
          await withTimeout(session.prompt(buildDailyPrompt(ctx)), remaining, timeoutReason);
        }
      } catch (e) {
        if (boundedStop) {
          // Expected: our own budget-triggered abort() caused prompt() to reject.
        } else if (e instanceof Error && e.message.startsWith(timeoutReason)) {
          boundedStop = true;
          boundedReason = e.message;
          await session.abort().catch(() => {});
        } else {
          // A real failure (auth, provider/model, unexpected SDK error) — not
          // a budget/timeout bound. Propagate instead of recording a fake
          // successful day.
          await session.abort().catch(() => {});
          throw e;
        }
      } finally {
        unsub();
      }

      const lastAssistant = [...session.state.messages].reverse().find((m) => m.role === "assistant");
      const rationale = stripCodeFences(extractText(lastAssistant));
      const stats = session.getSessionStats();

      // A refused (N+1)th tool-call attempt (agent/tools.ts's budgetGate) must
      // surface as bounded even when it never aborted the session — reaching
      // maxToolCalls alone lets the model finish its turn and this rationale
      // normally, but the day is still bounded (see TurnBudget.recordRefusal).
      const refusalReason = state.budget.wasRefused();
      const usage = state.budget.usage();
      return {
        orders: state.decidedOrders,
        failedOrders: state.failedOrders,
        rationale,
        usage: { ...usage, promptTokens: stats.tokens.input, completionTokens: stats.tokens.output },
        boundedStop: boundedStop || refusalReason !== null,
        boundedReason: boundedReason ?? refusalReason,
      };
    } finally {
      session.dispose();
    }
  }
}
