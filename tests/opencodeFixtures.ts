import type { QualifiedRoute, CatalogModelEvidence } from "../src/opencode/qualification.ts";

export function catalogFixture(route: QualifiedRoute): CatalogModelEvidence {
  return {
    id: route.model, providerID: route.provider,
    name: route.provider === "opencode" ? "Muse Spark Free" : "GPT-5.6 Luna",
    status: "active", api: { id: route.model, url: route.apiURL, npm: "@ai-sdk/openai" },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 }, tiers: [] },
    capabilities: { toolcall: true },
  };
}
