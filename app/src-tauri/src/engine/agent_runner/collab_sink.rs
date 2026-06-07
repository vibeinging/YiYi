//! `CollabEventSink` —— 群聊 / 协作伙伴的 `AgentEventSink` 实现。
//!
//! 把 ReAct 流事件翻译成 `CollaborationEvent`,经进程级 broadcast 推给前端:
//! - `on_token` / `on_thinking` → `Token { reasoning }`(正文 / 思考分流)
//! - `on_tool_start` / `on_tool_end` → 结构化 `ToolStart` / `ToolEnd`
//!   (取代早期把 `🔧 …` 文本塞进思考块的降级)
//! - `on_usage` → 累加 in/out token,供 executor 收尾构造 `TokenUsage`
//!
//! 伙伴没有 YiYi 主精灵的外壳,所以 `on_round` / `on_run_*` / `take_thinking`
//! / `tool_count` 等全走 trait default no-op。

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use crate::engine::collaboration::events;
use crate::engine::collaboration::{CollaborationEvent, CollaborationId, CompanionId, StepId};
use crate::engine::react_agent::ToolArtifact;

use super::{is_error_preview, AgentEventSink};

pub struct CollabEventSink {
    collaboration_id: CollaborationId,
    step_id: StepId,
    companion_id: CompanionId,
    in_tokens: Arc<AtomicU32>,
    out_tokens: Arc<AtomicU32>,
}

impl CollabEventSink {
    pub fn new(
        collaboration_id: CollaborationId,
        step_id: StepId,
        companion_id: CompanionId,
        in_tokens: Arc<AtomicU32>,
        out_tokens: Arc<AtomicU32>,
    ) -> Self {
        Self {
            collaboration_id,
            step_id,
            companion_id,
            in_tokens,
            out_tokens,
        }
    }

    fn emit_token(&self, delta: String, reasoning: bool) {
        super::mark_idle_activity(); // 有流活动 → 重置项目任务 idle 计时
        if delta.is_empty() {
            return;
        }
        events::emit(CollaborationEvent::Token {
            collaboration_id: self.collaboration_id,
            step_id: self.step_id,
            companion_id: self.companion_id,
            delta,
            reasoning,
        });
    }
}

impl AgentEventSink for CollabEventSink {
    fn on_token(&self, text: &str) {
        self.emit_token(text.to_string(), false);
    }

    fn on_thinking(&self, text: &str) {
        self.emit_token(text.to_string(), true);
    }

    fn on_tool_start(&self, name: &str, args_preview: &str) {
        super::mark_idle_activity();
        events::emit(CollaborationEvent::ToolStart {
            collaboration_id: self.collaboration_id,
            step_id: self.step_id,
            companion_id: self.companion_id,
            name: name.to_string(),
            args_preview: args_preview.to_string(),
        });
    }

    fn on_tool_end(&self, name: &str, result_preview: &str) {
        super::mark_idle_activity();
        events::emit(CollaborationEvent::ToolEnd {
            collaboration_id: self.collaboration_id,
            step_id: self.step_id,
            companion_id: self.companion_id,
            name: name.to_string(),
            result_preview: result_preview.to_string(),
            is_error: is_error_preview(result_preview),
        });
    }

    fn on_tool_artifact(&self, _tool_call_id: &str, _artifacts: &[ToolArtifact]) {
        // 伙伴工具产物(截图等)暂不内联渲染 —— 需协作 message 持久化才能重开可见,
        // 留后续(与 Phase 3 伙伴 message 持久化一并做)。
    }

    fn on_usage(
        &self,
        input: u32,
        output: u32,
        _cache_read: u32,
        _cache_creation: u32,
        _cost: Option<f64>,
    ) {
        self.in_tokens.fetch_add(input, Ordering::Relaxed);
        self.out_tokens.fetch_add(output, Ordering::Relaxed);
    }

    fn on_context_overflow_retry(&self) {
        // 子 agent 上下文溢出重试:无独立 UI,静默。
    }
}
