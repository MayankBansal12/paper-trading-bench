// Tool registry — builds all 7 tools sharing the same TradingContext so
// buy/sell can mutate the in-memory portfolio and every tool sees the
// freshest state on the next call.

import type { ToolDefinition, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TradingContext } from "./context.ts";
import { buildGetPortfolioTool } from "./portfolio.ts";
import { buildGetPriceTool } from "./price.ts";
import { buildSearchNewsTool } from "./news.ts";
import { buildBuyTool } from "./buy.ts";
import { buildSellTool } from "./sell.ts";
import { buildGetWeeklySummaryTool } from "./summary.ts";

/** Build the array of all 7 tool definitions bound to the given context. */
export function buildAllTools(ctx: TradingContext): ToolDefinition[] {
  return [
    buildGetPortfolioTool(ctx),
    buildGetPriceTool(ctx),
    buildSearchNewsTool(),
    buildBuyTool(ctx),
    buildSellTool(ctx),
    buildGetWeeklySummaryTool(),
  ];
}

/** Extension factory: registers all 7 tools with the pi extension runtime. */
export function createTradingToolsExtension(ctx: TradingContext) {
  return (pi: ExtensionAPI) => {
    for (const tool of buildAllTools(ctx)) {
      pi.registerTool(tool);
    }
  };
}
