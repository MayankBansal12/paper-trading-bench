import { assertDate } from "../data/calendar.ts";
import { Type } from "typebox";
import { Check, Errors } from "typebox/value";
import type { OrderRequest } from "../domain/types.ts";
import { contentHash } from "../core/hash.ts";
import {
  POLICY,
  availableHistoryBars,
  deepFreeze,
  openingPortfolio,
  openingContext,
  dailyPrompt,
  type SessionView,
} from "./protocol.ts";
import { JournalStore, type JournalEntry, type Submission } from "./journal.ts";
import { journalSchema, assertJournalNote } from "./memo.ts";
import { readJournal } from "./retrieval.ts";
const obj = (p: Record<string, any>) =>
  Type.Object(p, { additionalProperties: false });
const ticker = Type.String({ pattern: "^[A-Z][A-Z0-9.-]{0,15}$" });
const tickers = (max?: number) =>
  Type.Array(ticker, { minItems: 1, ...(max === undefined ? {} : { maxItems: max }), uniqueItems: true });
const positive = Type.Number({ exclusiveMinimum: 0, maximum: 1e9 });
const priceHistorySchema = (maximum: number, maximumTickers?: number) => obj({
  tickers: tickers(maximumTickers),
  lookback: Type.Integer({ minimum: 1, maximum }),
});
const inheritedRuns = new Map<string, Set<string>>();
/** A continuation segment may present its authenticated parent's own journal entries; no other foreign run is ever accepted. */
export function registerInheritedRun(runId: string, parentRunId: string) {
  inheritedRuns.set(runId, new Set([parentRunId]));
}
export function unregisterInheritedRun(runId: string) {
  inheritedRuns.delete(runId);
}
export const toolDefinitions = [
  {
    name: "market_snapshot",
    description:
      "Compact previous-session closes for selected tickers or the eligible universe. No future prices or indicators.",
    inputSchema: obj({ tickers: Type.Optional(tickers(256)) }),
  },
  {
    name: "price_history",
    description:
      "OHLCV through the previous session close. Request any eligible ticker batch and exactly lookback bars per ticker, within the advertised history limit. Responses are limited to 512 KiB; split oversized requests into smaller batches or use fewer bars. No end-date input.",
    inputSchema: priceHistorySchema(POLICY.maxHistory),
  },
  {
    name: "journal",
    description:
      "Own committed past notes, verbatim, newest first. Combine canonical ticker or frozen company name, exact past date and whitespace-separated query keywords: ALL keywords must occur in text or optional tags, case-insensitively. Ticker filters match declared tickers or standalone symbols in prose. Pages fill a 12,000-character note budget; use nextCursor with the same filters. Zero matches include a bounded recent date/ticker index and retry guidance.",
    inputSchema: obj({
      ticker: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      date: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
      query: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      cursor: Type.Optional(Type.Integer({ minimum: 0, maximum: 100000 })),
    }),
  },
  {
    name: "submit_day",
    description:
      "Final ordered trade batch and short free-text journal. Optional tags: up to 8 unique lowercase slugs (letters/digits separated by hyphens, max 48 characters each), e.g. phase-defensive or rule-tsla-428, for later keyword search. No required prose or Markdown structure. Empty orders means hold. Choose exactly one of notionalUsd (dollars) or units (shares) per order. Valid submission ends model work; no follow-up response.",
    inputSchema: obj({
      orders: Type.Array(
        obj({
          side: Type.Union([Type.Literal("BUY"), Type.Literal("SELL")]),
          ticker,
          notionalUsd: Type.Optional(positive),
          units: Type.Optional(positive),
        }),
        { maxItems: POLICY.maxOrders },
      ),
      journal: journalSchema,
    }),
  },
];
export class SessionTools {
  readonly definitions: typeof toolDefinitions;
  private closed = false;
  private calls = 0;
  private receipts = new Set<string>();
  private submitted?: Submission;
  private deliveries = new Map<
    string,
    { name: unknown; args: unknown; result: any }
  >();
  readonly trace: any[] = [];
  boundedReason?: string;
  integrityError?: string;
  constructor(
    readonly view: SessionView,
    private store: JournalStore,
    private past: JournalEntry[],
    private deadline: number,
    private onAudit: (e: any) => void = () => {},
  ) {
    this.definitions = deepFreeze(toolDefinitions.map((tool) =>
      tool.name === "price_history"
        ? { ...tool, inputSchema: priceHistorySchema(availableHistoryBars(view), view.universe.length) }
        : tool,
    ));
    this.past = deepFreeze(structuredClone(past));
    if (
      past.some(
        (e, i) =>
          e.date >= view.scope.date ||
          (e.runId !== view.scope.runId && !inheritedRuns.get(view.scope.runId)?.has(e.runId)) ||
          (i > 0 && e.date <= past[i - 1]!.date),
      )
    )
      throw new Error("Foreign/future/unordered journal supplied");
    this.receipts.add(openingPortfolio(view).receipt.id);
    this.receipts.add(openingContext(view, view.horizon, past).receipt.id);
  }
  revoke() {
    this.closed = true;
  }
  orders() {
    return structuredClone(this.submitted?.orders ?? []);
  }
  submission() {
    return structuredClone(this.submitted);
  }
  prompt() {
    return dailyPrompt(
      this.view,
      this.view.horizon.start,
      this.view.horizon.end,
      this.view.horizon.contributions,
      this.past,
    );
  }
  call(name: unknown, args: unknown, providerCallId?: string): any {
    if (providerCallId && this.deliveries.has(providerCallId)) {
      const old = this.deliveries.get(providerCallId)!;
      if (old.name !== name || contentHash(old.args) !== contentHash(args)) {
        this.integrityError = "Conflicting provider call identity";
        throw new Error(this.integrityError);
      }
      this.record({
        type: "tool_delivery_retry",
        providerCallId,
        name,
        arguments: args,
        result: old.result,
      });
      return structuredClone(old.result);
    }
    const sequence = ++this.calls;
    const callId = `${this.view.scope.date}:${this.view.scope.attempt}:t${sequence}`;
    // Provider identity is attached by the bridge; deterministic transports use host sequence IDs.
    const identity = providerCallId ?? `control-${sequence}`;
    this.record({
      type: "tool_attempt",
      name,
      arguments: args,
      providerCallId: identity,
    });
    let result: any;
    try {
      if (this.closed) throw new Error("Session is closed");
      if (Date.now() >= this.deadline) {
        this.boundedReason = "Host watchdog expired";
        this.closed = true;
        throw new Error(this.boundedReason);
      }
      const tool = this.definitions.find((t) => t.name === name);
      if (!tool) {
        this.integrityError = "Unknown tool";
        throw new Error(this.integrityError);
      }
      if (Buffer.byteLength(JSON.stringify(args)) > POLICY.maxRequestBytes)
        throw new Error("Request is too large");
      if (!Check(tool.inputSchema, args))
        throw new Error(
          "Invalid arguments: " +
            Errors(tool.inputSchema, args)
              .slice(0, 4)
              .map((e) => `${e.instancePath} ${e.message}`)
              .join("; "),
        );
      const a = args as Record<string, any>;
      if (this.submitted && name !== "submit_day")
        throw new Error("Decision already submitted");
      let data: unknown;
      if (name === "market_snapshot" || name === "price_history") {
        const selected: string[] = a.tickers ?? [...this.view.universe];
        if (selected.some((t) => !this.view.universe.includes(t)))
          throw new Error("Security unavailable");
        data = {
          observedThrough: this.view.scope.observationDate,
          adjustment: "as-of-session-splits-only",
          securities: Object.fromEntries(
            selected.map((t) => [
              t,
              name === "market_snapshot"
                ? { previousClose: this.view.bars[t]!.at(-1)!.close }
                : this.view.bars[t]!.slice(-a.lookback),
            ]),
          ),
        };
      } else if (name === "journal") {
        if (a.date) {
          assertDate(a.date);
          if (a.date >= this.view.scope.date)
            throw new Error("Journal date unavailable");
        }
        let resolved: string[] | undefined;
        if (a.ticker) {
          const key = normalizeAlias(a.ticker);
          resolved = this.view.universe.filter(
            (t) =>
              normalizeAlias(t) === key ||
              this.view.aliases[t]?.some((x) => normalizeAlias(x) === key),
          );
          if (!resolved.length) throw new Error("Security unavailable");
        }
        data = readJournal(this.past, this.view.universe, {
          date: a.date, tickers: resolved, query: a.query, cursor: a.cursor,
        });
      } else {
        assertJournalNote(a.journal);
        if (a.journal.tickers.some((t) => !this.view.universe.includes(t)))
          throw new Error("Journal ticker unavailable");
        const cited = a.journal.evidence_refs ?? [];
        if (cited.some((id) => !this.receipts.has(id)))
          throw new Error("Evidence unavailable in this session");
        const orders: OrderRequest[] = a.orders.map((o: any) => {
          if (!this.view.universe.includes(o.ticker))
            throw new Error("Order security unavailable");
          if ((o.notionalUsd === undefined) === (o.units === undefined))
            throw new Error("Provide exactly one sizing field");
          return {
            ticker: o.ticker,
            side: o.side,
            sizing:
              o.units !== undefined
                ? { kind: "units", units: o.units }
                : { kind: "notional", usd: o.notionalUsd },
          };
        });
        const id = `${this.view.scope.date}:${this.view.scope.attempt}:submission`;
        const submission: Submission = {
          id,
          providerCallId: identity,
          orders,
          orderIds: orders.map((_, i) => `${id}:o${i + 1}`),
          journal: {
            id: `${id}:journal`,
            runId: this.view.scope.runId,
            date: this.view.scope.date,
            attempt: this.view.scope.attempt,
            text: a.journal.text,
            tickers: [...a.journal.tickers],
            ...(a.journal.tags === undefined ? {} : { tags: [...a.journal.tags] }),
            evidenceRefs: [...cited],
          },
          seenEvidenceRefs: [...this.receipts],
        };
        if (this.submitted) {
          // Delivery retries are idempotent; a different decision is never accepted.
          if (
            contentHash({
              ...submission,
              providerCallId: this.submitted.providerCallId,
            }) !== contentHash(this.submitted)
          )
            throw new Error("Conflicting second submission");
        } else this.submitted = this.store.submit(this.view.scope, submission);
        data = {
          submitted: true,
          submissionId: this.submitted.id,
          orderCount: this.submitted.orders.length,
          journalId: this.submitted.journal.id,
        };
      }
      const receipt = {
        id: callId,
        sessionDate: this.view.scope.date,
        observedThrough: this.view.scope.observationDate,
        resultHash: contentHash(data),
      };
      result = {
        content: [{ type: "text", text: JSON.stringify({ receipt, data }) }],
      };
      if (Buffer.byteLength(JSON.stringify(result)) > POLICY.maxResponseBytes)
        throw new Error(name === "price_history"
          ? "History response exceeds 512 KiB; request fewer tickers or a shorter lookback. No partial history was returned."
          : "Response size limit exceeded");
      if (name !== "submit_day") this.receipts.add(callId);
    } catch (e) {
      result = {
        content: [
          {
            type: "text",
            text: e instanceof Error ? e.message : "Tool rejected",
          },
        ],
        isError: true,
      };
    }
    this.record({ type: "tool_result", name, result });
    this.deliveries.set(identity, {
      name,
      args: structuredClone(args),
      result: structuredClone(result),
    });
    return result;
  }
  private record(e: any) {
    this.store.audit(this.view.scope, e);
    this.onAudit(e);
    this.trace.push(e);
  }
}
export const normalizeAlias = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/(?:incorporated|corporation|inc|corp|plc|ltd)$/, "");
