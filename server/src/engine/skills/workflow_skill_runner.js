import { chat, ResponseExtractor } from "../core/llm.js";
import { getAppSkill, getPiSkill } from "../agents/pi_skill_registry.js";
import { ApiError } from "../../errors.js";

function text(value, fallback = "") {
  if (value == null) return fallback;
  return String(value);
}

function nullableText(value) {
  const v = text(value).trim();
  return v ? v : null;
}

export function safeStringify(value, fallback = "{}") {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return fallback;
  }
}

export function truncate(value, max = 12000) {
  const v = text(value);
  if (v.length <= max) return v;
  return `${v.slice(0, max)}\n...[truncated ${v.length - max} chars]`;
}

export function workflowSkillMeta(skill) {
  return skill ? {
    name: skill.name,
    runtime: skill.runtime,
    handler: skill.handler || skill.config?.handler || "",
  } : null;
}

function isSpecialProject(projectId) {
  const pid = String(projectId || "");
  return !pid || pid.startsWith("__") || pid.startsWith("folder:");
}

export async function resolveWorkflowSkill(ctx, projectId, skillName) {
  let skill;
  try {
    skill = isSpecialProject(projectId)
      ? await getAppSkill(ctx, skillName)
      : await getPiSkill(ctx, projectId, skillName);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(`Workflow Skill「${skillName}」不存在或不可用`, 404);
  }
  const runtime = skill?.runtime || "prompt";
  if (runtime !== "workflow") throw new ApiError(`Skill「${skillName}」不是 workflow runtime`, 400);
  const enabled = skill.effective_enabled ?? skill.is_enabled ?? skill.default_enabled;
  if (!enabled) throw new ApiError(`Workflow Skill「${skillName}」未启用`, 400);
  return skill;
}

function workflowMessages(skill, { task, input, responseContract, inputMaxChars = 30000 }) {
  return [
    {
      role: "system",
      content: [
        `Workflow Skill: ${skill.name}`,
        `Description: ${skill.description || ""}`,
        `Category: ${skill.category || "workflow"}`,
        `Handler: ${skill.handler || skill.config?.handler || ""}`,
        "Execution contract: 你正在执行一个产品内置 workflow Skill。必须遵守下面的 Skill 指令。",
        "",
        skill.instructions || "",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        task || "执行 workflow skill。",
        responseContract ? `\n输出合同:\n${responseContract}` : "",
        "",
        "输入:",
        truncate(safeStringify(input), inputMaxChars),
      ].join("\n"),
    },
  ];
}

export async function runWorkflowSkill(ctx, {
  projectId,
  skillName,
  task,
  input,
  responseContract = "",
  callSite,
  temperature = 0.1,
  maxTokens = 7000,
  modelId = null,
  inputMaxChars = 30000,
} = {}) {
  if (!skillName) throw new ApiError("skillName 不能为空", 400);
  const skill = await resolveWorkflowSkill(ctx, projectId, skillName);
  const raw = await chat(workflowMessages(skill, { task, input, responseContract, inputMaxChars }), {
    response_format: { type: "json_object" },
    temperature,
    max_tokens: maxTokens,
    project_id: projectId,
    model_id: nullableText(modelId),
    call_site: callSite || `workflow_skill:${skillName}`,
  });
  const cleaned = ResponseExtractor.clean_llm_json_response(raw, true);
  const parsed = typeof cleaned === "string" ? JSON.parse(cleaned) : cleaned;
  return {
    skill,
    data: parsed && typeof parsed === "object" ? parsed : {},
  };
}

export default { runWorkflowSkill, resolveWorkflowSkill, workflowSkillMeta };
