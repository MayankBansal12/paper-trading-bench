import { implementationMatches, runtimeMatches } from "./continuation.ts";
import { continuationFits, loadParentPrefix, type ContinuationCheckpoint } from "./segment.ts";
import { registerInheritedRun, unregisterInheritedRun } from "./tools.ts";
import { QUOTA_PAUSE_POLICY, quotaPause, type QuotaPause } from "./availability.ts";
import { isPiModel, PI_MUSE_MODEL_ID } from "../pi/route.ts";
import { isClaudeModel } from "../claude/route.ts";
import { studyRoute } from "./routes.ts";
import { assertStorage } from "./storage.ts";
import { mkdirSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  loadDataset,
  validateDatasetWindow,
  verifiedFile,
} from "../data/dataset.ts";
import { getUniverse } from "../config/universe.ts";
import { contentHash } from "../core/hash.ts";
import { buildDecisionContext, type ContextConfig } from "../core/context.ts";
import { monthlyDeposits, STARTING_CAPITAL } from "../core/funding.ts";
import { executeAccepted, executeInvalidDay } from "../core/execute.ts";
import type { StudyRecord, StudyLimits } from "../core/types.ts";
import { createInitialPortfolio } from "../engine/portfolio.ts";
import { acquireRunLock } from "../run/lock.ts";
import { implementationIdentity, repositoryRevision } from "./identity.ts";
import {
  STUDY_PROTOCOL,
  POLICY,
  scopeFor,
  makeView,
  type SessionView,
} from "./protocol.ts";
import {
  JournalStore,
  durableCreate,
  type JournalEntry,
  type JournalEvent,
} from "./journal.ts";
import {
  decideStudy,
  prepareModelRuntime,
} from "./model.ts";
import type { StudyAttempt } from "./agent.ts";
import { validateAccepted } from "./accept.ts";
export { validateAccepted, validateOpeningContext } from "./accept.ts";
import { QUALIFIED_ZEN_MODEL_ID } from "../opencode/qualification.ts";
export interface StudyConfig {
  availabilityPolicy?: typeof QUOTA_PAUSE_POLICY;
  model?: string;
  protocol: string;
  kind: "environment" | "smoke" | "quarter" | "control";
  runId: string;
  dataDir: string;
  datasetHash: string;
  universeVersion: string;
  reference?: { dataDir: string; datasetHash: string };
  start: string;
  end: string;
  history: number;
  limits: StudyLimits;
  policy: typeof POLICY;
  continuation?: ContinuationCheckpoint;
}
export interface Day {
  date: string;
  previous: string;
  resultEventHash: string;
  submissionEventHash: string | null;
  status: "completed" | "invalid";
  failureEventHashes: string[];
  reason: string | null;
  record: StudyRecord;
  hash: string;
}
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
export async function prepareStudyData(c: StudyConfig) {
  if (c.kind === "control" && c.model !== undefined) throw new Error("Control cannot select a model route");
  if (c.kind !== "control") studyRoute(c.model ?? QUALIFIED_ZEN_MODEL_ID);
  if (
    c.protocol !== STUDY_PROTOCOL ||
    contentHash(c.policy) !== contentHash(POLICY) ||
    !["environment", "smoke", "quarter", "control"].includes(c.kind) ||
    !/^[-A-Za-z0-9_]{1,120}$/.test(c.runId)
  )
    throw new Error(
      "Invalid study configuration; old cohorts require archived source",
    );
  if (
    !Number.isSafeInteger(c.history) ||
    c.history < 60 ||
    c.history > POLICY.maxHistory
  )
    throw new Error("History must be 60..252");
  if (c.availabilityPolicy && (!(isPiModel(c.model) || isClaudeModel(c.model) || c.model === "opencode-go/deepseek-v4.1-flash") || contentHash(c.availabilityPolicy) !== contentHash(QUOTA_PAUSE_POLICY)))
    throw new Error("Unqualified availability policy or model");
  const market = await loadDataset(c.dataDir);
  if (market.version !== c.datasetHash)
    throw new Error("Dataset identity mismatch");
  const universe =
    c.universeVersion === "dataset"
      ? market.universe
      : getUniverse(c.universeVersion);
  const dates = validateDatasetWindow(
    market,
    c.start,
    c.end,
    c.history,
    universe,
  );
  const config: ContextConfig = {
    history: c.history,
    start: c.start,
    end: c.end,
    limits: c.limits,
    contributions: monthlyDeposits(dates),
  };
  const aliases: Record<string, string[]> = {};
  // Only names from hash-verified frozen source metadata; never copy source market fields into context.
  const manifestPath = join(c.dataDir, "manifest.json");
  if (existsSync(manifestPath)) {
    const manifest = read(manifestPath);
    for (const file of manifest.snapshots ?? []) {
      if (!file.path.endsWith(".json")) continue;
      const raw = JSON.parse((await verifiedFile(c.dataDir, file)).toString());
      const meta = raw.chart?.result?.[0]?.meta;
      if (meta && universe.includes(meta.symbol))
        aliases[meta.symbol] = [meta.shortName, meta.longName].filter(
          (x: unknown): x is string => typeof x === "string" && x.length <= 200,
        );
    }
  }
  for (const date of dates) scopeFor(c.runId, date, 1);
  makeView(
    buildDecisionContext(
      config,
      dates[0]!,
      universe,
      createInitialPortfolio(STARTING_CAPITAL),
      [],
      market,
    ),
    scopeFor(c.runId, dates[0]!, 1),
    aliases,
  );
  return { market, universe, dates, config, aliases };
}
export const prepareStudy = prepareStudyData;
/** Attempt metadata never repeats the streamed trace or the durable submission. */
function resultPayload(a: StudyAttempt) {
  const { trace, orders, submittedOrders, rationale, ...decision } = a.decision;
  const { journalEntries, submission, decision: ignored, ...metadata } = a;
  return { ...metadata, decision };
}
export function restoreAttempt(
  store: JournalStore,
  e: JournalEvent,
): StudyAttempt {
  const submission = store.submission(e.scope);
  const { decision, ...metadata } = e.payload;
  return {
    ...metadata,
    decision: {
      ...decision,
      trace: store.trace(e.scope),
      orders:
        e.payload.outcome === "completed" ? (submission?.orders ?? []) : [],
      submittedOrders: submission?.orders ?? [],
      rationale: submission?.journal.text ?? "",
    },
    journalEntries: store.entries(e.scope),
    submission,
  };
}
export async function runStudy(
  c: StudyConfig,
  options: {
    readOnly?: boolean;
    control?: (
      view: SessionView,
      journal: JournalStore,
      past: JournalEntry[],
    ) => Promise<StudyAttempt>;
    fault?: (phase: "after-result" | "after-commit", date: string) => void;
  } = {},
) {
  if (options.control && c.kind !== "control")
    throw new Error("Control transport cannot produce model results");
  const { market, universe, dates, config, aliases } =
    await prepareStudyData(c);
  const horizon = {
    start: c.start,
    end: c.end,
    contributions: config.contributions,
  };
  const dir = resolve("results/studies", c.runId);
  if (options.readOnly && !existsSync(dir)) throw new Error("Missing run");
  mkdirSync(dir, { recursive: true });
  const release = await acquireRunLock(dir);
  let runtime: Awaited<ReturnType<typeof prepareModelRuntime>> | undefined;
  try {
    const implementation = implementationIdentity();
    const manifestPath = join(dir, "manifest.json");
    if (existsSync(manifestPath)) {
      const saved = read(manifestPath);
      if (
        contentHash(saved.config) !== contentHash(c) ||
        !implementationMatches(saved.implementation, implementation, dir, c)
      )
        throw new Error(
          "Implementation/configuration changed; start a new cohort",
        );
    } else {
      if (options.readOnly) throw new Error("Missing manifest");
      durableCreate(manifestPath, {
        config: c,
        implementation,
        repositoryRevision: repositoryRevision(),
        funding: config.contributions,
      });
    }
    const parent = c.continuation ? loadParentPrefix(c.continuation) : undefined;
    const offset = parent?.days.length ?? 0;
    if (c.continuation) registerInheritedRun(c.runId, c.continuation.parentRunId);
    if (parent && !continuationFits(parent, c as any, dates))
      throw new Error("Continuation parent does not match this quarter");
    const carry = parent?.carried.length
      ? { date: parent.carried[0]!.scope.date, attempts: Math.max(...parent.carried.map((e) => e.scope.attempt)) } : undefined;
    const store = new JournalStore(dir, carry);
    const past: JournalEntry[] = parent ? [...parent.past] : [],
      days: Day[] = parent ? [...parent.days] : [],
      attempts: StudyAttempt[] = [];
    let portfolio = parent ? parent.portfolio : createInitialPortfolio(STARTING_CAPITAL),
      failure: string | undefined;
    let availability: QuotaPause | undefined;
    let consecutiveInvalidDays = parent?.consecutiveInvalidDays ?? 0, maxConsecutiveInvalidDays = parent?.maxConsecutiveInvalidDays ?? 0;
    const files = existsSync(join(dir, "days"))
      ? readdirSync(join(dir, "days"))
          .filter((f) => f.endsWith(".json"))
          .sort()
      : [];
    if (files.some((f, i) => f !== `${dates[offset + i]}.json`))
      throw new Error("Days are not a contiguous prefix");
    // Reusable runtime is prepared lazily before the first new attempt, outside every daily watchdog.
    for (const [dateIndex, date] of dates.entries()) {
      if (dateIndex < offset) continue;
      if (consecutiveInvalidDays >= POLICY.maxConsecutiveInvalidDays) {
        if (files.length > days.length - offset) throw new Error("Day commits extend beyond the invalid-day stop");
        break;
      }
      const dayPath = join(dir, "days", `${date}.json`);
      let terminal = store
        .all()
        .filter(
          (e) =>
            e.scope.date === date &&
            e.kind === "result" &&
            e.payload.outcome === "completed",
        )
        .at(-1);
      const closedFailures = () => [...(parent?.carried ?? []), ...store.all()].filter((e) =>
        e.scope.date === date && (e.kind === "failed" ||
          (e.kind === "result" && e.payload.outcome !== "completed")),
      );
      if (!terminal && closedFailures().length !== POLICY.maxAttemptsPerDay && existsSync(dayPath))
        throw new Error("Commit missing completed result or exhausted failures");
      // A recorded quota failure keeps its attempt number. During cooldown no
      // new runtime, provider request, retry, invalid day or later day is created.
      if (!terminal && !existsSync(dayPath) && c.availabilityPolicy) {
        // Only this run's own failures can pause it; carried parent failures count toward attempts, never toward a wait.
        const pause = quotaPause(store, closedFailures().filter((e) => e.scope.runId === c.runId).at(-1));
        if (pause && (options.readOnly || Date.now() < Date.parse(pause.notBefore))) {
          availability = pause;
          failure = `Provider usage limit; resume no earlier than ${pause.notBefore}`;
          break;
        }
      }
      if (!terminal && !options.readOnly) {
        const last = store.all().at(-1);
        if (
          last?.scope.date === date &&
          !["result", "failed"].includes(last.kind)
        )
          store.fail(
            last.scope,
            "Interrupted before complete integrity audit; submission cannot execute",
          );
        // A fresh attempt starts from the last committed state, never failed memory.
        // Persisted attempts count across process restarts; resume cannot grant a third.
        while (!terminal && store.nextAttempt(date) <= POLICY.maxAttemptsPerDay) {
          assertStorage(dir);
          if (!options.control && c.kind === "control")
            throw new Error("Control requires explicit deterministic transport");
          if (!options.control && !runtime) {
            const runtimePath = join(dir, "runtime.json");
            runtime = await prepareModelRuntime(c.model, existsSync(runtimePath) ? read(runtimePath) : undefined);
            if (existsSync(runtimePath)) {
              if (
                !runtimeMatches(read(runtimePath), runtime.bundle.evidence, dir)
              )
                throw new Error("Runtime changed; start a new cohort");
            } else durableCreate(runtimePath, runtime.bundle.evidence);
          }
          // Runtime preparation also needs disk space. Recheck before inference.
          assertStorage(dir);
          if (!options.control) {
            try { await runtime!.credential.authorize(AbortSignal.timeout(60_000)); }
            catch { throw new Error("BENCH_AUTH_PAUSE: host login unavailable; no attempt started"); }
          }
          const scope = scopeFor(c.runId, date, store.nextAttempt(date));
          const view = makeView(
            buildDecisionContext(config, date, universe, portfolio, [], market),
            scope,
            aliases,
          );
          store.begin(scope);
          let result = options.control
            ? await options.control(view, store, [...past])
            : await decideStudy(
                view,
                store,
                [...past],
                horizon,
                (e) => store.audit(scope, e),
                runtime!,
              );
          let terminalVerificationError: string | undefined;
          // Controls persist the same raw prompt/tool boundary as the model adapter.
          if (result.outcome === "completed")
            try {
              validateAccepted(result, view, c.kind === "control", past, horizon, c.model);
            } catch (e) {
              if (c.model === PI_MUSE_MODEL_ID) terminalVerificationError = String(e);
              result = {
                ...result,
                outcome: "harness_error",
                reason: String(e),
                decision: {
                  ...result.decision,
                  outcome: "harness_error",
                  orders: [],
                },
              };
            }
          const resultEvent = store.result(scope, resultPayload(result));
          // An integrity audit failure is terminal infrastructure evidence, not
          // a reason to spend the remaining attempt on an unchanged verifier.
          // Persist the failed attempt first; never refund it or relabel a day.
          if (terminalVerificationError)
            throw new Error("TERMINAL_VERIFICATION_ERROR: " + terminalVerificationError);
          options.fault?.("after-result", date);
          if (result.outcome === "completed") terminal = resultEvent;
          else if (c.availabilityPolicy) {
            availability = quotaPause(store, resultEvent);
            if (availability) {
              failure = `Provider usage limit; resume no earlier than ${availability.notBefore}`;
              break;
            }
          }
        }
      }
      if (availability) break;
      const failures = closedFailures();
      const exhausted = failures.length === POLICY.maxAttemptsPerDay &&
        failures.every((e, i) => e.scope.attempt === i + 1);
      if (!terminal && !exhausted) {
        const last = store.all().filter((e) => e.scope.date === date).at(-1);
        if (last) failure = last.payload.reason ?? "Unfinished attempt requires recovery";
        break;
      }
      let accepted: StudyAttempt | undefined;
      let submissionEventHash: string | null = null;
      let record: StudyRecord;
      let reason: string | null = null;
      if (terminal) {
        accepted = restoreAttempt(store, terminal);
        const view = makeView(
          buildDecisionContext(config, date, universe, portfolio, [], market),
          accepted.scope, aliases,
        );
        if (c.kind !== "control") {
          const savedRuntime = read(join(dir, "runtime.json"));
          const acceptedRuntime = Object.fromEntries(Object.keys(savedRuntime).map(
            (key) => [key, (accepted!.sandbox as any)?.[key]],
          ));
          if (!runtimeMatches(savedRuntime, acceptedRuntime, dir))
            throw new Error("Accepted sandbox differs from frozen runtime");
        }
        validateAccepted(accepted, view, c.kind === "control", past, horizon, c.model);
        submissionEventHash = store.matching(accepted.scope).find((e) => e.kind === "submission")!.hash;
        record = executeAccepted(accepted, portfolio, config, market, universe);
      } else {
        // Bind the no-order ledger to both durable failures, never their submissions.
        terminal = failures.at(-1)!;
        reason = terminal.payload.reason ?? terminal.payload.outcome ?? "Attempts exhausted";
        record = executeInvalidDay(date, portfolio, config, market, universe);
      }
      const body = {
        date,
        previous: days.at(-1)?.hash ?? "0".repeat(64),
        resultEventHash: terminal.hash,
        submissionEventHash,
        status: accepted ? "completed" as const : "invalid" as const,
        failureEventHashes: accepted ? [] : failures.map((e) => e.hash),
        reason,
        record,
      };
      const day = { ...body, hash: contentHash(body) };
      if (existsSync(dayPath)) {
        if (contentHash(read(dayPath)) !== contentHash(day))
          throw new Error("Daily replay mismatch");
      } else if (options.readOnly)
        throw new Error("Durable result awaits day commit; resume to recover");
      else durableCreate(dayPath, day);
      options.fault?.("after-commit", date);
      days.push(day);
      portfolio = record.portfolioAfter;
      if (accepted) {
        attempts.push(accepted);
        past.push(...accepted.journalEntries);
        consecutiveInvalidDays = 0;
      } else {
        consecutiveInvalidDays++;
        maxConsecutiveInvalidDays = Math.max(maxConsecutiveInvalidDays, consecutiveInvalidDays);
        if (consecutiveInvalidDays >= POLICY.maxConsecutiveInvalidDays)
          failure = `${POLICY.maxConsecutiveInvalidDays} consecutive invalid trading days through ${date}: ${reason}`;
      }
    }
    const events = [...(parent?.events ?? []), ...store.all()];
    const resultEvents = events.filter((e) => e.kind === "result");
    const begins = events.filter((e) => e.kind === "begin");
    const attemptedDates = new Set(begins.map((e) => e.scope.date));
    const retriedDates = new Set(begins.filter((e) => e.scope.attempt > 1).map((e) => e.scope.date));
    const stopped = consecutiveInvalidDays >= POLICY.maxConsecutiveInvalidDays;
    const invalidSessions = days.filter((d) => d.status === "invalid").map((d) => ({
      date: d.date, attempts: POLICY.maxAttemptsPerDay, reason: d.reason,
    }));
    const summary = {
      protocol: STUDY_PROTOCOL,
      kind: c.kind,
      status: availability ? "paused" : stopped ? "invalid" : days.length === dates.length ? "completed" : "incomplete",
      ...(availability ? { availability } : {}),
      failure: failure ?? null,
      committedDays: days.length,
      validDays: (parent ? parent.days.filter((d) => d.status === "completed").length : 0) + attempts.length,
      ...(parent ? { continuation: {
        version: c.continuation!.version, parentRunId: c.continuation!.parentRunId, inheritedDays: offset,
        newlyCommittedDays: days.length - offset, totalDays: days.length, parentEventRoot: c.continuation!.eventRoot,
        parentLastDayHash: c.continuation!.lastDayHash, newEventRoot: store.root,
        ...(c.continuation!.recovery ? { recovery: {
          label: "SUPPLEMENTAL RECOVERY: fresh attempts after the parent's last valid day; the parent's later failed attempts are superseded here, not refunded, and the parent's own score is unchanged",
          boundaryDate: c.continuation!.recovery.boundaryDate,
          parentEventRoot: c.continuation!.recovery.parentEventRoot,
          parentLastDayHash: c.continuation!.recovery.parentLastDayHash,
          supersededDays: c.continuation!.recovery.supersededDays.map((d) => d.date),
          supersededAttempts: c.continuation!.recovery.supersededAttempts.length,
        } } : {}),
      } } : {}),
      consecutiveInvalidDays,
      maxConsecutiveInvalidDays,
      stopped,
      totalDays: dates.length,
      attemptedDays: attemptedDates.size,
      retriedDays: retriedDates.size,
      invalidDays: invalidSessions.length,
      unattemptedDays: dates.length - attemptedDates.size,
      invalidSessions,
      portfolio,
      fills: days.reduce((n, d) => n + d.record.fills.length, 0),
      rejectedOrders: days.reduce(
        (n, d) => n + d.record.failedOrders.length,
        0,
      ),
      journalEntries: past.length,
      eventRoot: store.root,
      commitRoot: days.at(-1)?.hash ?? null,
      attempts: begins.length,
      failures: events.filter(
          (e) =>
            e.kind === "failed" ||
            (e.kind === "result" && e.payload.outcome !== "completed"),
        ).length,
      usageUnavailableAttempts: resultEvents.filter(
        (e) => e.payload.decision.usage.completeness !== "complete",
      ).length,
    };
    return { dir, summary, days, attempts };
  } finally {
    unregisterInheritedRun(c.runId);
    await runtime?.dispose();
    await release();
  }
}
