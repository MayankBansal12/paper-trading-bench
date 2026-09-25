import { qualifiedRoute } from "../opencode/qualification.ts";
import { PI_MODEL_ID, PI_ROUTE } from "../pi/route.ts";
export function studyRoute(model: string) {
  return model === PI_MODEL_ID ? PI_ROUTE : qualifiedRoute(model);
}
