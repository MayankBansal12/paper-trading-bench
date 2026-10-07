// Build a portable static site from the same evidence used by scripts/analyze.py.
import { mkdir, readFile, writeFile, cp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
const root = resolve(import.meta.dir, ".."),
  out = join(root, "dist"),
  src = join(root, "results/current");
const read = async (name: string) =>
  JSON.parse(await readFile(join(src, name), "utf8"));
const manifest = await read("manifest.json"),
  metrics = await read("metrics.json"),
  memoryAudit = await read("memory-audit.json");
const number = (n: number) => n.toLocaleString("en-US");
const observedMemory = memoryAudit.models.filter((m: any) => m.actual_local_attempts_checked > 0);
const observedAttempts = observedMemory.reduce((n: number, m: any) => n + m.actual_local_attempts_checked, 0);
for (const [name, sha] of Object.entries({
  "provenance.json": manifest.provenance_sha256,
  ...manifest.supporting_sha256,
})) {
  const bytes = await readFile(join(src, name));
  if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== sha)
    throw Error("Evidence checksum mismatch: " + name);
}
const imported = manifest.import_verification;
if (manifest.files.some((f: any) => ["Sol 6.1", "Sonnet 5.5"].includes(f.model)) && !imported)
  throw Error("Missing import verification for imported models");
if (imported) {
  const bytes = await readFile(join(src, imported.path));
  if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== imported.sha256)
    throw Error("Evidence checksum mismatch: import verification");
}
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const money = (v: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(v);
const style: Record<string, string> = {
  "Astra 6":
    "Defensive positioning with 56.5% average cash; the only model profitable in all four quarters in this sample.",
  "Sol 5.6":
    "Broad relative-strength screening and whole-position replacement.",
  "Sol 6.1": "Selective strength entries, staged reductions and substantial cash reserves.",
  "Sonnet 5.5": "Buys a large-cap core, mainly when funded; no research calls or sales.",
  "Sol 6":
    "Broad screening, more additions, and greater concentration in retained winners.",
  "Opus 5":
    "Staged purchases and discretionary risk rules, with more exits in later quarters.",
  "Opus 5.5":
    "A broadly invested core, many HOLDs, and occasional risk reductions.",
  "Luna 6": "A retained core with frequent additions and partial trims.",
  "GLM 5.3 Flash":
    "Persistent baskets, selective additions, and changing deployment conditions.",
  "Sonnet 5":
    "Additions to a chosen core; rarely sells and buys on the same day.",
  "Muse Spark 1.3": "Long waits followed by larger, concentrated purchases.",
  "DeepSeek 4.1 Flash":
    "Frequent history queries, active rotation and flexible price thresholds.",
};
await rm(out, { recursive: true, force: true });
await mkdir(join(out, "data"), { recursive: true });
if (imported) await cp(join(src, imported.path), join(out, "data/import-verification.json"));
const days: any[] = [];
for (const f of manifest.files) {
  const path = join(src, f.path),
    bytes = await readFile(path);
  if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== f.sha256)
    throw Error("Evidence checksum mismatch: " + f.path);
  const rows = bytes
    .toString()
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  if (rows.length !== f.records)
    throw Error("Evidence count mismatch: " + f.path);
  if (f.kind === "sessions") days.push(...rows);
  const target = join(out, "data", f.path.replace(/\.jsonl$/, ".json"));
  await mkdir(resolve(target, ".."), { recursive: true });
  await writeFile(target, JSON.stringify(rows));
}
const models = metrics.models
  .map((m: any) => {
    const valid = days.filter((d) => d.model === m.model && d.status === "completed");
    const sequences = new Map<string, number>();
    for (const d of valid) {
      const key = JSON.stringify(d.tool_calls.map((t: any) => t.name));
      sequences.set(key, (sequences.get(key) ?? 0) + 1);
    }
    const workflows = [...sequences]
      .map(([key, count]) => ({ tools: JSON.parse(key), count }))
      .sort((a, b) => b.count - a.count || JSON.stringify(a.tools).localeCompare(JSON.stringify(b.tools)));
    if (valid.length !== m.valid_days) throw Error("Workflow coverage mismatch: " + m.model);
    const research = valid.map((d) => d.tool_calls.filter((t: any) => t.name !== "submit_day").length).sort((a, b) => a - b);
    const mid = Math.floor(research.length / 2);
    const tickerJournalCounts = valid.map((d) => d.tool_calls.filter((t: any) =>
      t.name === "journal" && typeof t.arguments?.ticker === "string" && t.arguments.ticker.trim()).length);
    const saleSelection = { loss_positions: 0, loss_sold: 0, gain_positions: 0, gain_sold: 0 };
    for (const d of valid) {
      const sold = new Set(d.fills.filter((f: any) => f.side === "SELL").map((f: any) => f.ticker));
      if (!sold.size) continue;
      for (const [ticker, h] of Object.entries(d.opening_portfolio.holdings) as [string, any][]) {
        if (h.lastClose === h.avgCost) continue;
        const sign = h.lastClose < h.avgCost ? "loss" : "gain";
        saleSelection[`${sign}_positions`]++;
        if (sold.has(ticker)) saleSelection[`${sign}_sold`]++;
      }
    }
    const qs = metrics.quarters
      .filter((q: any) => q.model === m.model)
      .map((q: any) => {
        const ds = days.filter(
          (d) => d.model === m.model && d.quarter === q.quarter,
        );
        return { ...q, start: ds[0].date, end: ds.at(-1).date };
      });
    const sum = (key: string) =>
      qs.reduce((s: number, q: any) => s + q[key], 0);
    const net = Math.round(sum("net_profit") * 100) / 100;
    return {
      ...m,
      quarters: qs,
      net_profit: net,
      average_profit: Math.round(net * 25 + 1e-7) / 100,
      mean_twr: sum("twr_pct") / 4,
      realized: sum("realized"),
      unrealized: sum("unrealized"),
      dividend_income: sum("dividend_income"),
      winning_sales: sum("winning_sales"),
      losing_sales: sum("losing_sales"),
      realized_gains: sum("realized_positive"),
      realized_losses: sum("realized_negative"),
      sell_days: valid.filter((d) => d.fills.some((f: any) => f.side === "SELL")).length,
      sell_and_buy_days: valid.filter((d) => ["BUY", "SELL"].every((side) => d.fills.some((f: any) => f.side === side))).length,
      worst_drawdown: Math.max(...qs.map((q: any) => q.max_drawdown_pct)),
      average_calls: m.calls_per_valid_day.mean,
      workflow_sequences: workflows,
      ticker_journal_requests: tickerJournalCounts.reduce((s, n) => s + n, 0),
      ticker_journal_days: tickerJournalCounts.filter((n) => n > 0).length,
      sale_selection: saleSelection,
      research_calls: {
        mean: research.reduce((s, n) => s + n, 0) / research.length,
        median: research.length % 2 ? research[mid] : (research[mid - 1] + research[mid]) / 2,
        zero_days: research.filter((n) => n === 0).length,
      },
      total_calls_valid: Object.values(m.calls_valid).reduce((s: number, n: any) => s + n, 0),
      favorite_query: Object.entries(m.calls_valid)
        .filter(([name]) => name !== "submit_day")
        .sort((a: any, b: any) => b[1] - a[1])[0]?.[0] ?? null,
      common_first: Object.entries(m.first_tool).sort(
        (a: any, b: any) => b[1] - a[1],
      )[0]?.[0],
      style: style[m.model],
    };
  })
  .sort((a: any, b: any) => b.net_profit - a.net_profit);
await writeFile(
  join(out, "data/summary.json"),
  JSON.stringify({
    models,
    quarters: ["2025-Q2", "2025-Q3", "2025-Q4", "2026-Q1"],
    manifest,
  }),
);
for (const file of [
  "manifest.json",
  "provenance.json",
  "metrics.json",
  "rule-review.json",
  "memory-audit.json",
  "price-opportunities.json",
])
  await cp(join(src, file), join(out, "data", file));
// Public JSON paths differ from the Git JSONL paths; retain both in the download index.
await writeFile(
  join(out, "data/manifest.json"),
  JSON.stringify(
    {
      ...manifest,
      files: manifest.files.map((f: any) => ({
        ...f,
        repository_path: "results/current/" + f.path,
        download: f.path.replace(/\.jsonl$/, ".json"),
        sha256_applies_to:
          "repository JSONL bytes; JSON download is a derived array",
      })),
    },
    null,
    2,
  ),
);
for (const f of ["index.html", "style.css"])
  await cp(join(root, "web", f), join(out, f));
const bundle = await Bun.build({
  entrypoints: [join(root, "web/app.ts")],
  target: "browser",
  outdir: out,
  minify: true,
});
if (!bundle.success)
  throw new AggregateError(bundle.logs, "Viewer build failed");
const template = await readFile(join(out, "index.html"), "utf8");
const page = async (name: string, title: string, body: string) => {
  let html = template
    .replace(
      "<title>Paper Trading Bench</title>",
      `<title>${esc(title)} · Paper Trading Bench</title>`,
    )
    .replace(
      /<main id="main">[\s\S]*?<\/main>/,
      `<main id="main" class="study">${body}</main>`,
    )
    .replace('<script type="module" src="app.js"></script>', "")
    .replace(' aria-current="page"', "");
  html = html.replace(
    `href="${name}.html"`,
    `href="${name}.html" aria-current="page"`,
  );
  await writeFile(join(out, name + ".html"), html);
};
const table = `<div class="table-wrap pnl"><table><thead><tr><th>Model</th><th>Realized</th><th>Unrealized</th><th>Dividends</th><th>Net profit</th></tr></thead><tbody>${models.map((m: any) => `<tr><td>${esc(m.model)}</td>${["realized", "unrealized", "dividend_income", "net_profit"].map((k) => `<td>${money(m[k])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
const toolLabel: Record<string, string> = { market_snapshot: "Snapshot", price_history: "History", journal: "Journal", submit_day: "Submit" };
const workflowTable = `<div class="table-wrap workflow"><table><thead><tr><th>Model</th><th>Tool calls: mean / median</th><th>Model turns: mean / median</th><th>Most common sequence</th><th>Valid days using it</th><th>Extra journal days</th></tr></thead><tbody>${models.map((m: any) => {
  const w = m.workflow_sequences[0];
  return `<tr><td><a href="index.html#sessions/${slug(m.model)}">${esc(m.model)}</a></td><td>${m.average_calls.toFixed(2)} / ${m.calls_per_valid_day.median}</td><td>${m.model_turns_per_valid_day.mean.toFixed(2)} / ${m.model_turns_per_valid_day.median}</td><td>${w.tools.map((t: string) => toolLabel[t] ?? esc(t)).join(" → ")}</td><td>${w.count} / ${m.valid_days}</td><td>${m.journal_days} / ${m.valid_days}</td></tr>`;
}).join("")}</tbody></table></div><p class="note">Counts use valid sessions and include failed tool requests and submission corrections. A model turn is a recorded inference request; one turn can request several tools. Neither count measures private reasoning. “Most common” need not mean a majority. Models are ordered by net profit.</p>`;
const journalTable = `<details><summary>Stock-specific journal searches</summary><div class="table-wrap"><table><thead><tr><th>Model</th><th>Ticker-filter requests</th><th>Valid days using them</th></tr></thead><tbody>${models.map((m: any) => `<tr><td>${esc(m.model)}</td><td>${m.ticker_journal_requests}</td><td>${m.ticker_journal_days} / ${m.valid_days}</td></tr>`).join("")}</tbody></table></div><p>Counts require the dedicated ticker argument, including requests combined with keywords or dates. Keyword-only stock searches are outside this table. These are requests, not successful retrievals or proof that every matching entry was read.</p></details>`;
const opportunities = await read("price-opportunities.json");
const saleFraction = (n: number, d: number) => d ? `${n} / ${d}` : "—";
const saleTable = `<details><summary>Which holdings did models choose to sell?</summary><div class="table-wrap"><table><thead><tr><th>Model</th><th>Losing holdings sold</th><th>Gaining holdings sold</th><th>Sell-days also buying</th></tr></thead><tbody>${models.map((m: any) => `<tr><td>${esc(m.model)}</td><td>${saleFraction(m.sale_selection.loss_sold, m.sale_selection.loss_positions)}</td><td>${saleFraction(m.sale_selection.gain_sold, m.sale_selection.gain_positions)}</td><td>${saleFraction(m.sell_and_buy_days, m.sell_days)}</td></tr>`).join("")}</tbody></table></div><p>Only valid days with at least one executed sale are included. Sonnet 5.5 never sold; its denominators are absent, not zero loss rates. Each held stock counts once per such day; any partial or full sale counts as sold. Loss/gain compares its previous-close mark with the account’s rounded average cost; equal marks are excluded. These are position–day counts, not unique stocks, invested dollars or realized sale profits. Execution at the next open can change the sign. Same-day buying does not prove where the purchase money came from.</p></details>`;
const priceTable = `<details><summary>Buying and selling after sharp moves · ${models.length} models; queried history only</summary><div class="table-wrap"><table><thead><tr><th>Model</th><th>Buy after fall</th><th>Buy after rise</th><th>Sell after fall</th><th>Sell after rise</th></tr></thead><tbody>${models.map((m: any) => {
  const rows = opportunities.find((p: any) => p.model === m.model).rows;
  const down = rows.find((r: any) => r.condition === "down_at_least_3pct_1d");
  const up = rows.find((r: any) => r.condition === "up_at_least_3pct_1d");
  const fraction = (r: any, side: string) => r ? `${r.response[side] + r.response.BOTH} / ${r.queried_ticker_days}` : "— no observations";
  return `<tr><td>${esc(m.model)}</td><td>${fraction(down, "BUY")}</td><td>${fraction(up, "BUY")}</td><td>${fraction(down, "SELL")}</td><td>${fraction(up, "SELL")}</td></tr>`;
}).join("")}</tbody></table></div><p>Each fraction counts stock–date observations with an executed purchase or sale, out of queried stocks with a rise or fall of at least 3% between the last two returned closes. Additions and partial sells count; a stock bought and sold the same day appears on both sides. Unqueried stocks and missing history are outside this table. Sonnet 5.5 requested no history, so its price responses cannot be measured here. The model chose what to query, so this is a conditional comparison, not a controlled test of price sensitivity.</p></details>`;
const pairs: [string, string, string][] = [
  ["sol61-entry", "Sol 6.1", "2025-05-08"],
  ["sol61-exit", "Sol 6.1", "2026-03-31"],
  ["sonnet55-start", "Sonnet 5.5", "2026-01-02"],
  ["sonnet55-deposit", "Sonnet 5.5", "2026-03-02"],
  ["astra", "Astra 6", "2025-05-08"],
  ["opus", "Opus 5", "2025-04-09"],
  ["sol", "Sol 5.6", "2025-09-26"],
  ["deepseek", "DeepSeek 4.1 Flash", "2025-12-24"],
  ["astra-hold", "Astra 6", "2025-04-10"],
  ["opus-hold", "Opus 5", "2025-04-10"],
  ["luna", "Luna 6", "2025-04-10"],
  ["sonnet", "Sonnet 5", "2025-09-04"],
  ["sol-workflow", "Sol 5.6", "2025-09-30"],
  ["deepseek-workflow", "DeepSeek 4.1 Flash", "2025-09-10"],
  ["sol6-style", "Sol 6", "2025-09-26"],
  ["muse-style", "Muse Spark 1.3", "2025-12-30"],
  ["glm-style", "GLM 5.3 Flash", "2025-11-26"],
  ["opus55-style", "Opus 5.5", "2025-07-21"],
  ["opus55-rule", "Opus 5.5", "2025-10-27"],
  ["opus55-aapl", "Opus 5.5", "2025-05-01"],
  ["opus55-wmt", "Opus 5.5", "2025-07-01"],
];
const cards = pairs
  .map(([id, m, date]) => {
    const d = days.find((d) => d.model === m && d.date === date);
    if (!d?.journal?.text) throw Error("Missing study evidence " + id);
    return `<details id="case-${id}" class="case"><summary>${esc(m)} · ${date}</summary><p>${esc(d.tool_calls.map((t: any) => t.name).join(" → "))}</p><div class="journal">${esc(d.journal.text)}</div><p>${d.fills.map((f: any) => `${esc(f.side)} ${money(f.notional)} ${esc(f.ticker)}`).join(" · ") || "No executed trades."}</p><a href="index.html#sessions/${slug(m)}/${date}">Open portfolio, receipts and all attempts →</a><pre>Original day hash: ${esc(d.day_hash)}</pre></details>`;
  })
  .join("");
const md = await readFile(join(root, "docs/STUDY.md"), "utf8");
await page(
  "study",
  "Investment behavior",
  Bun.markdown.html(
    md
      .replace("](METHODOLOGY.md)", "](methodology.html)")
      .replace("<!-- workflow-table -->", workflowTable)
      .replace("<!-- journal-table -->", journalTable)
      .replace("<!-- price-table -->", priceTable)
      .replace("<!-- sell-selection-table -->", saleTable)
      .replace(/<!-- pnl-table -->[\s\S]*?<!-- \/pnl-table -->/, table)
      .replaceAll(
        "https://mayankbansal12.github.io/paper-trading-bench/study.html#",
        "#",
      )
      .replaceAll(
        "https://mayankbansal12.github.io/paper-trading-bench/index.html#",
        "index.html#",
      ),
  ) +
    `<h2 id="evidence">Selected original sessions</h2><p>Examples explain the findings; they are not an unbiased estimate of rule compliance.</p>${cards}<details><summary>Evidence coverage and accounting</summary><p>The comparison uses ${number(manifest.accounted_days)} days, ${number(manifest.valid_days)} valid decisions, ${number(manifest.fills)} fills and ${number(manifest.attempts)} selected attempts. All ${number(manifest.quarters)} quarter accounts reconcile in independent float and Decimal calculations. Original event-chain verification was performed during extraction; this site checks compact file hashes and recalculates accounting, not a new pinned-runtime replay.</p><p>Automatic context was directly checked for ${number(observedAttempts)} attempts across ${observedMemory.length} models. For the others, the matching pinned protocol and committed sequence establish the preload policy; this does not prove the model used its journals. Query coverage differs by model and is displayed with denominators.</p><p><a href="data/rule-review.json">30 purposive rule cases</a> · <a href="data/price-opportunities.json">Price-response denominators</a> · <a href="data/memory-audit.json">Memory coverage</a> · <a href="methodology.html#selection">Selection history</a></p></details>`,
);
const method = await readFile(join(root, "docs/METHODOLOGY.md"), "utf8");
await page(
  "methodology",
  "Methodology",
  Bun.markdown.html(method) +
    `<h2 id="selection">Selected runs</h2><p>Snapshot: ${esc(manifest.as_of)}. Luna 6 replaces Luna 5.6; incomplete Terra and earlier failed cohorts are excluded from the leaderboard. Historical evidence is preserved separately.</p>${manifest.exceptions.map((x: any) => `<h3>${esc(x.model)}</h3><p>${esc(x.note)}</p>`).join("")}<p><a href="data/manifest.json">Compact evidence manifest</a> · <a href="data/provenance.json">Exact run identities</a> · <a href="data/import-verification.json">October import verification and smoke outcomes</a> · <a href="https://github.com/MayankBansal12/paper-trading-bench/blob/main/docs/SETUP.md">Setup and replication</a></p>`,
);
await writeFile(join(out, ".nojekyll"), "");
console.log(`Built ${models.length} models / ${days.length} sessions in dist/`);
