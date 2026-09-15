#!/usr/bin/env bun
// Live read-only visualizer for study/evaluation runs.
// Usage: bun scripts/visualizer.ts [--port 4173] [--dir results/studies]
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join, resolve } from "node:path";
import { exchangeDates } from "../src/data/calendar.ts";
import { studyFunding, studySession } from "../src/report/studyView.ts";
import { viewerIdentity, viewerCohorts } from "../src/report/evaluationView.ts";
import type { Day } from "../src/study/runner.ts";
import type { JournalEvent } from "../src/study/journal.ts";
import { HTML } from "./visualizer-page.ts";
export { HTML };

interface DaySummary {
  date: string; status: string;
  netWorth: number; cash: number; holdingsValue: number; turnoverPct: number;
  contribution: number; totalPrincipal: number; netProfit: number; dailyProfit: number;
  fills: number; failedOrders: number;
  tools: Record<string, number>; toolErrors: number; attempts: number;
  tags: string[]; reason: string | null;
}
interface RunCache extends ReturnType<typeof viewerIdentity> {
  runId: string; label: string; start: string; end: string; protocol: string;
  committed: number; valid: number; invalid: number; totalDays: number;
  days: DaySummary[];
  timeline: Array<{ date: string; status: string }>;
  funding: Omit<ReturnType<typeof studyFunding>, "daily">;
  state: string; lastEventAt: string | null;
  eventsMtimeMs: number; manifestMtimeMs: number; dir: string;
}

function argsSummary(name: string, a: any): string {
  if (name === "price_history" || name === "market_snapshot") {
    const t: string[] = a?.tickers ?? [];
    const shown = t.slice(0, 6).join(",") + (t.length > 6 ? ` +${t.length - 6}` : "");
    return (name === "price_history" ? `lookback=${a?.lookback} · ` : "") + (t.length ? shown : "full universe");
  }
  if (name === "journal") return ["ticker", "date", "query", "cursor"].filter(k => a?.[k] !== undefined).map(k => `${k}=${a[k]}`).join(" · ") || "browse";
  if (name === "submit_day") return `${a?.orders?.length ?? 0} orders`;
  return "";
}

// Read large audit logs as a stream, retaining only view data. A concurrent
// incomplete final line is retried on the next refresh, never parsed as a record.
async function readViewEvents(path: string, date?: string, compact = false): Promise<JournalEvent[]> {
  const events: JournalEvent[] = [];
  let pending = "";
  const types = new Set(["protocol", "tool_attempt", "tool_result", "tool_refused", "inference_request", "inference_response"]);
  for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
    pending += chunk;
    let end: number;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (!line) continue;
      const e = JSON.parse(line) as JournalEvent;
      if (date && e.scope.date !== date) continue;
      const p = e.payload;
      if (e.kind === "audit" && !types.has(p.type)) {
        // Keep the latest heartbeat without keeping raw provider chunks.
        const last = events.at(-1);
        if (last?.kind === "audit" && last.payload.type === "activity" &&
          last.scope.date === e.scope.date && last.scope.attempt === e.scope.attempt) events.pop();
        e.payload = { type: "activity" };
      } else if (e.kind === "result") {
        e.payload = { outcome: p.outcome, reason: p.reason };
      } else if (compact && e.kind === "audit") {
        e.payload = { type: p.type, name: p.name, providerCallId: p.providerCallId,
          sequence: p.sequence, status: p.status, result: p.result ? { isError: p.result.isError } : undefined };
      }
      events.push(e);
    }
  }
  return events;
}

export async function loadRun(dir: string): Promise<RunCache> {
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  const c = manifest.config;
  const dayFiles = (await readdir(join(dir, "days")).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return [] as string[];
    throw e;
  })).filter(f => f.endsWith(".json")).sort();
  const days: Day[] = await Promise.all(dayFiles.map(async f => JSON.parse(await readFile(join(dir, "days", f), "utf8"))));
  const eventsPath = join(dir, "events.jsonl");
  const st = await stat(eventsPath);
  const events = await readViewEvents(eventsPath, undefined, true);
  const byDate = new Map<string, JournalEvent[]>();
  for (const e of events) {
    if (!byDate.has(e.scope.date)) byDate.set(e.scope.date, []);
    byDate.get(e.scope.date)!.push(e);
  }
  const { daily, ...funding } = studyFunding(days);
  const summaries: DaySummary[] = days.map((d, i) => {
    const r = d.record, detail = studySession(d.date, d, byDate.get(d.date) ?? []);
    const calls = detail.calls.filter(c => c.name !== "inference");
    return { ...daily[i]!, date: d.date, status: d.status,
      netWorth: r.portfolioAfter.netWorth, cash: r.portfolioAfter.cash, holdingsValue: r.portfolioAfter.holdingsValue,
      turnoverPct: r.turnoverPct, fills: r.fills.length, failedOrders: r.failedOrders.length,
      tools: calls.reduce((counts: Record<string, number>, call) => { counts[call.name] = (counts[call.name] ?? 0) + 1; return counts; }, {}),
      toolErrors: calls.filter(call => call.ok === false).length, attempts: detail.attempts.length,
      tags: detail.journal?.tags ?? [], reason: d.reason };
  });
  const dates = exchangeDates(c.start, c.end);
  const committed = new Map(days.map(d => [d.date, d.status]));
  let consecutiveInvalid = 0;
  for (const d of [...days].reverse()) { if (d.status !== "invalid") break; consecutiveInvalid++; }
  const lastEvent = events.at(-1);
  const complete = days.length === dates.length && days.every((d, i) => d.date === dates[i]);
  const state = complete ? "Completed"
    : consecutiveInvalid >= (c.policy?.maxConsecutiveInvalidDays ?? Infinity) ? "Stopped after invalid days"
    : lastEvent && !committed.has(lastEvent.scope.date) ? "Uncommitted attempt" : "Incomplete";
  return { ...viewerIdentity(manifest), runId: c.runId, label: c.runId.match(/(\d{4}-Q[1-4])$/)?.[1] ?? c.runId,
    start: c.start, end: c.end, protocol: c.protocol, committed: days.length,
    valid: days.filter(d => d.status === "completed").length, invalid: days.filter(d => d.status === "invalid").length,
    totalDays: dates.length, days: summaries, funding,
    timeline: dates.map(date => ({ date, status: committed.get(date) ?? (byDate.has(date) ? "uncommitted" : "unattempted") })),
    state, lastEventAt: lastEvent?.recordedAt ?? null, eventsMtimeMs: st.mtimeMs,
    manifestMtimeMs: (await stat(join(dir, "manifest.json"))).mtimeMs, dir };
}

export async function dayDetail(dir: string, date: string, funding?: DaySummary) {
  const events = await readViewEvents(join(dir, "events.jsonl"), date);
  const raw = await readFile(join(dir, "days", `${date}.json`), "utf8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  const detail = studySession(date, raw ? JSON.parse(raw) : undefined, events);
  return { ...detail, totalPrincipal: funding?.totalPrincipal ?? null, netProfit: funding?.netProfit ?? null,
    calls: detail.calls.map(c => ({ ...c, args: argsSummary(c.name, c.raw) })),
    attempts: detail.attempts.map(a => ({ ...a, calls: a.calls.map(c => ({ ...c, args: argsSummary(c.name, c.raw) })) })) };
}

export function createVisualizer(studies: string) {
  const caches = new Map<string, RunCache>();
  let loading: Promise<RunCache[]> | undefined;
  async function loadRuns() {
    const dirs = (await readdir(studies, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return [];
      throw e;
    })).filter(d => d.isDirectory() || d.isSymbolicLink());
    const runs: RunCache[] = [];
    for (const entry of dirs) {
      if (entry.name.startsWith("test-")) continue;
      const dir = join(studies, entry.name);
      try {
        const manifest = await stat(join(dir, "manifest.json")), events = await stat(join(dir, "events.jsonl"));
        const prev = caches.get(dir);
        const count = (await readdir(join(dir, "days")).catch(() => [] as string[])).filter(f => f.endsWith(".json")).length;
        if (!prev || prev.eventsMtimeMs !== events.mtimeMs || prev.manifestMtimeMs !== manifest.mtimeMs || prev.committed !== count)
          caches.set(dir, await loadRun(dir));
        runs.push(caches.get(dir)!);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        // A just-created run may not have published its manifest/event log yet.
      }
    }
    for (const [dir, run] of caches) if (!runs.includes(run)) caches.delete(dir);
    return runs.sort((a, b) => a.modelName.localeCompare(b.modelName) || a.cohort.localeCompare(b.cohort) || a.start.localeCompare(b.start));
  }
  const getRuns = () => loading ??= loadRuns().finally(() => { loading = undefined; });
  const json = (res: ServerResponse, body: unknown) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://viewer");
    try {
      if (url.pathname === "/api/runs") {
        const runs = (await getRuns()).map(r => ({ ...r, dir: undefined }));
        return json(res, { runs, cohorts: viewerCohorts(runs) });
      }
      const m = url.pathname.match(/^\/api\/run\/([^/]+)\/(\d{4}-\d{2}-\d{2})$/);
      if (m) {
        const run = (await getRuns()).find(r => r.runId === decodeURIComponent(m[1]!));
        if (!run || !run.timeline.some(d => d.date === m[2])) { res.writeHead(404); return res.end("unknown run or session"); }
        return json(res, await dayDetail(run.dir, m[2]!, run.days.find(d => d.date === m[2])));
      }
      if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(HTML); }
      res.writeHead(404); res.end("not found");
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
  });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const port = args.includes("--port") ? Number(args[args.indexOf("--port") + 1]) : 4173;
  const dir = args.includes("--dir") ? args[args.indexOf("--dir") + 1] : "results/studies";
  if (!dir) throw new Error("--dir requires a study directory");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid --port");
  createVisualizer(resolve(dir)).listen(port, () => console.log(`visualizer on port ${port}`));
}
