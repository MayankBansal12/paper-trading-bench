// The full trading-day loop. Orchestrates:
//   1. Opening prompt injection (with portfolio + weekly summary)
//   2. Agentic loop (model calls tools freely until it stops)
//   3. Wrap-up prompt (asks for daily summary markdown)
//   4. Captures the final assistant text as the daily summary
//
// Persistence to disk is the CLI's job (Phase 7). This function returns
// the in-memory artifacts: updated portfolio, daily summary markdown.
//
// IMPORTANT: the tools mutate `ctx.portfolio` in place. We read it back
// from ctx at the end so the caller sees the post-trade state, not the
// pre-trade initial portfolio we passed in.

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { recalculateHoldingsValue } from "../state/valuation.ts";
import { buildOpeningPrompt } from "../prompts/context.ts";
import { buildWrapUpPrompt } from "../prompts/wrapup.ts";
import { buildSystemPrompt } from "./session.ts";
import { shouldTerminate } from "./termination.ts";
import type { PortfolioState } from "../types.ts";
import type { TradingContext } from "../tools/registry.ts";

export interface RunTradingDayResult {
  portfolio: PortfolioState;
  dailySummary: string | null;
  terminated: boolean;
}

export async function runTradingDay(
  session: AgentSession,
  ctx: TradingContext,
  initialPortfolio: PortfolioState,
): Promise<RunTradingDayResult> {
  // Pre-flight: already terminated → exit immediately.
  if (shouldTerminate(initialPortfolio)) {
    return {
      portfolio: { ...initialPortfolio, status: "terminated" },
      dailySummary: null,
      terminated: true,
    };
  }

  // Set the system prompt on the session. (pi's createAgentSession doesn't
  // take one directly when using resourceLoader's getSystemPrompt — we set
  // it here so subsequent prompts see it.)
  session.state.systemPrompt = buildSystemPrompt();

  // Phase A: opening prompt with portfolio + memory.
  const opening = await buildOpeningPrompt(ctx.date, initialPortfolio);
  await session.prompt(opening);

  // Phase B: wrap-up. Tools are closed; ask for the daily summary.
  const wrapUp = buildWrapUpPrompt(ctx.date, ctx.portfolio);
  await session.prompt(wrapUp);

  // The final assistant message should be the daily summary markdown.
  // Some models wrap it in ```markdown ... ``` fences — strip those so the
  // saved file is clean markdown (not markdown-inside-a-code-block).
  const messages = session.state.messages;
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const dailySummary = stripCodeFences(extractText(lastAssistant));

  // Recompute net worth one more time using the (possibly mutated) ctx.portfolio
  // so the saved state is consistent with the last_traded_price cache.
  const finalPortfolio = recalculateHoldingsValue(
    ctx.portfolio,
    (ticker) => ctx.portfolio.holdings[ticker]?.last_traded_price,
  );

  const terminated = shouldTerminate(finalPortfolio);

  return {
    portfolio: terminated ? { ...finalPortfolio, status: "terminated" } : finalPortfolio,
    dailySummary,
    terminated,
  };
}

/** Extract plain text from an assistant message (handles text blocks only). */
function extractText(msg: unknown): string | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as { content?: Array<{ type: string; text?: string }> };
  if (!Array.isArray(m.content)) return null;
  const parts: string[] = [];
  for (const block of m.content) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  const out = parts.join("\n").trim();
  return out.length > 0 ? out : null;
}

/** If the summary is wrapped in a single ```markdown ... ``` fence, strip it. */
function stripCodeFences(s: string | null): string | null {
  if (!s) return s;
  // Match a single fenced block with optional language tag at the start.
  const m = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/.exec(s);
  return m ? (m[1] ?? s).trim() : s;
}
