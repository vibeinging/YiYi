//! `run_with_shell` —— auto-continue 外壳。把原 `chat_stream_start` 的 spawn
//! 闭包(多轮长任务循环 + verify / growth / feed_memme / progress)整段搬来,
//! emit 全部走 `AgentEventSink`。
//!
//! YiYi(主精灵)= `shell.primary()` 全开,走完整外壳;伙伴 = `ShellOptions`
//! 全关,`auto_continue=false` → 只跑一轮 ReAct(等价 `executor::run_one_react`)。
//! task-local 三层(continuation_flag / cancelled / session_id)在这里内聚包裹。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::commands::agent::chat::feed_to_memme;
use crate::commands::agent::helpers::{
    db_messages_to_llm, estimate_tokens_simple, extract_title_from_message, make_persist_fn,
};
use crate::engine::db::Database;
use crate::engine::react_agent::{self, SignalType};
use crate::engine::tools;

use super::config::AgentRunConfig;
use super::{dispatch_agent_event, AgentEventSink, RoundEvent};

/// 运行一次完整的 agent task。task-local 包
/// `with_continuation_flag + with_cancelled + with_session_id`,内部按
/// `cfg.shell.*` 决定是否启用 auto-continue / verify / growth 等外壳。
///
/// - `internal_dir`: 内部数据目录(= `state.working_dir`),既作 ReAct 执行目录、
///   又作 `db_messages_to_llm` 锚点与 progress.json 落盘根。
/// - `user_workspace`: 用户工作区(`db_messages_to_llm` 第二锚点)。
/// - `cancelled`: 必须是 `state.chat_cancelled` 那个 Arc(供 `chat_stream_stop` 写)。
pub async fn run_with_shell(
    cfg: AgentRunConfig,
    db: Arc<Database>,
    internal_dir: PathBuf,
    user_workspace: PathBuf,
    session_id: String,
    sink: Arc<dyn AgentEventSink>,
    cancelled: Arc<AtomicBool>,
) {
    let continuation_flag = Arc::new(AtomicBool::new(false));
    let sid = session_id.clone();
    tools::with_continuation_flag(
        continuation_flag,
        tools::with_cancelled(
            cancelled.clone(),
            tools::with_session_id(session_id, async move {
                run_loop(
                    &cfg,
                    &db,
                    &internal_dir,
                    &user_workspace,
                    &sid,
                    &sink,
                    &cancelled,
                )
                .await;
                // streaming snapshot 收尾(mark inactive + 延迟清理)。
                sink.on_run_finished();
            }),
        ),
    )
    .await;
}

#[allow(clippy::too_many_arguments)]
async fn run_loop(
    cfg: &AgentRunConfig,
    db: &Arc<Database>,
    internal_dir: &PathBuf,
    user_workspace: &PathBuf,
    sid: &str,
    sink: &Arc<dyn AgentEventSink>,
    cancelled: &Arc<AtomicBool>,
) {
    let on_event = {
        let sink = sink.clone();
        move |evt: react_agent::AgentStreamEvent| dispatch_agent_event(&*sink, evt)
    };

    let max_r = cfg.shell.max_rounds;
    let budget = cfg.shell.token_budget;

    let mut round: usize = 0;
    let mut total_tokens: u64 = 0;
    let mut last_reply: String;
    let task_started_at = chrono::Utc::now().timestamp();

    // Check if this session belongs to a task (for progress persistence).
    let task_for_progress: Option<(String, std::path::PathBuf)> = if cfg.shell.task_progress {
        let tasks = db.list_tasks(None, Some("running")).unwrap_or_default();
        tasks
            .into_iter()
            .find(|t| t.session_id == sid)
            .map(|t| {
                let progress_dir = internal_dir.join("tasks").join(&t.id);
                std::fs::create_dir_all(&progress_dir).ok();
                (t.id.clone(), progress_dir)
            })
    } else {
        None
    };

    loop {
        round += 1;

        // Reset continuation flag for this round.
        tools::reset_continuation_flag();

        // Only emit round_start from round 2 onward — round 1 is silent so
        // simple Q&A doesn't flash the long task progress panel.
        if round >= 2 {
            sink.on_round(RoundEvent::Start {
                round,
                max_rounds: max_r,
                total_tokens,
                token_budget: budget,
            });
        }

        // Build message and history for this round.
        let (round_message, history) = if round == 1 {
            (cfg.agent_message.clone(), cfg.llm_history.clone())
        } else {
            // Push a "continue" user message into DB.
            let continue_msg = "请继续执行任务。".to_string();
            db.push_message(sid, "user", &continue_msg).ok();

            // Reload full conversation history from DB, excluding the last
            // message (the continue_msg we just pushed) since the stream call
            // includes user_message as the current turn.
            let raw_msgs = db.get_recent_messages(sid, 50).unwrap_or_default();
            let hist = if raw_msgs.len() > 1 {
                db_messages_to_llm(internal_dir, user_workspace, &raw_msgs[..raw_msgs.len() - 1])
            } else {
                vec![]
            };
            (continue_msg, hist)
        };

        let persist_fn = Some(make_persist_fn(db.clone(), sid.to_string()));

        match react_agent::run_react_with_options_stream(
            &cfg.llm,
            &cfg.system_prompt,
            &round_message,
            &history,
            cfg.max_iter,
            Some(internal_dir.as_path()),
            on_event.clone(),
            Some(cancelled),
            persist_fn,
            None,
        )
        .await
        {
            Ok(reply) => {
                if !reply.is_empty() && reply != "(no response)" {
                    // Always drain (= clear) the thinking buffer on any non-empty
                    // reply — matches the original's unconditional `mem::take`.
                    // Whether to persist is then a separate decision; gating the
                    // *drain* on persist_thinking would leak round N's thinking
                    // into round N+1 when persist_thinking=false.
                    let thinking_text = sink.take_thinking();
                    let clean_reply = tools::strip_stage_markers(&reply);
                    if thinking_text.is_empty() || !cfg.shell.persist_thinking {
                        db.push_message(sid, "assistant", &clean_reply).ok();
                    } else {
                        let meta = serde_json::json!({ "thinking": thinking_text }).to_string();
                        db.push_message_with_metadata(sid, "assistant", &clean_reply, Some(&meta))
                            .ok();
                    }
                } else {
                    // Clear thinking buffer even if no reply (take = clear).
                    let _ = sink.take_thinking();
                }

                if round == 1 && cfg.is_first_message {
                    let title = extract_title_from_message(&cfg.augmented_message);
                    db.rename_session(sid, &title).ok();
                }

                total_tokens += estimate_tokens_simple(&reply);
                last_reply = reply;

                // Check if the model called request_continuation during this round.
                let should_continue = tools::is_continuation_requested();

                let should_stop = !cfg.shell.auto_continue
                    || !should_continue
                    || round >= max_r
                    || total_tokens >= budget
                    || cancelled.load(Ordering::Relaxed);

                if should_stop {
                    // For YiYi (auto_continue=true) the `!auto_continue` term is
                    // always false, so this is identical to the original order:
                    // !should_continue → task_complete, then max_rounds / budget,
                    // cancelled last. The single-round (auto_continue=false) case
                    // folds into task_complete; its cancelled/budget semantics are
                    // a Phase-3 (companion) concern, revisited when that caller lands.
                    let stop_reason = if !should_continue || !cfg.shell.auto_continue {
                        "task_complete"
                    } else if round >= max_r {
                        "max_rounds"
                    } else if total_tokens >= budget {
                        "token_budget"
                    } else {
                        "cancelled"
                    };

                    // Write final progress.json for task completion.
                    if let Some((ref tid, ref progress_dir)) = task_for_progress {
                        let progress = serde_json::json!({
                            "task_id": tid,
                            "session_id": sid,
                            "status": stop_reason,
                            "current_round": round,
                            "total_tokens": total_tokens,
                            "last_output_preview": last_reply.chars().take(200).collect::<String>(),
                            "updated_at": chrono::Utc::now().timestamp(),
                        });
                        tools::write_progress_json(progress_dir, &progress);
                    }

                    // Only emit finished if we ever emitted round_start (round >= 2).
                    if round >= 2 {
                        sink.on_round(RoundEvent::Finished {
                            round,
                            total_tokens,
                            stop_reason: stop_reason.to_string(),
                        });
                    }

                    sink.on_run_complete(&last_reply);

                    if cfg.shell.notify {
                        let preview: String = last_reply.chars().take(100).collect();
                        crate::engine::scheduler::send_notification_with_context(
                            "YiYi",
                            &preview,
                            serde_json::json!({
                                "page": "chat",
                                "session_id": sid,
                            }),
                        );
                    }

                    // Verification Agent: auto-verify multi-round tasks (round >= 3).
                    // Runs in background so it doesn't block the main completion flow.
                    if cfg.shell.verify_long_tasks && round >= 3 {
                        let verify_config = cfg.llm.clone();
                        let verify_task_desc = cfg.augmented_message.clone();
                        let verify_output = last_reply.clone();
                        let verify_sid = sid.to_string();
                        let verify_wd = internal_dir.clone();
                        let sink_v = sink.clone();
                        tokio::spawn(async move {
                            log::info!("Verification Agent starting for session {}", verify_sid);
                            let on_event = {
                                let sink_v = sink_v.clone();
                                move |evt: react_agent::AgentStreamEvent| {
                                    if let react_agent::AgentStreamEvent::Token(text) = &evt {
                                        sink_v.on_verification_chunk(text);
                                    }
                                }
                            };
                            match react_agent::verification::verify_task(
                                &verify_config,
                                &verify_task_desc,
                                &verify_output,
                                Some(verify_wd.as_path()),
                                on_event,
                                None,
                            )
                            .await
                            {
                                Ok(report) => {
                                    log::info!(
                                        "Verification complete: {}",
                                        &report.chars().take(200).collect::<String>()
                                    );
                                    sink_v.on_verification_complete(&report);
                                }
                                Err(e) => {
                                    log::warn!("Verification Agent failed: {}", e);
                                }
                            }
                        });
                    }

                    // Feed conversation into MemMe Session pipeline.
                    if cfg.shell.feed_memme {
                        feed_to_memme(
                            sid.to_string(),
                            cfg.augmented_message.clone(),
                            last_reply.clone(),
                        );
                    }

                    if cfg.shell.growth_learning {
                        run_growth(cfg, sid, &last_reply, stop_reason, sink);
                    }

                    break;
                }

                // Emit round_complete, prepare for next round.
                sink.on_round(RoundEvent::Complete {
                    round,
                    total_tokens,
                });

                // Write progress.json for crash recovery.
                if let Some((ref tid, ref progress_dir)) = task_for_progress {
                    let progress = serde_json::json!({
                        "task_id": tid,
                        "session_id": sid,
                        "status": "running",
                        "current_round": round,
                        "total_tokens": total_tokens,
                        "last_output_preview": last_reply.chars().take(200).collect::<String>(),
                        "started_at": task_started_at,
                        "updated_at": chrono::Utc::now().timestamp(),
                    });
                    tools::write_progress_json(progress_dir, &progress);
                }
            }
            Err(e) => {
                if e == "cancelled" {
                    if round >= 2 {
                        sink.on_round(RoundEvent::Finished {
                            round,
                            total_tokens,
                            stop_reason: "cancelled".to_string(),
                        });
                    }
                    sink.on_run_complete("");
                } else {
                    sink.on_run_error(&e);
                    if cfg.shell.notify {
                        let err_preview: String = e.chars().take(100).collect();
                        crate::engine::scheduler::send_notification_with_context(
                            "YiYi",
                            &format!("Agent error: {}", err_preview),
                            serde_json::json!({
                                "page": "chat",
                                "session_id": sid,
                            }),
                        );
                    }

                    // Reflect on agent error as a failure (e.g. max iterations hit).
                    if cfg.shell.growth_learning && sink.tool_count() > 0 {
                        let config_err = cfg.llm.clone();
                        let user_msg_err = cfg.augmented_message.clone();
                        let err_msg = e.clone();
                        let sid_err = sid.to_string();
                        log::debug!("Agent error, reflecting as failure: {}", &err_msg);
                        tokio::spawn(async move {
                            react_agent::reflect_on_task(
                                &config_err,
                                None,
                                Some(&sid_err),
                                &user_msg_err,
                                &err_msg,
                                false,
                                SignalType::AgentError,
                            )
                            .await;
                        });
                    }
                }
                break;
            }
        }
    } // end auto-continue loop
}

/// Growth System:在 run 收尾(should_stop)时检测纠正 / 表扬 / 静默反思。
/// 逐字搬自原 `chat.rs`,工具计数改读 `sink.tool_count()/tool_error_count()`。
fn run_growth(
    cfg: &AgentRunConfig,
    sid: &str,
    last_reply: &str,
    stop_reason: &str,
    sink: &Arc<dyn AgentEventSink>,
) {
    // detect implicit negative feedback in user message.
    // Safety: only trigger on short messages that START with correction keywords
    // to avoid false positives like "不要忘记加测试" or "what's wrong with this code?"
    {
        let msg = cfg.augmented_message.trim();
        let msg_lower = msg.to_lowercase();
        let is_short = msg.chars().count() < 50;

        // Must start with a correction keyword (not just contain it).
        let starts_with_correction = [
            "不对",
            "不是这样",
            "重来",
            "错了",
            "wrong",
            "no,",
            "no ",
            "redo",
            "别这样",
            "我说的不是",
            "你理解错了",
        ]
        .iter()
        .any(|p| msg_lower.starts_with(p));

        // Or short message containing correction words.
        let short_contains_correction = is_short
            && ["重新做", "重做", "换一个", "不要这样"]
                .iter()
                .any(|p| msg_lower.contains(p));

        let is_correction = starts_with_correction || short_contains_correction;

        if is_correction && !last_reply.is_empty() {
            let config_fb = cfg.llm.clone();
            let feedback = cfg.augmented_message.clone();
            let prev_request: String = cfg
                .llm_history
                .iter()
                .rev()
                .find(|m| m.role == "user")
                .and_then(|m| m.content.as_ref())
                .map(|c| c.clone().into_text())
                .unwrap_or_default();
            // Use the PREVIOUS assistant reply from history (the bad reply the
            // user is correcting), not last_reply which is the response to the
            // current correction message.
            let prev_reply: String = cfg
                .llm_history
                .iter()
                .rev()
                .filter(|m| m.role == "assistant")
                .next()
                .and_then(|m| m.content.as_ref())
                .map(|c| c.clone().into_text())
                .unwrap_or_default();
            let prev_request_for_reflect = prev_request.clone();
            let prev_reply_for_reflect = prev_reply.clone();
            let config_fb_reflect = config_fb.clone();
            let sid_fb_reflect = sid.to_string();
            tokio::spawn(async move {
                react_agent::learn_from_feedback(&config_fb, &feedback, &prev_request, &prev_reply)
                    .await;
            });

            // Also reflect on the previous exchange as a failure.
            if !prev_request_for_reflect.is_empty() {
                log::info!(
                    "User correction detected, reflecting on previous exchange as failure"
                );
                tokio::spawn(async move {
                    react_agent::reflect_on_task(
                        &config_fb_reflect,
                        None,
                        Some(&sid_fb_reflect),
                        &prev_request_for_reflect,
                        &prev_reply_for_reflect,
                        false,
                        SignalType::ExplicitCorrection,
                    )
                    .await;
                });
            }
        }

        // --- Positive feedback detection ---
        // Detect explicit praise to reinforce correct behaviors.
        // "好的" means "OK" (acknowledgment), not praise — excluded.
        let praise_keywords_zh = ["很好", "太好了", "完美", "就是这样", "对的", "正是我要的", "没错"];
        let praise_keywords_en = ["perfect", "great", "exactly", "well done", "good job", "nice work"];

        let is_short_msg = msg.chars().count() < 15;

        let starts_with_praise = praise_keywords_zh.iter().any(|p| msg.starts_with(p))
            || praise_keywords_en.iter().any(|p| msg_lower.starts_with(p));

        // Exclude false positives where a praise word is part of a longer non-praise phrase.
        let false_positive_prefixes = ["很好奇", "很好的", "好的", "对的话", "就是这样的"];
        let is_false_positive = false_positive_prefixes.iter().any(|fp| msg.starts_with(fp));

        // Filter out messages with continuation ("好的，接下来...").
        let has_continuation = msg_lower.contains("但是")
            || msg_lower.contains("不过")
            || msg_lower.contains("but ")
            || msg_lower.contains("however")
            || msg_lower.contains("接下来")
            || msg_lower.contains("然后")
            || msg_lower.contains("帮我")
            || msg_lower.contains("再");

        let is_praise = is_short_msg && starts_with_praise && !has_continuation && !is_false_positive;

        if is_praise && !is_correction {
            // Reflect on the PREVIOUS exchange as a confirmed success.
            let prev_request: String = cfg
                .llm_history
                .iter()
                .rev()
                .find(|m| m.role == "user")
                .and_then(|m| m.content.as_ref())
                .map(|c| c.clone().into_text())
                .unwrap_or_default();

            if !prev_request.is_empty() {
                let config_praise = cfg.llm.clone();
                let prev_req = prev_request.clone();
                let prev_resp = last_reply.to_string();
                let sid_praise = sid.to_string();
                tokio::spawn(async move {
                    react_agent::reflect_on_task(
                        &config_praise,
                        None,
                        Some(&sid_praise),
                        &prev_req,
                        &prev_resp,
                        true,
                        SignalType::ExplicitPraise,
                    )
                    .await;
                });
                log::debug!("Praise detected, reinforcing previous exchange");
            }
        }
    }

    // Growth System: reflect on chat if tools were used (real work done).
    //
    // The hot path — SilentCompletion / ToolError / MaxIterations — fires on
    // every tool-using turn. We sample this path via `should_reflect_silent`
    // so only 1-in-N turns call the LLM; the ExplicitCorrection / ExplicitPraise
    // / AgentError paths above remain immediate because they're rare + high signal.
    if sink.tool_count() > 0 {
        let had_tool_errors = sink.tool_error_count() > 0;
        let hit_max_iterations = stop_reason == "max_rounds";
        let was_successful = !had_tool_errors && !hit_max_iterations;

        let signal_type = if had_tool_errors {
            SignalType::ToolError
        } else if hit_max_iterations {
            SignalType::MaxIterations
        } else {
            SignalType::SilentCompletion
        };

        if react_agent::should_reflect_silent(sid) {
            let config_ref = cfg.llm.clone();
            let user_msg = cfg.augmented_message.clone();
            let reply_ref = last_reply.to_string();
            let sid_ref = sid.to_string();

            log::debug!(
                "Reflection firing: was_successful={}, tool_errors={}, stop_reason={}, signal={:?}",
                was_successful,
                sink.tool_error_count(),
                stop_reason,
                signal_type,
            );

            tokio::spawn(async move {
                react_agent::reflect_on_task(
                    &config_ref,
                    None,
                    Some(&sid_ref),
                    &user_msg,
                    &reply_ref,
                    was_successful,
                    signal_type,
                )
                .await;
            });
        } else {
            log::debug!(
                "Reflection sampled OUT this turn (signal={:?}, was_successful={}). \
                 Sampling keeps 1-in-{} silent-completion reflections.",
                signal_type,
                was_successful,
                react_agent::SILENT_REFLECT_SAMPLE_EVERY,
            );
        }
    }

    // Memory extraction is delegated to MemMe's meditation pipeline (runs nightly).
}
