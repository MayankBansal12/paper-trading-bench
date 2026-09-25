import { qualifiedRoute } from "../opencode/qualification.ts";
import { isPiModel, piRoute } from "../pi/route.ts";
export function studyRoute(model: string) {
  return isPiModel(model) ? piRoute(model) : qualifiedRoute(model);
}
