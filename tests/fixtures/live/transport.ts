import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { DecisionContext } from "../../../src/domain/types.ts";

// A real SDK session and agent loop, replacing only provider transport. No network.
export async function configure(session: AgentSession, ctx: DecisionContext) {
  const scenario = ctx.universe[1];
  if (scenario === "exit") process.exit(7);
  let calls = 0;
  session.agent.streamFn = (async (model: any, context: any) => {
    calls++;
    const usage = scenario === "cache"
      ? { input: 100, output: 20, cacheRead: 900, cacheWrite: 50, totalTokens: 1070,
          cost: { input: .01, output: .02, cacheRead: .003, cacheWrite: .004, total: .037 } }
      : { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    if (scenario === "throw") throw new Error("offline provider failure");
    if (scenario === "stream-hang") return { result: () => new Promise(() => {}), async *[Symbol.asyncIterator]() {
      yield { type: "start", partial: { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [], stopReason: "stop", usage, timestamp: Date.now() } };
      yield { type: "text_delta", contentIndex: 0, delta: "Partial rationale", partial: {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [{ type: "text", text: "Partial rationale" }], stopReason: "stop", usage, timestamp: Date.now() } };
      await new Promise(() => {});
    } };
    if (scenario === "hang" || (scenario === "partial-hang" && calls > 1)) await new Promise(() => {});
    if (scenario === "cpu-hang") while (true) { /* requires process kill, no cooperative event loop */ }
    let content: any[] = [{ type: "text", text: "Hold based on technical evidence." }];
    let stopReason = "stop";
    if (scenario === "error" || scenario === "aborted" || (scenario === "partial-error" && calls > 1)) stopReason = scenario === "aborted" ? "aborted" : "error";
    if (["partial-hang", "partial-error", "buy"].includes(scenario!) && calls === 1) {
      content = [{ type: "toolCall", id: "buy-1", name: "buy", arguments: { ticker: "AAPL", notionalUsd: 100 } }]; stopReason = "toolUse";
    }
    if (scenario === "invalid" && calls === 1) {
      content = [{ type: "toolCall", id: "unknown", name: "does_not_exist", arguments: {} },
        { type: "toolCall", id: "bad-buy", name: "buy", arguments: { notionalUsd: 10 } }]; stopReason = "toolUse";
    }
    if (scenario === "over-cap" && calls === 1) {
      content = [{ type: "toolCall", id: "unknown", name: "does_not_exist", arguments: {} },
        { type: "toolCall", id: "buy-2", name: "buy", arguments: { ticker: "AAPL", notionalUsd: 100 } }]; stopReason = "toolUse";
    }
    if (scenario === "semantic" && calls === 1) {
      content = [{ type: "toolCall", id: "bad-size", name: "buy", arguments: { ticker: "AAPL", units: -1 } }]; stopReason = "toolUse";
    }
    if (scenario === "length") stopReason = "length";
    if (scenario === "empty") content = [];
    const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content, stopReason, timestamp: Date.now(), usage, errorMessage: stopReason === "error" ? "offline provider terminal error" : undefined };
    return { result: async () => message, async *[Symbol.asyncIterator]() {
      yield { type: stopReason === "error" || stopReason === "aborted" ? "error" : "done", reason: stopReason, message };
    } };
  }) as typeof session.agent.streamFn;
}
