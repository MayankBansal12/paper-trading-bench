export const meta = {
  name: "claude-paper-bench-loop",
  description: "Event-driven Claude implementation and Codex review loop for the paper-trading benchmark",
  phases: [
    { title: "Claude implementation", detail: "Claude implements the next bounded correction set" },
    { title: "Independent review", detail: "Codex tests and audits the shared working tree" },
  ],
};

const objective = `
Implement a coherent v0 paper-trading batch benchmark in the shared pr-1 workspace.
The existing Pi SDK implementation is only a baseline. Use Pi SDK with opencode-go models,
initially minimax-m3 and deepseek-v4-pro. Never print or commit .env secrets. Do not make
live paid model calls while developing or testing.

V0 requirements: fixed versioned universe of 50 liquid US large-cap equities; USD 1,000
starting capital; deterministic fractional shares; no web/news tool; strict as-of OHLCV and
technical indicators without look-ahead; explicit execution-price convention; isolated state
per model/seed/run; configurable date batch; resume/idempotency; bounded turns/tool calls/time;
offline fixtures and fake agent boundary; equity curves, return, drawdown, volatility/Sharpe,
turnover/trades/failures/usage; cash and buy-and-hold baselines; JSON and readable comparisons;
pinned reproducible dependencies; strict TypeScript; source files under 300 lines; accurate docs.

Work directly in the existing workspace with auto-approval. Inspect all current changes first.
Implement a bounded coherent slice, run relevant tests/typecheck, and leave changes uncommitted.
Do not merely plan. Your final response must state files changed, validation, remaining work,
and anything the reviewer should examine.
`;

const reviewSchema = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["complete", "needs_work"] },
    summary: { type: "string" },
    feedback: { type: "string" },
    validation: { type: "string" },
  },
  required: ["verdict", "summary", "feedback", "validation"],
  additionalProperties: false,
};

let implementationPrompt = objective;
for (let round = 1; round <= 20; round += 1) {
  phase("Claude implementation");
  let implementation;
  try {
    implementation = await agent(implementationPrompt, {
      provider: "claude-code",
      model: "claude-sonnet-5",
      reasoningLevel: "high",
      title: "Claude benchmark implementation round " + round,
      phase: "Claude implementation",
    });
  } catch (error) {
    return {
      status: "paused",
      stage: "claude",
      round,
      reason: String(error),
    };
  }

  phase("Independent review");
  let review;
  try {
    review = await agent(`
You are the independent orchestrator/tester. Claude just completed implementation round ${round}.
Inspect the entire shared pr-1 working-tree diff and Claude's handoff below. Do not modify source
files. Run proportionate offline tests, typecheck, and CLI dry/help paths. Audit secret safety,
dependency pins, fixed US-50 fairness, fractional accounting, look-ahead semantics, deterministic
run isolation/resume, agent limits, failure behavior, metrics/baselines, docs, and 300-line limits.

Claude handoff:
${implementation}

Return complete only if the requested v0 is genuinely coherent and tests pass. Otherwise provide
one precise, prioritized, self-contained correction brief for Claude's next round.
`, {
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoningLevel: "high",
      outputSchema: reviewSchema,
      title: "Review benchmark implementation round " + round,
      phase: "Independent review",
    });
  } catch (error) {
    return {
      status: "paused",
      stage: "review",
      round,
      reason: String(error),
    };
  }

  if (review.verdict === "complete") {
    return {
      status: "complete",
      round,
      summary: review.summary,
      validation: review.validation,
    };
  }

  implementationPrompt = `${objective}

This is correction round ${round + 1}. The independent reviewer found:

${review.feedback}

Reviewer validation evidence:
${review.validation}

Fix the findings completely, inspect surrounding code for the same defect pattern, and rerun tests.
`;
}

return {
  status: "needs_followup",
  reason: "The workflow reached its 20-round safety cap before independent approval.",
};
