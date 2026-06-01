//! `ConcreteExecutor` — production `Executor` impl backed by direct LLM
//! chat completion calls.
//!
//! Phase 2A simplification: we go directly through
//! `chat_completion_tracked`, not the full ReAct tool-using loop. That
//! keeps the executor honest (real LLM tokens) without depending on the
//! sub-agent infrastructure in `engine/tools/spawn_tools.rs`. The ReAct
//! upgrade is a Phase 2B follow-up — at that point we'll wrap
//! `run_react_with_options_stream` and stream tokens through the events
//! channel.
//!
//! Per Phase 2A.15: each step is wrapped in `with_memme_user_id` based
//! on the participant's `memory_scope`, so a companion juror's
//! `memory_add` lands in its own bucket, a host's lands in the shared
//! bucket, and a group-scope agent's lands in `group_shared_{id}`.

use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use futures_util::future::join_all;

use super::{
    collab_semaphore, events, resolve_memme_user_id, CollaborationEvent, CollaborationId,
    Executor, Step, StepId, StepKind, StepOutput, TokenUsage,
};
use crate::engine::agents::persona_loader;
use crate::engine::llm_client::{
    chat_completion_stream_tracked, LLMConfig, LLMMessage, MessageContent, StreamEvent,
};
use crate::engine::usage::UsageSource;

/// Production executor. Stateless besides an LLM config closure and the
/// `with_memme_user_id` wrap that scopes each participant to its bucket.
pub struct ConcreteExecutor {
    config: LLMConfig,
}

impl ConcreteExecutor {
    pub fn new(config: LLMConfig) -> Self {
        Self { config }
    }
}

/// Render persona prompt prefix for a participant. Companion participants
/// (id > 0) attempt to load the user-edited persona.md from the
/// `companions/<id>/persona.md` path; if absent, falls through to the
/// AgentDefinition's instructions stored elsewhere. The host participant
/// (companion_id = 0) gets a generic chair prompt.
/// 成员选择"这一轮我不发言"的哨兵 —— fused reply-or-pass(见对话循环引擎)。
/// trim 后等于它即视为"没接话":不进 verdict、前端不渲染气泡。
pub const PASS_SENTINEL: &str = "<pass>";

/// 读 step 的对话模式标记(Driver 写进 metadata)。
/// `group_round` = 群聊一轮(全员 reply-or-pass);`yiyi_fallback` = 全让兜底位。
fn step_mode(step: &Step) -> Option<&str> {
    step.input.metadata.get("mode").and_then(|v| v.as_str())
}

/// 把 metadata 里的群历史渲染成 append-only 块。**缓存纪律**:历史在前(只增),
/// 新消息(step.input.prompt)在最末 → 每位成员跨轮只有最后那句 miss,前缀全命中。
fn history_block(step: &Step) -> String {
    let Some(arr) = step.input.metadata.get("history").and_then(|v| v.as_array()) else {
        return String::new();
    };
    if arr.is_empty() {
        return String::new();
    }
    let mut s = String::from("【群里最近的对话】\n");
    for t in arr {
        let role = t.get("role").and_then(|v| v.as_str()).unwrap_or("");
        let text = t.get("text").and_then(|v| v.as_str()).unwrap_or("");
        s.push_str(&format!("{role}: {text}\n"));
    }
    s.push('\n');
    s
}

fn render_system_prompt(step: &Step, participant_idx: usize) -> String {
    let p = &step.participants[participant_idx];
    match step_mode(step) {
        // 群聊一轮:每位成员自决发言或 <pass>。人设 + 静态规则进 system(稳定前缀,可缓存)。
        // 规则强偏向"让"——群里抢话比冷场更伤体验(见用户反馈:点名了别人,其他成员还硬插话)。
        Some("group_round") => format!(
            "你是 {} {}。这是用户的群聊,群里还有其他 AI 伙伴。\n\n\
             【发言规则 —— 群里别抢话】\n\
             - 用户**点名或明显在问某一位**(直接喊名字、或\"你\"指向某人)→ 那是 TA 的话,\
             你**默认只输出 `{PASS_SENTINEL}`**,把舞台让给 TA,不要凑上去。\n\
             - 只有当这条消息正打在**你的特长**上、或你有**别人给不了的关键补充/纠正** → \
             才以你的性格简短回一句。\n\
             - 其余一律只输出 `{PASS_SENTINEL}`,不要解释、不要客套,\
             **不要为了热情 / 凑热闹 / 刷存在感而接话**。\n\
             宁可少说:被点到的人答就够了,群里清静比热闹重要。",
            p.avatar_emoji, p.name
        ),
        // 全让兜底位:群里没人接,YiYi 群管家接住。
        Some("yiyi_fallback") => format!(
            "你是群管家 {}。群里这条消息暂时没有成员接话,由你接住它:简短自然地回答用户;\
             若确实不是你擅长的领域,就坦诚点一句并把方向轻轻递出去,别生硬推托。",
            p.name
        ),
        _ => {
            if p.companion_id == 0 {
                return format!(
                    "你是群协作的主持人 {}。负责整合上游的产出，提炼共识 / 标出分歧 / 给最终建议。\
                     你不投票、不消灭异议。",
                    p.name
                );
            }
            // Phase 2B will look up the persona via AgentRegistry. For now we
            // synthesize a minimal prompt from the participant snapshot.
            format!("你是 {} {}。按你的性格和视角回应。", p.avatar_emoji, p.name)
        }
    }
}

/// Render the user prompt fed to a single participant. Includes the
/// step's input prompt plus, for HostSummarize, the upstream summaries.
fn render_user_prompt(step: &Step, upstream: &[(StepId, StepOutput)]) -> String {
    // 对话循环的轮 step:历史 append-only 在前,用户新消息在最末(缓存纪律)。
    if matches!(step_mode(step), Some("group_round") | Some("yiyi_fallback")) {
        return format!("{}【用户刚说】\n{}", history_block(step), step.input.prompt);
    }
    match step.kind {
        StepKind::HostSummarize => {
            let mut s = String::new();
            s.push_str("以下是大家在群里的讨论(已概括):\n\n");
            for (id, out) in upstream {
                s.push_str(&format!("【第 {} 轮】{}\n\n", id, out.full_output));
            }
            s.push_str(
                "\n这是讨论的**最后收尾**,不要再发起新一轮、不要问\"要不要继续\"。\
请你作为群管家直接给用户一个明确的结论:先一句话给出核心结论,再简述大家的共识、\
分歧(如有),最后给一条可落地的建议。\n用户原问题:",
            );
            s.push_str(&step.input.prompt);
            s
        }
        // 群讨论的后续轮:把前几轮的发言喂进来,让成员看得到彼此说了什么,
        // 才能真"讨论"(回应 / 补充 / 反驳),而不是各说各的。第一轮 upstream 为空。
        _ => {
            if upstream.is_empty() {
                step.input.prompt.clone()
            } else {
                let mut s = String::new();
                s.push_str("群里目前的讨论:\n\n");
                for (id, out) in upstream {
                    s.push_str(&format!("【第 {} 轮】{}\n\n", id, out.full_output));
                }
                s.push_str("\n");
                s.push_str(&step.input.prompt);
                s
            }
        }
    }
}

/// 单个成员执行的硬超时(秒)。LLM 流偶尔会挂起(连接半开 / DeepSeek 不收尾),
/// 没有超时会让 run_one 永久 await → 永占并发信号量许可 → 几个挂起后许可耗尽,
/// 新成员卡在 acquire 上(连 LLM 请求都发不出),前端永久骨骼屏。超时后该成员算
/// 失败(ParallelAgents 部分容错会跳过它),future 返回 → 许可释放。
const PARTICIPANT_TIMEOUT_SECS: u64 = 150;

/// run_one 的超时包装 —— 见 PARTICIPANT_TIMEOUT_SECS。
async fn run_one_guarded(
    config: &LLMConfig,
    step: &Step,
    participant_idx: usize,
    upstream: &[(StepId, StepOutput)],
    collab_id: CollaborationId,
    usage_source: UsageSource,
) -> Result<StepOutput, String> {
    let name = step
        .participants
        .get(participant_idx)
        .map(|p| p.name.clone())
        .unwrap_or_default();
    match tokio::time::timeout(
        std::time::Duration::from_secs(PARTICIPANT_TIMEOUT_SECS),
        run_one(config, step, participant_idx, upstream, collab_id, usage_source),
    )
    .await
    {
        Ok(r) => r,
        Err(_) => Err(format!("{name} 响应超时({PARTICIPANT_TIMEOUT_SECS}s)")),
    }
}

async fn run_one(
    config: &LLMConfig,
    step: &Step,
    participant_idx: usize,
    upstream: &[(StepId, StepOutput)],
    collab_id: CollaborationId,
    usage_source: UsageSource,
) -> Result<StepOutput, String> {
    let p = &step.participants[participant_idx];

    // Pre-load companion persona override if present (best-effort; absence
    // simply means we fall back to the synthesized prompt). Recorded for
    // the cache, not directly inlined here — Phase 2B will weave it in.
    if p.companion_id != 0 {
        // Look up via task-local working_dir if available; persona_loader
        // is fine with missing files.
        if let Some(wd) = crate::engine::tools::WORKING_DIR.get() {
            let path = wd
                .join("companions")
                .join(p.companion_id.to_string())
                .join("persona.md");
            let _ = persona_loader::load_companion_persona(&path);
        }
    }

    let system_prompt = render_system_prompt(step, participant_idx);
    let user_prompt = render_user_prompt(step, upstream);

    let messages = vec![
        LLMMessage {
            role: "system".into(),
            content: Some(MessageContent::text(system_prompt)),
            tool_calls: None,
            tool_call_id: None,
            reasoning_content: None,
        },
        LLMMessage {
            role: "user".into(),
            content: Some(MessageContent::text(user_prompt)),
            tool_calls: None,
            tool_call_id: None,
            reasoning_content: None,
        },
    ];

    let started = Instant::now();
    // 真·流式:每个增量立刻 emit Token 事件,前端 ParallelAgentStepCard 按
    // ${step_id}:${companion_id} 累积,群成员逐字蹦出(与 YiYi 单聊体验一致)。
    // 正文(ContentDelta)与思考(ReasoningDelta)都放行,用 `reasoning` 标志分流 —— 子
    // agent 因此和主 agent 一样有可见思考过程(只是气泡背景按成员色不同)。
    let collab_id_c = collab_id;
    let step_id_c = step.id;
    let companion_id_c = p.companion_id;
    let resp = chat_completion_stream_tracked(
        usage_source,
        config,
        &messages,
        &[],
        move |evt| {
            let (delta, reasoning) = match evt {
                StreamEvent::ContentDelta(d) => (d, false),
                StreamEvent::ReasoningDelta(d) => (d, true),
                _ => return,
            };
            if !delta.is_empty() {
                events::emit(CollaborationEvent::Token {
                    collaboration_id: collab_id_c,
                    step_id: step_id_c,
                    companion_id: companion_id_c,
                    delta,
                    reasoning,
                });
            }
        },
        None,
    )
    .await?;
    let duration_ms = started.elapsed().as_millis() as u64;

    let full_output = resp
        .message
        .content
        .map(|c| c.into_text())
        .unwrap_or_default();

    let tokens_used = resp
        .usage
        .map(|u| TokenUsage {
            input: u.input_tokens,
            output: u.output_tokens,
        })
        .unwrap_or_default();

    // Summary: take the first ~500 chars of full_output, terminated at a
    // sentence boundary if possible. Downstream HostSummarize feeds on this
    // (not full_output) to keep its context window bounded.
    let summary = summarize(&full_output);

    Ok(StepOutput {
        summary,
        full_output,
        tokens_used,
        duration_ms,
    })
}

fn summarize(text: &str) -> String {
    const CAP: usize = 500;
    if text.chars().count() <= CAP {
        return text.to_string();
    }
    text.chars().take(CAP).collect::<String>() + "…"
}

#[async_trait]
impl Executor for ConcreteExecutor {
    async fn run_step(
        &self,
        collab_id: CollaborationId,
        step: &Step,
        upstream: &[(StepId, StepOutput)],
    ) -> Result<StepOutput, String> {
        match step.kind {
            StepKind::UserConfirmation => {
                Err("UserConfirmation steps must be released via orchestrator (skip/confirm), \
                     never dispatched to the Executor"
                    .into())
            }
            StepKind::SingleAgent => {
                if step.participants.is_empty() {
                    return Err("SingleAgent step missing participant".into());
                }
                let p = &step.participants[0];
                let bucket = resolve_memme_user_id(p.memory_scope, &format!("companion_{}", p.companion_id));
                // Compute the bucket then run inside the memme override scope.
                let _permit = collab_semaphore()
                    .acquire_owned()
                    .await
                    .map_err(|e| format!("semaphore acquire: {e}"))?;
                crate::engine::tools::with_memme_user_id(
                    bucket,
                    run_one_guarded(&self.config, step, 0, upstream, collab_id, UsageSource::CollabWorker),
                )
                .await
            }
            StepKind::ParallelAgents => {
                let _permit = (); // each child task acquires its own permit
                let mut futures = Vec::with_capacity(step.participants.len());
                for (idx, p) in step.participants.iter().enumerate() {
                    let config = self.config.clone();
                    let step = step.clone();
                    let upstream = upstream.to_vec();
                    let bucket = resolve_memme_user_id(
                        p.memory_scope,
                        &format!("companion_{}", p.companion_id),
                    );
                    futures.push(async move {
                        let _permit = collab_semaphore()
                            .acquire_owned()
                            .await
                            .map_err(|e| format!("semaphore acquire: {e}"))?;
                        crate::engine::tools::with_memme_user_id(
                            bucket,
                            run_one_guarded(
                                &config,
                                &step,
                                idx,
                                &upstream,
                                collab_id,
                                UsageSource::CollabWorker,
                            ),
                        )
                        .await
                    });
                }
                let results: Vec<Result<StepOutput, String>> = join_all(futures).await;
                // 部分容错:收集成功者的 output,跳过失败者(只记日志),**仅当全员
                // 失败才整步 Err**。群聊里一个分身答不出来不该让全群"未完成"——
                // 其余成员的发言已通过 Token 事件流到前端,整步成功才能让这些
                // 气泡保留为"说完"。见 P1 修复 / docs/review/2026-05-29_jury。
                let mut combined_summary = String::new();
                let mut combined_full = String::new();
                let mut total_tokens = TokenUsage::default();
                let mut max_duration_ms: u64 = 0;
                let mut success_count = 0usize;
                let mut failures: Vec<String> = Vec::new();
                for (idx, r) in results.into_iter().enumerate() {
                    let name = &step.participants[idx].name;
                    match r {
                        Ok(out) => {
                            // 成功 = 这位成员"跑完了"(无论发言还是 <pass>)。但 <pass>
                            // (选择不发言)不进 combined —— 它没贡献内容,不该出现在
                            // verdict / 气泡聚合里。Driver 据 combined 是否为空判断
                            // "全让"→ YiYi 兜底。见对话循环引擎 §A。
                            success_count += 1;
                            total_tokens.input += out.tokens_used.input;
                            total_tokens.output += out.tokens_used.output;
                            if out.duration_ms > max_duration_ms {
                                max_duration_ms = out.duration_ms;
                            }
                            if out.full_output.trim() == PASS_SENTINEL
                                || out.full_output.trim().is_empty()
                            {
                                continue; // 这位选择不发言
                            }
                            if !combined_full.is_empty() {
                                combined_summary.push_str("\n\n");
                                combined_full.push_str("\n\n");
                            }
                            combined_summary.push_str(&format!("【{}】{}", name, out.summary));
                            combined_full.push_str(&format!("【{}】{}", name, out.full_output));
                        }
                        Err(e) => {
                            log::warn!(
                                "ParallelAgents 成员 {idx} ({name}) 没回上来,跳过: {e}"
                            );
                            failures.push(format!("{name}: {e}"));
                        }
                    }
                }
                // 仅当**全员报错**才整步失败。全员 <pass>(都选择不发言)是合法的
                // "全让",返回空 combined,Driver 会接 YiYi 兜底,不算失败。
                if success_count == 0 {
                    return Err(format!(
                        "所有 {} 位成员都没回上来: {}",
                        step.participants.len(),
                        failures.join("; ")
                    ));
                }
                Ok(StepOutput {
                    summary: combined_summary,
                    full_output: combined_full,
                    tokens_used: total_tokens,
                    duration_ms: max_duration_ms,
                })
            }
            StepKind::HostSummarize => {
                if step.participants.is_empty() {
                    return Err("HostSummarize step missing host participant".into());
                }
                let p = &step.participants[0];
                let bucket = resolve_memme_user_id(p.memory_scope, &format!("companion_{}", p.companion_id));
                let _permit = collab_semaphore()
                    .acquire_owned()
                    .await
                    .map_err(|e| format!("semaphore acquire: {e}"))?;
                crate::engine::tools::with_memme_user_id(
                    bucket,
                    run_one_guarded(&self.config, step, 0, upstream, collab_id, UsageSource::CollabHost),
                )
                .await
            }
        }
    }
}

/// Type-erased handle suitable for `Arc<dyn Executor>` consumption.
pub fn into_handle(executor: ConcreteExecutor) -> Arc<dyn Executor> {
    Arc::new(executor)
}
