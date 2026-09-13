/** Yahoo chart conversion is deliberately separate from networking for offline
 * reproduction. quote OHLC, volume and dividends are split-adjusted. adjclose
 * additionally includes distributions and is NEVER an execution/valuation input. */
import type { OhlcvBar } from "../domain/types.ts";
import { assertSupportedSplitRatio, validateBars, type CorporateAction } from "./dataset.ts";
import { assertDate } from "./calendar.ts";

type YahooEvent = { date: number; amount?: number; numerator?: number; denominator?: number };
interface YahooResult {
  meta: { symbol: string; currency: string; exchangeTimezoneName: string; instrumentType: string };
  timestamp: number[];
  indicators: { quote: Array<Record<"open" | "high" | "low" | "close" | "volume", Array<number | null>>> };
  events?: { splits?: Record<string, YahooEvent>; dividends?: Record<string, YahooEvent>; capitalGains?: Record<string, YahooEvent> };
}
export interface YahooConversion { bars: OhlcvBar[]; actions: CorporateAction[]; allSplits: CorporateAction[] }
export const yahooSymbol = (ticker: string) => ticker === "BRK.B" ? "BRK-B" : ticker;
function sessionDate(timestamp: number): string {
  if (!Number.isSafeInteger(timestamp)) throw new Error("Invalid Yahoo timestamp");
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(timestamp * 1000));
}
export function convertYahooChart(raw: unknown, ticker: string, start: string, end: string): YahooConversion {
  assertDate(start); assertDate(end);
  if (start > end) throw new Error("Yahoo conversion start is after end");
  const envelope = raw as { chart?: { error?: unknown; result?: YahooResult[] } };
  const result = envelope?.chart?.result;
  if (envelope?.chart?.error || !Array.isArray(result) || result.length !== 1) throw new Error(`Yahoo chart error or missing result for ${ticker}`);
  const r = result[0]!;
  if (r.meta?.symbol !== yahooSymbol(ticker) || r.meta.currency !== "USD" || r.meta.exchangeTimezoneName !== "America/New_York" || !["EQUITY", "ETF"].includes(r.meta.instrumentType)) throw new Error(`Unsupported Yahoo symbol/currency/exchange/instrument for ${ticker}`);
  if (Object.keys(r.events?.capitalGains ?? {}).length) throw new Error(`Unsupported capital-gain distribution for ${ticker}`);
  const allSplits: CorporateAction[] = Object.values(r.events?.splits ?? {}).map((event): CorporateAction => {
    const ratio = Number(event.numerator) / Number(event.denominator);
    if (!Number.isFinite(ratio) || ratio <= 0 || !event.numerator || !event.denominator || event.numerator < 0 || event.denominator < 0) throw new Error(`Invalid Yahoo split for ${ticker}`);
    const date = sessionDate(event.date);
    if (date >= start) assertSupportedSplitRatio(ratio, ticker, date);
    return { type: "split", date, ticker, ratio };
  }).filter(split => split.date >= start).sort((a, b) => a.date.localeCompare(b.date));
  if (new Set(allSplits.map(s => s.date)).size !== allSplits.length) throw new Error(`Duplicate Yahoo split for ${ticker}`);
  const futureFactor = (date: string): number => allSplits.reduce((factor, split) => split.date > date && split.type === "split" ? factor * split.ratio : factor, 1);
  const q = r.indicators?.quote?.[0];
  if (!q || !Array.isArray(r.timestamp) || !r.timestamp.length) throw new Error(`Missing Yahoo bars for ${ticker}`);
  for (const key of ["open", "high", "low", "close", "volume"] as const) if (!Array.isArray(q[key]) || q[key].length !== r.timestamp.length) throw new Error(`Yahoo ${key} length mismatch for ${ticker}`);
  const bars: OhlcvBar[] = [];
  let previous = "";
  for (let i = 0; i < r.timestamp.length; i++) {
    const date = sessionDate(r.timestamp[i]!);
    if (date < start || date > end) continue;
    if (date <= previous) throw new Error(`Duplicate/unsorted Yahoo session for ${ticker}: ${date}`);
    previous = date;
    const factor = futureFactor(date);
    for (const key of ["open", "high", "low", "close", "volume"] as const) if (typeof q[key][i] !== "number" || !Number.isFinite(q[key][i])) throw new Error(`Missing/nonfinite Yahoo ${ticker} ${date} ${key}`);
    bars.push({ date, open: q.open[i]! * factor, high: q.high[i]! * factor, low: q.low[i]! * factor, close: q.close[i]! * factor, volume: q.volume[i]! / factor });
  }
  const dividends: CorporateAction[] = Object.values(r.events?.dividends ?? {}).map(event => {
    const date = sessionDate(event.date);
    const amount = event.amount! * futureFactor(date);
    if (typeof event.amount !== "number" || !Number.isFinite(amount) || amount <= 0) throw new Error(`Invalid Yahoo dividend for ${ticker}`);
    return { type: "dividend", date, ticker, amount };
  });
  const actions = [...allSplits, ...dividends].filter(a => a.date >= start && a.date <= end).sort((a, b) => a.date.localeCompare(b.date) || (a.type === b.type ? 0 : a.type === "split" ? -1 : 1));
  return { bars: validateBars(bars, ticker), actions, allSplits };
}
