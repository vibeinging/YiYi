// L1 应用/用例层 — MCP Provider Library + Project Binding。
// App 级存 Provider 定义;项目级只存 enabled_override 绑定,与 Skill Library 模型一致。
import { randomUUID } from "crypto";
import { ApiError } from "../../errors.js";
import {
  discoverMcpProviderTools,
  disposeAllMcpRuntimes,
  disposeProjectMcpRuntimes,
  listAppMcpProviderRows,
  listEffectiveMcpProviders,
  normalizeMcpProviderRow,
} from "../../engine/agents/mcp_tools.js";

const APP_MCP_COLS = `id, provider_name, transport, command, args, env, is_active, default_enabled,
  last_discovered_at, last_error, created_at, updated_at`;

export function mcpRow(r) {
  return normalizeMcpProviderRow(r);
}

function toBool(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function boolFrom(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return toBool(value);
}

function normalizeArgs(args) {
  return Array.isArray(args) ? args.map((x) => String(x)) : [];
}

function normalizeEnv(env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) return {};
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    const k = String(key || "").trim();
    if (!k) continue;
    out[k] = value == null ? "" : String(value);
  }
  return out;
}

export function normalizeMcpProviderName(value) {
  const name = String(value || "").trim();
  if (!name) throw new ApiError("Provider 名称不能为空", 400);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
    throw new ApiError(`非法的 Provider 名称: ${name}`, 400);
  }
  return name;
}

function validateProviderPayload({ provider_name, transport, command }, { requireCommand = true } = {}) {
  if (provider_name !== undefined) normalizeMcpProviderName(provider_name);
  if (requireCommand && !command) throw new ApiError("command 不能为空", 400);
  if (command !== undefined && !String(command || "").trim()) throw new ApiError("command 不能为空", 400);
  if ((transport || "stdio") !== "stdio") {
    throw new ApiError(`不支持的 transport: ${transport},当前仅支持 stdio`, 400);
  }
}

async function findAppProviderRow(ctx, rawNameOrId) {
  const nameOrId = String(rawNameOrId || "").trim();
  if (!nameOrId) return null;
  return ctx.queryOne(
    `SELECT ${APP_MCP_COLS}
       FROM app_mcp_providers
      WHERE (id=$1 OR provider_name=$1) AND deleted_at IS NULL
      ORDER BY updated_at DESC
      LIMIT 1`,
    [nameOrId],
  ).catch(() => null);
}

async function getAppProviderRow(ctx, rawNameOrId) {
  const row = await findAppProviderRow(ctx, rawNameOrId);
  if (!row) throw new ApiError("MCP Provider 不存在", 404);
  return row;
}

async function findProjectBindingRow(ctx, projectId, provider) {
  return ctx.queryOne(
    `SELECT id, project_id, provider_id, provider_name, is_enabled, enabled_override, created_at, updated_at
       FROM project_mcp_providers
      WHERE project_id=$1
        AND deleted_at IS NULL
        AND (provider_id=$2 OR provider_name=$3)
      ORDER BY updated_at DESC
      LIMIT 1`,
    [projectId, provider.id, provider.provider_name],
  ).catch(async () =>
    ctx.queryOne(
      `SELECT id, project_id, provider_name, is_enabled, created_at, updated_at
         FROM project_mcp_providers
        WHERE project_id=$1 AND provider_name=$2 AND deleted_at IS NULL
        ORDER BY updated_at DESC
        LIMIT 1`,
      [projectId, provider.provider_name],
    ).catch(() => null),
  );
}

async function upsertProjectMcpBinding(ctx, projectId, provider, enabledOverride, userId = "") {
  const inherited = enabledOverride === null || enabledOverride === undefined;
  const effective = inherited ? boolFrom(provider.default_enabled, true) : !!enabledOverride;
  const enabledValue = inherited ? null : enabledOverride ? 1 : 0;
  const existing = await findProjectBindingRow(ctx, projectId, provider);
  if (existing) {
    await ctx.query(
      `UPDATE project_mcp_providers
          SET provider_id=$3, provider_name=$4, enabled_override=$5, is_enabled=$6, enabled_by=$7, updated_at=now()
        WHERE project_id=$1 AND id=$2 AND deleted_at IS NULL`,
      [projectId, existing.id, provider.id, provider.provider_name, enabledValue, effective ? 1 : 0, userId || null],
    ).catch(() =>
      ctx.query(
        `UPDATE project_mcp_providers
            SET provider_name=$3, is_enabled=$4, enabled_by=$5, updated_at=now()
          WHERE project_id=$1 AND id=$2 AND deleted_at IS NULL`,
        [projectId, existing.id, provider.provider_name, effective ? 1 : 0, userId || null],
      ),
    );
  } else {
    await ctx.query(
      `INSERT INTO project_mcp_providers
         (id, project_id, provider_id, provider_name, is_enabled, enabled_override, enabled_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now())`,
      [randomUUID(), projectId, provider.id, provider.provider_name, effective ? 1 : 0, enabledValue, userId || null],
    ).catch(() =>
      ctx.query(
        `INSERT INTO project_mcp_providers
           (id, project_id, provider_name, is_enabled, enabled_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,now(),now())`,
        [randomUUID(), projectId, provider.provider_name, effective ? 1 : 0, userId || null],
      ),
    );
  }
  await disposeProjectMcpRuntimes(projectId);
  return getProjectMcpProvider(ctx, projectId, provider.provider_name);
}

async function clearProjectMcpBinding(ctx, projectId, provider, userId = "") {
  await ctx.query(
    `UPDATE project_mcp_providers
        SET deleted_at=now(), deleted_by=$4, updated_at=now()
      WHERE project_id=$1 AND deleted_at IS NULL AND (provider_id=$2 OR provider_name=$3)`,
    [projectId, provider.id, provider.provider_name, userId || null],
  ).catch(() =>
    ctx.query(
      `UPDATE project_mcp_providers
          SET deleted_at=now(), deleted_by=$3, updated_at=now()
        WHERE project_id=$1 AND provider_name=$2 AND deleted_at IS NULL`,
      [projectId, provider.provider_name, userId || null],
    ),
  );
  await disposeProjectMcpRuntimes(projectId);
  return getProjectMcpProvider(ctx, projectId, provider.provider_name);
}

export async function getProjectMcpProvider(ctx, projectId, rawNameOrId) {
  const rows = await listEffectiveMcpProviders(ctx, projectId);
  const target = String(rawNameOrId || "");
  const row = rows.find((provider) => provider.id === target || provider.provider_name === target || provider.app_provider_id === target);
  if (!row) throw new ApiError("MCP Provider 不存在", 404);
  return row;
}

// GET /api/agent/mcp_providers
export async function listAppMcpProviders(ctx) {
  const rows = await listAppMcpProviderRows(ctx).catch((e) => {
    console.error("[app mcp providers list]", e?.message ?? e);
    return [];
  });
  return { data: rows.map(mcpRow), message: "获取 App MCP Provider 列表成功" };
}

// GET /api/agent/mcp_providers/:providerName
export async function getAppMcpProvider(ctx, input) {
  return { data: mcpRow(await getAppProviderRow(ctx, input.params.providerName)), message: "获取 App MCP Provider 成功" };
}

// POST /api/agent/mcp_providers/test
export async function testAppMcpProvider(_ctx, input) {
  const body = input.body || {};
  try {
    validateProviderPayload(body);
    const discovered = await discoverMcpProviderTools({
      provider_name: body.provider_name || "test",
      transport: body.transport || "stdio",
      command: body.command,
      args: normalizeArgs(body.args),
      env: normalizeEnv(body.env),
      is_active: true,
      default_enabled: true,
    });
    return {
      data: { ok: true, tools: discovered.tools, tool_count: discovered.tools.length },
      message: "连接测试完成",
    };
  } catch (e) {
    return {
      data: { ok: false, error: e?.message || String(e), tools: [], tool_count: 0 },
      message: "连接测试完成",
    };
  }
}

// POST /api/agent/mcp_providers
export async function createAppMcpProvider(ctx, input) {
  const body = input.body || {};
  const providerName = normalizeMcpProviderName(body.provider_name);
  validateProviderPayload({ ...body, provider_name: providerName });
  const existing = await findAppProviderRow(ctx, providerName);
  if (existing) throw new ApiError("MCP Provider 已存在", 409);

  const row = await ctx.queryOne(
    `INSERT INTO app_mcp_providers
       (id, provider_name, transport, command, args, env, is_active, default_enabled, created_by, updated_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,now(),now())
     RETURNING ${APP_MCP_COLS}`,
    [
      randomUUID(),
      providerName,
      body.transport || "stdio",
      String(body.command || "").trim(),
      JSON.stringify(normalizeArgs(body.args)),
      JSON.stringify(normalizeEnv(body.env)),
      boolFrom(body.is_active, true) ? 1 : 0,
      boolFrom(body.default_enabled ?? body.is_enabled, true) ? 1 : 0,
      ctx.userId || null,
    ],
  );
  await disposeAllMcpRuntimes();
  return { data: mcpRow(row), message: "MCP Provider 创建成功" };
}

// PUT /api/agent/mcp_providers/:providerName
export async function updateAppMcpProvider(ctx, input) {
  const { providerName } = input.params;
  const existing = await getAppProviderRow(ctx, providerName);
  const body = input.body || {};
  validateProviderPayload(body, { requireCommand: false });

  const sets = [];
  const params = [];
  let idx = 1;
  if (body.command !== undefined) { sets.push(`command=$${idx++}`); params.push(String(body.command || "").trim()); }
  if (body.args !== undefined) { sets.push(`args=$${idx++}`); params.push(JSON.stringify(normalizeArgs(body.args))); }
  if (body.env !== undefined) { sets.push(`env=$${idx++}`); params.push(JSON.stringify(normalizeEnv(body.env))); }
  if (body.transport !== undefined) { sets.push(`transport=$${idx++}`); params.push(body.transport || "stdio"); }
  if (body.is_active !== undefined) { sets.push(`is_active=$${idx++}`); params.push(boolFrom(body.is_active, true) ? 1 : 0); }
  if (body.default_enabled !== undefined || body.is_enabled !== undefined) {
    sets.push(`default_enabled=$${idx++}`);
    params.push(boolFrom(body.default_enabled ?? body.is_enabled, true) ? 1 : 0);
  }
  if (!sets.length) return { data: mcpRow(existing), message: "无变更" };
  sets.push(`updated_by=$${idx++}`);
  params.push(ctx.userId || null);
  sets.push(`updated_at=now()`);
  params.push(existing.id);
  const row = await ctx.queryOne(
    `UPDATE app_mcp_providers
        SET ${sets.join(",")}
      WHERE id=$${idx} AND deleted_at IS NULL
      RETURNING ${APP_MCP_COLS}`,
    params,
  );
  await disposeAllMcpRuntimes();
  return { data: mcpRow(row), message: "MCP Provider 更新成功" };
}

// PATCH /api/agent/mcp_providers/:providerName/toggle
export async function toggleAppMcpProvider(ctx, input) {
  const existing = await getAppProviderRow(ctx, input.params.providerName);
  const body = input.body || {};
  const patch = {};
  if (body.is_active !== undefined) patch.is_active = body.is_active;
  if (body.default_enabled !== undefined || body.is_enabled !== undefined) {
    patch.default_enabled = body.default_enabled ?? body.is_enabled;
  }
  if (patch.is_active === undefined && patch.default_enabled === undefined) {
    throw new ApiError("is_active/default_enabled/is_enabled 至少需要传一个", 400);
  }
  return updateAppMcpProvider(ctx, {
    ...input,
    params: { providerName: existing.id },
    body: patch,
  });
}

// DELETE /api/agent/mcp_providers/:providerName
export async function deleteAppMcpProvider(ctx, input) {
  const row = await getAppProviderRow(ctx, input.params.providerName);
  await ctx.query(
    `UPDATE app_mcp_providers
        SET deleted_at=now(), deleted_by=$2, updated_by=$2, updated_at=now()
      WHERE id=$1 AND deleted_at IS NULL`,
    [row.id, ctx.userId || null],
  );
  await disposeAllMcpRuntimes();
  return { data: { deleted: true, provider_name: row.provider_name }, message: "MCP Provider 已删除" };
}

// POST /api/agent/mcp_providers/:providerName/rediscover
export async function rediscoverAppMcpProvider(ctx, input) {
  const row = await getAppProviderRow(ctx, input.params.providerName);
  try {
    const discovered = await discoverMcpProviderTools(row);
    const updated = await ctx.queryOne(
      `UPDATE app_mcp_providers
          SET last_discovered_at=now(), last_error=NULL, updated_at=now()
        WHERE id=$1
        RETURNING ${APP_MCP_COLS}`,
      [row.id],
    );
    await disposeAllMcpRuntimes();
    return {
      data: { ...mcpRow(updated), ok: true, tools: discovered.tools, tool_count: discovered.tools.length },
      message: "MCP Provider 发现完成",
    };
  } catch (e) {
    const error = e?.message || String(e);
    const updated = await ctx.queryOne(
      `UPDATE app_mcp_providers
          SET last_error=$1, updated_at=now()
        WHERE id=$2
        RETURNING ${APP_MCP_COLS}`,
      [error, row.id],
    );
    await disposeAllMcpRuntimes();
    return {
      data: { ...mcpRow(updated), ok: false, error, tools: [], tool_count: 0 },
      message: "MCP Provider 发现失败",
    };
  }
}

// GET /api/projects/:pid/mcp_providers
export async function listProjectMcpProviders(ctx, input) {
  const rows = await listEffectiveMcpProviders(ctx, input.params.pid).catch((e) => {
    console.error("[project mcp providers list]", e?.message ?? e);
    return [];
  });
  return { data: rows, message: "获取项目 MCP Provider 列表成功" };
}

// 兼容旧路由:项目内不再创建定义。
export async function createMcpProvider() {
  throw new ApiError("项目内不创建 MCP Provider 定义,请在 App 设置 → MCP 服务器中创建后绑定到项目", 400);
}

// 兼容旧路由:/test 仍可测试临时配置。
export async function testMcpProvider(ctx, input) {
  return testAppMcpProvider(ctx, input);
}

// PATCH /api/projects/:pid/mcp_providers/:providerName/binding
// PATCH /api/projects/:pid/mcp_providers/:mid
export async function updateMcpProvider(ctx, input) {
  const { pid, providerName, mid } = input.params;
  const raw = Object.prototype.hasOwnProperty.call(input.body || {}, "enabled_override")
    ? input.body.enabled_override
    : input.body?.is_enabled;
  if (!(typeof raw === "boolean" || raw === null)) throw new ApiError("is_enabled/enabled_override 必须为布尔值或 null", 400);
  const provider = await getAppProviderRow(ctx, providerName || mid);
  const data = await upsertProjectMcpBinding(ctx, pid, provider, raw, ctx.userId || "");
  return { data, message: "更新项目 MCP Provider 绑定成功" };
}

// DELETE /api/projects/:pid/mcp_providers/:mid — 清除项目绑定覆盖。
export async function deleteMcpProvider(ctx, input) {
  const { pid, mid, providerName } = input.params;
  const provider = await getAppProviderRow(ctx, providerName || mid);
  const data = await clearProjectMcpBinding(ctx, pid, provider, ctx.userId || "");
  return { data, message: "已清除项目 MCP Provider 绑定" };
}

// POST /api/projects/:pid/mcp_providers/:mid/rediscover — 兼容旧路由,实际发现 App Provider。
export async function rediscoverMcpProvider(ctx, input) {
  return rediscoverAppMcpProvider(ctx, {
    ...input,
    params: { providerName: input.params.mid || input.params.providerName },
  });
}
