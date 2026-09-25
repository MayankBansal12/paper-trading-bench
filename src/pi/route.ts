export const PI_MODEL_ID = "pi/openai-codex/gpt-6-astra";
export const PI_VERSION = "0.85.1";
export const PI_PROVIDER = "openai-codex";
export const PI_MODEL = "gpt-6-astra";
export const PI_THINKING = "medium";
export const PI_ROUTE = Object.freeze({
  id: PI_MODEL_ID,
  provider: PI_PROVIDER,
  model: PI_MODEL,
  apiURL: "https://chatgpt.com/backend-api",
  api: "openai-codex-responses",
  auth: "oauth",
  cost: null,
});

export const PI_SOL_MODEL_ID = "pi/openai-codex/gpt-5.6-sol";
export const PI_SOL6_MODEL_ID = "pi/openai-codex/gpt-6-sol";
export const PI_LUNA6_MODEL_ID = "pi/openai-codex/gpt-6-luna";
export const PI_MUSE_MODEL_ID = "pi/opencode-go/muse-spark-1.3-contributor";
export const PI_MUSE_CATALOG_COST = Object.freeze({ input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 });
export function isPiModel(model?: string): boolean {
  return [PI_MODEL_ID, PI_SOL_MODEL_ID, PI_SOL6_MODEL_ID, PI_LUNA6_MODEL_ID, PI_MUSE_MODEL_ID].includes(model ?? "");
}
export function piRoute(model = PI_MODEL_ID) {
  if (!isPiModel(model)) throw new Error("Unqualified Pi model: " + model);
  if (model === PI_MUSE_MODEL_ID) return Object.freeze({
    id: model, provider: "opencode-go", model: "muse-spark-1.3-contributor",
    apiURL: "https://opencode.ai/zen/go/v1", api: "openai-responses", auth: "api", cost: null,
  });
  return Object.freeze({ ...PI_ROUTE, id: model, model: model.slice("pi/openai-codex/".length) });
}

export function piClientVersion(model = PI_MODEL_ID) {
  if (!isPiModel(model)) throw new Error("Unqualified Pi model: " + model);
  return model === PI_SOL6_MODEL_ID || model === PI_LUNA6_MODEL_ID ? "0.87.0" : PI_VERSION;
}
export function piNodeVersion(model = PI_MODEL_ID) {
  return model === PI_MODEL_ID || model === PI_SOL_MODEL_ID ? "v22.23.1" : "v24.13.0";
}
