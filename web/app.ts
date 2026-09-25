// Read-only static viewer. All journal/tool content is rendered as escaped text.
const root = document.querySelector<HTMLElement>("main")!;
const esc = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const usd = (v: number, cents = false) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: cents ? 2 : 0,
    minimumFractionDigits: cents ? 2 : 0,
  }).format(v);
const num = (v: number, digits = 0) =>
  v.toLocaleString("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
const pnl = (v: number, cents = false) =>
  `<span class="${v < 0 ? "negative" : "positive"}">${v > 0 ? "+" : ""}${usd(v, cents)}</span>`;
const pct = (v: number) => num(v, 2) + "%";
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const json = async (path: string) => {
  const r = await fetch(path);
  if (!r.ok) throw Error(`Could not load ${path} (${r.status})`);
  return r.json();
};
const cache = new Map<string, Promise<any>>();
const get = (path: string) => {
  if (!cache.has(path)) cache.set(path, json(path));
  return cache.get(path)!;
};
let data: any,
  mode = "profit",
  sort = "net_profit",
  ascending = false,
  generation = 0;
const table = (headers: string[], rows: string[][]) =>
  `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
const stats = (rows: [string, string][]) =>
  `<div class="stats">${rows.map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join("")}</div>`;
function leaderboard() {
  const columns: Record<string, [string, string][]> = {
    profit: [
      ["net_profit", "Net profit"],
      ["average_profit", "Avg / quarter"],
      ["mean_twr", "Mean quarterly TWR"],
      ["valid_days", "Valid / invalid"],
    ],
    risk: [
      ["mean_cash_pct", "Average cash"],
      ["max_issuer_pct", "Peak issuer weight"],
      ["worst_drawdown", "Worst quarter drawdown"],
      ["gross_turnover", "Daily turnover"],
    ],
    tools: [
      ["average_calls", "Calls / valid day"],
      ["journal_days", "Extra journal days"],
      ["hold_days", "HOLD days"],
      ["all_attempt_tool_errors", "Tool errors · all attempts"],
    ],
  };
  const cols = columns[mode]!;
  const rows = [...data.models].sort(
    (a, b) =>
      (ascending ? 1 : -1) * (a[sort] - b[sort]) ||
      a.model.localeCompare(b.model),
  );
  const headers = [
    "Model",
    ...cols.map(
      ([key, label]) =>
        `<button data-sort="${key}">${label}${key === sort ? (ascending ? " ↑" : " ↓") : ""}</button>`,
    ),
  ];
  const body = rows.map((m, i) => [
    `<span class="rank">${i + 1}</span><a href="#sessions/${slug(m.model)}">${esc(m.model)}</a>`,
    ...cols.map(([key]) =>
      key === "valid_days"
        ? `${m.valid_days} / ${251 - m.valid_days}`
        : key.includes("profit")
          ? pnl(m[key], true)
          : [
                "mean_twr",
                "mean_cash_pct",
                "max_issuer_pct",
                "worst_drawdown",
                "gross_turnover",
              ].includes(key)
            ? pct(m[key])
            : num(m[key], key === "average_calls" ? 2 : 0),
    ),
  ]);
  document.querySelector("#leaderboard")!.innerHTML = table(headers, body);
  document.querySelectorAll<HTMLButtonElement>("[data-sort]").forEach(
    (b) =>
      (b.onclick = () => {
        ascending = sort === b.dataset.sort ? !ascending : false;
        sort = b.dataset.sort!;
        leaderboard();
      }),
  );
}
function home() {
  root.innerHTML = `<p class="eyebrow">Ten models. One market sample.</p><h1>The same tools.<br>Different investment decisions.</h1><p class="intro">Explore what models bought, sold and held—and the reasons they recorded. Four independent quarterly accounts test their choices through rising and falling markets.</p>${stats(
    [
      ["10", "Completed model results"],
      ["251", "Sessions per model"],
      ["$600,000", "Total funding per model"],
      [num(data.manifest.fills), "Executed trades"],
    ],
  )}<div class="tabs" aria-label="Comparison"><button data-mode="profit" aria-pressed="true">Performance</button><button data-mode="risk" aria-pressed="false">Risk</button><button data-mode="tools" aria-pressed="false">Tools & activity</button></div><div id="leaderboard"></div><p class="note">Net profit sums four separate accounts. Average profit divides that total by four. Mean quarterly TWR adjusts for deposits; it is not an annual return. Click a model to inspect its sessions.</p><div class="selection-note">Opus 5 uses the newer Q2 repeat, selected after both results were known. Opus 5.5 includes seven supplemental recovery dates. <a href="methodology.html#selection">Selection and limitations</a></div><div class="two-col"><section class="card"><h3>What did the models do differently?</h3><p>Some screened the whole market. Others checked a shortlist. A HOLD could mean staying mostly in cash—or keeping a fully invested portfolio.</p><a href="study.html">Read the comparative study →</a></section><section class="card"><h3>Follow a decision from evidence to execution</h3><p>See the supplied portfolio, tool sequence, original journal, actual fills and failed attempts for every selected date.</p><a href="#sessions">Explore trading sessions →</a></section></div><h2>Four independent quarters</h2><p class="note">Each quarter starts with $50,000 and receives two further $50,000 deposits. No portfolio or memory carries between quarters.</p>${table(
    ["Model", ...data.quarters],
    data.models.map((m: any) => [
      `<a href="#sessions/${slug(m.model)}">${esc(m.model)}</a>`,
      ...data.quarters.map((q: string) => {
        const row = m.quarters.find((x: any) => x.quarter === q);
        return `<a href="#sessions/${slug(m.model)}/${row.start}">${pnl(row.net_profit)}</a>`;
      }),
    ]),
  )}`;
  mode = "profit";
  sort = "net_profit";
  ascending = false;
  leaderboard();
  document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach(
    (b) =>
      (b.onclick = () => {
        mode = b.dataset.mode!;
        sort = "net_profit";
        ascending = false;
        document
          .querySelectorAll("[data-mode]")
          .forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        leaderboard();
      }),
  );
}
function chart(days: any[]) {
  let funding = 50000;
  const points = days.map((d) => {
    funding += d.contribution;
    return d.closing_portfolio.netWorth - funding;
  });
  const lo = Math.min(0, ...points),
    hi = Math.max(0, ...points),
    span = hi - lo || 1;
  const y = (v: number) => 200 - ((v - lo) / span) * 170;
  const x = (i: number) => 70 + (i / (points.length - 1 || 1)) * 730;
  const path = points
    .map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(2)},${y(v).toFixed(2)}`)
    .join(" ");
  return `<svg class="chart" viewBox="0 0 830 225" role="img" aria-label="Quarter profit after contributions, first day ${usd(points[0]!, true)}, last day ${usd(points.at(-1)!, true)}"><line x1="70" y1="${y(0)}" x2="800" y2="${y(0)}" stroke="#dbe2dd"/><text x="5" y="34">${esc(usd(hi))}</text><text x="5" y="203">${esc(usd(lo))}</text><path d="${path}" fill="none" stroke="#16745f" stroke-width="2.5"/></svg><div class="chart-label"><span>${esc(days[0].date)}</span><span>Quarter profit · deposits removed</span><span>${esc(days.at(-1).date)}</span></div>`;
}
async function sessions(parts: string[], ticket: number) {
  const m =
    data.models.find((x: any) => slug(x.model) === parts[1]) ?? data.models[0];
  const date = parts[2] ?? m.quarters[0].start;
  const quarter =
    m.quarters.find((q: any) => date >= q.start && date <= q.end) ??
    m.quarters[0];
  const days = await get(`data/${slug(m.model)}/${quarter.quarter}.json`);
  if (ticket !== generation) return;
  const d = days.find((x: any) => x.date === date) ?? days[0];
  root.innerHTML = `<p class="eyebrow">Original decisions & executed trades</p><h1>${esc(m.model)}</h1><p class="intro">${esc(m.style)}</p><div class="toolbar"><label>Model<select id="model">${data.models.map((x: any) => `<option value="${slug(x.model)}" ${x.model === m.model ? "selected" : ""}>${esc(x.model)}</option>`).join("")}</select></label><label>Quarter<select id="quarter">${m.quarters.map((q: any) => `<option value="${q.start}" ${q.quarter === quarter.quarter ? "selected" : ""}>${q.quarter}</option>`).join("")}</select></label><label>Find a session<input id="search" type="search" placeholder="Date, ticker or journal text"></label></div>${stats(
    [
      [pnl(m.net_profit, true), "Total net profit"],
      [pct(m.mean_twr), "Mean quarterly TWR"],
      [num(m.average_calls, 2), "Tool calls / valid day"],
      [`${m.valid_days} / ${251 - m.valid_days}`, "Valid / invalid days"],
    ],
  )}<div class="two-col"><section class="card"><h3>${quarter.quarter} profit</h3>${chart(days)}</section><section class="card"><h3>How this model used a session</h3><p><strong>${num(m.calls_per_valid_day.median, 1)} calls</strong> was the median; 90% of valid sessions used at most <strong>${m.calls_per_valid_day.p90}</strong>. The most frequent first tool was <strong>${esc(m.common_first)}</strong>.</p><p>${m.journal_days} valid sessions requested extra journals. Up to three recent committed journals were supplied automatically. ${m.only_submit_days} sessions used only <code>submit_day</code>.</p><p class="note">${m.attempts} total attempts; ${m.uncommitted_attempts} uncommitted. Tool counts include submission and recoverable errors.</p></section></div><div class="toolbar"><label>Trading date<select id="date"></select></label><div class="actions"><button id="previous" aria-label="Previous session">← Previous</button><button id="next" aria-label="Next session">Next →</button></div></div><section id="decision" aria-live="polite"></section><details><summary>Tool counts across the whole run</summary>${table(
    ["Tool", "Valid sessions", "All attempts"],
    ["market_snapshot", "price_history", "journal", "submit_day"].map((t) => [
      t,
      num(m.calls_valid[t] ?? 0),
      num(m.calls_all_attempts[t] ?? 0),
    ]),
  )}<p class="note">Extra journal calls are requests, not proof of retrieval or use. Requests can fail. Tool errors: ${m.all_attempt_tool_errors} across all attempts; execution rejections: ${m.execution_rejections}.</p></details><details><summary>Source and accounting</summary><p>${esc(data.manifest.exceptions.find((x: any) => x.model === m.model)?.note ?? "Four independent quarters; every selected attempt is retained.")}</p><p>Annual realized trading P&L ${pnl(m.realized, true)}; quarter-end unrealized P&L ${pnl(m.unrealized, true)}; dividends ${usd(m.dividend_income, true)}.</p><a href="data/provenance.json">Exact source, runtime, dataset and segment identities</a> · <a href="data/${slug(m.model)}/attempts.json">All compact attempts</a> · <a href="data/${slug(m.model)}/${quarter.quarter}.json">This quarter’s compact sessions</a></details>`;
  const setDate = (v: string) => {
    location.hash = `sessions/${slug(m.model)}/${v}`;
  };
  const select = document.querySelector<HTMLSelectElement>("#date")!;
  const list = (term = "") => {
    const visible = days.filter((x: any) =>
      `${x.date} ${x.journal?.text ?? ""} ${(x.orders ?? []).map((o: any) => o.ticker).join(" ")}`
        .toLowerCase()
        .includes(term.toLowerCase()),
    );
    select.innerHTML = visible
      .map(
        (x: any) =>
          `<option value="${x.date}" ${x.date === d.date ? "selected" : ""}>${x.date} · ${x.session_class.replaceAll("_", " ")}</option>`,
      )
      .join("");
    if (!visible.length)
      select.innerHTML = "<option>No matching sessions</option>";
  };
  list();
  document.querySelector<HTMLSelectElement>("#model")!.onchange = (e) => {
    location.hash = `sessions/${(e.target as HTMLSelectElement).value}`;
  };
  document.querySelector<HTMLSelectElement>("#quarter")!.onchange = (e) =>
    setDate((e.target as HTMLSelectElement).value);
  select.onchange = () => setDate(select.value);
  document.querySelector<HTMLInputElement>("#search")!.oninput = (e) =>
    list((e.target as HTMLInputElement).value);
  const i = days.indexOf(d);
  const prev = document.querySelector<HTMLButtonElement>("#previous")!,
    next = document.querySelector<HTMLButtonElement>("#next")!;
  prev.disabled = i === 0;
  next.disabled = i === days.length - 1;
  prev.onclick = () => setDate(days[i - 1].date);
  next.onclick = () => setDate(days[i + 1].date);
  const attempts = await get(`data/${slug(m.model)}/attempts.json`);
  if (ticket !== generation) return;
  decision(
    d,
    attempts.filter((a: any) => a.date === d.date),
  );
}
function decision(d: any, attempts: any[]) {
  const portfolio = (p: any) =>
    table(
      ["Holding", "Units", "Value", "Weight"],
      [
        ["Cash", "—", usd(p.cash, true), pct((p.cash / p.netWorth) * 100)],
        ...Object.entries(p.holdings)
          .sort((a: any, b: any) => b[1].value - a[1].value)
          .map(([t, h]: any) => [
            esc(t),
            num(h.units, 6),
            usd(h.value, true),
            pct((h.value / p.netWorth) * 100),
          ]),
      ],
    );
  const tools = d.tool_calls
    .map(
      (t: any) =>
        `<li><details><summary>${esc(t.name)} <small>${esc(t.arguments?.tickers?.join(", ") ?? "")}</small></summary><pre>${esc(JSON.stringify(t.arguments, null, 2))}</pre></details></li>`,
    )
    .join("");
  document.querySelector("#decision")!.innerHTML =
    `<h2>${esc(d.date)} <span class="pill">${esc(d.session_class.replaceAll("_", " "))}</span></h2><p class="note">Observed prices through ${esc(d.observation_date)}. Attempt ${d.attempt ?? "—"}. ${d.contribution ? `Deposit: ${usd(d.contribution)}.` : ""} ${d.reason ? esc(d.reason) : ""}</p><section class="card"><h3>Journal submitted before execution</h3><div class="journal">${esc(d.journal?.text ?? "No accepted journal on this invalid day.")}</div></section><h3>Executed trades</h3>${
      d.fills.length
        ? table(
            ["Stock", "Side", "Units", "Price", "Cash exchanged"],
            d.fills.map((f: any) => [
              esc(f.ticker),
              esc(f.side),
              num(f.units, 6),
              usd(f.price, true),
              usd(f.notional, true),
            ]),
          )
        : '<p class="empty">No executed trades.</p>'
    }${d.failed_orders.length ? `<details open><summary>${d.failed_orders.length} rejected orders</summary><pre>${esc(JSON.stringify(d.failed_orders, null, 2))}</pre></details>` : ""}<div class="two-col"><section class="card"><h3>Supplied opening portfolio</h3><p>${usd(d.opening_portfolio.netWorth, true)}</p>${portfolio(d.opening_portfolio)}</section><section class="card"><h3>Portfolio at the close</h3><p>${usd(d.closing_portfolio.netWorth, true)}</p>${portfolio(d.closing_portfolio)}</section></div><h3>Tool sequence · accepted attempt</h3><p class="note">${d.tool_calls.length} calls; ${d.usage?.turns ?? "unobserved"} model turns. Previous prices, portfolio and recent journals were already supplied.</p><ol class="tool-list">${tools || "<li>No accepted tool sequence.</li>"}</ol><details><summary>Tool receipts and observed market evidence</summary><pre>${esc(JSON.stringify(d.tool_receipts, null, 2))}</pre></details><details><summary>All ${attempts.length} recorded attempts for this date</summary>${attempts.map((a) => `<h3>Attempt ${a.attempt} · ${esc(a.outcome)} ${a.committed ? "· committed" : ""}</h3><p>${esc(a.reason ?? "")}</p><pre>${esc(JSON.stringify(a, null, 2))}</pre>`).join("")}</details><details><summary>Orders, usage and source anchors</summary><pre>${esc(JSON.stringify({ orders: d.orders, usage: d.usage, day_hash: d.day_hash, result_hash: d.result_hash, submission_hash: d.submission_hash, run_id: d.run_id, corporate_actions: d.corporate_actions }, null, 2))}</pre></details>`;
}
async function route() {
  const ticket = ++generation;
  const parts = location.hash.slice(1).split("/").map(decodeURIComponent);
  try {
    if (parts[0] === "sessions") {
      root.innerHTML =
        '<p class="loading" role="status">Loading session evidence…</p>';
      await sessions(parts, ticket);
    } else home();
  } catch (e) {
    if (ticket === generation)
      root.innerHTML = `<p class="error" role="alert">${esc(e instanceof Error ? e.message : e)}. Please reload to retry.</p>`;
  }
}
try {
  data = await get("data/summary.json");
  window.addEventListener("hashchange", route);
  await route();
} catch (e) {
  root.innerHTML = `<p class="error" role="alert">${esc(e instanceof Error ? e.message : e)}</p>`;
}

export {};
