import { loadDataset, type MarketDataset } from "../data/dataset.ts";
import { buildDailyPrompt, buildSystemPrompt } from "../agent/prompt.ts";
import { computeIndicators } from "../data/indicators.ts";
import { executeOrder } from "../engine/execution.ts";
import { applyFill, isTerminated, valuePortfolio } from "../engine/portfolio.ts";
import { contributionOn, preparePortfolio } from "../engine/cashFlows.ts";
import type { AgentDecision, AgentPort, DailyRecord, DecisionContext, FailedOrder, Fill, Indicators, OhlcvBar, PortfolioState, RunConfig } from "../domain/types.ts";
import { ARTIFACT_VERSION, contentHash, sealRecord, textHash, validateUsage } from "./persist.ts";

export class DecisionAttemptError extends Error {
  constructor(readonly date: string, readonly decision: AgentDecision, reason?: string, readonly failurePhase?: "validation" | "execution") {
    super(reason ?? decision.terminalReason ?? decision.boundedReason ?? `Decision ${decision.outcome ?? "budget_cutoff"} on ${date}`);
  }
}

/** Replay is shared by live execution and artifact validation. No model calls. */
export function replayDecision(config: RunConfig, date: string, universe: readonly string[], previous: PortfolioState, decision: AgentDecision, market: MarketDataset, recentDays: DailyRecord[] = [], priorAttemptHashes: string[] = []): DailyRecord {
  const context = buildDecisionContext(config, date, universe, previous, recentDays, market);
  const contextHash = contentHash(context);
  try { validateDecisionEvidence(decision, contextHash, config, date, context); }
  catch (error) { throw new DecisionAttemptError(date, decision, error instanceof Error ? error.message : String(error), "validation"); }
  if (decision.boundedStop || (decision.outcome !== undefined && decision.outcome !== "completed")) throw new DecisionAttemptError(date, decision);
  try {
  const contribution = contributionOn(config.contributions, date);
  const corporateActions = market.actionsOn(date);
  let portfolio = preparePortfolio(previous, contribution, corporateActions);
  const before = portfolio.netWorth;
  const fills: Fill[] = [], failedOrders: FailedOrder[] = [...decision.failedOrders];
  for (const order of decision.orders) {
    if (!universe.includes(order.ticker)) {
      failedOrders.push({ date, ticker: order.ticker, side: order.side, reason: `"${order.ticker}" is not in the trading universe.` });
      continue;
    }
    const price = market.openOn(order.ticker, date);
    if (price === undefined) { failedOrders.push({ date, ticker: order.ticker, side: order.side, reason: `No open price for ${order.ticker} on ${date}.` }); continue; }
    const result = executeOrder(order, price, portfolio, date);
    if ("fill" in result) { portfolio = applyFill(portfolio, result.fill); fills.push(result.fill); }
    else failedOrders.push(result.failed);
  }
  portfolio = valuePortfolio(portfolio, (t) => market.closeOn(t, date));
  const turnover = fills.reduce((sum, f) => sum + f.notional, 0);
  const totalPrincipal = config.startingCapital + (config.contributions ?? []).filter((c) => c.date <= date).reduce((sum, c) => sum + c.amount, 0);
  return sealRecord({ artifactVersion: ARTIFACT_VERSION, outcome: "completed", contextHash, priorAttemptHashes, date, contribution, corporateActions,
    submittedOrders: decision.submittedOrders ?? decision.orders, decision,
    portfolioBefore: previous, portfolioAfter: portfolio, fills, failedOrders,
    rationale: decision.rationale, usage: decision.usage,
    turnoverPct: before > 0 ? Math.round(turnover / before * 1e6) / 1e4 : 0,
    terminated: config.experiment !== "three-month" && isTerminated(portfolio, totalPrincipal), boundedStop: false, boundedReason: null });
  } catch (error) { throw new DecisionAttemptError(date, decision, error instanceof Error ? error.message : String(error), "execution"); }
}

export function buildDecisionContext(config: RunConfig, date: string, universe: readonly string[], portfolioBefore: PortfolioState, recentDays: DailyRecord[], market: MarketDataset): DecisionContext {
  const bars: Record<string, OhlcvBar[]> = {}, indicators: Record<string, Indicators> = {};
  for (const ticker of universe) {
    const history = market.asOfBefore(ticker, date);
    bars[ticker] = history.slice(-Math.max(config.warmupBars ?? 60, 60));
    indicators[ticker] = computeIndicators(history);
  }
  const portfolio = preparePortfolio(portfolioBefore, contributionOn(config.contributions, date), market.actionsOn(date));
  return { date, universe, portfolio: structuredClone(portfolio), bars, indicators,
    recentDays: structuredClone(recentDays), limits: { ...config.limits },
    horizon: config.experiment ? { startDate: config.startDate, endDate: config.endDate } : undefined, contributions: structuredClone(config.contributions) };
}

/** Checks provider evidence against the actual context, not merely its own checksum. */
export function validateDecisionEvidence(decision: AgentDecision, contextHash: string, config: RunConfig, date: string, context?: DecisionContext): void {
  if (!decision || !Array.isArray(decision.orders) || !Array.isArray(decision.failedOrders) || typeof decision.rationale !== "string" || typeof decision.boundedStop !== "boolean") throw new Error(`Invalid decision schema for ${date}`);
  validateUsage(decision.usage);
  for (const order of decision.orders) if (!order || typeof order.ticker !== "string" || !["BUY", "SELL"].includes(order.side) || !order.sizing || !["notional", "units"].includes(order.sizing.kind)) throw new Error(`Invalid submitted order schema for ${date}`);
  for (const failure of decision.failedOrders) if (!failure || failure.date !== date || typeof failure.ticker !== "string" || !["BUY", "SELL"].includes(failure.side) || typeof failure.reason !== "string") throw new Error(`Invalid rejected order schema for ${date}`);
  const protocol = decision.trace?.find((event): event is Record<string, unknown> => !!event && typeof event === "object" && (event as Record<string, unknown>).type === "protocol");
  if (protocol) {
    const basePrompt = buildSystemPrompt(config.limits);
    const expectedPrompt = config.agent === "opencode"
      ? `${basePrompt}\nTrading tool names use the trading_ prefix (for example trading_get_indicators and trading_buy).`
      : basePrompt;
    if (decision.effectiveSystemPrompt !== expectedPrompt) throw new Error(`Decision system prompt does not match benchmark protocol for ${date}`);
    if (protocol.contextHash !== contextHash || protocol.model !== config.model || protocol.provider !== (config.provider ?? "opencode")) throw new Error(`Decision protocol context/model/provider mismatch for ${date}`);
    if (typeof decision.effectiveSystemPrompt !== "string" || decision.promptHash !== textHash(decision.effectiveSystemPrompt) || protocol.systemPrompt !== decision.effectiveSystemPrompt || protocol.promptHash !== decision.promptHash) throw new Error(`Decision effective prompt mismatch for ${date}`);
    if (context && protocol.dailyPrompt !== buildDailyPrompt(context)) throw new Error(`Decision daily prompt does not match causal context for ${date}`);
    if (protocol.dailyPromptHash !== undefined && (typeof protocol.dailyPrompt !== "string" || protocol.dailyPromptHash !== textHash(protocol.dailyPrompt))) throw new Error(`Decision daily prompt checksum mismatch for ${date}`);
  } else if (config.agent !== "fake" && config.experiment) throw new Error(`Missing live protocol evidence for ${date}`);
}

export async function runOneDay(agent: AgentPort, config: RunConfig, date: string, universe: readonly string[], portfolioBefore: PortfolioState, recentDays: DailyRecord[], dataset?: MarketDataset, priorAttemptHashes: string[] = []): Promise<DailyRecord> {
  const market = dataset ?? await loadDataset(config.dataDir);
  const context = buildDecisionContext(config, date, universe, portfolioBefore, recentDays, market);
  const decision = await agent.decide(context);
  return replayDecision(config, date, universe, portfolioBefore, decision, market, recentDays, priorAttemptHashes);
}
