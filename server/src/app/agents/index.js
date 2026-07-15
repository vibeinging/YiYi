// L1 应用/用例层 — Agent 配置域 CRUD。抽自 routes/agents.js,逻辑逐行对齐。
// 签名恒为 async fn(ctx, input) -> { data, message } | throw ApiError;不碰 req/res。
//
// 覆盖端点:
//   GET    /api/agents/projects/:pid/businesses/:bid/agents/config/:agentType
//   POST   /api/agents/projects/:pid/businesses/:bid/agents/config
//   GET    /api/agents/projects/:pid/agents/detail/:agentId
//   DELETE /api/agents/projects/:pid/agents/detail/:agentId
//   PATCH  /api/agents/projects/:pid/businesses/:bid/agents/config/:agentType/toggle
//
// 注:
//   - /api/agents/types/config (GET) 仍在 index.js 中实现(静态数组),此处不重复注册。
//   - 响应形状与前端 AgentSettings.vue + api/agent.js 严格对齐。
//   - GET 配置始终返回 default_* 字段(前端用于重置功能);Node 侧无 Python 侧的 prompt_templates_loader,
//     default_* 字段来自已存库行的实际值镜像(同库值),若行不存在则返回空字符串。
import { ApiError } from "../../errors.js";

const QUERY_AGENT_TYPE = "query_agent";
const LEGACY_QUERY_AGENT_TYPE = "pi_query_agent";

function normalizeAgentType(agentType) {
  return agentType === LEGACY_QUERY_AGENT_TYPE ? QUERY_AGENT_TYPE : agentType;
}

function agentTypeCandidates(agentType) {
  const normalized = normalizeAgentType(agentType);
  return normalized === QUERY_AGENT_TYPE ? [QUERY_AGENT_TYPE, LEGACY_QUERY_AGENT_TYPE] : [normalized];
}

// 合法的 Agent 类型白名单(与 Python models/agent.py AgentType 对齐)
const VALID_AGENT_TYPES = new Set([
  "nl2sql",
  "format",
  "failure_analysis",
  "supervisor",
  "super_agent",
  QUERY_AGENT_TYPE,
  LEGACY_QUERY_AGENT_TYPE,
  "ds_agent",
  "agentic_search",
  "workflow_selection",
]);

// ── GET 单个 Agent 配置(按类型+业务) ──
// 前端: getAgentConfig(pid, bid, agentType) → res.data
// 形状: { id, agent_type, project_id, model_id, system_prompt, user_prompt_template,
//         rules, is_active, default_system_prompt, default_user_prompt_template, default_rules }
export async function getAgentConfig(ctx, input) {
  const { pid, agentType } = input.params;
  const canonicalAgentType = normalizeAgentType(agentType);
  const candidates = agentTypeCandidates(agentType);

  const agent = await ctx.queryOne(
    `SELECT id, agent_type, project_id, model_id,
            system_prompt, user_prompt_template, rules, is_active
       FROM agents
      WHERE project_id=$1 AND agent_type = ANY($2::text[])
        AND deleted_at IS NULL
      ORDER BY CASE WHEN agent_type=$3 THEN 0 ELSE 1 END, updated_at DESC
      LIMIT 1`,
    [pid, candidates, canonicalAgentType],
  );

  if (agent) {
    return {
      data: {
        id: agent.id,
        agent_type: canonicalAgentType,
        project_id: agent.project_id,
        model_id: agent.model_id || "",
        system_prompt: agent.system_prompt || "",
        user_prompt_template: agent.user_prompt_template || "",
        rules: agent.rules || "",
        is_active: agent.is_active,
        default_system_prompt: agent.system_prompt || "",
        default_user_prompt_template: agent.user_prompt_template || "",
        default_rules: agent.rules || "",
      },
      message: "获取Agent配置成功",
    };
  }

  return {
    data: {
      id: "",
      agent_type: canonicalAgentType,
      project_id: pid,
      model_id: "",
      system_prompt: "",
      user_prompt_template: "",
      rules: "",
      is_active: true,
      default_system_prompt: "",
      default_user_prompt_template: "",
      default_rules: "",
    },
    message: "获取Agent配置成功",
  };
}

// ── POST 保存 Agent 配置(创建或更新) ──
// 前端: saveAgentConfig(pid, bid, { name, agent_type, project_id, model_id,
//                                   system_prompt, user_prompt_template, rules })
// 响应: { success: true, message, data: null, detail: {} }
export async function saveAgentConfig(ctx, input) {
  const { pid } = input.params;
  const {
    name,
    agent_type,
    model_id = null,
    system_prompt = null,
    user_prompt_template = null,
    rules = null,
  } = input.body || {};

  if (!name) throw new ApiError("name 不能为空", 400);
  if (!agent_type) throw new ApiError("agent_type 不能为空", 400);
  if (!VALID_AGENT_TYPES.has(agent_type)) {
    throw new ApiError(`无效的 agent_type: ${agent_type}`, 400);
  }

  const canonicalAgentType = normalizeAgentType(agent_type);
  const candidates = agentTypeCandidates(agent_type);
  const userId = ctx.userId;

  const existing = await ctx.queryOne(
    `SELECT id FROM agents
      WHERE project_id=$1 AND agent_type = ANY($2::text[])
        AND deleted_at IS NULL
      ORDER BY CASE WHEN agent_type=$3 THEN 0 ELSE 1 END, updated_at DESC
      LIMIT 1`,
    [pid, candidates, canonicalAgentType],
  );

  if (existing) {
    await ctx.query(
      `UPDATE agents
          SET name=$1, agent_type=$2, model_id=$3, system_prompt=$4,
              user_prompt_template=$5, rules=$6, updated_at=now()
        WHERE id=$7`,
      [name, canonicalAgentType, model_id || null, system_prompt || null, user_prompt_template || null, rules || null, existing.id],
    );
  } else {
    const id = crypto.randomUUID();
    await ctx.query(
      `INSERT INTO agents
         (id, name, agent_type, project_id, created_by,
          model_id, system_prompt, user_prompt_template, rules,
          is_active, is_default, version, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,false,'1.0.0',now(),now())`,
      [id, name, canonicalAgentType, pid, userId, model_id || null, system_prompt || null, user_prompt_template || null, rules || null],
    );
  }

  return { data: null, message: "保存成功" };
}

// ── GET Agent 详情(按 ID) ──
// 前端: getAgentDetail(pid, agentId) → res.data
export async function getAgentDetail(ctx, input) {
  const { pid, agentId } = input.params;

  const agent = await ctx.queryOne(
    `SELECT id, name, agent_type, project_id, created_by,
            model_id, system_prompt, user_prompt_template, rules,
            description, version, is_active, is_default,
            last_used_at, created_at, updated_at
       FROM agents
      WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [agentId, pid],
  );

  if (!agent) throw new ApiError("Agent不存在或无权限", 404);

  return { data: { ...agent, agent_type: normalizeAgentType(agent.agent_type) }, message: "获取Agent详情成功" };
}

// ── DELETE Agent 配置(软删除) ──
// 前端: deleteAgentConfig(pid, agentId) → res.data
export async function deleteAgent(ctx, input) {
  const { pid, agentId } = input.params;

  const existing = await ctx.queryOne(
    `SELECT id FROM agents WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [agentId, pid],
  );

  if (!existing) throw new ApiError("Agent不存在或无权限", 404);

  await ctx.query(
    `UPDATE agents SET deleted_at=now(), deleted_by=$1 WHERE id=$2`,
    [ctx.userId, agentId],
  );

  return { data: null, message: "删除Agent配置成功" };
}

// ── PATCH 切换 Agent 启用/停用 ──
// 前端: toggleAgentActive(pid, bid, agentType, isActive)
//   PATCH .../config/:agentType/toggle?is_active=true/false
export async function toggleAgent(ctx, input) {
  const { pid, agentType } = input.params;
  const canonicalAgentType = normalizeAgentType(agentType);
  const candidates = agentTypeCandidates(agentType);
  const isActiveRaw = (input.query || {}).is_active;
  if (isActiveRaw === undefined) throw new ApiError("is_active 参数必填", 400);
  const isActive = isActiveRaw === "true" || isActiveRaw === true;

  const agent = await ctx.queryOne(
    `SELECT id FROM agents
      WHERE project_id=$1 AND agent_type = ANY($2::text[])
        AND deleted_at IS NULL
      ORDER BY CASE WHEN agent_type=$3 THEN 0 ELSE 1 END, updated_at DESC
      LIMIT 1`,
    [pid, candidates, canonicalAgentType],
  );

  if (!agent) throw new ApiError("Agent配置不存在，请先保存配置", 404);

  await ctx.query(`UPDATE agents SET agent_type=$1, is_active=$2, updated_at=now() WHERE id=$3`, [
    canonicalAgentType,
    isActive,
    agent.id,
  ]);

  return { data: null, message: isActive ? "Agent已启用" : "Agent已停用" };
}
