import { createQueryProjectDataTool } from "./services/query_agent_service.js";

const BUILTIN_SERVICE_HANDLERS = new Map([
  ["query_agent", createQueryProjectDataTool],
]);

export function createServiceSkillTools({ skills = [], agentContext, streamCallback } = {}) {
  const tools = [];
  const usedNames = new Set();
  for (const skill of Array.isArray(skills) ? skills : []) {
    if (!skill?.builtin || (skill.runtime || "prompt") !== "service") continue;
    if (!(skill.effective_enabled ?? skill.is_enabled ?? true)) continue;
    const factory = BUILTIN_SERVICE_HANDLERS.get(String(skill.handler || ""));
    if (!factory) continue;
    const tool = factory({ skill, agentContext, streamCallback });
    if (!tool?.name || usedNames.has(tool.name)) continue;
    usedNames.add(tool.name);
    tools.push(tool);
  }
  return tools;
}

export default createServiceSkillTools;
