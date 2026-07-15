// few-shot SQL 样例向量生成(迁移补全 P4)。
// examples 召回(读)侧已迁移(example_retrieval_tool.js vexdb_cosine_distance),此前缺生产(写)侧:
// 插入样例不生成 embedding → 召回退化关键词。这里补 question 向量化写入 examples.embedding。

import { embed } from '../core/llm.js';
import { vectorReady, query } from '../../db.js';

const BATCH = 16;
const EMBEDDING_MODEL = 'text-embedding-v3';

/**
 * 为某项目下缺向量的样例批量生成 embedding(question 向量化)。
 * @param {string} projectId
 * @param {{onlyEmpty?:boolean}} [opts]
 * @returns {Promise<{total:number, embedded:number, skipped?:string}>}
 */
export async function embedExamples(projectId, { onlyEmpty = true } = {}) {
  if (!vectorReady) return { total: 0, embedded: 0, skipped: '向量扩展未加载' };
  const blank = onlyEmpty ? "AND (embedding IS NULL OR embedding = '')" : '';
  const rows = await query(
    `SELECT id, question FROM examples
      WHERE project_id=$1 AND deleted_at IS NULL ${blank}`,
    [projectId],
  ).catch(() => []);
  if (!rows.length) return { total: 0, embedded: 0 };

  let embedded = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    let vecs = [];
    try { vecs = await embed(chunk.map((r) => String(r.question || '')), { project_id: projectId }); }
    catch (e) { console.warn(`[example_embedding] embed 失败(batch ${i}): ${e?.message ?? e}`); break; }
    for (let j = 0; j < chunk.length; j += 1) {
      if (!vecs[j]) continue;
      await query(
        `UPDATE examples SET embedding=$1, embedding_model=$2, updated_at=now() WHERE id=$3`,
        [JSON.stringify(vecs[j]), EMBEDDING_MODEL, chunk[j].id],
      ).catch(() => {});
      embedded += 1;
    }
  }
  return { total: rows.length, embedded };
}

/**
 * 向量召回某项目下相似样例(供 examples/search 路由)。
 * @param {string} projectId
 * @param {string} queryText
 * @param {{topK?:number}} [opts]
 * @returns {Promise<Array<{id,question,content,description,distance}>>}
 */
export async function searchExamples(projectId, queryText, { topK = 5 } = {}) {
  if (!vectorReady || !queryText || !String(queryText).trim()) return [];
  let vec;
  try { vec = await embed(String(queryText), { project_id: projectId }); }
  catch { return []; }
  if (!Array.isArray(vec) || !vec.length) return [];
  return await query(
    `SELECT id, question, content, description, example_type,
            vexdb_cosine_distance(embedding, vexdb_f32($1)) AS distance
       FROM examples
      WHERE project_id=$2 AND deleted_at IS NULL AND embedding IS NOT NULL AND embedding != ''
      ORDER BY distance ASC LIMIT $3`,
    [JSON.stringify(vec), projectId, topK],
  ).catch(() => []);
}
