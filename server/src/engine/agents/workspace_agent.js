/**
 * WorkspaceAgent —— 通用工作台引擎(接入本地工具运行时)。
 *
 * 工具:复用 read/grep/ls/find 等本地工具,作用于**项目的本地工作区文件夹**(数据不出本机)。
 *   - 本步仅启用**只读**工具(read/grep/ls/find);写/执行类(write/edit/bash)留到下一步 + 治理确认(beforeToolCall)。
 * 模型:ModelConfigResolver 走 llm_models 表(与问数同源)。
 * 契约不变:execute(agentContext, stream_callback) → { success }。
 */
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { ModelConfigResolver } from "../core/llm.js";
import { BaseAgent } from "../core/base_agent.js";
import {
  canActivatePromptSkill,
  formatPiSkillInstructions,
  isImplicitSkillVisible,
  listEnabledAppSkills,
  listEnabledPiSkills,
  listGlobalPiSkills,
  renderPiSkillsIndexPrompt,
} from "./pi_skill_registry.js";
import { PRODUCT_CONFIRM_TOOL_NAMES, PRODUCT_TOOL_NAMES } from "./product_tool_catalog.js";
import { createProductTools } from "./product_tools.js";
import { acquireMcpToolsForSession, isMcpToolName } from "./mcp_tools.js";
import { loadTranscript, appendMessages, rewriteTranscript, trimToBudget } from "./sessionStore.js";
import { compactIfNeeded, MANUAL_COMPACTION_SETTINGS } from "./compaction.js";
import {
  assistantMessageTraceText,
  buildPiModel,
  createPiStreamFn,
  ensurePiProviders,
  normalizePiUsageForTrace,
  positiveInt,
} from "./pi_runtime.js";
import { createPromptSkillHookRegistry } from "../skills/hooks/prompt_skill_hooks.js";
import { createServiceSkillTools } from "../skills/service_skill_registry.js";
import { isImagePath, renderUiCapabilityPrompt } from "../stream/ui_capabilities.js";
import { ensureProjectWorkspaceContext, isAskDataProjectWorkspaceId, loadProjectDataSourceOverview, loadWorkspaceAgentsPrompt } from "./workspace_context.js";
import { withAgentToolLifecycles } from "../trace/trace_context.js";
import { claimSessionBackgroundJobEvents, completeBackgroundJobEvents, releaseBackgroundJobEvents } from "../jobs/background_jobs.js";
// 本地原生工具(返回 AgentTool),从 vendored dist 直接引(包 exports 只暴露 ".")
import {
  createReadTool,
  createGrepTool,
  createLsTool,
  createFindTool,
  createWriteTool,
  createEditTool,
  createBashTool,
} from "../../../vendor/pi/coding-agent/dist/core/tools/index.js";

// 写/执行/外部 MCP 工具:执行前要走治理确认(beforeToolCall);只读类直接放行。
const WRITE_TOOLS = new Set(["write", "edit", "bash"]);
const SKILL_META_TOOLS = new Set(["update_plan", "use_skill", "capability_search", "capability_describe", "capability_invoke"]);

// 项目本地工作区文件夹(工具的 cwd):~/.yiw/projects/<projectId>/
function ensureWorkspace(projectId) {
  const cwd = join(homedir(), ".yiw", "projects", String(projectId || "default"));
  try {
    mkdirSync(cwd, { recursive: true });
    // 新建/空目录时放一个说明文件,便于工具有内容可操作(不覆盖用户已有文件)
    if (readdirSync(cwd).length === 0) {
      writeFileSync(
        join(cwd, "README.md"),
        "# 本工作区\n\n这是该项目的本地工作区,Agent 可在此 read/grep/ls/find。\n上传的文件、生成的脚本、中间结果都放这里。\n",
      );
    }
    ensureProjectWorkspaceContext({ cwd, projectId });
  } catch (e) {
    console.error("[workspace_agent ensureWorkspace]", e?.message || e);
  }
  return cwd;
}

// 工作区身份编码进 pid:
//   '__chat__'             → 聊天模式;执行时按 session 隔离到 projects/__chat__/<session_id>/
//   'folder:' + base64url  → 用户「打开文件夹」选择的本地目录(直接作为 cwd)
//   其它(UUID)            → 项目本地工作区 ~/.yiw/projects/<id>/
const CHAT_PID = "__chat__";
function safeWorkspaceSegment(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^\.+/, "_")
    .slice(0, 160);
}

function decodeFolderPid(pid) {
  try {
    const b64 = String(pid).slice("folder:".length).replace(/-/g, "+").replace(/_/g, "/");
    const p = Buffer.from(b64, "base64").toString("utf8");
    return p || null;
  } catch {
    return null;
  }
}
// pid → 本地工作目录(纯解析,不创建):folder: → 解码路径;chat+session → 每会话草稿目录;其它 → ~/.yiw/projects/<id>。
// 供 routes 的文件树/预览复用,保证与 agent 实际运行的 cwd 同源(避免目录穿越守卫与实际目录漂移)。
export function workspaceCwd(projectId, sessionId = null) {
  const s = String(projectId || "");
  if (s.startsWith("folder:")) {
    const p = decodeFolderPid(s);
    if (p) return p;
  }
  if (s === CHAT_PID) {
    const sid = safeWorkspaceSegment(sessionId);
    return sid
      ? join(homedir(), ".yiw", "projects", CHAT_PID, sid)
      : join(homedir(), ".yiw", "projects", CHAT_PID);
  }
  return join(homedir(), ".yiw", "projects", s);
}
// → { mode: 'chat' | 'agent', cwd }
function resolveWorkspace(projectId, sessionId) {
  // chat 模式:给一个**懒创建**的会话草稿工作区(= projects/__chat__/<session_id>),此处不建目录;
  // 首次有工具真正执行时(beforeToolCall)才 mkdir → 纯聊天保持零落盘,需要时就地长出会话目录。
  if (projectId === CHAT_PID) return { mode: "chat", cwd: workspaceCwd(CHAT_PID, sessionId) };
  if (typeof projectId === "string" && projectId.startsWith("folder:")) {
    const p = decodeFolderPid(projectId);
    if (p && existsSync(p)) return { mode: "agent", cwd: p };
    // 解码失败 / 目录不存在 → 退回项目工作区
  }
  return { mode: "agent", cwd: ensureWorkspace(projectId) };
}

async function loadProjectSummary(agentContext, projectId) {
  if (!isAskDataProjectWorkspaceId(projectId)) return null;
  const db = agentContext?.db;
  if (typeof db?.queryOne !== "function") return null;
  return db.queryOne(
    `SELECT id, name, description
       FROM projects
      WHERE id=$1 AND deleted_at IS NULL`,
    [projectId],
  ).catch(() => null);
}

const CHAT_PROMPT = `你是 YiW，本地数据分析桌面 App 里的通用智能体助手。
如果需要自我介绍，请使用“你好，我是 YiW，你的本地数据分析助手，可以帮你连接数据源、分析数据库和文件，并把结果沉淀到工作区。”
默认以**对话**为主:用中文、简洁专业地答疑、解释、梳理思路、给示例代码片段。
当用户**确实需要产出文件**(生成脚本、保存结果、处理上传的数据等)时,你可以操作运行上下文里给出的当前工作区:
- read / ls / grep / find:读取、列目录、按内容搜索、按名查找(只读)
- write / edit:创建或修改文件;bash:在草稿区里执行 shell 命令
没有产出文件的需求时**不要主动建文件**——纯聊天不会落盘。写文件和执行命令会先请用户确认。
多步问题可调用 update_plan 列出步骤,帮助用户理解。`;

const SYSTEM_PROMPT = `你是 YiW，本地数据分析桌面 App 里的通用智能体助手。
如果需要自我介绍，请使用“你好，我是 YiW，你的本地数据分析助手，可以帮你连接数据源、分析数据库和文件，并把结果沉淀到工作区。”
用中文、简洁专业地帮用户完成任务:梳理步骤、解释问题、写轻量代码、多步推理。
你可以使用工具操作运行上下文里给出的**本地工作区**:
- read / ls / grep / find:读取、列目录、按内容搜索、按名查找(只读)
- write / edit:创建或修改文件
- bash:在工作区里执行 shell 命令(脚本、数据处理等)
需要时主动调用工具,不要编造文件内容。写文件和执行命令会先请用户确认(被拒绝则换思路或说明)。
多步任务开始时调用 update_plan 列出步骤,推进时更新各步状态(todo/doing/done),让用户看到进度。
当前若是问数项目工作区,本地文件夹只代表项目文件工作区,不是已接入的数据源本身。
数据库取数、数据源介绍、表结构、字段、记录、图表、统计分析类问题必须调用 query_project_data;不要通过列目录来替代问数,也不要猜测项目配置。
只有用户明确要求查看本地目录、处理文件、生成脚本或管理工作区产物时,才读取本地文件。`;

function buildRuntimeContextMessage({ userMessage, cwd, workspaceContextPrompt, skillsPrompt, routedSkillPrompt, mcpPrompt, backgroundEventsPrompt }) {
  const blocks = [
    `## 运行上下文\n- 当前工作区: ${cwd}\n- 工具的相对路径均以当前工作区为基准。`,
    workspaceContextPrompt,
    renderUiCapabilityPrompt({ cwd }),
    skillsPrompt,
    routedSkillPrompt,
    mcpPrompt,
    backgroundEventsPrompt,
  ]
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  if (!blocks.length) return userMessage;
  return `${blocks.join("\n\n")}\n\n## 用户消息\n${userMessage}`;
}

function stripRuntimeContextForTranscript(message) {
  if (message?.role !== "user" || typeof message.content !== "string") return message;
  const marker = "\n\n## 用户消息\n";
  const idx = message.content.indexOf(marker);
  if (idx < 0) return message;
  return { ...message, content: message.content.slice(idx + marker.length) };
}

function stripRuntimeContextMessages(messages) {
  return Array.isArray(messages) ? messages.map(stripRuntimeContextForTranscript) : [];
}

function extractParts(content) {
  let text = "";
  let thinking = "";
  for (const part of content || []) {
    if (!part) continue;
    if (part.type === "text") text += part.text || "";
    else if (part.type === "thinking") thinking += part.thinking || part.text || "";
  }
  return { text, thinking };
}

const shortArgs = (args) => {
  try {
    const s = JSON.stringify(args);
    return s.length > 80 ? s.slice(0, 80) + "…" : s;
  } catch {
    return "";
  }
};
const TRACE_TEXT_MAX = Math.max(0, Number(process.env.YIW_TRACE_TEXT_MAX || 0));

const traceJson = (value, max = TRACE_TEXT_MAX) => {
  if (value == null || value === "") return "";
  try {
    const s = typeof value === "string" ? value : JSON.stringify(value);
    const limit = Math.max(0, Number(max || 0));
    return limit > 0 && s.length > limit ? `${s.slice(0, limit).trimEnd()}...` : s;
  } catch {
    const s = String(value);
    const limit = Math.max(0, Number(max || 0));
    return limit > 0 && s.length > limit ? `${s.slice(0, limit).trimEnd()}...` : s;
  }
};

// 哪些工具的结果值得在 GUI 里展示: 文件读写、命令输出、目录/搜索结果
const SHOW_RESULT = new Set(["read", "bash", "write", "edit", "ls", "find", "grep"]);
function resultText(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  const c = result.content;
  if (Array.isArray(c)) {
    return c
      .map((p) => (p && typeof p.text === "string" ? p.text : typeof p === "string" ? p : ""))
      .join("");
  }
  if (typeof result.text === "string") return result.text;
  try {
    return JSON.stringify(result);
  } catch {
    return "";
  }
}

function buildWorkspaceEvent(toolName, result, agentContext) {
  const details = result?.details;
  if (!details || details.success === false) return null;
  const project = details.project && typeof details.project === "object" ? details.project : null;
  const projectId = String(details.project_id || project?.id || project?.project_id || "").trim();
  if (!projectId) return null;

  let event = null;
  if (toolName === "project_create" || toolName === "create_smart_qa_project") event = "project_created";
  else if (toolName === "project_session_move") event = "session_moved";
  else if (toolName === "unstructured_import") event = "project_data_preparing";
  else if (toolName === "structured_import" || toolName === "database_file_import" || toolName === "query_smoke_test") event = "project_ready_for_query";
  if (!event) return null;

  return {
    type: "workspace_event",
    event,
    source_tool: toolName,
    origin_project_id: agentContext?.project_id || null,
    session_id: agentContext?.session_id || agentContext?.input_data?.session_id || null,
    project_id: projectId,
    project: project || { id: projectId, project_id: projectId },
    connection_id: details.connection_id || null,
    data_source_id: details.data_source_id || details.structured_data_source_id || details.unstructured_data_source_id || null,
    table_count: Number(details.table_count || 0),
    document_count: Array.isArray(details.documents) ? details.documents.length : undefined,
    status: details.status || null,
    next_skill: event === "project_ready_for_query" ? "project_data_query" : null,
    next_tool: event === "project_ready_for_query" ? "query_project_data" : null,
  };
}

function snapshotImages(dir) {
  const out = new Map();
  const walk = (base) => {
    let entries = [];
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(base, entry.name);
      try {
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          if (isImagePath(full)) out.set(full, statSync(full).mtimeMs);
        }
      } catch {
        /* ignore unreadable entries */
      }
    }
  };
  walk(dir);
  return out;
}

function changedImages(before, after) {
  return [...after.entries()]
    .filter(([path, mtime]) => !before?.has(path) || mtime > Number(before.get(path) || 0) + 1)
    .sort((a, b) => b[1] - a[1])
    .map(([path]) => path);
}

// 持久化的 session_messages → 运行时对话历史(AgentMessage[])。
// user → 纯文本;assistant → 合并 text/markdown 块为一段文本(忽略 thinking/tool/plan/confirm,
// 避免重建不完整的 toolCall/toolResult 配对破坏 LLM 转换)。空文本消息跳过。
function buildHistoryMessages(history, model) {
  const out = [];
  for (const row of Array.isArray(history) ? history : []) {
    let ci = row?.content_items;
    if (typeof ci === "string") {
      try {
        ci = JSON.parse(ci);
      } catch {
        ci = [];
      }
    }
    if (!Array.isArray(ci)) ci = [];
    if (row?.role === "user") {
      const text = ci
        .map((b) => (typeof b?.content === "string" ? b.content : ""))
        .join("")
        .trim();
      if (text) out.push({ role: "user", content: text, timestamp: 0 });
    } else if (row?.role === "assistant") {
      const text = ci
        .filter((b) => b?.type === "markdown" || b?.type === "text")
        .map((b) => (typeof b?.content === "string" ? b.content : ""))
        .join("\n")
        .trim();
      if (text) {
        out.push({
          role: "assistant",
          content: [{ type: "text", text }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: 0,
        });
      }
    }
  }
  return out;
}

/**
 * 手动压缩某会话上下文(/compact)。强制压缩(不看阈值),把更早的消息摘成一条 + 保留近期。
 * 只动 JSONL 转写(模型上下文);SQL/前端显示不变(以用户看到的为主)。
 */
export async function compactSession({ projectId, sessionId }) {
  ensurePiProviders();
  if (!sessionId) return { compacted: false, message: "没有会话可压缩" };
  const transcript = loadTranscript(sessionId);
  if (!Array.isArray(transcript) || transcript.length < 4) {
    return { compacted: false, message: "对话较短,无需压缩" };
  }
  let cfg;
  try {
    cfg = await ModelConfigResolver.resolve({ project_id: projectId, category: "PRIMARY" });
  } catch (e) {
    return { compacted: false, message: `未配置可用大模型:${e?.message || e}` };
  }
  const model = buildPiModel(cfg);
  const before = transcript.length;
  const r = await compactIfNeeded(transcript, {
    model,
    apiKey: cfg.api_key,
    streamFn: createPiStreamFn({ apiKey: cfg.api_key, extraConfig: cfg.extra_config }),
    contextWindow: model.contextWindow,
    settings: MANUAL_COMPACTION_SETTINGS,
    force: true,
  });
  if (r.compacted) {
    rewriteTranscript(sessionId, r.messages);
    return { compacted: true, before, after: r.messages.length };
  }
  const approx = r.tokensBefore ? `当前约 ${r.tokensBefore} tokens,` : "";
  const messages = {
    too_short: "对话较短,无需压缩",
    no_older_messages: `对话内容还不够长,${approx}近期窗口内已全部保留`,
    summary_failed: `压缩摘要生成失败:${r.error || "未知错误"}`,
    empty_summary: "压缩摘要为空,已保留原上下文",
  };
  return { compacted: false, message: messages[r.reason] || "无需压缩", reason: r.reason, tokensBefore: r.tokensBefore };
}

export class WorkspaceAgent extends BaseAgent {
  constructor(opts = {}) {
    super({ name: "WorkspaceAgent", description: "通用工作台 Agent" });
    this.opts = opts;
  }
  static async create(opts = {}) {
    return new WorkspaceAgent(opts);
  }

  async execute(agentContext, stream_callback) {
    ensurePiProviders();
    const q = agentContext?.input_data?.user_message || "";
    const projectId = agentContext?.project_id || null;
    const sessionId = agentContext?.session_id || agentContext?.input_data?.session_id || null;

    let cfg;
    try {
      cfg = await ModelConfigResolver.resolve({ project_id: projectId, category: "PRIMARY" });
    } catch (e) {
      await stream_callback(`⚠️ 未配置可用大模型:${e?.message || e}\n请在「项目设置 → 模型配置」配置后再试。`, {
        content_id: randomUUID(),
        content_type: "markdown",
        title: "提示",
      });
      return { success: false, error: "no model configured" };
    }

    const { mode: wsMode, cwd } = resolveWorkspace(projectId, sessionId);
    let workspaceContextPrompt = "";
    try {
      if (isAskDataProjectWorkspaceId(projectId)) {
        const project = await loadProjectSummary(agentContext, projectId);
        const dataSources = await loadProjectDataSourceOverview(agentContext?.db, projectId);
        ensureProjectWorkspaceContext({ cwd, projectId, project, dataSources });
      }
      workspaceContextPrompt = loadWorkspaceAgentsPrompt({ cwd });
    } catch (e) {
      console.error("[workspace_agent workspace context]", e?.message || e);
    }
    const awaitDecision = agentContext?.awaitDecision; // (toolCallId) => Promise<boolean> 治理确认
    // 权限模式:ask=写/执行都确认 / auto=仅命令执行(bash)确认 / full=全放行
    const approval = ["ask", "auto", "full"].includes(agentContext?.approval) ? agentContext.approval : "ask";
    const model = buildPiModel(cfg);
    const apiKey = cfg.api_key;
    // 运行设置(设置页):网络超时(ms)+ 是否自动压缩上下文
    const rt = agentContext?.settings || {};
    const timeoutMs = positiveInt(rt.timeoutMs);
    const autoCompact = rt.autoCompact !== false;
    let enabledSkills = [];
    let skillsPrompt = "";
    try {
      const db = agentContext?.db;
      if (db?.query && (projectId === CHAT_PID || String(projectId || "").startsWith("folder:"))) {
        enabledSkills = await listEnabledAppSkills(db);
        skillsPrompt = renderPiSkillsIndexPrompt(enabledSkills);
      } else if (db?.query && projectId && !String(projectId).startsWith("folder:")) {
        enabledSkills = await listEnabledPiSkills(db, projectId);
        skillsPrompt = renderPiSkillsIndexPrompt(enabledSkills);
      } else if (projectId === CHAT_PID) {
        enabledSkills = listGlobalPiSkills();
        skillsPrompt = renderPiSkillsIndexPrompt(enabledSkills);
      }
    } catch (e) {
      console.error("[workspace_agent skills]", e?.message || e);
    }
    const promptSkills = enabledSkills.filter((s) => (s.runtime || "prompt") === "prompt");
    const serviceSkills = enabledSkills.filter((s) => (s.runtime || "prompt") === "service");
    const promptSkillsByName = new Map(promptSkills.map((s) => [s.name, s]));
    const visiblePromptSkillNames = promptSkills.filter(isImplicitSkillVisible).map((s) => s.name);
    const routedSkillName =
      agentContext?.skillDecision?.runtime === "prompt" ? String(agentContext.skillDecision.skill_name || "").trim() : "";
    const routedSkill = routedSkillName ? promptSkillsByName.get(routedSkillName) : null;
    let activeSkill = routedSkill || null;
    const routedSkillPrompt = routedSkill
      ? `\n\n## 当前路由已选 Skill\n本轮用户意图已由路由器匹配到 ${routedSkill.name},该 Skill 已激活,不需要再调用 use_skill。\n${formatPiSkillInstructions(routedSkill)}`
      : "";
    const emitRoutedSkillTrace = async () => {
      if (!routedSkill) return;
      const toolCallId = `routed-skill:${randomUUID()}`;
      await stream_callback(`use_skill ${shortArgs({ name: routedSkill.name })}`, {
        content_id: toolCallId,
        content_type: "tool",
        title: "done",
        tool_name: "use_skill",
        skill_name: routedSkill.name,
      });
      await stream_callback(formatPiSkillInstructions(routedSkill), {
        content_id: `result:${toolCallId}`,
        content_type: "tool_result",
        title: "use_skill",
        tool_name: "use_skill",
        skill_name: routedSkill.name,
      });
      await stream_callback(
        JSON.stringify({
          type: "skill_invocation",
          skill_id: routedSkill.id || routedSkill.name,
          skill_name: routedSkill.name,
          runtime: routedSkill.runtime || "prompt",
          status: "running",
          scope: routedSkill.project_id ? "project" : "app",
          project_id: routedSkill.project_id || null,
          source: routedSkill.binding ? "project_binding" : routedSkill.source || "app_definition",
          effective_enabled: routedSkill.effective_enabled ?? routedSkill.is_enabled ?? true,
          availability: routedSkill.availability || "enabled",
        }),
        {
          content_id: `skill:${routedSkill.name}`,
          content_type: "skill_invocation",
          title: routedSkill.name,
          skill_name: routedSkill.name,
          display: false,
        },
      );
    };
    const mcpTools = await acquireMcpToolsForSession({
      db: agentContext?.db,
      projectId,
      sessionId,
      streamCallback: stream_callback,
      timeoutMs,
    });
    const mcpPrompt = mcpTools.tools.length
      ? `\n\n项目已启用 MCP 服务器工具。工具名以 mcp_ 开头,代表外部系统能力;只在用户任务需要时调用。`
      : "";

    // 自定义工具:update_plan —— agent 调用它来公布/更新计划,前端右栏「计划」据此渲染
    const planTool = {
      name: "update_plan",
      description: "公布或更新当前多步任务的计划清单。每个步骤含 title 和 status(todo/doing/done)。规划与推进时调用。",
      parameters: Type.Object({
        steps: Type.Array(
          Type.Object({
            title: Type.String({ description: "步骤标题" }),
            status: Type.String({ description: "todo | doing | done" }),
          }),
        ),
      }),
      execute: async (_toolCallId, params) => {
        const steps = Array.isArray(params?.steps) ? params.steps : [];
        await stream_callback(JSON.stringify(steps), { content_id: "plan", content_type: "plan" });
        return { content: [{ type: "text", text: "计划已更新" }], details: undefined };
      },
    };

    const useSkillTool = {
      name: "use_skill",
      description:
        "加载并激活一个项目 Skill。用户任务匹配 Skill 索引时先调用本工具;返回完整指令和 allowed_tools,后续工具调用会受该 Skill 白名单约束。",
      parameters: Type.Object({
        name: Type.String({ description: "要激活的 Skill 名称,必须来自项目启用的 Skill 索引。" }),
      }),
      execute: async (_toolCallId, params) => {
        const name = String(params?.name || "").trim();
        const skill = promptSkillsByName.get(name);
        if (!skill) {
          const names = visiblePromptSkillNames.join(", ") || "无";
          activeSkill = null;
          return {
            content: [{ type: "text", text: `Skill「${name || "(空)"}」不可用。当前可用 Skill: ${names}` }],
            details: undefined,
          };
        }
        if (!canActivatePromptSkill(skill, { routedSkillName })) {
          activeSkill = null;
          const names = visiblePromptSkillNames.join(", ") || "无";
          return {
            content: [{
              type: "text",
              text: `Skill「${name}」不能直接激活。该 Skill 需要本轮路由命中或用户显式选择。当前可用 Skill: ${names}`,
            }],
            details: { skill: name, denied: true, reason: "implicit_invocation_disabled" },
          };
        }
        activeSkill = skill;
        return {
          content: [{ type: "text", text: formatPiSkillInstructions(skill) }],
          details: { skill: skill.name, allowed_tools: skill.allowed_tools || [] },
        };
      },
    };

    // 全套工具:计划 + 文件/执行(写/执行经治理确认)。chat 与 agent 用同一套;
    // chat 的 cwd 是懒创建的草稿区,目录在首个工具执行前(beforeToolCall)才落盘。
    const productTools = createProductTools(agentContext);
    const serviceTools = createServiceSkillTools({
      skills: serviceSkills,
      agentContext,
      streamCallback: stream_callback,
    });
    const tools = withAgentToolLifecycles([
      planTool,
      ...(promptSkillsByName.size ? [useSkillTool] : []),
      ...serviceTools,
      ...productTools,
      createReadTool(cwd),
      createGrepTool(cwd),
      createLsTool(cwd),
      createFindTool(cwd),
      createWriteTool(cwd),
      createEditTool(cwd),
      createBashTool(cwd),
      ...mcpTools.tools,
    ], { trace_agent: "workspace_agent" });

    const skillHooks = createPromptSkillHookRegistry({
      cwd,
      getActiveSkill: () => activeSkill,
      metaTools: SKILL_META_TOOLS,
      approval,
      writeTools: WRITE_TOOLS,
      confirmToolNames: PRODUCT_CONFIRM_TOOL_NAMES,
      isExternalTool: isMcpToolName,
      streamCallback: stream_callback,
      awaitDecision,
      shortArgs,
    });

    // 上下文恢复:优先用 JSONL 原始转写(无损,含工具调用);
    // 老会话无转写文件 → 回退到 SQL 渲染块重建(文本级),并把重建结果引导写入 JSONL。
    let historyMessages = loadTranscript(sessionId);
    const claimedBackgroundEvents = claimSessionBackgroundJobEvents(sessionId);
    const backgroundEventsPrompt = claimedBackgroundEvents.length
      ? `## 待处理后台任务事件\n这些是系统可靠投递且本轮只消费一次的事实。先结合用户当前要求处理；可自动恢复的继续处理，需要配置或替换文件时再询问用户。\n${claimedBackgroundEvents.map((event) => JSON.stringify(event.payload)).join("\n")}`
      : "";
    if (!Array.isArray(historyMessages)) {
      // JSONL 缺失(老会话)→ 懒查 SQL 重建一次(常规路径不触发此查询)
      const sqlHistory = typeof agentContext?.loadHistory === "function" ? await agentContext.loadHistory() : [];
      historyMessages = buildHistoryMessages(sqlHistory, model);
      if (sessionId && historyMessages.length) rewriteTranscript(sessionId, historyMessages); // 老会话引导
    }
    // 超阈值 → 摘要式 compaction(把旧消息压成一条摘要 + 保留近期);触发即把检查点整份重写落盘。
    // 设置页关闭「自动压缩」则跳过(仍可用 /compact 手动压)。
    try {
      const r = autoCompact
        ? await compactIfNeeded(historyMessages, {
            model,
            apiKey,
            streamFn: createPiStreamFn({ apiKey, extraConfig: cfg.extra_config }),
            contextWindow: model.contextWindow,
          })
        : { compacted: false };
      if (r.compacted) {
        historyMessages = r.messages;
        if (sessionId) rewriteTranscript(sessionId, historyMessages);
        await stream_callback("已压缩较早的对话上下文以控制长度。", {
          content_id: randomUUID(),
          content_type: "thinking",
          title: "上下文压缩",
        });
      }
    } catch (e) {
      console.error("[workspace_agent compact]", e?.message || e);
    }
    // 预算裁剪兜底(compaction 未触发/失败时仍保证不溢出,且窗口以 user 起头)
    historyMessages = trimToBudget(historyMessages);

    // 落盘游标:agent.state.messages 里已持久化到此长度;flush 把超出部分(本轮新消息)append 进 JSONL。
    // 注:初值 = 喂给 agent 的历史长度;文件里可能还有更早(裁剪掉)的消息,append 仅写本轮增量,不重复。
    let persistedCount = historyMessages.length;

    const agent = new Agent({
      initialState: {
        systemPrompt: wsMode === "chat" ? CHAT_PROMPT : SYSTEM_PROMPT,
        model,
        tools,
        messages: historyMessages,
      },
      sessionId: sessionId || undefined,
      streamFn: createPiStreamFn({ apiKey, extraConfig: cfg.extra_config, timeoutMs }),
      beforeToolCall: async (bctx, signal) => skillHooks.beforeToolCall(bctx, signal),
      afterToolCall: async (bctx, signal) => skillHooks.afterToolCall(bctx, signal),
    });

    // 暴露 agent 给路由层,供「停止」时 abort
    if (typeof agentContext?.onAgent === "function") agentContext.onAgent(agent);

    // 把本轮新产生的消息 append 进 JSONL(每轮 turn_end 调一次 → 崩溃只丢进行中的轮次)。
    // 始终以 agent.state.messages 为真相源切增量,避免手工重建漂移。
    const flush = () => {
      if (!sessionId) return;
      try {
        const all = agent.state?.messages || [];
        if (all.length > persistedCount) {
          appendMessages(sessionId, stripRuntimeContextMessages(all.slice(persistedCount)));
          persistedCount = all.length;
        }
      } catch (e) {
        console.error("[workspace_agent flush]", e?.message || e);
      }
    };

    // 每个 assistant turn 用新 content_id,工具调用各自独立块 → 视觉顺序正确
    let curTextId = randomUUID();
    let curThinkId = randomUUID();
    let lastText = "";
    let lastThink = "";
    let lastUsage = null;
    let lastModel = model.id;
    const argsMap = {}; // toolCallId → args(start 时记下,end 时复用)
    const imageSnapshots = new Map(); // bash toolCallId → 执行前图片快照

    const unsub = agent.subscribe(async (event) => {
      try {
        await skillHooks.onEvent({ agentContext }, event);
        switch (event.type) {
          case "turn_start":
            curTextId = randomUUID();
            curThinkId = randomUUID();
            lastText = "";
            lastThink = "";
            lastUsage = null;
            lastModel = model.id;
            break;
          case "turn_end":
            {
              const message = event.message || {};
              const usage = normalizePiUsageForTrace(message.usage) || lastUsage;
              const { text: finalText } = extractParts(message.content);
              const visibleText = finalText || lastText;
              const traceText = visibleText || assistantMessageTraceText(message) || lastThink || "LLM turn";
              if (usage) {
                await stream_callback(traceText, {
                  content_id: curTextId,
                  content_type: "markdown",
                  title: visibleText ? undefined : "LLM 工具决策",
                  display: Boolean(visibleText),
                  msg_category: visibleText ? "" : "llm_trace",
                  usage,
                  model: message.responseModel || message.model || lastModel || model.id,
                });
              }
            }
            // 本轮 assistant + 工具结果已落入 state → append 进 JSONL(增量、崩溃可续)
            flush();
            break;
          case "tool_handoff": {
            const { text } = extractParts(event.message?.content);
            const finalText = String(text || "").trim();
            if (!finalText) break;
            await stream_callback(finalText, {
              content_id: randomUUID(),
              content_type: "markdown",
              msg_category: "final_answer",
              handoff: true,
              handoff_metadata: event.message?.handoffMetadata || null,
            });
            // 合成 assistant 已进入 Agent state；紧随其后的 turn_end 统一持久化本轮。
            break;
          }
          case "message_update": {
            const partial = event.assistantMessageEvent?.partial;
            const { text, thinking } = extractParts(partial?.content);
            const usage = normalizePiUsageForTrace(partial?.usage);
            if (usage) lastUsage = usage;
            lastModel = partial?.responseModel || partial?.model || lastModel || model.id;
            if (thinking && thinking !== lastThink) {
              lastThink = thinking;
              await stream_callback(thinking, { content_id: curThinkId, content_type: "thinking", title: "思考" });
            }
            if (text && text !== lastText) {
              lastText = text;
              await stream_callback(text, {
                content_id: curTextId,
                content_type: "markdown",
                usage: lastUsage,
                model: lastModel,
              });
            }
            break;
          }
          case "tool_execution_start":
            argsMap[event.toolCallId] = event.args;
            if (event.toolName === "bash") imageSnapshots.set(event.toolCallId, snapshotImages(cwd));
            // update_plan = 元工具(只更新右栏计划,不在对话里显示);写/执行类的 running 块由确认卡代替
            if (event.toolName === "update_plan" || WRITE_TOOLS.has(event.toolName) || isMcpToolName(event.toolName) || PRODUCT_CONFIRM_TOOL_NAMES.has(event.toolName)) break;
            await stream_callback(`${event.toolName} ${shortArgs(event.args)}`, {
              content_id: event.toolCallId,
              content_type: "tool",
              title: "running",
              tool_name: event.toolName,
              trace_input: traceJson(event.args),
              ...(event.toolName === "use_skill" ? { skill_name: event.args?.name } : {}),
            });
            break;
          case "tool_execution_end": {
            if (event.toolName === "update_plan") break; // 元工具不在对话里显示
            const a = argsMap[event.toolCallId] || {};
            // write/edit 成功 → 该文件是一个「工件」,给右栏工作台
            const imageArtifact =
              !event.isError && event.toolName === "bash"
                ? changedImages(imageSnapshots.get(event.toolCallId), snapshotImages(cwd))[0]
                : undefined;
            const artifact =
              imageArtifact || (!event.isError && (event.toolName === "write" || event.toolName === "edit") && a.path ? a.path : undefined);
            imageSnapshots.delete(event.toolCallId);
            await stream_callback(`${event.toolName} ${shortArgs(a)}`, {
              content_id: event.toolCallId,
              content_type: "tool",
              title: event.isError ? "error" : "done",
              tool_name: event.toolName,
              trace_input: traceJson(a),
              trace_output: traceJson(resultText(event.result)),
              ...(event.toolName === "use_skill" ? { skill_name: a.name } : {}),
              ...(artifact ? { artifact } : {}),
            });
            // 工具结果(可折叠富渲染:read=代码 / edit·write=diff / bash=输出)
            if (!event.isError && (SHOW_RESULT.has(event.toolName) || event.toolName === "use_skill" || isMcpToolName(event.toolName) || PRODUCT_TOOL_NAMES.has(event.toolName))) {
              const rtext = resultText(event.result).slice(0, 4000);
              if (rtext.trim()) {
                await stream_callback(rtext, {
                  content_id: `result:${event.toolCallId}`,
                  content_type: "tool_result",
                  title: event.toolName,
                  tool_name: event.toolName,
                });
              }
            }
            const workspaceEvent = !event.isError ? buildWorkspaceEvent(event.toolName, event.result, agentContext) : null;
            if (workspaceEvent) {
              await stream_callback(JSON.stringify(workspaceEvent), {
                content_id: `workspace:${event.toolCallId}`,
                content_type: "workspace_event",
                title: workspaceEvent.event,
                display: false,
                workspace_event: workspaceEvent,
              });
            }
            break;
          }
        }
      } catch (e) {
        console.error("[workspace_agent event]", e?.message || e);
      }
    });

    try {
      await emitRoutedSkillTrace();
      if (agentContext?.resume?.continueFromTranscript) {
        await agent.continue();
      } else {
        await agent.prompt(
          buildRuntimeContextMessage({
            userMessage: q,
            cwd,
            workspaceContextPrompt,
            skillsPrompt,
            routedSkillPrompt,
            mcpPrompt,
            backgroundEventsPrompt,
          }),
        );
      }
      completeBackgroundJobEvents(claimedBackgroundEvents.map((event) => event.id));
      return { success: true };
    } catch (e) {
      releaseBackgroundJobEvents(claimedBackgroundEvents.map((event) => event.id));
      console.error("[workspace_agent prompt]", e?.stack || e?.message || e);
      await stream_callback(`⚠️ 工作台执行失败:${e?.message || e}`, {
        content_id: randomUUID(),
        content_type: "markdown",
        title: "错误",
      });
      return { success: false, error: e?.message || String(e) };
    } finally {
      unsub();
      // 收尾:把最后一轮(turn_end 可能未覆盖,如中途停止/报错)的新消息 append 进 JSONL。
      flush();
      await mcpTools.release();
    }
  }
}

export default WorkspaceAgent;
