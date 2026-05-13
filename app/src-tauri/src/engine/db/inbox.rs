use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

/// Growth V3 Inbox: agent-proposed growth drafts pending user review.
///
/// pending items do NOT affect runtime behavior — they're parked here until
/// the user approves, edits, or rejects them. See docs/design/2026-05-11_growth-v3-白盒共建.md.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InboxItem {
    pub id: String,
    /// 'skill_create' | 'skill_merge' | 'skill_archive' | 'principle_add'
    pub kind: String,
    /// 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'edited'
    pub status: String,
    /// JSON draft body — structure varies by kind.
    pub draft_json: String,
    /// 'meditation' | 'user_request'
    pub source: String,
    /// Human-readable reason for the proposal.
    pub reason: String,
    /// agent self-assessed confidence in the draft (0.0-1.0).
    pub confidence: f64,
    /// JSON evidence (session_ids, hit counts, ...).
    pub evidence_json: Option<String>,
    pub created_at: i64,
    pub reviewed_at: Option<i64>,
    pub applied_at: Option<i64>,
    /// 'approve' | 'reject' | 'edit_approve' | 'withdraw'
    pub user_action: Option<String>,
    pub user_edited_json: Option<String>,
    pub user_note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewInboxItem {
    pub id: String,
    pub kind: String,
    pub draft_json: String,
    pub source: String,
    pub reason: String,
    pub confidence: f64,
    pub evidence_json: Option<String>,
}

impl super::Database {
    pub fn insert_inbox_item(&self, item: &NewInboxItem) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let now = super::now_ts();
        conn.execute(
            "INSERT INTO inbox_items
                (id, kind, status, draft_json, source, reason, confidence, evidence_json, created_at)
             VALUES (?1, ?2, 'pending', ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                item.id,
                item.kind,
                item.draft_json,
                item.source,
                item.reason,
                item.confidence,
                item.evidence_json,
                now,
            ],
        )
        .map(|_| ())
        .map_err(|e| format!("insert_inbox_item: {}", e))
    }

    pub fn list_inbox_items(&self, status_filter: Option<&str>, limit: usize) -> Vec<InboxItem> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let (sql, has_filter) = match status_filter {
            Some(_) => (
                "SELECT id, kind, status, draft_json, source, reason, confidence, evidence_json,
                        created_at, reviewed_at, applied_at, user_action, user_edited_json, user_note
                 FROM inbox_items
                 WHERE status = ?1
                 ORDER BY created_at DESC
                 LIMIT ?2",
                true,
            ),
            None => (
                "SELECT id, kind, status, draft_json, source, reason, confidence, evidence_json,
                        created_at, reviewed_at, applied_at, user_action, user_edited_json, user_note
                 FROM inbox_items
                 ORDER BY created_at DESC
                 LIMIT ?1",
                false,
            ),
        };
        let mut stmt = match conn.prepare(sql) {
            Ok(s) => s,
            Err(_) => return vec![],
        };
        let map_row = |row: &rusqlite::Row| -> rusqlite::Result<InboxItem> {
            Ok(InboxItem {
                id: row.get(0)?,
                kind: row.get(1)?,
                status: row.get(2)?,
                draft_json: row.get(3)?,
                source: row.get(4)?,
                reason: row.get(5)?,
                confidence: row.get(6)?,
                evidence_json: row.get(7)?,
                created_at: row.get(8)?,
                reviewed_at: row.get(9)?,
                applied_at: row.get(10)?,
                user_action: row.get(11)?,
                user_edited_json: row.get(12)?,
                user_note: row.get(13)?,
            })
        };
        let rows = if has_filter {
            stmt.query_map(params![status_filter.unwrap(), limit as i64], map_row)
        } else {
            stmt.query_map(params![limit as i64], map_row)
        };
        rows.map(|it| it.filter_map(|r| r.ok()).collect())
            .unwrap_or_default()
    }

    pub fn get_inbox_item(&self, id: &str) -> Option<InboxItem> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            "SELECT id, kind, status, draft_json, source, reason, confidence, evidence_json,
                    created_at, reviewed_at, applied_at, user_action, user_edited_json, user_note
             FROM inbox_items WHERE id = ?1",
            params![id],
            |row| {
                Ok(InboxItem {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    status: row.get(2)?,
                    draft_json: row.get(3)?,
                    source: row.get(4)?,
                    reason: row.get(5)?,
                    confidence: row.get(6)?,
                    evidence_json: row.get(7)?,
                    created_at: row.get(8)?,
                    reviewed_at: row.get(9)?,
                    applied_at: row.get(10)?,
                    user_action: row.get(11)?,
                    user_edited_json: row.get(12)?,
                    user_note: row.get(13)?,
                })
            },
        )
        .optional()
        .ok()
        .flatten()
    }

    pub fn count_pending_inbox(&self) -> i64 {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            "SELECT COUNT(*) FROM inbox_items WHERE status = 'pending'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .unwrap_or(0)
    }

    /// Mark item as approved (or edit_approved). `applied_at` set by caller after side-effect succeeds.
    pub fn mark_inbox_approved(
        &self,
        id: &str,
        edited_json: Option<&str>,
        note: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let now = super::now_ts();
        let (action, status) = match edited_json {
            Some(_) => ("edit_approve", "edited"),
            None => ("approve", "approved"),
        };
        conn.execute(
            "UPDATE inbox_items
                SET status = ?1, user_action = ?2, user_edited_json = ?3, user_note = ?4, reviewed_at = ?5
                WHERE id = ?6 AND status = 'pending'",
            params![status, action, edited_json, note, now, id],
        )
        .map(|_| ())
        .map_err(|e| format!("mark_inbox_approved: {}", e))
    }

    /// Stamp `applied_at` once the downstream side-effect (e.g. SKILL.md written) has succeeded.
    pub fn mark_inbox_applied(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let now = super::now_ts();
        conn.execute(
            "UPDATE inbox_items SET applied_at = ?1 WHERE id = ?2",
            params![now, id],
        )
        .map(|_| ())
        .map_err(|e| format!("mark_inbox_applied: {}", e))
    }

    pub fn reject_inbox_item(&self, id: &str, note: Option<&str>) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let now = super::now_ts();
        conn.execute(
            "UPDATE inbox_items
                SET status = 'rejected', user_action = 'reject', user_note = ?1, reviewed_at = ?2
                WHERE id = ?3 AND status = 'pending'",
            params![note, now, id],
        )
        .map(|_| ())
        .map_err(|e| format!("reject_inbox_item: {}", e))
    }

    /// Auto-archive `pending` items older than `max_age_days`. Returns the
    /// number archived. Uses status `'archived'` with `user_action='gc'` so
    /// it's distinguishable from user-initiated withdrawals.
    ///
    /// Idempotent — safe to call repeatedly; items already not-pending are
    /// untouched. Designed for a daily idle-tick maintenance loop, per the
    /// CLAUDE.md "维护型任务：规则先行 + 空闲触发" principle.
    pub fn archive_stale_inbox_items(&self, max_age_days: i64) -> Result<usize, String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let now = super::now_ts();
        let cutoff = now - max_age_days * 86_400_000;
        let affected = conn
            .execute(
                "UPDATE inbox_items
                    SET status = 'archived',
                        user_action = 'gc',
                        user_note = 'auto-archived: stale after ' || ?1 || ' days',
                        reviewed_at = ?2
                  WHERE status = 'pending' AND created_at < ?3",
                params![max_age_days, now, cutoff],
            )
            .map_err(|e| format!("archive_stale_inbox_items: {}", e))?;
        Ok(affected)
    }

    pub fn withdraw_inbox_item(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let now = super::now_ts();
        conn.execute(
            "UPDATE inbox_items
                SET status = 'withdrawn', user_action = 'withdraw', reviewed_at = ?1
                WHERE id = ?2 AND status = 'pending'",
            params![now, id],
        )
        .map(|_| ())
        .map_err(|e| format!("withdraw_inbox_item: {}", e))
    }

    /// Returns true if a similar `skill_create` proposal exists in the last
    /// `days_back` days. "Similar" = same name OR description Jaccard ≥ 0.7
    /// over the first 80 chars (word-level, case-insensitive).
    ///
    /// Considers all non-withdrawn statuses (pending/approved/edited/rejected)
    /// so a rejected near-duplicate isn't re-proposed and pestering the user.
    pub fn has_similar_skill_proposal(
        &self,
        name: &str,
        description: &str,
        days_back: i64,
    ) -> bool {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let cutoff = super::now_ts() - days_back * 86_400_000;
        let mut stmt = match conn.prepare(
            "SELECT json_extract(draft_json, '$.name'),
                    json_extract(draft_json, '$.description')
             FROM inbox_items
             WHERE kind = 'skill_create'
               AND status IN ('pending', 'approved', 'edited', 'rejected')
               AND created_at >= ?1",
        ) {
            Ok(s) => s,
            Err(_) => return false,
        };
        let needle_name = name.trim().to_lowercase();
        let needle_words = jaccard_words(&description.chars().take(80).collect::<String>());
        let rows = stmt.query_map(params![cutoff], |row| {
            Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?))
        });
        let Ok(rows) = rows else { return false };
        for r in rows.flatten() {
            let other_name = r.0.unwrap_or_default().trim().to_lowercase();
            if !other_name.is_empty() && other_name == needle_name {
                return true;
            }
            let other_desc = r.1.unwrap_or_default();
            let other_words = jaccard_words(&other_desc.chars().take(80).collect::<String>());
            if jaccard(&needle_words, &other_words) >= 0.7 {
                return true;
            }
        }
        false
    }

    /// Count inbox items created since `since_ts` whose `source` starts with
    /// `source_prefix` (e.g. `"reflection_"`). Used for daily caps.
    pub fn count_inbox_since_with_source_prefix(&self, since_ts: i64, source_prefix: &str) -> i64 {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let like = format!("{}%", source_prefix);
        conn.query_row(
            "SELECT COUNT(*) FROM inbox_items
             WHERE created_at >= ?1 AND source LIKE ?2",
            params![since_ts, like],
            |r| r.get::<_, i64>(0),
        )
        .unwrap_or(0)
    }
}

fn jaccard_words(s: &str) -> std::collections::HashSet<String> {
    s.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() >= 2)
        .map(|w| w.to_string())
        .collect()
}

fn jaccard(a: &std::collections::HashSet<String>, b: &std::collections::HashSet<String>) -> f64 {
    if a.is_empty() && b.is_empty() {
        return 0.0;
    }
    let inter = a.intersection(b).count() as f64;
    let union = a.union(b).count() as f64;
    if union == 0.0 { 0.0 } else { inter / union }
}
