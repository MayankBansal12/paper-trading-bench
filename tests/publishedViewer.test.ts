import { test, expect, beforeAll } from "bun:test";
import { readFile, access } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dir, ".."),
  dir = resolve(root, "dist");
let summary: any;
beforeAll(async () => {
  const p = Bun.spawn([process.execPath, "scripts/build-viewer.ts"], {
    cwd: root,
    stdout: "ignore",
    stderr: "pipe",
  });
  const [err, code] = await Promise.all([
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code) throw Error(err);
  summary = await Bun.file(dir + "/data/summary.json").json();
}, 30_000);
test("published selection has all twelve models and preserves invalid and uncommitted attempts", async () => {
  expect(summary.models).toHaveLength(12);
  expect(summary.models[0].model).toBe("Opus 5");
  expect(summary.models[0].net_profit).toBe(32582.58);
  expect(summary.models[0].average_profit).toBe(8145.65);
  expect(summary.manifest).toMatchObject({
    accounted_days: 3012,
    valid_days: 3007,
    attempts: 3088,
    fills: 3512,
  });
  for (const m of summary.models) {
    expect(m.quarters).toHaveLength(4);
    const slug = m.model.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const a = await Bun.file(`${dir}/data/${slug}/attempts.json`).json();
    expect(a).toHaveLength(m.attempts);
    const calls: number[] = [];
    const research: number[] = [];
    const turns: number[] = [];
    let tickerRequests = 0, tickerDays = 0;
    const sequences = new Map<string, number>();
    for (const q of m.quarters) {
      const ds = await Bun.file(`${dir}/data/${slug}/${q.quarter}.json`).json();
      expect(ds).toHaveLength(q.days);
      expect(ds.at(-1).closing_portfolio.netWorth - 150000).toBeCloseTo(
        q.net_profit,
        5,
      );
      for (const d of ds.filter((d: any) => d.status === "completed")) {
        const accepted = a.find((x: any) => x.date === d.date && x.committed && x.attempt === d.attempt);
        expect(accepted).toBeDefined();
        expect(d.usage.turns).toBe(accepted.inference_requests);
        turns.push(accepted.inference_requests);
        const filtered = d.tool_calls.filter((t: any) => t.name === "journal" && t.arguments?.ticker);
        tickerRequests += filtered.length;
        tickerDays += Number(filtered.length > 0);
        calls.push(d.tool_calls.length);
        research.push(d.tool_calls.filter((t: any) => t.name !== "submit_day").length);
        const key = JSON.stringify(d.tool_calls.map((t: any) => t.name));
        sequences.set(key, (sequences.get(key) ?? 0) + 1);
      }
    }
    expect(calls).toHaveLength(m.valid_days);
    expect(turns.reduce((s, n) => s + n, 0) / turns.length).toBeCloseTo(m.model_turns_per_valid_day.mean, 10);
    expect(m.ticker_journal_requests).toBe(tickerRequests);
    expect(m.ticker_journal_days).toBe(tickerDays);
    expect(calls.reduce((s, n) => s + n, 0)).toBe(m.total_calls_valid);
    expect(research.filter((n) => n === 0).length).toBe(m.research_calls.zero_days);
    expect(research.reduce((s, n) => s + n, 0) / research.length).toBeCloseTo(m.research_calls.mean, 10);
    expect(m.workflow_sequences.reduce((s: number, w: any) => s + w.count, 0)).toBe(m.valid_days);
    for (const w of m.workflow_sequences) expect(sequences.get(JSON.stringify(w.tools))).toBe(w.count);
  }
  expect(
    summary.models.some(
      (m: any) => m.model === "Luna 5.6" || m.model.includes("Terra"),
    ),
  ).toBe(false);
});
test("imported runs retain full sessions, no-query evidence and exact accepted identities", async () => {
  const proof = await Bun.file(`${dir}/data/import-verification.json`).json();
  expect(proof.checks.annual_day_hashes.checked).toBe(502);
  expect(proof.checks.actual_opening_contexts).toBe(510);
  expect(proof.checks.fresh_runtime_replay).toBe(false);
  for (const [name, id, valid, attempts, profit] of [
    ["Sol 6.1", "gpt-6.1-sol", 250, 259, 13746.63],
    ["Sonnet 5.5", "claude-sonnet-5-5", 251, 251, 25482.34],
  ] as const) {
    const m = summary.models.find((x: any) => x.model === name);
    expect(m).toMatchObject({ valid_days: valid, attempts, net_profit: profit });
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const records = await Bun.file(`${dir}/data/${slug}/attempts.json`).json();
    for (const a of records.filter((a: any) => a.committed)) {
      expect(a.identity_audit).toHaveLength(a.inference_requests);
      for (const request of a.identity_audit) {
        expect(request.request.model).toBe(id);
        expect(request.request.effort).toBe("medium");
        expect(request.response_models).toEqual([id]);
        expect(request.response_status).toBe(200);
        expect(request.completed_exact_stream).toBe(true);
      }
    }
  }
  const sonnet = summary.models.find((m: any) => m.model === "Sonnet 5.5");
  expect(sonnet).toMatchObject({ realized: 0, sell_days: 0, fills: 62, hold_days: 237,
    calls_valid: { submit_day: 253 }, favorite_query: null, research_calls: { zero_days: 251 } });
  const solDays = await Bun.file(`${dir}/data/sol-6-1/2025-Q4.json`).json();
  expect(solDays.find((d: any) => d.date === "2025-12-17").status).toBe("invalid");
  const html = await Bun.file(`${dir}/study.html`).text();
  expect(html).toContain("— no observations");
  expect(html).not.toContain("pending session import");
  expect(html).not.toContain("all ten models");
});
test("every built local page link resolves, including study and session anchors", async () => {
  let count = 0;
  for (const page of ["index.html", "study.html", "methodology.html"]) {
    const html = await readFile(`${dir}/${page}`, "utf8");
    expect(html).not.toContain("/home/");
    expect(html).not.toContain("{{PNL_TABLE}}");
    for (const match of html.matchAll(/href="([^"]+)"/g)) {
      const href = match[1]!;
      if (/^(https?:|mailto:)/.test(href)) continue;
      const [path, anchor] = href.split("#"),
        target = path || page;
      await access(resolve(dir, target));
      if (anchor?.startsWith("sessions/")) {
        const [, model, date] = anchor.split("/");
        expect(
          summary.models.some(
            (m: any) =>
              m.model.toLowerCase().replace(/[^a-z0-9]+/g, "-") === model &&
              (!date || m.quarters.some((q: any) => date >= q.start && date <= q.end)),
          ),
        ).toBe(true);
      } else if (anchor && anchor !== "sessions") {
        const other = await readFile(resolve(dir, target), "utf8");
        expect(other).toContain(`id="${anchor}"`);
      }
      count++;
    }
  }
  expect(count).toBeGreaterThan(50);
});
test("build keeps journals escaped and labels accounting and sample limits", async () => {
  const html = await readFile(dir + "/study.html", "utf8");
  expect(html).toContain("not a compliance rate");
  expect(html).toContain("not forced to sell");
  expect(html).not.toMatch(/<script[^>]*>[^<]+/);
  const method = await readFile(dir + "/methodology.html", "utf8");
  expect(method).toContain("post-result selection");
  expect(method).toContain("fresh attempts");
});

test("selling-position denominators match the independent review, including partial sales", () => {
  const expected: Record<string, number[]> = {
    "Astra 6": [57, 154, 35, 328],
    "DeepSeek 4.1 Flash": [181, 629, 54, 1033],
    "GLM 5.3 Flash": [49, 225, 15, 347],
    "Luna 6": [27, 61, 32, 116],
    "Muse Spark 1.3": [36, 71, 17, 114],
    "Opus 5": [125, 361, 58, 968],
    "Opus 5.5": [18, 151, 5, 183],
    "Sol 5.6": [85, 378, 23, 766],
    "Sol 6": [105, 410, 22, 806],
    "Sonnet 5": [58, 153, 10, 162],
    "Sol 6.1": [71, 185, 36, 522],
    "Sonnet 5.5": [0, 0, 0, 0],
  };
  for (const m of summary.models) {
    const s = m.sale_selection;
    expect([s.loss_sold, s.loss_positions, s.gain_sold, s.gain_positions]).toEqual(expected[m.model]);
  }
  expect(summary.models.find((m: any) => m.model === "Opus 5.5").sell_and_buy_days).toBe(0);
});
