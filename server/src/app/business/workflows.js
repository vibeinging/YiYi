// L1 应用/用例层 — SuperAgent Workflow 编排配置。
// 当前桌面 app 已去业务层:workflow 作为项目级资源挂在 /api/projects/:pid/superagent-workflows。
// 为兼容旧 dev 表结构,写库时保留 business_id=project_id。
import { ApiError } from "../../errors.js";

const nowIso = () => new Date().toISOString();

function pageParams(input) {
  const page = Math.max(1, Number.parseInt(input.query?.page || "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(input.query?.page_size || "20", 10) || 20));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeTrigger(trigger) {
  if (!trigger || typeof trigger !== "object" || Array.isArray(trigger)) {
    return { summary: "", examples: [] };
  }
  const summary = trigger.summary == null ? "" : String(trigger.summary);
  const examples = Array.isArray(trigger.examples)
    ? trigger.examples.map((e) => String(e || "").trim()).filter(Boolean)
    : [];
  return { summary, examples };
}

function validateGraph(graph) {
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) {
    throw new ApiError("workflow graph 必须是对象", 400);
  }
  if (!Array.isArray(graph.nodes)) throw new ApiError("workflow graph.nodes 必须是数组", 400);
  if (!Array.isArray(graph.edges)) throw new ApiError("workflow graph.edges 必须是数组", 400);
  const ids = new Set();
  for (const node of graph.nodes) {
    if (!node || typeof node !== "object") throw new ApiError("workflow 节点格式无效", 400);
    if (!node.id || !node.type) throw new ApiError("workflow 节点必须包含 id 和 type", 400);
    if (ids.has(node.id)) throw new ApiError(`workflow 节点 id 重复: ${node.id}`, 400);
    ids.add(node.id);
  }
  for (const edge of graph.edges) {
    if (!edge || typeof edge !== "object") throw new ApiError("workflow 边格式无效", 400);
    if (!edge.source || !edge.target) throw new ApiError("workflow 边必须包含 source 和 target", 400);
    if (graph.nodes.length && (!ids.has(edge.source) || !ids.has(edge.target))) {
      throw new ApiError(`workflow 边引用了不存在的节点: ${edge.source} -> ${edge.target}`, 400);
    }
  }
}

function workflowRow(row) {
  if (!row) return null;
  return {
    ...row,
    graph: parseJson(row.graph, { nodes: [], edges: [] }),
    trigger: normalizeTrigger(parseJson(row.trigger, {})),
    is_enabled: row.is_enabled === true || row.is_enabled === 1 || row.is_enabled === "1",
  };
}

function runRow(row) {
  if (!row) return null;
  return {
    ...row,
    input: parseJson(row.input, null),
    output: parseJson(row.output, null),
    graph_snapshot: parseJson(row.graph_snapshot, { nodes: [], edges: [] }),
    node_runs: parseJson(row.node_runs, []),
  };
}

async function getWorkflowRow(ctx, projectId, workflowId) {
  const row = await ctx.queryOne(
    `SELECT * FROM superagent_workflows
      WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [workflowId, projectId],
  );
  if (!row) throw new ApiError("workflow 不存在", 404);
  return row;
}

export async function createWorkflow(ctx, input) {
  const { pid } = input.params;
  const { name, graph, trigger, design_business_id } = input.body || {};
  const trimmedName = String(name || "").trim();
  if (!trimmedName) throw new ApiError("workflow 名称不能为空", 400);
  if (trimmedName.length > 255) throw new ApiError("workflow 名称过长", 400);
  validateGraph(graph);

  const id = crypto.randomUUID();
  const ts = nowIso();
  await ctx.query(
    `INSERT INTO superagent_workflows
       (id, project_id, business_id, name, graph, revision, design_business_id,
        trigger, is_enabled, source, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,1,$6,$7,1,'manual',$8,$9)`,
    [
      id,
      pid,
      pid,
      trimmedName,
      JSON.stringify(graph),
      design_business_id || null,
      JSON.stringify(normalizeTrigger(trigger)),
      ts,
      ts,
    ],
  );
  const row = await ctx.queryOne(`SELECT * FROM superagent_workflows WHERE id=$1`, [id]);
  return { data: workflowRow(row), message: "创建 workflow 成功" };
}

export async function listWorkflows(ctx, input) {
  const { pid } = input.params;
  const { page, pageSize, offset } = pageParams(input);
  const activeOnly = input.query?.active_only === true || input.query?.active_only === "true" || input.query?.active_only === "1";
  const where = ["project_id=$1", "deleted_at IS NULL"];
  const params = [pid];
  if (activeOnly) where.push("is_enabled=1");

  const whereSql = where.join(" AND ");
  const totalRow = await ctx.queryOne(
    `SELECT count(*) AS total FROM superagent_workflows WHERE ${whereSql}`,
    params,
  );
  const rows = await ctx.query(
    `SELECT * FROM superagent_workflows
      WHERE ${whereSql}
      ORDER BY updated_at DESC, created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset],
  );
  return {
    data: {
      items: rows.map(workflowRow),
      total: Number(totalRow?.total || 0),
      page,
      page_size: pageSize,
    },
    message: "获取 workflow 列表成功",
  };
}

export async function getWorkflow(ctx, input) {
  const { pid, workflowId } = input.params;
  const row = await getWorkflowRow(ctx, pid, workflowId);
  return { data: workflowRow(row), message: "获取 workflow 成功" };
}

export async function updateWorkflow(ctx, input) {
  const { pid, workflowId } = input.params;
  await getWorkflowRow(ctx, pid, workflowId);

  const body = input.body || {};
  const sets = ["updated_at=now()"];
  const vals = [];
  const add = (col, val) => {
    sets.push(`${col}=$${vals.length + 1}`);
    vals.push(val);
  };

  if (body.name !== undefined) {
    const trimmedName = String(body.name || "").trim();
    if (!trimmedName) throw new ApiError("workflow 名称不能为空", 400);
    if (trimmedName.length > 255) throw new ApiError("workflow 名称过长", 400);
    add("name", trimmedName);
  }
  if (body.graph !== undefined) {
    validateGraph(body.graph);
    add("graph", JSON.stringify(body.graph));
    sets.push("revision=COALESCE(revision,1)+1");
  }
  if (body.trigger !== undefined) add("trigger", JSON.stringify(normalizeTrigger(body.trigger)));
  if (body.design_business_id !== undefined) add("design_business_id", body.design_business_id || null);
  if (body.is_enabled !== undefined) add("is_enabled", body.is_enabled ? 1 : 0);

  if (sets.length === 1) throw new ApiError("没有可更新的字段", 400);
  vals.push(workflowId, pid);
  await ctx.query(
    `UPDATE superagent_workflows SET ${sets.join(", ")}
      WHERE id=$${vals.length - 1} AND project_id=$${vals.length} AND deleted_at IS NULL`,
    vals,
  );
  const row = await getWorkflowRow(ctx, pid, workflowId);
  return { data: workflowRow(row), message: "更新 workflow 成功" };
}

export async function deleteWorkflow(ctx, input) {
  const { pid, workflowId } = input.params;
  await getWorkflowRow(ctx, pid, workflowId);
  await ctx.query(`DELETE FROM superagent_workflow_runs WHERE workflow_id=$1`, [workflowId]);
  await ctx.query(
    `DELETE FROM superagent_workflows WHERE id=$1 AND project_id=$2`,
    [workflowId, pid],
  );
  return { data: null, message: "删除 workflow 成功" };
}

export async function triggerWorkflowRun(ctx, input) {
  const { pid, workflowId } = input.params;
  const { origin_session_id, query, resumed_from } = input.body || {};
  if (!origin_session_id) throw new ApiError("origin_session_id 不能为空", 400);
  if (!String(query || "").trim()) throw new ApiError("query 不能为空", 400);

  const wf = workflowRow(await getWorkflowRow(ctx, pid, workflowId));
  const id = crypto.randomUUID();
  const ts = nowIso();
  const error = "桌面端暂未迁入 WorkflowRuntime,当前仅支持工作流编排配置管理";
  await ctx.query(
    `INSERT INTO superagent_workflow_runs
       (id, workflow_id, business_id, origin_session_id, status, input, output, error,
        graph_snapshot, workflow_revision, node_runs, finished_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'failed',$5,NULL,$6,$7,$8,$9,$10,$11,$12)`,
    [
      id,
      workflowId,
      pid,
      origin_session_id,
      JSON.stringify({ workflow_id: workflowId, query, resumed_from: resumed_from || null }),
      error,
      JSON.stringify(wf.graph || { nodes: [], edges: [] }),
      wf.revision || 1,
      JSON.stringify([]),
      ts,
      ts,
      ts,
    ],
  );
  const row = await ctx.queryOne(`SELECT * FROM superagent_workflow_runs WHERE id=$1`, [id]);
  return { data: runRow(row), message: "workflow run 已记录" };
}

export async function listWorkflowRuns(ctx, input) {
  const { pid, workflowId } = input.params;
  await getWorkflowRow(ctx, pid, workflowId);
  const { page, pageSize, offset } = pageParams(input);
  const totalRow = await ctx.queryOne(
    `SELECT count(*) AS total FROM superagent_workflow_runs
      WHERE workflow_id=$1 AND deleted_at IS NULL`,
    [workflowId],
  );
  const rows = await ctx.query(
    `SELECT * FROM superagent_workflow_runs
      WHERE workflow_id=$1 AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3`,
    [workflowId, pageSize, offset],
  );
  return {
    data: {
      items: rows.map(runRow),
      total: Number(totalRow?.total || 0),
      page,
      page_size: pageSize,
    },
    message: "获取 run 列表成功",
  };
}

export async function getWorkflowRun(ctx, input) {
  const { runId } = input.params;
  const row = await ctx.queryOne(
    `SELECT * FROM superagent_workflow_runs WHERE id=$1 AND deleted_at IS NULL`,
    [runId],
  );
  if (!row) throw new ApiError("workflow run 不存在", 404);
  return { data: runRow(row), message: "获取 run 成功" };
}
