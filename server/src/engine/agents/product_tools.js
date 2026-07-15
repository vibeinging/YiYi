import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { PRODUCT_TOOL_CATALOG } from "./product_tool_catalog.js";
import {
  boundedCapabilityResult,
  buildCapabilityCatalog,
  describeCapability,
  findCapability,
  resolveCapabilityProjectScope,
  searchCapabilities,
  validateCapabilityInput,
} from "./capability_bridge.js";
import { claimCapabilityInvocation, completeCapabilityInvocation, failCapabilityInvocation } from "./capability_idempotency.js";
import { hasExplicitProjectCreateRequest, hasExplicitProjectSessionMoveRequest } from "./product_tool_intent.js";
import { listProjects, getProject, createProject } from "../../app/projects/index.js";
import { moveSession } from "../../app/session/index.js";
import { createStructuredDatasource, createUnstructuredDatasource } from "../../app/datasource/datasources.js";
import { uploadDbFile, createDatabase, syncSchema } from "../../app/datasource/connections.js";
import { batchSyncExampleValues, storeVectors } from "../../app/datasource/tables.js";
import { createStructuredDocuments, processStructuredDocuments, listStructuredDocuments } from "../../app/docs/structured.js";
import { createDocument, listDocuments } from "../../app/docs/unstructured.js";
import { getBackgroundJob } from "../jobs/background_jobs.js";
import { listDatabases, listTables, listColumns } from "../../app/reads/reads_datasource.js";
import { DatabaseDataSource } from "../datasources/database_data_source.js";
import {
  createAppSkill,
  deleteAppSkill,
  listAppSkills,
  listPiSkills,
  setAppSkillEnabled,
  setPiSkillEnabled,
  updateAppSkill,
} from "./pi_skill_registry.js";
import {
  createAppMcpProvider,
  deleteAppMcpProvider,
  deleteMcpProvider,
  listAppMcpProviders,
  listProjectMcpProviders,
  rediscoverAppMcpProvider,
  testAppMcpProvider,
  toggleAppMcpProvider,
  updateAppMcpProvider,
  updateMcpProvider,
} from "../../app/integrations/mcp.js";

const DB_EXTS = new Set([".db", ".sqlite", ".sqlite3", ".duckdb"]);
const STRUCTURED_EXTS = new Set([".csv", ".tsv", ".xlsx", ".xls", ".json", ".jsonl", ".ndjson", ".parquet", ".pq"]);
const UNSTRUCTURED_EXTS = new Set([".md", ".markdown", ".txt", ".pdf", ".docx", ".doc", ".html", ".htm"]);
const MAX_SCAN_FILES = 500;
let capabilityCatalogPromise = null;

async function capabilityCatalog() {
  if (!capabilityCatalogPromise) {
    capabilityCatalogPromise = import("../../transport/registry.js")
      .then(({ ROUTES }) => buildCapabilityCatalog(ROUTES));
  }
  return capabilityCatalogPromise;
}

function toolResult(data) {
  const text = JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }], details: data };
}

function errorResult(message, extra = {}) {
  return toolResult({ success: false, error: String(message || "工具执行失败"), ...extra });
}

function makeCtx(agentContext) {
  const db = agentContext?.db || {};
  return {
    query: db.query,
    queryOne: db.queryOne,
    userId: agentContext?.user_id || "",
    signal: agentContext?.signal,
  };
}

function projectId(agentContext, params = {}) {
  const explicit = String(params?.project_id || "").trim();
  if (explicit) return explicit;
  const current = String(agentContext?.project_id || "");
  if (current && current !== "__chat__" && !current.startsWith("folder:")) return current;
  return "";
}

function input(params = {}, { pid = "" } = {}) {
  return {
    params: { ...(pid ? { pid } : {}), ...(params.params || {}) },
    body: params.body || {},
    query: params.query || {},
  };
}

function normalizePaths(value) {
  const normalize = (item) => {
    const text = String(item || "").trim();
    if (!text) return "";
    if (text === "~") return homedir();
    if (text.startsWith("~/")) return join(homedir(), text.slice(2));
    return text;
  };
  if (Array.isArray(value)) return value.map(normalize).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [normalize(value)];
  return [];
}

function walkPath(p, recursive, out) {
  if (out.length >= MAX_SCAN_FILES) return;
  if (!existsSync(p)) {
    out.push({ path: p, exists: false, kind: "missing", ext: extname(p).toLowerCase() });
    return;
  }
  const st = statSync(p);
  if (st.isDirectory()) {
    if (!recursive) {
      out.push({ path: p, exists: true, kind: "directory", ext: "" });
      return;
    }
    for (const name of readdirSync(p)) {
      if (out.length >= MAX_SCAN_FILES) break;
      if (name.startsWith(".")) continue;
      walkPath(join(p, name), recursive, out);
    }
    return;
  }
  if (st.isFile()) {
    out.push({ path: p, exists: true, kind: "file", ext: extname(p).toLowerCase(), size: st.size, name: basename(p) });
  }
}

function classifyFiles(paths, recursive = false) {
  const files = [];
  for (const p of paths) walkPath(p, recursive, files);
  const groups = {
    database_files: [],
    structured_files: [],
    unstructured_docs: [],
    unsupported: [],
    missing: [],
    directories: [],
  };
  for (const f of files) {
    if (!f.exists) groups.missing.push(f);
    else if (f.kind === "directory") groups.directories.push(f);
    else if (DB_EXTS.has(f.ext)) groups.database_files.push(f);
    else if (STRUCTURED_EXTS.has(f.ext)) groups.structured_files.push(f);
    else if (UNSTRUCTURED_EXTS.has(f.ext)) groups.unstructured_docs.push(f);
    else groups.unsupported.push(f);
  }
  return { files, groups };
}

function dbTypeForPath(filePath) {
  const ext = extname(String(filePath || "")).toLowerCase();
  if (ext === ".duckdb") return "DuckDB";
  if (DB_EXTS.has(ext)) return "SQLite";
  return "";
}

async function safeCall(fn, fallback = null) {
  try {
    return await fn();
  } catch (e) {
    return fallback ?? { warning: e?.message || String(e) };
  }
}

async function tableSummary(ctx, pid, connId) {
  const tablesResp = await listTables(ctx, input({ params: { cid: connId } }, { pid }));
  const tables = tablesResp?.data?.items || [];
  let columnCount = 0;
  for (const t of tables.slice(0, 50)) {
    const cols = await safeCall(() => listColumns(ctx, input({ params: { cid: connId, tid: t.id } }, { pid })), { data: { items: [] } });
    columnCount += Number(cols?.data?.items?.length || 0);
  }
  return {
    tables: tables.map((t) => ({ id: t.id, name: t.table_name || t.name, schema: t.schema_name, row_count: t.row_count })).slice(0, 100),
    table_count: tables.length,
    column_count: columnCount,
  };
}

async function projectListTool(agentContext, params = {}) {
  const ctx = makeCtx(agentContext);
  const r = await listProjects(ctx, { query: { search: params.search || "" }, body: {}, params: {} });
  return toolResult({ success: true, ...r.data });
}

async function projectDetailTool(agentContext, params = {}) {
  const ctx = makeCtx(agentContext);
  const rawId = String(params.project_id || params.id || "").trim();
  const name = String(params.name || params.project_name || "").trim();
  const fallbackId = projectId(agentContext, params);
  const id = rawId || (!name ? fallbackId : "");
  if (id) {
    const r = await getProject(ctx, { params: { id }, query: {}, body: {} });
    return toolResult({ success: true, project: r.data, project_id: r.data?.id || r.data?.project_id });
  }
  if (!name) return errorResult("project_id/id 或 name 为必填项;也可以在项目会话中省略以查看当前项目。");
  const listed = await listProjects(ctx, { query: { search: name }, body: {}, params: {} });
  const items = listed?.data?.items || [];
  const exact = items.filter((item) => String(item.name || item.project_name || "") === name);
  const matches = exact.length ? exact : items;
  if (matches.length === 1) {
    const foundId = matches[0].id || matches[0].project_id;
    const r = await getProject(ctx, { params: { id: foundId }, query: {}, body: {} });
    return toolResult({ success: true, project: r.data, project_id: r.data?.id || r.data?.project_id });
  }
  if (!matches.length) return errorResult(`没有找到名为 ${name} 的项目。`, { candidates: [] });
  return errorResult(`找到多个匹配 ${name} 的项目,请提供 project_id。`, {
    candidates: matches.map((item) => ({ id: item.id || item.project_id, name: item.name || item.project_name })),
  });
}

async function projectCreateTool(agentContext, params = {}) {
  const name = String(params.name || "").trim();
  if (!name) return errorResult("name 为必填项");
  if (!hasExplicitProjectCreateRequest(agentContext)) {
    return errorResult("只有用户在本轮消息中明确要求创建、新建、重建、转成或升级为智能问数项目/工作区时,才能创建项目。请先询问用户,并让用户明确回复要创建智能问数项目。", {
      code: "PROJECT_CREATE_REQUIRES_EXPLICIT_USER_REQUEST",
    });
  }
  const ctx = makeCtx(agentContext);
  const r = await createProject(ctx, { body: { name, description: params.description || "" }, params: {}, query: {} });
  return toolResult({ success: true, project: r.data, project_id: r.data?.id || r.data?.project_id });
}

async function projectSessionMoveTool(agentContext, params = {}) {
  const sid = String(params.session_id || agentContext?.session_id || agentContext?.input_data?.session_id || "").trim();
  if (!sid) return errorResult("缺少 session_id。只有已有会话才能迁移到问数项目。");
  if (!hasExplicitProjectSessionMoveRequest(agentContext)) {
    return errorResult("只有用户本轮明确要求把当前会话迁移、移动或转到已有、现有、指定或具名问数项目/工作区时,才能调用 project_session_move。泛泛说转到智能问数应创建新项目;普通文件分析、发票统计、导入或确认卡都不能自动迁移当前对话。", {
      code: "PROJECT_SESSION_MOVE_REQUIRES_EXPLICIT_USER_REQUEST",
    });
  }
  const fromProjectId = String(params.from_project_id || agentContext?.project_id || "").trim();
  if (!fromProjectId) return errorResult("缺少当前工作区 ID,无法迁移会话。");
  const targetProjectId = String(params.target_project_id || params.project_id || "").trim();
  if (!targetProjectId) return errorResult("target_project_id 为必填项");
  const ctx = makeCtx(agentContext);
  const r = await moveSession(ctx, {
    params: { pid: fromProjectId, sid },
    body: { target_project_id: targetProjectId },
  });
  return toolResult({
    success: true,
    project_id: targetProjectId,
    target_project_id: targetProjectId,
    from_project_id: fromProjectId,
    session_id: sid,
    migrated: r?.data?.migrated !== false,
    session: r?.data?.session || null,
    workspace: r?.data?.workspace || null,
  });
}

async function fileClassifyTool(_agentContext, params = {}) {
  const paths = normalizePaths(params.paths || params.path);
  if (!paths.length) return errorResult("paths 不能为空");
  const recursive = params.recursive !== false;
  const { files, groups } = classifyFiles(paths, recursive);
  return toolResult({
    success: true,
    scanned_count: files.length,
    truncated: files.length >= MAX_SCAN_FILES,
    groups,
  });
}

async function structuredImportTool(agentContext, params = {}) {
  const pid = projectId(agentContext, params);
  if (!pid) return errorResult("缺少 project_id。请先创建或选择问数项目。");
  const paths = normalizePaths(params.file_paths || params.paths || params.path);
  if (!paths.length) return errorResult("file_paths 不能为空");
  const ctx = makeCtx(agentContext);
  const dsName = String(params.data_source_name || params.name || `structured-${Date.now()}`).trim();
  const ds = await createStructuredDatasource(ctx, input({ body: { name: dsName, description: params.description || "" } }, { pid }));
  const dsid = ds?.data?.id;
  const created = await createStructuredDocuments(ctx, input({ body: { data_source_id: dsid, file_paths: paths } }, { pid }));
  const documentIds = (created?.data?.created_documents || []).map((d) => d.document_id).filter(Boolean);
  const processed = await processStructuredDocuments(
    ctx,
    input({ body: {
      data_source_id: dsid,
      ...(documentIds.length ? { document_ids: documentIds } : {}),
      session_id: agentContext?.session_id || agentContext?.input_data?.session_id || null,
    } }, { pid }),
  );
  const connId = processed?.data?.database_connection_id;
  const docs = await safeCall(
    () => listStructuredDocuments(ctx, { params: { pid }, query: { data_source_id: dsid }, body: {} }),
    { data: { items: [] } },
  );
  const summary = connId ? await tableSummary(ctx, pid, connId) : {};
  return toolResult({
    success: true,
    project_id: pid,
    data_source_id: dsid,
    connection_id: connId,
    processed: processed?.data?.processed || [],
    jobs: processed?.data?.job ? [processed.data.job] : [],
    documents: docs?.data?.items || [],
    ...summary,
  });
}

async function databaseFileImportTool(agentContext, params = {}) {
  const pid = projectId(agentContext, params);
  if (!pid) return errorResult("缺少 project_id。请先创建或选择问数项目。");
  const filePath = String(params.file_path || params.path || "").trim();
  if (!filePath) return errorResult("file_path 为必填项");
  const dbType = params.db_type || dbTypeForPath(filePath);
  if (!dbType) return errorResult("无法从文件扩展名识别数据库类型,仅支持 SQLite/DuckDB 文件");
  const ctx = makeCtx(agentContext);
  const uploaded = await uploadDbFile(ctx, input({ body: { file_path: filePath } }, { pid }));
  const databasePath = uploaded?.data?.path || filePath;
  const stem = String(params.name || basename(filePath).replace(/\.[^.]+$/, "") || `db-${Date.now()}`);
  const conn = await createDatabase(
    ctx,
    input({
      body: {
        name: stem,
        db_type: dbType,
        host: databasePath,
        database: databasePath,
        description: params.description || `AI 导入数据库文件 ${basename(filePath)}`,
      },
    }, { pid }),
  );
  const connId = conn?.data?.id;
  const synced = await syncSchema(ctx, input({
    params: { cid: connId },
    body: { session_id: agentContext?.session_id || agentContext?.input_data?.session_id || null },
  }, { pid }));
  const warnings = [];
  const jobs = synced?.data?.job ? [synced.data.job] : [];
  const summary = await tableSummary(ctx, pid, connId);
  const tableIds = summary.tables.map((t) => t.id).filter(Boolean);
  if (params.enrich === true && tableIds.length) {
    const samples = await safeCall(() => batchSyncExampleValues(ctx, input({ params: { cid: connId }, body: { table_ids: tableIds, limit: 3 } }, { pid })));
    if (samples?.warning) warnings.push(samples.warning);
    const vectors = await safeCall(() => storeVectors(ctx, input({
      params: { cid: connId },
      body: {
        table_ids: tableIds,
        only_pending: false,
        session_id: agentContext?.session_id || agentContext?.input_data?.session_id || null,
      },
    }, { pid })));
    if (vectors?.warning) warnings.push(vectors.warning);
    if (vectors?.data?.job) jobs.push(vectors.data.job);
  }
  return toolResult({
    success: true,
    project_id: pid,
    connection_id: connId,
    database: conn?.data,
    sync: synced?.data,
    jobs,
    warnings,
    ...summary,
  });
}

async function unstructuredImportTool(agentContext, params = {}) {
  const pid = projectId(agentContext, params);
  if (!pid) return errorResult("缺少 project_id。请先创建或选择问数项目。");
  const paths = normalizePaths(params.file_paths || params.paths || params.path);
  if (!paths.length) return errorResult("file_paths 不能为空");
  const ctx = makeCtx(agentContext);
  const dsName = String(params.data_source_name || params.name || `docs-${Date.now()}`).trim();
  const ds = await createUnstructuredDatasource(ctx, input({ body: { name: dsName, description: params.description || "" } }, { pid }));
  const dsid = ds?.data?.id;
  const documents = [];
  const jobs = [];
  for (const filePath of paths) {
    const created = await createDocument(ctx, input({
      params: { dsid },
      body: { file_path: filePath, session_id: agentContext?.session_id || agentContext?.input_data?.session_id || null },
    }, { pid }));
    if (created?.data?.document) documents.push(created.data.document);
    if (created?.data?.job) jobs.push(created.data.job);
  }
  const status = await safeCall(
    () => listDocuments(ctx, { params: { pid, dsid }, body: {}, query: {} }),
    { data: { items: [] } },
  );
  return toolResult({
    success: true,
    project_id: pid,
    data_source_id: dsid,
    submitted_count: documents.length,
    documents: status?.data?.items || documents,
    jobs,
    status: "processing",
  });
}

async function jobStatusTool(agentContext, params = {}) {
  const pid = projectId(agentContext, params);
  if (!pid) return errorResult("缺少 project_id");
  const ctx = makeCtx(agentContext);
  if (params.job_id) {
    const job = getBackgroundJob(String(params.job_id));
    if (!job || (pid && job.project_id !== pid)) return errorResult("后台任务不存在或不属于当前项目");
    return toolResult({ success: true, project_id: job.project_id, kind: job.kind, ...job });
  }
  const kind = String(params.kind || "").toLowerCase();
  if (params.connection_id || kind === "database") {
    const connId = params.connection_id || params.conn_id;
    if (!connId) return errorResult("connection_id 不能为空");
    const summary = await tableSummary(ctx, pid, connId);
    return toolResult({ success: true, project_id: pid, kind: "database", connection_id: connId, status: summary.table_count ? "completed" : "processing", ...summary });
  }
  if (params.structured_data_source_id || kind === "structured") {
    const dsid = params.structured_data_source_id || params.data_source_id;
    const docs = await listStructuredDocuments(ctx, { params: { pid }, query: { data_source_id: dsid }, body: {} });
    const items = docs?.data?.items || [];
    const failed = items.filter((d) => /failed/i.test(d.status || ""));
    const completed = items.filter((d) => /completed|done|ready/i.test(d.status || ""));
    return toolResult({ success: true, project_id: pid, kind: "structured", data_source_id: dsid, status: failed.length ? "failed" : completed.length === items.length ? "completed" : "processing", documents: items });
  }
  if (params.unstructured_data_source_id || kind === "unstructured") {
    const dsid = params.unstructured_data_source_id || params.data_source_id;
    const docs = await listDocuments(ctx, { params: { pid, dsid }, query: {}, body: {} });
    const items = docs?.data?.items || [];
    const parseFailed = items.filter((d) => String(d.status || "").toLowerCase() === "failed");
    const embeddingFailed = items.filter((d) => /embedding_(?:failed|partial)/i.test(d.status || "") || (d.status === "completed" && d.embedding_status !== "completed"));
    const ready = items.filter((d) => d.status === "completed" && d.embedding_status === "completed");
    const status = parseFailed.length
      ? "failed"
      : embeddingFailed.length
        ? "needs_embedding"
        : items.length > 0 && ready.length === items.length
          ? "completed"
          : "processing";
    return toolResult({
      success: true,
      project_id: pid,
      kind: "unstructured",
      data_source_id: dsid,
      status,
      total_count: items.length,
      ready_count: ready.length,
      embedding_pending_count: embeddingFailed.length,
      failed_count: parseFailed.length,
      message: status === "needs_embedding"
        ? "文档解析已完成,但向量尚未全部生成。请配置可用的嵌入模型后重试向量生成。"
        : status === "processing"
          ? "后台仍在解析和生成向量,无需在当前对话中持续等待。"
          : undefined,
      documents: items,
    });
  }
  const dbs = await listDatabases(ctx, { params: { pid }, query: {}, body: {} });
  return toolResult({ success: true, project_id: pid, kind: "project", databases: dbs?.data?.items || [] });
}

async function querySmokeTestTool(agentContext, params = {}) {
  const pid = projectId(agentContext, params);
  const connId = String(params.connection_id || params.conn_id || "").trim();
  if (!pid || !connId) return errorResult("project_id 和 connection_id 为必填项");
  const ctx = makeCtx(agentContext);
  const summary = await tableSummary(ctx, pid, connId);
  const first = summary.tables[0];
  if (!first?.name) return errorResult("没有可测试的表", { project_id: pid, connection_id: connId });
  const ds = new DatabaseDataSource(null, pid, connId);
  const schemaPrefix = first.schema && !["default", "main"].includes(String(first.schema)) ? `"${String(first.schema).replace(/"/g, '""')}".` : "";
  const tableSql = `${schemaPrefix}"${String(first.name).replace(/"/g, '""')}"`;
  const result = await ds.query(`SELECT COUNT(*) AS row_count FROM ${tableSql}`);
  return toolResult({
    success: !!result?.success,
    project_id: pid,
    connection_id: connId,
    table: first.name,
    query: `SELECT COUNT(*) AS row_count FROM ${tableSql}`,
    result: result?.to_dict ? result.to_dict() : result,
  });
}

async function skillListTool(agentContext) {
  const ctx = makeCtx(agentContext);
  const skills = await listAppSkills(ctx);
  return toolResult({ success: true, skills });
}

async function skillCreateTool(agentContext, params = {}) {
  const ctx = makeCtx(agentContext);
  const skill = await createAppSkill(ctx, params, agentContext?.user_id || "");
  return toolResult({ success: true, skill });
}

async function skillUpdateTool(agentContext, params = {}) {
  const name = String(params.name || params.skill_name || "").trim();
  if (!name) return errorResult("name 为必填项");
  const ctx = makeCtx(agentContext);
  const skill = await updateAppSkill(ctx, name, params, agentContext?.user_id || "");
  return toolResult({ success: true, skill });
}

async function skillToggleTool(agentContext, params = {}) {
  const name = String(params.name || params.skill_name || "").trim();
  if (!name) return errorResult("name 为必填项");
  const patch = {};
  if (typeof params.is_active === "boolean") patch.is_active = params.is_active;
  if (typeof params.default_enabled === "boolean") patch.default_enabled = params.default_enabled;
  if (typeof params.is_enabled === "boolean") patch.is_enabled = params.is_enabled;
  if (!Object.keys(patch).length) return errorResult("至少需要提供 is_active、default_enabled 或 is_enabled");
  const ctx = makeCtx(agentContext);
  const skill = await setAppSkillEnabled(ctx, name, patch, agentContext?.user_id || "");
  return toolResult({ success: true, skill });
}

async function skillDeleteTool(agentContext, params = {}) {
  const name = String(params.name || params.skill_name || "").trim();
  if (!name) return errorResult("name 为必填项");
  const ctx = makeCtx(agentContext);
  const result = await deleteAppSkill(ctx, name, agentContext?.user_id || "");
  return toolResult({ success: true, ...result });
}

async function projectSkillListTool(agentContext, params = {}) {
  const pid = projectId(agentContext, params);
  if (!pid) return errorResult("缺少 project_id。请先创建或选择问数项目。");
  const ctx = makeCtx(agentContext);
  const skills = await listPiSkills(ctx, pid);
  return toolResult({ success: true, project_id: pid, skills });
}

async function projectSkillSetTool(agentContext, params = {}, enabled) {
  const pid = projectId(agentContext, params);
  if (!pid) return errorResult("缺少 project_id。请先创建或选择问数项目。");
  const name = String(params.name || params.skill_name || "").trim();
  if (!name) return errorResult("name 为必填项");
  const ctx = makeCtx(agentContext);
  const skill = await setPiSkillEnabled(ctx, pid, name, enabled, agentContext?.user_id || "");
  return toolResult({ success: true, project_id: pid, skill });
}

async function mcpProviderListTool(agentContext) {
  const ctx = makeCtx(agentContext);
  const r = await listAppMcpProviders(ctx);
  return toolResult({ success: true, providers: r.data || [] });
}

async function mcpProviderCreateTool(agentContext, params = {}) {
  const ctx = makeCtx(agentContext);
  const r = await createAppMcpProvider(ctx, { params: {}, query: {}, body: params });
  return toolResult({ success: true, provider: r.data });
}

async function mcpProviderUpdateTool(agentContext, params = {}) {
  const name = String(params.name || params.provider_name || "").trim();
  if (!name) return errorResult("name/provider_name 为必填项");
  const ctx = makeCtx(agentContext);
  const r = await updateAppMcpProvider(ctx, { params: { providerName: name }, query: {}, body: params });
  return toolResult({ success: true, provider: r.data });
}

async function mcpProviderToggleTool(agentContext, params = {}) {
  const name = String(params.name || params.provider_name || "").trim();
  if (!name) return errorResult("name/provider_name 为必填项");
  const patch = {};
  if (typeof params.is_active === "boolean") patch.is_active = params.is_active;
  if (typeof params.default_enabled === "boolean") patch.default_enabled = params.default_enabled;
  if (typeof params.is_enabled === "boolean") patch.is_enabled = params.is_enabled;
  if (!Object.keys(patch).length) return errorResult("至少需要提供 is_active、default_enabled 或 is_enabled");
  const ctx = makeCtx(agentContext);
  const r = await toggleAppMcpProvider(ctx, { params: { providerName: name }, query: {}, body: patch });
  return toolResult({ success: true, provider: r.data });
}

async function mcpProviderDeleteTool(agentContext, params = {}) {
  const name = String(params.name || params.provider_name || "").trim();
  if (!name) return errorResult("name/provider_name 为必填项");
  const ctx = makeCtx(agentContext);
  const r = await deleteAppMcpProvider(ctx, { params: { providerName: name }, query: {}, body: {} });
  return toolResult({ success: true, ...r.data });
}

async function mcpProviderTestTool(agentContext, params = {}) {
  const ctx = makeCtx(agentContext);
  const r = await testAppMcpProvider(ctx, { params: {}, query: {}, body: params });
  return toolResult({ success: !!r.data?.ok, ...r.data });
}

async function mcpProviderRediscoverTool(agentContext, params = {}) {
  const name = String(params.name || params.provider_name || "").trim();
  if (!name) return errorResult("name/provider_name 为必填项");
  const ctx = makeCtx(agentContext);
  const r = await rediscoverAppMcpProvider(ctx, { params: { providerName: name }, query: {}, body: {} });
  return toolResult({ success: !!r.data?.ok, provider: r.data, tools: r.data?.tools || [], error: r.data?.error || "" });
}

async function projectMcpProviderListTool(agentContext, params = {}) {
  const pid = projectId(agentContext, params);
  if (!pid) return errorResult("缺少 project_id。请先创建或选择问数项目。");
  const ctx = makeCtx(agentContext);
  const r = await listProjectMcpProviders(ctx, { params: { pid }, query: {}, body: {} });
  return toolResult({ success: true, project_id: pid, providers: r.data || [] });
}

async function projectMcpProviderSetTool(agentContext, params = {}, enabled) {
  const pid = projectId(agentContext, params);
  if (!pid) return errorResult("缺少 project_id。请先创建或选择问数项目。");
  const name = String(params.name || params.provider_name || "").trim();
  if (!name) return errorResult("name/provider_name 为必填项");
  const ctx = makeCtx(agentContext);
  const r = await updateMcpProvider(ctx, {
    params: { pid, providerName: name },
    query: {},
    body: { enabled_override: enabled },
  });
  return toolResult({ success: true, project_id: pid, provider: r.data });
}

async function projectMcpProviderResetTool(agentContext, params = {}) {
  const pid = projectId(agentContext, params);
  if (!pid) return errorResult("缺少 project_id。请先创建或选择问数项目。");
  const name = String(params.name || params.provider_name || "").trim();
  if (!name) return errorResult("name/provider_name 为必填项");
  const ctx = makeCtx(agentContext);
  const r = await deleteMcpProvider(ctx, { params: { pid, providerName: name }, query: {}, body: {} });
  return toolResult({ success: true, project_id: pid, provider: r.data });
}

const PRODUCT_TOOL_HANDLERS = {
  capability_search: async (_agentContext, params = {}) => {
    const catalog = await capabilityCatalog();
    const capabilities = searchCapabilities(catalog, params);
    return toolResult({ success: true, count: capabilities.length, capabilities });
  },
  capability_describe: async (_agentContext, params = {}) => {
    const operationId = String(params.operation_id || "").trim();
    if (!operationId) return errorResult("operation_id 为必填项");
    const detail = describeCapability(await capabilityCatalog(), operationId);
    return detail ? toolResult({ success: true, capability: detail }) : errorResult(`未找到能力: ${operationId}`);
  },
  capability_invoke: async (agentContext, params = {}) => {
    const operationId = String(params.operation_id || "").trim();
    if (!operationId) return errorResult("operation_id 为必填项");
    const item = findCapability(await capabilityCatalog(), operationId);
    if (!item) return errorResult(`未找到能力: ${operationId}`);
    const ctx = makeCtx(agentContext);
    const scoped = resolveCapabilityProjectScope(item, params.params || {}, agentContext?.project_id);
    if (scoped.error) return errorResult(scoped.error, { code: "project_scope_violation" });
    const routeParams = scoped.params;
    if (scoped.needsMembershipCheck) {
      const member = await ctx.queryOne(
        `SELECT 1 AS allowed FROM project_members
          WHERE project_id=$1 AND user_id=$2 AND deleted_at IS NULL LIMIT 1`,
        [scoped.projectId, ctx.userId],
      ).catch(() => null);
      if (!member) return errorResult("项目不存在或无权限", { code: "project_access_denied" });
    }
    const missing = item.path_params.filter((name) => routeParams[name] == null || routeParams[name] === "");
    if (missing.length) return errorResult(`缺少路径参数: ${missing.join(", ")}`);
    const routeBody = params.body && typeof params.body === "object" ? { ...params.body } : {};
    if (!routeBody.session_id && item.safety !== 'read') {
      routeBody.session_id = agentContext?.session_id || agentContext?.input_data?.session_id || null;
    }
    const routeQuery = params.query && typeof params.query === "object" ? params.query : {};
    const validation = validateCapabilityInput(item, { params: routeParams, query: routeQuery, body: routeBody });
    if (!validation.valid) {
      return errorResult("能力参数不正确", {
        code: "invalid_capability_input",
        operation_id: operationId,
        schema_quality: validation.schemaQuality,
        corrections: validation.errors,
      });
    }
    const idempotencyKey = String(params.idempotency_key || "").trim();
    let idempotencyClaim = null;
    if (item.safety !== "read" && idempotencyKey) {
      idempotencyClaim = claimCapabilityInvocation({
        userId: ctx.userId,
        projectId: scoped.projectId || agentContext?.project_id || null,
        operationId,
        idempotencyKey,
        input: { params: routeParams, query: routeQuery, body: routeBody },
      });
      if (idempotencyClaim.state === "conflict") {
        return errorResult("同一 idempotency_key 不能用于不同参数", { code: "idempotency_conflict" });
      }
      if (idempotencyClaim.state === "in_progress") {
        return errorResult("相同操作正在处理中", { code: "idempotency_in_progress", retryable: true });
      }
      if (idempotencyClaim.state === "replay") {
        return toolResult({
          success: true,
          operation_id: operationId,
          safety: item.safety,
          long_running: item.long_running,
          idempotent_replay: true,
          result: boundedCapabilityResult(idempotencyClaim.result),
        });
      }
    }
    let result;
    try {
      result = await item.route.fn(ctx, {
        params: routeParams,
        query: routeQuery,
        body: routeBody,
        headers: idempotencyKey ? { "idempotency-key": idempotencyKey } : {},
      });
      if (idempotencyClaim?.id) completeCapabilityInvocation(idempotencyClaim.id, result);
    } catch (error) {
      if (idempotencyClaim?.id) failCapabilityInvocation(idempotencyClaim.id, error);
      throw error;
    }
    return toolResult({
      success: true,
      operation_id: operationId,
      safety: item.safety,
      long_running: item.long_running,
      result: boundedCapabilityResult(result),
    });
  },
  project_list: projectListTool,
  project_detail: projectDetailTool,
  create_smart_qa_project: projectCreateTool,
  project_create: projectCreateTool,
  project_session_move: projectSessionMoveTool,
  file_classify: fileClassifyTool,
  structured_import: structuredImportTool,
  database_file_import: databaseFileImportTool,
  unstructured_import: unstructuredImportTool,
  job_status: jobStatusTool,
  query_smoke_test: querySmokeTestTool,
  skill_list: skillListTool,
  skill_create: skillCreateTool,
  skill_update: skillUpdateTool,
  skill_toggle: skillToggleTool,
  skill_delete: skillDeleteTool,
  project_skill_list: projectSkillListTool,
  project_skill_enable: (agentContext, params) => projectSkillSetTool(agentContext, params, true),
  project_skill_disable: (agentContext, params) => projectSkillSetTool(agentContext, params, false),
  mcp_provider_list: mcpProviderListTool,
  mcp_provider_create: mcpProviderCreateTool,
  mcp_provider_update: mcpProviderUpdateTool,
  mcp_provider_toggle: mcpProviderToggleTool,
  mcp_provider_delete: mcpProviderDeleteTool,
  mcp_provider_test: mcpProviderTestTool,
  mcp_provider_rediscover: mcpProviderRediscoverTool,
  project_mcp_provider_list: projectMcpProviderListTool,
  project_mcp_provider_enable: (agentContext, params) => projectMcpProviderSetTool(agentContext, params, true),
  project_mcp_provider_disable: (agentContext, params) => projectMcpProviderSetTool(agentContext, params, false),
  project_mcp_provider_reset: projectMcpProviderResetTool,
};

const PARAMS = {
  capability_search: Type.Object({
    query: Type.String({ description: "要查找的 App 能力,使用简短自然语言" }),
    domain: Type.Optional(Type.String({ description: "可选能力域" })),
    safety: Type.Optional(Type.String({ description: "可选 read | write | delete | execute" })),
    limit: Type.Optional(Type.Number({ description: "返回数量,默认 8,最大 20" })),
  }),
  capability_describe: Type.Object({
    operation_id: Type.String({ description: "capability_search 返回的 operation_id" }),
  }),
  capability_invoke: Type.Object({
    operation_id: Type.String({ description: "capability_search 返回的 operation_id" }),
    params: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "路径参数" })),
    query: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "查询参数" })),
    body: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "请求体" })),
    idempotency_key: Type.Optional(Type.String({ description: "长任务或可重试写入的幂等键" })),
  }),
  project_list: Type.Object({
    search: Type.Optional(Type.String({ description: "按项目名称搜索(可选)" })),
  }),
  project_detail: Type.Object({
    project_id: Type.Optional(Type.String({ description: "项目 ID;省略且在项目会话中时默认当前项目" })),
    id: Type.Optional(Type.String({ description: "项目 ID,兼容字段" })),
    name: Type.Optional(Type.String({ description: "按项目名称唯一匹配" })),
    project_name: Type.Optional(Type.String({ description: "项目名称,兼容字段" })),
  }),
  project_create: Type.Object({
    name: Type.String({ description: "项目名称" }),
    description: Type.Optional(Type.String({ description: "项目描述" })),
  }),
  create_smart_qa_project: Type.Object({
    name: Type.String({ description: "智能问数项目名称" }),
    description: Type.Optional(Type.String({ description: "项目描述" })),
  }),
  project_session_move: Type.Object({
    target_project_id: Type.String({ description: "目标问数项目 ID" }),
    session_id: Type.Optional(Type.String({ description: "要迁移的会话 ID;默认当前会话" })),
    from_project_id: Type.Optional(Type.String({ description: "源工作区 ID;默认当前工作区" })),
  }),
  file_classify: Type.Object({
    paths: Type.Array(Type.String(), { description: "本地文件或目录路径列表" }),
    recursive: Type.Optional(Type.Boolean({ description: "目录是否递归扫描,默认 true" })),
  }),
  structured_import: Type.Object({
    project_id: Type.Optional(Type.String({ description: "目标项目 ID;在项目会话中可省略" })),
    file_paths: Type.Array(Type.String(), { description: "CSV/Excel/JSON/Parquet 文件路径" }),
    data_source_name: Type.Optional(Type.String({ description: "结构化数据源名称" })),
    description: Type.Optional(Type.String({ description: "数据源描述" })),
  }),
  database_file_import: Type.Object({
    project_id: Type.Optional(Type.String({ description: "目标项目 ID;在项目会话中可省略" })),
    file_path: Type.String({ description: "SQLite/DuckDB 本地文件路径" }),
    name: Type.Optional(Type.String({ description: "数据库连接名称" })),
    db_type: Type.Optional(Type.String({ description: "SQLite 或 DuckDB;省略时按扩展名识别" })),
    description: Type.Optional(Type.String({ description: "连接描述" })),
    enrich: Type.Optional(Type.Boolean({ description: "是否同步示例值并向量化;默认 false" })),
  }),
  unstructured_import: Type.Object({
    project_id: Type.Optional(Type.String({ description: "目标项目 ID;在项目会话中可省略" })),
    file_paths: Type.Array(Type.String(), { description: "Markdown/PDF/DOCX/TXT 等文档路径" }),
    data_source_name: Type.Optional(Type.String({ description: "非结构化数据源名称" })),
    description: Type.Optional(Type.String({ description: "数据源描述" })),
  }),
  job_status: Type.Object({
    project_id: Type.Optional(Type.String({ description: "目标项目 ID;在项目会话中可省略" })),
    kind: Type.Optional(Type.String({ description: "database | structured | unstructured | project" })),
    connection_id: Type.Optional(Type.String({ description: "数据库连接 ID" })),
    data_source_id: Type.Optional(Type.String({ description: "结构化或非结构化数据源 ID" })),
    structured_data_source_id: Type.Optional(Type.String({ description: "结构化数据源 ID" })),
    unstructured_data_source_id: Type.Optional(Type.String({ description: "非结构化数据源 ID" })),
    job_id: Type.Optional(Type.String({ description: "提交后台任务时返回的 job.id;优先按任务 ID 精确查询" })),
  }),
  query_smoke_test: Type.Object({
    project_id: Type.Optional(Type.String({ description: "目标项目 ID;在项目会话中可省略" })),
    connection_id: Type.String({ description: "数据库连接 ID" }),
  }),
  skill_list: Type.Object({}),
  skill_create: Type.Object({
    name: Type.String({ description: "Skill 名称" }),
    description: Type.String({ description: "Skill 描述" }),
    instructions: Type.String({ description: "Skill 指令 Markdown" }),
    category: Type.Optional(Type.String({ description: "分类" })),
    tags: Type.Optional(Type.Array(Type.String(), { description: "标签" })),
    allowed_tools: Type.Optional(Type.Array(Type.String(), { description: "允许调用的工具名" })),
    runtime: Type.Optional(Type.String({ description: "运行类型: prompt | service | workflow;默认 prompt" })),
    side_effect: Type.Optional(Type.String({ description: "副作用等级: read | write | execute;默认 read" })),
    requires_project: Type.Optional(Type.Boolean({ description: "是否必须在问数项目上下文中使用;默认 false" })),
    default_enabled: Type.Optional(Type.Boolean({ description: "App 默认启用状态;默认 true" })),
    is_active: Type.Optional(Type.Boolean({ description: "App 总开关;默认 true" })),
  }),
  skill_update: Type.Object({
    name: Type.String({ description: "Skill 名称" }),
    description: Type.Optional(Type.String({ description: "Skill 描述" })),
    instructions: Type.Optional(Type.String({ description: "Skill 指令 Markdown" })),
    category: Type.Optional(Type.String({ description: "分类" })),
    tags: Type.Optional(Type.Array(Type.String(), { description: "标签" })),
    allowed_tools: Type.Optional(Type.Array(Type.String(), { description: "允许调用的工具名" })),
    runtime: Type.Optional(Type.String({ description: "运行类型: prompt | service | workflow" })),
    side_effect: Type.Optional(Type.String({ description: "副作用等级: read | write | execute" })),
    requires_project: Type.Optional(Type.Boolean({ description: "是否必须在问数项目上下文中使用" })),
  }),
  skill_toggle: Type.Object({
    name: Type.String({ description: "Skill 名称" }),
    is_active: Type.Optional(Type.Boolean({ description: "App 总开关;false 时所有项目都不能执行" })),
    default_enabled: Type.Optional(Type.Boolean({ description: "App 默认启用状态;项目可覆盖" })),
    is_enabled: Type.Optional(Type.Boolean({ description: "兼容字段,等同 default_enabled" })),
  }),
  skill_delete: Type.Object({
    name: Type.String({ description: "Skill 名称" }),
  }),
  project_skill_list: Type.Object({
    project_id: Type.Optional(Type.String({ description: "目标项目 ID;在项目会话中可省略" })),
  }),
  project_skill_enable: Type.Object({
    project_id: Type.Optional(Type.String({ description: "目标项目 ID;在项目会话中可省略" })),
    name: Type.String({ description: "App Skill 名称" }),
  }),
  project_skill_disable: Type.Object({
    project_id: Type.Optional(Type.String({ description: "目标项目 ID;在项目会话中可省略" })),
    name: Type.String({ description: "App Skill 名称" }),
  }),
  mcp_provider_list: Type.Object({}),
  mcp_provider_create: Type.Object({
    provider_name: Type.String({ description: "MCP Provider 名称,只能包含小写字母、数字、下划线和中划线" }),
    transport: Type.Optional(Type.String({ description: "传输类型,当前仅支持 stdio" })),
    command: Type.String({ description: "启动 MCP server 的命令,例如 node、python、npx" }),
    args: Type.Optional(Type.Array(Type.String(), { description: "命令参数数组" })),
    env: Type.Optional(Type.Any({ description: "环境变量对象,key/value 都会按字符串写入" })),
    default_enabled: Type.Optional(Type.Boolean({ description: "App 默认启用状态;项目可覆盖;默认 true" })),
    is_active: Type.Optional(Type.Boolean({ description: "App 总开关;默认 true" })),
  }),
  mcp_provider_update: Type.Object({
    name: Type.String({ description: "MCP Provider 名称" }),
    command: Type.Optional(Type.String({ description: "启动 MCP server 的命令" })),
    args: Type.Optional(Type.Array(Type.String(), { description: "命令参数数组" })),
    env: Type.Optional(Type.Any({ description: "环境变量对象" })),
    transport: Type.Optional(Type.String({ description: "传输类型,当前仅支持 stdio" })),
    default_enabled: Type.Optional(Type.Boolean({ description: "App 默认启用状态;项目可覆盖" })),
    is_active: Type.Optional(Type.Boolean({ description: "App 总开关" })),
  }),
  mcp_provider_toggle: Type.Object({
    name: Type.String({ description: "MCP Provider 名称" }),
    is_active: Type.Optional(Type.Boolean({ description: "App 总开关;false 时所有项目都不能执行" })),
    default_enabled: Type.Optional(Type.Boolean({ description: "App 默认启用状态;项目可覆盖" })),
    is_enabled: Type.Optional(Type.Boolean({ description: "兼容字段,等同 default_enabled" })),
  }),
  mcp_provider_delete: Type.Object({
    name: Type.String({ description: "MCP Provider 名称" }),
  }),
  mcp_provider_test: Type.Object({
    provider_name: Type.Optional(Type.String({ description: "临时测试名称;可省略" })),
    transport: Type.Optional(Type.String({ description: "传输类型,当前仅支持 stdio" })),
    command: Type.String({ description: "启动 MCP server 的命令" }),
    args: Type.Optional(Type.Array(Type.String(), { description: "命令参数数组" })),
    env: Type.Optional(Type.Any({ description: "环境变量对象" })),
  }),
  mcp_provider_rediscover: Type.Object({
    name: Type.String({ description: "MCP Provider 名称" }),
  }),
  project_mcp_provider_list: Type.Object({
    project_id: Type.Optional(Type.String({ description: "目标项目 ID;在项目会话中可省略" })),
  }),
  project_mcp_provider_enable: Type.Object({
    project_id: Type.Optional(Type.String({ description: "目标项目 ID;在项目会话中可省略" })),
    name: Type.String({ description: "App MCP Provider 名称" }),
  }),
  project_mcp_provider_disable: Type.Object({
    project_id: Type.Optional(Type.String({ description: "目标项目 ID;在项目会话中可省略" })),
    name: Type.String({ description: "App MCP Provider 名称" }),
  }),
  project_mcp_provider_reset: Type.Object({
    project_id: Type.Optional(Type.String({ description: "目标项目 ID;在项目会话中可省略" })),
    name: Type.String({ description: "App MCP Provider 名称" }),
  }),
};

export function createProductTools(agentContext) {
  const hasDb = !!agentContext?.db?.query && !!agentContext?.db?.queryOne;
  if (!hasDb) return [];
  return PRODUCT_TOOL_CATALOG.map((def) => ({
    name: def.name,
    description: def.description,
    parameters: PARAMS[def.name] || Type.Object({}),
    execute: async (_toolCallId, params) => {
      const handler = PRODUCT_TOOL_HANDLERS[def.name];
      if (!handler) return errorResult(`工具未实现: ${def.name}`);
      try {
        return await handler(agentContext, params || {});
      } catch (e) {
        return errorResult(e?.message || String(e), { tool: def.name });
      }
    },
  }));
}
