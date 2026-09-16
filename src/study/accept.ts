import { PI_MODEL_ID } from "../pi/route.ts";
import { validatePiAccepted } from "../pi/audit.ts";
import { studyRoute } from "./routes.ts";
import { contentHash } from "../core/hash.ts";
import { validateUsage } from "../core/types.ts";
import type { StudyAttempt } from "./agent.ts";
import type { JournalEntry } from "./journal.ts";
import {
  STUDY_TOOLS,
  STUDY_PROTOCOL,
  dailyPrompt,
  openingPortfolio,
  systemPrompt,
  type SessionView,
  type SessionHorizon,
} from "./protocol.ts";
import {
  QUALIFIED_ZEN_MODEL_ID,
  qualifiedRoute,
  QUALIFIED_OPENCODE_CLIENT_VERSION,
  assertCatalogEntry,
} from "../opencode/qualification.ts";
import { OPENCODE_PROMPT_SUFFIX } from "../opencode/config.ts";
import {
  reconcileClientTools,
  validateClientRuntimeAudits,
} from "../opencode/audit.ts";
import { validateSandboxState } from "./sandbox.ts";
import { assertProviderContext } from "../opencode/context.ts";
import { verifyClientTelemetry } from "../opencode/events.ts";
import { verifyToolEvidence } from "./verify.ts";
/** Bind the preloaded state and complete opening prompt to reconstructed data. */
export function validateOpeningContext(
  a: StudyAttempt,
  view: SessionView,
  past: JournalEntry[],
  horizon: SessionHorizon,
) {
  const protocols = a.decision.trace.filter(
    (e: any) => e.type === "protocol",
  ) as any[];
  const protocol = protocols[0];
  const expected = dailyPrompt(
    view,
    horizon.start,
    horizon.end,
    horizon.contributions,
    past,
  );
  if (
    protocols.length !== 1 ||
    protocol.version !== STUDY_PROTOCOL ||
    protocol.viewHash !== contentHash(view) ||
    protocol.dailyPrompt !== expected ||
    contentHash(protocol.openingPortfolio) !==
      contentHash(openingPortfolio(view))
  )
    throw new Error(
      "Opening portfolio or daily prompt differs from eligible session context",
    );
}
export function validateAccepted(
  a: StudyAttempt,
  view: SessionView,
  control = false,
  past: JournalEntry[] = [],
  horizon?: SessionHorizon,
  expectedModel: string = QUALIFIED_ZEN_MODEL_ID,
) {
  if (
    a.outcome !== "completed" ||
    a.decision.outcome !== "completed" ||
    a.decision.boundedStop ||
    a.viewHash !== contentHash(view) ||
    contentHash(a.scope) !== contentHash(view.scope) ||
    !a.journalEntries.length
  )
    throw new Error("Accepted decision is incomplete or mismatched");
  const routeCost = studyRoute(expectedModel).cost;
  const free = routeCost !== null && routeCost.input === 0 && routeCost.output === 0 && routeCost.cacheRead === 0 && routeCost.cacheWrite === 0;
  const costUsd = a.decision.usage.costUsd;
  if (
    !a.decision.rationale.trim() ||
    (costUsd !== null &&
      (!Number.isFinite(costUsd) || costUsd < 0 ||
        (free && costUsd !== 0)))
  )
    throw new Error("Missing rationale or cost outside the route pricing class");
  validateUsage(a.decision.usage);
  if (
    a.journalEntries.length !== 1 ||
    a.decision.rationale !== a.journalEntries[0]!.text
  )
    throw new Error("Final note mismatch");
  if (
    a.decision.trace.some(
      (e) =>
        e.type === "gateway_denied" ||
        (e.type === "tool_attempt" &&
          !(STUDY_TOOLS as readonly unknown[]).includes(e.name)),
    )
  )
    throw new Error("Unauthorized tool/gateway request");
  if (a.decision.elapsedMs > view.limits.timeoutMs + 5000)
    throw new Error("Accepted decision exceeded budget");
  verifyToolEvidence(a, view, past);
  if (!horizon)
    throw new Error("Missing session horizon for prompt verification");
  validateOpeningContext(a, view, past, horizon);
  if (control) return;
  if (expectedModel === PI_MODEL_ID) return validatePiAccepted(a, view, past, horizon);
  const route = qualifiedRoute(expectedModel);
  const protocol = a.decision.trace.find(e => e.type === "protocol");
  if (protocol?.provider !== route.provider || protocol.model !== route.model)
    throw new Error("Protocol model differs from configured route");
  verifyClientTelemetry(a.decision);
  const denied = a.decision.trace.find((e) => e.type === "gateway_denied");
  if (denied) throw new Error("Gateway authorization failure");
  const usage = structuredClone(a.decision.usage);
  const reconciled = reconcileClientTools(
    a.decision.trace,
    usage,
    view.limits.maxToolCalls,
    STUDY_TOOLS,
  );
  if (
    reconciled.errors.length ||
    reconciled.boundedReason ||
    contentHash(usage) !== contentHash(a.decision.usage)
  )
    throw new Error("Client tool accounting differs on replay");
  if (
    a.decision.trace.filter((e: any) => e.type === "inference_request")
      .length !== usage.turns
  )
    throw new Error("Inference accounting differs on replay");
  for (const request of a.decision.trace.filter(
    (e) => e.type === "inference_request",
  )) {
    if (request.model !== route.model || request.body?.model !== route.model ||
        !(route.provider === "openai" ? ["/inference/responses"] : ["/inference/responses", "/inference/chat/completions"]).includes(request.route))
      throw new Error("Inference model or endpoint differs from configured route");
    assertProviderContext(
      request.body,
      systemPrompt(view.limits) + OPENCODE_PROMPT_SUFFIX,
      dailyPrompt(
        view,
        horizon.start,
        horizon.end,
        horizon.contributions,
        past,
      ),
      STUDY_TOOLS,
    );
  }
  const qualifications = a.decision.trace.filter(e => e.type === "model_qualification");
  const q = qualifications[0] as any;
  if (
    qualifications.length !== 1 ||
    q?.evidence?.exactModel !== route.id ||
    q.evidence.clientVersion !== QUALIFIED_OPENCODE_CLIENT_VERSION ||
    q.evidence.pricingProven !== true ||
    q.evidence.noInference !== true ||
    q.evidence.catalogCommand !== `opencode models ${route.provider} --verbose --refresh`
  )
    throw new Error("Missing exact free-model qualification");
  assertCatalogEntry(q.evidence.catalogEntry, route.id);
  if (
    a.decision.effectiveSystemPrompt !==
    systemPrompt(view.limits) + OPENCODE_PROMPT_SUFFIX
  )
    throw new Error("Study prompt drift");
  const errs = validateClientRuntimeAudits(
    a.decision,
    route.id,
    "/work",
    STUDY_TOOLS,
  );
  if (errs.length) throw new Error(errs.join("; "));
  const state = a.decision.trace.find(
    (e: any) => e.type === "opencode_event" && e.event.type === "sandbox_state",
  ) as any;
  validateSandboxState(state?.event?.checks, a.sandbox);
}
