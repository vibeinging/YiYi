//! ConversationDriver —— 群聊"对话循环引擎"(见 docs/design/2026-05-31 §A)。
//!
//! 群聊不是静态 DAG,是开放轮次的对话循环。Driver **自己持有 finalize**:它一轮
//! 一轮同步推进(`orchestrator::run_round_step`),自己决定下一步、何时收口,而不是
//! 靠 orchestrator 的 "all-terminal 即自动 finalize"(那套是给静态 plan 的,会和
//! 动态续轮打架 —— 正是旧 chime-in 补丁 finalize 竞态的根)。
//!
//! Phase 1a:**单轮**形态 —— 全员一轮 reply-or-`<pass>`,全让则 YiYi 兜底,然后收口。
//! chime-in / 多轮讨论 / 全抢自纠是 Phase 1b 在同一循环里加 NextCandidates +
//! TerminationPolicy,本文件留好扩展点(`drive` 的循环骨架)。

use std::sync::Arc;

use crate::engine::agents::MemoryScope;
use crate::engine::collaboration::executor::ConcreteExecutor;
use crate::engine::collaboration::orchestrator::SqliteOrchestrator;
use crate::engine::collaboration::{
    ChatTurnSummary, CollaborationMode, CollaborationOrchestrator, CollaborationPlan,
    CollaborationStatus, CompanionProfile, Participant, Step, StepId, StepInput, StepKind,
    StepOutput, StepStatus,
};
use crate::engine::db::Database;
use crate::engine::llm_client::{chat_completion_tracked, LLMConfig, LLMMessage, MessageContent};
use crate::engine::usage::UsageSource;

/// 群讨论的硬轮数上限 —— judge 没提前判收敛时的兜底,防失控烧 token。
/// 开源 debate 实证:多数议题第 2 轮即收敛,3 是宽松上限。
const MAX_DISCUSSION_ROUNDS: i64 = 3;

/// 把群历史压成 executor 认的 metadata 形态(`[{role,text}]`)。
fn history_json(history: &[ChatTurnSummary]) -> serde_json::Value {
    serde_json::Value::Array(
        history
            .iter()
            .map(|t| serde_json::json!({ "role": t.role, "text": t.text }))
            .collect(),
    )
}

/// 构造一个 "group_round" step —— 全员 reply-or-`<pass>`,缓存友好的 prompt 由
/// executor::render_* 据 metadata.mode 渲染。
fn group_round_step(id: i64, participants: Vec<Participant>, history: &serde_json::Value, user_message: &str) -> Step {
    Step {
        id,
        kind: StepKind::ParallelAgents,
        participants,
        depends_on: vec![],
        input: StepInput {
            prompt: user_message.to_string(),
            metadata: serde_json::json!({ "mode": "group_round", "history": history }),
        },
        output: None,
        status: StepStatus::Pending,
        started_at: None,
        finished_at: None,
    }
}

/// 全让兜底位 —— 群里没人接,YiYi(companion 0)接住。
fn yiyi_fallback_step(id: i64, scope: MemoryScope, history: &serde_json::Value, user_message: &str) -> Step {
    Step {
        id,
        kind: StepKind::SingleAgent,
        participants: vec![Participant {
            companion_id: 0,
            name: "YiYi".into(),
            avatar_emoji: "🦊".into(),
            color_hex: "#6366F1".into(),
            memory_scope: scope,
        }],
        depends_on: vec![],
        input: StepInput {
            prompt: user_message.to_string(),
            metadata: serde_json::json!({ "mode": "yiyi_fallback", "history": history }),
        },
        output: None,
        status: StepStatus::Pending,
        started_at: None,
        finished_at: None,
    }
}

/// 发起一场群聊对话:建协作 + 第 1 轮 step → spawn Driver 循环(后台流式跑),
/// 立即返回 `(collab_id, 上场成员快照)`,调用方据此渲染 placeholder / 返回 Dispatched。
///
/// 注意:成员的实际"接 / 不接"在运行时由 fused prompt 自决(`<pass>`),这里把
/// **全员**放进第 1 轮 —— "谁该说话"不再前置判断,是发言本身的一部分。
pub async fn dispatch_group_conversation(
    db: Arc<Database>,
    cfg: LLMConfig,
    session_id: &str,
    user_message: &str,
    members: &[CompanionProfile],
    history: &[ChatTurnSummary],
    scope: MemoryScope,
) -> Result<(i64, Vec<Participant>), String> {
    let participants: Vec<Participant> = members
        .iter()
        .map(|c| Participant {
            companion_id: c.id,
            name: c.name.clone(),
            avatar_emoji: c.avatar_emoji.clone(),
            color_hex: c.color_hex.clone(),
            memory_scope: scope,
        })
        .collect();

    let hist = history_json(history);
    let round1 = group_round_step(1, participants.clone(), &hist, user_message);
    let plan = CollaborationPlan { steps: vec![round1.clone()] };

    let executor = Arc::new(ConcreteExecutor::new(cfg));
    let orch = SqliteOrchestrator::new(db.clone(), executor);
    let parent_id = orch
        .list_recent_by_session(session_id, 1)
        .ok()
        .and_then(|v| v.into_iter().next())
        .map(|c| c.id);

    let collab_id = orch.create_conversation(
        session_id,
        user_message,
        &plan,
        &CollaborationMode::Dispatched(0),
        parent_id,
    )?;

    // placeholder:@ 上全体,让消息列表先渲出"这一轮在场谁"(实际谁发言看流式)。
    let mention = participants
        .iter()
        .map(|p| format!("@{}", p.name))
        .collect::<Vec<_>>()
        .join(" ");
    let _ = db.upsert_collaboration_message(session_id, collab_id, &format!("{mention} {user_message}"));

    // spawn Driver 循环:跑第 1 轮 → 全让则 YiYi 兜底 → 收口。后台流式,不阻塞返回。
    let user_message_bg = user_message.to_string();
    tokio::spawn(async move {
        drive(orch, collab_id, round1, scope, hist, user_message_bg).await;
    });

    Ok((collab_id, participants))
}

/// Driver 循环本体(Phase 1a 单轮)。Phase 1b 在此把"单轮 + 收口"展开成
/// `loop { run_round; if 静默/judge/预算 → break; next_candidates }`。
async fn drive(
    orch: SqliteOrchestrator,
    collab_id: i64,
    round1: Step,
    scope: MemoryScope,
    history: serde_json::Value,
    user_message: String,
) {
    match orch.run_round_step(collab_id, &round1, &[]).await {
        Ok(Some(out)) => {
            // 全员 <pass>(combined 为空)= 全让 → YiYi 兜底位接住。
            if out.full_output.trim().is_empty() {
                let step2 = yiyi_fallback_step(2, scope, &history, &user_message);
                if orch.add_pending_step(collab_id, &step2).is_ok() {
                    let _ = orch.run_round_step(collab_id, &step2, &[]).await;
                }
            }
            let _ = orch.finalize_conversation(collab_id, CollaborationStatus::Done);
        }
        // 被 abort 抢占(CAS 落空)—— finalize 已由 abort 占,这里不再翻状态。
        Ok(None) => {}
        // 第 1 轮整步失败(全员报错)。
        Err(e) => {
            let _ = orch
                .finalize_conversation(collab_id, CollaborationStatus::Failed(format!("群聊执行失败: {e}")));
        }
    }
}

// ================================================================
// 多轮讨论模式(Phase 1b)—— 同一个对话循环引擎,换 TerminationPolicy + 收口。
// ================================================================
// 与 casual(单轮 reply-or-pass)的区别:讨论里成员**必答**(看见彼此、把话题往前
// 推),Driver 一轮轮跑,每轮后由 judge 判"收敛了吗",收敛或到上限就让 YiYi 收口
// 给结论。chime / 全抢自纠在这个循环里自然涌现(后轮看见前轮再调整)。

/// 一个讨论轮 step(ParallelAgents,必答;非 fused,无 `<pass>` 余地)。后轮靠
/// depends_on 串上前轮,executor 把前几轮发言喂进 prompt(render_user_prompt 的
/// upstream 分支),成员据此回应 / 补充 / 反驳。
fn discussion_round_step(id: StepId, participants: Vec<Participant>, topic: &str, depends_on: Vec<StepId>) -> Step {
    let prompt = if id == 1 {
        format!("群里在讨论这个话题,说说你的看法:\n{topic}")
    } else {
        "看看上面其他成员说了什么,回应 / 补充 / 提不同意见,把讨论往前推一步(别重复已经说过的)。".to_string()
    };
    Step {
        id,
        kind: StepKind::ParallelAgents,
        participants,
        depends_on,
        input: StepInput { prompt, metadata: serde_json::Value::Null },
        output: None,
        status: StepStatus::Pending,
        started_at: None,
        finished_at: None,
    }
}

/// YiYi 收口 step(HostSummarize)—— 看全程发言,给用户一个明确结论。
fn discussion_summary_step(id: StepId, scope: MemoryScope, topic: &str, depends_on: Vec<StepId>) -> Step {
    Step {
        id,
        kind: StepKind::HostSummarize,
        participants: vec![Participant {
            companion_id: 0,
            name: "YiYi".into(),
            avatar_emoji: "🦊".into(),
            color_hex: "#6366F1".into(),
            memory_scope: scope,
        }],
        depends_on,
        input: StepInput { prompt: topic.to_string(), metadata: serde_json::Value::Null },
        output: None,
        status: StepStatus::Pending,
        started_at: None,
        finished_at: None,
    }
}

/// judge:这场讨论收敛了吗?读最新一轮发言,flash 一次判断。返回 true = 可收口。
/// 失败/解析不出 → false(保守:继续讨论,反正有硬上限兜底)。
async fn judge_converged(cfg: &LLMConfig, latest_round: &str) -> bool {
    let prompt = format!(
        "下面是一场多人群讨论的最新一轮发言。判断:大家的观点是否已经基本收敛、\
         再来一轮也多半是重复?\n\n{latest_round}\n\n只回一个词:收敛 或 继续。",
    );
    let messages = vec![LLMMessage {
        role: "user".into(),
        content: Some(MessageContent::text(prompt)),
        tool_calls: None,
        tool_call_id: None,
        reasoning_content: None,
    }];
    match chat_completion_tracked(UsageSource::CollabDispatch, cfg, &messages, &[]).await {
        Ok(resp) => resp
            .message
            .content
            .map(|c| c.into_text())
            .map(|t| t.contains("收敛"))
            .unwrap_or(false),
        Err(_) => false,
    }
}

/// 发起一场群讨论:建协作 + spawn 多轮 Driver 循环。立即返回 collab_id。
pub async fn dispatch_group_discussion(
    db: Arc<Database>,
    cfg: LLMConfig,
    session_id: &str,
    topic: &str,
) -> Result<i64, String> {
    let gid = db
        .get_session_group(session_id)
        .ok_or_else(|| "session 未绑群,无法讨论".to_string())?;
    let companions = db.list_group_members(gid);
    if companions.is_empty() {
        return Err("空群无法讨论".into());
    }
    let scope = MemoryScope::Group(gid);
    let participants: Vec<Participant> = companions
        .iter()
        .map(|c| Participant {
            companion_id: c.id,
            name: c.name.clone(),
            avatar_emoji: c.avatar_emoji.clone(),
            color_hex: c.color_hex.clone(),
            memory_scope: scope,
        })
        .collect();

    let round1 = discussion_round_step(1, participants.clone(), topic, vec![]);
    let plan = CollaborationPlan { steps: vec![round1.clone()] };

    let executor = Arc::new(ConcreteExecutor::new(cfg.clone()));
    let orch = SqliteOrchestrator::new(db.clone(), executor);
    let parent_id = orch
        .list_recent_by_session(session_id, 1)
        .ok()
        .and_then(|v| v.into_iter().next())
        .map(|c| c.id);
    let collab_id =
        orch.create_conversation(session_id, topic, &plan, &CollaborationMode::Dispatched(0), parent_id)?;

    let mention = participants.iter().map(|p| format!("@{}", p.name)).collect::<Vec<_>>().join(" ");
    let _ = db.upsert_collaboration_message(session_id, collab_id, &format!("[群讨论] {mention} {topic}"));

    let topic_bg = topic.to_string();
    tokio::spawn(async move {
        drive_discussion(orch, cfg, collab_id, round1, participants, scope, topic_bg).await;
    });

    Ok(collab_id)
}

/// 多轮讨论循环本体:轮 → judge 判收敛 → (收敛/到顶则)YiYi 收口 → finalize。
async fn drive_discussion(
    orch: SqliteOrchestrator,
    cfg: LLMConfig,
    collab_id: i64,
    round1: Step,
    participants: Vec<Participant>,
    scope: MemoryScope,
    topic: String,
) {
    // 累积每一轮产出,既做下一轮的 upstream(看见全程),也做收口的 upstream。
    let mut all_outputs: Vec<(StepId, StepOutput)> = Vec::new();
    let mut round: StepId = 1;
    loop {
        // round 1 已在 create_conversation 的 plan 里;后轮运行时追加。
        let step = if round == 1 {
            round1.clone()
        } else {
            let s = discussion_round_step(round, participants.clone(), &topic, vec![round - 1]);
            if orch.add_pending_step(collab_id, &s).is_err() {
                return;
            }
            s
        };
        let out = match orch.run_round_step(collab_id, &step, &all_outputs).await {
            Ok(Some(o)) => o,
            Ok(None) => return, // 被 abort
            Err(e) => {
                let _ = orch.finalize_conversation(
                    collab_id,
                    CollaborationStatus::Failed(format!("讨论第 {round} 轮失败: {e}")),
                );
                return;
            }
        };
        let latest = out.full_output.clone();
        all_outputs.push((round, out));

        if round >= MAX_DISCUSSION_ROUNDS {
            break;
        }
        // judge:收敛就提前收口,否则再来一轮(全抢自纠 / chime 在后轮自然发生)。
        if judge_converged(&cfg, &latest).await {
            break;
        }
        round += 1;
    }

    // YiYi 收口 —— 看全程,给结论。
    let summary = discussion_summary_step(round + 1, scope, &topic, all_outputs.iter().map(|(id, _)| *id).collect());
    if orch.add_pending_step(collab_id, &summary).is_ok() {
        let _ = orch.run_round_step(collab_id, &summary, &all_outputs).await;
    }
    let _ = orch.finalize_conversation(collab_id, CollaborationStatus::Done);
}
