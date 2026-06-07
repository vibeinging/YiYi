pub mod chat_sink;
pub mod collab_sink;
pub mod config;
pub mod run;

use crate::engine::react_agent::{AgentStreamEvent, ToolArtifact};

// ── idle 超时活动标记(项目长程任务用)──────────────────────────────────
// project_task 不用总超时(会切掉进展中的长任务),改用 idle 超时:每次有流活动
// (token / 思考 / 工具事件)就 mark,executor 的看门狗据"多久没活动"判断 LLM 流
// 是否真挂起。群聊/普通步不设此 scope → mark 是 no-op,仍走总超时。
tokio::task_local! {
    static IDLE_ACTIVITY: std::sync::Arc<std::sync::Mutex<std::time::Instant>>;
}

/// 在 fut 期间绑定一个 idle 活动时间戳(executor 创建 Arc 并在看门狗里读同一个)。
pub async fn with_idle_activity<F, R>(
    activity: std::sync::Arc<std::sync::Mutex<std::time::Instant>>,
    fut: F,
) -> R
where
    F: std::future::Future<Output = R>,
{
    IDLE_ACTIVITY.scope(activity, fut).await
}

/// 标记"刚有流活动"。不在 `with_idle_activity` scope 内 → no-op。
pub fn mark_idle_activity() {
    let _ = IDLE_ACTIVITY.try_with(|a| {
        if let Ok(mut t) = a.lock() {
            *t = std::time::Instant::now();
        }
    });
}

/// Auto-continue 外壳的轮次事件。`run_with_shell` 在多轮长任务里发出,
/// YiYi 的 `ChatEventSink` 翻译成 `chat://auto_continue`;伙伴 sink no-op。
#[derive(Debug, Clone)]
pub enum RoundEvent {
    /// 新一轮开始(原 round_start;只在 round≥2 由外壳发)。
    Start {
        round: usize,
        max_rounds: usize,
        total_tokens: u64,
        token_budget: u64,
    },
    /// 一轮结束、还要继续(原 round_complete)。
    Complete { round: usize, total_tokens: u64 },
    /// 整个 run 收尾(原 finished;只在 round≥2 发)。
    Finished {
        round: usize,
        total_tokens: u64,
        stop_reason: String,
    },
}

/// Trait for receiving streaming events from the ReAct agent loop.
///
/// Implementors encapsulate all side-effects (event emission, state mutation,
/// counters, DB writes) that should happen as the agent streams its response.
/// This lets the agent loop stay generic and the per-context logic live in a
/// typed, testable struct rather than an ad-hoc closure.
pub trait AgentEventSink: Send + Sync {
    fn on_token(&self, text: &str);
    fn on_thinking(&self, text: &str);
    fn on_tool_start(&self, name: &str, args_preview: &str);
    fn on_tool_end(&self, name: &str, result_preview: &str);
    fn on_tool_artifact(&self, tool_call_id: &str, artifacts: &[ToolArtifact]);
    fn on_usage(
        &self,
        input: u32,
        output: u32,
        cache_read: u32,
        cache_creation: u32,
        cost: Option<f64>,
    );
    fn on_context_overflow_retry(&self);
    fn on_complete(&self, _final_text: &str) {}
    fn on_error(&self, _err: &str) {}

    // ── auto-continue 外壳事件(`run_with_shell` 调;伙伴 sink 全 default no-op)──
    // 注意:run 级终止**不复用** `on_complete/on_error` —— 那两个被 ReAct core 的
    // `AgentStreamEvent::Complete/Error` 每轮占用,复用会让 `chat://complete` 提前触发。
    /// 多轮长任务的轮次进度(round_start / round_complete / finished)。
    fn on_round(&self, _ev: RoundEvent) {}
    /// 整个 run 正常收尾,带最终回复(原 `chat://complete`)。
    fn on_run_complete(&self, _final_text: &str) {}
    /// 整个 run 出错(原 `chat://error`)。
    fn on_run_error(&self, _err: &str) {}
    /// run 结束后的 streaming snapshot 收尾(mark inactive + 延迟清理)。
    fn on_run_finished(&self) {}
    /// 验证 Agent 的流式增量(原 `chat://verification_chunk`)。
    fn on_verification_chunk(&self, _text: &str) {}
    /// 验证 Agent 完成,带报告(原 `chat://verification_complete`)。
    fn on_verification_complete(&self, _report: &str) {}

    // ── 外壳读取 sink 累积的本轮统计(伙伴 sink default 空/0)──
    /// 取走并清空累积的思考链(每轮 push assistant 落库用)。
    fn take_thinking(&self) -> String {
        String::new()
    }
    /// 本次 run 累计工具调用次数(growth 判断"是否动过手")。
    fn tool_count(&self) -> usize {
        0
    }
    /// 本次 run 累计工具错误次数(growth 判断 signal_type)。
    fn tool_error_count(&self) -> usize {
        0
    }
}

/// Dispatch a single `AgentStreamEvent` to the appropriate `AgentEventSink` method.
///
/// This is the bridge between the enum-based event stream produced by the ReAct
/// core and the trait-method-based sink interface.  Call this from any closure
/// that wraps a `dyn AgentEventSink`:
///
/// ```ignore
/// let sink = Arc::new(ChatEventSink::new(...));
/// let on_event = {
///     let sink = sink.clone();
///     move |evt| dispatch_agent_event(&*sink, evt)
/// };
/// ```
pub fn dispatch_agent_event(sink: &dyn AgentEventSink, evt: AgentStreamEvent) {
    match evt {
        AgentStreamEvent::Token(ref text) => sink.on_token(text),
        AgentStreamEvent::Thinking(ref text) => sink.on_thinking(text),
        AgentStreamEvent::ToolStart { ref name, ref args_preview } => {
            sink.on_tool_start(name, args_preview)
        }
        AgentStreamEvent::ToolEnd { ref name, ref result_preview } => {
            sink.on_tool_end(name, result_preview)
        }
        AgentStreamEvent::ToolArtifact { ref tool_call_id, ref artifacts } => {
            sink.on_tool_artifact(tool_call_id, artifacts)
        }
        AgentStreamEvent::ContextOverflowRetry => sink.on_context_overflow_retry(),
        AgentStreamEvent::Usage {
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_creation_tokens,
            estimated_cost_usd,
        } => sink.on_usage(
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_creation_tokens,
            estimated_cost_usd,
        ),
        AgentStreamEvent::Complete => sink.on_complete(""),
        AgentStreamEvent::Error => sink.on_error(""),
    }
}

/// 工具结果 preview 是否表示错误 —— 按前缀判断。主精灵 `ChatEventSink` 与伙伴
/// `CollabEventSink` 共用,保证两侧 is_error 判定一致。
pub(crate) fn is_error_preview(preview: &str) -> bool {
    preview.starts_with("Error:")
        || preview.starts_with("error:")
        || preview.starts_with("Failed")
        || preview.starts_with("failed")
}
