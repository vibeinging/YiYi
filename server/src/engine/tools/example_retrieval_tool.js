// 迁移自 yiw_kernel/data_analyze/planner/dbagents/tools/example_retrieval_tool.py
/**
 * Example Retrieval Tool - 样例召回工具。
 * 从 examples 表召回与用户问题相似的历史 SQL 样例,供 LLM 参考。
 *
 * 注:Python 走 BusinessExampleService(向量召回),该服务未迁移。本版直查 examples 表
 * (经注入 ctx)。召回优先走真·向量召回(vexdb_cosine_distance + examples.embedding),
 * embedding 缺失/向量扩展未加载/无 EMBEDDING 模型时回退关键词打分排序。
 * demo 业务无样例时返回空,行为与 Python 一致。
 */
import { BaseTool, Result } from '../core/base_tool.js';
import { t } from '../utils/i18n.js';
import { query, vectorReady } from '../../db.js';
import { embed } from '../core/llm.js';

const logger = {
  info: (...a) => console.info('[ExampleRetrieval]', ...a),
  error: (...a) => console.error('[ExampleRetrieval]', ...a),
};

function tokenize(s) {
  const str = String(s || '').toLowerCase();
  const out = new Set();
  for (const m of str.matchAll(/[a-z0-9_]+/g)) if (m[0].length > 1) out.add(m[0]);
  for (const ch of str) if (/[一-鿿]/.test(ch)) out.add(ch);
  return out;
}

/**
 * 把问题向量化(供 vexdb_cosine_distance 召回)。任何失败(无 EMBEDDING 模型/
 * 扩展未加载/空问题)返回 null → 调用方回退关键词召回。
 * @returns {Promise<number[]|null>}
 */
async function embedQuestion(question, project_id = null) {
  if (!vectorReady || !question || !String(question).trim()) return null;
  try {
    const v = await embed(question, { project_id });
    return Array.isArray(v) && v.length ? v : null;
  } catch (e) {
    logger.error(`embed 失败,回退关键词召回: ${e?.message ?? e}`);
    return null;
  }
}

export class ExampleRetrievalTool extends BaseTool {
  constructor() {
    super('example_retrieval', '召回相似的历史SQL样例，为LLM提供参考', {
      supported_task_types: ['nl2sql', 'sql_supervision'], version: '1.0.0', author: 'System',
    });
  }

  /** @param {import('../core/agent_context.js').AgentContext} context */
  async execute(context, kwargs = {}) {
    try {
      const database_id = kwargs.database_id;
      // 去业务层:project_id 作 scope(fallback 兼容旧 input_data.business_id,值与 project_id 相同)
      const project_id = kwargs.project_id || context?.project_id || context?.input_data?.business_id || kwargs.user_id;
      const user_message = kwargs.user_message ?? '';
      const top_k = kwargs.top_k ?? 3;

      if (!project_id && !database_id) return Result.createError('缺少 project_id 或 database_id 参数');
      if (!project_id) return Result.createError('缺少 project_id 参数');

      const [examples, examples_text] = await this._recall_examples_with_raw({ project_id, database_id, question: user_message, top_k });

      if (!examples.length) {
        return Result.create({ examples: [], examples_text: '', examples_found: 0 }, t('样例库为空或未找到相似样例'));
      }
      logger.info(`成功召回 ${examples.length} 个样例`);
      return Result.create({ examples, examples_text, examples_found: examples.length }, t('成功召回{}个样例', examples.length));
    } catch (e) {
      logger.error(`样例召回失败: ${e?.message ?? e}`);
      return Result.createError(`样例召回失败: ${e?.message ?? e}`);
    }
  }

  async _recall_examples_with_raw({ project_id, database_id, question, top_k = 3 }) {
    try {
      if (!project_id) {
        // 样例召回必须有 project_id(与 Python 一致)
        throw new Error(t('样例召回需要 project_id，但当前只有 database_id={}', database_id));
      }

      // ① 优先真·向量召回(vexdb_cosine_distance);失败/无 embedding 回退关键词
      const qvec = await embedQuestion(question, project_id);
      if (qvec) {
        const vectorExamples = await this._vectorRecallExamples({ project_id, queryVec: qvec, top_k });
        if (vectorExamples.length) {
          logger.info(`向量召回(vexdb): ${vectorExamples.length} 个样例`);
          return [vectorExamples, this._format_examples(vectorExamples)];
        }
      }

      // ② 关键词兜底(无向量结果时)
      const rows = await query(
        `SELECT id, question, content, description, example_type FROM examples
          WHERE project_id = $1 AND COALESCE(is_active, 1) <> 0 AND deleted_at IS NULL`,
        [project_id],
      ).catch(() => []);
      if (!rows.length) return [[], ''];

      // 关键词打分(降级版,无 embedding 时的相似度近似)
      const qtok = tokenize(question);
      const scored = rows.map((r) => {
        const rtok = tokenize(r.question);
        let hits = 0;
        for (const tk of qtok) if (rtok.has(tk)) hits += 1;
        const denom = Math.max(qtok.size, 1);
        const similarity = String(r.question || '').trim() === String(question || '').trim() ? 1.0 : hits / denom;
        return { ...r, similarity };
      }).sort((a, b) => b.similarity - a.similarity).slice(0, top_k);

      const examples = scored.filter((e) => e.similarity > 0);
      if (!examples.length) return [[], ''];
      return [examples, this._format_examples(examples)];
    } catch (e) {
      logger.error(`样例召回失败，返回空: ${e?.message ?? e}`);
      return [[], ''];
    }
  }

  /**
   * vexdb_cosine_distance 向量召回样例:对该业务下有 embedding 的样例按余弦距离升序取 top-N。
   * similarity = max(0, 1 - distance),与关键词路径返回结构一致(下游/_format_examples 依赖)。
   * SQL 失败(扩展未加载/列不存在)返回空 → 调用方回退关键词。
   * @returns {Promise<Array<object>>}
   */
  async _vectorRecallExamples({ project_id, queryVec, top_k = 3 }) {
    const rows = await query(
      `SELECT id, question, content, description, example_type,
              vexdb_cosine_distance(embedding, vexdb_f32($1)) AS distance
         FROM examples
        WHERE project_id = $2 AND COALESCE(is_active, 1) <> 0
          AND embedding IS NOT NULL AND deleted_at IS NULL
        ORDER BY distance ASC
        LIMIT $3`,
      [JSON.stringify(queryVec), project_id, top_k],
    ).catch((e) => { logger.error(`向量召回样例 SQL 失败: ${e?.message ?? e}`); return []; });

    return rows
      .map((r) => ({
        id: r.id,
        question: r.question,
        content: r.content,
        description: r.description,
        example_type: r.example_type,
        similarity: Math.max(0, 1.0 - Number(r.distance ?? 1)),
      }))
      .filter((e) => e.similarity > 0);
  }

  _format_examples(examples) {
    if (!examples || !examples.length) return '';
    const max_similarity = examples.reduce((m, e) => Math.max(m, e.similarity ?? 0), 0);
    const has_high_similarity = max_similarity > 0.9;
    const formatted_parts = [];
    let i = 0;
    for (const example of examples) {
      i += 1;
      const similarity = example.similarity ?? 0;
      const question = String(example.question || '').trim();
      let content = example.content || example.sql || '';
      content = content ? String(content).trim() : '';
      if (!question || !content || similarity < 0.8) continue;
      formatted_parts.push(`### 参考样例 ${i}（相似度：${similarity.toFixed(2)}）\n问题：${question}\n答案：${content}\n`);
    }
    if (!formatted_parts.length) return '';
    const body = formatted_parts.join('\n');
    if (has_high_similarity) {
      return '## 相关示例（重要参考）\n⚠️ **发现高度相似的历史样例（相似度>90%）**\n'
        + '**重要：请优先参考以下SQL写法，保持相似的查询结构和逻辑！**\n\n' + body;
    }
    return `## 相关示例（重要参考）\n${body}`;
  }

  validate_params(kwargs = {}) {
    const { project_id, database_id, user_id } = kwargs;
    const has_source = (typeof project_id === 'string' && project_id.length > 0)
      || (typeof database_id === 'string' && database_id.length > 0);
    const has_project = (typeof project_id === 'string' && project_id.length > 0)
      || (typeof user_id === 'string' && user_id.length > 0);
    return has_source && has_project;
  }
}

export default ExampleRetrievalTool;
