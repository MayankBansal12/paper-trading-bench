#!/usr/bin/env bun
// Live read-only visualizer for study/evaluation runs.
// Usage: bun scripts/visualizer.ts [--port 4173] [--dir results/studies]
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { exchangeDates } from "../src/data/calendar.ts";
import { studyFunding, studySession } from "../src/report/studyView.ts";
import type { Day } from "../src/study/runner.ts";
import type { JournalEvent } from "../src/study/journal.ts";

const args = process.argv.slice(2);
const port = args.includes("--port") ? Number(args[args.indexOf("--port") + 1]) : 4173;
const dirArg = args.includes("--dir") ? args[args.indexOf("--dir") + 1] : "results/studies";
if (!dirArg) throw new Error("--dir requires a study directory");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid --port");
const STUDIES = resolve(dirArg);

interface DaySummary {
  date: string; status: string;
  netWorth: number; cash: number; holdingsValue: number; turnoverPct: number;
  fills: number; failedOrders: number;
  contribution: number; totalPrincipal: number; netProfit: number; dailyProfit: number;
  tools: Record<string, number>; toolErrors: number; attempts: number;
  tags: string[]; reason: string | null;
}
interface RunCache {
  runId: string; label: string; start: string; end: string; protocol: string;
  committed: number; valid: number; invalid: number; totalDays: number;
  days: DaySummary[];
  timeline: Array<{ date: string; status: string }>;
  funding: Omit<ReturnType<typeof studyFunding>, "daily">;
  state: string; lastEventAt: string | null;
  eventsMtimeMs: number; dir: string;
}
const caches = new Map<string, RunCache>();

function quarterLabel(runId: string) {
  const m = runId.match(/(\d{4}-Q\d)$/);
  return m ? m[1]! : runId;
}
function argsSummary(name: string, a: any): string {
  try {
    if (name === "price_history") {
      const t: string[] = a?.tickers ?? [];
      const shown = t.length > 6 ? t.slice(0, 6).join(",") + ` +${t.length - 6}` : t.join(",");
      return `lookback=${a?.lookback}${t.length ? ` · [${shown}]` : ""}`;
    }
    if (name === "market_snapshot") {
      const t: string[] = a?.tickers ?? [];
      return t.length ? (t.length > 6 ? t.slice(0, 6).join(",") + ` +${t.length - 6}` : t.join(",")) : "full universe";
    }
    if (name === "journal") {
      const parts: string[] = [];
      if (a?.ticker) parts.push(`ticker=${a.ticker}`);
      if (a?.date) parts.push(`date=${a.date}`);
      if (a?.query) parts.push(`query="${a.query}"`);
      if (a?.cursor) parts.push(`cursor=${a.cursor}`);
      return parts.join(" · ") || "browse";
    }
    if (name === "submit_day") {
      const o: any[] = a?.orders ?? [];
      const brief = o.slice(0, 4).map((x: any) =>
        `${x.side} ${x.ticker} ${x.units !== undefined ? x.units + "u" : "$" + x.notionalUsd}`).join("; ");
      return `${o.length} orders${o.length ? ": " + brief : " (hold)"}`;
    }
  } catch { /* fallthrough */ }
  return "";
}

function parseEvents(text: string): JournalEvent[] {
  // A concurrent append can leave an incomplete final line in this read.
  const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
  return complete.split("\n").filter(Boolean).map(line => JSON.parse(line));
}

async function loadRun(dir: string): Promise<RunCache> {
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  const runId: string = manifest.config.runId;
  const dayFiles = (await readdir(join(dir, "days")).catch(() => [] as string[]))
    .filter(f => f.endsWith(".json")).sort();
  const days: Day[] = await Promise.all(dayFiles.map(async f =>
    JSON.parse(await readFile(join(dir, "days", f), "utf8"))));
  const eventsPath = join(dir, "events.jsonl");
  const st = await stat(eventsPath);
  const events = parseEvents(await readFile(eventsPath, "utf8"));
  const byDate = new Map<string, JournalEvent[]>();
  for (const e of events) {
    if (!byDate.has(e.scope.date)) byDate.set(e.scope.date, []);
    byDate.get(e.scope.date)!.push(e);
  }
  const { daily, ...funding } = studyFunding(days);
  const summaries: DaySummary[] = days.map((d, i) => {
    const r = d.record;
    const detail = studySession(d.date, d, byDate.get(d.date) ?? []);
    const calls = detail.calls.filter(c => c.name !== "inference");
    return {
      ...daily[i]!, date: d.date, status: d.status,
      netWorth: r.portfolioAfter.netWorth, cash: r.portfolioAfter.cash,
      holdingsValue: r.portfolioAfter.holdingsValue, turnoverPct: r.turnoverPct,
      fills: r.fills.length, failedOrders: r.failedOrders.length,
      tools: calls.reduce((counts: Record<string, number>, c) => {
        counts[c.name] = (counts[c.name] ?? 0) + 1; return counts;
      }, {}),
      toolErrors: calls.filter(c => c.ok === false).length,
      attempts: detail.attempts.length, tags: detail.journal?.tags ?? [], reason: d.reason,
    };
  });
  const dates = exchangeDates(manifest.config.start, manifest.config.end);
  const committed = new Map(days.map(d => [d.date, d.status]));
  let consecutiveInvalid = 0;
  for (const d of [...days].reverse()) {
    if (d.status !== "invalid") break;
    consecutiveInvalid++;
  }
  const lastEvent = events.at(-1);
  const state = days.length === dates.length ? "Completed"
    : consecutiveInvalid >= (manifest.config.policy?.maxConsecutiveInvalidDays ?? Infinity) ? "Stopped after invalid days"
    : lastEvent && !committed.has(lastEvent.scope.date) ? "Uncommitted attempt"
    : "Incomplete";
  return {
    runId, label: quarterLabel(runId), start: manifest.config.start, end: manifest.config.end,
    protocol: manifest.config.protocol, committed: days.length,
    valid: days.filter(d => d.status === "completed").length,
    invalid: days.filter(d => d.status === "invalid").length,
    totalDays: dates.length, days: summaries, funding,
    timeline: dates.map(date => ({ date, status: committed.get(date) ?? (byDate.has(date) ? "uncommitted" : "unattempted") })),
    state, lastEventAt: lastEvent?.recordedAt ?? null, eventsMtimeMs: st.mtimeMs, dir,
  };
}

async function getRuns(): Promise<RunCache[]> {
  const dirs = (await readdir(STUDIES, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name);
  const runs: RunCache[] = [];
  for (const name of dirs) {
    if (name.startsWith("test-")) continue;
    const dir = join(STUDIES, name);
    try {
      await stat(join(dir, "manifest.json"));
      const events = await stat(join(dir, "events.jsonl"));
      const prev = caches.get(dir);
      if (!prev || prev.eventsMtimeMs !== events.mtimeMs || prev.committed !== (await readdir(join(dir, "days")).catch(() => [] as string[])).filter(f => f.endsWith(".json")).length) {
        caches.set(dir, await loadRun(dir));
      }
      runs.push(caches.get(dir)!);
    } catch { /* not a run dir */ }
  }
  runs.sort((a, b) => a.runId.localeCompare(b.runId));
  return runs;
}

async function dayDetail(dir: string, date: string) {
  const events = parseEvents(await readFile(join(dir, "events.jsonl"), "utf8"));
  const raw = await readFile(join(dir, "days", `${date}.json`), "utf8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  const detail = studySession(date, raw ? JSON.parse(raw) : undefined, events);
  const funding = caches.get(dir)?.days.find(d => d.date === date);
  return {
    ...detail, totalPrincipal: funding?.totalPrincipal ?? null, netProfit: funding?.netProfit ?? null,
    calls: detail.calls.map(c => ({ ...c, args: argsSummary(c.name, c.raw) })),
    attempts: detail.attempts.map(a => ({ ...a, calls: a.calls.map(c => ({ ...c, args: argsSummary(c.name, c.raw) })) })),
  };
}

function json(res: ServerResponse, body: unknown) {
  res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  try {
    if (url.pathname === "/api/runs") return json(res, { runs: (await getRuns()).map(r => ({ ...r, dir: undefined })) });
    const m = url.pathname.match(/^\/api\/run\/([^/]+)\/(\d{4}-\d{2}-\d{2})$/);
    if (m) {
      const runs = await getRuns();
      const run = runs.find(r => r.runId === decodeURIComponent(m[1]!));
      if (!run || !run.timeline.some(d => d.date === m[2])) { res.writeHead(404); return res.end("unknown run or session"); }
      return json(res, await dayDetail(run.dir, m[2]!));
    }
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(HTML);
    }
    res.writeHead(404); res.end("not found");
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  }
});

export const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Paper Trading Bench — Live Runs</title>
<style>
:root{
  --bg:#0d1117;--panel:#151b23;--panel2:#1a212b;--border:#242d38;--text:#e6edf3;
  --muted:#8b949e;--accent:#4ea1ff;--green:#3fb950;--red:#f85149;--amber:#d29922;--violet:#a371f7;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:var(--sans);font-size:14px;line-height:1.5}
header{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:12px;padding:10px 20px;
  background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--border)}
header h1{font-size:15px;font-weight:600}
header .sub{color:var(--muted);font-size:12px}
.live{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--green)}
.live .dot{width:8px;height:8px;border-radius:50%;background:var(--green);animation:pulse 1.6s infinite}
.live.done .dot{background:var(--accent);animation:none}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
#updated{margin-left:auto;color:var(--muted);font-size:12px;font-family:var(--mono)}
.layout{display:grid;grid-template-columns:280px minmax(0,1fr);gap:16px;padding:16px 20px;max-width:1500px;margin:0 auto}
@media(max-width:900px){.layout{grid-template-columns:minmax(0,1fr)}}
main,.sidebar{min-width:0}
.sidebar{display:flex;flex-direction:column;gap:10px}
.run-card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:12px 14px;cursor:pointer;transition:border-color .15s}
.run-card:hover{border-color:var(--accent)}
.run-card.active{border-color:var(--accent);background:var(--panel2)}
.run-card .rl{font-weight:600;font-size:14px;display:flex;justify-content:space-between;align-items:center}
.run-card .rs{color:var(--muted);font-size:12px;margin-top:2px;font-family:var(--mono)}
.bar{height:6px;border-radius:3px;background:#232b36;margin-top:8px;overflow:hidden}
.bar>i{display:block;height:100%;background:linear-gradient(90deg,var(--accent),var(--violet));border-radius:3px;transition:width .4s}
.kpis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:14px}
.kpi{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:12px 14px}
.kpi .k{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em}
.kpi .v{font-size:20px;font-weight:600;font-family:var(--mono);margin-top:2px}
.kpi .d{font-size:11px;color:var(--muted);margin-top:4px}
@media(max-width:1100px){.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:480px){.kpis{grid-template-columns:1fr}}
.status-line{color:var(--muted);font-size:12px;margin:-3px 0 14px}
.attempt{border:1px solid var(--border);border-radius:8px;padding:12px;margin-top:12px}
.attempt h4{font-size:13px;margin-bottom:6px}
details{max-width:650px;white-space:normal}summary{cursor:pointer;color:var(--accent)}
pre.payload{max-height:320px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--bg);padding:10px;margin:6px 0;font-size:11px}
.attempt table{min-width:600px}
.tl.pending{border:1.5px dashed var(--amber);background:transparent}
.tl.future{border:1px solid var(--border);background:transparent;opacity:.5}
.tl.selected{outline:2px solid var(--accent)}
.pos{color:var(--green)}.neg{color:var(--red)}
.card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-bottom:14px}
.card h2{font-size:13px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px}
canvas{width:100%;height:260px;display:block}
.timeline{display:flex;flex-wrap:wrap;gap:3px}
.tl{width:16px;height:16px;border-radius:4px;background:#232b36;cursor:pointer;position:relative}
.tl.b{background:var(--green)}.tl.s{background:var(--red)}.tl.bs{background:var(--accent)}
.tl.x{background:transparent;border:1.5px dashed var(--red)}
.tl:hover{outline:2px solid var(--accent)}
.sessions{max-height:340px;overflow-y:auto}
table{width:100%;border-collapse:collapse;font-family:var(--mono);font-size:12.5px}
th{color:var(--muted);text-align:left;font-weight:500;padding:6px 10px;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--panel);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
td{padding:6px 10px;border-bottom:1px solid #1c232d;cursor:pointer;white-space:nowrap}
tr:hover td{background:var(--panel2)}
.pill{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;font-family:var(--sans)}
.pill.ok{background:#12301c;color:var(--green)}.pill.x{background:#3a1518;color:var(--red)}
.tag{display:inline-block;background:#1c2740;color:var(--accent);border:1px solid #274067;border-radius:10px;padding:1px 9px;font-size:11px;margin:2px 4px 2px 0;font-family:var(--mono)}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:flex-start;justify-content:center;z-index:50;overflow-y:auto;padding:40px 16px}
.overlay.open{display:flex}
.modal{background:var(--panel);border:1px solid var(--border);border-radius:12px;max-width:980px;width:100%;padding:20px 24px}
.modal h3{font-size:16px;margin-bottom:4px;display:flex;align-items:center;gap:10px}
.modal .close{margin-left:auto;cursor:pointer;color:var(--muted);border:1px solid var(--border);border-radius:6px;padding:2px 10px;background:none;font-size:13px}
.modal .close:hover{color:var(--text)}
.sect{margin-top:16px}
.sect h4{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px}
pre.journal{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px;font-family:var(--mono);font-size:12px;white-space:pre-wrap;word-break:break-word;max-height:260px;overflow-y:auto}
.holdings{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:760px){.holdings{grid-template-columns:1fr}}
.mini{font-size:12px}
.legend{display:flex;gap:14px;margin-top:8px;font-size:11px;color:var(--muted);flex-wrap:wrap}
.legend span{display:inline-flex;align-items:center;gap:5px}
.sw{width:10px;height:10px;border-radius:3px;display:inline-block}
.empty{color:var(--muted);font-style:italic;font-size:13px}
.loading{padding:60px;text-align:center;color:var(--muted)}
footer{color:var(--muted);font-size:12px;text-align:center;padding:10px 0 30px}
</style>
</head>
<body>
<header>
  <h1>Paper Trading Bench</h1>
  <span class="live" id="live"><span class="dot"></span><span id="liveText">loading</span></span>
  <span id="updated"></span>
</header>
<div class="layout">
  <aside class="sidebar" id="runList"><div class="loading">Loading runs…</div></aside>
  <main id="main"><div class="loading">Select a run</div></main>
</div>
<div class="overlay" id="overlay"><div class="modal" id="modal"></div></div>
<footer>read-only live view of results/studies · refreshes every 5s</footer>
<script>
var state = { runs: [], current: null, detail: null, timer: null, refreshing: false };

function fmt(n, d) { return n == null ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: d === undefined ? 0 : d }); }
function pct(n) { return n == null ? "—" : (n >= 0 ? "+" : "") + n.toFixed(2) + "%"; }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

async function api(path) { const r = await fetch(path); if (!r.ok) throw new Error(await r.text()); return r.json(); }

function renderSidebar() {
  var el = document.getElementById("runList");
  el.innerHTML = state.runs.map(function (r, i) {
    var exp = expected(r);
    var p = exp ? Math.min(100, r.committed / exp * 100) : 0;
    var last = r.days.length ? r.days[r.days.length - 1].date : "—";
    return '<div class="run-card' + (state.current === i ? " active" : "") + '" onclick="select(' + i + ')">' +
      '<div class="rl">' + esc(r.label) + '<span class="rs">' + r.committed + "/" + exp + "</span></div>" +
      '<div class="rs">' + esc(r.runId.slice(0, 34)) + "…</div>" +
      '<div class="bar"><i style="width:' + p.toFixed(1) + '%"></i></div>' +
      '<div class="rs" style="margin-top:6px">' + esc(r.state) + " · " + r.valid + " valid · " + r.invalid + " invalid</div>" +
      '<div class="rs">accounted through ' + last + "</div></div>";
  }).join("");
}
function expected(r) { return r.totalDays; }

function select(i) { closeModal(); state.current = i; renderSidebar(); renderMain(); }

function classify(d) {
  if (d.status === "unattempted") return "future";
  if (d.status === "uncommitted") return "pending";
  if (d.status === "invalid") return "x";
  return d.fills > 0 ? "bs" : "";
}
function renderMain() {
  var el = document.getElementById("main");
  var r = state.runs[state.current];
  if (!r) { el.innerHTML = '<div class="loading">No runs found yet</div>'; return; }
  var days = r.days, last = days[days.length - 1], f = r.funding;
  var ret = f.returnOnPrincipalPct;
  var cashPct = last ? last.cash / Math.max(last.netWorth, 1) * 100 : null;
  var totalFills = days.reduce(function (s, d) { return s + d.fills; }, 0);
  var exp = expected(r);
  var byDate = {}; days.forEach(function (d) { byDate[d.date] = d; });
  el.innerHTML =
    '<div class="kpis">' +
      kpi("Net worth", last ? "$" + fmt(last.netWorth, 2) : "—", "", "Cash + holdings") +
      kpi("Total principal", f.totalPrincipal == null ? "—" : "$" + fmt(f.totalPrincipal, 2), "", "Opening capital + credited deposits") +
      kpi("Net profit", f.netProfit == null ? "—" : (f.netProfit >= 0 ? "+$" : "−$") + fmt(Math.abs(f.netProfit), 2), f.netProfit >= 0 ? "pos" : "neg", "Net worth − total principal") +
      kpi("Return on principal", pct(ret), ret >= 0 ? "pos" : "neg", "Net profit / total principal") +
      kpi("Cash allocation", cashPct == null ? "—" : fmt(cashPct, 2) + "%", "", "Share of net worth") +
      kpi("Accounted sessions", r.committed + " / " + exp, "", r.valid + " valid · " + r.invalid + " invalid · " + totalFills + " fills") +
    '</div><div class="status-line">Time-weighted return: ' + pct(f.timeWeightedReturnPct) +
      ' (adjusts for deposit timing) · Values through ' + (last ? last.date + " close" : "first committed session pending") +
      (r.lastEventAt ? ' · Last event: ' + esc(new Date(r.lastEventAt).toLocaleString()) : "") + '</div>' +
    '<div class="card"><h2>Net worth &amp; cash allocation</h2><canvas id="chart"></canvas>' +
      '<div class="legend"><span><i class="sw" style="background:var(--accent)"></i>net worth</span>' +
      '<span><i class="sw" style="background:var(--amber);opacity:.45"></i>cash % (right axis)</span>' +
      '<span><i class="sw" style="background:#758396"></i>total principal</span></div></div>' +
    '<div class="card"><h2>Session timeline</h2><div class="timeline">' +
      r.timeline.map(function (t) {
        var d = byDate[t.date] || t;
        var cls = classify(d) + (state.detail && state.detail.date === d.date ? " selected" : "");
        return '<div class="tl ' + cls + '" data-date="' + d.date + '" title="' + d.date + " · " + d.status +
          (d.netWorth == null ? "" : " · $" + fmt(d.netWorth)) + '"></div>';
      }).join("") +
      '</div><div class="legend">' +
      '<span><i class="sw" style="background:#232b36"></i>valid, no fills</span>' +
      '<span><i class="sw" style="background:var(--accent)"></i>traded</span>' +
      '<span><i class="sw" style="border:1.5px dashed var(--red)"></i>invalid</span>' +
      '<span><i class="sw" style="border:1.5px dashed var(--amber)"></i>uncommitted</span>' +
      '<span><i class="sw" style="border:1px solid var(--border)"></i>unattempted</span></div></div>' +
    '<div class="card"><h2>Accounted sessions</h2><div class="sessions"><table><thead><tr>' +
      '<th>Date</th><th>Status</th><th>Net worth</th><th>Deposit</th><th>Day P/L</th><th>Cash %</th><th>Fills</th><th>Attempts</th><th>Tool calls</th><th>Journal</th></tr></thead><tbody>' +
      days.map(function (d) {
        var tools = 0; for (var k in d.tools) tools += d.tools[k];
        return '<tr data-date="' + d.date + '"><td>' + d.date + '</td>' +
          '<td><span class="pill ' + (d.status === "completed" ? "ok" : "x") + '">' + d.status + '</span></td>' +
          '<td>' + fmt(d.netWorth, 2) + '</td><td>' + (d.contribution ? "+" + fmt(d.contribution, 2) : "—") + '</td>' +
          '<td class="' + (d.dailyProfit >= 0 ? "pos" : "neg") + '">' + (d.dailyProfit >= 0 ? "+" : "") + fmt(d.dailyProfit, 2) + '</td>' +
          '<td>' + (d.cash / Math.max(d.netWorth, 1) * 100).toFixed(1) + '%</td><td>' + d.fills + '</td><td>' + d.attempts + '</td>' +
          '<td>' + tools + (d.toolErrors ? ' <span class="neg">' + d.toolErrors + ' errors</span>' : '') + '</td>' +
          '<td>' + (d.tags.length ? d.tags.slice(0, 2).map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('') : '—') + '</td></tr>';
      }).join('') + '</tbody></table></div><div class="legend">Day P/L excludes deposits and includes dividends and changes in holdings value. Tool counts include all attempts.</div></div>';
  drawChart(days);
}

function kpi(k, v, cls, note) {
  return '<div class="kpi"><div class="k">' + esc(k) + '</div><div class="v ' + cls + '">' + esc(v) +
    '</div><div class="d">' + esc(note || '') + '</div></div>';
}

function drawChart(days) {
  var c = document.getElementById("chart");
  if (!c || !days.length) return;
  var dpr = window.devicePixelRatio || 1;
  var W = c.clientWidth, H = c.clientHeight;
  c.width = W * dpr; c.height = H * dpr;
  var ctx = c.getContext("2d");
  ctx.scale(dpr, dpr);
  var padL = 62, padR = 54, padT = 14, padB = 24;
  var iw = W - padL - padR, ih = H - padT - padB;
  var funding = days.map(function (d) { return d.totalPrincipal; });
  var vals = days.map(function (d) { return d.netWorth; }).concat(funding);
  var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
  var pad = (max - min) * 0.08 || 1000; min -= pad; max += pad;
  var maxCash = 100;
  function x(i) { return padL + (days.length === 1 ? iw / 2 : i / (days.length - 1) * iw); }
  function y(v) { return padT + (1 - (v - min) / (max - min)) * ih; }
  function yc(v) { return padT + (1 - v / maxCash) * ih; }
  ctx.clearRect(0, 0, W, H);
  ctx.font = "10px ui-monospace,monospace";
  // grid
  ctx.strokeStyle = "#202833"; ctx.fillStyle = "#8b949e";
  for (var g = 0; g <= 4; g++) {
    var v = min + (max - min) * g / 4;
    ctx.beginPath(); ctx.moveTo(padL, y(v)); ctx.lineTo(W - padR, y(v)); ctx.stroke();
    ctx.fillText(fmt(v), 8, y(v) + 3);
  }
  for (var g2 = 0; g2 <= 4; g2++) { ctx.fillText(g2 * 25 + "%", W - padR + 6, yc(g2 * 25) + 3); }
  // cash area
  ctx.beginPath();
  days.forEach(function (d, i) { var px = x(i), py = yc(d.netWorth ? d.cash / d.netWorth * 100 : 0); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
  ctx.lineTo(x(days.length - 1), padT + ih); ctx.lineTo(x(0), padT + ih); ctx.closePath();
  ctx.fillStyle = "rgba(210,153,34,.13)"; ctx.fill();
  ctx.beginPath();
  days.forEach(function (d, i) { var px = x(i), py = yc(d.netWorth ? d.cash / d.netWorth * 100 : 0); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
  ctx.strokeStyle = "rgba(210,153,34,.5)"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
  // funding baseline
  ctx.beginPath();
  funding.forEach(function (v, i) { i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(0), y(v)); });
  ctx.strokeStyle = "#758396"; ctx.setLineDash([2, 4]); ctx.stroke(); ctx.setLineDash([]);
  // net worth line
  var grad = ctx.createLinearGradient(padL, 0, W - padR, 0);
  grad.addColorStop(0, "#4ea1ff"); grad.addColorStop(1, "#a371f7");
  ctx.beginPath();
  days.forEach(function (d, i) { i ? ctx.lineTo(x(i), y(d.netWorth)) : ctx.moveTo(x(i), y(d.netWorth)); });
  ctx.strokeStyle = grad; ctx.lineWidth = 2; ctx.stroke();
  // last point
  ctx.beginPath(); ctx.arc(x(days.length - 1), y(days[days.length - 1].netWorth), 3.5, 0, 7);
  ctx.fillStyle = "#a371f7"; ctx.fill();
  // x labels
  ctx.fillStyle = "#8b949e";
  [0, Math.floor(days.length / 2), days.length - 1].forEach(function (i) { ctx.fillText(days[i].date, x(i) - 24, H - 6); });
}

function payload(value) {
  var readable = value && Array.isArray(value.content) ? value.content.map(function (block) {
    if (block.type !== 'text') return block;
    try { return JSON.parse(block.text); } catch (_) { return block.text; }
  }) : value;
  return '<pre class="payload">' + esc(JSON.stringify(readable, null, 2)) + '</pre>';
}
function renderCalls(calls) {
  if (!calls.length) return '<div class="empty">No calls recorded.</div>';
  return '<div class="sessions"><table><thead><tr><th>#</th><th>Tool / request</th><th>Arguments &amp; response</th><th>Status</th><th>Tool ms</th></tr></thead><tbody>' +
    calls.map(function (c) {
      var status = c.name === "inference" ? (c.httpStatus == null ? "Awaiting headers" : "HTTP " + c.httpStatus) : (c.ok === null ? "No result" : c.ok ? "ok" : "error");
      return '<tr><td>' + c.seq + '</td><td>' + esc(c.name) + '</td><td><details><summary>' + esc(c.args || 'Request details') + '</summary>' +
        '<div class="mini">Arguments</div>' + payload(c.raw) + (c.result === undefined ? '' : '<div class="mini">Result</div>' + payload(c.result)) +
        '</details></td><td class="' + (c.ok === false || c.httpStatus >= 400 ? 'neg' : '') + '">' + status + '</td><td>' + fmt(c.ms) + '</td></tr>';
    }).join('') + '</tbody></table></div>';
}
function renderAttempt(a) {
  var label = a.accepted ? 'Committed decision' : a.outcome === 'in_progress' ? 'Unfinished' : 'Not committed';
  return '<div class="attempt"><h4>Attempt ' + a.attempt + ' · ' + label + '</h4>' +
    '<div class="mini">' + esc(a.outcome) + (a.reason ? ' · ' + esc(a.reason) : '') + '</div>' +
    '<div class="mini" style="color:var(--muted)">' + esc(a.startedAt || '') + (a.endedAt ? ' → ' + esc(a.endedAt) : '') + '</div>' +
    a.submissions.filter(function (s) { return !s.accepted; }).map(function (s) {
      return '<details style="margin:10px 0"><summary>Uncommitted submission — orders and journal</summary>' + payload(s.orders) +
        '<pre class="journal">' + esc(s.journal.text) + '</pre></details>';
    }).join('') + renderCalls(a.calls) + '</div>';
}
async function showDetail(date, quiet) {
  var r = state.runs[state.current];
  if (!r) return;
  var selected = r.runId + '/' + date;
  state.detail = { runId: r.runId, date: date };
  document.getElementById('overlay').classList.add('open');
  var m = document.getElementById('modal');
  if (!quiet) m.innerHTML = '<div class="loading">Loading ' + date + '…</div>';
  try {
    var d = await api('/api/run/' + encodeURIComponent(r.runId) + '/' + date);
    if (!state.detail || state.detail.runId + '/' + state.detail.date !== selected) return;
    var calls = d.calls.filter(function (c) { return c.name !== 'inference'; });
    var inf = d.calls.length - calls.length;
    var finance = d.after ? 'Net worth $' + fmt(d.after.netWorth, 2) + ' · principal $' + fmt(d.totalPrincipal, 2) +
      ' · day P/L $' + fmt(d.dailyProfit, 2) + ' · deposit $' + fmt(d.contribution, 2) : 'No committed closing balance for this session.';
    m.innerHTML = '<h3>' + d.date + ' <span class="pill ' + (d.status === 'completed' ? 'ok' : 'x') + '">' + esc(d.status) + '</span>' +
      '<button class="close" onclick="closeModal()">esc</button></h3>' +
      (d.reason ? '<div class="mini neg">' + esc(d.reason) + '</div>' : '') +
      '<div class="mini" style="color:var(--muted)">' + finance + ' · ' + calls.length + ' tool calls · ' + inf + ' provider requests</div>' +
      (d.journal ? sect('Committed journal', (d.journal.tags || []).map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('') +
        '<pre class="journal">' + esc(d.journal.text) + '</pre>') : '') +
      sect('Executed orders', d.fills.length ? '<div class="sessions"><table><thead><tr><th>Side</th><th>Ticker</th><th>Units</th><th>Price</th><th>Notional</th></tr></thead><tbody>' +
        d.fills.map(function (f) { return '<tr><td>' + esc(f.side) + '</td><td>' + esc(f.ticker) + '</td><td>' + fmt(f.units, 6) + '</td><td>$' + fmt(f.price, 2) + '</td><td>$' + fmt(f.notional, 2) + '</td></tr>'; }).join('') + '</tbody></table></div>' :
        '<div class="empty">' + (d.status === 'invalid' ? 'No valid decision. No orders executed; holdings carried forward.' : d.status === 'completed' ? 'No fills recorded.' : 'No execution committed for this session.') + '</div>') +
      (d.failedOrders.length ? sect('Rejected orders', payload(d.failedOrders)) : '') +
      (d.after ? sect('Holdings after', holdingsTable(d.after)) : '') +
      sect('Session attempts', d.attempts.length ? d.attempts.map(renderAttempt).join('') : '<div class="empty">This session has not been attempted.</div>');
  } catch (e) {
    if (state.detail && state.detail.runId + '/' + state.detail.date === selected) {
      m.innerHTML = '<h3>Session unavailable<button class="close" onclick="closeModal()">esc</button></h3><p>' + esc(e.message) + '</p>';
    }
  }
}
function holdingsTable(p) {
  if (!p || !p.holdings || !Object.keys(p.holdings).length) return '<div class="empty">All cash.</div>';
  return "<table><thead><tr><th>Ticker</th><th>Units</th><th>Avg cost</th><th>Last close</th><th>P/L</th><th>Value</th></tr></thead><tbody>" +
    Object.entries(p.holdings).map(function (e) {
      var h = e[1]; var pl = (h.lastClose / h.avgCost - 1) * 100;
      return "<tr><td>" + e[0] + "</td><td>" + h.units.toFixed(3) + "</td><td>$" + h.avgCost.toFixed(2) + "</td><td>$" + h.lastClose.toFixed(2) + "</td><td class='" + (pl >= 0 ? "pos" : "neg") + "'>" + pct(pl) + "</td><td>$" + fmt(h.value, 0) + "</td></tr>";
    }).join("") + "</tbody></table>";
}
function sect(t, body) { return '<div class="sect"><h4>' + t + "</h4>" + body + "</div>"; }
function closeModal() { state.detail = null; document.getElementById("overlay").classList.remove("open"); }
document.addEventListener("click", function (e) {
  var t = e.target.closest ? e.target.closest("[data-date]") : null;
  if (t && (t.classList.contains("tl") || t.tagName === "TR")) showDetail(t.getAttribute("data-date"));
});
document.getElementById("overlay").addEventListener("click", function (e) { if (e.target === this) closeModal(); });
document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeModal(); });

async function refresh() {
  if (state.refreshing) return;
  state.refreshing = true;
  try {
    var id = state.runs[state.current] && state.runs[state.current].runId;
    var data = await api('/api/runs');
    state.runs = data.runs;
    state.current = state.runs.length ? Math.max(0, state.runs.findIndex(function (r) { return r.runId === id; })) : null;
    document.getElementById('liveText').textContent = 'auto-refresh';
    document.getElementById('updated').textContent = 'updated ' + new Date().toLocaleTimeString();
    renderSidebar();
    renderMain();
  } catch (e) {
    document.getElementById('updated').textContent = 'Refresh failed: ' + e.message;
  } finally { state.refreshing = false; }
}
refresh();
state.timer = setInterval(refresh, 5000);
</script>
</body>
</html>`;

if (import.meta.main) server.listen(port, () => console.log(`visualizer on port ${port}`));
