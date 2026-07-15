/**
 * AnalysisSession —— 问数引擎的会话级状态(把旧 SuperAgent 的 agent_context.data 等价物搬到当前运行时)。
 *
 * 底层运行时是纯文本驱动的无状态循环;问数需要的显式状态(中间表数据源 / 任务计划 / 探索到的 schema 提示)
 * 都挂在这里,被所有问数工具的 execute 闭包捕获。
 */
import { randomUUID } from "node:crypto";

import { query as _dbQuery, queryOne as _dbQueryOne } from "../../db.js";
import { PlanStepService } from "./plan_step_service.js";

export class AnalysisSession {
  static MAX_HARD_ERROR_REPLANS = 3; // 同一硬错误签名反复出现的上限(空结果不计入)
  static MAX_TOTAL_REPLANS = 6; // 累计 replan 上限(对齐 SuperAgent)

  constructor({ sessionId = null, agentContext = null, ctx = null } = {}) {
    this.sessionId = sessionId;
    this.agentContext = agentContext;
    // DB 访问(持久化 plan / 中间表索引);默认用本地 db 单例,测试可注入 { query, queryOne }。
    this.ctx = ctx || { query: _dbQuery, queryOne: _dbQueryOne };

    /** @type {import('../datasources/intermediate_data_source.js').IntermediateDataSource|null} */
    this.intermediate_ds = null;

    // LLM 用 update_plan 公布的任务计划(权威进度回灌 system prompt 用)
    this.taskPlan = [];

    // grep_tables / grep_columns 探索到的表/列,合并进 sql_scan 的 schema_hint(对齐 SuperAgent._extract_schema_hint)
    this.schemaTables = new Set();
    /** @type {Object<string, Set<string>>} */
    this.schemaColumns = {};

    // ── handle-result 运行态(SuperAgent agent_context.data 等价物;底层运行时 stateless,外置到这里)──
    // 步骤产出:sub_query/task_id → {row_count, columns, value_preview, intermediate_table, source_name}(下游依赖判断 / 可观测)
    this.stepOutputs = {};
    // 同查询空结果护栏:上次返回空的 sub_query(同一查询反复空 → 升级"停止重试")。空≠失败,故不计数、只比对。
    this.lastEmptyQuery = null;
    // 硬错误 fail-fast 双闸:error_signature → 次数 / 累计 replan(仅硬错误,空结果不计入)
    this.replanSigCounts = {};
    this.totalReplans = 0;
  }

  /**
   * 注册并挂载本会话的中间数据源(每会话一个 DuckDB 中间库),并注入 agentContext 供算子读取。
   * @param {import('../datasources/business_data_sources.js').BusinessDataSources} bds
   */
  registerIntermediate(bds) {
    if (!bds || typeof bds.register_intermediate_data_source !== "function") return null;
    this.intermediate_ds = bds.register_intermediate_data_source(this.sessionId);
    const dsi = this.agentContext?.input_data?.data_sources_info;
    if (dsi) dsi.intermediate_ds = this.intermediate_ds;
    return this.intermediate_ds;
  }

  /** 中间源名(供工具参数提示与 database_name 路由) */
  get intermediateName() {
    return this.intermediate_ds?.datasource_name || "";
  }

  /**
   * 渲染「## 中间结果」段(注入 system prompt;让模型知道有哪些 r_xxxx 表可被 JOIN/聚合)。
   * 跨问题追问场景靠这里(同 session 内 stateless-turn,messages 为空但 DuckDB 持久)。
   * @returns {Promise<string>}
   */
  async renderIntermediateSection() {
    if (!this.intermediate_ds) return "";
    let profiles = [];
    try {
      profiles = await this.intermediate_ds.profile();
    } catch {
      profiles = [];
    }
    if (profiles && profiles.length) {
      const body = profiles
        .map((p) => (typeof p.to_str === "function" ? p.to_str() : ""))
        .filter(Boolean)
        .join("\n");
      return (
        "## 中间结果\n" +
        `以下中间表已存在(可被 sql_scan_operator 以 database_name="${this.intermediateName}" 引用做 JOIN/聚合):\n` +
        body
      );
    }
    return (
      "## 中间结果\n" +
      `中间数据源 \`${this.intermediateName}\` 当前为空,子问题查询结果会自动存到这里供后续跨表查询。`
    );
  }

  /**
   * LLM 调 update_plan 时落到这里:① 内存(renderTaskPlan 即时用,权威进度)② 持久化到
   * analysis_plan_steps(E4;前端右栏 plan + 跨重启可见)。持久化 best-effort,失败不影响主流程。
   */
  async setTaskPlan(steps, { messageId = null } = {}) {
    this.taskPlan = Array.isArray(steps) ? steps : [];
    if (!this.sessionId) return;
    try {
      await PlanStepService.replacePlan(this.ctx, { sessionId: this.sessionId, messageId, steps: this.taskPlan });
    } catch (e) {
      console.error("[AnalysisSession setTaskPlan persist]", e?.message || e);
    }
  }

  /**
   * 标记某步骤完成/进行(E4);框架在工具成功落表后调用(query_tool_adapter afterToolCall),
   * 与 LLM 的 update_plan 重发互补。taskId 对齐持久化时的 task_id(update_plan 无显式 id 时为 step_<i>)。
   */
  async advanceTask(taskId, status, { intermediateTable = null } = {}) {
    for (const s of this.taskPlan) {
      const tid = s?.task_id ?? s?.taskId;
      if (tid && tid === taskId) {
        s.status = status;
        if (intermediateTable) s.intermediate_table = intermediateTable;
      }
    }
    if (!this.sessionId) return;
    try {
      await PlanStepService.advance(this.ctx, { sessionId: this.sessionId, taskId, status, intermediateTable });
    } catch (e) {
      console.error("[AnalysisSession advanceTask persist]", e?.message || e);
    }
  }

  /**
   * 收尾时把仍未完成的计划步骤统一标记为 done。
   * 这是框架级兜底,不依赖 LLM 在 complete 前再调用一次 update_plan。
   */
  async completeOpenTasks() {
    if (!Array.isArray(this.taskPlan) || !this.taskPlan.length) return [];
    let changed = false;
    this.taskPlan = this.taskPlan.map((step) => {
      const status = String(step?.status || "").toLowerCase();
      if (status === "done" || status === "completed" || status === "complete") return step;
      changed = true;
      return { ...step, status: "done" };
    });
    if (changed && this.sessionId) {
      try {
        await PlanStepService.completeOpen(this.ctx, { sessionId: this.sessionId });
      } catch (e) {
        console.error("[AnalysisSession completeOpenTasks persist]", e?.message || e);
      }
    }
    return this.taskPlan;
  }

  /**
   * 落地一张中间表(r_xxx)后,写一行会话级索引(E3;session_intermediate_tables)。
   * detail 仍以各 session 的 DuckDB _intermediate_metadata 为写真相源;这张索引让右栏面板 /
   * eval 不必逐个打开 DuckDB。由 landResult(待 E3 主流程接入)在落表成功后调用。
   */
  async recordIntermediateTable({
    tableName,
    messageId = null,
    planStepId = null,
    duckdbPath = null,
    description = null,
    rowCount = null,
    columnCount = null,
    columns = null,
    schemaPreview = null,
    subQuery = null,
    sqlQuery = null,
  }) {
    if (!this.sessionId || !tableName) return;
    try {
      await this.ctx.query(
        `INSERT INTO session_intermediate_tables
           (id, session_id, message_id, plan_step_id, table_name, duckdb_path, description,
            row_count, column_count, columns, schema_preview, sub_query, sql_query, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now(),now())`,
        [randomUUID(), this.sessionId, messageId, planStepId, tableName, duckdbPath, description,
          rowCount, columnCount, columns, schemaPreview, subQuery, sqlQuery],
      );
    } catch (e) {
      console.error("[AnalysisSession recordIntermediateTable]", e?.message || e);
    }
  }

  // ── handle-result 安全网(空护栏 / 硬错误 fail-fast / 步骤产出)。空≠失败:空结果不进 fail-fast ──

  /** 记一次空结果;返回是否与上次空的是同一 sub_query(同查询反复空 → 升级护栏)。 */
  noteEmptyResult(subQuery) {
    const q = String(subQuery || "").trim();
    const repeated = q !== "" && q === this.lastEmptyQuery;
    this.lastEmptyQuery = q;
    return { repeated };
  }

  /** 硬错误 fail-fast 双闸:同错误签名 ≥ MAX_HARD_ERROR_REPLANS 或累计 ≥ MAX_TOTAL_REPLANS 触发。空结果不调用此方法。 */
  bumpFailFast(reason) {
    const sig = AnalysisSession._errorSignature(reason);
    this.replanSigCounts[sig] = (this.replanSigCounts[sig] || 0) + 1;
    this.totalReplans += 1;
    const failFast =
      this.replanSigCounts[sig] >= AnalysisSession.MAX_HARD_ERROR_REPLANS ||
      this.totalReplans >= AnalysisSession.MAX_TOTAL_REPLANS;
    return { failFast, sigCount: this.replanSigCounts[sig], totalReplans: this.totalReplans };
  }

  /** 错误签名归一(去中间表名/数字/空白),让"同一错误反复"可识别(对齐 fail_fast.error_signature)。 */
  static _errorSignature(reason) {
    return String(reason || "")
      .replace(/r_[0-9a-f]+/gi, "r_X")
      .replace(/\d+/g, "N")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
  }

  /** 成功落表后记步骤产出(键用 sub_query 或 task_id),供下游依赖注入(P2)与可观测。 */
  recordStepOutput(key, output) {
    if (!key) return;
    const k = String(key);
    this.stepOutputs[k] = { ...(this.stepOutputs[k] || {}), ...output };
  }

  /** 真进展(成功有数据):清空查询护栏 + fail-fast 计数(对齐 SuperAgent._advance_task 清 churn)。 */
  resetChurn() {
    this.lastEmptyQuery = null;
    this.replanSigCounts = {};
    this.totalReplans = 0;
  }

  /** 渲染「## 任务计划」段(回灌 system prompt) */
  renderTaskPlan() {
    if (!this.taskPlan || !this.taskPlan.length) return "";
    const lines = this.taskPlan.map((s, i) => {
      const st = String(s?.status || "todo").toLowerCase();
      const mark = st === "done" ? "✅" : st === "doing" ? "▶️" : "⬜";
      const src = s?.source_kind
        ? ` [${s.source_kind}${s.source_name ? ":" + s.source_name : ""}]`
        : "";
      return `${mark} ${i + 1}. ${s?.title || ""}${src}`;
    });
    return "## 任务计划(权威进度,已完成步骤保持 done)\n" + lines.join("\n");
  }

  /** 累积 grep 探索到的表/列(对齐 SuperAgent._extract_schema_hint) */
  accumulateSchema({ tables = [], table_name = "", columns = [] } = {}) {
    for (const t of tables) {
      const tn = t && typeof t === "object" ? t.table_name : t;
      if (tn) this.schemaTables.add(tn);
    }
    if (table_name) {
      this.schemaTables.add(table_name);
      this.schemaColumns[table_name] = this.schemaColumns[table_name] || new Set();
      for (const c of columns) {
        const cn = c && typeof c === "object" ? c.column_name ?? c.name : c;
        if (cn) this.schemaColumns[table_name].add(cn);
      }
    }
  }

  /** 产出 schema_hint(注入 sql_scan_operator);无探索结果时返回 null */
  schemaHint() {
    if (!this.schemaTables.size && !Object.keys(this.schemaColumns).length) return null;
    const cols = {};
    for (const [tn, set] of Object.entries(this.schemaColumns)) cols[tn] = [...set];
    return { tables: [...this.schemaTables], columns: cols };
  }
}

export default AnalysisSession;
