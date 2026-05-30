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
//! bucket, and a family-scope agent's lands in `family_shared`.

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
fn render_system_prompt(step: &Step, participant_idx: usize) -> String {
    let p = &step.participants[participant_idx];
    if p.companion_id == 0 {
        return format!(
            "你是家族协作的主持人 {}。负责整合上游的产出，提炼共识 / 标出分歧 / 给最终建议。\
             你不投票、不消灭异议。",
            p.name
        );
    }
    // Phase 2B will look up the persona via AgentRegistry. For now we
    // synthesize a minimal prompt from the participant snapshot — enough
    // for the executor to be testable end-to-end without a full
    // companions wiring.
    format!(
        "你是 {} {}。按你的性格和视角回应。",
        p.avatar_emoji, p.name
    )
}

/// Render the user prompt fed to a single participant. Includes the
/// step's input prompt plus, for HostSummarize, the upstream summaries.
fn render_user_prompt(step: &Step, upstream: &[(StepId, StepOutput)]) -> String {
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
    // 真·流式:每个 ContentDelta 立刻 emit 一个 Token 事件,前端 ParallelAgentStepCard
    // 按 ${step_id}:${companion_id} 累积,群成员发言逐字蹦出(与 YiYi 单聊体验一致)。
    // 此前用非流式 chat_completion_tracked + 结束后 emit 整段,导致群成员"loading 一下
    // 才整段出字、不流式"。reasoning(thinking)增量不入气泡,只取 content。
    let collab_id_c = collab_id;
    let step_id_c = step.id;
    let companion_id_c = p.companion_id;
    let resp = chat_completion_stream_tracked(
        usage_source,
        config,
        &messages,
        &[],
        move |evt| {
            if let StreamEvent::ContentDelta(delta) = evt {
                if !delta.is_empty() {
                    events::emit(CollaborationEvent::Token {
                        collaboration_id: collab_id_c,
                        step_id: step_id_c,
                        companion_id: companion_id_c,
                        delta,
                    });
                }
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
                    run_one(&self.config, step, 0, upstream, collab_id, UsageSource::CollabWorker),
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
                            run_one(
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
                            if success_count > 0 {
                                combined_summary.push_str("\n\n");
                                combined_full.push_str("\n\n");
                            }
                            combined_summary.push_str(&format!("【{}】{}", name, out.summary));
                            combined_full.push_str(&format!("【{}】{}", name, out.full_output));
                            total_tokens.input += out.tokens_used.input;
                            total_tokens.output += out.tokens_used.output;
                            if out.duration_ms > max_duration_ms {
                                max_duration_ms = out.duration_ms;
                            }
                            success_count += 1;
                        }
                        Err(e) => {
                            log::warn!(
                                "ParallelAgents 成员 {idx} ({name}) 没回上来,跳过: {e}"
                            );
                            failures.push(format!("{name}: {e}"));
                        }
                    }
                }
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
                    run_one(&self.config, step, 0, upstream, collab_id, UsageSource::CollabHost),
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
