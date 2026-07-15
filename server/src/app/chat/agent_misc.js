/**
 * L1 用例层 — 工作台 Agent 入口的非流式端点(抽自 routes/agent_chat.js 的 6 个非 SSE 端点)。
 *
 * 常规契约:async fn(ctx, input) -> { data, message } | throw ApiError;不碰 req/res。
 * 源里的 res.json({success,data,message}) 与 ok 同形 → 归一成 return { data, message }。
 * 源里 catch 后 res.json({success:false,...}) 的容错 → 这里 .catch(()=>fallback) 原样照搬语义,
 *   不向上 throw(保持「失败也回 200 + 空数据」的旧行为,前端按 data 兜底)。
 *
 * pendingDecisions:治理确认共享态(toolCallId → resolve)。chat 流 await,/tool-decision resolve。
 *   与 agent_chat.js 共用同一 Map(本模块导出),不可各持一份。
 *
 * 注:app/chat/ 比 routes/ 深一层 → engine 用 ../../engine。
 */
import { randomUUID } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { compactSession, workspaceCwd } from "../../engine/agents/workspace_agent.js";
import { ModelConfigResolver } from "../../engine/core/llm.js";
import { ensureProjectWorkspaceContext, isAskDataProjectWorkspaceId } from "../../engine/agents/workspace_context.js";
import {
  PI_TOOL_CATALOG,
  createAppSkill,
  deleteAppSkill,
  generatePiSkillDraft,
  getAppSkill,
  listAppSkills,
  listEnabledAppSkills,
  setAppSkillEnabled,
  updateAppSkill,
} from "../../engine/agents/pi_skill_registry.js";

// 治理确认共享态:toolCallId → resolve(approved)。chat 流里 beforeToolCall await,decision 端点 resolve。
export const pendingDecisions = new Map();

// 递归遍历工作区目录 → 文件树(限深度/数量,跳隐藏)
function walkDir(dir, base, depth) {
  if (depth > 5) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  let count = 0;
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    if (count++ > 300) break;
    const full = join(dir, e.name);
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push({ name: e.name, path: rel, type: "dir", children: walkDir(full, rel, depth + 1) });
    } else {
      let size = 0;
      try {
        size = statSync(full).size;
      } catch {
        /* ignore */
      }
      out.push({ name: e.name, path: rel, type: "file", size });
    }
  }
  out.sort((a, b) => (a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name)));
  return out;
}

function sessionScopedWorkspaceCwd(input) {
  const sessionId = String(input.query?.session_id || input.query?.sessionId || input.params?.sid || "").trim();
  const cwd = workspaceCwd(input.params.pid, sessionId || null);
  if (isAskDataProjectWorkspaceId(input.params.pid)) {
    ensureProjectWorkspaceContext({ cwd, projectId: input.params.pid });
  }
  return cwd;
}

function isInsideDir(base, file) {
  const rel = relative(resolve(base), resolve(file));
  return rel === "" || (!!rel && !rel.startsWith("..") && !rel.startsWith("/") && !rel.startsWith("\\"));
}

// POST /api/agent/tool-decision — 治理确认:resolve 待决的 toolCallId
export async function resolveToolDecision(ctx, input) {
  const { toolCallId, approved } = input.body || {};
  const resolve = pendingDecisions.get(toolCallId);
  if (resolve) {
    pendingDecisions.delete(toolCallId);
    resolve(!!approved);
  }
  return { data: null, message: "ok" };
}

// GET /api/agent/projects/:pid/sessions — 工作区历史:统一 agent 会话
export async function listAgentSessions(ctx, input) {
  const archived = input.query?.archived === "1" || input.query?.archived === "true";
  const statusFilter = archived
    ? "AND COALESCE(status,'active')='archived'"
    : "AND COALESCE(status,'active')<>'archived'";
  const rows = await ctx
    .query(
      `SELECT id, project_id, title, status, message_count, created_at, updated_at,
              (
                SELECT ar.status
                  FROM agent_runs ar
                 WHERE ar.session_id=sessions.id AND ar.deleted_at IS NULL
                 ORDER BY COALESCE(ar.updated_at, ar.created_at) DESC
                 LIMIT 1
              ) AS latest_run_status
         FROM sessions
        WHERE project_id=$1 AND created_by=$2 AND deleted_at IS NULL
          AND action_type='agentic_chat'
          ${statusFilter}
        ORDER BY updated_at DESC`,
      [input.params.pid, ctx.userId || ""],
    )
    .catch(() => []);
  return { data: { items: rows }, message: "ok" };
}

// GET /api/agent/projects/:pid/model — 当前生效模型(PRIMARY)
export async function getAgentModel(ctx, input) {
  const cfg = await ModelConfigResolver.resolve({ project_id: input.params.pid, category: "PRIMARY" }).catch(() => null);
  return { data: { model_name: cfg?.model_name || "" }, message: "ok" };
}

// GET /api/agent/skills — App 级 Skill 列表(全局聊天/通用智能体)
export async function listAppAgentSkills(ctx) {
  return { data: await listAppSkills(ctx), message: "获取 App 技能列表成功" };
}

// GET /api/agent/skills/enabled/list
export async function listEnabledAppAgentSkills(ctx) {
  return { data: await listEnabledAppSkills(ctx), message: "获取启用 App 技能成功" };
}

// GET /api/agent/skills/available-tools
export async function listAppSkillAvailableTools() {
  return { data: PI_TOOL_CATALOG, message: "获取可用工具成功" };
}

// GET /api/agent/skills/:skillName
export async function getAppAgentSkill(ctx, input) {
  return { data: await getAppSkill(ctx, input.params.skillName), message: "获取 App 技能详情成功" };
}

// POST /api/agent/skills
export async function createAppAgentSkill(ctx, input) {
  const data = await createAppSkill(ctx, input.body || {}, ctx.userId || "");
  return { data, message: "创建 App 技能成功" };
}

// PUT /api/agent/skills/:skillName
export async function updateAppAgentSkill(ctx, input) {
  const data = await updateAppSkill(ctx, input.params.skillName, input.body || {});
  return { data, message: "更新 App 技能成功" };
}

// DELETE /api/agent/skills/:skillName
export async function deleteAppAgentSkill(ctx, input) {
  return { data: await deleteAppSkill(ctx, input.params.skillName, ctx.userId || ""), message: "删除 App 技能成功" };
}

// PATCH /api/agent/skills/:skillName/toggle
export async function toggleAppAgentSkill(ctx, input) {
  const data = await setAppSkillEnabled(ctx, input.params.skillName, input.body || {}, ctx.userId || "");
  return { data, message: "更新 App 技能状态成功" };
}

// POST /api/agent/skills/ai-generate
export async function aiGenerateAppAgentSkill(_ctx, input) {
  return { data: generatePiSkillDraft(input.body?.description || ""), message: "生成技能配置成功" };
}

// GET /api/agent/projects/:pid/files — 工作区文件树
export async function getAgentFiles(ctx, input) {
  try {
    const cwd = sessionScopedWorkspaceCwd(input);
    return { data: { tree: walkDir(cwd, "", 0), root: cwd }, message: "ok" };
  } catch (e) {
    return { data: { tree: [] }, message: e?.message || String(e) };
  }
}

// GET /api/agent/projects/:pid/file?path=... — 读取工作区内单个文件(预览;限工作区内、限大小)
export async function getAgentFile(ctx, input) {
  try {
    const cwd = sessionScopedWorkspaceCwd(input);
    const rel = String(input.query?.path || "");
    const full = join(cwd, rel);
    // 防目录穿越:必须在工作区内
    if (!isInsideDir(cwd, full)) return { data: null, message: "非法路径" };
    const content = readFileSync(full, "utf8").slice(0, 200000);
    return { data: { path: rel, content }, message: "ok" };
  } catch (e) {
    return { data: null, message: e?.message || String(e) };
  }
}

// POST /api/agent/projects/:pid/sessions/:sid/compact — 手动压缩会话上下文(/compact)
export async function compactAgentSession(ctx, input) {
  try {
    const sid = input.params.sid;
    const r = await compactSession({ projectId: input.params.pid, sessionId: sid });
    // 成功压缩 → 往会话流插入一条「压缩分割线」标记(进 SQL,刷新后仍在;模型侧 JSONL 已单独压缩)
    if (r.compacted) {
      try {
        const seqRow = await ctx
          .queryOne(
            `SELECT COALESCE(MAX(sequence_number),0) AS m FROM session_messages WHERE session_id=$1`,
            [sid],
          )
          .catch(() => ({ m: 0 }));
        const seq = Number(seqRow?.m || 0) + 1;
        const block = {
          id: randomUUID(),
          type: "compact",
          content: r.before && r.after ? `上下文已压缩 · ${r.before} → ${r.after}` : "上下文已压缩",
          metadata: { before: r.before, after: r.after },
          is_complete: true,
          display_type: "compact",
        };
        await ctx
          .query(
            `INSERT INTO session_messages (id,session_id,role,content_items,sequence_number,created_at,updated_at)
             VALUES ($1,$2,'assistant',$3,$4,now(),now())`,
            [randomUUID(), sid, JSON.stringify([block]), seq],
          )
          .catch(() => {});
      } catch {
        /* 标记落库失败不影响压缩本身 */
      }
    }
    return {
      data: r,
      message: r.compacted ? `已压缩上下文(${r.before} → ${r.after} 条)` : r.message || "无需压缩",
    };
  } catch (e) {
    return { data: null, message: e?.message || String(e) };
  }
}
