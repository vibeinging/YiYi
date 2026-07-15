import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const WORKSPACE_AGENTS_FILE = "AGENTS.md";

const MAX_CONTEXT_CHARS = 16000;
const CONTEXT_FILE_CANDIDATES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
const DATA_SOURCE_SECTION_START = "<!-- YIW:DATASOURCES:START -->";
const DATA_SOURCE_SECTION_END = "<!-- YIW:DATASOURCES:END -->";
const MAX_DATA_SOURCE_LINES = 12;

export function isAskDataProjectWorkspaceId(projectId) {
  const id = String(projectId || "").trim();
  return !!id && id !== "__chat__" && !id.startsWith("folder:");
}

function cleanLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function projectLabel(project, projectId) {
  return cleanLine(project?.name || project?.project_name) || `项目 ${cleanLine(projectId) || "default"}`;
}

function shortText(value, max = 80) {
  const text = cleanLine(value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function compactType(value) {
  return cleanLine(value).replace(/_/g, " ").toUpperCase();
}

function sourceKindLabel(source) {
  if (source?.kind === "database") return compactType(source.db_type || "database");
  if (source?.kind === "file_dataset") return "文件数据集";
  if (source?.kind === "document_library") return "文档库";
  if (source?.kind === "web_search") return "Web 搜索";
  if (source?.kind === "mcp") return "MCP";
  return cleanLine(source?.kind) || "数据源";
}

function sourceCountDetails(source) {
  const details = [sourceKindLabel(source)].filter(Boolean);
  const tableCount = Number(source?.table_count || 0);
  const documentCount = Number(source?.document_count || 0);
  if (tableCount > 0) details.push(`${tableCount} 张表`);
  if (documentCount > 0) details.push(`${documentCount} 个文档`);
  if (source?.status) details.push(`状态 ${cleanLine(source.status)}`);
  if (source?.description) details.push(`说明 ${shortText(source.description)}`);
  return details.join(", ");
}

export function buildDataSourceOverviewMarkdown(dataSources = []) {
  const sources = Array.isArray(dataSources) ? dataSources : [];
  const visible = sources.slice(0, MAX_DATA_SOURCE_LINES);
  const lines = visible.length
    ? visible.map((source) => `- ${cleanLine(source?.name) || "未命名数据源"}: ${sourceCountDetails(source)}`)
    : ["- 当前尚未接入数据源。"];
  if (sources.length > visible.length) {
    lines.push(`- 其余 ${sources.length - visible.length} 个数据源已省略;需要时通过问数服务实时召回。`);
  }
  return `${DATA_SOURCE_SECTION_START}
## 已接入数据源概览

${lines.join("\n")}

说明: 这里只是轻量概览,不包含完整表结构、字段、样例值或连接密钥;具体查询以问数服务实时召回为准。
${DATA_SOURCE_SECTION_END}`;
}

function upsertDataSourceOverview(content, dataSources) {
  const section = buildDataSourceOverviewMarkdown(dataSources);
  const start = content.indexOf(DATA_SOURCE_SECTION_START);
  const end = content.indexOf(DATA_SOURCE_SECTION_END);
  if (start >= 0 && end > start) {
    return `${content.slice(0, start).trimEnd()}\n\n${section}\n${content.slice(end + DATA_SOURCE_SECTION_END.length).trimStart()}`;
  }
  return `${content.trimEnd()}\n\n${section}\n`;
}

export function buildProjectAgentsMarkdown({ projectId, project, dataSources } = {}) {
  const name = projectLabel(project, projectId);
  const description = cleanLine(project?.description || project?.project_description);
  const descLine = description ? `\n项目描述: ${description}\n` : "";
  const dataSourceSection = Array.isArray(dataSources) ? `\n${buildDataSourceOverviewMarkdown(dataSources)}\n` : "";

  return `# ${name} 问数项目工作区

这是 YiW 的问数项目工作区,不是项目数据源本身。${descLine}
本目录用于保存上传文件、生成脚本、中间产物、导出结果和项目相关说明。

## Agent 行为

- 用户询问项目数据、数据源、表结构、字段、统计、图表、SQL、记录明细时,必须调用 query_project_data,不要猜测真实配置或数据。
- 不要把本地工作区文件列表当作项目已接入的数据源。
- 只有用户明确要求查看本目录、处理本地文件、生成脚本、保存结果或管理项目文件时,才使用 read / ls / grep / find / write / edit / bash。
- 数据接入、导入文件、连接数据库、同步 schema 或准备数据时,使用产品工具和 data_onboarding 工作流。
- 回答时优先说明当前工作区边界:项目数据来自 YiW 已接入的数据源,本目录只是项目文件工作区。
${dataSourceSection}

## 可编辑说明

你可以手动修改本文件,补充项目口径、常用指标、数据源说明或团队约定。agent 会在项目 chat 流程中读取这些说明。
`;
}

export function ensureProjectWorkspaceContext({ cwd, projectId, project, dataSources } = {}) {
  if (!cwd || !isAskDataProjectWorkspaceId(projectId)) return null;
  try {
    mkdirSync(cwd, { recursive: true });
    const filePath = join(cwd, WORKSPACE_AGENTS_FILE);
    if (!existsSync(filePath)) {
      writeFileSync(filePath, buildProjectAgentsMarkdown({ projectId, project, dataSources }), "utf8");
    } else if (Array.isArray(dataSources)) {
      const current = readFileSync(filePath, "utf8");
      const next = upsertDataSourceOverview(current, dataSources);
      if (next !== current) writeFileSync(filePath, next, "utf8");
    }
    return filePath;
  } catch (e) {
    console.error("[workspace_context ensure]", e?.message || e);
    return null;
  }
}

function loadContextFileFromDir(cwd) {
  for (const filename of CONTEXT_FILE_CANDIDATES) {
    const filePath = join(cwd, filename);
    if (!existsSync(filePath)) continue;
    try {
      const raw = readFileSync(filePath, "utf8");
      const truncated = raw.length > MAX_CONTEXT_CHARS;
      const content = truncated ? `${raw.slice(0, MAX_CONTEXT_CHARS)}\n\n[内容过长,已截断]` : raw;
      return { path: filePath, content };
    } catch (e) {
      console.error("[workspace_context read]", e?.message || e);
    }
  }
  return null;
}

export function loadWorkspaceAgentsPrompt({ cwd } = {}) {
  if (!cwd) return "";
  const contextFile = loadContextFileFromDir(cwd);
  if (!contextFile) return "";
  return `\n\n<project_context>\nProject-specific instructions from workspace file:\n\n<project_instructions path="${contextFile.path}">\n${contextFile.content}\n</project_instructions>\n</project_context>`;
}

async function safeQuery(db, sql, params = []) {
  if (typeof db?.query !== "function") return [];
  return db.query(sql, params).catch(() => []);
}

function idsForType(assocs, sourceType) {
  return assocs
    .filter((row) => row?.source_type === sourceType)
    .map((row) => String(row.source_id || row.raw_source_id || "").trim())
    .filter(Boolean);
}

export async function loadProjectDataSourceOverview(db, projectId) {
  if (!isAskDataProjectWorkspaceId(projectId)) return null;
  const assocs = await safeQuery(
    db,
    `SELECT source_type, source_id
       FROM business_data_sources
      WHERE project_id=$1 AND deleted_at IS NULL
      ORDER BY created_at DESC`,
    [projectId],
  );
  const out = [];

  const databaseIds = idsForType(assocs, "database_connection");
  if (databaseIds.length) {
    const rows = await safeQuery(
      db,
      `SELECT c.id, c.name, c.db_type, c.description, COUNT(t.id)::int AS table_count
         FROM database_connections c
         LEFT JOIN table_metadata t ON t.database_connection_id=c.id AND t.deleted_at IS NULL
        WHERE c.id::text = ANY($1::text[]) AND c.deleted_at IS NULL
        GROUP BY c.id, c.name, c.db_type, c.description, c.created_at
        ORDER BY c.created_at DESC`,
      [databaseIds],
    );
    for (const row of rows) {
      out.push({
        id: row.id,
        name: row.name,
        kind: "database",
        db_type: row.db_type,
        description: row.description,
        table_count: Number(row.table_count || 0),
      });
    }
  }

  const fileDatasetIds = idsForType(assocs, "structured_data_source");
  if (fileDatasetIds.length) {
    const rows = await safeQuery(
      db,
      `SELECT s.id, s.name, s.description, s.is_active,
              COUNT(DISTINCT t.id)::int AS table_count,
              COUNT(DISTINCT d.id)::int AS document_count
         FROM structured_data_sources s
         LEFT JOIN table_metadata t ON t.database_connection_id=s.database_connection_id AND t.deleted_at IS NULL
         LEFT JOIN structured_documents d ON d.structured_data_source_id=s.id AND d.deleted_at IS NULL
        WHERE s.id::text = ANY($1::text[]) AND s.deleted_at IS NULL
        GROUP BY s.id, s.name, s.description, s.is_active, s.created_at
        ORDER BY s.created_at DESC`,
      [fileDatasetIds],
    );
    for (const row of rows) {
      out.push({
        id: row.id,
        name: row.name,
        kind: "file_dataset",
        description: row.description,
        table_count: Number(row.table_count || 0),
        document_count: Number(row.document_count || 0),
        status: row.is_active === false ? "停用" : "",
      });
    }
  }

  const documentLibraryIds = idsForType(assocs, "unstructured_data_source");
  if (documentLibraryIds.length) {
    const rows = await safeQuery(
      db,
      `SELECT u.id, u.name, u.description, u.is_active,
              COUNT(d.id)::int AS document_count
         FROM unstructured_data_sources u
         LEFT JOIN unstructured_documents d ON d.unstructured_data_source_id=u.id AND d.deleted_at IS NULL
        WHERE u.id::text = ANY($1::text[]) AND u.deleted_at IS NULL
        GROUP BY u.id, u.name, u.description, u.is_active, u.created_at
        ORDER BY u.created_at DESC`,
      [documentLibraryIds],
    );
    for (const row of rows) {
      out.push({
        id: row.id,
        name: row.name,
        kind: "document_library",
        description: row.description,
        document_count: Number(row.document_count || 0),
        status: row.is_active === false ? "停用" : "",
      });
    }
  }

  const webSearchIds = idsForType(assocs, "web_search_model");
  if (webSearchIds.length) {
    const rows = await safeQuery(
      db,
      `SELECT id, name, api, model, description
         FROM web_search_models
        WHERE id::text = ANY($1::text[]) AND deleted_at IS NULL
        ORDER BY created_at DESC`,
      [webSearchIds],
    );
    for (const row of rows) {
      out.push({
        id: row.id,
        name: row.name,
        kind: "web_search",
        description: row.description,
        status: row.api || row.model || "",
      });
    }
  }

  const mcpIds = idsForType(assocs, "mcp_data_source");
  if (mcpIds.length) {
    const rows = await safeQuery(
      db,
      `SELECT id, name, description, is_active
         FROM mcp_data_sources
        WHERE id::text = ANY($1::text[]) AND deleted_at IS NULL
        ORDER BY created_at DESC`,
      [mcpIds],
    );
    for (const row of rows) {
      out.push({
        id: row.id,
        name: row.name,
        kind: "mcp",
        description: row.description,
        status: row.is_active === false ? "停用" : "",
      });
    }
  }

  return out;
}
