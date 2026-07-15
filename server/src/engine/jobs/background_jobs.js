import { randomUUID } from 'node:crypto';
import { sqlite } from '../../db.js';
import { appendMessages } from '../agents/sessionStore.js';

const TERMINAL = new Set(['completed', 'failed', 'failed_permanent', 'blocked_configuration', 'cancelled']);
const retryTimers = new Map();

function parseJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

export function jobShape(row) {
  if (!row) return null;
  return {
    ...row,
    progress: Number(row.progress || 0),
    attempt_count: Number(row.attempt_count || 0),
    max_attempts: Number(row.max_attempts || 0),
    result: parseJson(row.result_json),
  };
}

export function createBackgroundJob({ projectId, sessionId = null, userId = null, kind, resourceType, resourceId, maxAttempts = 3 }) {
  const id = randomUUID();
  const now = new Date().toISOString();
  sqlite.prepare(
    `INSERT INTO background_jobs
      (id,project_id,session_id,user_id,kind,resource_type,resource_id,status,progress,attempt_count,max_attempts,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,'queued',0,0,?,?,?)`,
  ).run(id, projectId || null, sessionId, userId, kind, resourceType, resourceId, maxAttempts, now, now);
  return getBackgroundJob(id);
}

export function updateBackgroundJob(id, patch = {}) {
  const before = getBackgroundJob(id);
  const allowed = ['status', 'progress', 'error_code', 'error_message', 'result_json', 'started_at', 'finished_at', 'next_retry_at'];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (!(key in patch)) continue;
    sets.push(`${key}=?`);
    const value = key === 'result_json' && patch[key] != null && typeof patch[key] !== 'string'
      ? JSON.stringify(patch[key])
      : patch[key];
    params.push(value);
  }
  if (patch.incrementAttempt) sets.push('attempt_count=attempt_count+1');
  sets.push('updated_at=?');
  params.push(new Date().toISOString(), id);
  sqlite.prepare(`UPDATE background_jobs SET ${sets.join(',')} WHERE id=?`).run(...params);
  const after = getBackgroundJob(id);
  if (after?.session_id && TERMINAL.has(after.status) && !TERMINAL.has(before?.status)) {
    publishBackgroundJobEvent(after);
  }
  return after;
}

export function publishBackgroundJobEvent(job) {
  if (!job?.session_id) return false;
  const summary = {
    type: 'background_job_event',
    job_id: job.id,
    kind: job.kind,
    status: job.status,
    progress: job.progress,
    resource_type: job.resource_type,
    resource_id: job.resource_id,
    error_code: job.error_code || null,
    error_message: job.error_message || null,
    result: job.result || null,
  };
  const eventId = randomUUID();
  const eventKey = `${job.attempt_count}:${job.status}`;
  const now = new Date().toISOString();
  const inserted = sqlite.prepare(
    `INSERT OR IGNORE INTO background_job_events
      (id,job_id,session_id,event_key,payload_json,consume_status,created_at,updated_at)
     VALUES (?,?,?,?,?,'pending',?,?)`,
  ).run(eventId, job.id, job.session_id, eventKey, JSON.stringify(summary), now, now);
  if (inserted.changes !== 1) return false;
  const text = `[后台任务事件]\n${JSON.stringify(summary)}`;
  appendMessages(job.session_id, [
    { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() },
  ]);

  const seq = Number(sqlite.prepare(
    `SELECT COALESCE(MAX(sequence_number),0) AS m FROM session_messages WHERE session_id=?`,
  ).get(job.session_id)?.m || 0) + 1;
  const visible = job.status === 'completed'
    ? `后台任务已完成。\n\n任务 ID：\`${job.id}\``
    : job.status === 'blocked_configuration'
      ? `后台任务需要补充配置后继续。\n\n${job.error_message || '请检查相关配置。'}\n\n任务 ID：\`${job.id}\``
      : `后台任务处理失败。\n\n${job.error_message || '请查看任务详情。'}\n\n任务 ID：\`${job.id}\``;
  sqlite.prepare(
    `INSERT INTO session_messages (id,session_id,role,content_items,message_metadata,sequence_number,created_at,updated_at)
     VALUES (?,?,'assistant',?,?,?,now(),now())`,
  ).run(
    randomUUID(),
    job.session_id,
    JSON.stringify([{ type: 'markdown', content: visible, metadata: summary }]),
    JSON.stringify({ source: 'background_job', background_job: summary }),
    seq,
  );
  sqlite.prepare(
    `UPDATE sessions SET updated_at=now(), message_count=COALESCE(message_count,0)+1 WHERE id=?`,
  ).run(job.session_id);
  return true;
}

function parseEvent(row) {
  if (!row) return null;
  return { ...row, payload: parseJson(row.payload_json) };
}

export function claimSessionBackgroundJobEvents(sessionId, limit = 10) {
  if (!sessionId) return [];
  const staleBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const rows = sqlite.prepare(
    `SELECT * FROM background_job_events
      WHERE session_id=? AND (consume_status='pending' OR (consume_status='processing' AND claimed_at<?))
      ORDER BY created_at ASC LIMIT ?`,
  ).all(sessionId, staleBefore, Math.max(1, Math.min(50, Number(limit) || 10)));
  if (!rows.length) return [];
  const now = new Date().toISOString();
  const ids = rows.map((row) => row.id);
  const placeholders = ids.map(() => '?').join(',');
  sqlite.prepare(
    `UPDATE background_job_events SET consume_status='processing', claimed_at=?, updated_at=?
      WHERE id IN (${placeholders}) AND consume_status IN ('pending','processing')`,
  ).run(now, now, ...ids);
  return rows.map(parseEvent);
}

export function completeBackgroundJobEvents(ids = []) {
  if (!ids.length) return 0;
  const placeholders = ids.map(() => '?').join(',');
  const now = new Date().toISOString();
  return sqlite.prepare(
    `UPDATE background_job_events SET consume_status='consumed', consumed_at=?, updated_at=? WHERE id IN (${placeholders})`,
  ).run(now, now, ...ids).changes;
}

export function releaseBackgroundJobEvents(ids = []) {
  if (!ids.length) return 0;
  const placeholders = ids.map(() => '?').join(',');
  return sqlite.prepare(
    `UPDATE background_job_events SET consume_status='pending', claimed_at=NULL, updated_at=? WHERE id IN (${placeholders}) AND consume_status='processing'`,
  ).run(new Date().toISOString(), ...ids).changes;
}

export function getBackgroundJob(id) {
  return jobShape(sqlite.prepare(`SELECT * FROM background_jobs WHERE id=? AND deleted_at IS NULL`).get(id));
}

export function latestResourceJob(resourceType, resourceId) {
  return jobShape(sqlite.prepare(
    `SELECT * FROM background_jobs WHERE resource_type=? AND resource_id=? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
  ).get(resourceType, resourceId));
}

export function listBlockedBackgroundJobs(kind) {
  const rows = sqlite.prepare(
    `SELECT * FROM background_jobs
      WHERE status='blocked_configuration' AND kind=? AND deleted_at IS NULL
      ORDER BY updated_at ASC`,
  ).all(kind);
  return rows.map(jobShape);
}

export function listIncompleteBackgroundJobs(kind) {
  const rows = sqlite.prepare(
    `SELECT * FROM background_jobs
      WHERE status IN ('queued','running','retry_wait','partial') AND kind=? AND deleted_at IS NULL
      ORDER BY updated_at ASC`,
  ).all(kind);
  return rows.map(jobShape);
}

export function classifyBackgroundJobError(error) {
  const message = String(error?.message || error || '未知错误');
  const status = Number(error?.status || error?.statusCode || 0);
  const code = String(error?.code || '');
  if (/未配置.*(?:嵌入|模型)|embedding.*(?:missing|unavailable)|api.?key.*(?:missing|不能为空)/i.test(message)) {
    return { category: 'configuration', code: 'configuration_required', retryable: false, message };
  }
  if (status === 429 || status >= 500 || /429|rate.?limit|timeout|timed.?out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|fetch failed|temporar|暂时/i.test(`${code} ${message}`)) {
    return { category: 'transient', code: code || (status ? `http_${status}` : 'temporary_failure'), retryable: true, message };
  }
  if (/unsupported|不支持.*(?:格式|文件)|corrupt|损坏|invalid file/i.test(message)) {
    return { category: 'permanent', code: code || 'permanent_failure', retryable: false, message };
  }
  return { category: 'failure', code: code || 'background_job_failed', retryable: false, message };
}

export function scheduleBackgroundJobRetry(jobId, resume, { delayMs = 2000 } = {}) {
  if (retryTimers.has(jobId)) clearTimeout(retryTimers.get(jobId));
  const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
  updateBackgroundJob(jobId, { status: 'retry_wait', next_retry_at: nextRetryAt, finished_at: null });
  const timer = setTimeout(async () => {
    retryTimers.delete(jobId);
    const job = getBackgroundJob(jobId);
    if (job?.status !== 'retry_wait') return;
    try { await resume(job); }
    catch (error) {
      updateBackgroundJob(jobId, {
        status: 'failed', error_code: 'retry_resume_failed', error_message: error?.message || String(error),
        finished_at: new Date().toISOString(), next_retry_at: null,
      });
    }
  }, Math.max(0, delayMs));
  timer.unref?.();
  return getBackgroundJob(jobId);
}

export function cancelBackgroundJob(jobId) {
  const job = getBackgroundJob(jobId);
  if (!job || TERMINAL.has(job.status)) return job;
  if (retryTimers.has(jobId)) clearTimeout(retryTimers.get(jobId));
  retryTimers.delete(jobId);
  return updateBackgroundJob(jobId, {
    status: 'cancelled', error_code: 'cancelled_by_user', error_message: '任务已由用户取消',
    progress: job.progress, finished_at: new Date().toISOString(), next_retry_at: null,
  });
}
