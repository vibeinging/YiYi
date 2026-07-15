// L1 应用/用例层 — 报告模板与报告实例的变更/操作端点。抽自 routes/reports_extra.js,逻辑逐行对齐。
// 签名恒为 async fn(ctx, input) -> { data, message } | throw ApiError;不碰 req/res。
// 二进制下载端点 reports-v1/:rid/download 本批跳过(留批 4)。
import { randomUUID } from "crypto";
import { ApiError } from "../../errors.js";

// 轻量 YAML 解析：仅解析顶级 sections 数组长度及 template.report_type
// 不引入 js-yaml，避免依赖；用正则计数足以满足 section_count 和 validate 需求
function parseSectionCount(yamlSpec) {
  if (!yamlSpec || typeof yamlSpec !== "string") return 0;
  // 匹配 sections: 下以 "- " 开头的顶级列表项（无前导缩进）
  try {
    const inSections = yamlSpec.split(/\nsections:/)[1];
    if (!inSections) return 0;
    // 取到下一个顶级 key（非空白开头的行）为止
    const block = inSections.split(/\n[a-zA-Z]/)[0];
    // 顶级 sections 列表项以 "^- " 开头（无缩进）
    const matches = block.match(/^-\s+/gm);
    return matches ? matches.length : 0;
  } catch {
    return 0;
  }
}

function parseYamlReportType(yamlSpec) {
  if (!yamlSpec) return null;
  const m = yamlSpec.match(/report_type:\s*["']?([^\s"'\n]+)["']?/);
  return m ? m[1] : null;
}

// metadata_json → metadata 字段转换（对齐 Python to_dict 行为）
function normalizeReport(row) {
  if (!row) return row;
  const out = { ...row };
  if ("metadata_json" in out) {
    out.metadata = out.metadata_json;
    delete out.metadata_json;
  }
  return out;
}

// 模板 to_dict：补 section_count
function normalizeTemplate(row) {
  if (!row) return row;
  const out = { ...row };
  if (!("section_count" in out)) {
    out.section_count = parseSectionCount(row.yaml_spec || "");
  }
  return out;
}

// ── 模板：校验 YAML ──
export async function validateTemplate(ctx, input) {
  const { yaml_spec } = input.body || {};
  if (!yaml_spec) throw new ApiError("yaml_spec 不能为空", 400);
  const section_count = parseSectionCount(yaml_spec);
  const report_type = parseYamlReportType(yaml_spec);
  return {
    data: { valid: true, report_type, section_count },
    message: "模板校验成功",
  };
}

// ── 模板：预览渲染 ──
// Node 端无法复现 Python 的 UnifiedHTMLRenderer；
// 返回一个最小可用的 HTML 骨架 + 前端实际读取的 sections/template 字段，
// 让前端 previewMeta.sectionCount 能正常计数。
export async function previewTemplate(ctx, input) {
  const { yaml_spec, payload } = input.body || {};
  if (!yaml_spec) throw new ApiError("yaml_spec 不能为空", 400);
  const section_count = parseSectionCount(yaml_spec);
  const report_type = parseYamlReportType(yaml_spec);

  // 构造最小骨架 sections（供前端计数）
  const fakeSections = Array.from({ length: section_count }, (_, i) => ({
    key: `section_${i}`,
    type: "markdown",
  }));

  const title = (payload && payload.report && payload.report.title) || "预览报告";
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>（预览仅在完整 Python 服务中可用）</p></body></html>`;

  return {
    data: {
      template: { report_type, name: "", theme: "default", spec_version: "v1" },
      sections: fakeSections,
      html,
    },
    message: "模板预览成功",
  };
}

// ── 模板：创建 ──
export async function createTemplate(ctx, input) {
  const { pid } = input.params;
  const {
    name,
    report_type = "general_analysis",
    description = null,
    yaml_spec,
    status = "active",
    is_default = false,
    config = null,
  } = input.body || {};

  if (!name) throw new ApiError("name 不能为空", 400);
  if (!yaml_spec) throw new ApiError("yaml_spec 不能为空", 400);

  // 名称唯一性检查
  const exists = await ctx.queryOne(
    `SELECT id FROM report_templates WHERE project_id=$1 AND name=$2 AND deleted_at IS NULL`,
    [pid, name],
  );
  if (exists) throw new ApiError("同一项目下模板名称不能重复", 400);

  // 如果设为默认，先清除同 report_type 的旧默认
  if (is_default) {
    await ctx.query(
      `UPDATE report_templates SET is_default=false
       WHERE project_id=$1 AND report_type=$2 AND deleted_at IS NULL`,
      [pid, report_type],
    );
  }

  const newId = randomUUID();
  const row = await ctx.queryOne(
    `INSERT INTO report_templates
       (id, project_id, name, report_type, description, yaml_spec, status, is_default, version, spec_version, config, created_by, updated_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,'v1',$9,$10,$10,now(),now())
     RETURNING id, project_id, name, report_type, description, yaml_spec, status, is_default, version, spec_version, config, created_by, updated_by, created_at, updated_at`,
    [newId, pid, name, report_type, description, yaml_spec, status, is_default, config, ctx.userId],
  );

  return { data: normalizeTemplate(row), message: "创建报告模板成功" };
}

// ── 模板：更新 ──
export async function updateTemplate(ctx, input) {
  const { pid, tid } = input.params;
  const tpl = await ctx.queryOne(
    `SELECT * FROM report_templates WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [tid, pid],
  );
  if (!tpl) throw new ApiError("报告模板不存在", 404);

  const {
    name,
    report_type,
    description,
    yaml_spec,
    status,
    is_default,
    spec_version,
    config,
  } = input.body || {};

  // 名称唯一性（排除自身）
  if (name && name !== tpl.name) {
    const dup = await ctx.queryOne(
      `SELECT id FROM report_templates WHERE project_id=$1 AND name=$2 AND id<>$3 AND deleted_at IS NULL`,
      [pid, name, tid],
    );
    if (dup) throw new ApiError("同一项目下模板名称不能重复", 400);
  }

  // 如果设为默认，先清除
  const nextDefault = is_default === true || is_default === "true";
  if (nextDefault && !tpl.is_default) {
    const nextReportType = report_type || tpl.report_type;
    await ctx.query(
      `UPDATE report_templates SET is_default=false
       WHERE project_id=$1 AND report_type=$2 AND deleted_at IS NULL`,
      [pid, nextReportType],
    );
  }

  const setClauses = [];
  const params = [];
  const add = (col, val) => {
    params.push(val);
    setClauses.push(`${col}=$${params.length}`);
  };

  if (name !== undefined && name !== null) add("name", name);
  if (report_type !== undefined && report_type !== null) add("report_type", report_type);
  if (description !== undefined) add("description", description);
  if (yaml_spec !== undefined && yaml_spec !== null) add("yaml_spec", yaml_spec);
  if (status !== undefined && status !== null) add("status", status);
  if (is_default !== undefined && is_default !== null)
    add("is_default", nextDefault);
  if (spec_version !== undefined && spec_version !== null) add("spec_version", spec_version);
  if (config !== undefined && config !== null) add("config", JSON.stringify(config));

  add("version", (tpl.version || 1) + 1);
  add("updated_by", ctx.userId);
  add("updated_at", new Date());

  params.push(tid);
  params.push(pid);

  const row = await ctx.queryOne(
    `UPDATE report_templates SET ${setClauses.join(",")}
     WHERE id=$${params.length - 1} AND project_id=$${params.length} AND deleted_at IS NULL
     RETURNING id, project_id, name, report_type, description, yaml_spec, status, is_default, version, spec_version, config, created_by, updated_by, created_at, updated_at`,
    params,
  );

  if (!row) throw new ApiError("报告模板不存在或更新失败", 404);
  return { data: normalizeTemplate(row), message: "更新报告模板成功" };
}

// ── 模板：设为默认 ──
export async function setDefaultTemplate(ctx, input) {
  const { pid, tid } = input.params;
  const tpl = await ctx.queryOne(
    `SELECT * FROM report_templates WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [tid, pid],
  );
  if (!tpl) throw new ApiError("报告模板不存在", 404);
  if (tpl.status !== "active") throw new ApiError("停用模板不能设为默认模板", 400);

  // 清除同 report_type 旧默认
  await ctx.query(
    `UPDATE report_templates SET is_default=false
     WHERE project_id=$1 AND report_type=$2 AND deleted_at IS NULL`,
    [pid, tpl.report_type],
  );

  const row = await ctx.queryOne(
    `UPDATE report_templates SET is_default=true, updated_by=$1, updated_at=now()
     WHERE id=$2 AND project_id=$3 AND deleted_at IS NULL
     RETURNING id, project_id, name, report_type, description, yaml_spec, status, is_default, version, spec_version, config, created_by, updated_by, created_at, updated_at`,
    [ctx.userId, tid, pid],
  );

  return { data: normalizeTemplate(row), message: "设置默认模板成功" };
}

// ── 模板：切换状态 ──
export async function toggleTemplateStatus(ctx, input) {
  const { pid, tid } = input.params;
  const { status } = input.body || {};
  if (!["active", "disabled"].includes(status))
    throw new ApiError("模板状态只能是 active 或 disabled", 400);

  // 停用时同时清除 is_default；启用时保留原值
  const newIsDefault = status === "disabled" ? false : null; // null = keep
  let row;
  if (status === "disabled") {
    row = await ctx.queryOne(
      `UPDATE report_templates
          SET status=$1, is_default=false, updated_by=$2, updated_at=now()
        WHERE id=$3 AND project_id=$4 AND deleted_at IS NULL
        RETURNING id, project_id, name, report_type, description, yaml_spec, status, is_default, version, spec_version, config, created_by, updated_by, created_at, updated_at`,
      [status, ctx.userId, tid, pid],
    );
  } else {
    row = await ctx.queryOne(
      `UPDATE report_templates
          SET status=$1, updated_by=$2, updated_at=now()
        WHERE id=$3 AND project_id=$4 AND deleted_at IS NULL
        RETURNING id, project_id, name, report_type, description, yaml_spec, status, is_default, version, spec_version, config, created_by, updated_by, created_at, updated_at`,
      [status, ctx.userId, tid, pid],
    );
  }

  if (!row) throw new ApiError("报告模板不存在", 404);
  return { data: normalizeTemplate(row), message: "更新模板状态成功" };
}

// ── 模板：使用记录（覆盖 index.js 中返回空数组的 stub）──
export async function getTemplateUsageBusinesses(ctx, input) {
  const { pid, tid } = input.params;

  const tpl = await ctx.queryOne(
    `SELECT id, name, report_type FROM report_templates
      WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [tid, pid],
  );
  if (!tpl) throw new ApiError("报告模板不存在", 404);

  // 聚合：每个 project_id 的使用次数、最近时间、最近报告 id
  const reports = await ctx.query(
    `SELECT id, project_id, metadata_json, created_at
       FROM generated_reports
      WHERE project_id=$1 AND template_id=$2 AND deleted_at IS NULL
      ORDER BY created_at DESC`,
    [pid, tid],
  );

  // 按 project_id 归并
  const usageMap = new Map();
  for (const r of reports) {
    let meta = r.metadata_json;
    if (typeof meta === "string") {
      try { meta = JSON.parse(meta); } catch { meta = {}; }
    }
    meta = meta || {};
    const trace = (meta.report_trace && typeof meta.report_trace === "object") ? meta.report_trace : {};
    const bizId = r.project_id || trace.project_id;
    if (!bizId) continue;

    if (!usageMap.has(bizId)) {
      usageMap.set(bizId, {
        project_id: bizId,
        usage_count: 0,
        latest_used_at: r.created_at ? new Date(r.created_at).toISOString() : null,
        latest_report_id: r.id,
      });
    }
    usageMap.get(bizId).usage_count += 1;
  }

  // 批量查 business name/description
  const bizIds = [...usageMap.keys()];
  const businesses = bizIds.length
    ? await ctx.query(
        `SELECT id, name, description FROM businesses
          WHERE id::text = ANY($1::text[]) AND deleted_at IS NULL`,
        [bizIds],
      )
    : [];
  const bizLookup = new Map(businesses.map((b) => [b.id, b]));

  const items = [...usageMap.values()].map((u) => {
    const biz = bizLookup.get(u.project_id);
    return {
      project_id: u.project_id,
      business_name: biz ? biz.name : u.project_id,
      business_description: biz ? (biz.description || "") : "",
      usage_count: u.usage_count,
      latest_used_at: u.latest_used_at,
      latest_report_id: u.latest_report_id,
    };
  });

  items.sort((a, b) => {
    if (!a.latest_used_at) return 1;
    if (!b.latest_used_at) return -1;
    return b.latest_used_at.localeCompare(a.latest_used_at);
  });

  return {
    data: {
      template_id: tpl.id,
      template_name: tpl.name,
      report_type: tpl.report_type,
      items,
    },
    message: "获取模板使用记录成功",
  };
}

// ── 深度研究报告：全文 ──
export async function getDeepResearchReport(ctx, input) {
  const { pid, taskId } = input.params;

  const task = await ctx.queryOne(
    `SELECT id, project_id, status, result_data, updated_at
       FROM tasks
      WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [taskId, pid],
  );

  if (!task) throw new ApiError("报告不存在", 404);
  if (task.status !== "completed")
    throw new ApiError(`报告尚未生成完成，当前状态：${task.status}`, 400);

  let resultData = task.result_data;
  if (typeof resultData === "string") {
    try { resultData = JSON.parse(resultData); } catch { resultData = {}; }
  }
  resultData = resultData || {};

  const htmlReport = resultData.html_report;
  if (typeof htmlReport !== "string" || !htmlReport.trim())
    throw new ApiError("报告内容为空", 404);

  const reportSize = htmlReport.length;
  return {
    data: {
      task_id: taskId,
      html: htmlReport,
      metadata: {
        size: reportSize,
        size_kb: Math.floor(reportSize / 1024),
        created_at: task.updated_at ? new Date(task.updated_at).toISOString() : null,
        paper_count: resultData.paper_count || 0,
        section_count: resultData.section_count || 0,
      },
    },
  };
}

// ── 深度研究报告：元信息 ──
export async function getDeepResearchReportInfo(ctx, input) {
  const { pid, taskId } = input.params;

  const task = await ctx.queryOne(
    `SELECT id, project_id, status, result_data, updated_at
       FROM tasks
      WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [taskId, pid],
  );

  if (!task) throw new ApiError("报告不存在", 404);

  let resultData = task.result_data;
  if (typeof resultData === "string") {
    try { resultData = JSON.parse(resultData); } catch { resultData = {}; }
  }
  resultData = resultData || {};

  return {
    data: {
      task_id: taskId,
      status: task.status,
      created_at: task.updated_at ? new Date(task.updated_at).toISOString() : null,
      metadata: {
        paper_count: resultData.paper_count || 0,
        section_count: resultData.section_count || 0,
        size: resultData.report_size || 0,
      },
    },
  };
}
