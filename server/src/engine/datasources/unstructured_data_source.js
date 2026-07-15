// 迁移自 yiw_kernel/data_sources/datasource/unstructured_data_source.py(桌面精简版)
//
// 非结构化数据源:知识库文档的检索。
// - profile(): 列出该源下已处理完成的文档(每个文档作为一个"表",供 agent semantic_scan 按名读取)。
// - query(search_query):
//     · `Database:X Table:Y` 寻址 → 读文档 Y 的全部 chunk(semantic_scan 用)
//     · 自由查询 → vexdb 向量召回 top_k chunk(kb_search/RAG 用),embedding 缺失则 LIKE 关键词兜底
//
// chunk 存 unstructured_contents(embedding_content=切片文本,embedding=JSON 向量);
// 文档存 unstructured_documents(title/status,FK unstructured_data_source_id)。
// 桌面版混合检索暂只做向量(BM25 待 FTS5),与 Python 的 vector+bm25 hybrid 相比简化。

import { DataSource, QueryResult } from './data_source.js';
import { Profile, Column } from './profile.js';
import { query, queryOne, vectorReady } from '../../db.js';
import { embed } from '../core/llm.js';

const SCAN_RE = /^Database:\s*(.+?)\s+Table:\s*(.+)$/;

function safeMeta(m) {
  if (!m) return {};
  try { return typeof m === 'string' ? JSON.parse(m) : m; } catch { return {}; }
}

function normalizeSearchText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, '');
}

function tokenizeSearchQuery(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];
  const normalized = normalizeSearchText(raw);
  const pieces = raw
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);
  return [...new Set([normalized, ...pieces].filter((part) => part.length >= 2))];
}

function keywordScore(content, tokens) {
  if (!tokens.length) return 0;
  const compact = normalizeSearchText(content);
  if (!compact) return 0;
  let score = 0;
  for (const token of tokens) {
    if (compact.includes(token)) {
      score += Math.min(4, Math.max(1, token.length / 2));
    }
  }
  return Math.min(1, score / Math.max(1, tokens.length * 2));
}

export class UnstructuredDataSource extends DataSource {
  /**
   * @param {string} business_id
   * @param {string} project_id
   * @param {string} raw_id unstructured_data_source.id
   * @param {{source_id?:string}} [opts]
   */
  constructor(business_id, project_id, raw_id, { source_id = null } = {}) {
    super(source_id || raw_id, business_id, project_id, 'unstructured_data_source');
    this.raw_id = raw_id;
  }

  /** 该源下已处理完成的文档列表。 */
  async _documents() {
    return query(
      `SELECT id, title FROM unstructured_documents
        WHERE unstructured_data_source_id = $1 AND deleted_at IS NULL
          AND (status IS NULL OR status = 'completed')
        ORDER BY created_at DESC`,
      [this.raw_id],
    ).catch(() => []);
  }

  /** 每个文档作为一个 Profile(让 agent 知道有哪些文件可 semantic_scan)。 */
  async profile(_user_message = null) {
    const docs = await this._documents();
    const dsName = this.datasource_name || this.raw_id;
    if (!docs.length) {
      return [new Profile(dsName, '知识库', '非结构化知识库(暂无已处理文档)', 0, [], [], false)];
    }
    return docs.map((d) => new Profile(
      dsName, d.title, '非结构化文档(可整库语义扫描)', 1,
      [new Column('content', '文档切片内容', new Set(['str']))], [], false,
    ));
  }

  /**
   * 检索。`Database:X Table:Y` → 读文档全部 chunk;否则向量召回 top_k。
   * @param {string} search_query
   * @param {{top_k?:number}} [kwargs]
   * @returns {Promise<QueryResult>}
   */
  async query(search_query, kwargs = {}) {
    const top_k = kwargs.top_k ?? kwargs.topK ?? 5;
    try {
      const m = SCAN_RE.exec(String(search_query || ''));
      if (m) {
        const tblName = m[2].trim();
        const doc = await queryOne(
          `SELECT id FROM unstructured_documents
            WHERE unstructured_data_source_id = $1 AND title = $2 AND deleted_at IS NULL
            ORDER BY created_at DESC LIMIT 1`,
          [this.raw_id, tblName],
        ).catch(() => null);
        if (!doc) return QueryResult.error(`未找到指定的非结构化文档: ${tblName}`, search_query);
        const rows = await query(
          `SELECT content_index, embedding_content, token_count, meta_info
             FROM unstructured_contents WHERE document_id = $1 AND deleted_at IS NULL
            ORDER BY content_index ASC`,
          [doc.id],
        ).catch(() => []);
        const data = rows.map((r) => ({
          content_index: r.content_index, content: r.embedding_content, ...safeMeta(r.meta_info),
        }));
        return QueryResult.ok(data, data.length ? Object.keys(data[0]) : ['content'], data.length, '');
      }

      // 自由查询 → 向量召回
      const docs = await this._documents();
      if (!docs.length) return QueryResult.ok([], ['content'], 0, '知识库暂无文档');
      const docIds = docs.map((d) => d.id);
      let data = [];

      if (vectorReady) {
        const qvec = await embed(search_query, { project_id: this.project_id }).catch(() => null);
        if (qvec) {
          const rows = await query(
            `SELECT embedding_content AS content, content_index, document_id,
                    vexdb_cosine_distance(embedding, vexdb_f32($1)) AS distance
               FROM unstructured_contents
              WHERE document_id::text = ANY($2::text[]) AND embedding IS NOT NULL AND deleted_at IS NULL
              ORDER BY distance ASC LIMIT $3`,
            [JSON.stringify(qvec), docIds, top_k],
          ).catch((e) => { console.warn(`[Unstructured] 向量召回失败: ${e?.message ?? e}`); return []; });
          data = rows.map((r) => ({
            content: r.content, content_index: r.content_index, document_id: r.document_id,
            similarity: Math.max(0, 1 - Number(r.distance ?? 1)),
            retrieval_method: 'vector',
          }));
        }
      }

      // 兜底:关键词 LIKE
      if (!data.length) {
        const tokens = tokenizeSearchQuery(search_query);
        const rows = await query(
          `SELECT embedding_content AS content, content_index, document_id
             FROM unstructured_contents
            WHERE document_id::text = ANY($1::text[]) AND deleted_at IS NULL`,
          [docIds],
        ).catch(() => []);
        data = rows
          .map((r) => ({
            content: r.content,
            content_index: r.content_index,
            document_id: r.document_id,
            similarity: keywordScore(r.content, tokens),
            retrieval_method: 'keyword',
          }))
          .filter((r) => r.similarity > 0)
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, top_k);
      }

      return QueryResult.ok(data, data.length ? Object.keys(data[0]) : ['content'], data.length, '');
    } catch (e) {
      return QueryResult.error(String(e?.message ?? e), search_query);
    }
  }
}

export default UnstructuredDataSource;
