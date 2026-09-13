import { expect, test } from "bun:test";
import { assertZeroCostCatalogEntry, parseQualifiedCatalogEntry } from "../src/opencode/qualification.ts";
import { OpenCodeAgent } from "../src/opencode/agent.ts";

const valid = {
  id: "muse-spark-1.3-contributor-free", providerID: "opencode", name: "Muse Spark 1.3 Free", status: "active",
  api: { id: "muse-spark-1.3-contributor-free", url: "https://opencode.ai/zen/v1", npm: "@ai-sdk/openai" },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 }, tiers: [] }, capabilities: { toolcall: true },
};
test("exact refreshed catalog entry proves active zero-cost Zen tool-call routing", () => {
  const output = `opencode/similarly-named\n${JSON.stringify({ ...valid, id: "other" })}\nopencode/muse-spark-1.3-contributor-free\n${JSON.stringify(valid)}\n`;
  const entry = parseQualifiedCatalogEntry(output);
  expect(entry).toEqual(valid);
  expect(() => assertZeroCostCatalogEntry(entry)).not.toThrow();
});
test("catalog qualification fails closed on absence, price tiers, status, endpoint, name, or tools", () => {
  expect(() => parseQualifiedCatalogEntry("opencode/muse-spark-1.3-free\n{}\n")).toThrow(/absent/);
  for (const patch of [
    { cost: { ...valid.cost, output: 0.01 } }, { cost: { ...valid.cost, tiers: [{ input: 0 }] } },
    { status: "deprecated" }, { api: { ...valid.api, url: "https://example.test" } },
    { name: "Muse Spark" }, { capabilities: { toolcall: false } },
  ]) expect(() => assertZeroCostCatalogEntry({ ...valid, ...patch })).toThrow();
});
test("official adapter constructor permits no alternate provider, model, or paid override", () => {
  expect(() => new OpenCodeAgent()).not.toThrow();
  expect(() => new OpenCodeAgent("muse-spark-1.3-free")).toThrow(/exact zero-cost/);
  expect(() => new OpenCodeAgent("muse-spark-1.3-contributor-free", "other")).toThrow(/exact zero-cost/);
  expect(() => new OpenCodeAgent("muse-spark-1.3-contributor-free", "opencode", { freeOnly: false })).toThrow(/exact zero-cost/);
});
