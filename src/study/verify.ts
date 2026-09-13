import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash } from "../core/hash.ts";
import type { StudyAttempt } from "./agent.ts";
import { JournalStore, type JournalEntry } from "./journal.ts";
import { SessionTools } from "./tools.ts";
import { scopeFor, type SessionView } from "./protocol.ts";

/** Re-execute every broker request against the reconstructed eligible snapshot.
 * No inference and no writes to the experiment. A forged receipt hash alone is
 * insufficient: its payload must equal the independently reconstructed result. */
export function verifyToolEvidence(
  attempt: StudyAttempt,
  view: SessionView,
  past: JournalEntry[],
) {
  const dir = mkdtempSync(join(tmpdir(), "study-replay-"));
  try {
    const journal = new JournalStore(dir);
    for (let n = 1; n < view.scope.attempt; n++) {
      const prior = scopeFor(view.scope.runId, view.scope.date, n);
      journal.begin(prior);
      journal.fail(prior, "prior attempt");
    }
    journal.begin(view.scope);
    const tools = new SessionTools(
      view,
      journal,
      past,
      Number.MAX_SAFE_INTEGER,
    );
    const trace = attempt.decision.trace.filter(
      (e: any) =>
        e.type === "tool_attempt" ||
        e.type === "tool_result" ||
        e.type === "tool_delivery_retry",
    ) as any[];
    for (let i = 0; i < trace.length; ) {
      if (trace[i].type === "tool_delivery_retry") {
        const e = trace[i++];
        if (
          contentHash(tools.call(e.name, e.arguments, e.providerCallId)) !==
          contentHash(e.result)
        )
          throw new Error("Delivery retry differs");
        continue;
      }
      const request = trace[i],
        recorded = trace[i + 1];
      if (!recorded) throw new Error("Incomplete broker trace");
      i += 2;
      if (
        request.type !== "tool_attempt" ||
        recorded.type !== "tool_result" ||
        recorded.name !== request.name
      )
        throw new Error("Broker request/result mismatch");
      const result = tools.call(
        request.name,
        request.arguments,
        request.providerCallId,
      );
      if (contentHash(result) !== contentHash(recorded.result))
        throw new Error("Broker result differs from eligible data or journal");
    }
    if (
      tools.boundedReason ||
      tools.integrityError ||
      !tools.submission() ||
      contentHash(tools.submission()) !== contentHash(attempt.submission) ||
      contentHash(tools.orders()) !== contentHash(attempt.decision.orders) ||
      contentHash(journal.entries(view.scope)) !==
        contentHash(attempt.journalEntries)
    )
      throw new Error("Broker replay differs from accepted orders/journal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
