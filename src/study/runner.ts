import {
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { resolve, join } from "node:path";
import {
  loadDataset,
  validateDatasetWindow,
  type MarketDataset,
} from "../data/dataset.ts";
import { implementationIdentity } from "./identity.ts";
import { analyzeStudy } from "./analysis.ts";
import { assertFinalJournal } from "./memo.ts";
import { renderJournalReview } from "./review.ts";
import { loadNDX, compareNDX } from "./reference.ts";
import { getUniverse } from "../config/universe.ts";
import { buildDecisionContext } from "../run/day.ts";
import { contentHash, validateUsage } from "../run/persist.ts";
import { acquireRunLock } from "../run/lock.ts";
import {
  createInitialPortfolio,
  valuePortfolio,
  applyFill,
} from "../engine/portfolio.ts";
import { preparePortfolio, contributionOn } from "../engine/cashFlows.ts";
import { EXECUTION_CONVENTION } from "../engine/execution.ts";
import { executeOrder } from "../engine/execution.ts";
import { computeMetrics } from "../engine/metrics.ts";
import { cashBaseline, buyAndHoldBaseline } from "../engine/baselines.ts";
import { monthlyDeposits } from "../cli/experiment.ts";
import type {
  RunConfig,
  DailyRecord,
  PortfolioState,
  Fill,
  FailedOrder,
} from "../domain/types.ts";
import {
  QUALIFIED_ZEN_MODEL,
  QUALIFIED_ZEN_MODEL_ID,
  QUALIFIED_OPENCODE_CLIENT_VERSION,
  assertZeroCostCatalogEntry,
} from "../opencode/qualification.ts";
import {
  STUDY_PROTOCOL,
  POLICY,
  scopeFor,
  makeView,
  systemPrompt,
  dailyPrompt,
  openingPortfolio,
  type StudyLimits,
  type SessionHorizon,
  type SessionView,
  STUDY_TOOLS,
} from "./protocol.ts";
import { OPENCODE_PROMPT_SUFFIX } from "../opencode/config.ts";
import { verifyToolEvidence } from "./verify.ts";
import {
  reconcileClientTools,
  validateClientRuntimeAudits,
} from "../opencode/audit.ts";
import {
  validateSandboxState,
  qualifySandbox,
  sandboxIdentity,
} from "./sandbox.ts";
import { JournalStore, durableCreate, type JournalEntry } from "./journal.ts";
import { decideStudy, type StudyAttempt } from "./agent.ts";
export interface StudyConfig {
  protocol: string;
  kind: "smoke" | "quarter" | "control";
  runId: string;
  dataDir: string;
  datasetHash: string;
  reference?: { dataDir: string; datasetHash: string };
  universeVersion: string;
  start: string;
  end: string;
  history: number;
  limits: StudyLimits;
  policy: typeof POLICY;
}
interface Accepted {
  attempt: StudyAttempt;
  hash: string;
}
interface Day {
  date: string;
  acceptedHash: string;
  previous: string;
  journalRoot: string;
  record: DailyRecord;
  hash: string;
}
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
export function legacyConfig(
  c: StudyConfig,
  dates: readonly string[],
): RunConfig<null> {
  return {
    executionConvention: EXECUTION_CONVENTION,
    model: QUALIFIED_ZEN_MODEL,
    provider: "opencode",
    freeOnly: true,
    agent: "opencode",
    seed: 1,
    startingCapital: 500,
    universeVersion: c.universeVersion,
    startDate: c.start,
    endDate: c.end,
    limits: c.limits,
    warmupBars: c.history,
    contributions: monthlyDeposits(dates),
    dataDir: c.dataDir,
    fixtureVersion: c.datasetHash,
    protocolVersion: STUDY_PROTOCOL,
    experiment: c.kind === "quarter" ? "three-month" : "smoke",
  };
}
export async function prepareStudy(c: StudyConfig) {
  if (
    c.protocol !== STUDY_PROTOCOL ||
    JSON.stringify(c.policy) !== JSON.stringify(POLICY) ||
    !["smoke", "quarter", "control"].includes(c.kind)
  )
    throw new Error("Study policy mismatch");
  return prepareStudyData(c);
}
export async function prepareStudyData(c: StudyConfig) {
  if (
    c.protocol !== STUDY_PROTOCOL ||
    JSON.stringify(c.policy) !== JSON.stringify(POLICY) ||
    !["smoke", "quarter", "control"].includes(c.kind) ||
    !/^[-A-Za-z0-9_]{1,120}$/.test(c.runId)
  )
    throw new Error("Invalid study configuration");
  if (
    !Number.isSafeInteger(c.history) ||
    c.history < 60 ||
    c.history > POLICY.maxHistory
  )
    throw new Error("Study history must be 60..252");
  if (c.kind === "quarter") {
    const d = new Date(`${c.start}T00:00:00Z`);
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3, 0))
      .toISOString()
      .slice(0, 10);
    if (
      !c.start.endsWith("-01") ||
      ![0, 3, 6, 9].includes(d.getUTCMonth()) ||
      end !== c.end
    )
      throw new Error("Quarter requires a complete calendar quarter");
  }
  const market = await loadDataset(c.dataDir);
  if (market.version !== c.datasetHash)
    throw new Error("Dataset identity mismatch");
  if (c.kind === "quarter" && market.kind !== "historical")
    throw new Error("Scored quarters require historical data");
  let reference: MarketDataset | undefined;
  if (c.reference)
    reference = await loadNDX(
      c.reference.dataDir,
      c.reference.datasetHash,
      c.start,
      c.end,
    );
  if (c.kind === "quarter") {
    if (!reference)
      throw new Error(
        "Scored quarter requires a frozen NDX reference with session opens and closes",
      );
    const manifest = read(join(c.dataDir, "manifest.json"));
    const firstSession = market.calendar.find((date) => date >= c.start);
    if (
      manifest.universeDefinition?.effectiveDate !== firstSession ||
      manifest.universeDefinition?.frozenThrough !== c.end ||
      manifest.universeDefinition?.indexSymbol !== "NDX" ||
      !manifest.universeRecord ||
      !manifest.snapshots?.some(
        (f: any) => contentHash(f) === contentHash(manifest.universeRecord),
      )
    )
      throw new Error(
        "Quarter requires its own frozen start-of-quarter membership evidence",
      );
    if (
      !manifest.universeDefinition.sources?.length ||
      manifest.universeDefinition.sources.some(
        (source: any) =>
          typeof source.asOf !== "string" ||
          source.asOf >= c.start ||
          typeof source.availableAt !== "string" ||
          !Number.isFinite(Date.parse(source.availableAt)) ||
          Date.parse(source.availableAt) >= Date.parse(c.start + "T00:00:00Z"),
      )
    )
      throw new Error("Membership evidence must predate the quarter");
    if (manifest.exclusions?.length)
      throw new Error(
        "Scored quarter refuses retrospectively excluded securities; qualify complete membership and corporate actions",
      );
  }
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
  if (c.kind === "smoke" && dates.length > 5)
    throw new Error("Smoke is limited to five sessions");
  for (const date of dates) scopeFor(c.runId, date, 1);
  const config = legacyConfig(c, dates);
  const first = buildDecisionContext(
    config,
    dates[0]!,
    universe,
    createInitialPortfolio(500),
    [],
    market,
  );
  makeView(first, scopeFor(c.runId, dates[0]!, 1));
  return { market, universe, dates, config, reference };
}
function executeAccepted(
  accepted: StudyAttempt,
  previous: PortfolioState,
  config: RunConfig<null>,
  market: MarketDataset,
  universe: readonly string[],
): DailyRecord {
  const date = accepted.scope.date,
    contribution = contributionOn(config.contributions, date),
    actions = market.actionsOn(date);
  let portfolio = preparePortfolio(previous, contribution, actions);
  const before = portfolio.netWorth;
  const fills: Fill[] = [],
    failed: FailedOrder[] = [];
  for (const order of accepted.decision.orders) {
    if (!universe.includes(order.ticker))
      throw new Error("Accepted order escaped universe");
    const price = market.openOn(order.ticker, date);
    if (price === undefined) throw new Error("Execution price missing");
    const r = executeOrder(order, price, portfolio, date);
    if ("fill" in r) {
      portfolio = applyFill(portfolio, r.fill);
      fills.push(r.fill);
    } else failed.push(r.failed);
  }
  portfolio = valuePortfolio(portfolio, (t) => market.closeOn(t, date));
  return {
    artifactVersion: STUDY_PROTOCOL,
    date,
    portfolioBefore: previous,
    portfolioAfter: portfolio,
    contribution,
    corporateActions: actions,
    fills,
    failedOrders: failed,
    rationale: accepted.decision.rationale,
    usage: accepted.decision.usage,
    turnoverPct: before
      ? (fills.reduce((n, f) => n + f.notional, 0) / before) * 100
      : 0,
    terminated: false,
    boundedStop: false,
    boundedReason: null,
  };
}
/** Bind the preloaded state and complete opening prompt to reconstructed data. */
export function validateOpeningContext(a: StudyAttempt, view: SessionView, past: JournalEntry[], horizon: SessionHorizon) {
  const protocols = a.decision.trace.filter((e: any) => e.type === "protocol") as any[];
  const protocol = protocols[0];
  const expected = dailyPrompt(view, horizon.start, horizon.end, horizon.contributions, {
    lastCommittedDate: past.at(-1)?.date ?? null, entries: past.length,
  });
  if (protocols.length !== 1 || protocol.version !== STUDY_PROTOCOL ||
      protocol.viewHash !== contentHash(view) || protocol.dailyPrompt !== expected ||
      contentHash(protocol.openingPortfolio) !== contentHash(openingPortfolio(view)))
    throw new Error("Opening portfolio or daily prompt differs from eligible session context");
}
export function validateAccepted(
  a: StudyAttempt,
  view: SessionView,
  control = false,
  past: JournalEntry[] = [],
  horizon?: SessionHorizon,
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
  if (!a.decision.rationale.trim() || a.decision.usage.costUsd !== 0)
    throw new Error("Missing rationale or nonzero cost");
  validateUsage(a.decision.usage);
  assertFinalJournal(a.journalEntries, a.decision.orders);
  if (
    a.decision.usage.attemptedToolCalls > view.limits.maxToolCalls ||
    a.decision.elapsedMs > view.limits.timeoutMs + 5000
  )
    throw new Error("Accepted decision exceeded budget");
  verifyToolEvidence(a, view, past);
  if (control) return;
  if (!horizon) throw new Error("Missing session horizon for prompt verification");
  validateOpeningContext(a, view, past, horizon);
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
  const q = a.decision.trace.find(
    (e: any) => e.type === "model_qualification",
  ) as any;
  if (
    q?.evidence?.exactModel !== QUALIFIED_ZEN_MODEL_ID ||
    q.evidence.clientVersion !== QUALIFIED_OPENCODE_CLIENT_VERSION ||
    q.evidence.zeroCostProven !== true
  )
    throw new Error("Missing exact free-model qualification");
  assertZeroCostCatalogEntry(q.evidence.catalogEntry);
  if (
    a.decision.effectiveSystemPrompt !==
    systemPrompt(view.limits) + OPENCODE_PROMPT_SUFFIX
  )
    throw new Error("Study prompt drift");
  const errs = validateClientRuntimeAudits(
    a.decision,
    QUALIFIED_ZEN_MODEL_ID,
    "/work",
    STUDY_TOOLS,
  );
  if (errs.length) throw new Error(errs.join("; "));
  const state = a.decision.trace.find(
    (e: any) => e.type === "opencode_event" && e.event.type === "sandbox_state",
  ) as any;
  validateSandboxState(state?.event?.checks, a.sandbox);
  const orders = a.decision.trace
    .filter(
      (e: any) =>
        e.type === "tool_result" &&
        ["buy", "sell"].includes(e.name) &&
        !e.result.isError,
    )
    .map((e: any) => {
      const { queued, ...order } = JSON.parse(e.result.content[0].text).data;
      if (queued !== true) throw new Error("Invalid order receipt");
      return order;
    });
  if (contentHash(orders) !== contentHash(a.decision.orders))
    throw new Error("Orders differ from independent tool receipts");
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
  } = {},
) {
  if (options.control && c.kind !== "control")
    throw new Error("Control transport cannot produce a model result");
  const prepared = await prepareStudyData(c);
  const { market, universe, dates, config, reference } = prepared;
  const horizon = { start: c.start, end: c.end, contributions: config.contributions };
  const dir = resolve("results/studies", c.runId);
  mkdirSync(dir, { recursive: true });
  const release = await acquireRunLock(dir);
  try {
    const configPath = join(dir, "config.json");
    if (existsSync(configPath)) {
      if (contentHash(read(configPath)) !== contentHash(c))
        throw new Error("Immutable run configuration differs");
    } else {
      if (options.readOnly) throw new Error("Missing study configuration");
      durableCreate(configPath, c);
    }
    const implementation = implementationIdentity();
    const environmentPath = join(dir, "environment.json");
    const currentRuntime =
      !options.readOnly && c.kind !== "control"
        ? await sandboxIdentity()
        : undefined;
    if (existsSync(environmentPath)) {
      const saved = read(environmentPath);
      if (
        contentHash(saved.implementation) !== contentHash(implementation) ||
        (currentRuntime &&
          contentHash(saved.runtime) !== contentHash(currentRuntime))
      )
        throw new Error(
          "Study implementation/runtime changed; start a new cohort instead of mixing environments",
        );
    } else {
      if (options.readOnly)
        throw new Error("Missing frozen environment identity");
      durableCreate(environmentPath, {
        implementation,
        ...(currentRuntime ? { runtime: currentRuntime } : {}),
      });
    }
    const environment = read(environmentPath);
    const journal = new JournalStore(dir);
    const past: JournalEntry[] = [];
    const days: Day[] = [];
    const acceptedDecisions: StudyAttempt[] = [];
    let portfolio = createInitialPortfolio(500);
    let failure: string | undefined;
    if (!options.readOnly && c.kind !== "control") {
      const qualification = await qualifySandbox();
      const file = join(dir, `sandbox-qualification-${Date.now()}.json`);
      durableCreate(file, qualification);
    }
    if (!options.readOnly && c.kind === "control" && !options.control)
      throw new Error("Control requires an explicit deterministic transport");
    if (options.control && c.kind !== "control")
      throw new Error("Control transport cannot produce a model result");
    const files = existsSync(join(dir, "daily"))
      ? readdirSync(join(dir, "daily"))
          .filter((f) => f.endsWith(".json"))
          .sort()
      : [];
    if (files.some((f, i) => f !== `${dates[i]}.json`))
      throw new Error("Daily files are not a contiguous prefix");
    for (const date of dates) {
      const acceptedPath = join(dir, "accepted", `${date}.json`),
        dayPath = join(dir, "daily", `${date}.json`);
      let accepted: Accepted;
      // An interrupted attempt is never exposed as retry memory. A durable successful
      // result is promoted without another inference call, before any execution.
      if (!existsSync(acceptedPath) && !options.readOnly) {
        const last = journal.all().at(-1);
        if (
          last &&
          last.scope.date === date &&
          ["begin", "append"].includes(last.kind)
        ) {
          const resultPath = join(
            dir,
            "attempts",
            `${date}-${last.scope.attempt}`,
            "result.json",
          );
          if (existsSync(resultPath)) {
            const result = read(resultPath) as StudyAttempt;
            if (result.outcome === "completed") {
              const expectedScope = scopeFor(c.runId, date, last.scope.attempt);
              const recoveryView = makeView(
                buildDecisionContext(
                  config,
                  date,
                  universe,
                  portfolio,
                  [],
                  market,
                ),
                expectedScope,
              );
              validateAccepted(
                result,
                recoveryView,
                c.kind === "control",
                past,
                horizon,
              );
              durableCreate(acceptedPath, {
                attempt: result,
                hash: contentHash(result),
              });
            } else journal.finish(last.scope, "failed", contentHash(result));
          } else {
            const interruption = {
              outcome: "interrupted",
              scope: last.scope,
              reason: "Process ended before durable result; no orders executed",
            };
            durableCreate(
              join(
                dir,
                "attempts",
                `${date}-${last.scope.attempt}`,
                "interrupted.json",
              ),
              interruption,
            );
            journal.finish(last.scope, "failed", contentHash(interruption));
          }
        }
      }
      if (existsSync(acceptedPath)) accepted = read(acceptedPath);
      else {
        if (existsSync(dayPath))
          throw new Error("Day missing accepted decision");
        if (options.readOnly) break;
        const scope = scopeFor(c.runId, date, journal.nextAttempt(date));
        const view = makeView(
          buildDecisionContext(config, date, universe, portfolio, [], market),
          scope,
        );
        journal.begin(scope);
        const attemptDir = join(dir, "attempts", `${date}-${scope.attempt}`);
        mkdirSync(attemptDir, { recursive: true });
        durableCreate(join(attemptDir, "start.json"), {
          scope,
          viewHash: contentHash(view),
          priorJournalRoot: journal.root,
        });
        const auditFd = openSync(join(attemptDir, "audit.jsonl"), "ax", 0o600);
        const audit = (e: any) => {
          writeSync(auditFd, JSON.stringify(e) + "\n");
          fsyncSync(auditFd);
        };
        let result: StudyAttempt;
        try {
          result = options.control
            ? await options.control(view, journal, [...past])
            : await decideStudy(
                view,
                journal,
                [...past],
                {
                  start: c.start,
                  end: c.end,
                  contributions: config.contributions,
                },
                audit,
              );
        } finally {
          closeSync(auditFd);
        }
        if (result.outcome === "completed")
          try {
            validateAccepted(result, view, c.kind === "control", past, horizon);
          } catch (e) {
            result = {
              ...result,
              outcome: "harness_error",
              reason: e instanceof Error ? e.message : "Validation failed",
              decision: {
                ...result.decision,
                outcome: "harness_error",
                orders: [],
              },
            };
          }
        durableCreate(join(attemptDir, "result.json"), result);
        if (result.outcome !== "completed") {
          journal.finish(scope, "failed", contentHash(result));
          failure = result.reason ?? result.outcome;
          break;
        }
        accepted = { attempt: result, hash: contentHash(result) };
        durableCreate(acceptedPath, accepted);
      }
      if (
        accepted.hash !== contentHash(accepted.attempt) ||
        accepted.attempt.scope.date !== date
      )
        throw new Error("Accepted artifact changed");
      const view = makeView(
        buildDecisionContext(config, date, universe, portfolio, [], market),
        scopeFor(c.runId, date, accepted.attempt.scope.attempt),
      );
      if (
        c.kind !== "control" &&
        (accepted.attempt.sandbox as any)?.id !== environment.runtime?.id
      )
        throw new Error("Accepted sandbox differs from frozen runtime");
      validateAccepted(accepted.attempt, view, c.kind === "control", past, horizon);
      if (
        contentHash(journal.entries(accepted.attempt.scope)) !==
        contentHash(accepted.attempt.journalEntries)
      )
        throw new Error("Journal differs from accepted decision");
      let root: string;
      if (options.readOnly) {
        const e = journal
          .all()
          .find(
            (e) =>
              e.scope.date === date &&
              e.scope.attempt === accepted.attempt.scope.attempt &&
              e.kind === "sealed",
          );
        if (!e || e.payloadHash !== accepted.hash)
          throw new Error("Missing journal seal");
        root = e.hash;
      } else
        root = journal.finish(accepted.attempt.scope, "sealed", accepted.hash);
      const record = executeAccepted(
        accepted.attempt,
        portfolio,
        config,
        market,
        universe,
      );
      const body = {
        date,
        acceptedHash: accepted.hash,
        previous: days.at(-1)?.hash ?? "0".repeat(64),
        journalRoot: root,
        record,
      };
      const day = { ...body, hash: contentHash(body) };
      if (existsSync(dayPath)) {
        if (contentHash(read(dayPath)) !== contentHash(day))
          throw new Error("Daily replay mismatch");
      } else if (options.readOnly)
        throw new Error("Accepted day is not committed");
      else durableCreate(dayPath, day);
      if (!options.readOnly) journal.renderDay(accepted.attempt.scope);
      days.push(day);
      acceptedDecisions.push(accepted.attempt);
      portfolio = record.portfolioAfter;
      past.push(...accepted.attempt.journalEntries);
    }
    const records = days.map((d) => d.record);
    const curve = records.map((r) => ({
      date: r.date,
      netWorth: r.portfolioAfter.netWorth,
      ...(r.contribution ? { contribution: r.contribution } : {}),
    }));
    const metrics = computeMetrics(
      curve,
      500,
      records.reduce((n, r) => n + r.fills.length, 0),
      records.reduce((n, r) => n + r.failedOrders.length, 0),
      0,
      records.map((r) => r.turnoverPct),
    );
    const completedDates = records.map((r) => r.date);
    const bh = await buyAndHoldBaseline(
      500,
      universe,
      completedDates,
      config.contributions,
      market,
    );
    const cash = cashBaseline(500, completedDates, config.contributions);
    const ndx = reference
      ? await compareNDX(reference, records, config.contributions ?? [])
      : undefined;
    const attemptEvents = journal.all().filter((e) => e.kind === "begin");
    const reported = {
      turns: 0,
      tokens: 0,
      costUsd: 0,
      usageIncompleteAttempts: 0,
    };
    const attemptDetails = [];
    for (const e of attemptEvents) {
      const path = join(
        dir,
        "attempts",
        `${e.scope.date}-${e.scope.attempt}`,
        "result.json",
      );
      if (!existsSync(path)) {
        reported.usageIncompleteAttempts++;
        attemptDetails.push({ date: e.scope.date, attempt: e.scope.attempt, outcome: "interrupted", reason: "No durable result; orders not executed" });
        continue;
      }
      const attempt = read(path) as StudyAttempt;
      attemptDetails.push({
        date: e.scope.date, attempt: e.scope.attempt, outcome: attempt.outcome,
        reason: attempt.reason ?? null, elapsedMs: attempt.decision.elapsedMs,
        turns: attempt.decision.usage.turns,
        brokerToolAttempts: attempt.decision.trace.filter((event: any) => event.type === "tool_attempt").length,
        submittedOrders: attempt.decision.submittedOrders.length,
        journalEntries: attempt.journalEntries.length,
        executedFills: attempt.outcome === "completed" ? records.find(r => r.date === e.scope.date)?.fills.length ?? 0 : 0,
      });
      const u = attempt.decision.usage;
      validateUsage(u);
      reported.turns += u.turns;
      reported.tokens += u.totalTokens;
      reported.costUsd += u.costUsd;
      if (attempt.outcome !== "completed") reported.usageIncompleteAttempts++;
    }
    const summary = {
      protocol: STUDY_PROTOCOL,
      kind: c.kind,
      config: c,
      status: days.length === dates.length ? "completed" : "incomplete",
      failure,
      committedDays: days.length,
      totalDays: dates.length,
      metrics,
      portfolio,
      behavior: analyzeStudy(records, acceptedDecisions),
      baselines: { cash, buyAndHold: bh, ...(ndx ? { ndx } : {}) },
      journal: { entries: past.length, root: journal.root },
      operational: {
        reportedUsage: reported,
        attemptDetails,
        attempts: journal.all().filter((e) => e.kind === "begin").length,
        failed: journal.all().filter((e) => e.kind === "failed").length,
      },
      note:
        c.kind === "quarter"
          ? "Independent quarter: fresh portfolio and journal. NDX is a price index; portfolio dividends are reported separately."
          : "Environment qualification only; smoke/control results are excluded from scored model comparisons.",
    };
    // Derived reports can be regenerated; accepted decisions, journal and daily records cannot be overwritten.
    if (!options.readOnly) {
      const { writeFileAtomic } = await import("../utils/fs.ts");
      await writeFileAtomic(join(dir, "journal-review.md"), renderJournalReview(records, acceptedDecisions));
      await writeFileAtomic(
        join(dir, "summary.json"),
        JSON.stringify(summary, null, 2) + "\n",
      );
    }
    return { dir, summary };
  } finally {
    await release();
  }
}
