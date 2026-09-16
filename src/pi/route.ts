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
  auth: "oauth",
  cost: null,
});

export const PI_SOL_MODEL_ID = "pi/openai-codex/gpt-5.6-sol";
export function isPiModel(model?: string): boolean {
  return model === PI_MODEL_ID || model === PI_SOL_MODEL_ID;
}
export function piRoute(model = PI_MODEL_ID) {
  if (!isPiModel(model)) throw new Error("Unqualified Pi model: " + model);
  return Object.freeze({ ...PI_ROUTE, id: model, model: model.slice("pi/openai-codex/".length) });
}
