import { randomUUID } from "node:crypto";
import { ApiError } from "../../errors.js";
import { PRODUCT_TOOL_CATALOG } from "./product_tool_catalog.js";
import { loadBuiltinSkills } from "../skills/skill_file_loader.js";

export const PI_TOOL_CATALOG = [
  { name: "update_plan", description: "更新当前任务计划,用于让用户看到多步任务进度。", safety: "meta" },
  { name: "query_project_data", description: "查询当前问数项目已经接入的数据。", safety: "read" },
  { name: "read", description: "读取工作区内文件内容。", safety: "read" },
  { name: "grep", description: "按内容搜索工作区文件。", safety: "read" },
  { name: "ls", description: "列出工作区目录内容。", safety: "read" },
  { name: "find", description: "按 glob 模式查找工作区文件。", safety: "read" },
  { name: "write", description: "创建或覆盖工作区文件,执行前受权限确认控制。", safety: "write" },
  { name: "edit", description: "编辑工作区文件,执行前受权限确认控制。", safety: "write" },
  { name: "bash", description: "在工作区执行 shell 命令,执行前受权限确认控制。", safety: "execute" },
  ...PRODUCT_TOOL_CATALOG,
];

export const BUILTIN_PI_SKILLS = loadBuiltinSkills();
export const APP_SKILL_SCOPE = "__app__";
export const CHAT_SKILL_SCOPE = "__chat__";

const BUILTIN_BY_NAME = new Map(BUILTIN_PI_SKILLS.map((s) => [s.name, s]));
const TOOL_NAMES = new Set(PI_TOOL_CATALOG.map((t) => t.name));

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function toBool(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function boolFrom(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return toBool(value);
}

function cleanString(value, max = 2000) {
  return String(value || "").trim().slice(0, max);
}

function cleanTags(value) {
  return Array.isArray(value)
    ? value.map((x) => cleanString(x, 48)).filter(Boolean).slice(0, 12)
    : [];
}

function cleanAllowedTools(value) {
  return Array.isArray(value)
    ? value.map((x) => cleanString(x, 64)).filter((x) => TOOL_NAMES.has(x)).slice(0, 24)
    : [];
}

function assertKnownAllowedTools(value) {
  if (!Array.isArray(value)) return;
  const requested = value.map((x) => cleanString(x, 64)).filter(Boolean);
  const unknown = [...new Set(requested.filter((x) => !TOOL_NAMES.has(x)))];
  if (unknown.length) throw new ApiError(`未知工具:${unknown.join(", ")}`, 400);
}

function maybeRuntime(value) {
  const runtime = cleanString(value, 32) || "prompt";
  return ["prompt", "service", "workflow"].includes(runtime) ? runtime : "prompt";
}

export function normalizeSkillName(value) {
  const name = cleanString(value, 80);
  if (!name) throw new ApiError("Skill 名称不能为空", 400);
  if (/[/\\?#]/.test(name)) throw new ApiError("Skill 名称不能包含 /、\\、?、# 等路径字符", 400);
  return name;
}

function normalizeSkillConfig(data = {}) {
  const description = cleanString(data.description, 1000);
  const instructions = cleanString(data.instructions, 20000);
  return {
    description,
    category: cleanString(data.category, 80) || null,
    tags: cleanTags(data.tags),
    allowed_tools: cleanAllowedTools(data.allowed_tools),
    instructions,
    runtime: maybeRuntime(data.runtime),
    side_effect: cleanString(data.side_effect, 32) || "read",
    requires_project: boolFrom(data.requires_project, false),
  };
}

function configFromAppRow(row) {
  const cfg = parseJson(row?.config, {});
  return {
    description: cleanString(row?.description || cfg.description, 1000),
    category: cfg.category || null,
    tags: cleanTags(cfg.tags),
    allowed_tools: cleanAllowedTools(cfg.allowed_tools),
    instructions: cleanString(row?.instructions || cfg.instructions || "", 20000),
    runtime: maybeRuntime(row?.runtime || cfg.runtime),
    side_effect: cleanString(cfg.side_effect, 32) || "read",
    requires_project: boolFrom(cfg.requires_project, false),
  };
}

function configFromProjectRow(row) {
  const cfg = parseJson(row?.config, {});
  return {
    description: cleanString(cfg.description),
    category: cfg.category || null,
    tags: cleanTags(cfg.tags),
    allowed_tools: cleanAllowedTools(cfg.allowed_tools),
    instructions: cleanString(cfg.instructions || row?.skill_template || "", 20000),
    runtime: maybeRuntime(cfg.runtime),
    side_effect: cleanString(cfg.side_effect, 32) || "read",
    requires_project: boolFrom(cfg.requires_project, false),
  };
}

function builtinRequiresProject(def) {
  return def.requires_project === true || def.name === "smart_query" || (def.global === false && def.runtime === "service");
}

function appRowToSkill(row) {
  const cfg = configFromAppRow(row);
  const isActive = boolFrom(row?.is_active, true);
  const defaultEnabled = boolFrom(row?.default_enabled ?? row?.is_enabled, true);
  const effective = isActive && defaultEnabled;
  return {
    id: row.id,
    name: row.skill_name,
    ...cfg,
    version: "",
    author: "",
    icon: "",
    inputs: [],
    outputs: [],
    action_type: "",
    builtin: false,
    source: "app_db",
    is_active: isActive,
    default_enabled: defaultEnabled,
    effective_enabled: effective,
    availability: effective ? "enabled" : "disabled",
    is_enabled: effective,
    requires_datasource: cfg.requires_project,
    config: cfg,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function builtinToSkill(def, row = null) {
  const isActive = true;
  const defaultEnabled = true;
  const requiresProject = builtinRequiresProject(def);
  const effective = true;
  return {
    ...def,
    id: row?.id || `builtin:${def.name}`,
    version: "",
    author: "system",
    icon: "",
    inputs: [],
    outputs: [],
    action_type: "",
    source: "builtin_file",
    builtin: true,
    runtime: maybeRuntime(def.runtime),
    side_effect: def.side_effect || "read",
    handler: def.handler || "",
    tool_name: def.tool_name || "",
    requires_project: requiresProject,
    requires_datasource: requiresProject,
    is_active: isActive,
    default_enabled: defaultEnabled,
    effective_enabled: effective,
    availability: effective ? "enabled" : "disabled",
    is_enabled: effective,
    config: {
      description: def.description,
      category: def.category || null,
      tags: def.tags || [],
      allowed_tools: def.allowed_tools || [],
      runtime: maybeRuntime(def.runtime),
      side_effect: def.side_effect || "read",
      handler: def.handler || "",
      tool_name: def.tool_name || "",
      requires_project: requiresProject,
      path: def.path || "",
    },
    created_at: row?.created_at || null,
    updated_at: row?.updated_at || null,
  };
}

async function findAppSkillRow(ctx, name) {
  return ctx.queryOne(
    `SELECT id, skill_name, is_active, default_enabled, builtin, runtime, description, config, instructions, created_at, updated_at
       FROM app_skills
      WHERE skill_name=$1 AND deleted_at IS NULL
      ORDER BY updated_at DESC
      LIMIT 1`,
    [name],
  ).catch(() => null);
}

async function listAppSkillRows(ctx) {
  return ctx.query(
    `SELECT id, skill_name, is_active, default_enabled, builtin, runtime, description, config, instructions, created_at, updated_at
       FROM app_skills
      WHERE deleted_at IS NULL
      ORDER BY created_at`,
  ).catch(() => []);
}

async function insertAppSkillRow(ctx, name, config, { defaultEnabled = true, isActive = true, builtin = false, userId = "" } = {}) {
  const id = randomUUID();
  await ctx.query(
    `INSERT INTO app_skills
       (id, skill_name, is_active, default_enabled, builtin, runtime, description, config, instructions, created_by, updated_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,now(),now())`,
    [
      id,
      name,
      isActive ? 1 : 0,
      defaultEnabled ? 1 : 0,
      builtin ? 1 : 0,
      config.runtime || "prompt",
      config.description || "",
      JSON.stringify(config),
      builtin ? "" : config.instructions || "",
      userId || null,
    ],
  );
  return findAppSkillRow(ctx, name);
}

async function updateAppSkillRow(ctx, name, config, userId = "") {
  await ctx.query(
    `UPDATE app_skills
        SET runtime=$2, description=$3, config=$4, instructions=$5, updated_by=$6, updated_at=now()
      WHERE skill_name=$1 AND deleted_at IS NULL`,
    [name, config.runtime || "prompt", config.description || "", JSON.stringify(config), config.instructions || "", userId || null],
  );
  return findAppSkillRow(ctx, name);
}

async function upsertAppSkillState(ctx, name, patch = {}, userId = "") {
  const builtin = BUILTIN_BY_NAME.get(name);
  const row = await findAppSkillRow(ctx, name);
  const existing = row ? (builtin ? builtinToSkill(builtin, row) : appRowToSkill(row)) : null;
  if (!builtin && !existing) throw new ApiError("Skill 不存在", 404);
  if (builtin) {
    const wantsInactive = patch.is_active === false;
    const wantsDefaultOff = patch.default_enabled === false || patch.is_enabled === false;
    if (wantsInactive || wantsDefaultOff) throw new ApiError("系统内置 Skill 不能关闭", 400);
    return builtinToSkill(builtin, row);
  }

  const isActive = patch.is_active === undefined ? existing?.is_active ?? true : !!patch.is_active;
  const defaultEnabled =
    patch.default_enabled === undefined && patch.is_enabled === undefined
      ? existing?.default_enabled ?? true
      : patch.default_enabled !== undefined
        ? !!patch.default_enabled
        : !!patch.is_enabled;

  if (!row) {
    const def = builtinToSkill(builtin, null);
    const cfg = {
      description: def.description,
      category: def.category || null,
      tags: def.tags || [],
      allowed_tools: def.allowed_tools || [],
      runtime: def.runtime || "prompt",
      side_effect: def.side_effect || "read",
      requires_project: def.requires_project,
    };
    await insertAppSkillRow(ctx, name, cfg, { defaultEnabled, isActive, builtin: true, userId });
  } else {
    await ctx.query(
      `UPDATE app_skills
          SET is_active=$2, default_enabled=$3, updated_by=$4, updated_at=now()
        WHERE skill_name=$1 AND deleted_at IS NULL`,
      [name, isActive ? 1 : 0, defaultEnabled ? 1 : 0, userId || null],
    );
  }
  return getAppSkill(ctx, name);
}

async function findProjectBindingRow(ctx, projectId, name) {
  return ctx.queryOne(
    `SELECT id, project_id, skill_id, skill_name, is_enabled, enabled_override, config, skill_template, created_at, updated_at
       FROM project_skills
      WHERE project_id=$1 AND skill_name=$2 AND deleted_at IS NULL
      ORDER BY updated_at DESC
      LIMIT 1`,
    [projectId, name],
  ).catch(async () => {
    return ctx.queryOne(
      `SELECT id, project_id, skill_name, is_enabled, config, skill_template, created_at, updated_at
         FROM project_skills
        WHERE project_id=$1 AND skill_name=$2 AND deleted_at IS NULL
        ORDER BY updated_at DESC
        LIMIT 1`,
      [projectId, name],
    ).catch(() => null);
  });
}

function bindingOverride(row) {
  if (!row) return null;
  if (Object.prototype.hasOwnProperty.call(row, "enabled_override")) {
    return row.enabled_override === null || row.enabled_override === undefined ? null : toBool(row.enabled_override);
  }
  if (row.is_enabled !== undefined && row.is_enabled !== null) return toBool(row.is_enabled);
  return null;
}

function projectBindingPayload(row) {
  if (!row) return null;
  return {
    id: row.id,
    project_id: row.project_id,
    skill_id: row.skill_id || null,
    skill_name: row.skill_name,
    enabled_override: bindingOverride(row),
    config_override: {},
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function applyProjectBinding(skill, row, projectId) {
  if (skill.builtin) {
    const binding = projectBindingPayload(row);
    return {
      ...skill,
      project_id: projectId,
      binding: binding ? { ...binding, enabled_override: null } : null,
      enabled_override: null,
      effective_enabled: true,
      availability: "enabled",
      disabled_reason: "",
      is_enabled: true,
    };
  }

  const override = bindingOverride(row);
  const inherited = override === null || override === undefined;
  const enabledByBinding = inherited ? !!skill.default_enabled : !!override;
  const blocked = !skill.is_active;
  const effectiveEnabled = !blocked && enabledByBinding;
  return {
    ...skill,
    project_id: projectId,
    binding: projectBindingPayload(row),
    enabled_override: inherited ? null : !!override,
    effective_enabled: effectiveEnabled,
    availability: blocked ? "blocked" : effectiveEnabled ? "enabled" : "disabled",
    disabled_reason: blocked ? "App 级总开关已关闭" : effectiveEnabled ? "" : "未启用",
    is_enabled: effectiveEnabled,
  };
}

async function upsertProjectBinding(ctx, projectId, skill, enabledOverride, userId = "") {
  if (skill.builtin) {
    if (enabledOverride === false) throw new ApiError("系统内置 Skill 不能关闭", 400);
    if (enabledOverride === null || enabledOverride === undefined) {
      const existing = await findProjectBindingRow(ctx, projectId, skill.name);
      if (existing) {
        await ctx.query(
          `UPDATE project_skills
              SET deleted_at=now(), deleted_by=$4, updated_at=now()
            WHERE project_id=$1 AND skill_name=$2 AND id=$3`,
          [projectId, skill.name, existing.id, userId || null],
        ).catch(() => null);
      }
    }
    return getPiSkill(ctx, projectId, skill.name);
  }

  const row = await findProjectBindingRow(ctx, projectId, skill.name);
  const inherited = enabledOverride === null || enabledOverride === undefined;
  const effective = inherited ? !!skill.default_enabled : !!enabledOverride;
  const enabledValue = inherited ? null : enabledOverride ? 1 : 0;
  if (row) {
    await ctx.query(
      `UPDATE project_skills
          SET skill_id=$3, enabled_override=$4, is_enabled=$5, enabled_by=$6, updated_at=now()
        WHERE project_id=$1 AND skill_name=$2 AND deleted_at IS NULL`,
      [projectId, skill.name, skill.id || null, enabledValue, effective ? 1 : 0, userId || null],
    ).catch(() =>
      ctx.query(
        `UPDATE project_skills
            SET is_enabled=$3, enabled_by=$4, updated_at=now()
          WHERE project_id=$1 AND skill_name=$2 AND deleted_at IS NULL`,
        [projectId, skill.name, effective ? 1 : 0, userId || null],
      ),
    );
  } else {
    await ctx.query(
      `INSERT INTO project_skills
         (id, project_id, skill_id, skill_name, is_enabled, enabled_override, config, skill_template, enabled_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),now())`,
      [randomUUID(), projectId, skill.id || null, skill.name, effective ? 1 : 0, enabledValue, "{}", "", userId || null],
    ).catch(() =>
      ctx.query(
        `INSERT INTO project_skills
           (id, project_id, skill_name, is_enabled, config, skill_template, enabled_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now())`,
        [randomUUID(), projectId, skill.name, effective ? 1 : 0, "{}", "", userId || null],
      ),
    );
  }
  return getPiSkill(ctx, projectId, skill.name);
}

async function promoteLegacyProjectSkillDefinitions(ctx, projectId) {
  const rows = await ctx.query(
    `SELECT id, project_id, skill_name, is_enabled, config, skill_template, enabled_by, created_at, updated_at
       FROM project_skills
      WHERE project_id=$1 AND deleted_at IS NULL
      ORDER BY created_at`,
    [projectId],
  ).catch(() => []);
  for (const row of rows) {
    const name = row.skill_name;
    if (!name || BUILTIN_BY_NAME.has(name)) continue;
    const existing = await findAppSkillRow(ctx, name);
    if (existing) continue;
    const cfg = configFromProjectRow(row);
    if (!cfg.description || !cfg.instructions) continue;
    await insertAppSkillRow(ctx, name, cfg, {
      defaultEnabled: true,
      isActive: true,
      builtin: false,
      userId: row.enabled_by || "",
    }).catch(() => null);
  }
}

export function isBuiltinPiSkill(name) {
  return BUILTIN_BY_NAME.has(String(name || ""));
}

export async function listAppSkills(ctx) {
  const rows = await listAppSkillRows(ctx);
  const byName = new Map(rows.map((r) => [r.skill_name, r]));
  const builtins = BUILTIN_PI_SKILLS.map((def) => builtinToSkill(def, byName.get(def.name)));
  const custom = rows.filter((r) => !BUILTIN_BY_NAME.has(r.skill_name)).map(appRowToSkill);
  return [...builtins, ...custom].sort((a, b) => {
    if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export async function listEnabledAppSkills(ctx) {
  return (await listAppSkills(ctx)).filter((s) => s.is_active && s.default_enabled && !s.requires_project);
}

export function listGlobalPiSkills() {
  return BUILTIN_PI_SKILLS
    .map((def) => builtinToSkill(def, null))
    .filter((s) => s.default_enabled && !s.requires_project);
}

export async function getAppSkill(ctx, rawName) {
  const name = normalizeSkillName(rawName);
  const row = await findAppSkillRow(ctx, name);
  const builtin = BUILTIN_BY_NAME.get(name);
  if (builtin) return builtinToSkill(builtin, row);
  if (!row) throw new ApiError("Skill 不存在", 404);
  return appRowToSkill(row);
}

export async function createAppSkill(ctx, data = {}, userId = "") {
  const name = normalizeSkillName(data.name);
  if (BUILTIN_BY_NAME.has(name)) throw new ApiError("不能创建与内置 Skill 同名的自定义 Skill", 400);
  const existing = await findAppSkillRow(ctx, name);
  if (existing) throw new ApiError("Skill 已存在", 409);
  assertKnownAllowedTools(data.allowed_tools);
  const config = normalizeSkillConfig(data);
  if (config.runtime === "service") throw new ApiError("service Skill 只能由 App 内置代码提供", 400);
  if (!config.description) throw new ApiError("Skill 描述不能为空", 400);
  if (!config.instructions) throw new ApiError("Skill 指令不能为空", 400);
  const row = await insertAppSkillRow(ctx, name, config, {
    defaultEnabled: data.default_enabled !== undefined ? !!data.default_enabled : true,
    isActive: data.is_active !== undefined ? !!data.is_active : true,
    userId,
  });
  return appRowToSkill(row);
}

export async function updateAppSkill(ctx, rawName, data = {}, userId = "") {
  const name = normalizeSkillName(rawName);
  if (BUILTIN_BY_NAME.has(name)) throw new ApiError("内置 Skill 不支持编辑定义,只能启用或禁用", 400);
  const existing = await findAppSkillRow(ctx, name);
  if (!existing) throw new ApiError("Skill 不存在", 404);
  if (Object.prototype.hasOwnProperty.call(data, "allowed_tools")) assertKnownAllowedTools(data.allowed_tools);
  const prev = configFromAppRow(existing);
  const config = normalizeSkillConfig({ ...prev, ...data });
  if (config.runtime === "service") throw new ApiError("service Skill 只能由 App 内置代码提供", 400);
  if (!config.description) throw new ApiError("Skill 描述不能为空", 400);
  if (!config.instructions) throw new ApiError("Skill 指令不能为空", 400);
  const row = await updateAppSkillRow(ctx, name, config, userId);
  return appRowToSkill(row);
}

export async function deleteAppSkill(ctx, rawName, userId = "") {
  const name = normalizeSkillName(rawName);
  if (BUILTIN_BY_NAME.has(name)) throw new ApiError("内置 Skill 不能删除", 400);
  const existing = await findAppSkillRow(ctx, name);
  if (!existing) throw new ApiError("Skill 不存在", 404);
  await ctx.query(
    `UPDATE app_skills
        SET deleted_at=now(), deleted_by=$2, updated_by=$2, updated_at=now()
      WHERE skill_name=$1 AND deleted_at IS NULL`,
    [name, userId || null],
  );
  return { name };
}

export async function setAppSkillEnabled(ctx, rawName, enabled, userId = "") {
  const name = normalizeSkillName(rawName);
  const patch = typeof enabled === "object" && enabled !== null ? enabled : { is_enabled: !!enabled };
  return upsertAppSkillState(ctx, name, patch, userId);
}

export async function listPiSkills(ctx, projectId) {
  await promoteLegacyProjectSkillDefinitions(ctx, projectId);
  const skills = await listAppSkills(ctx);
  const rows = await ctx.query(
    `SELECT id, project_id, skill_id, skill_name, is_enabled, enabled_override, config, skill_template, created_at, updated_at
       FROM project_skills
      WHERE project_id=$1 AND deleted_at IS NULL
      ORDER BY created_at`,
    [projectId],
  ).catch(async () =>
    ctx.query(
      `SELECT id, project_id, skill_name, is_enabled, config, skill_template, created_at, updated_at
         FROM project_skills
        WHERE project_id=$1 AND deleted_at IS NULL
        ORDER BY created_at`,
      [projectId],
    ).catch(() => []),
  );
  const byName = new Map(rows.map((r) => [r.skill_name, r]));
  return skills.map((skill) => applyProjectBinding(skill, byName.get(skill.name), projectId));
}

export async function listEnabledPiSkills(ctx, projectId) {
  return (await listPiSkills(ctx, projectId)).filter((s) => s.effective_enabled);
}

export async function getPiSkill(ctx, projectId, rawName) {
  const name = normalizeSkillName(rawName);
  const skills = await listPiSkills(ctx, projectId);
  const skill = skills.find((s) => s.name === name);
  if (!skill) throw new ApiError("Skill 不存在", 404);
  return skill;
}

export async function createPiSkill(_ctx, _projectId, _data = {}, _userId = "") {
  throw new ApiError("项目内不创建 Skill 定义,请在 App 技能库创建后绑定到项目", 400);
}

export async function updatePiSkill(_ctx, _projectId, _rawName, _data = {}) {
  throw new ApiError("项目内不更新 Skill 定义,请在 App 技能库更新定义", 400);
}

export async function deletePiSkill(ctx, projectId, rawName, userId = "") {
  const name = normalizeSkillName(rawName);
  if (isBuiltinPiSkill(name)) throw new ApiError("系统内置 Skill 不能删除", 400);
  const existing = await findProjectBindingRow(ctx, projectId, name);
  if (existing) {
    await ctx.query(
      `UPDATE project_skills
          SET deleted_at=now(), deleted_by=$4, updated_at=now()
        WHERE project_id=$1 AND skill_name=$2 AND id=$3`,
      [projectId, name, existing.id, userId || null],
    );
  }
  return getPiSkill(ctx, projectId, name);
}

export async function setPiSkillEnabled(ctx, projectId, rawName, enabled, userId = "") {
  const name = normalizeSkillName(rawName);
  const appSkill = await getAppSkill(ctx, name);
  const enabledOverride = enabled === null || enabled === undefined ? null : !!enabled;
  return upsertProjectBinding(ctx, projectId, appSkill, enabledOverride, userId);
}

export async function isPiSkillEnabled(ctx, projectId, rawName) {
  const name = normalizeSkillName(rawName);
  const skill = await getPiSkill(ctx, projectId, name);
  return !!skill.effective_enabled;
}

export async function isAppSkillEnabled(ctx, rawName) {
  const name = normalizeSkillName(rawName);
  const skill = await getAppSkill(ctx, name);
  return !!skill.is_active && !!skill.default_enabled && !skill.requires_project;
}

export async function isSkillEnabledForWorkspace(ctx, projectId, rawName) {
  const pid = String(projectId || "");
  if (pid === CHAT_SKILL_SCOPE || pid === APP_SKILL_SCOPE || pid.startsWith("folder:")) {
    return isAppSkillEnabled(ctx, rawName);
  }
  return isPiSkillEnabled(ctx, projectId, rawName);
}

export function isImplicitSkillVisible(skill) {
  return !!(
    skill &&
    (skill.effective_enabled ?? skill.is_enabled) &&
    (skill.runtime || "prompt") === "prompt" &&
    skill.allow_implicit_invocation !== false
  );
}

export function canActivatePromptSkill(skill, { routedSkillName = "" } = {}) {
  if (!skill || (skill.runtime || "prompt") !== "prompt") return false;
  if (skill.allow_implicit_invocation !== false) return true;
  return String(skill.name || "") === String(routedSkillName || "");
}

export function renderPiSkillsIndexPrompt(skills = []) {
  const promptSkills = skills.filter(isImplicitSkillVisible);
  if (!promptSkills.length) return "";
  const blocks = promptSkills.map((s) => {
    const tools = (s.allowed_tools || []).length ? s.allowed_tools.join(", ") : "未限制";
    const tags = (s.tags || []).length ? s.tags.join(", ") : "无";
    return `- ${s.name}: ${s.description || "无描述"}; runtime=${s.runtime || "prompt"}; category=${s.category || "general"}; tags=${tags}; allowed_tools=${tools}`;
  });
  return `

## 当前工作区可用 Skills

以下是当前工作区可用的 Skill 索引。不要凭索引直接执行完整流程。
当用户任务明显匹配某个 Skill 时,必须先调用 use_skill(name) 获取完整指令并激活该 Skill,再继续执行。
激活 Skill 后,只能使用该 Skill allowed_tools 允许的工具;如工具不足,先说明限制或请求用户调整 Skill 配置。

${blocks.join("\n")}`;
}

export function renderPiSkillsPrompt(skills = []) {
  return renderPiSkillsIndexPrompt(skills);
}

export function formatPiSkillInstructions(skill) {
  const tools = (skill?.allowed_tools || []).length ? skill.allowed_tools.join(", ") : "未限制";
  return `Skill: ${skill?.name || ""}
Description: ${skill?.description || ""}
Category: ${skill?.category || "general"}
Runtime: ${skill?.runtime || "prompt"}
Allowed tools: ${tools}

Execution contract:
- 这是 Skill 的执行手册,不是已经完成执行。
- 读取本说明后,必须继续调用 allowed_tools 中允许的底层工具完成任务。
- 不要重复加载同一个 Skill;如工具不足,向用户说明限制。

Instructions:
${skill?.instructions || ""}`;
}

export function generatePiSkillDraft(description = "") {
  const desc = cleanString(description, 1000);
  if (!desc) throw new ApiError("请输入 Skill 需求描述", 400);
  const compact = desc.replace(/\s+/g, " ").slice(0, 24);
  return {
    name: compact ? `${compact}_skill`.replace(/[\/\\?#]/g, "_").slice(0, 80) : "custom_skill",
    description: desc,
    category: "analysis",
    tags: ["custom"],
    allowed_tools: ["read", "grep", "ls", "find", "update_plan"],
    runtime: "prompt",
    requires_project: false,
    instructions: `# 概述
${desc}

# 工作方式
1. 先判断用户问题是否适合使用本 Skill。
2. 明确目标、输入和预期输出。
3. 必要时读取工作区文件或更新任务计划。
4. 输出简洁、可验证的结果。

# 输出规范
- 使用中文回答。
- 说明关键依据和限制。
- 不确定时先说明需要补充的信息。`,
  };
}
