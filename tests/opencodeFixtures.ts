import type { QualifiedRoute, CatalogModelEvidence } from "../src/opencode/qualification.ts";

export function catalogFixture(route: QualifiedRoute): CatalogModelEvidence {
  return {
    id: route.model, providerID: route.provider,
    name: route.provider === "opencode" ? "Muse Spark Free"
      : route.provider === "opencode-go" ? "GLM 5.3 Flash" : "GPT-5.6 Luna",
    status: "active", api: { id: route.model, url: route.apiURL, npm: route.npm },
    cost: { input: route.cost.input, output: route.cost.output,
      cache: { read: route.cost.cacheRead, write: route.cost.cacheWrite }, tiers: [] },
    capabilities: { toolcall: true },
  };
}
