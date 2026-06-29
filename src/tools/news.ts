// search_news — financial news headlines for a query.
// Pure read. No side effects.

import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { searchNews } from "../news/search.ts";

const Schema = Type.Object({
  query: Type.String({
    description:
      "Search query scoped to financial news. Can be a ticker symbol (e.g. 'NVDA'), a company name ('Nvidia'), or a topic ('AI chips', 'rate cuts').",
  }),
});

export function buildSearchNewsTool(): ToolDefinition<typeof Schema, unknown> {
  return {
    name: "search_news",
    label: "Search News",
    description:
      "Searches financial news for the given query and returns up to 10 recent headlines with publisher and link. Returns an empty list if no news is found or the call fails — this is non-critical and you can still make decisions without it.",
    parameters: Schema,
    execute: async (_id, params) => {
      const headlines = await searchNews(params.query);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { query: params.query, count: headlines.length, headlines },
              null,
              2,
            ),
          },
        ],
        details: { query: params.query, count: headlines.length },
      };
    },
  };
}

export type SearchNewsParams = Static<typeof Schema>;
