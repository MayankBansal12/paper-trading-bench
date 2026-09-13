import { assertDate } from "../data/calendar.ts";
import { Type } from "typebox";
import { Check, Errors } from "typebox/value";
import type { OrderRequest } from "../domain/types.ts";
import { contentHash } from "../run/persist.ts";
import { POLICY, deepFreeze, openingPortfolio, type SessionView } from "./protocol.ts";
import { JournalStore, type JournalEntry } from "./journal.ts";
import { decisionMemoSchema, assertDecisionMemo, memoEvidenceIds } from "./memo.ts";
const obj = (p: Record<string, any>) =>
  Type.Object(p, { additionalProperties: false });
const ticker = Type.String({ pattern: "^[A-Z][A-Z0-9.-]{0,15}$" });
const date = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const str = (max: number) => Type.String({ minLength: 1, maxLength: max });
const size = {
  ticker,
  notionalUsd: Type.Optional(
    Type.Number({ exclusiveMinimum: 0, maximum: 1e9 }),
  ),
  units: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1e9 })),
};
export const toolDefinitions = [
  {
    name: "get_universe",
    description: "All eligible securities; no prescribed candidates.",
    inputSchema: obj({}),
  },
  {
    name: "get_price",
    description:
      "Latest observable previous-session close. Session controls date; execution-day open is unknown.",
    inputSchema: obj({ ticker }),
  },
  {
    name: "get_ohlcv",
    description:
      "Historical OHLCV ending at this session's observation cutoff. Choose history depth, never an end date.",
    inputSchema: obj({
      ticker,
      lookback: Type.Optional(
        Type.Integer({ minimum: 1, maximum: POLICY.maxHistory }),
      ),
    }),
  },
  {
    name: "get_indicators",
    description:
      "SMA20/SMA50/RSI14 from eligible history. Omit ticker for the full universe.",
    inputSchema: obj({ ticker: Type.Optional(ticker) }),
  },
  {
    name: "get_portfolio",
    description:
      "Observable pretrade cash, holdings and value; includes due contributions/actions, never queued fills.",
    inputSchema: obj({}),
  },
  {
    name: "buy",
    description:
      "Queue buy: choose exactly one of notionalUsd or units. No immediate execution or portfolio change.",
    inputSchema: obj(size),
  },
  {
    name: "sell",
    description:
      "Queue sell: choose exactly one of notionalUsd or units. Sale can fund only later queued orders.",
    inputSchema: obj(size),
  },
  {
    name: "journal_append",
    description:
      "Append today's immutable note. The final entry MUST include a decision memo after all orders, also for holds: thesis, 1-8 evidence claims with 1-2 exact receiptIds each, allocation, alternatives, risks, invalidation, continuity. Cite information-tool receipts or the opening-portfolio receipt in your session context; a queue receipt is not price evidence. Reuse requestId only for an identical retry.",
    inputSchema: obj({
      text: str(POLICY.maxEntryChars),
      decision: Type.Optional(decisionMemoSchema),
      evidenceIds: Type.Optional(Type.Array(str(100), { maxItems: 16 })),
      requestId: Type.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" }),
    }),
  },
  {
    name: "journal_read",
    description:
      "Read your prior committed journal or current-attempt entries for a date; bounded pagination.",
    inputSchema: obj({
      date,
      cursor: Type.Optional(Type.Integer({ minimum: 0, maximum: 100000 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
    }),
  },
  {
    name: "journal_search",
    description:
      "Search your eligible journal history, case-insensitive literal text, bounded pagination.",
    inputSchema: obj({
      query: str(200),
      cursor: Type.Optional(Type.Integer({ minimum: 0, maximum: 100000 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
    }),
  },
];
export class SessionTools {
  private closed = false;
  private calls = 0;
  private receipts = new Map<string, string>();
  private queued: OrderRequest[] = [];
  readonly trace: any[] = [];
  boundedReason: string | undefined;
  constructor(
    readonly view: SessionView,
    private journal: JournalStore,
    private past: JournalEntry[],
    private deadline: number,
    private onAudit: (event: any) => void = () => {},
  ) {
    this.receipts.set(openingPortfolio(view).receipt.id, "get_portfolio");
    this.past = deepFreeze(structuredClone(past));
    if (
      past.some(
        (e) => e.date >= view.scope.date || e.runId !== view.scope.runId,
      )
    )
      throw new Error("Future journal supplied to session");
  }
  revoke() {
    this.closed = true;
  }
  orders() {
    return structuredClone(this.queued);
  }
  call(name: unknown, args: unknown): any {
    const callId = `${this.view.scope.date}:${this.view.scope.attempt}:t${++this.calls}`;
    const event = { type: "tool_attempt", name, arguments: args };
    this.record(event);
    let result: any;
    try {
      if (this.closed) throw new Error("Session is closed");
      if (
        this.calls > this.view.limits.maxToolCalls ||
        Date.now() >= this.deadline
      ) {
        this.boundedReason = "Tool/time budget exceeded";
        this.closed = true;
        throw new Error(this.boundedReason);
      }
      const tool = toolDefinitions.find((t) => t.name === name);
      if (!tool) throw new Error("Unknown tool");
      if (!Check(tool.inputSchema, args)) {
        const errors = Errors(tool.inputSchema, args).slice(0, 4);
        throw new Error("Invalid arguments: " + errors.map(e => `${e.instancePath || "/"} ${e.message}`).join("; "));
      }
      if (Buffer.byteLength(JSON.stringify(args)) > POLICY.maxRequestBytes)
        throw new Error("Request is too large");
      const a = args as Record<string, any>;
      if (a.ticker !== undefined && !this.view.universe.includes(a.ticker))
        throw new Error("Security unavailable");
      let data: unknown;
      switch (name) {
        case "get_universe":
          data = this.view.universe;
          break;
        case "get_price": {
          const bar = this.view.bars[a.ticker]!.at(-1)!;
          data = {
            ticker: a.ticker,
            price: bar.close,
            priceType: "previous-session-close",
            asOf: bar.date,
            source: "frozen-validated-ohlcv",
            adjustment: "as-of-session-splits-only",
          };
          break;
        }
        case "get_ohlcv":
          data = this.view.bars[a.ticker]!.slice(
            -(a.lookback ?? POLICY.maxHistory),
          );
          break;
        case "get_indicators":
          data = a.ticker
            ? {
                ...this.view.indicators[a.ticker],
                lastClose: this.view.bars[a.ticker]!.at(-1)!.close,
                asOf: this.view.scope.observationDate,
              }
            : Object.fromEntries(
                this.view.universe.map((t) => [
                  t,
                  {
                    ...this.view.indicators[t],
                    lastClose: this.view.bars[t]!.at(-1)!.close,
                    asOf: this.view.scope.observationDate,
                  },
                ]),
              );
          break;
        case "get_portfolio":
          data = this.view.portfolio;
          break;
        case "buy":
        case "sell": {
          if ((a.notionalUsd === undefined) === (a.units === undefined))
            throw new Error("Provide exactly one sizing field");
          const order: OrderRequest = {
            ticker: a.ticker,
            side: name === "buy" ? "BUY" : "SELL",
            sizing:
              a.units !== undefined
                ? { kind: "units", units: a.units }
                : { kind: "notional", usd: a.notionalUsd },
          };
          this.queued.push(order);
          data = { queued: true, ...order };
          break;
        }
        case "journal_append": {
          if (a.decision !== undefined) assertDecisionMemo(a.decision);
          const decisionIds = a.decision ? memoEvidenceIds(a.decision) : [];
          if (decisionIds.some(id => !["get_universe", "get_price", "get_ohlcv", "get_indicators", "get_portfolio", "journal_read", "journal_search"].includes(this.receipts.get(id) ?? "")))
            throw new Error("Decision evidence must cite information-tool receipts or the opening-portfolio receipt from this session");
          if (a.decision && !decisionIds.some(id => ["get_price", "get_ohlcv", "get_indicators", "get_portfolio"].includes(this.receipts.get(id) ?? "")))
            throw new Error("Decision memo must cite observable market or portfolio evidence");
          const evidence = [...new Set<string>([...(a.evidenceIds ?? []), ...decisionIds])];
          if (evidence.length > 16) throw new Error("A journal entry permits at most 16 distinct evidence receipt IDs");
          if (evidence.some((id) => !this.receipts.has(id)))
            throw new Error("Evidence ID unavailable in this session");
          if (!a.text.trim()) throw new Error("Empty journal entry");
          data = this.journal.append(
            this.view.scope,
            a.text,
            evidence,
            a.requestId,
            contentHash(this.queued),
            a.decision,
          );
          break;
        }
        case "journal_read":
        case "journal_search": {
          if (a.date) assertDate(a.date);
          if (a.date && a.date > this.view.scope.date)
            throw new Error("Journal date unavailable");
          const rows = [
            ...this.past,
            ...this.journal.entries(this.view.scope),
          ].filter((e) =>
            name === "journal_read"
              ? e.date === a.date
              : (e.text + " " + JSON.stringify(e.decision ?? "")).toLowerCase().includes(a.query.toLowerCase()),
          );
          const start = a.cursor ?? 0;
          const selected: JournalEntry[] = [];
          let chars = 0;
          for (const e of rows.slice(start, start + (a.limit ?? 4))) {
            const size = e.text.length + (e.decision ? JSON.stringify(e.decision).length : 0);
            if (chars + size > POLICY.maxReadChars) break;
            selected.push(e);
            chars += size;
          }
          data = {
            entries: selected,
            nextCursor:
              start + selected.length < rows.length
                ? start + selected.length
                : null,
          };
          break;
        }
      }
      const receipt = {
        id: callId,
        sessionDate: this.view.scope.date,
        observedThrough: this.view.scope.observationDate,
        resultHash: contentHash(data),
        remainingToolCalls: Math.max(0, this.view.limits.maxToolCalls - this.calls),
      };
      result = {
        content: [{ type: "text", text: JSON.stringify({ receipt, data }) }],
      };
      if (Buffer.byteLength(JSON.stringify(result)) > POLICY.maxResponseBytes)
        throw new Error("Response size limit exceeded");
      this.receipts.set(callId, name as string);
    } catch (e) {
      result = {
        content: [
          {
            type: "text",
            text: `${e instanceof Error ? e.message : "Tool rejected"}. Remaining tool calls: ${Math.max(0, this.view.limits.maxToolCalls - this.calls)}.`,
          },
        ],
        isError: true,
      };
    }
    this.record({ type: "tool_result", name, result });
    return result;
  }
  private record(e: any) {
    this.onAudit(e);
    this.trace.push(e);
  }
}
