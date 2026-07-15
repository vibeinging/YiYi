import { mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { SkillHookRegistry } from "./hook_registry.js";

function toolName(ctx) {
  return ctx?.toolCall?.name || "";
}

export class WorkspaceHook {
  name = "WorkspaceHook";
  priority = 10;

  constructor({ cwd } = {}) {
    this.cwd = cwd;
  }

  async beforeToolCall() {
    try {
      if (this.cwd && !existsSync(this.cwd)) mkdirSync(this.cwd, { recursive: true });
    } catch {
      /* 工具自身会报告后续文件错误 */
    }
  }
}

export class AllowedToolsHook {
  name = "AllowedToolsHook";
  priority = 20;

  constructor({ getActiveSkill, metaTools = new Set() } = {}) {
    this.getActiveSkill = getActiveSkill;
    this.metaTools = metaTools;
  }

  async beforeToolCall(ctx) {
    const activeSkill = typeof this.getActiveSkill === "function" ? this.getActiveSkill() : null;
    const name = toolName(ctx);
    if (
      activeSkill &&
      Array.isArray(activeSkill.allowed_tools) &&
      activeSkill.allowed_tools.length > 0 &&
      !activeSkill.allowed_tools.includes(name) &&
      !this.metaTools.has(name)
    ) {
      return {
        block: true,
        reason: `当前 Skill「${activeSkill.name}」不允许调用工具「${name}」。允许的工具:${activeSkill.allowed_tools.join(", ")}`,
      };
    }
    return undefined;
  }
}

export class ApprovalHook {
  name = "ApprovalHook";
  priority = 30;

  constructor({
    approval = "ask",
    writeTools = new Set(),
    confirmToolNames = new Set(),
    isExternalTool = () => false,
    streamCallback,
    awaitDecision,
    shortArgs = () => "",
  } = {}) {
    this.approval = approval;
    this.writeTools = writeTools;
    this.confirmToolNames = confirmToolNames;
    this.isExternalTool = isExternalTool;
    this.streamCallback = streamCallback;
    this.awaitDecision = awaitDecision;
    this.shortArgs = shortArgs;
  }

  needsConfirm(name, args = {}) {
    const external = this.isExternalTool(name);
    if (this.approval === "full") return false;
    if (this.approval === "auto") return name === "bash" || external;
    if (name === "capability_invoke" && /^(?:get|head)\./i.test(String(args?.operation_id || ""))) return false;
    if (this.confirmToolNames.has(name)) return true;
    return this.writeTools.has(name) || external;
  }

  async beforeToolCall(ctx) {
    const name = toolName(ctx);
    if (!this.needsConfirm(name, ctx?.args)) return undefined;

    const id = ctx?.toolCall?.id || randomUUID();
    const argStr = this.shortArgs(ctx?.args);
    if (typeof this.streamCallback === "function") {
      await this.streamCallback(`${name} ${argStr}`, {
        content_id: `confirm:${id}`,
        content_type: "confirm",
        title: name,
        tool_call_id: id,
      });
    }

    let approved = true;
    if (typeof this.awaitDecision === "function") {
      try {
        approved = await this.awaitDecision(id);
      } catch {
        approved = false;
      }
    }

    if (typeof this.streamCallback === "function") {
      await this.streamCallback(`${name} ${argStr}`, {
        content_id: `confirm:${id}`,
        content_type: "confirm",
        title: approved ? "approved" : "rejected",
        tool_call_id: id,
      });
    }

    if (!approved) return { block: true, reason: "用户拒绝了该写入/执行操作" };
    return undefined;
  }
}

export class SkillInvocationTraceHook {
  name = "SkillInvocationTraceHook";
  priority = 90;

  constructor({ getActiveSkill, streamCallback } = {}) {
    this.getActiveSkill = getActiveSkill;
    this.streamCallback = streamCallback;
    this.emitted = new Set();
  }

  async onEvent(_ctx, event) {
    if (event?.type !== "tool_execution_end" || event.toolName !== "use_skill" || event.isError) return;
    const activeSkill = typeof this.getActiveSkill === "function" ? this.getActiveSkill() : null;
    if (!activeSkill?.name || this.emitted.has(activeSkill.name)) return;
    this.emitted.add(activeSkill.name);
    if (typeof this.streamCallback !== "function") return;
    await this.streamCallback(
      JSON.stringify({
        type: "skill_invocation",
        skill_id: activeSkill.id || activeSkill.name,
        skill_name: activeSkill.name,
        runtime: activeSkill.runtime || "prompt",
        status: "running",
        scope: activeSkill.project_id ? "project" : "app",
        project_id: activeSkill.project_id || null,
        source: activeSkill.binding ? "project_binding" : activeSkill.source || "app_definition",
        effective_enabled: activeSkill.effective_enabled ?? activeSkill.is_enabled ?? true,
        availability: activeSkill.availability || "enabled",
      }),
      {
        content_id: `skill:${activeSkill.name}`,
        content_type: "skill_invocation",
        title: activeSkill.name,
        skill_name: activeSkill.name,
        display: false,
      },
    );
  }
}

export function createPromptSkillHookRegistry(options = {}) {
  return new SkillHookRegistry([
    new WorkspaceHook(options),
    new AllowedToolsHook(options),
    new ApprovalHook(options),
    new SkillInvocationTraceHook(options),
  ]);
}

export default { createPromptSkillHookRegistry };
