// 迁移自 yiw_kernel/semantic_catalogs/unstructured_data/document_processing_service.py(桌面精简版)
//
// 文档处理流水线:load(提取文本) → split(分块) → embed(向量化) → store(存 unstructured_contents)
// → 更新 unstructured_documents.status/chunk_count。失败置 status='failed' + error_msg,不抛。

import { randomUUID } from 'node:crypto';
import { sqlite, query, queryOne } from '../../../db.js';
import { embed } from '../../core/llm.js';
import { loadDocument } from './document_loaders.js';
import { splitText } from './text_splitter.js';
import { latestResourceJob, updateBackgroundJob } from '../../jobs/background_jobs.js';

// 增量进度的 embed 批大小(粗于 embed 内部的 10,够细到能看进度即可)。
const _EMBED_PROGRESS_BATCH = 20;

function setStatus(id, status, progress, errorMsg = null) {
  try {
    sqlite.prepare(
      `UPDATE unstructured_documents SET status=?, progress=?, error_msg=?, updated_at=? WHERE id=?`,
    ).run(status, progress, errorMsg, new Date().toISOString(), id);
  } catch { /* 状态更新失败不致命 */ }
}

export function embeddingResultStatus(vectors, errors = []) {
  const total = Array.isArray(vectors) ? vectors.length : 0;
  const generated = Array.isArray(vectors) ? vectors.filter((item) => Array.isArray(item) && item.length > 0).length : 0;
  if (total > 0 && generated === total) {
    return { status: 'completed', success: true, error: null, generated, total };
  }
  const detail = errors.find(Boolean) || '未生成向量,请检查项目的嵌入模型配置后重试';
  if (generated > 0) {
    return {
      status: 'embedding_partial',
      success: false,
      error: `仅完成 ${generated}/${total} 个切片的向量生成: ${detail}`,
      generated,
      total,
    };
  }
  return { status: 'embedding_failed', success: false, error: detail, generated, total };
}

export class DocumentProcessingService {
  /**
   * 处理单个文档(整条 ingest 流水线)。
   * @param {string} documentId unstructured_documents.id
   * @param {{chunkSize?:number, chunkOverlap?:number, projectId?:string}} [opts]
   * @returns {Promise<{success:boolean, chunk_count?:number, message:string}>}
   */
  static async processDocument(documentId, { chunkSize = 512, chunkOverlap = 50, projectId = null, jobId = null } = {}) {
    const doc = await queryOne(
      `SELECT id, file_path, file_ext, title, project_id FROM unstructured_documents
        WHERE id = $1 AND deleted_at IS NULL`,
      [documentId],
    ).catch(() => null);
    if (!doc) {
      if (jobId) updateBackgroundJob(jobId, { status: 'failed', error_code: 'document_not_found', error_message: '文档不存在', finished_at: new Date().toISOString() });
      return { success: false, message: '文档不存在' };
    }

    try {
      if (jobId) updateBackgroundJob(jobId, { status: 'running', progress: 5, started_at: new Date().toISOString(), incrementAttempt: true });
      setStatus(documentId, 'processing', 10);
      // 1) 提取文本
      const text = await loadDocument(doc.file_path, doc.file_ext);
      if (!text || !String(text).trim()) {
        setStatus(documentId, 'failed', 0, '文档内容为空或无法提取');
        if (jobId) updateBackgroundJob(jobId, { status: 'failed', error_code: 'empty_document', error_message: '文档内容为空或无法提取', finished_at: new Date().toISOString() });
        return { success: false, message: '文档内容为空或无法提取' };
      }
      // 2) 分块
      const chunks = splitText(text, { chunkSize, chunkOverlap });
      if (!chunks.length) {
        setStatus(documentId, 'failed', 0, '文本分块为空');
        if (jobId) updateBackgroundJob(jobId, { status: 'failed', error_code: 'empty_chunks', error_message: '文本分块为空', finished_at: new Date().toISOString() });
        return { success: false, message: '文本分块为空' };
      }
      setStatus(documentId, 'embedding', 40);
      // 3) 向量化:按批 embed + 增量更新 progress(40→95),让后台任务可被轮询观测;
      //    单批失败仅该批降级为纯文本(无向量),不拖垮整篇。
      const vecs = new Array(chunks.length).fill(null);
      const embeddingErrors = [];
      for (let i = 0; i < chunks.length; i += _EMBED_PROGRESS_BATCH) {
        const group = chunks.slice(i, i + _EMBED_PROGRESS_BATCH);
        try {
          const gv = await embed(group, { project_id: projectId || doc.project_id });
          for (let j = 0; j < group.length; j += 1) vecs[i + j] = gv[j] ?? null;
        } catch (e) {
          const message = String(e?.message ?? e);
          embeddingErrors.push(message);
          console.warn(`[DocProcessing] embed 批失败(${i}~${i + group.length}),该批仅存文本: ${message}`);
        }
        const done = Math.min(i + group.length, chunks.length);
        setStatus(documentId, 'embedding', 40 + Math.floor((done / chunks.length) * 55));
      }
      // 4) 落库(先清旧 chunk 再插)
      sqlite.prepare(`DELETE FROM unstructured_contents WHERE document_id = ?`).run(documentId);
      const now = new Date().toISOString();
      const ins = sqlite.prepare(
        `INSERT INTO unstructured_contents
           (id, document_id, content_index, content_size, token_count, embedding_content, embedding, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      );
      chunks.forEach((c, i) => {
        const vec = vecs[i];
        ins.run(randomUUID(), documentId, i, c.length, Math.ceil(c.length / 2), c, vec ? JSON.stringify(vec) : null, now, now);
      });
      // 5) 只有全部切片都生成向量才算真正完成。解析成功但向量失败时保留切片,
      //    同时暴露可重试状态,避免 Agent 和 UI 把“可读文本”误报成“知识库已就绪”。
      const embeddingResult = embeddingResultStatus(vecs, embeddingErrors);
      sqlite.prepare(
        `UPDATE unstructured_documents SET status=?, chunk_count=?, progress=100, error_msg=?, updated_at=? WHERE id=?`,
      ).run(embeddingResult.status, chunks.length, embeddingResult.error, now, documentId);

      if (jobId) updateBackgroundJob(jobId, embeddingResult.success ? {
        status: 'completed', progress: 100, result_json: { document_id: documentId, chunk_count: chunks.length, embedding_count: embeddingResult.generated }, finished_at: now,
      } : {
        status: 'blocked_configuration', progress: 100, error_code: 'embedding_unavailable', error_message: embeddingResult.error, result_json: { document_id: documentId, chunk_count: chunks.length, embedding_count: embeddingResult.generated }, finished_at: now,
      });

      return {
        success: embeddingResult.success,
        status: embeddingResult.status,
        chunk_count: chunks.length,
        embedding_count: embeddingResult.generated,
        message: embeddingResult.success
          ? `处理完成,共 ${chunks.length} 个切片`
          : embeddingResult.error,
      };
    } catch (e) {
      setStatus(documentId, 'failed', 0, String(e?.message ?? e));
      if (jobId) updateBackgroundJob(jobId, { status: 'failed', error_code: 'document_processing_failed', error_message: String(e?.message ?? e), finished_at: new Date().toISOString() });
      return { success: false, message: String(e?.message ?? e) };
    }
  }
}

// 进程内串行后台队列:detach 文档处理,不阻塞 HTTP 响应。
// 串行(而非并发)避免多文档同时上传时一起 embed 把 DashScope 打爆;桌面单用户串行足够。
// processDocument 自身全程 try/catch + 写 status,这里再兜一层 catch 保证队列不被单篇失败打断。
let _processChain = Promise.resolve();

/**
 * 把文档处理排进后台串行队列,立即返回该任务的 Promise(调用方一般 fire-and-forget)。
 * @param {string} documentId
 * @param {{chunkSize?:number, chunkOverlap?:number, projectId?:string}} [opts]
 * @returns {Promise<{success:boolean, chunk_count?:number, message:string}>}
 */
export function enqueueProcessDocument(documentId, opts = {}) {
  const run = () => DocumentProcessingService.processDocument(documentId, opts);
  const task = _processChain.then(run, run);
  _processChain = task.catch(() => {});
  return task;
}

/**
 * 启动续跑:扫描上次进程退出时卡在中途的文档，重新排进后台串行队列。
 * 文档处理是离线任务，App 重启后继续执行。
 */
export async function resumePendingDocuments() {
  try {
    const rows = await query(
      `SELECT id, project_id FROM unstructured_documents
        WHERE status IN ('pending','processing','embedding') AND deleted_at IS NULL
        ORDER BY created_at ASC`,
      [],
    ).catch(() => []);
    if (!rows.length) return 0;
    console.info(`[DocProcessing] 启动续跑:${rows.length} 个未完成文档重新入队`);
    for (const row of rows) {
      const job = latestResourceJob('unstructured_document', row.id);
      enqueueProcessDocument(row.id, { projectId: row.project_id, jobId: job?.id || null })
        .catch((e) => console.warn(`[DocProcessing] 续跑文档 ${row.id} 失败: ${e?.message ?? e}`));
    }
    return rows.length;
  } catch (e) {
    console.warn(`[DocProcessing] 启动续跑扫描失败: ${e?.message ?? e}`);
    return 0;
  }
}

/**
 * 嵌入模型创建或恢复后，自动重试此前仅向量阶段失败的文档。
 * 不重试普通 failed（解析错误/空文件），避免无意义循环；每次模型变更只入队一次。
 */
export async function resumeEmbeddingFailedDocuments() {
  try {
    const rows = await query(
      `SELECT id, project_id FROM unstructured_documents
        WHERE status IN ('embedding_failed','embedding_partial') AND deleted_at IS NULL
        ORDER BY updated_at ASC`,
      [],
    ).catch(() => []);
    if (!rows.length) return 0;
    console.info(`[DocProcessing] 嵌入模型可用后自动重试:${rows.length} 个文档重新入队`);
    for (const r of rows) {
      setStatus(r.id, 'pending', 0, null);
      const job = latestResourceJob('unstructured_document', r.id);
      if (job) updateBackgroundJob(job.id, { status: 'queued', progress: 0, error_code: null, error_message: null, finished_at: null });
      enqueueProcessDocument(r.id, { projectId: r.project_id, jobId: job?.id || null })
        .catch((e) => console.warn(`[DocProcessing] 自动重试文档 ${r.id} 失败: ${e?.message ?? e}`));
    }
    return rows.length;
  } catch (e) {
    console.warn(`[DocProcessing] 向量失败文档扫描失败: ${e?.message ?? e}`);
    return 0;
  }
}

export default DocumentProcessingService;
