import type { AgentPort, DecisionContext } from "../domain/types.ts";
import type { LiveDecision } from "../agent/trace.ts";
import { QUALIFIED_ZEN_MODEL, QUALIFIED_ZEN_PROVIDER } from "./qualification.ts";

/** Historical adapter identity retained for callers; live v7 has been retired. */
export class OpenCodeAgent implements AgentPort {
  readonly name: string;
  constructor(modelId = QUALIFIED_ZEN_MODEL, provider = QUALIFIED_ZEN_PROVIDER, options: { freeOnly?: boolean } = {}) {
    this.name = `opencode:${provider}:${modelId}`;
    if (provider !== QUALIFIED_ZEN_PROVIDER || modelId !== QUALIFIED_ZEN_MODEL || options.freeOnly === false) throw new Error("Only the exact zero-cost Muse model is qualified; no fallback is used.");
  }
  async decide(_ctx: DecisionContext): Promise<LiveDecision> {
    throw new Error("Unsandboxed live adapter retired. Use pnpm study:run for the v8 sandbox; historical artifacts remain available for offline replay.");
  }
}
