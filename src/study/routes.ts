import { qualifiedRoute } from "../opencode/qualification.ts";
import { isPiModel, piRoute } from "../pi/route.ts";
import { isClaudeModel, claudeRoute } from "../claude/route.ts";
export function studyRoute(model: string) {
  return isPiModel(model) ? piRoute(model) : isClaudeModel(model) ? claudeRoute(model) : qualifiedRoute(model);
}
