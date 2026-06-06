//! Pending user questions —— `ask_user` 工具的跨会话持久化层。
//!
//! 与 `permission_gate` 的纯内存 oneshot 不同:agent 调 `ask_user` 抛出的开放
//! 问题会**落一行到 `pending_questions`**。这样即便用户关掉 app(内存里等待的
//! oneshot 随运行结束蒸发),重开后前端仍能从本表把未答问题拉回来继续显示;
//! 用户答完后,下次同一 agent 再问"同一个问题"会命中**已答去重**直接读 answer,
//! 不再阻塞——这就是 F1 的"问题持久、等待可重建"。
//!
//! 详见 docs/design/2026-06-05_软件公司群聊-长程协作-设计.md §四 F1。

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

/// 一行待答 / 已答问题。`request_id` 同时是内存 oneshot map 的 key。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PendingQuestion {
    pub request_id: String,
    /// 发起提问的 chat 会话。群聊 / 协作里可能为空(用 collaboration_id 定位)。
    pub session_id: String,
    /// 若在协作中提问,关联的 collaboration(F1 暂为 None,留给 S2 项目模式)。
    pub collaboration_id: Option<i64>,
    /// 若在某个协作 step 中提问(留给 S2)。
    pub step_id: Option<i64>,
    /// 提问者 companion id(0 = YiYi 主精灵)。
    pub companion_id: i64,
    /// 提问者展示名(渲染气泡头像旁)。
    pub asker_name: String,
    pub question: String,
    /// 选项 JSON 数组(`["A","B"]`);为 None 表示开放文本输入。
    pub options_json: Option<String>,
    /// "choice"(给了选项) | "text"(自由输入) | 领域 kind。
    pub kind: String,
    /// "pending" | "answered"。
    pub status: String,
    pub answer: Option<String>,
    pub created_at: i64,
    pub answered_at: Option<i64>,
}

pub(super) fn map_row(row: &rusqlite::Row) -> rusqlite::Result<PendingQuestion> {
    Ok(PendingQuestion {
        request_id: row.get(0)?,
        session_id: row.get(1)?,
        collaboration_id: row.get(2)?,
        step_id: row.get(3)?,
        companion_id: row.get(4)?,
        asker_name: row.get(5)?,
        question: row.get(6)?,
        options_json: row.get(7)?,
        kind: row.get(8)?,
        status: row.get(9)?,
        answer: row.get(10)?,
        created_at: row.get(11)?,
        answered_at: row.get(12)?,
    })
}

pub(super) const SELECT_COLS: &str =
    "request_id, session_id, collaboration_id, step_id, companion_id, asker_name, \
     question, options_json, kind, status, answer, created_at, answered_at";

impl super::Database {
    /// 落一行待答问题(status='pending')。`ask_user` 在阻塞等待前调用,
    /// 保证问题在任何重启前已持久化。
    pub fn insert_pending_question(&self, q: &PendingQuestion) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute(
            "INSERT OR REPLACE INTO pending_questions
                (request_id, session_id, collaboration_id, step_id, companion_id, asker_name,
                 question, options_json, kind, status, answer, created_at, answered_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                q.request_id,
                q.session_id,
                q.collaboration_id,
                q.step_id,
                q.companion_id,
                q.asker_name,
                q.question,
                q.options_json,
                q.kind,
                q.status,
                q.answer,
                q.created_at,
                q.answered_at,
            ],
        )
        .map_err(|e| format!("insert_pending_question: {e}"))?;
        Ok(())
    }

    /// 拉某会话下所有未答问题(重开 app 恢复卡片用)。按提问时间升序。
    /// `session_id` 为空时拉全部未答(无会话上下文的兜底)。
    pub fn list_pending_questions(&self, session_id: &str) -> Vec<PendingQuestion> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let (sql, has_filter) = if session_id.is_empty() {
            (
                format!(
                    "SELECT {SELECT_COLS} FROM pending_questions \
                     WHERE status = 'pending' ORDER BY created_at ASC"
                ),
                false,
            )
        } else {
            (
                format!(
                    "SELECT {SELECT_COLS} FROM pending_questions \
                     WHERE status = 'pending' AND session_id = ?1 ORDER BY created_at ASC"
                ),
                true,
            )
        };
        let mut stmt = match conn.prepare(&sql) {
            Ok(s) => s,
            Err(e) => {
                log::warn!("list_pending_questions prepare: {e}");
                return Vec::new();
            }
        };
        let rows = if has_filter {
            stmt.query_map(params![session_id], map_row)
        } else {
            stmt.query_map([], map_row)
        };
        rows.map(|r| r.filter_map(|x| x.ok()).collect())
            .unwrap_or_default()
    }

    /// 标记某问题已答,写回 answer + answered_at。
    pub fn mark_question_answered(&self, request_id: &str, answer: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let now = super::now_ts();
        conn.execute(
            "UPDATE pending_questions
                SET status = 'answered', answer = ?1, answered_at = ?2
              WHERE request_id = ?3",
            params![answer, now, request_id],
        )
        .map_err(|e| format!("mark_question_answered: {e}"))?;
        Ok(())
    }

    /// 去重命中:同一会话(或协作)里**已答**过的同一问题文本,直接返回其答案。
    /// 这让 agent 在重启后重跑、再次 `ask_user` 同一问题时不再阻塞、直接拿答案。
    /// scope_key 即 session_id(空会话时上层会传 `collab_<id>` 之类)。
    pub fn find_answered_question(&self, scope_key: &str, question: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            "SELECT answer FROM pending_questions
              WHERE session_id = ?1 AND question = ?2 AND status = 'answered' AND answer IS NOT NULL
              ORDER BY answered_at DESC LIMIT 1",
            params![scope_key, question],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten()
    }

    /// 取单行(命令层校验 / 测试用)。
    pub fn get_pending_question(&self, request_id: &str) -> Option<PendingQuestion> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let sql = format!("SELECT {SELECT_COLS} FROM pending_questions WHERE request_id = ?1");
        conn.query_row(&sql, params![request_id], map_row).ok()
    }
}
