import { parseFlags } from "../src/cli/args.ts";
import { assertKnownFlags, assertNoPositionals } from "../src/cli/validate.ts";
import { loadDataset } from "../src/data/dataset.ts";
import { resolve } from "node:path";
import { contentHash } from "../src/run/persist.ts";
import { initialStudyDecision } from "../src/study/agent.ts";
import { runStudy, type StudyConfig } from "../src/study/runner.ts";
import { SessionTools } from "../src/study/tools.ts";
import { POLICY, STUDY_PROTOCOL } from "../src/study/protocol.ts";
const { flags, positionals } = parseFlags(process.argv.slice(2));
assertNoPositionals(positionals, "control");
assertKnownFlags(flags, ["data-dir", "start", "end", "run-id"], "control");
if (
  !flags.get("data-dir") ||
  !flags.get("start") ||
  !flags.get("end") ||
  !flags.get("run-id")
)
  throw new Error("Required: --data-dir --start --end --run-id");
const dataDir = resolve(flags.get("data-dir")!);
const market = await loadDataset(dataDir);
const config: StudyConfig = {
  protocol: STUDY_PROTOCOL,
  kind: "control",
  runId: flags.get("run-id")!,
  dataDir,
  datasetHash: market.version,
  universeVersion: "dataset",
  start: flags.get("start")!,
  end: flags.get("end")!,
  history: 100,
  limits: { maxTurns: null, maxToolCalls: 24, timeoutMs: 300000 },
  policy: POLICY,
};
const result = await runStudy(config, {
  control: async (view, journal, past) => {
    const tools = new SessionTools(
      view,
      journal,
      past,
      Date.now() + view.limits.timeoutMs,
    );
    const ticker = view.universe[0]!;
    const observed = tools.call("get_price", { ticker });
    tools.call("get_ohlcv", { ticker, lookback: 20 });
    tools.call("get_portfolio", {});
    tools.call("journal_search", { query: "control" });
    const units = view.portfolio.holdings[ticker]?.units ?? 0;
    if (past.length % 7 === 6 && units > 0)
      tools.call("sell", { ticker, units: units / 2 });
    if (view.portfolio.cash >= 100)
      tools.call("buy", { ticker, notionalUsd: 100 });
    tools.call("journal_append", {
      text: "Deterministic engine control. This mechanical action tests fills, cash flows, journal persistence and replay; it is not a model strategy.",
    decision: {
      thesis: "Mechanical control to validate journal and order replay.",
      evidence: [{ claim: "The eligible prior close is available.", receiptIds: [JSON.parse(observed.content[0].text).receipt.id] }],
      allocation: "Fixed control sizing, remaining funds stay in cash.",
      alternatives: "No strategy optimization; this is an engine control.",
      risks: "Unknown opening fill price and price changes.",
      invalidation: "Stop if eligible data or accounting validation fails.",
      continuity: past.length ? "Continue the same mechanical control." : "First session; no prior thesis.",
    },
    requestId: "final",
      evidenceIds: [JSON.parse(observed.content[0].text).receipt.id],
    });
    const decision = initialStudyDecision(view);
    decision.outcome = "completed";
    decision.rationale = "Deterministic engine control";
    decision.orders = tools.orders();
    decision.submittedOrders = tools.orders();
    decision.trace = tools.trace;
    return {
      outcome: "completed",
      scope: view.scope,
      viewHash: contentHash(view),
      decision,
      journalEntries: journal.entries(view.scope),
    };
  },
});
const replay = await runStudy(config, { readOnly: true });
if (contentHash(result.summary) !== contentHash(replay.summary))
  throw new Error("Control replay differs");
console.log(
  JSON.stringify(
    {
      dir: result.dir,
      status: result.summary.status,
      days: result.summary.committedDays,
      metrics: result.summary.metrics,
      journal: result.summary.journal,
      replay: "identical",
      inferenceCalls: 0,
    },
    null,
    2,
  ),
);
