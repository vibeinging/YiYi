/**
 * 本地 SQLite 数据库(桌面端:下载即用,内置库,无远程依赖)。
 *
 * 设计:对外保持与原 PG 版完全一致的接口(query/queryOne 返回 rows / row|null),
 * 内部用 better-sqlite3(原生同步,Electron 友好),并在 query 时做 **PG → SQLite 方言翻译**,
 * 使迁移过来的 65 个引擎文件 + 路由所写的 PG 方言 SQL 一个字都不用改:
 *   - `$1,$2…` 占位符 → 位置 `?`(数组参数自动展开)
 *   - `col::text = ANY($n::text[])` / `ANY($n)` → `col IN (?,?,…)`(空数组→永假)
 *   - `::text / ::jsonb / ::uuid …` 类型转换 → 剥除(SQLite 比较不需要)
 *   - `ILIKE` → `LIKE`(SQLite LIKE 对 ASCII 本就大小写不敏感)
 *   - `now()` / `gen_random_uuid()` → 注册为 SQLite 自定义函数(SQL 文本不动)
 *   - `->>` / `->` JSON 取值 → SQLite 3.38+ 原生兼容
 *   - `RETURNING` → SQLite 3.35+ 原生支持
 *
 * 库文件路径:env DB_SQLITE_PATH,默认 ~/.yiw/local.db。
 */
import Database from "better-sqlite3"; // 原生同步驱动,Electron 友好(prebuilds + loadExtension);替代 node:sqlite(实验内置,Electron 捆的 Node 未必有)
import { randomUUID } from "node:crypto";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { homedir, platform, arch } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_SQLITE_PATH || join(homedir(), ".yiw", "local.db");
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = OFF;"); // 迁移数据可能跨表先后插入,关闭外键约束更稳

// ── schema bootstrap:开机幂等自建表(下载即用,脱离远程 Vastbase)──
// 内置 DDL(db/schema.sql,55 表 CREATE TABLE IF NOT EXISTS)。空库自建、已有库无副作用。
// 重新生成 DDL:node scripts/gen_schema.mjs(从一份完整 local.db 导出)。
(function bootstrapSchema() {
  try {
    const schemaPath = process.env.DB_SCHEMA_PATH || join(__dir, "..", "db", "schema.sql");
    if (!existsSync(schemaPath)) {
      console.warn(`[db] 内置 schema.sql 不存在(${schemaPath}),跳过自建表(假定库已就绪)`);
      return;
    }
    db.exec(readFileSync(schemaPath, "utf8"));
    const n = db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().c;
    console.info(`[db] ✓ schema bootstrap:${n} 张表就绪`);
  } catch (e) {
    console.error(`[db] schema bootstrap 失败: ${e?.message ?? e}`);
  }
})();

// ── Stage 0(去业务层 · 数据层)── 给「只有 business_id」的语义表补 project_id 列,并从 businesses 回填。
// 后续阶段 service/engine 改成按 project_id 查;business_id 列暂留(末阶段再清)。
// 幂等:列已存在则跳过;回填只填 NULL 行。加列是纯增量,不破坏已有数据。
(function migrateAddProjectId() {
  const tables = [
    "business_data_sources",
    "business_entity_configs",
    "entity_mapping_configs",
    "entity_mappings",
    "examples",
    "metric_definitions",
    "metric_view_definitions",
  ];
  let added = 0;
  let filled = 0;
  for (const t of tables) {
    try {
      const cols = db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);
      if (!cols.includes("business_id")) continue; // 表不存在/结构异常,跳过
      if (!cols.includes("project_id")) {
        db.exec(`ALTER TABLE "${t}" ADD COLUMN "project_id" TEXT`);
        added++;
      }
      // businesses.id → businesses.project_id 回填(只填空,幂等)
      const before = db.prepare(`SELECT count(*) c FROM "${t}" WHERE project_id IS NULL AND business_id IS NOT NULL`).get().c;
      db.exec(
        `UPDATE "${t}" SET project_id = (SELECT b.project_id FROM businesses b WHERE b.id = "${t}".business_id)
          WHERE project_id IS NULL AND business_id IS NOT NULL`,
      );
      const after = db.prepare(`SELECT count(*) c FROM "${t}" WHERE project_id IS NULL AND business_id IS NOT NULL`).get().c;
      filled += before - after;
    } catch (e) {
      console.error(`[db] migrate project_id(${t})失败: ${e?.message ?? e}`);
    }
  }
  if (added || filled) console.info(`[db] ✓ Stage0 project_id 迁移:加列 ${added} 张,回填 ${filled} 行`);
})();

// ── Stage 1(去业务层 · 协议级)── sessions.source_type 从 'business' 迁到 'project'。
// 配合阶段 4 前端改动(createSession source_type 改 'project')。旧会话行批量更新,幂等。
// 桌面端 business 与 project 1:1,source_id 存的通常是 business_id(== project_id),
// 故顺带把 source_id 校正为 project_id(businesses 表 join),保证后续读取一致。
(function migrateSessionSourceType() {
  let updated = 0;
  try {
    // 仅迁移 source_type='business' 的旧行(新行已直接写 'project')
    const stale = db.prepare(`SELECT count(*) c FROM sessions WHERE source_type = 'business'`).get().c;
    if (stale > 0) {
      // 1) source_id 能在 businesses 表找到 → 用其 project_id 校正 source_id
      db.exec(
        `UPDATE sessions SET source_type = 'project',
           source_id = (SELECT b.project_id FROM businesses b WHERE b.id = sessions.source_id)
         WHERE source_type = 'business'
           AND source_id IN (SELECT id FROM businesses)`,
      );
      // 2) 兜底:source_id 不在 businesses 表(可能是 project_id 直存)→ 仅改 source_type
      db.exec(
        `UPDATE sessions SET source_type = 'project'
         WHERE source_type = 'business'`,
      );
      const remaining = db.prepare(`SELECT count(*) c FROM sessions WHERE source_type = 'business'`).get().c;
      updated = stale - remaining;
    }
  } catch (e) {
    console.error(`[db] migrate session source_type 失败: ${e?.message ?? e}`);
  }
  if (updated) console.info(`[db] ✓ Stage1 session source_type 迁移: ${updated} 行 business→project`);
})();

// ── Stage 2(去业务层 · schema 清理)── 删除语义表的 business_id 列。
// 破坏性:列删后不可回滚(需从备份恢复 local.db)。前置:Stage 0 回填 project_id 完成 + 所有读路径已切 project_id。
// 幂等:列不存在则跳过(SQLite ALTER DROP COLUMN 在列缺失时报错,故先 PRAGMA 检查)。
// 注:businesses / business_api_keys / business_publish_configs 表本身保留(阶段评估是否整体删表)。
(function migrateDropBusinessIdColumns() {
  const tables = [
    "business_data_sources",
    "business_entity_configs",
    "entity_mapping_configs",
    "entity_mappings",
    "examples",
    "metric_definitions",
    "metric_view_definitions",
    "agents",
    "generated_reports",
    "llm_call_logs",
    "metric_view_recommendation_tasks",
    "disambiguation_resolutions",
  ];
  let dropped = 0;
  for (const t of tables) {
    try {
      const cols = db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);
      if (!cols.includes("business_id")) continue; // 列已删/表不存在 → 跳过
      db.exec(`ALTER TABLE "${t}" DROP COLUMN "business_id"`);
      dropped++;
    } catch (e) {
      console.error(`[db] drop business_id(${t})失败(非致命,继续): ${e?.message ?? e}`);
    }
  }
  if (dropped) console.info(`[db] ✓ Stage2 删 business_id 列: ${dropped} 张表`);
})();

// ── Track D(问数工作区)── 运行态新表(全幂等 CREATE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS)。
// 放在代码里(而非 schema.sql)是因为 schema.sql 自动生成(gen_schema.mjs),代码迁移可跨重新生成存活。
// 设计见 docs/design/2026-06-23_track-d-sqlite-schema-draft.md。
//   analysis_plan_steps          = 持久化 task_plan 活文档(E4),一步一行 todo→doing→done。
//   session_intermediate_tables  = r_xxx 中间表 ↔ 会话薄索引(E3),detail 仍在各 session 的 DuckDB _intermediate_metadata。
// 注:不动 sessions / action_type —— 问数就是问数,引擎(SuperAgent↔pi)走 flag 不是会话属性。
//     子 agent / fork / 压缩 等会话级状态待 E5/fork 真落地时随功能加列;compact 已有实现且压缩点
//     表示成 session_messages 里的 compact 分割线消息(见 agent_chat.js /compact),不需要 sessions 列。
//     session_tool_calls / session_semantic_hits / 分组表 延后到 D3/D4 治理 / eval / 多任务真做时再建。
(function migrateTrackD() {
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS "analysis_plan_steps" ("session_id" TEXT, "message_id" TEXT, "step_index" INTEGER, "task_id" TEXT, "title" TEXT, "source_kind" TEXT, "source_name" TEXT, "depends_on" TEXT, "output_alias" TEXT, "status" TEXT, "intermediate_table" TEXT, "id" TEXT, "created_at" TEXT, "updated_at" TEXT, "deleted_at" TEXT, "deleted_by" TEXT, PRIMARY KEY ("id"))`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS "session_intermediate_tables" ("session_id" TEXT, "message_id" TEXT, "plan_step_id" TEXT, "table_name" TEXT, "duckdb_path" TEXT, "description" TEXT, "row_count" INTEGER, "column_count" INTEGER, "columns" TEXT, "schema_preview" TEXT, "sub_query" TEXT, "sql_query" TEXT, "id" TEXT, "created_at" TEXT, "updated_at" TEXT, "deleted_at" TEXT, "deleted_by" TEXT, PRIMARY KEY ("id"))`,
    );

    // 索引(schema.sql 不含索引,统一在此建;幂等)。partial index 走软删过滤,与查询口径一致。
    db.exec(`CREATE INDEX IF NOT EXISTS idx_plan_session_step ON "analysis_plan_steps"(session_id, step_index) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_inter_session ON "session_intermediate_tables"(session_id) WHERE deleted_at IS NULL`);
  } catch (e) {
    console.error(`[db] Track D 迁移失败: ${e?.message ?? e}`);
  }
})();

// ── Skill Library / Project Binding── App 级 Skill 定义 + 项目级绑定。
// 旧 project_skills 同时承担"定义"和"启用状态";新模型中 app_skills 存定义,
// project_skills 只存项目绑定(enabled_override/config override)。这里保持幂等补表补列。
(function migrateSkillLibrary() {
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS "app_skills" (
        "id" TEXT PRIMARY KEY,
        "skill_name" TEXT NOT NULL UNIQUE,
        "is_active" INTEGER DEFAULT 1,
        "default_enabled" INTEGER DEFAULT 1,
        "builtin" INTEGER DEFAULT 0,
        "runtime" TEXT DEFAULT 'prompt',
        "description" TEXT,
        "config" TEXT,
        "instructions" TEXT,
        "created_by" TEXT,
        "updated_by" TEXT,
        "created_at" TEXT,
        "updated_at" TEXT,
        "deleted_at" TEXT,
        "deleted_by" TEXT
      )`,
    );

    const projectSkillCols = db.prepare(`PRAGMA table_info("project_skills")`).all().map((c) => c.name);
    if (!projectSkillCols.includes("skill_id")) {
      db.exec(`ALTER TABLE "project_skills" ADD COLUMN "skill_id" TEXT`);
    }
    if (!projectSkillCols.includes("enabled_override")) {
      db.exec(`ALTER TABLE "project_skills" ADD COLUMN "enabled_override" INTEGER`);
      db.exec(`UPDATE "project_skills" SET enabled_override = is_enabled WHERE enabled_override IS NULL AND deleted_at IS NULL`);
    }

    // 迁移旧 App scope 自定义 Skill。builtin 行只作为状态行使用,不会覆盖 SKILL.md。
    db.exec(
      `INSERT INTO "app_skills" (
          id, skill_name, is_active, default_enabled, builtin, runtime,
          description, config, instructions, created_by, updated_by, created_at, updated_at
        )
        SELECT id, skill_name, 1, COALESCE(is_enabled, 1), 0, 'prompt',
               json_extract(config, '$.description'), config,
               COALESCE(skill_template, json_extract(config, '$.instructions')),
               enabled_by, enabled_by, created_at, updated_at
          FROM "project_skills" ps
         WHERE ps.project_id='__app__'
           AND ps.deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM "app_skills" s
              WHERE s.skill_name = ps.skill_name AND s.deleted_at IS NULL
           )`,
    );

    db.exec(`CREATE INDEX IF NOT EXISTS idx_app_skills_name ON "app_skills"(skill_name) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_project_skills_binding ON "project_skills"(project_id, skill_name) WHERE deleted_at IS NULL`);
  } catch (e) {
    console.error(`[db] Skill Library 迁移失败: ${e?.message ?? e}`);
  }
})();

// ── MCP Provider Library / Project Binding── App 级 MCP Provider 定义 + 项目级绑定。
// 旧 project_mcp_providers 同时承担"定义"和"启用状态";新模型中 app_mcp_providers 存定义,
// project_mcp_providers 只存项目启用覆盖。这里保持幂等补表补列,并迁移旧项目内 Provider 定义。
(function migrateMcpProviderLibrary() {
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS "app_mcp_providers" (
        "id" TEXT PRIMARY KEY,
        "provider_name" TEXT NOT NULL UNIQUE,
        "transport" TEXT DEFAULT 'stdio',
        "command" TEXT NOT NULL,
        "args" TEXT,
        "env" TEXT,
        "is_active" INTEGER DEFAULT 1,
        "default_enabled" INTEGER DEFAULT 1,
        "last_discovered_at" TEXT,
        "last_error" TEXT,
        "tool_cache" TEXT,
        "created_by" TEXT,
        "updated_by" TEXT,
        "created_at" TEXT,
        "updated_at" TEXT,
        "deleted_at" TEXT,
        "deleted_by" TEXT
      )`,
    );

    const projectMcpCols = db.prepare(`PRAGMA table_info("project_mcp_providers")`).all().map((c) => c.name);
    if (!projectMcpCols.includes("provider_id")) {
      db.exec(`ALTER TABLE "project_mcp_providers" ADD COLUMN "provider_id" TEXT`);
    }
    if (!projectMcpCols.includes("enabled_override")) {
      db.exec(`ALTER TABLE "project_mcp_providers" ADD COLUMN "enabled_override" INTEGER`);
      db.exec(`UPDATE "project_mcp_providers" SET enabled_override = is_enabled WHERE enabled_override IS NULL AND deleted_at IS NULL`);
    }

    db.exec(
      `INSERT INTO "app_mcp_providers" (
          id, provider_name, transport, command, args, env, is_active, default_enabled,
          last_discovered_at, last_error, created_by, updated_by, created_at, updated_at
        )
        SELECT id, provider_name, COALESCE(transport, 'stdio'), command, args, env, 1, COALESCE(is_enabled, 1),
               last_discovered_at, last_error, enabled_by, enabled_by, created_at, updated_at
          FROM "project_mcp_providers" pm
         WHERE pm.deleted_at IS NULL
           AND pm.provider_name IS NOT NULL
           AND pm.command IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM "app_mcp_providers" ap
              WHERE ap.provider_name = pm.provider_name AND ap.deleted_at IS NULL
           )`,
    );

    db.exec(
      `UPDATE "project_mcp_providers"
          SET provider_id = (
                SELECT ap.id
                  FROM "app_mcp_providers" ap
                 WHERE ap.provider_name = "project_mcp_providers".provider_name
                   AND ap.deleted_at IS NULL
                 LIMIT 1
              )
        WHERE provider_id IS NULL
          AND deleted_at IS NULL`,
    );

    db.exec(`CREATE INDEX IF NOT EXISTS idx_app_mcp_providers_name ON "app_mcp_providers"(provider_name) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_project_mcp_provider_binding ON "project_mcp_providers"(project_id, provider_name) WHERE deleted_at IS NULL`);
  } catch (e) {
    console.error(`[db] MCP Provider Library 迁移失败: ${e?.message ?? e}`);
  }
})();

// ── Pi-Agent Suspended Runs── 框架级等待用户输入/审批/恢复句柄。
// pending action 长期入库;resume 是否仍可原地恢复由 resume_expires_at 与 checkpoint 决定。
(function migrateAgentSuspendedRuns() {
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS "agent_runs" (
        "id" TEXT PRIMARY KEY,
        "session_id" TEXT NOT NULL,
        "project_id" TEXT,
        "user_id" TEXT,
        "status" TEXT NOT NULL DEFAULT 'running',
        "skill_name" TEXT,
        "mode" TEXT,
        "checkpoint_json" TEXT,
        "metadata_json" TEXT,
        "finished_at" TEXT,
        "created_at" TEXT,
        "updated_at" TEXT,
        "deleted_at" TEXT,
        "deleted_by" TEXT
      )`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS "agent_pending_inputs" (
        "id" TEXT PRIMARY KEY,
        "run_id" TEXT NOT NULL,
        "session_id" TEXT NOT NULL,
        "project_id" TEXT,
        "user_id" TEXT,
        "request_id" TEXT NOT NULL UNIQUE,
        "input_type" TEXT NOT NULL DEFAULT 'user_input',
        "status" TEXT NOT NULL DEFAULT 'pending',
        "payload_json" TEXT,
        "response_json" TEXT,
        "resume_handle_json" TEXT,
        "resume_expires_at" TEXT,
        "record_expires_at" TEXT,
        "responded_by" TEXT,
        "responded_at" TEXT,
        "created_at" TEXT,
        "updated_at" TEXT,
        "deleted_at" TEXT,
        "deleted_by" TEXT
      )`,
    );
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_runs_session_status ON "agent_runs"(session_id, status) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_pending_session_status ON "agent_pending_inputs"(session_id, status) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_pending_run ON "agent_pending_inputs"(run_id) WHERE deleted_at IS NULL`);
  } catch (e) {
    console.error(`[db] Pi-Agent Suspended Runs 迁移失败: ${e?.message ?? e}`);
  }
})();

// ── Durable Background Jobs── 长任务提交即返回，但状态、失败原因和重试次数持久化。
(function migrateBackgroundJobs() {
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS "background_jobs" (
        "id" TEXT PRIMARY KEY,
        "project_id" TEXT,
        "session_id" TEXT,
        "user_id" TEXT,
        "kind" TEXT NOT NULL,
        "resource_type" TEXT,
        "resource_id" TEXT,
        "status" TEXT NOT NULL DEFAULT 'queued',
        "progress" INTEGER NOT NULL DEFAULT 0,
        "attempt_count" INTEGER NOT NULL DEFAULT 0,
        "max_attempts" INTEGER NOT NULL DEFAULT 3,
        "error_code" TEXT,
        "error_message" TEXT,
        "result_json" TEXT,
        "created_at" TEXT,
        "started_at" TEXT,
        "finished_at" TEXT,
        "updated_at" TEXT,
        "deleted_at" TEXT
      )`,
    );
    db.exec(`CREATE INDEX IF NOT EXISTS idx_background_jobs_project_status ON "background_jobs"(project_id, status) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_background_jobs_resource ON "background_jobs"(resource_type, resource_id) WHERE deleted_at IS NULL`);
    const columns = db.prepare(`PRAGMA table_info("background_jobs")`).all().map((column) => column.name);
    if (!columns.includes('next_retry_at')) db.exec(`ALTER TABLE "background_jobs" ADD COLUMN "next_retry_at" TEXT`);
  } catch (e) {
    console.error(`[db] Background Jobs 迁移失败: ${e?.message ?? e}`);
  }
})();

// ── Agent 能力调用幂等记录── 同一用户/项目/operation/key 在 App 重启后仍只执行一次。
(function migrateCapabilityIdempotency() {
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS "capability_idempotency" (
        "id" TEXT PRIMARY KEY,
        "user_id" TEXT NOT NULL,
        "project_scope" TEXT NOT NULL,
        "operation_id" TEXT NOT NULL,
        "idempotency_key" TEXT NOT NULL,
        "request_hash" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'pending',
        "response_json" TEXT,
        "error_message" TEXT,
        "created_at" TEXT,
        "updated_at" TEXT,
        "completed_at" TEXT
      )`,
    );
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_capability_idempotency_scope
      ON "capability_idempotency"(user_id, project_scope, operation_id, idempotency_key)`);
  } catch (e) {
    console.error(`[db] capability idempotency 迁移失败: ${e?.message ?? e}`);
  }
})();

// ── 后台任务事件消费── 每个任务终态事件只交给 Agent 一次。
(function migrateBackgroundJobEvents() {
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS "background_job_events" (
        "id" TEXT PRIMARY KEY,
        "job_id" TEXT NOT NULL,
        "session_id" TEXT,
        "event_key" TEXT NOT NULL,
        "payload_json" TEXT NOT NULL,
        "consume_status" TEXT NOT NULL DEFAULT 'pending',
        "claimed_at" TEXT,
        "consumed_at" TEXT,
        "created_at" TEXT,
        "updated_at" TEXT
      )`,
    );
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_background_job_event_key ON "background_job_events"(job_id,event_key)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_background_job_event_session ON "background_job_events"(session_id,consume_status,created_at)`);
  } catch (e) {
    console.error(`[db] background job events 迁移失败: ${e?.message ?? e}`);
  }
})();

// ── Loop Engineering MVP-A── Trace Review / Eval Draft / Step 0 Gold Solve。
// 产品状态存 YiW 本地库；yiTrace 继续只保存 trace/span/input/output 等事实。
(function migrateTraceOptimization() {
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS "trace_run_reviews" (
        "id" TEXT PRIMARY KEY,
        "project_id" TEXT NOT NULL,
        "session_id" TEXT,
        "run_id" TEXT NOT NULL,
        "trace_id" TEXT,
        "span_id" TEXT,
        "target_type" TEXT NOT NULL DEFAULT 'run',
        "question" TEXT,
        "actual_output" TEXT,
        "trace_snapshot_json" TEXT,
        "status" TEXT NOT NULL DEFAULT 'needs_review',
        "severity" TEXT NOT NULL DEFAULT 'medium',
        "reason_code" TEXT,
        "reason_text" TEXT,
        "expected_behavior" TEXT,
        "source" TEXT DEFAULT 'human',
        "score_type" TEXT,
        "score_value" TEXT,
        "risk_reason" TEXT,
        "created_by" TEXT,
        "updated_by" TEXT,
        "version" INTEGER NOT NULL DEFAULT 1,
        "created_at" TEXT,
        "updated_at" TEXT,
        "deleted_at" TEXT,
        "deleted_by" TEXT
      )`,
    );
    const reviewCols = db.prepare(`PRAGMA table_info("trace_run_reviews")`).all().map((c) => c.name);
    if (!reviewCols.includes("question")) db.exec(`ALTER TABLE "trace_run_reviews" ADD COLUMN "question" TEXT`);
    if (!reviewCols.includes("actual_output")) db.exec(`ALTER TABLE "trace_run_reviews" ADD COLUMN "actual_output" TEXT`);
    if (!reviewCols.includes("trace_snapshot_json")) db.exec(`ALTER TABLE "trace_run_reviews" ADD COLUMN "trace_snapshot_json" TEXT`);
    db.exec(
      `CREATE TABLE IF NOT EXISTS "trace_eval_drafts" (
        "id" TEXT PRIMARY KEY,
        "review_id" TEXT NOT NULL,
        "project_id" TEXT NOT NULL,
        "session_id" TEXT,
        "run_id" TEXT NOT NULL,
        "trace_id" TEXT,
        "span_id" TEXT,
        "source_object_id" TEXT,
        "source_object_type" TEXT DEFAULT 'trace_review',
        "question" TEXT,
        "actual_output" TEXT,
        "expected_behavior" TEXT,
        "expected_answer" TEXT,
        "assertion_type" TEXT DEFAULT 'manual',
        "status" TEXT NOT NULL DEFAULT 'draft',
        "benchmark_status" TEXT NOT NULL DEFAULT 'candidate',
        "tags" TEXT,
        "failure_category" TEXT,
        "tuning_notes" TEXT,
        "replay_requirements_json" TEXT,
        "trace_snapshot_json" TEXT,
        "created_by" TEXT,
        "updated_by" TEXT,
        "version" INTEGER NOT NULL DEFAULT 1,
        "created_at" TEXT,
        "updated_at" TEXT,
        "deleted_at" TEXT,
        "deleted_by" TEXT
      )`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS "trace_gold_solves" (
        "id" TEXT PRIMARY KEY,
        "draft_id" TEXT NOT NULL,
        "project_id" TEXT NOT NULL,
        "question" TEXT,
        "expected_behavior" TEXT,
        "expected_answer" TEXT,
        "intent_summary" TEXT,
        "data_sources" TEXT,
        "filters_json" TEXT,
        "metric_definition" TEXT,
        "reference_steps_json" TEXT,
        "reference_sql" TEXT,
        "intermediate_expectations_json" TEXT,
        "final_answer_contract" TEXT,
        "trace_diff_summary" TEXT,
        "status" TEXT NOT NULL DEFAULT 'drafted',
        "created_by" TEXT,
        "verified_by" TEXT,
        "version" INTEGER NOT NULL DEFAULT 1,
        "created_at" TEXT,
        "updated_at" TEXT,
        "deleted_at" TEXT,
        "deleted_by" TEXT
      )`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS "trace_benchmark_cases" (
        "id" TEXT PRIMARY KEY,
        "project_id" TEXT NOT NULL,
        "source_type" TEXT DEFAULT 'manual',
        "source_object_id" TEXT,
        "case_key" TEXT,
        "title" TEXT,
        "question" TEXT NOT NULL,
        "expected_behavior" TEXT,
        "answer_type" TEXT NOT NULL DEFAULT 'text',
        "assertion_type" TEXT NOT NULL DEFAULT 'manual',
        "assertion_json" TEXT,
        "gold_json" TEXT,
        "metadata_json" TEXT,
        "tags" TEXT,
        "gold_solve_json" TEXT,
        "status" TEXT NOT NULL DEFAULT 'draft',
        "warnings_json" TEXT,
        "raw_input" TEXT,
        "created_by" TEXT,
        "updated_by" TEXT,
        "version" INTEGER NOT NULL DEFAULT 1,
        "created_at" TEXT,
        "updated_at" TEXT,
        "deleted_at" TEXT,
        "deleted_by" TEXT
      )`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS "trace_benchmark_runs" (
        "id" TEXT PRIMARY KEY,
        "project_id" TEXT NOT NULL,
        "benchmark_case_id" TEXT NOT NULL,
        "task_id" TEXT,
        "status" TEXT NOT NULL DEFAULT 'running',
        "eval_run_id" TEXT,
        "report_file" TEXT,
        "report_json" TEXT,
        "result_json" TEXT,
        "diagnosis_json" TEXT,
        "trace_id" TEXT,
        "run_id" TEXT,
        "session_id" TEXT,
        "span_id" TEXT,
        "trace_snapshot_json" TEXT,
        "metrics_json" TEXT,
        "stdout" TEXT,
        "stderr" TEXT,
        "exit_code" INTEGER,
        "started_at" TEXT,
        "finished_at" TEXT,
        "created_by" TEXT,
        "updated_by" TEXT,
        "version" INTEGER NOT NULL DEFAULT 1,
        "created_at" TEXT,
        "updated_at" TEXT,
        "deleted_at" TEXT,
        "deleted_by" TEXT
      )`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS "trace_optimization_attempts" (
        "id" TEXT PRIMARY KEY,
        "project_id" TEXT NOT NULL,
        "draft_id" TEXT NOT NULL,
        "benchmark_case_id" TEXT,
        "attempt_index" INTEGER NOT NULL DEFAULT 1,
        "source" TEXT NOT NULL DEFAULT 'manual',
        "status" TEXT NOT NULL DEFAULT 'planned',
        "hypothesis" TEXT,
        "change_summary" TEXT,
        "diagnosis_json" TEXT,
        "benchmark_result_json" TEXT,
        "trace_id" TEXT,
        "run_id" TEXT,
        "session_id" TEXT,
        "span_id" TEXT,
        "trace_snapshot_json" TEXT,
        "metrics_json" TEXT,
        "notes" TEXT,
        "created_by" TEXT,
        "updated_by" TEXT,
        "version" INTEGER NOT NULL DEFAULT 1,
        "created_at" TEXT,
        "updated_at" TEXT,
        "deleted_at" TEXT,
        "deleted_by" TEXT
      )`,
    );

    db.exec(`CREATE INDEX IF NOT EXISTS idx_trace_reviews_project_updated ON "trace_run_reviews"(project_id, updated_at) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_trace_reviews_target ON "trace_run_reviews"(project_id, target_type, run_id, span_id) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_trace_reviews_session ON "trace_run_reviews"(project_id, session_id) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_trace_drafts_project_updated ON "trace_eval_drafts"(project_id, updated_at) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_trace_drafts_review ON "trace_eval_drafts"(review_id) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_trace_drafts_session ON "trace_eval_drafts"(project_id, session_id) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_trace_gold_solves_draft ON "trace_gold_solves"(draft_id) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_trace_benchmark_cases_project_updated ON "trace_benchmark_cases"(project_id, updated_at) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_trace_benchmark_cases_status ON "trace_benchmark_cases"(project_id, status) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_trace_benchmark_runs_case_updated ON "trace_benchmark_runs"(benchmark_case_id, updated_at) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_trace_benchmark_runs_project_updated ON "trace_benchmark_runs"(project_id, updated_at) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_trace_benchmark_runs_status ON "trace_benchmark_runs"(project_id, status) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_trace_attempts_draft ON "trace_optimization_attempts"(draft_id, attempt_index) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_trace_attempts_project_updated ON "trace_optimization_attempts"(project_id, updated_at) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_trace_attempts_status ON "trace_optimization_attempts"(project_id, status) WHERE deleted_at IS NULL`);
  } catch (e) {
    console.error(`[db] Loop Engineering 迁移失败: ${e?.message ?? e}`);
  }
})();

// ── IM Remote Gateway── 飞书/企微/未来 IM 通道统一远程控制模型。
// 通道(connector)、外部身份(identity)、远程上下文(context)、幂等事件、投递日志、pending 交互、
// worker 状态分离,避免把平台配置直接绑死到单一工作区或会话。
(function migrateImGateway() {
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS "im_connectors" (
        "id" TEXT PRIMARY KEY,
        "provider" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "owner_user_id" TEXT NOT NULL,
        "default_workspace_id" TEXT,
        "allowed_workspace_ids" TEXT,
        "session_policy" TEXT DEFAULT 'per_user',
        "enabled" INTEGER DEFAULT 1,
        "credentials" TEXT,
        "settings" TEXT,
        "connection_status" TEXT DEFAULT 'disconnected',
        "last_error" TEXT,
        "created_at" TEXT,
        "updated_at" TEXT,
        "deleted_at" TEXT,
        "deleted_by" TEXT
      )`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS "im_remote_identities" (
        "id" TEXT PRIMARY KEY,
        "connector_id" TEXT NOT NULL,
        "provider" TEXT NOT NULL,
        "external_user_id" TEXT NOT NULL,
        "external_union_id" TEXT,
        "app_user_id" TEXT,
        "display_name" TEXT,
        "status" TEXT DEFAULT 'pending',
        "pairing_code" TEXT,
        "created_at" TEXT,
        "updated_at" TEXT,
        "deleted_at" TEXT,
        "deleted_by" TEXT
      )`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS "im_remote_contexts" (
        "id" TEXT PRIMARY KEY,
        "connector_id" TEXT NOT NULL,
        "provider" TEXT NOT NULL,
        "external_conversation_key" TEXT NOT NULL,
        "external_user_id" TEXT NOT NULL,
        "chat_id" TEXT,
        "chat_type" TEXT,
        "current_workspace_id" TEXT,
        "current_session_id" TEXT,
        "session_policy" TEXT DEFAULT 'per_user',
        "last_active_at" TEXT,
        "created_at" TEXT,
        "updated_at" TEXT,
        "deleted_at" TEXT,
        "deleted_by" TEXT
      )`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS "im_inbound_events" (
        "id" TEXT PRIMARY KEY,
        "connector_id" TEXT NOT NULL,
        "provider" TEXT NOT NULL,
        "event_id" TEXT NOT NULL,
        "message_id" TEXT,
        "external_conversation_key" TEXT,
        "external_user_id" TEXT,
        "chat_id" TEXT,
        "chat_type" TEXT,
        "text" TEXT,
        "command" TEXT,
        "status" TEXT,
        "result_workspace_id" TEXT,
        "result_session_id" TEXT,
        "raw_event" TEXT,
        "created_at" TEXT,
        "updated_at" TEXT,
        "deleted_at" TEXT,
        "deleted_by" TEXT
      )`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS "im_outbound_messages" (
        "id" TEXT PRIMARY KEY,
        "connector_id" TEXT NOT NULL,
        "inbound_event_id" TEXT,
        "provider" TEXT NOT NULL,
        "target_key" TEXT,
        "message_type" TEXT DEFAULT 'markdown',
        "content" TEXT,
        "status" TEXT DEFAULT 'queued',
        "error_message" TEXT,
        "created_at" TEXT,
        "updated_at" TEXT,
        "deleted_at" TEXT,
        "deleted_by" TEXT
      )`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS "im_pending_interactions" (
        "id" TEXT PRIMARY KEY,
        "connector_id" TEXT NOT NULL,
        "provider" TEXT NOT NULL,
        "external_conversation_key" TEXT NOT NULL,
        "external_user_id" TEXT NOT NULL,
        "workspace_id" TEXT,
        "session_id" TEXT,
        "run_id" TEXT,
        "request_id" TEXT,
        "type" TEXT,
        "payload" TEXT,
        "expires_at" TEXT,
        "created_at" TEXT,
        "updated_at" TEXT,
        "deleted_at" TEXT,
        "deleted_by" TEXT
      )`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS "im_worker_status" (
        "id" TEXT PRIMARY KEY,
        "connector_id" TEXT NOT NULL,
        "provider" TEXT NOT NULL,
        "status" TEXT DEFAULT 'disconnected',
        "heartbeat_at" TEXT,
        "last_error" TEXT,
        "pid" INTEGER,
        "created_at" TEXT,
        "updated_at" TEXT,
        "deleted_at" TEXT,
        "deleted_by" TEXT
      )`,
    );
    db.exec(`CREATE INDEX IF NOT EXISTS idx_im_connectors_owner ON "im_connectors"(owner_user_id) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_im_identity_lookup ON "im_remote_identities"(connector_id, external_user_id) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_im_context_lookup ON "im_remote_contexts"(connector_id, external_conversation_key, external_user_id) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_im_inbound_dedupe ON "im_inbound_events"(connector_id, event_id) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_im_pending_lookup ON "im_pending_interactions"(connector_id, external_conversation_key, external_user_id) WHERE deleted_at IS NULL`);
  } catch (e) {
    console.error(`[db] IM Gateway 迁移失败: ${e?.message ?? e}`);
  }
})();

// ── SuperAgent Workflow── 项目设置里的工作流编排定义与运行记录。
// 当前桌面 app 已去业务层,但 workflow 历史表结构仍保留 business_id 以兼容旧 dev 数据形状;
// 新写入统一令 business_id = project_id。
(function migrateSuperAgentWorkflow() {
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS "superagent_workflows" (
        "id" TEXT PRIMARY KEY,
        "project_id" TEXT NOT NULL,
        "business_id" TEXT,
        "name" TEXT NOT NULL,
        "graph" TEXT NOT NULL,
        "revision" INTEGER NOT NULL DEFAULT 1,
        "design_business_id" TEXT,
        "trigger" TEXT,
        "is_enabled" INTEGER NOT NULL DEFAULT 1,
        "source" TEXT NOT NULL DEFAULT 'manual',
        "created_at" TEXT,
        "updated_at" TEXT,
        "deleted_at" TEXT,
        "deleted_by" TEXT
      )`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS "superagent_workflow_runs" (
        "id" TEXT PRIMARY KEY,
        "workflow_id" TEXT NOT NULL,
        "business_id" TEXT,
        "origin_session_id" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'running',
        "input" TEXT,
        "output" TEXT,
        "error" TEXT,
        "graph_snapshot" TEXT NOT NULL,
        "workflow_revision" INTEGER NOT NULL,
        "node_runs" TEXT,
        "finished_at" TEXT,
        "created_at" TEXT,
        "updated_at" TEXT,
        "deleted_at" TEXT,
        "deleted_by" TEXT
      )`,
    );
    db.exec(`CREATE INDEX IF NOT EXISTS idx_saw_project_updated ON "superagent_workflows"(project_id, updated_at) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_saw_project_enabled ON "superagent_workflows"(project_id, is_enabled) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sawr_workflow_status ON "superagent_workflow_runs"(workflow_id, status) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sawr_origin_session ON "superagent_workflow_runs"(origin_session_id, status) WHERE deleted_at IS NULL`);
  } catch (e) {
    console.error(`[db] SuperAgent Workflow 迁移失败: ${e?.message ?? e}`);
  }
})();

// ── 元数据同步策略 / 记录── 对齐源库数据库管理页的自动同步配置。
(function migrateMetadataSync() {
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS "metadata_sync_configs" (
        "id" TEXT PRIMARY KEY,
        "project_id" TEXT NOT NULL,
        "database_connection_id" TEXT NOT NULL,
        "enabled" INTEGER DEFAULT 0,
        "skip_cron" INTEGER DEFAULT 0,
        "schedule_cron" TEXT,
        "sync_mode" TEXT DEFAULT 'registered_only',
        "last_run_at" TEXT,
        "last_status" TEXT,
        "last_error" TEXT,
        "last_auto_run_at" TEXT,
        "created_at" TEXT,
        "updated_at" TEXT,
        "deleted_at" TEXT,
        "deleted_by" TEXT
      )`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS "metadata_sync_audits" (
        "id" TEXT PRIMARY KEY,
        "project_id" TEXT NOT NULL,
        "database_connection_id" TEXT NOT NULL,
        "trigger_source" TEXT,
        "status" TEXT,
        "tables_synced" INTEGER,
        "columns_synced" INTEGER,
        "duration_ms" INTEGER,
        "error_msg" TEXT,
        "created_at" TEXT,
        "updated_at" TEXT,
        "deleted_at" TEXT,
        "deleted_by" TEXT
      )`,
    );
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_metadata_sync_config_conn ON "metadata_sync_configs"(project_id, database_connection_id) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_metadata_sync_audits_conn ON "metadata_sync_audits"(project_id, database_connection_id, created_at) WHERE deleted_at IS NULL`);
  } catch (e) {
    console.error(`[db] metadata sync 迁移失败: ${e?.message ?? e}`);
  }
})();

// ── vexdb_lite 向量扩展(HNSW ANN,供 schema/实体/指标的向量召回)──
// 加载失败不致命:相关服务自动降级为关键词/LIKE 召回。
export let vectorReady = false;
(function loadVectorExtension() {
  const plat = platform();
  const file = plat === "win32" ? "windows-x64/vexdb_lite.dll" : "macos/vexdb_lite.dylib";
  const extPath = process.env.VEXDB_EXT_PATH || join(__dir, "..", "vendor", "vexdb_lite", file);
  if (plat !== "darwin" && plat !== "win32") {
    console.warn(`[db] vexdb_lite 无 ${plat}/${arch()} 构建,向量召回降级为关键词`);
    return;
  }
  if (!existsSync(extPath)) {
    console.warn(`[db] vexdb_lite 扩展不存在(${extPath}),向量召回降级为关键词`);
    return;
  }
  try {
    db.loadExtension(extPath); // better-sqlite3 直接加载扩展,无需 enableLoadExtension(node:sqlite 才有)
    const v = db.prepare("SELECT vexdb_version() v").get().v;
    vectorReady = true;
    console.info(`[db] ✓ vexdb_lite 向量扩展已加载: ${v}`);
  } catch (e) {
    console.warn(`[db] vexdb_lite 加载失败(${e?.message ?? e}),向量召回降级为关键词`);
  }
})();

// ── PG 内置函数 → SQLite 自定义函数(避免改 SQL 文本)──
db.function("now", () => new Date().toISOString());
db.function("gen_random_uuid", () => randomUUID());
db.function("uuid_generate_v4", () => randomUUID());

/** 单个绑定值:PG 驱动接受 JS 对象/布尔/Date,SQLite 只接受 null/number/bigint/string/Buffer。 */
function normalizeParam(v) {
  if (v === undefined || v === null) return null;
  const t = typeof v;
  if (t === "boolean") return v ? 1 : 0;
  if (t === "number" || t === "bigint" || t === "string") return v;
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Date) return v.toISOString();
  return JSON.stringify(v); // 对象/数组 → JSON 文本(对应 jsonb 列)
}

// 一次扫描同时处理:`= ANY($n)`→IN展开、`!=/<> ALL($n)`→NOT IN展开、标量 `$n`→`?`。
// String.replace(/g) 按出现顺序回调,保证 out 参数顺序与 ? 一致。
const ANY_ALL_PLACEHOLDER = /=\s*ANY\(\s*\$(\d+)(?:::[a-zA-Z_]+(?:\[\])?)?\s*\)|(?:!=|<>)\s*ALL\(\s*\$(\d+)(?:::[a-zA-Z_]+(?:\[\])?)?\s*\)|\$(\d+)/g;

/** PG SQL + 参数 → SQLite SQL + 位置参数。 */
function translate(sql, params) {
  const out = [];
  let translated = sql.replace(ANY_ALL_PLACEHOLDER, (m, anyN, allN, scalarN) => {
    if (anyN !== undefined || allN !== undefined) {
      const idx = anyN !== undefined ? anyN : allN;
      let arr = params[Number(idx) - 1];
      if (!Array.isArray(arr)) arr = arr == null ? [] : [arr];
      if (anyN !== undefined) {
        // = ANY(...) → IN(...);空数组永不命中
        if (arr.length === 0) return " IN (SELECT NULL WHERE 0)";
        for (const v of arr) out.push(normalizeParam(v));
        return " IN (" + arr.map(() => "?").join(",") + ")";
      }
      // != / <> ALL(...) → NOT IN(...);空数组 → NOT IN 空集 = 恒为真(无排除项)
      if (arr.length === 0) return " NOT IN (SELECT NULL WHERE 0)";
      for (const v of arr) out.push(normalizeParam(v));
      return " NOT IN (" + arr.map(() => "?").join(",") + ")";
    }
    out.push(normalizeParam(params[Number(scalarN) - 1]));
    return "?";
  });
  translated = translated.replace(/::[a-zA-Z_]+(\[\])?/g, ""); // 剥残留类型转换
  translated = translated.replace(/\bILIKE\b/gi, "LIKE");
  return { sql: translated, params: out };
}

const RETURNS_ROWS = /^\s*(select|with)\b/i;
const HAS_RETURNING = /\breturning\b/i;

/** 执行查询,返回 rows(数组)。 */
export async function query(sql, params = []) {
  const t = translate(sql, params);
  const stmt = db.prepare(t.sql);
  if (RETURNS_ROWS.test(t.sql) || HAS_RETURNING.test(t.sql)) {
    return stmt.all(...t.params);
  }
  stmt.run(...t.params);
  return [];
}

/** 取单行(无则 null)。 */
export async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

/** 兼容部分迁移代码里用 ctx.execute 写库的调用。 */
export async function execute(sql, params = []) {
  return query(sql, params);
}

/** 原始 SQLite 句柄(供 schema 初始化 / 批量导入等底层操作)。 */
export const sqlite = db;

export default { query, queryOne, execute, sqlite };
