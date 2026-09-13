import type { MarketDataset } from "../data/dataset.ts";
import { contributionOn, preparePortfolio } from "../engine/cashFlows.ts";
import type {
  Contribution,
  DecisionContext,
  DailyRecord,
  Indicators,
  OhlcvBar,
  PortfolioState,
} from "../domain/types.ts";
import type { StudyLimits } from "./types.ts";
export interface ContextConfig {
  history: number;
  start: string;
  end: string;
  limits: StudyLimits;
  contributions: Contribution[];
}
export type EnvironmentContext = Omit<
  DecisionContext<null>,
  "limits" | "indicators"
> & { limits: StudyLimits };
export function buildDecisionContext(
  config: ContextConfig,
  date: string,
  universe: readonly string[],
  portfolioBefore: PortfolioState,
  recentDays: DailyRecord[],
  market: MarketDataset,
): EnvironmentContext {
  const bars: Record<string, OhlcvBar[]> = {};
  for (const ticker of universe) {
    const history = market.asOfBefore(ticker, date);
    bars[ticker] = history.slice(-Math.max(config.history, 60));
  }
  const portfolio = preparePortfolio(
    portfolioBefore,
    contributionOn(config.contributions, date),
    market.actionsOn(date),
  );
  return {
    date,
    universe,
    portfolio: structuredClone(portfolio),
    bars,
    recentDays: structuredClone(recentDays),
    limits: { ...config.limits },
    horizon: { startDate: config.start, endDate: config.end },
    contributions: structuredClone(config.contributions),
  };
}
