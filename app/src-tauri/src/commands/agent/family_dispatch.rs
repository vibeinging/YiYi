//! family_dispatch — 家族会话的「host 上游路由」。
//!
//! 当一个 session 开启了家族模式（见 `db.get_session_family_mode`），主精灵
//! 在自己回答之前先用 `LLMDispatchStrategy::judge` 扫一遍当前 active 家族：
//! 若它以足够置信度选中某个成员，就**派遣**一个单 companion 协作（复用 Phase 2B
//! 的 `delegate_to_companion` → orchestrator 路径）而不是自答；否则主精灵照常自答。
//!
//! 设计：`docs/design/2026-05-27_家族会话-host调度群聊.md`（Approach A）。
//! 路由 strategy（`judge`）本体已实现 + 测试，这里只是把它接进 chat 路径：
//! 组装 `DispatchContext` → judge → 按 confidence 门控 → `submit(Dispatched)`。
//!
//! 本函数刻意**不持有 `AppHandle`**：它只碰 db + LLM，返回一个
//! [`FamilyDispatchOutcome`]，由调用方（chat 命令）负责 emit Tauri 事件、决定
//! 是否还要跑主精灵自答。这样核心路由逻辑可在 TempDb + mock LLM 下直接测。

use std::sync::Arc;

use crate::engine::agents::MemoryScope;
use crate::engine::collaboration::audit::AuditTrail;
use crate::engine::collaboration::claim::{run_chime_in_round, run_claim_round};
use crate::engine::collaboration::dispatch::llm_strategy::LLMDispatchStrategy;
use crate::engine::collaboration::dispatch::DispatchStrategy;
use crate::engine::collaboration::executor::ConcreteExecutor;
use crate::engine::collaboration::learning::sqlite_sink::SqliteLearningSink;
use crate::engine::collaboration::learning::LearningSink;
use crate::engine::collaboration::orchestrator::SqliteOrchestrator;
use crate::engine::collaboration::{
    Actor, AuditKind, ChatTurnSummary, CollaborationEvent, CollaborationMode,
    CollaborationOrchestrator, CompanionProfile, DispatchContext, Mutation, Participant, Step,
    StepInput, StepKind, StepStatus,
};
use crate::engine::db::Database;
use crate::engine::llm_client::LLMConfig;

/// 喂给路由判断的最近对话轮数。有界，免得家族聊久了把（高频、本应便宜的）
/// 路由 prompt 撑大 —— 见设计 Open Question 5。
const DISPATCH_HISTORY_TURNS: usize = 6;
/// 取多少条最近的用户改派/反馈信号给路由参考。
const RECENT_CORRECTIONS: usize = 8;
/// 低于此置信度主精灵自答。与 `DispatchDecision` 文档及 judge 的 fallback 一致。
const DISPATCH_CONFIDENCE_FLOOR: f64 = 0.5;

/// 一次家族路由的结果。调用方据此决定是否继续跑主精灵自答。
///
/// L1 多成员模型:Dispatched 携带 N 个成员(1+);UI 同框冒出多个气泡(群聊感)。
/// 没有路由卡 —— "谁选的、为什么"沉到 audit / 日志,前台只见成员发言。
#[derive(Debug, Clone)]
pub enum FamilyDispatchOutcome {
    /// 主精灵自答 —— 家族为空 / 没人入选 / judge 兜底。`reason` 仅用于日志和 audit。
    SelfAnswer { reason: String },
    /// 已派遣给 N 位家族成员(1 或多个),对应 ParallelAgents 协作正在后台并发执行。
    Dispatched {
        collaboration_id: i64,
        /// 入选成员快照,顺序与 plan 中 participants 一致。
        members: Vec<DispatchedMember>,
    },
}

/// 派遣成员的轻量快照 —— 给上层日志 / 后续可能的事件回播用。
#[derive(Debug, Clone)]
pub struct DispatchedMember {
    pub companion_id: i64,
    pub name: String,
    pub avatar_emoji: String,
    pub color_hex: String,
}

/// 在家族模式下尝试把 `user_message` 路由给某位成员。
///
/// `cfg` 同时用于路由判断（judge）与被选成员的执行（ConcreteExecutor）。Phase A
/// 复用 session 的 LLM 配置；未来可让 judge 走更便宜的小模型（Open Question 3）。
pub async fn try_family_dispatch(
    db: Arc<Database>,
    cfg: LLMConfig,
    session_id: &str,
    user_message: &str,
) -> Result<FamilyDispatchOutcome, String> {
    // 1. session 必须绑定具名 group(IM 心智:group = 群聊窗口,1:1)。
    //    未绑 → 直接当单聊,回退主精灵自答。caller 应已用 group_id 判断,
    //    这里再守一遍。
    let Some(gid) = db.get_session_group(session_id) else {
        return Ok(FamilyDispatchOutcome::SelfAnswer {
            reason: "session 未绑家族,单聊主精灵".into(),
        });
    };
    let companions = db.list_group_members(gid);
    let family_scope = crate::engine::agents::MemoryScope::FamilyGroup(gid);
    let family: Vec<CompanionProfile> = companions
        .into_iter()
        .map(|c| CompanionProfile {
            id: c.id,
            name: c.name,
            avatar_emoji: c.avatar_emoji,
            color_hex: c.color_hex,
            // 一行角色描述：优先用户设的 role_label，缺省回落到 agent 定义名。
            description: c.role_label.unwrap_or_else(|| c.agent_definition_name.clone()),
            agent_definition_name: c.agent_definition_name,
            last_used_at: c.last_used_at,
        })
        .collect();

    // 2. 近 N 轮对话 + 最近学习信号 → DispatchContext。
    let chat_history: Vec<ChatTurnSummary> = db
        .get_recent_messages(session_id, DISPATCH_HISTORY_TURNS)
        .unwrap_or_default()
        .into_iter()
        .map(|m| ChatTurnSummary {
            role: m.role,
            text: m.content,
            timestamp: m.timestamp,
        })
        .collect();
    let recent_corrections = SqliteLearningSink::new(db.clone())
        .recent(RECENT_CORRECTIONS)
        .await
        .unwrap_or_default();

    let ctx = DispatchContext {
        user_intent: user_message.to_string(),
        chat_history,
        family,
        recent_corrections,
    };

    // 3. L1 集中粗筛:strategy 一次 LLM 选出"该响应的所有成员"。
    //    strategy 从不硬失败,任何错误都回落空 plan + confidence 0.0。
    let mut decision = LLMDispatchStrategy::new(cfg.clone()).judge(&ctx).await?;

    // 4. 门控:空 plan / 无成员 / 置信度不足 → 主精灵自答。
    let Some(candidates_snapshot) = decision
        .plan
        .steps
        .first()
        .map(|s| s.participants.clone())
        .filter(|ps| !ps.is_empty())
    else {
        return Ok(FamilyDispatchOutcome::SelfAnswer { reason: decision.reason });
    };
    if decision.confidence < DISPATCH_CONFIDENCE_FLOOR {
        return Ok(FamilyDispatchOutcome::SelfAnswer { reason: decision.reason });
    }

    // 4.5. L2 个体精筛:每位候选自己看消息决定接不接(slock 风格 self-claim)。
    //      claim_round 并发跑 N 次轻量 LLM,wall clock ≈ 1 次。每位返回
    //      {claimed, reason}。失败默认不接(保守不抢话)。
    //      候选 profiles 从 ctx.family 按 id 反查 —— Participant 没带回 description,
    //      但 ctx.family 里有,直接复用。
    let candidate_profiles: Vec<CompanionProfile> = candidates_snapshot
        .iter()
        .filter_map(|p| ctx.family.iter().find(|c| c.id == p.companion_id).cloned())
        .collect();
    let claims = run_claim_round(&cfg, user_message, &ctx.chat_history, &candidate_profiles).await;

    // 选 claimed=true 的成员;若全 no but 候选非空 → 防沉默,挑 confidence 最高的
    // 那位(strategy 已按 confidence desc 排序,候选[0] 即最高)。
    let mut claimed_ids: Vec<i64> =
        claims.iter().filter(|c| c.claimed).map(|c| c.companion_id).collect();
    let used_silence_fallback = claimed_ids.is_empty();
    if used_silence_fallback {
        if let Some(first) = candidates_snapshot.first() {
            claimed_ids.push(first.companion_id);
        } else {
            // 不应到这里(上面 filter 已确保非空),保险起见仍走自答。
            return Ok(FamilyDispatchOutcome::SelfAnswer { reason: decision.reason });
        }
    }

    // 用 claimed_ids 过滤 plan.participants(保序),同时翻成 family scope。
    // 这里 mutate plan 是为了 submit 的 plan 与 outcome / audit 对齐。
    for step in &mut decision.plan.steps {
        step.participants.retain(|p| claimed_ids.contains(&p.companion_id));
        for p in &mut step.participants {
            p.memory_scope = family_scope;
        }
    }
    // participants_snapshot 是过滤后的最终上场名单 —— 用于 audit / outcome /
    // placeholder。strategy 已按 confidence desc 排序,这里保序。
    let participants_snapshot: Vec<Participant> = decision
        .plan
        .steps
        .first()
        .map(|s| s.participants.clone())
        .unwrap_or_default();

    // 5. 派遣：提交单 companion 协作，并以 parent_id 串到本 session 上一个协作
    //    （每轮独立可审计 —— 设计步骤 5 拍板用 parent_id 链）。
    //    cfg 在这里 clone 进 executor;原始 cfg 后面给 L3 chime-in 用。
    let executor = Arc::new(ConcreteExecutor::new(cfg.clone()));
    let orch = SqliteOrchestrator::new(db.clone(), executor);
    let parent_id = orch
        .list_recent_by_session(session_id, 1)
        .ok()
        .and_then(|v| v.into_iter().next())
        .map(|c| c.id);

    let collab_id = orch
        .submit(
            session_id.to_string(),
            user_message.to_string(),
            decision.plan,
            CollaborationMode::Dispatched(0), // 0 = 主精灵 as dispatcher
            parent_id,
        )
        .await?;

    // 持久化路由决策 —— `DispatchJudged` audit 让刷新 / 重放也能看到 judge 选了谁。
    // L2 形态:audit payload 同时记录 L1 候选 + L2 每位 claim 决定 + 是否走了
    // 沉默兜底,让用户事后能审"判断链"(透明 > 智能)。
    // emit 同时广播 collaboration://event 流(live 推送),失败不阻断派遣。
    let member_audit: Vec<_> = participants_snapshot
        .iter()
        .map(|p| {
            serde_json::json!({
                "companion_id": p.companion_id,
                "name": &p.name,
                "avatar_emoji": &p.avatar_emoji,
                "color_hex": &p.color_hex,
            })
        })
        .collect();
    let candidates_audit: Vec<_> = candidates_snapshot
        .iter()
        .map(|p| {
            serde_json::json!({
                "companion_id": p.companion_id,
                "name": &p.name,
            })
        })
        .collect();
    let claims_audit: Vec<_> = claims
        .iter()
        .map(|c| {
            serde_json::json!({
                "companion_id": c.companion_id,
                "claimed": c.claimed,
                "reason": &c.reason,
            })
        })
        .collect();
    let _ = AuditTrail::new(db.clone()).emit(
        collab_id,
        Actor::Companion(0),
        AuditKind::DispatchJudged,
        serde_json::json!({
            "members": member_audit,
            "candidates": candidates_audit,
            "claims": claims_audit,
            "silence_fallback": used_silence_fallback,
            "reason": &decision.reason,
            "confidence": decision.confidence,
        }),
    );

    // 预写内联 collaboration 消息,turn 结束时前端立刻渲染卡片。N 个成员都 @ 上,
    // 用户看消息列表 placeholder 就知道这一轮邀了谁。
    let mention_chain: String = participants_snapshot
        .iter()
        .map(|p| format!("@{}", p.name))
        .collect::<Vec<_>>()
        .join(" ");
    let placeholder = format!("{} {}", mention_chain, user_message);
    let _ = db.upsert_collaboration_message(session_id, collab_id, &placeholder);

    let dispatched_members: Vec<DispatchedMember> = participants_snapshot
        .into_iter()
        .map(|p: Participant| DispatchedMember {
            companion_id: p.companion_id,
            name: p.name,
            avatar_emoji: p.avatar_emoji,
            color_hex: p.color_hex,
        })
        .collect();

    // 6. L3 chime-in 第 2 轮:第 1 轮没接的候选,可能看了别人说啥后想补一刀。
    //    后台 tokio task 跑:订阅事件 → 等 step 1 完成 → chime-in claim → AddStep。
    //    fire-and-forget:失败 / abort / 没人补刀都默默退出,不影响第 1 轮派遣结果。
    let chime_candidates: Vec<CompanionProfile> = candidate_profiles
        .into_iter()
        .filter(|p| !claimed_ids.contains(&p.id))
        .collect();
    if !chime_candidates.is_empty() {
        let db_bg = db.clone();
        let cfg_bg = cfg.clone();
        let intent_bg = user_message.to_string();
        let history_bg = ctx.chat_history.clone();
        tokio::spawn(async move {
            run_chime_in_background(
                db_bg,
                cfg_bg,
                collab_id,
                intent_bg,
                history_bg,
                chime_candidates,
                family_scope,
            )
            .await;
        });
    }

    Ok(FamilyDispatchOutcome::Dispatched {
        collaboration_id: collab_id,
        members: dispatched_members,
    })
}

/// L3 chime-in 后台流程 —— fire-and-forget,失败不抛错(只打 log)。
///
/// 流程:
/// 1. 订阅 collaboration event,等本 collab_id 的 step 1 `StepCompleted` 事件
/// 2. 同时监听 terminal 事件(Aborted/Failed/Completed),提前退出
/// 3. 拿 step 1 transcript → run_chime_in_round → 过滤 yes
/// 4. 有 yes → 构造 ParallelAgents step 2 → orch.mutate(AddStep) 追加
///
/// step 2 自动被 `schedule_ready_steps` 启动,UI 会看到新一组 ParallelAgentStepCard。
async fn run_chime_in_background(
    db: Arc<Database>,
    cfg: LLMConfig,
    collab_id: i64,
    intent: String,
    chat_history: Vec<ChatTurnSummary>,
    candidates: Vec<CompanionProfile>,
    family_scope: MemoryScope,
) {
    let executor = Arc::new(ConcreteExecutor::new(cfg.clone()));
    let orch = SqliteOrchestrator::new(db.clone(), executor);
    let mut rx = orch.subscribe_all();

    // 等 step 1 完成。同时监听 terminal 事件提前退出。lagged / channel 关也退。
    loop {
        match rx.recv().await {
            Ok(CollaborationEvent::Audit { event }) if event.collaboration_id == collab_id => {
                match event.kind {
                    AuditKind::StepCompleted => break,
                    AuditKind::Aborted
                    | AuditKind::Failed
                    | AuditKind::CollaborationCompleted => return,
                    _ => continue,
                }
            }
            Ok(_) => continue,
            Err(_) => return,
        }
    }

    // 拿 step 1 transcript。orch.load 同步版本,避免 Send 跨 await 麻烦。
    let collab = match orch.load(collab_id) {
        Ok(Some(c)) => c,
        _ => return,
    };
    let first_step = match collab.plan.steps.first() {
        Some(s) => s,
        None => return,
    };
    let transcript = first_step
        .output
        .as_ref()
        .map(|o| o.full_output.clone())
        .unwrap_or_default();
    if transcript.is_empty() {
        return;
    }

    // chime-in claim 并发跑。失败的成员默认 no(claim.rs 内部已保守)。
    let claims = run_chime_in_round(&cfg, &intent, &transcript, &chat_history, &candidates).await;
    let chime_yes: Vec<&CompanionProfile> = candidates
        .iter()
        .zip(claims.iter())
        .filter(|(_, c)| c.claimed)
        .map(|(p, _)| p)
        .collect();
    if chime_yes.is_empty() {
        return;
    }

    // 构造 step 2 —— 新 id = 现有 max + 1。input.prompt 带第 1 轮 transcript,
    // 让 chime-in 成员的 ReAct loop 看得见上下文。memory_scope 与第 1 轮一致。
    let next_id = collab.plan.steps.iter().map(|s| s.id).max().unwrap_or(0) + 1;
    let step2 = Step {
        id: next_id,
        kind: StepKind::ParallelAgents,
        participants: chime_yes
            .iter()
            .map(|c| Participant {
                companion_id: c.id,
                name: c.name.clone(),
                avatar_emoji: c.avatar_emoji.clone(),
                color_hex: c.color_hex.clone(),
                memory_scope: family_scope,
            })
            .collect(),
        depends_on: vec![],
        input: StepInput {
            prompt: format!(
                "{}\n\n(其他成员刚才说了:\n{})\n请基于上面补充你的角度。",
                intent, transcript
            ),
            metadata: serde_json::Value::Null,
        },
        output: None,
        status: StepStatus::Pending,
        started_at: None,
        finished_at: None,
    };

    if let Err(e) = orch.mutate(collab_id, Mutation::AddStep { step: step2 }).await {
        eprintln!("chime-in AddStep 失败:{e}");
    }
}
