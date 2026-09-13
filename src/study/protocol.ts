import type {
  DecisionContext,
  OhlcvBar,
  PortfolioState,
  RunLimits,
} from "../domain/types.ts";
import { assertDate, exchangeDates, shiftDate } from "../data/calendar.ts";
import { computeIndicators } from "../data/indicators.ts";
import { contentHash } from "../run/persist.ts";
import { MAX_MEMO_CHARS } from "./memo.ts";

export const STUDY_PROTOCOL = "v10-unlimited-turns-portfolio-context";
export type StudyLimits = RunLimits<null>;
export interface SessionHorizon {
  start: string;
  end: string;
  contributions: unknown;
}
export const STUDY_TOOLS = [
  "get_universe",
  "get_price",
  "get_ohlcv",
  "get_indicators",
  "get_portfolio",
  "buy",
  "sell",
  "journal_append",
  "journal_read",
  "journal_search",
] as const;
export const POLICY = Object.freeze({
  version: STUDY_PROTOCOL,
  maxHistory: 252,
  maxAttemptsPerDay: 3,
  maxEntryChars: 2000,
  maxMemoChars: MAX_MEMO_CHARS,
  maxEntries: 8,
  maxReadChars: 12000,
  maxRequestBytes: 16384,
  maxResponseBytes: 131072,
  maxOutputBytes: 16777216,
  reports: "disabled-technical-only",
  journal: "own-committed-past-and-current-attempt",
});
export interface SessionScope {
  protocol: string;
  runId: string;
  date: string;
  attempt: number;
  observationDate: string;
  reportCutoff: string;
}
export interface SessionView {
  scope: SessionScope;
  universe: readonly string[];
  bars: Record<string, OhlcvBar[]>;
  indicators: DecisionContext["indicators"];
  portfolio: PortfolioState;
  limits: StudyLimits;
}
export function scopeFor(
  runId: string,
  date: string,
  attempt: number,
): SessionScope {
  assertDate(date);
  if (
    !/^[a-zA-Z0-9_-]{1,120}$/.test(runId) ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    attempt > POLICY.maxAttemptsPerDay
  )
    throw new Error("Invalid session identity");
  if (exchangeDates(date, date).length !== 1)
    throw new Error("Session must be an exchange day");
  const prior = exchangeDates(shiftDate(date, -14), shiftDate(date, -1)).at(-1);
  if (!prior) throw new Error("Missing observation session");
  const month = Math.floor((Number(date.slice(5, 7)) - 1) / 3) * 3 + 1;
  return Object.freeze({
    protocol: STUDY_PROTOCOL,
    runId,
    date,
    attempt,
    observationDate: prior,
    reportCutoff: `${date.slice(0, 4)}-${String(month).padStart(2, "0")}-01`,
  });
}
export function makeView(
  ctx: DecisionContext<null>,
  scope: SessionScope,
): SessionView {
  if (
    ctx.date !== scope.date ||
    contentHash(scope) !==
      contentHash(scopeFor(scope.runId, scope.date, scope.attempt))
  )
    throw new Error("Context/session mismatch");
  if (
    !ctx.universe.length ||
    new Set(ctx.universe).size !== ctx.universe.length
  )
    throw new Error("Invalid universe");
  const bars: SessionView["bars"] = {},
    indicators: SessionView["indicators"] = {};
  for (const ticker of ctx.universe) {
    if (!/^[A-Z][A-Z0-9.-]{0,15}$/.test(ticker))
      throw new Error("Invalid security identity");
    const history = ctx.bars[ticker];
    for (const bar of history ?? []) assertDate(bar.date);
    if (
      !history?.length ||
      history.at(-1)!.date !== scope.observationDate ||
      history.some(
        (b, i) =>
          b.date > scope.observationDate ||
          (i > 0 && b.date <= history[i - 1]!.date) ||
          ![b.open, b.high, b.low, b.close].every(
            (n) => Number.isFinite(n) && n > 0,
          ) ||
          !Number.isFinite(b.volume) ||
          b.volume < 0 ||
          b.low > Math.min(b.open, b.close) ||
          b.high < Math.max(b.open, b.close),
      )
    )
      throw new Error("Invalid or noncausal market snapshot");
    // Indicators and raw observations use the same eligible prefix, never supplied future-derived indicators.
    bars[ticker] = structuredClone(history.slice(-POLICY.maxHistory));
    indicators[ticker] = computeIndicators(bars[ticker]!);
  }
  if (ctx.limits.maxTurns !== null)
    throw new Error("Study model turns must be unlimited (maxTurns: null)");
  for (const n of [
    ctx.limits.maxToolCalls,
    ctx.limits.timeoutMs,
  ])
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error("Invalid budget");
  if (
    ctx.limits.maxToolCalls > 64 ||
    ctx.limits.timeoutMs > 300000
  )
    throw new Error("Study budget exceeds hard limits");
  if (!Number.isFinite(ctx.portfolio.cash) || ctx.portfolio.cash < 0)
    throw new Error("Invalid portfolio");
  for (const [ticker, h] of Object.entries(ctx.portfolio.holdings))
    if (
      !ctx.universe.includes(ticker) ||
      h.lastClose !== bars[ticker]!.at(-1)!.close
    )
      throw new Error("Portfolio mark is not observable");
  return deepFreeze({
    scope,
    universe: [...ctx.universe],
    bars,
    indicators,
    portfolio: structuredClone(ctx.portfolio),
    limits: { ...ctx.limits },
  });
}
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}
export const viewHash = (view: SessionView) => contentHash(view);
/** A host-provided, citable snapshot; loading it consumes no tool call. */
export function openingPortfolio(view: SessionView) {
  return {
    receipt: {
      id: `${view.scope.date}:${view.scope.attempt}:opening-portfolio`,
      sessionDate: view.scope.date,
      observedThrough: view.scope.observationDate,
      resultHash: contentHash(view.portfolio),
    },
    data: structuredClone(view.portfolio),
  };
}
export function systemPrompt(limits: StudyLimits): string {
  return [
    "You manage a long-only fractional-share paper portfolio using supplied historical technical data.",
    "Choose your own securities, sizing, cash retention, concentration, diversification, turnover, and analysis. Buying, selling, holding, and all-cash are all permitted. No particular indicators or tool sequence are required.",
    "The runner sets the simulated session date. Prices are the latest observable PREVIOUS-session closes, labeled with their observation date. Today's opening price is unknown. Orders are queued and execute in order at today's open only after you finish; queued orders never update portfolio tools. A sale can fund only later queued buys. No leverage, shorts, fees, or modeled slippage. Contributions/actions shown by portfolio tools are already applied.",
    "Your opening context includes your current pretrade portfolio: available cash, holdings with units, average cost, latest observable close and value, total holdings value and net worth. Due contributions/actions are already applied. Its opening-portfolio receipt is valid journal evidence; no get_portfolio call is needed to load or cite it. Obtain any other financial information through trading tools. No browsing, shell, filesystem, external data, or recalled future information is permitted. Tools accept no price dates. Reports/news are unavailable in this technical-only protocol.",
    "Your journal is the durable decision record and memory within this run. Read the previous committed decision when available and reassess its thesis against current observable evidence. Existing entries cannot be edited. After queuing final orders (or choosing to hold), call journal_append with a concise text summary and a structured decision object: thesis; evidence (1-8 claims each with 1-2 exact receiptIds from information tools or the opening portfolio); allocation (why these sizes, cash and concentration, distinguishing queued intent from unknown fills); alternatives (including hold, and why rejected); risks (uncertainty and contrary evidence); invalidation (observable conditions to reconsider and next review); continuity (what changed or remained valid since the prior memo, or explicitly first day). Keep the memo concise, at most 5000 characters in total. Each prose field and claim needs at least 10 characters of substantive explanation; do not use placeholders. Cite actual receipt IDs, not informal t1 labels. Evidence presence does not prove a claim correct. Record stated decision justifications, not private chain-of-thought. No trading style or preferred indicator is required.",
    `Model turns are unlimited. Session limits: ${limits.maxToolCalls} attempted tools, ${limits.timeoutMs}ms including startup. Complete analysis in time to queue orders, append the final structured memo, and finish. One memo can cover the entire portfolio; additional research notes are optional. Each tool receipt shows remaining tool calls. Journal: ${POLICY.maxEntries} entries, summaries of ${POLICY.maxEntryChars} characters plus a decision memo of ${POLICY.maxMemoChars} characters; reads bounded to ${POLICY.maxReadChars} characters.`,
    "Finish with a concise final decision summary. No calls are allowed after the session ends. A failed, timed-out, or budget-cutoff attempt executes no orders. Trading tool names use the trading_ prefix.",
  ].join("\n");
}
export function dailyPrompt(
  view: SessionView,
  start: string,
  end: string,
  contributions: unknown,
  journalHistory: { lastCommittedDate: string | null; entries: number } = { lastCommittedDate: null, entries: 0 },
): string {
  const { scope } = view;
  return `Session date: ${scope.date}. Observable market through: ${scope.observationDate} close. Horizon: ${start} through ${end}. Scheduled contributions: ${JSON.stringify(contributions)}.
Opening portfolio (available cash includes due contributions/actions; holdings are marked at the observable previous close; today's fills are unknown). Cite this receipt in your decision memo when using the opening state:
${JSON.stringify(openingPortfolio(view))}
Journal scope: your own run, committed past and current attempt only. Committed journal entries: ${journalHistory.entries}. ${journalHistory.lastCommittedDate ? `Latest committed journal date: ${journalHistory.lastCommittedDate}; use journal_read for that date to review the previous decision. Earlier notes remain searchable.` : "No prior committed journal; this is the first decision."} Previous conversation transcripts are not carried forward. Decide freely and record your structured decision before finishing.`;
}
