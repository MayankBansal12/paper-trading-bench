import { test, expect, describe } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scopeFor,
  makeView,
  POLICY,
  STUDY_PROTOCOL,
  dailyPrompt,
  openingPortfolio,
} from "../src/study/protocol.ts";
import { JournalStore } from "../src/study/journal.ts";
import { SessionTools } from "../src/study/tools.ts";
import { serveGateway } from "../src/study/gateway.ts";
import type { DecisionContext } from "../src/domain/types.ts";
const ctx = (): DecisionContext<null> => ({
  date: "2025-01-22",
  universe: ["AAPL"],
  bars: {
    AAPL: [
      {
        date: "2025-01-21",
        open: 10,
        high: 12,
        low: 9,
        close: 11,
        volume: 100,
      },
    ],
  },
  indicators: { AAPL: { sma20: 999, sma50: 999, rsi14: 999 } },
  portfolio: { cash: 500, holdings: {}, holdingsValue: 0, netWorth: 500 },
  recentDays: [],
  limits: { maxTurns: null, maxToolCalls: 24, timeoutMs: 10000 },
});
function setup(limit = 24, past: any[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "study-test-"));
  const journal = new JournalStore(dir);
  const scope = scopeFor("boundary", ctx().date, 1);
  journal.begin(scope);
  const c = ctx();
  c.limits.maxToolCalls = limit;
  const view = makeView(c, scope);
  const tools = new SessionTools(view, journal, past, Date.now() + 10000);
  return {
    dir,
    journal,
    scope,
    view,
    tools,
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}
const data = (r: any) => JSON.parse(r.content[0].text).data;
describe("session data boundary", () => {
  test("runner controls dates across weekends/holidays, not caller timestamps", () => {
    expect(scopeFor("test", "2025-01-21", 1).observationDate).toBe(
      "2025-01-17",
    );
    expect(() => scopeFor("test", "2025-01-20", 1)).toThrow();
    expect(scopeFor("test", "2025-04-01", 1).reportCutoff).toBe("2025-04-01");
  });
  test("price is the correctly labeled prior close; supplied dates and unknown fields fail", () => {
    const s = setup();
    try {
      expect(data(s.tools.call("get_price", { ticker: "AAPL" }))).toMatchObject(
        { price: 11, asOf: "2025-01-21", priceType: "previous-session-close" },
      );
      for (const field of ["date", "asOf", "end", "runId", "__proto__"]) {
        const args = JSON.parse(`{"ticker":"AAPL","${field}":"2099-01-01"}`);
        expect(s.tools.call("get_price", args).isError).toBe(true);
      }
    } finally {
      s.close();
    }
  });
  test("indicators are rebuilt from eligible bars; poisoned precomputed values are ignored", () => {
    const s = setup();
    try {
      expect(
        data(s.tools.call("get_indicators", { ticker: "AAPL" })).sma20,
      ).toBeNull();
    } finally {
      s.close();
    }
  });
  test("future or stale bars in supplied views fail closed", () => {
    for (const date of ["2025-01-22", "2025-01-23", "2025-01-17"]) {
      const c = ctx();
      c.bars.AAPL![0]!.date = date;
      expect(() => makeView(c, scopeFor("x", c.date, 1))).toThrow();
    }
  });
  test("snapshot is isolated from caller mutations", () => {
    const c = ctx(),
      v = makeView(c, scopeFor("x", c.date, 1));
    c.bars.AAPL![0]!.close = 999;
    c.portfolio.cash = 999;
    expect(v.bars.AAPL![0]!.close).toBe(11);
    expect(v.portfolio.cash).toBe(500);
    expect(Object.isFrozen(v.bars.AAPL![0])).toBe(true);
  });
  test("negative, fractional, huge lookbacks and invalid tickers cannot bypass bounds", () => {
    const s = setup();
    try {
      for (const lookback of [-1, 0, 1.5, 253, Infinity])
        expect(
          s.tools.call("get_ohlcv", { ticker: "AAPL", lookback }).isError,
        ).toBe(true);
      for (const ticker of ["../AAPL", "__proto__", "MSFT"])
        expect(s.tools.call("get_price", { ticker }).isError).toBe(true);
    } finally {
      s.close();
    }
  });
  test("orders queue without revealing execution prices or changing portfolio", () => {
    const s = setup();
    try {
      const before = s.tools.call("get_portfolio", {});
      expect(
        data(s.tools.call("buy", { ticker: "AAPL", notionalUsd: 200 })),
      ).toEqual({
        queued: true,
        ticker: "AAPL",
        side: "BUY",
        sizing: { kind: "notional", usd: 200 },
      });
      expect(data(s.tools.call("get_portfolio", {}))).toEqual(data(before));
      expect(s.tools.orders()).toHaveLength(1);
      expect(
        s.tools.call("sell", { ticker: "AAPL", notionalUsd: 1, units: 1 })
          .isError,
      ).toBe(true);
    } finally {
      s.close();
    }
  });
  test("invalid calls consume budget and cutoff refuses all later mutations", () => {
    const s = setup(2);
    try {
      s.tools.call("shell", {});
      s.tools.call("get_price", { ticker: "AAPL", date: "2099-01-01" });
      expect(
        s.tools.call("journal_append", { text: "blocked", requestId: "x" })
          .isError,
      ).toBe(true);
      expect(s.journal.entries(s.scope)).toHaveLength(0);
      expect(s.tools.boundedReason).toBeTruthy();
      expect(s.tools.call("buy", { ticker: "AAPL", units: 1 }).isError).toBe(
        true,
      );
    } finally {
      s.close();
    }
  });
  test("revocation and elapsed deadlines block journal writes", () => {
    const s = setup();
    try {
      s.tools.revoke();
      expect(
        s.tools.call("journal_append", { text: "late", requestId: "late" })
          .isError,
      ).toBe(true);
      const t = new SessionTools(s.view, s.journal, [], Date.now() - 1);
      expect(t.call("buy", { ticker: "AAPL", units: 1 }).isError).toBe(true);
      expect(t.orders()).toHaveLength(0);
    } finally {
      s.close();
    }
  });
});
describe("append-only journal", () => {
  test("date/path injection fails and appends are durable before acknowledgment", () => {
    const s = setup();
    try {
      const price = s.tools.call("get_price", { ticker: "AAPL" });
      const id = JSON.parse(price.content[0].text).receipt.id;
      const args = {
        text: "Hold; price is 11",
        requestId: "one",
        evidenceIds: [id],
      };
      expect(
        s.tools.call("journal_append", { ...args, date: "2025-01-21" }).isError,
      ).toBe(true);
      const entry = data(s.tools.call("journal_append", args));
      expect(entry.date).toBe(s.scope.date);
      expect(new JournalStore(s.dir).entries(s.scope)).toEqual([entry]);
      expect(data(s.tools.call("journal_append", args))).toEqual(entry);
      expect(
        s.tools.call("journal_append", { ...args, text: "rewritten" }).isError,
      ).toBe(true);
    } finally {
      s.close();
    }
  });
  test("fabricated evidence, empty or oversized notes fail", () => {
    const s = setup();
    try {
      for (const args of [
        { text: "x", requestId: "a", evidenceIds: ["unknown"] },
        { text: " ", requestId: "b" },
        { text: "x".repeat(2001), requestId: "c" },
        { text: "x", requestId: "../escape" },
      ])
        expect(s.tools.call("journal_append", args).isError).toBe(true);
      expect(s.journal.entries(s.scope)).toHaveLength(0);
    } finally {
      s.close();
    }
  });
  test("sealed days cannot be changed, failed-attempt text stays out of a retry's read view", () => {
    const s = setup();
    try {
      s.tools.call("journal_append", {
        text: "failed attempt",
        requestId: "one",
      });
      s.journal.finish(s.scope, "failed", "a".repeat(64));
      const retry = scopeFor("boundary", s.scope.date, 2);
      s.journal.begin(retry);
      const t = new SessionTools(
        { ...s.view, scope: retry },
        s.journal,
        [],
        Date.now() + 10000,
      );
      expect(
        data(t.call("journal_read", { date: retry.date })).entries,
      ).toHaveLength(0);
      t.call("journal_append", { text: "retry decision", requestId: "one" });
      s.journal.finish(retry, "sealed", "b".repeat(64));
      expect(
        t.call("journal_append", { text: "late edit", requestId: "two" })
          .isError,
      ).toBe(true);
      expect(s.journal.entries(s.scope)[0]!.text).toBe("failed attempt");
    } finally {
      s.close();
    }
  });
  test("eligible history remains searchable beyond five days; future reads fail", () => {
    const old = {
      id: "old",
      runId: "boundary",
      ordersHash: "a".repeat(64),
      date: "2024-12-20",
      attempt: 1,
      text: "Long-term thesis",
      evidenceIds: [],
      requestId: "old",
    };
    const s = setup(24, [old]);
    try {
      expect(
        data(s.tools.call("journal_search", { query: "thesis" })).entries,
      ).toEqual([old]);
      expect(s.tools.call("journal_read", { date: "2025-01-23" }).isError).toBe(
        true,
      );
      expect(
        s.tools.call("journal_read", { date: old.date, runId: "foreign" })
          .isError,
      ).toBe(true);
    } finally {
      s.close();
    }
  });
  test("deleted, altered, reordered, or truncated journal events fail reload", () => {
    const s = setup();
    try {
      s.tools.call("journal_append", { text: "original", requestId: "a" });
      const original = readFileSync(s.journal.path, "utf8");
      for (const broken of [
        original.replace("original", "modified"),
        original.split("\n").slice(1).join("\n"),
        original.slice(0, -2),
      ]) {
        writeFileSync(s.journal.path, broken);
        expect(() => new JournalStore(s.dir)).toThrow();
      }
      writeFileSync(s.journal.path, original);
    } finally {
      s.close();
    }
  });
});
describe("scoped gateway", () => {
  test("rejects unauthenticated, arbitrary-route, alternate-model and external-tool requests without forwarding", async () => {
    const s = setup();
    let calls = 0;
    const socket = join(s.dir, "gateway.sock");
    const g = await serveGateway(
      socket,
      s.tools,
      "test-secret",
      Date.now() + 10000,
      () => {},
      (async () => {
        calls++;
        return new Response("ok");
      }) as any,
    );
    const call = (path: string, body: any, auth = true) =>
      fetch("http://gateway" + path, {
        unix: socket,
        method: "POST",
        headers: auth ? { authorization: `Bearer ${g.capability}` } : {},
        body: JSON.stringify(body),
      });
    try {
      expect(
        (
          await call(
            "/inference/responses",
            { model: "muse-spark-1.3-contributor-free" },
            false,
          )
        ).status,
      ).toBe(403);
      expect((await call("/admin", {})).status).toBe(403);
      expect(
        (await call("/inference/responses", { model: "paid-model" })).status,
      ).toBe(403);
      expect(
        (
          await call("/inference/responses", {
            model: "muse-spark-1.3-contributor-free",
            tools: [{ type: "web_search" }],
          })
        ).status,
      ).toBe(403);
      expect(calls).toBe(0);
      expect(
        (
          await call("/inference/responses", {
            model: "muse-spark-1.3-contributor-free",
            tools: [],
          })
        ).status,
      ).toBe(200);
      expect(calls).toBe(1);
    } finally {
      g.close();
      s.close();
    }
  });
});

test("session identity and journal history cannot be forged across runs", () => {
  const s = setup();
  try {
    expect(() =>
      makeView(ctx(), { ...s.scope, observationDate: "2099-01-01" }),
    ).toThrow();
    expect(() =>
      s.journal.append({ ...s.scope, runId: "foreign" }, "wrong run", [], "x"),
    ).toThrow();
    expect(
      () =>
        new SessionTools(
          s.view,
          s.journal,
          [
            {
              id: "x",
              runId: "foreign",
              date: "2024-12-20",
              attempt: 1,
              text: "foreign memory",
              requestId: "x",
              evidenceIds: [],
              ordersHash: "a".repeat(64),
            },
          ],
          Date.now() + 10000,
        ),
    ).toThrow();
    expect(s.tools.call("journal_read", { date: "2025-02-30" }).isError).toBe(
      true,
    );
    expect(s.tools.call("get_report", { ticker: "AAPL" }).isError).toBe(true);
  } finally {
    s.close();
  }
});
test("gateway blocks provider-hosted retrieval, session continuation and mismatched capabilities", async () => {
  const s = setup();
  const socket = join(s.dir, "gateway.sock");
  let forwarded = 0;
  const g = await serveGateway(
    socket,
    s.tools,
    "test-host-key",
    Date.now() + 10000,
    () => {},
    (async () => {
      forwarded++;
      return new Response("ok");
    }) as any,
  );
  const call = (body: any, key = g.capability) =>
    fetch("http://gateway/inference/chat/completions", {
      unix: socket,
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: "muse-spark-1.3-contributor-free",
        ...body,
      }),
    });
  try {
    for (const body of [
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: "https://news.example/latest.png" },
              },
            ],
          },
        ],
      },
      { previous_response_id: "other-session" },
      { tools: [{ type: "mcp", server_url: "https://news.example" }] },
      { web_search_options: {} },
      { store: true },
    ])
      expect((await call(body)).status).toBe(403);
    expect(
      (await call({ messages: [] }, "another-session-capability")).status,
    ).toBe(403);
    expect(forwarded).toBe(0);
  } finally {
    g.close();
    s.close();
  }
});
test("inference has no turn or aggregate HTTP-request cap and remains counted", async () => {
  const s = setup();
  const socket = join(s.dir, "gateway.sock");
  let forwarded = 0;
  const audit: any[] = [], stopped: string[] = [];
  const g = await serveGateway(socket, s.tools, "test-host-key", Date.now() + 10000,
    e => audit.push(e), (async () => { forwarded++; return new Response("ok"); }) as typeof fetch,
    reason => stopped.push(reason));
  try {
    // Cross the old 12/24-turn ceilings and the old 256-request gateway ceiling.
    for (let i = 0; i < 300; i++) {
      const r = await fetch("http://gateway/inference/responses", {
        unix: socket, method: "POST", headers: { authorization: `Bearer ${g.capability}` },
        body: JSON.stringify({ model: "muse-spark-1.3-contributor-free", input: "Continue." }),
      });
      expect(r.status).toBe(200);
      await r.text();
    }
    expect(forwarded).toBe(300);
    expect(g.count()).toBe(300);
    expect(audit.filter(e => e.type === "inference_request").map(e => e.sequence)).toEqual(Array.from({length: 300}, (_,i) => i+1));
    expect(stopped).toEqual([]);
    expect(s.tools.boundedReason).toBeUndefined();
    expect(s.tools.call("buy", { ticker: "AAPL", notionalUsd: 10 }).isError).not.toBe(true);
  } finally { g.close(); s.close(); }
});

test("a slow inference response survives beyond Bun's default ten-second idle timeout", async () => {
  const s = setup();
  const socket = join(s.dir, "gateway.sock");
  const g = await serveGateway(
    socket,
    s.tools,
    "test-host-key",
    Date.now() + 14000,
    () => {},
    (async () => {
      await new Promise((resolve) => setTimeout(resolve, 11000));
      return new Response("slow response");
    }) as any,
  );
  try {
    const r = await fetch("http://gateway/inference/chat/completions", {
      unix: socket,
      method: "POST",
      headers: { authorization: `Bearer ${g.capability}` },
      body: JSON.stringify({
        model: "muse-spark-1.3-contributor-free",
        messages: [],
      }),
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("slow response");
  } finally {
    g.close();
    s.close();
  }
}, 16000);

function memo(receiptId: string) {
  return {
    thesis: "Hold while observing the initial portfolio.",
    evidence: [{ claim: "The observed prior close is 11.", receiptIds: [receiptId] }],
    allocation: "Keep cash pending a stronger signal.",
    alternatives: "Buying now offers insufficient evidence of an advantage.",
    risks: "Cash may lag a rising market; one price does not establish a trend.",
    invalidation: "Revisit when a new close provides evidence against this thesis.",
    continuity: "First day; no prior memo.",
  };
}
test("decision memos require real information receipts and persist searchable structured reasoning", () => {
  const s = setup();
  try {
    const price = s.tools.call("get_price", { ticker: "AAPL" });
    const receipt = JSON.parse(price.content[0].text).receipt;
    expect(receipt.remainingToolCalls).toBe(23);
    const args = { text: "Hold cash.", requestId: "decision", decision: memo(receipt.id) };
    expect(s.tools.call("journal_append", { ...args, decision: memo("invented") }).isError).toBe(true);
    const queued = s.tools.call("buy", { ticker: "AAPL", notionalUsd: 10 });
    expect(s.tools.call("journal_append", { ...args, decision: memo(JSON.parse(queued.content[0].text).receipt.id) }).isError).toBe(true);
    expect(s.tools.call("journal_append", { ...args, decision: { ...args.decision, risks: " " } }).isError).toBe(true);
    const entry = data(s.tools.call("journal_append", args));
    expect(entry.evidenceIds).toEqual([receipt.id]);
    expect(entry.decision).toEqual(args.decision);
    expect(data(s.tools.call("journal_search", { query: "insufficient evidence" })).entries[0].id).toBe(entry.id);
    expect(s.tools.call("journal_append", { ...args, decision: { ...args.decision, thesis: "Changed" } }).isError).toBe(true);
    const reloaded = new JournalStore(s.dir);
    expect(reloaded.entries(s.scope)[0]?.decision).toEqual(args.decision);
  } finally { s.close(); }
});

test("journal errors explain evidence limits and seven valid claims are accepted", () => {
  const s = setup();
  try {
    const id = JSON.parse(s.tools.call("get_price", { ticker: "AAPL" }).content[0].text).receipt.id;
    const decision = memo(id);
    decision.evidence = Array.from({ length: 9 }, () => ({ claim: "Observed price is 11.", receiptIds: [id] }));
    const args = { text: "Hold pending further evidence.", requestId: "claims", decision };
    const rejected = s.tools.call("journal_append", args);
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0].text).toContain("/decision/evidence must not have more than 8 items");
    expect(rejected.content[0].text).toContain("Remaining tool calls: 22");
    decision.evidence = decision.evidence.slice(0, 7);
    expect(data(s.tools.call("journal_append", args)).decision.evidence).toHaveLength(7);
    const placeholder = s.tools.call("journal_append", { ...args, requestId: "placeholder", decision: { ...decision, thesis: "t" } });
    expect(placeholder.isError).toBe(true);
    expect(placeholder.content[0].text).toContain("/decision/thesis");
  } finally { s.close(); }
});
test("gateway still notifies the host immediately on tool budget exhaustion", async () => {
  const s = setup(1);
  const socket = join(s.dir, "cutoff.sock");
  const stopped: string[] = [];
  const g = await serveGateway(socket, s.tools, "key", Date.now() + 10000, () => {},
    (async () => new Response("ok")) as typeof fetch, reason => stopped.push(reason));
  const call = async (name: string, args: object) => {
    const r = await fetch("http://gateway/mcp", {
      unix: socket, method: "POST", headers: { authorization: `Bearer ${g.capability}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    return (await r.json() as any).result;
  };
  try {
    expect((await call("get_portfolio", {})).isError).not.toBe(true);
    expect(stopped).toEqual([]);
    expect((await call("buy", { ticker: "AAPL", units: 1 })).isError).toBe(true);
    expect(stopped).toEqual(["Tool/time budget exceeded"]);
    expect(s.tools.orders()).toEqual([]);
  } finally { g.close(); s.close(); }
});

test("opening portfolio is preloaded, citable without a tool call, and scoped to the attempt", () => {
  const s = setup();
  try {
    const packet = openingPortfolio(s.view);
    const prompt = dailyPrompt(s.view, "2025-01-22", "2025-01-24", []);
    expect(prompt).toContain(JSON.stringify(packet));
    expect(packet.data).toEqual({ cash: 500, holdings: {}, holdingsValue: 0, netWorth: 500 });
    expect(packet.receipt.observedThrough).toBe("2025-01-21");
    expect(s.tools.trace).toEqual([]);
    const decision = { ...memo(packet.receipt.id), evidence: [{ claim: "The opening portfolio has 500 cash and no holdings.", receiptIds: [packet.receipt.id] }] };
    const entry = s.tools.call("journal_append", { text: "Hold the opening cash.", requestId: "opening", decision });
    expect(entry.isError).not.toBe(true);
    expect(JSON.parse(entry.content[0].text).receipt.remainingToolCalls).toBe(23);
    expect(data(entry).evidenceIds).toEqual([packet.receipt.id]);
    expect(data(s.tools.call("get_portfolio", {}))).toEqual(packet.data);
    for (const id of ["2025-01-21:1:opening-portfolio", "2025-01-22:2:opening-portfolio"]) {
      expect(s.tools.call("journal_append", { text: "Wrong scope.", requestId: "foreign", decision: memo(id) }).isError).toBe(true);
    }
    s.tools.call("buy", { ticker: "AAPL", notionalUsd: 200 });
    expect(openingPortfolio(s.view)).toEqual(packet);
    packet.data.cash = 123;
    expect(s.view.portfolio.cash).toBe(500);
  } finally { s.close(); }
});

test("v10 requires explicit unlimited turns and still validates tool/time limits", () => {
  for (const maxTurns of [12, 24, 300, 0, undefined]) {
    const c = ctx();
    (c.limits as any).maxTurns = maxTurns;
    expect(() => makeView(c, scopeFor("boundary", c.date, 1))).toThrow("unlimited");
  }
  for (const limits of [{ maxToolCalls: 65 }, { timeoutMs: 300001 }]) {
    const c = ctx(); Object.assign(c.limits, limits);
    expect(() => makeView(c, scopeFor("boundary", c.date, 1))).toThrow("hard limits");
  }
});
