import { initialStudyDecision } from "../src/study/agent.ts";
import { textHash } from "../src/core/hash.ts";
/** Adapter parser tests need no dataset or inference. */
export function initialDecision(
  _ctx?: unknown,
  _model?: string,
  _provider?: string,
) {
  const d = initialStudyDecision({
    limits: { maxTurns: null, maxToolCalls: null, timeoutMs: 300000 },
  } as any);
  d.promptHash = textHash(d.effectiveSystemPrompt);
  return d;
}
