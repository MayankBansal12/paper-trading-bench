import type { Day } from "../study/runner.ts";
import type { JournalEvent } from "../study/journal.ts";
import { computeMetrics } from "../engine/metrics.ts";

const money = (n: number) => Math.round(n * 100) / 100;

/** Capital comes from the recorded opening account, including for older cohorts. */
export function studyFunding(days: readonly Day[]) {
  const startingCapital = days[0]?.record.portfolioBefore.netWorth ?? null;
  let principal = startingCapital ?? 0;
  const daily = days.map(({ record: r }) => {
    const contribution = r.contribution ?? 0;
    principal = money(principal + contribution);
    return {
      date: r.date,
      contribution,
      totalPrincipal: principal,
      netProfit: money(r.portfolioAfter.netWorth - principal),
      dailyProfit: money(r.portfolioAfter.netWorth - r.portfolioBefore.netWorth - contribution),
    };
  });
  const metrics = startingCapital === null ? null : computeMetrics(
    days.map(({ record: r }) => ({ date: r.date, netWorth: r.portfolioAfter.netWorth, contribution: r.contribution })),
    startingCapital,
    days.reduce((n, d) => n + d.record.fills.length, 0),
    days.reduce((n, d) => n + d.record.failedOrders.length, 0),
    0,
    days.map(d => d.record.turnoverPct),
  );
  const totalPrincipal = metrics?.totalContributions ?? null;
  const netProfit = metrics?.netProfit ?? null;
  return {
    startingCapital,
    totalPrincipal,
    netProfit,
    returnOnPrincipalPct: totalPrincipal && netProfit !== null ? netProfit / totalPrincipal * 100 : null,
    timeWeightedReturnPct: metrics?.timeWeightedReturnPct ?? null,
    daily,
  };
}

export interface ViewerCall {
  seq: number;
  attempt: number;
  name: string;
  providerCallId?: string;
  raw: unknown;
  result?: unknown;
  ok: boolean | null;
  ms: number | null;
  at: string;
  httpStatus?: number;
}

/** Results have their own event sequence. Pair tools within each attempt in
 * broker order; provider HTTP request numbers are a separate namespace. */
export function studySession(date: string, day: Day | undefined, events: readonly JournalEvent[]) {
  const attempts = new Map<number, {
    attempt: number;
    outcome: string;
    reason: string | null;
    accepted: boolean;
    startedAt: string | null;
    endedAt: string | null;
    calls: ViewerCall[];
    submissions: Array<{ hash: string; accepted: boolean; orders: unknown; journal: any }>;
  }>();
  const pendingTools = new Map<number, ViewerCall[]>();
  const inference = new Map<string, ViewerCall>();
  let journal: any = null;
  let openingPortfolio: any = null;
  let lastEventAt: string | null = null;
  for (const e of events) {
    if (e.scope.date !== date) continue;
    lastEventAt = e.recordedAt;
    const number = e.scope.attempt;
    if (!attempts.has(number)) {
      attempts.set(number, { attempt: number, outcome: "in_progress", reason: null,
        accepted: false, startedAt: null, endedAt: null, calls: [], submissions: [] });
      pendingTools.set(number, []);
    }
    const a = attempts.get(number)!;
    const p = e.payload;
    if (e.kind === "begin") a.startedAt = e.recordedAt;
    if (e.kind === "result" || e.kind === "failed") {
      a.outcome = e.kind === "failed" ? "interrupted" : p.outcome;
      a.reason = p.reason ?? null;
      a.endedAt = e.recordedAt;
    }
    if (e.kind === "submission") {
      const accepted = day?.status === "completed" && e.hash === day.submissionEventHash;
      a.submissions.push({ hash: e.hash, accepted, orders: p.orders, journal: p.journal });
      if (accepted) { a.accepted = true; journal = p.journal; }
    }
    if (e.kind !== "audit") continue;
    if (p.type === "protocol") openingPortfolio = p.openingPortfolio?.data ?? openingPortfolio;
    if (p.type === "tool_attempt") {
      const c: ViewerCall = { seq: e.sequence, attempt: number, name: p.name,
        providerCallId: p.providerCallId, raw: p.arguments ?? {}, ok: null, ms: null, at: e.recordedAt };
      a.calls.push(c);
      pendingTools.get(number)!.push(c);
    } else if (p.type === "tool_result" || p.type === "tool_refused") {
      const pending = pendingTools.get(number)!;
      const i = pending.findIndex(c => c.name === p.name &&
        (!p.providerCallId || c.providerCallId === p.providerCallId));
      if (i >= 0) {
        const c = pending.splice(i, 1)[0]!;
        c.result = p.result ?? { error: p.reason ?? "Tool refused" };
        c.ok = p.type !== "tool_refused" && !p.result?.isError;
        c.ms = Math.max(0, Date.parse(e.recordedAt) - Date.parse(c.at));
      }
    } else if (p.type === "inference_request") {
      const c: ViewerCall = { seq: e.sequence, attempt: number, name: "inference",
        raw: { model: p.model, route: p.route, request: p.sequence }, ok: null, ms: null, at: e.recordedAt };
      a.calls.push(c);
      inference.set(`${number}:${p.sequence}`, c);
    } else if (p.type === "inference_response") {
      const c = inference.get(`${number}:${p.sequence}`);
      if (c) { c.httpStatus = p.status; }
    }
  }
  const rows = [...attempts.values()].sort((a, b) => a.attempt - b.attempt);
  const r = day?.record;
  return {
    date,
    status: day?.status ?? (rows.length ? "uncommitted" : "unattempted"),
    reason: day?.reason ?? null,
    before: r?.portfolioBefore ?? openingPortfolio,
    after: r?.portfolioAfter ?? null,
    contribution: r?.contribution ?? null,
    dailyProfit: r ? money(r.portfolioAfter.netWorth - r.portfolioBefore.netWorth - (r.contribution ?? 0)) : null,
    fills: r?.fills ?? [],
    failedOrders: r?.failedOrders ?? [],
    turnoverPct: r?.turnoverPct ?? null,
    journal,
    attempts: rows,
    calls: rows.flatMap(a => a.calls),
    lastEventAt,
  };
}
