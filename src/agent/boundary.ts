// The fake/live agent boundary. `AgentPort` is the ONLY interface the run
// orchestrator depends on — it never imports the Pi SDK or FakeAgent
// directly. This is what makes offline development and testing possible:
//
//   - agent/fakeAgent.ts   — deterministic, no network, no tokens. Used by
//                            every automated test and available via
//                            `--agent=fake` for dry runs.
//   - agent/piAgent.ts     — wraps the real Pi SDK + an explicit provider/model
//                            (minimax-m3, deepseek-v4-pro, ...). Only
//                            constructed by the CLI when `--agent=pi`
//                            (the default for real benchmark runs). Tests
//                            may use its isolated offline transport.
//
// Re-exported from domain/types.ts to keep the type definitions dependency-
// free while giving this boundary a dedicated, discoverable module.

export type { AgentPort, AgentDecision, DecisionContext } from "../domain/types.ts";
