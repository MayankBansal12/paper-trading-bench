// get_weekly_summary — concatenates the last 7 daily summary .md files.
// Pure read. No side effects.

import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getWeeklySummaries } from "../summary/manager.ts";

const Schema = Type.Object({});

export function buildGetWeeklySummaryTool(): ToolDefinition<typeof Schema, unknown> {
  return {
    name: "get_weekly_summary",
    label: "Get Weekly Summary",
    description:
      "Returns the markdown content of the last 7 daily summary files (one per recent trading day, in chronological order, gaps skipped). This is your only memory of past decisions across sessions — use it to recall what you did and why before making new trades.",
    parameters: Schema,
    execute: async () => {
      const summaries = await getWeeklySummaries();
      if (summaries.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No prior summaries on record. This is your first session.",
            },
          ],
          details: { count: 0 },
        };
      }
      const joined = summaries
        .map((md, i) => `--- Summary ${i + 1} of ${summaries.length} ---\n${md.trim()}`)
        .join("\n\n");
      return {
        content: [{ type: "text" as const, text: joined }],
        details: { count: summaries.length },
      };
    },
  };
}

export type GetWeeklySummaryParams = Static<typeof Schema>;
