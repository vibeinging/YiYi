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
    chat_completion_tracked, LLMConfig, LLMMessage, MessageContent,
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
            s.push_str("以下是上游几位的发言（已概括）：\n\n");
            for (id, out) in upstream {
                s.push_str(&format!("【step {}】{}\n\n", id, out.summary));
            }
            s.push_str("\n请整合：共识 / 分歧 / 你的最终建议。\n用户原问题：");
            s.push_str(&step.input.prompt);
            s
        }
        _ => step.input.prompt.clone(),
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
    let resp = chat_completion_tracked(usage_source, config, &messages, &[]).await?;
    let duration_ms = started.elapsed().as_millis() as u64;

    let full_output = resp
        .message
        .content
        .map(|c| c.into_text())
        .unwrap_or_default();

    // Emit the assembled response as a single Token event so the front-end
    // can render it (Phase 2A is non-streaming; Phase 2B switches to the
    // streaming variant). One event per participant keeps the contract
    // testable.
    events::emit(CollaborationEvent::Token {
        collaboration_id: collab_id,
        step_id: step.id,
        companion_id: p.companion_id,
        delta: full_output.clone(),
    });

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
                // Aggregate: first failure aborts; otherwise concat summaries
                // / full_outputs by participant index for the upstream
                // HostSummarize step.
                let mut combined_summary = String::new();
                let mut combined_full = String::new();
                let mut total_tokens = TokenUsage::default();
                let mut max_duration_ms: u64 = 0;
                for (idx, r) in results.into_iter().enumerate() {
                    let out = r.map_err(|e| {
                        format!("participant {} ({}): {e}", idx, step.participants[idx].name)
                    })?;
                    if !combined_summary.is_empty() {
                        combined_summary.push_str("\n\n");
                        combined_full.push_str("\n\n");
                    }
                    combined_summary.push_str(&format!(
                        "【{}】{}",
                        step.participants[idx].name, out.summary
                    ));
                    combined_full.push_str(&format!(
                        "【{}】{}",
                        step.participants[idx].name, out.full_output
                    ));
                    total_tokens.input += out.tokens_used.input;
                    total_tokens.output += out.tokens_used.output;
                    if out.duration_ms > max_duration_ms {
                        max_duration_ms = out.duration_ms;
                    }
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
