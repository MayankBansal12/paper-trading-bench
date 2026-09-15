import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { contentHash, textHash } from "../core/hash.ts";
import { STARTING_CAPITAL, MONTHLY_CONTRIBUTION } from "../core/funding.ts";
import { exchangeDates } from "../data/calendar.ts";
import { loadDataset } from "../data/dataset.ts";
import { computeMetrics } from "../engine/metrics.ts";
import { acquireRunLock } from "../run/lock.ts";
import { writeFileAtomic } from "../utils/fs.ts";
import { QUALIFIED_MODEL_IDS } from "../opencode/qualification.ts";
import { deterministicControl } from "./control.ts";
import { implementationIdentity } from "./identity.ts";
import { durableCreate } from "./journal.ts";
import { POLICY, STUDY_PROTOCOL } from "./protocol.ts";
import { prepareStudyData, runStudy, type StudyConfig } from "./runner.ts";

export const EVALUATION_VERSION = "independent-quarters-apr2025-mar2026-v4";
export const EVALUATION_MODELS = QUALIFIED_MODEL_IDS;
export const CONTROL_MODEL = "deterministic-control";
export const EVALUATION_QUARTERS = Object.freeze([
  Object.freeze({ label: "2025-Q2", start: "2025-04-01", end: "2025-06-30" }),
  Object.freeze({ label: "2025-Q3", start: "2025-07-01", end: "2025-09-30" }),
  Object.freeze({ label: "2025-Q4", start: "2025-10-01", end: "2025-12-31" }),
  Object.freeze({ label: "2026-Q1", start: "2026-01-01", end: "2026-03-31" }),
]);

export interface EvaluationInput {
  evalId: string;
  dataDir: string;
  models?: readonly string[];
  history?: number;
  timeoutMs?: number;
  concurrency?: number;
}

/** Every model uses the same Cartesian product; there is no continuous-year path. */
export function evaluationSchedule(evalId: string, models: readonly string[]) {
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(evalId))
    throw new Error("Evaluation ID must be 1..60 letters, digits, hyphens or underscores");
  if (!models.length || new Set(models).size !== models.length ||
      models.some(m => !/^[A-Za-z0-9_./-]{1,160}$/.test(m)))
    throw new Error("Evaluation needs distinct, nonempty model IDs");
  const jobs = models.flatMap(model => EVALUATION_QUARTERS.map(quarter => ({
    model,
    ...quarter,
    runId: `${evalId}-${model.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 25)}-${textHash(model).slice(0, 12)}-${quarter.label}`,
  })));
  if (new Set(jobs.map(j => j.runId)).size !== jobs.length)
    throw new Error("Evaluation run ID collision");
  return jobs;
}

export async function prepareEvaluation(input: EvaluationInput) {
  const models = [...(input.models ?? EVALUATION_MODELS)];
  const schedule = evaluationSchedule(input.evalId, models);
  const concurrency = input.concurrency ?? schedule.length;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > schedule.length)
    throw new Error(`Concurrency must be an integer from 1 to ${schedule.length}`);
  for (const model of models)
    if (model !== CONTROL_MODEL && !EVALUATION_MODELS.includes(model))
      throw new Error(`Unqualified evaluation model: ${model}. Qualified routes: ${EVALUATION_MODELS.join(", ")}`);
  const history = input.history ?? 100;
  const timeoutMs = input.timeoutMs ?? POLICY.defaultTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > POLICY.defaultTimeoutMs)
    throw new Error(`Timeout must be 1..${POLICY.defaultTimeoutMs} ms`);
  const dataDir = resolve(input.dataDir);
  const market = await loadDataset(dataDir);
  if (models.some(m => m !== CONTROL_MODEL) && market.kind !== "historical")
    throw new Error("Model evaluations require frozen historical data");
  const jobs = [];
  // Validate ALL quarters before creating any artifact or making any model call.
  for (const job of schedule) {
    const config: StudyConfig = {
      protocol: STUDY_PROTOCOL,
      kind: job.model === CONTROL_MODEL ? "control" : "environment",
      runId: job.runId,
      ...(job.model === CONTROL_MODEL ? {} : { model: job.model }),
      dataDir,
      datasetHash: market.version,
      universeVersion: "dataset",
      start: job.start,
      end: job.end,
      history,
      limits: { maxTurns: null, maxToolCalls: null, timeoutMs },
      policy: POLICY,
    };
    const prepared = await prepareStudyData(config);
    if (contentHash(prepared.dates) !== contentHash(exchangeDates(job.start, job.end)))
      throw new Error(`${job.label} requires every exchange session; truncated quarters are refused`);
    if (prepared.config.contributions.length !== 2)
      throw new Error(`${job.label} requires two monthly deposits`);
    jobs.push({ ...job, config, sessions: prepared.dates.length,
      firstSession: prepared.dates[0]!, lastSession: prepared.dates.at(-1)!,
      funding: prepared.config.contributions });
  }
  return {
    version: EVALUATION_VERSION,
    evalId: input.evalId,
    start: EVALUATION_QUARTERS[0]!.start,
    end: EVALUATION_QUARTERS.at(-1)!.end,
    models,
    execution: { maxConcurrentRuns: concurrency, scheduling: "model-then-quarter-queue", state: "independent-runs" },
    initialization: {
      startingCapital: STARTING_CAPITAL, holdings: {}, journalEntries: 0,
      priorAttempts: 0, consecutiveInvalidDays: 0,
      monthlyContribution: MONTHLY_CONTRIBUTION,
      totalFundingPerQuarter: STARTING_CAPITAL + 2 * MONTHLY_CONTRIBUTION,
      totalFundingPerModel: 4 * (STARTING_CAPITAL + 2 * MONTHLY_CONTRIBUTION),
      carryForward: false,
    },
    jobs,
  };
}
export type EvaluationPlan = Awaited<ReturnType<typeof prepareEvaluation>>;
type StudyResult = Awaited<ReturnType<typeof runStudy>>;
export interface EvaluationQuarterResult {
  runId: string;
  model: string;
  label: string;
  start: string;
  end: string;
  status: string;
  summary: StudyResult["summary"] | null;
  metrics: ReturnType<typeof computeMetrics> | null;
  error: string | null;
}

function quarterResult(job: EvaluationPlan["jobs"][number], result: StudyResult): EvaluationQuarterResult {
  const records = result.days.map(d => d.record);
  return {
    runId: job.runId, model: job.model, label: job.label, start: job.start, end: job.end,
    status: result.summary.status, summary: result.summary, error: null,
    metrics: records.length ? computeMetrics(
      records.map(r => ({ date: r.date, netWorth: r.portfolioAfter.netWorth, contribution: r.contribution })),
      STARTING_CAPITAL, result.summary.fills, result.summary.rejectedOrders, 0,
      records.map(r => r.turnoverPct),
    ) : null,
  };
}

/** Sum independent account outcomes; never compound quarterly returns or join balances. */
export function evaluationReport(plan: EvaluationPlan, quarters: EvaluationQuarterResult[]) {
  const round = (x: number) => Math.round(x * 100) / 100;
  const models = plan.models.map(model => {
    const rows = plan.jobs.filter(j => j.model === model).map(job => {
      const matches = quarters.filter(q => q.runId === job.runId && q.model === model);
      if (matches.length > 1) throw new Error("Duplicate quarter result");
      return matches[0];
    });
    const complete = rows.length === 4 && rows.every(q => q?.status === "completed" && q.metrics);
    const metrics = rows.flatMap(q => q?.metrics ? [q.metrics] : []);
    const contributed = round(metrics.reduce((n, m) => n + m.totalContributions!, 0));
    const profit = round(metrics.reduce((n, m) => n + m.netProfit!, 0));
    return {
      model, complete, completedQuarters: rows.filter(q => q?.status === "completed").length,
      accountedSessions: rows.reduce((n, q) => n + (q?.summary?.committedDays ?? 0), 0),
      validDays: rows.reduce((n, q) => n + (q?.summary?.validDays ?? 0), 0),
      invalidDays: rows.reduce((n, q) => n + (q?.summary?.invalidDays ?? 0), 0),
      retriedDays: rows.reduce((n, q) => n + (q?.summary?.retriedDays ?? 0), 0),
      plannedContributions: plan.initialization.totalFundingPerModel,
      accountedContributions: contributed,
      // Incomplete periods retain their quarter results but never get a full-year score.
      year: complete ? {
        totalContributions: contributed,
        sumOfQuarterEndingEquities: round(metrics.reduce((n, m) => n + m.endingNetWorth, 0)),
        netProfit: profit,
        profitOnContributionsPct: round(profit / contributed * 100),
        meanQuarterTimeWeightedReturnPct: round(metrics.reduce((n, m) => n + m.timeWeightedReturnPct!, 0) / 4),
      } : null,
    };
  });
  return {
    version: plan.version, evalId: plan.evalId, start: plan.start, end: plan.end,
    status: models.every(m => m.complete) ? "completed" : "incomplete",
    interpretation: "Four independent quarterly portfolios per model. Dollar outcomes are summed; mean quarterly TWR is not an annual compounded return. Independent account balances must not be plotted as one equity curve. These environment results do not establish scored NDX membership eligibility.",
    models, quarters,
  };
}

export async function runEvaluation(input: EvaluationInput, options: {
  resume?: boolean;
  readOnly?: boolean;
  control?: NonNullable<Parameters<typeof runStudy>[1]>["control"];
} = {}) {
  const plan = await prepareEvaluation(input);
  if (options.control && plan.models.some(m => m !== CONTROL_MODEL))
    throw new Error("Control transport cannot produce model evaluation results");
  const dir = resolve("results/evaluations", plan.evalId);
  if (options.readOnly && !existsSync(join(dir, "manifest.json"))) throw new Error("Missing evaluation");
  const release = await acquireRunLock(dir);
  try {
    const manifest = {
      plan, implementation: implementationIdentity(),
      orchestratorHash: textHash(readFileSync(new URL(import.meta.url), "utf8")),
    };
    const manifestPath = join(dir, "manifest.json");
    if (existsSync(manifestPath)) {
      if (!options.resume && !options.readOnly)
        throw new Error("Evaluation already exists; use --resume=true or a new --eval-id");
      if (contentHash(JSON.parse(readFileSync(manifestPath, "utf8"))) !== contentHash(manifest))
        throw new Error("Evaluation implementation/configuration changed; start a new evaluation");
    } else {
      if (options.resume || options.readOnly) throw new Error("Missing evaluation manifest");
      for (const job of plan.jobs)
        if (existsSync(resolve("results/studies", job.runId)))
          throw new Error(`Refusing to adopt existing run ${job.runId}; use a new evaluation ID`);
      durableCreate(manifestPath, manifest);
    }
    // Validate every saved child before allowing new inference in any child.
    for (const job of plan.jobs) {
      const path = resolve("results/studies", job.runId, "manifest.json");
      if (!existsSync(path)) continue;
      const saved = JSON.parse(readFileSync(path, "utf8"));
      if (contentHash(saved.config) !== contentHash(job.config) ||
          contentHash(saved.implementation) !== contentHash(manifest.implementation))
        throw new Error(`Child run identity mismatch: ${job.runId}`);
    }
    const quarters: EvaluationQuarterResult[] = plan.jobs.map(job => ({
      runId: job.runId, model: job.model, label: job.label, start: job.start, end: job.end,
      status: "pending", summary: null, metrics: null, error: null,
    }));
    // Concurrent children share only this derived report. Serialize atomic writes so
    // they cannot race on summary.json.tmp or overwrite a newer snapshot.
    let writes = Promise.resolve();
    const persist = () => {
      writes = writes.then(() => writeFileAtomic(
        join(dir, "summary.json"),
        JSON.stringify(evaluationReport(plan, quarters), null, 2) + "\n",
      ));
      return writes;
    };
    const batch = plan.jobs.map((job, index) => ({ job, index }));
    if (!options.readOnly) await persist();
    const execute = async ({ job, index }: (typeof batch)[number]) => {
      const childExists = existsSync(resolve("results/studies", job.runId, "manifest.json"));
      if (!options.readOnly) {
        quarters[index]!.status = "running";
        await persist();
      }
      try {
        if (!options.readOnly || childExists) {
          // Every admitted job owns its portfolio, journal, attempts, sandbox and
          // runtime. Queueing changes host concurrency, never quarter state.
          const result = await runStudy(job.config, {
            readOnly: options.readOnly,
            ...(job.model === CONTROL_MODEL && !options.readOnly
              ? { control: options.control ?? deterministicControl } : {}),
          });
          quarters[index] = quarterResult(job, result);
        }
      } catch (e) {
        if (options.readOnly) throw e;
        quarters[index] = { ...quarters[index]!, status: "error", error: String(e) };
      }
      if (!options.readOnly) await persist();
    };
    // A failed job releases its slot without cancelling the remaining quarters.
    // Keep results in plan order even when completion order differs.
    const settled: PromiseSettledResult<void>[] = new Array(batch.length);
    let next = 0;
    await Promise.all(Array.from({ length: plan.execution.maxConcurrentRuns }, async () => {
      while (next < batch.length) {
        const index = next++;
        try {
          await execute(batch[index]!);
          settled[index] = { status: "fulfilled", value: undefined };
        } catch (reason) {
          settled[index] = { status: "rejected", reason };
        }
      }
    }));
    // Keep the evaluation lock until all model/quarter runs and report writes settle,
    // including when a verification or report write fails.
    const failed = settled.flatMap((r, index) => r.status === "rejected" ? [new Error(
      `${batch[index]!.job.label} (${batch[index]!.job.runId}): ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
      { cause: r.reason },
    )] : []);
    if (failed.length) throw new AggregateError(failed, `Quarter execution failed:\n${failed.map(e => e.message).join("\n")}`);
    return { dir, plan, report: evaluationReport(plan, quarters) };
  } finally { await release(); }
}
