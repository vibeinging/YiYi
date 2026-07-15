// Track D · 问数 task_plan 活文档持久化服务(样板)
//
// 把 SuperAgent/pi 在一次问数里维护的「任务计划」从 prompt 里拉出来落表(表 analysis_plan_steps),
// 让 ① 前端右栏 plan 列表、② replan 后的合并、③ {task_plan_section} 回灌 都有持久来源。
// 对标 ZCode/OpenCode 的 `todo` 表(见 docs/design/2026-06-23_track-d-sqlite-schema-draft.md §3.1)。
//
// ============================ DB 访问约定(与其它已迁 service 一致)============================
// 所有需要查库的方法第一个参数为 ctx:{ query(sql,params)->Promise<rows>, queryOne(sql,params)->Promise<row|null> }。
// 本服务【不直接连库】,由上层(路由 / AnalysisSession / chat 工具)注入 ctx={query,queryOne}(见 business_crud.js 模式)。
// SQL 用 PG 方言($1,$2… 占位符 / now() / gen_random_uuid());db.js 自动翻译成 SQLite,一字不改。
// 软删:所有查询带 deleted_at IS NULL。主键 id 由本服务 randomUUID() 生成(对应 Python 端默认值)。
// JSON 列(depends_on):直接传 JS 数组,db.js normalizeParam 自动 JSON.stringify;读取侧 _parseJson 还原。
// =============================================================================================

import { randomUUID } from "crypto";

import { ValidationError } from "./exceptions.js";

const _TABLE = "analysis_plan_steps";

/** 安全解析 JSON 文本列,失败回退默认值。 */
function _parseJson(text, fallback) {
  if (text == null || text === "") return fallback;
  if (typeof text !== "string") return text; // 已是对象/数组
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export class PlanStepService {
  /**
   * 用 LLM 给的新 plan 覆盖/合并本 session 的计划(E4 _merge_task_plan 语义):
   *   - 已 completed / running 的步骤:保留其状态与 intermediate_table,仅刷新描述/顺序/依赖;
   *   - pending / failed 的步骤:采用 LLM 新版;
   *   - 本轮新 plan 不再出现、且仍是 pending 的旧步骤:软删(completed/running 留作历史)。
   * @param {{query:Function,queryOne:Function}} ctx
   * @param {{sessionId:string, messageId?:string|null, steps:Array<object>}} p
   *   steps[i] = { task_id, title, source_kind?, source_name?, depends_on?:string[], output_alias?, status? }
   */
  static async replacePlan(ctx, { sessionId, messageId = null, steps = [] }) {
    if (!sessionId) throw new ValidationError("sessionId 必填");

    const existing = await ctx.query(
      `SELECT id, task_id, status FROM ${_TABLE} WHERE session_id = $1 AND deleted_at IS NULL`,
      [sessionId],
    );
    const byTask = new Map(existing.filter((r) => r.task_id).map((r) => [r.task_id, r]));
    const incoming = new Set();

    for (let i = 0; i < steps.length; i++) {
      const s = steps[i] || {};
      const taskId = s.task_id ?? s.taskId ?? `step_${i}`;
      incoming.add(taskId);
      const dependsOn = s.depends_on ?? s.dependsOn ?? [];
      const prev = byTask.get(taskId);

      if (prev && (prev.status === "completed" || prev.status === "running")) {
        // 保状态:只刷新可变描述字段
        await ctx.query(
          `UPDATE ${_TABLE} SET step_index=$1, title=$2, source_kind=$3, source_name=$4,
             depends_on=$5, output_alias=$6, updated_at=now() WHERE id=$7`,
          [i, s.title ?? "", s.source_kind ?? null, s.source_name ?? null, dependsOn, s.output_alias ?? null, prev.id],
        );
      } else if (prev) {
        // pending/failed:采用 LLM 新版(默认回 pending)
        await ctx.query(
          `UPDATE ${_TABLE} SET step_index=$1, title=$2, source_kind=$3, source_name=$4,
             depends_on=$5, output_alias=$6, status=$7, updated_at=now() WHERE id=$8`,
          [i, s.title ?? "", s.source_kind ?? null, s.source_name ?? null, dependsOn, s.output_alias ?? null, s.status ?? "pending", prev.id],
        );
      } else {
        await ctx.query(
          `INSERT INTO ${_TABLE}
             (id, session_id, message_id, step_index, task_id, title, source_kind, source_name,
              depends_on, output_alias, status, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),now())`,
          [randomUUID(), sessionId, messageId, i, taskId, s.title ?? "", s.source_kind ?? null,
            s.source_name ?? null, dependsOn, s.output_alias ?? null, s.status ?? "pending"],
        );
      }
    }

    // replan 丢弃的 pending 步骤软删;completed/running 保留作历史轨迹
    for (const r of existing) {
      if (r.task_id && !incoming.has(r.task_id) && r.status !== "completed" && r.status !== "running") {
        await ctx.query(`UPDATE ${_TABLE} SET deleted_at=now() WHERE id=$1`, [r.id]);
      }
    }
  }

  /**
   * 标记某步骤状态(E4 _advance_task);工具成功落表后回填 intermediate_table。
   * @param {{query:Function}} ctx
   * @param {{sessionId:string, taskId:string, status:string, intermediateTable?:string|null}} p
   */
  static async advance(ctx, { sessionId, taskId, status, intermediateTable = null }) {
    if (!sessionId || !taskId) throw new ValidationError("sessionId / taskId 必填");
    await ctx.query(
      `UPDATE ${_TABLE}
         SET status=$1, intermediate_table=COALESCE($2, intermediate_table), updated_at=now()
       WHERE session_id=$3 AND task_id=$4 AND deleted_at IS NULL`,
      [status, intermediateTable, sessionId, taskId],
    );
  }

  /** 收尾兜底:把仍未完成的步骤统一置为 completed。 */
  static async completeOpen(ctx, { sessionId }) {
    if (!sessionId) throw new ValidationError("sessionId 必填");
    await ctx.query(
      `UPDATE ${_TABLE}
          SET status='completed', updated_at=now()
        WHERE session_id=$1 AND deleted_at IS NULL
          AND COALESCE(status, 'pending') NOT IN ('completed', 'done', 'complete')`,
      [sessionId],
    );
  }

  /** 按顺序列出本 session 的计划步骤(depends_on 还原为数组)。供前端右栏 plan。 */
  static async list(ctx, sessionId) {
    const rows = await ctx.query(
      `SELECT id, step_index, task_id, title, source_kind, source_name, depends_on,
              output_alias, status, intermediate_table
         FROM ${_TABLE}
        WHERE session_id=$1 AND deleted_at IS NULL
        ORDER BY step_index ASC`,
      [sessionId],
    );
    return rows.map((r) => ({ ...r, depends_on: _parseJson(r.depends_on, []) }));
  }

  /** 渲染 {task_plan_section} 的精简文本回灌父 agent(对齐 serialize_task_plan 的 slim 序列化)。 */
  static async render(ctx, sessionId) {
    const steps = await PlanStepService.list(ctx, sessionId);
    if (!steps.length) return "";
    const mark = { completed: "[x]", running: "[~]", failed: "[!]", pending: "[ ]" };
    const lines = steps.map((s) => {
      const dep = s.depends_on?.length ? ` ←${s.depends_on.join(",")}` : "";
      const out = s.output_alias ? ` →${s.output_alias}` : "";
      return `${mark[s.status] || "[ ]"} ${s.task_id}: ${s.title}${dep}${out}`;
    });
    return `## 任务计划\n${lines.join("\n")}`;
  }
}

export default PlanStepService;
