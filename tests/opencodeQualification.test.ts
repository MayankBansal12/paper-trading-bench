import { expect, test } from "bun:test";
import {
  assertZeroCostCatalogEntry,
  parseQualifiedCatalogEntry,
  QUALIFIED_ROUTES,
  qualifyOfficialOpenCode,
} from "../src/opencode/qualification.ts";
import { catalogFixture } from "./opencodeFixtures.ts";
import { makeClientConfig } from "../src/opencode/config.ts";

const valid = {
  id: "muse-spark-1.3-contributor-free",
  providerID: "opencode",
  name: "Muse Spark 1.3 Free",
  status: "active",
  api: {
    id: "muse-spark-1.3-contributor-free",
    url: "https://opencode.ai/zen/v1",
    npm: "@ai-sdk/openai",
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 }, tiers: [] },
  capabilities: { toolcall: true },
};
test("exact refreshed catalog entry proves active zero-cost Zen tool-call routing", () => {
  const output = `opencode/similarly-named\n${JSON.stringify({ ...valid, id: "other" })}\nopencode/muse-spark-1.3-contributor-free\n${JSON.stringify(valid)}\n`;
  const entry = parseQualifiedCatalogEntry(output);
  expect(entry).toEqual(valid);
  expect(() => assertZeroCostCatalogEntry(entry)).not.toThrow();
});
test("catalog qualification fails closed on absence, price tiers, status, endpoint, name, or tools", () => {
  expect(() =>
    parseQualifiedCatalogEntry("opencode/muse-spark-1.3-free\n{}\n"),
  ).toThrow(/absent/);
  for (const patch of [
    { cost: { ...valid.cost, output: 0.01 } },
    { cost: { ...valid.cost, tiers: [{ input: 0 }] } },
    { status: "deprecated" },
    { api: { ...valid.api, url: "https://example.test" } },
    { name: "Muse Spark" },
    { capabilities: { toolcall: false } },
  ])
    expect(() => assertZeroCostCatalogEntry({ ...valid, ...patch })).toThrow();
});
test("official adapter rejects alternate model and unqualified client before setup", async () => {
  await expect(
    makeClientConfig(
      "/unused",
      "opencode/paid-model",
      "prompt",
      "http://unused",
      "1.18.30",
    ),
  ).rejects.toThrow(/except/);
  await expect(
    makeClientConfig(
      "/unused",
      "opencode/muse-spark-1.3-contributor-free",
      "prompt",
      "http://unused",
      "other",
    ),
  ).rejects.toThrow(/qualified/);
});

for (const route of QUALIFIED_ROUTES) test(`${route.id}: exact catalog admission and no-inference commands`, async () => {
  const entry = catalogFixture(route);
  const catalog = QUALIFIED_ROUTES.map(r => `${r.id}\n${JSON.stringify(catalogFixture(r))}`).join("\n") + "\n";
  expect(parseQualifiedCatalogEntry(catalog, route.id)).toEqual(entry);
  expect(() => assertZeroCostCatalogEntry(entry, route.id)).not.toThrow();
  for (const patch of [
    { id: "other" }, { providerID: "other" }, { status: "deprecated" },
    { api: { ...entry.api, id: "alias" } }, { api: { ...entry.api, url: "https://other.test" } },
    { cost: { ...entry.cost, input: 1 } }, { cost: { ...entry.cost, output: 1 } },
    { cost: { ...entry.cost, cache: { read: 1, write: 0 } } },
    { cost: { ...entry.cost, cache: { read: 0, write: 1 } } },
    { cost: { input: 0, output: 0 } }, { cost: { ...entry.cost, tiers: [{}] } },
    { capabilities: {} }, { options: { reasoningEffort: "high" } },
    { headers: { authorization: "dummy-key" } },
  ]) expect(() => assertZeroCostCatalogEntry({ ...entry, ...patch } as any, route.id)).toThrow();
  for (const output of ["prefix/" + route.id + "\n" + JSON.stringify(entry),
    route.id + "\nother/model\n" + JSON.stringify(entry),
    route.id + "\n{" , catalog + catalog])
    expect(() => parseQualifiedCatalogEntry(output, route.id)).toThrow();
  const commands: string[][] = [];
  const evidence = await qualifyOfficialOpenCode(1000, route.id, async args => {
    commands.push(args);
    return { stdout: args[1] === "--version" ? "1.18.30" : catalog, stderr: "" };
  });
  expect(commands).toEqual([["opencode", "--version"], ["opencode", "models", route.provider, "--verbose", "--refresh"]]);
  expect(evidence.exactModel).toBe(route.id);
  expect(evidence.catalogEntry).toEqual(entry);
  expect(evidence.zeroCostProven).toBe(true);
  expect(evidence.noInference).toBe(true);
  expect(evidence.catalogAttempts).toHaveLength(1);
  await expect(qualifyOfficialOpenCode(1000, route.id, async () => ({ stdout: "1.18.31", stderr: "" }))).rejects.toThrow("not qualified");
});
test("catalog retries retain omissions and never substitute another route", async () => {
  const route = QUALIFIED_ROUTES[2]!;
  let calls = 0;
  const e = await qualifyOfficialOpenCode(1000, route.id, async args => ({
    stdout: args[1] === "--version" ? "1.18.30" : ++calls === 1 ? "" : `${route.id}\n${JSON.stringify(catalogFixture(route))}`, stderr: "",
  }));
  expect(e.catalogAttempts.map(a => a.matched)).toEqual([false, true]);
  expect(() => parseQualifiedCatalogEntry("", "openai/unqualified")).toThrow("Unqualified");
});
