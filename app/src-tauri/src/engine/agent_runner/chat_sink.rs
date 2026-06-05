use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::collections::HashMap;

use tauri::{AppHandle, Emitter};

use crate::engine::react_agent::ToolArtifact;
use crate::state::app_state::{StreamingSnapshot, ToolSnapshot};

use super::{AgentEventSink, RoundEvent};

/// `AgentEventSink` implementation for the main chat streaming path.
///
/// Implements every event branch with byte-for-byte identical emit calls,
/// snapshot mutations, counter increments, `record_usage` and
/// `maybe_trigger_pressure_compact` invocations as the former inline `on_event`
/// closure. `handle` / `ss_for_event` (shared streaming state) / `sid` / `model`
/// are passed in; the thinking buffer and tool counters are owned here — the
/// `run_with_shell` loop reads them back via `take_thinking()` / `tool_count()`
/// / `tool_error_count()`, so no external `Arc` sharing is needed.
pub struct ChatEventSink {
    handle: AppHandle,
    ss_for_event: Arc<Mutex<HashMap<String, StreamingSnapshot>>>,
    sid_for_event: String,
    model_for_event: String,
    thinking_buf_for_event: Mutex<String>,
    tool_count_for_event: AtomicUsize,
    tool_error_for_event: AtomicUsize,
}

impl ChatEventSink {
    pub fn new(
        handle: AppHandle,
        ss_for_event: Arc<Mutex<HashMap<String, StreamingSnapshot>>>,
        sid_for_event: String,
        model_for_event: String,
    ) -> Self {
        Self {
            handle,
            ss_for_event,
            sid_for_event,
            model_for_event,
            thinking_buf_for_event: Mutex::new(String::new()),
            tool_count_for_event: AtomicUsize::new(0),
            tool_error_for_event: AtomicUsize::new(0),
        }
    }
}

impl AgentEventSink for ChatEventSink {
    fn on_token(&self, text: &str) {
        // Strip internal markers before sending to frontend
        let clean = crate::engine::tools::strip_stage_markers(text);
        if !clean.is_empty() {
            self.handle.emit("chat://chunk", serde_json::json!({
                "text": clean,
                "session_id": self.sid_for_event,
            })).ok();
        }
        if let Ok(mut ss) = self.ss_for_event.lock() {
            if let Some(snap) = ss.get_mut(&self.sid_for_event) {
                snap.accumulated_text.push_str(text);
            }
        }
    }

    fn on_thinking(&self, text: &str) {
        self.handle.emit("chat://thinking", serde_json::json!({
            "text": text,
            "session_id": self.sid_for_event,
        })).ok();
        if let Ok(mut buf) = self.thinking_buf_for_event.lock() {
            buf.push_str(text);
        }
    }

    fn on_tool_start(&self, name: &str, args_preview: &str) {
        self.handle
            .emit(
                "chat://tool_status",
                serde_json::json!({
                    "type": "start",
                    "name": name,
                    "preview": args_preview,
                    "session_id": self.sid_for_event,
                }),
            )
            .ok();
        if let Ok(mut ss) = self.ss_for_event.lock() {
            if let Some(snap) = ss.get_mut(&self.sid_for_event) {
                snap.tools.push(ToolSnapshot {
                    name: name.to_string(),
                    status: "running".into(),
                    preview: Some(args_preview.to_string()),
                });
            }
        }
    }

    fn on_tool_end(&self, name: &str, result_preview: &str) {
        self.tool_count_for_event.fetch_add(1, Ordering::Relaxed);
        if super::is_error_preview(result_preview) {
            self.tool_error_for_event.fetch_add(1, Ordering::Relaxed);
        }
        self.handle
            .emit(
                "chat://tool_status",
                serde_json::json!({
                    "type": "end",
                    "name": name,
                    "preview": result_preview,
                    "session_id": self.sid_for_event,
                }),
            )
            .ok();
        if let Ok(mut ss) = self.ss_for_event.lock() {
            if let Some(snap) = ss.get_mut(&self.sid_for_event) {
                for t in snap.tools.iter_mut().rev() {
                    if t.name == name && t.status == "running" {
                        t.status = "done".into();
                        if !result_preview.is_empty() {
                            t.preview = Some(result_preview.to_string());
                        }
                        break;
                    }
                }
            }
        }
    }

    fn on_tool_artifact(&self, tool_call_id: &str, artifacts: &[ToolArtifact]) {
        self.handle
            .emit(
                "chat://tool_artifact",
                serde_json::json!({
                    "session_id": self.sid_for_event,
                    "tool_call_id": tool_call_id,
                    "artifacts": artifacts,
                }),
            )
            .ok();
    }

    fn on_context_overflow_retry(&self) {
        // Reset accumulated text so the retry doesn't produce duplicate content
        self.handle.emit("chat://stream_reset", serde_json::json!({
            "session_id": self.sid_for_event,
            "reason": "context_overflow",
        })).ok();
        if let Ok(mut ss) = self.ss_for_event.lock() {
            if let Some(snap) = ss.get_mut(&self.sid_for_event) {
                snap.accumulated_text.clear();
            }
        }
    }

    fn on_usage(
        &self,
        input: u32,
        output: u32,
        cache_read: u32,
        cache_creation: u32,
        cost: Option<f64>,
    ) {
        self.handle.emit("chat://usage", serde_json::json!({
            "session_id": self.sid_for_event,
            "input_tokens": input,
            "output_tokens": output,
            "cache_read_tokens": cache_read,
            "cache_creation_tokens": cache_creation,
            "estimated_cost_usd": cost,
        })).ok();
        // Persist to DB for historical queries.
        if let Some(db) = crate::engine::tools::get_database() {
            db.record_usage(
                &self.sid_for_event,
                &self.model_for_event,
                input,
                output,
                cache_read,
                cache_creation,
                cost.unwrap_or(0.0),
            );
        }
        // Window-pressure compact: if input tokens are nearing context limit,
        // compact the session so earlier messages become searchable episodes.
        crate::commands::agent::chat::maybe_trigger_pressure_compact(
            &self.sid_for_event,
            input as u64,
        );
    }

    fn on_round(&self, ev: RoundEvent) {
        let payload = match ev {
            RoundEvent::Start {
                round,
                max_rounds,
                total_tokens,
                token_budget,
            } => serde_json::json!({
                "type": "round_start",
                "round": round,
                "max_rounds": max_rounds,
                "total_tokens": total_tokens,
                "token_budget": token_budget,
                "session_id": self.sid_for_event,
            }),
            RoundEvent::Complete { round, total_tokens } => serde_json::json!({
                "type": "round_complete",
                "round": round,
                "total_tokens": total_tokens,
                "session_id": self.sid_for_event,
            }),
            RoundEvent::Finished {
                round,
                total_tokens,
                stop_reason,
            } => serde_json::json!({
                "type": "finished",
                "round": round,
                "total_tokens": total_tokens,
                "stop_reason": stop_reason,
                "session_id": self.sid_for_event,
            }),
        };
        self.handle.emit("chat://auto_continue", payload).ok();
    }

    fn on_run_complete(&self, final_text: &str) {
        self.handle
            .emit(
                "chat://complete",
                serde_json::json!({
                    "text": final_text,
                    "session_id": self.sid_for_event,
                }),
            )
            .ok();
    }

    fn on_run_error(&self, err: &str) {
        self.handle
            .emit(
                "chat://error",
                serde_json::json!({
                    "text": err,
                    "session_id": self.sid_for_event,
                }),
            )
            .ok();
    }

    fn on_run_finished(&self) {
        // Mark snapshot inactive, then schedule cleanup after 30s for recovery window.
        if let Ok(mut ss) = self.ss_for_event.lock() {
            if let Some(snap) = ss.get_mut(&self.sid_for_event) {
                snap.is_active = false;
            }
        }
        let ss_cleanup = self.ss_for_event.clone();
        let sid_cleanup = self.sid_for_event.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            if let Ok(mut ss) = ss_cleanup.lock() {
                if let Some(snap) = ss.get(&sid_cleanup) {
                    if !snap.is_active {
                        ss.remove(&sid_cleanup);
                    }
                }
            }
        });
    }

    fn on_verification_chunk(&self, text: &str) {
        self.handle
            .emit(
                "chat://verification_chunk",
                serde_json::json!({
                    "text": text,
                    "session_id": self.sid_for_event,
                }),
            )
            .ok();
    }

    fn on_verification_complete(&self, report: &str) {
        self.handle
            .emit(
                "chat://verification_complete",
                serde_json::json!({
                    "report": report,
                    "session_id": self.sid_for_event,
                }),
            )
            .ok();
    }

    fn take_thinking(&self) -> String {
        self.thinking_buf_for_event
            .lock()
            .ok()
            .map(|mut b| std::mem::take(&mut *b))
            .unwrap_or_default()
    }

    fn tool_count(&self) -> usize {
        self.tool_count_for_event.load(Ordering::Relaxed)
    }

    fn tool_error_count(&self) -> usize {
        self.tool_error_for_event.load(Ordering::Relaxed)
    }
}
