import { textHash, canonical } from "../core/hash.ts";
import { EVALUATION_QUARTERS } from "../study/evaluation.ts";
import { exchangeDates } from "../data/calendar.ts";
import type { studyFunding } from "./studyView.ts";

const names: Record<string, string> = {
  "openai/gpt-5.6-luna": "GPT-5.6 Luna",
  "opencode/muse-spark-1.3-contributor-free": "Muse Spark 1.3",
  "opencode/muse-spark-1.2-contributor-free": "Muse Spark 1.2",
  "opencode-go/glm-5.3-flash": "GLM 5.3 Flash",
};

/** Read identity from the manifest, not model-name substrings in a run ID.
 * Keep separate launches and differing data/protocol implementations separate. */
export function viewerIdentity(manifest: any) {
  const c = manifest.config;
  const model = c.model ?? (c.kind === "control" ? "deterministic-control" : "unknown-model");
  const cohort = c.runId.replace(/-\d{4}-Q[1-4]$/, "");
  return {
    model, modelName: names[model] ?? model, provider: model.includes("/") ? model.split("/")[0] : model,
    cohort, kind: c.kind,
    cohortId: textHash(canonical({ cohort, model, kind: c.kind, protocol: c.protocol,
      implementation: manifest.implementation?.hash, dataset: c.datasetHash,
      universe: c.universeVersion, history: c.history, limits: c.limits, policy: c.policy })),
  };
}

interface Run extends ReturnType<typeof viewerIdentity> {
  runId: string; start: string; end: string; committed: number; totalDays: number;
  valid: number; invalid: number; state: string;
  funding: Omit<ReturnType<typeof studyFunding>, "daily">;
  days: Array<{ fills: number; failedOrders: number; tools: Record<string, number> }>;
}

export function viewerCohorts<T extends Run>(runs: T[]) {
  const groups = new Map<string, T[]>();
  for (const r of runs) {
    if (!groups.has(r.cohortId)) groups.set(r.cohortId, []);
    groups.get(r.cohortId)!.push(r);
  }
  return [...groups.entries()].map(([id, entries]) => {
    const first = entries[0]!;
    const quarters = EVALUATION_QUARTERS.map(q => {
      const matches = entries.filter(r => r.start === q.start && r.end === q.end);
      return { ...q, expected: exchangeDates(q.start, q.end).length, runIds: matches.map(r => r.runId) };
    });
    const annual = first.kind === "environment" && entries.every(r => quarters.some(q => q.runIds.includes(r.runId)));
    const complete = annual && entries.length === 4 && quarters.every(q => q.runIds.length === 1) &&
      entries.every(r => r.state === "Completed" && r.committed === r.totalDays &&
        r.funding.netProfit !== null && r.funding.totalPrincipal !== null && r.funding.timeWeightedReturnPct !== null);
    const sum = (f: (r: T) => number) => entries.reduce((n, r) => n + f(r), 0);
    const money = (n: number) => Math.round(n * 100) / 100;
    return {
      id, model: first.model, name: first.modelName, provider: first.provider, cohort: first.cohort,
      annual, complete, quarters, runIds: entries.map(r => r.runId),
      expected: annual ? quarters.reduce((n, q) => n + q.expected, 0) : sum(r => r.totalDays),
      committed: sum(r => r.committed), valid: sum(r => r.valid), invalid: sum(r => r.invalid),
      completedQuarters: quarters.filter(q => q.runIds.length === 1 && entries.find(r => r.runId === q.runIds[0])!.state === "Completed").length,
      observedProfit: entries.some(r => r.funding.netProfit !== null) ? money(sum(r => r.funding.netProfit ?? 0)) : null,
      fills: sum(r => r.days.reduce((n, d) => n + d.fills, 0)),
      rejectedOrders: sum(r => r.days.reduce((n, d) => n + d.failedOrders, 0)),
      tools: sum(r => r.days.reduce((n, d) => n + Object.values(d.tools).reduce((a, b) => a + b, 0), 0)),
      year: complete ? {
        netProfit: money(sum(r => r.funding.netProfit!)),
        contributed: money(sum(r => r.funding.totalPrincipal!)),
        meanQuarterTimeWeightedReturnPct: sum(r => r.funding.timeWeightedReturnPct!) / 4,
      } : null,
    };
  });
}
