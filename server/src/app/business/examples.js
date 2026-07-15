// L1 应用/用例层 — 样例(Examples)CRUD + 向量。抽自 routes/business_crud.js,逻辑逐行对齐。
// 签名恒为 async fn(ctx, input) -> { data, message } | throw ApiError;不碰 req/res。
//
// 覆盖:
//   POST search                — 向量召回相似样例(已实现)
//   POST generate_embeddings   — 批量生成样例向量(已实现)
//   POST/PUT/DELETE /examples[/:eid]  (含批量 DELETE)
//
// 注:app/business/ 比 routes/ 深一层 → engine/db 用 ../../。
import { ApiError } from "../../errors.js";
import { embedExamples, searchExamples } from "../../engine/semantic/example_embedding.js";
import { assertBusiness } from "./business.js";

// ════════════════════════════════════════════
// Examples CRUD
// ════════════════════════════════════════════

// POST /api/projects/:pid/businesses/:bid/examples/search — 向量召回相似样例(迁移补全)
export async function searchExamplesUseCase(ctx, input) {
  const { pid, bid } = input.params;
  const b = await assertBusiness(pid, bid);
  if (!b) throw new ApiError("业务不存在", 404);
  const queryText = input.body?.query || input.body?.question || input.body?.user_message || "";
  const topK = Number(input.body?.top_k) > 0 ? Number(input.body.top_k) : 5;
  const items = await searchExamples(pid, queryText, { topK });
  return { data: { items, total: items.length }, message: "召回样例成功" };
}

// POST /api/projects/:pid/businesses/:bid/examples/generate_embeddings — 批量生成样例向量(迁移补全)
export async function generateExampleEmbeddings(ctx, input) {
  const { pid, bid } = input.params;
  const b = await assertBusiness(pid, bid);
  if (!b) throw new ApiError("业务不存在", 404);
  const onlyEmpty = input.body?.only_pending !== false;
  const r = await embedExamples(pid, { onlyEmpty });
  return { data: r, message: "样例向量生成完成" };
}

// POST /api/projects/:pid/businesses/:bid/examples — 批量创建样例
export async function createExamples(ctx, input) {
  const { pid, bid } = input.params;
  const b = await assertBusiness(pid, bid);
  if (!b) throw new ApiError("业务不存在", 404);
  const { example_type = "sql", examples, source_id, source_type } = input.body || {};
  if (!Array.isArray(examples) || !examples.length) throw new ApiError("examples 不能为空", 400);

  let created = 0;
  for (const ex of examples) {
    const { question, content, description } = ex;
    if (!question || !content) continue;
    const id = crypto.randomUUID();
    await ctx.query(
      `INSERT INTO examples
         (id, project_id, example_type, question, content, description,
          source_id, source_type, is_active, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,now(),now())`,
      [id, pid, example_type, question, content, description || null, source_id || null, source_type || null],
    );
    created++;
  }
  // 后台为新样例生成向量(不阻塞响应):召回靠 examples.embedding,缺则退化关键词。
  // 火后即返回:用 queueMicrotask 保留「先返回后台跑」语义。
  queueMicrotask(() => {
    embedExamples(pid).catch((e) =>
      console.warn(`[examples] 项目 ${pid} 样例向量生成失败: ${e?.message ?? e}`));
  });
  return { data: { created }, message: `成功创建 ${created} 条样例` };
}

// PUT /api/projects/:pid/businesses/:bid/examples/:eid — 更新样例
export async function updateExample(ctx, input) {
  const { pid, eid } = input.params;
  const existing = await ctx.queryOne(
    `SELECT id FROM examples WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [eid, pid],
  );
  if (!existing) throw new ApiError("样例不存在", 404);

  const { question, content, description, is_active } = input.body || {};
  const sets = ["updated_at=now()"];
  const vals = [];
  const add = (col, val) => { sets.push(`${col}=$${vals.length + 1}`); vals.push(val); };
  if (question !== undefined) add("question", question);
  if (content !== undefined) add("content", content);
  if (description !== undefined) add("description", description);
  if (is_active !== undefined) add("is_active", !!is_active);
  vals.push(eid);
  await ctx.query(`UPDATE examples SET ${sets.join(",")} WHERE id=$${vals.length}`, vals);
  const row = await ctx.queryOne(`SELECT * FROM examples WHERE id=$1`, [eid]);
  return { data: row, message: "更新成功" };
}

// DELETE /api/projects/:pid/businesses/:bid/examples — 批量删除样例
export async function deleteExamples(ctx, input) {
  const { pid } = input.params;
  const { example_ids } = input.body || {};
  if (!Array.isArray(example_ids) || !example_ids.length)
    throw new ApiError("example_ids 不能为空", 400);
  const existing = await ctx.query(
    `SELECT id FROM examples WHERE project_id=$1 AND id::text = ANY($2::text[]) AND deleted_at IS NULL`,
    [pid, example_ids],
  );
  const deleted_count = existing.length;
  if (deleted_count) {
    await ctx.query(
      `UPDATE examples SET deleted_at=now(), updated_at=now()
        WHERE project_id=$1 AND id::text = ANY($2::text[]) AND deleted_at IS NULL`,
      [pid, example_ids],
    );
  }
  return { data: { deleted_count }, message: `成功删除 ${deleted_count} 条样例` };
}
