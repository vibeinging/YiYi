//! ConversationDriver —— 群聊"对话循环引擎"(见 docs/design/2026-05-31 §A)。
//!
//! 群聊不是静态 DAG,是开放轮次的对话循环。Driver **自己持有 finalize**:它一轮
//! 一轮同步推进(`orchestrator::run_round_step`),自己决定下一步、何时收口,而不是
//! 靠 orchestrator 的 "all-terminal 即自动 finalize"(那套是给静态 plan 的,会和
//! 动态续轮打架 —— 正是旧 chime-in 补丁 finalize 竞态的根)。

use std::sync::Arc;

use crate::engine::agents::MemoryScope;
use crate::engine::collaboration::executor::ConcreteExecutor;
use crate::engine::collaboration::orchestrator::SqliteOrchestrator;
use crate::engine::collaboration::{
    ChatTurnSummary, CollaborationMode, CollaborationPlan,
    CollaborationStatus, CompanionProfile, Participant, Step, StepId, StepInput, StepKind,
    StepStatus,
};
use crate::engine::db::Database;
use crate::engine::llm_client::LLMConfig;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex as StdMutex, OnceLock};
use std::time::Duration;
use tokio::sync::{mpsc, Notify};

// ================================================================
// 群事件循环:异步事件驱动 + 变速发言,成员各自参差延迟接话、冷场自然收口。
// 设计:docs/design/2026-06-01_群聊-异步事件循环-v2.md
// ================================================================

/// 全程没人发言时的兜底位 —— 群静默,YiYi(companion 0)接住,不让用户等到天荒地老。
fn yiyi_fallback_step(id: StepId, scope: MemoryScope, history: &serde_json::Value, user_message: &str) -> Step {
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

/// session → 在跑群循环的取消句柄。用户在同一会话发新消息时,先抢占(取消)旧循环
/// 再起新的(决策 D:新消息 abort 旧群 collab)。
type GroupCancel = (Arc<AtomicBool>, Arc<Notify>);
fn group_loop_registry() -> &'static StdMutex<HashMap<String, GroupCancel>> {
    static R: OnceLock<StdMutex<HashMap<String, GroupCancel>>> = OnceLock::new();
    R.get_or_init(|| StdMutex::new(HashMap::new()))
}
/// 注册新循环;若该 session 已有在跑循环 → 先 cancel + notify 抢占它。
fn register_and_preempt(session_id: &str, cancel: Arc<AtomicBool>, notify: Arc<Notify>) {
    let mut reg = group_loop_registry().lock().unwrap_or_else(|e| e.into_inner());
    if let Some((old_c, old_n)) = reg.insert(session_id.to_string(), (cancel, notify)) {
        old_c.store(true, Ordering::Relaxed);
        old_n.notify_waiters();
    }
}
/// 用户喊停:立即取消该会话在跑的群循环(cancel + notify),返回是否真停了一个。不从注册表
/// 摘除 —— 让循环自己 break 后 deregister,避免和并发抢占 / 收尾打架。
pub fn stop_group_loop(session_id: &str) -> bool {
    let reg = group_loop_registry().lock().unwrap_or_else(|e| e.into_inner());
    if let Some((c, n)) = reg.get(session_id) {
        c.store(true, Ordering::Relaxed);
        n.notify_waiters();
        true
    } else {
        false
    }
}
/// 循环结束时摘除自己(仅当注册表里仍是自己,避免误删已抢占进来的新循环)。
fn deregister_group_loop(session_id: &str, cancel: &Arc<AtomicBool>) {
    let mut reg = group_loop_registry().lock().unwrap_or_else(|e| e.into_inner());
    if reg.get(session_id).map(|(c, _)| Arc::ptr_eq(c, cancel)).unwrap_or(false) {
        reg.remove(session_id);
    }
}

const REACT_DELAY_MIN_MS: u64 = 5000;
const REACT_DELAY_SPAN_MS: u64 = 25000; // 5000..30000ms = 随机 5–30 秒

/// 群"放养式"持续群聊的护栏。**全是防失控的硬上限,不是体验上限**——产品意图是"他们自己
/// 一直聊到冷场或用户打断"(用户决策:热闹 + 不设限 + 我喊停)。正常停因是 ① 用户发消息打断
/// ② 连续几波重新点火仍没人接(真冷场)。下面数值只在 bug 失控时兜底,免得无限烧 token;
/// 测试注入小值以快速验证"撞顶会停"。
#[derive(Clone)]
struct GroupLimits {
    /// 可见发言硬上限。
    max_messages: u32,
    /// LLM 调用硬上限(reply + pass 都计数)—— 真正卡钱的闸。
    max_calls: u32,
    /// 整场墙钟硬兜底。
    wall: Duration,
    /// 连续多少"波"重新点火仍无人开口 → 判定聊散了,收口。
    revive_max_dry: u32,
    /// 「忙时积压」去抖:成员回复中群里又有新发言它没看到(mailbox),回复完等这么久再合并
    /// 补看一波(react 取全量最新快照 = 一次看完积压)。用户要的"统一回复 + 5 秒"。
    wake_debounce: Duration,
}
impl GroupLimits {
    fn production() -> Self {
        Self {
            max_messages: 200,
            max_calls: 500,
            wall: Duration::from_secs(1800), // 30 分钟硬兜底
            revive_max_dry: 2,
            wake_debounce: Duration::from_millis(5000),
        }
    }
}

/// 变速:每个成员每次反应摇一个**随机 5–30 秒**延迟,模拟"真人看到群消息的时刻各不相同"。
/// 被用户 @ 点名的成员例外:wave-1 立即回(delay=0),见 drive_group_loop 的 forced 处理。
/// 熵源用系统时钟纳秒(app 非 workflow,可用时钟),再混入 companion_id+salt —— 保证并发同一
/// 时刻 spawn 的多个成员也各摇各的。慢的人 sleep 期间会收齐更多消息(react 时取最新历史快照),
/// 这就是"慢就是快"。注:测试不走这里(注入确定的 delay_fn),随机不影响测试可重复性。
fn react_delay(companion_id: i64, salt: u64) -> Duration {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    let seed = nanos
        .wrapping_mul(2654435761)
        .wrapping_add((companion_id as u64).wrapping_mul(40503))
        .wrapping_add(salt.wrapping_mul(2246822519))
        .rotate_left(13);
    Duration::from_millis(REACT_DELAY_MIN_MS + seed % REACT_DELAY_SPAN_MS)
}

/// 用户这句是不是"要个结论"——命中则群聊冷场后让 YiYi 收口给结论(决策 §6:
/// 退役硬总结,但保留显式"要结论"出口,别把已上线价值清零)。
fn wants_conclusion(msg: &str) -> bool {
    const KW: &[&str] = &[
        "结论", "总结", "归纳", "给个说法", "拍板", "最终", "到底怎么", "给我个答案", "给我答案",
    ];
    KW.iter().any(|k| msg.contains(k))
}

/// YiYi 收口 step(SingleAgent,mode=yiyi_summary)—— 仅"用户要结论 + 自然冷场"时跑。
fn yiyi_summary_step(id: StepId, scope: MemoryScope, history: &serde_json::Value, user_message: &str) -> Step {
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
            metadata: serde_json::json!({ "mode": "yiyi_summary", "history": history }),
        },
        output: None,
        status: StepStatus::Pending,
        started_at: None,
        finished_at: None,
    }
}

/// 一条"成员发言"= 一个 1-participant step(mode=group_loop)。history 在 spawn 之后、
/// 取最新快照时填(决策 A + 慢者看到更多)。
fn loop_step(id: StepId, p: Participant, history: &serde_json::Value, user_message: &str) -> Step {
    Step {
        id,
        kind: StepKind::ParallelAgents, // 1 participant → executor 退化成单成员加【名字】前缀,前端切段零改
        participants: vec![p],
        depends_on: vec![],
        input: StepInput {
            prompt: user_message.to_string(),
            metadata: serde_json::json!({ "mode": "group_loop", "history": history }),
        },
        output: None,
        status: StepStatus::Pending,
        started_at: None,
        finished_at: None,
    }
}

/// 一个成员反应任务的结果(text 为空 / `<pass>` = 没发言)。
struct ReactDone {
    author: i64,
    name: String,
    text: String,
}

type SharedHistory = Arc<StdMutex<Vec<(String, String)>>>;

fn turns_to_json(turns: &[(String, String)]) -> serde_json::Value {
    serde_json::Value::Array(
        turns.iter().map(|(r, t)| serde_json::json!({ "role": r, "text": t })).collect(),
    )
}

/// 单个成员的一次反应:变速 sleep(可取消)→ 取最新历史快照 → 跑 1-participant step →
/// 把结果投回 Driver 邮箱。决策 D 的检查点①②在此(③流式中途取消留待增量 2)。
#[allow(clippy::too_many_arguments)]
async fn react_once(
    orch: Arc<SqliteOrchestrator>,
    collab_id: i64,
    history: SharedHistory,
    cancel: Arc<AtomicBool>,
    notify: Arc<Notify>,
    tx: mpsc::UnboundedSender<ReactDone>,
    p: Participant,
    step_id: StepId,
    delay: Duration,
    user_message: String,
) {
    let pass = |tx: &mpsc::UnboundedSender<ReactDone>| {
        let _ = tx.send(ReactDone { author: p.companion_id, name: p.name.clone(), text: String::new() });
    };
    // 检查点①:变速 sleep,可被 notify 打断(取消 / 墙钟到点)。
    tokio::select! {
        _ = tokio::time::sleep(delay) => {}
        _ = notify.notified() => { pass(&tx); return; }
    }
    if cancel.load(Ordering::Relaxed) { pass(&tx); return; }
    // 取最新历史快照(慢者看到更全上下文)。锁内只克隆,不跨 await。
    let snap = { history.lock().unwrap_or_else(|e| e.into_inner()).clone() };
    let step = loop_step(step_id, p.clone(), &turns_to_json(&snap), &user_message);
    // 检查点②:发 LLM 前。
    if cancel.load(Ordering::Relaxed) { pass(&tx); return; }
    // typing 占位:延迟到点、开始发言 → 前端让这条气泡错时冒出(变速参差的可见信号)。
    crate::engine::collaboration::events::emit(
        crate::engine::collaboration::CollaborationEvent::MemberThinking {
            collaboration_id: collab_id,
            step_id,
            companion_id: p.companion_id,
        },
    );
    let text = match orch.run_round_step(collab_id, &step, &[]).await {
        Ok(Some(out)) => out.full_output, // None=被抢占 / Err=失败 → 视作没发言
        _ => String::new(),
    };
    let _ = tx.send(ReactDone { author: p.companion_id, name: p.name.clone(), text });
}

/// 发起一场群事件循环(v2)。建协作(wave-1:每成员一个 1-participant pending step,id 1..N)
/// → spawn Driver actor 循环。立即返回 `(collab_id, 上场成员)`。
pub async fn dispatch_group_loop(
    db: Arc<Database>,
    cfg: LLMConfig,
    session_id: &str,
    user_message: &str,
    members: &[CompanionProfile],
    history: &[ChatTurnSummary],
    scope: MemoryScope,
    forced_ids: &[i64],
) -> Result<(i64, Vec<Participant>), String> {
    let mut participants: Vec<Participant> = members
        .iter()
        .map(|c| Participant {
            companion_id: c.id,
            name: c.name.clone(),
            avatar_emoji: c.avatar_emoji.clone(),
            color_hex: c.color_hex.clone(),
            memory_scope: scope,
        })
        .collect();
    if participants.is_empty() {
        return Err("群事件循环:空群".into());
    }
    // YiYi(companion 0)也作为一员入群参与(用户要求:YiYi 要一起聊)。放群成员之后,和其他人
    // 一样变速接话 / pass(走 group_loop prompt)。防重:群里若真有 companion 0 就不重复加。
    if !participants.iter().any(|p| p.companion_id == 0) {
        participants.push(Participant {
            companion_id: 0,
            name: "YiYi".into(),
            avatar_emoji: "🦊".into(),
            color_hex: "#6366F1".into(),
            memory_scope: scope,
        });
    }

    // 共享历史 = 本回合之前的对话(不含这一句用户消息;用户消息走每个 step 的 prompt/【用户刚说】)。
    let prior: Vec<(String, String)> = history.iter().map(|t| (t.role.clone(), t.text.clone())).collect();
    let hist0 = turns_to_json(&prior);

    // wave-1:每成员一个 pending 1-participant step(id 1..N)。
    let wave1: Vec<Step> = participants
        .iter()
        .enumerate()
        .map(|(i, p)| loop_step((i + 1) as StepId, p.clone(), &hist0, user_message))
        .collect();
    let plan = CollaborationPlan { steps: wave1 };

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

    let mention = participants.iter().map(|p| format!("@{}", p.name)).collect::<Vec<_>>().join(" ");
    let _ = db.upsert_collaboration_message(session_id, collab_id, &format!("{mention} {user_message}"));

    // 取消句柄 + 抢占:用户在本会话再发一句 → 先 cancel 旧循环再起新的。
    let cancel = Arc::new(AtomicBool::new(false));
    let notify = Arc::new(Notify::new());
    register_and_preempt(session_id, cancel.clone(), notify.clone());

    let participants_ret = participants.clone();
    let user_msg = user_message.to_string();
    let sid = session_id.to_string();
    // 被 @ 点名的成员 → wave-1 立即回(delay=0),其余变速。
    let forced: Vec<i64> = forced_ids.to_vec();
    tokio::spawn(async move {
        drive_group_loop(
            orch, collab_id, &sid, participants, scope, prior, user_msg, cancel, notify, react_delay,
            GroupLimits::production(), forced,
        )
        .await;
    });
    Ok((collab_id, participants_ret))
}

/// Driver actor 循环本体:单线程消费成员发言、串行 append 历史、扇出下一波、可判定终止。
/// `delay_fn` 可注入(生产传 `react_delay`,测试传确定值)。`cancel`/`notify` 由调用方
/// 持有并注册,支持被新消息抢占。
#[allow(clippy::too_many_arguments)]
async fn drive_group_loop(
    orch: SqliteOrchestrator,
    collab_id: i64,
    session_id: &str,
    participants: Vec<Participant>,
    scope: MemoryScope,
    prior_turns: Vec<(String, String)>,
    user_message: String,
    cancel: Arc<AtomicBool>,
    notify: Arc<Notify>,
    delay_fn: fn(i64, u64) -> Duration,
    limits: GroupLimits,
    forced: Vec<i64>,
) {
    let orch = Arc::new(orch);
    let history: SharedHistory = Arc::new(StdMutex::new(prior_turns));
    let (tx, mut rx) = mpsc::unbounded_channel::<ReactDone>();

    // 护栏全是 Copy 字段,解构成局部量;它们是"防失控硬上限"不是体验上限。
    let GroupLimits { max_messages, max_calls, wall, revive_max_dry, wake_debounce } = limits;
    let at_hard_cap = |calls: u32, msg: u32| calls >= max_calls || msg >= max_messages;

    let mut next_id: StepId = participants.len() as StepId; // wave-1 用掉 1..N
    let mut inflight: i64 = 0;
    let mut calls: u32 = 0;
    let mut msg_count: u32 = 0;
    let mut reacting: HashSet<i64> = HashSet::new();
    // mailbox 去抖:某成员"忙"时被扇出跳过过(错过了那段群消息)→ 记在这。它一空下来,
    // 延迟 wake_debounce 再补扇一次,让它看忙时积压的全部新消息。
    let mut pending_wake: HashSet<i64> = HashSet::new();
    // 放养续聊:inflight 归零(没人接)= 暂时冷场。不立刻收口,重新点火一波;连续
    // revive_max_dry 波仍没人开口才判定真聊散了。有人开口即清零。
    let mut dry_waves: u32 = 0;

    // wave 1:全员对用户这句反应(steps 1..N 已 persist)。被 @ 点名的成员立即回(delay=0),
    // 其余变速 —— 用户 @ 谁,谁马上接,不用等几十秒。
    for (i, p) in participants.iter().enumerate() {
        let d = if forced.contains(&p.companion_id) {
            Duration::ZERO
        } else {
            delay_fn(p.companion_id, 0)
        };
        tokio::spawn(react_once(
            orch.clone(), collab_id, history.clone(), cancel.clone(), notify.clone(), tx.clone(),
            p.clone(), (i + 1) as StepId, d, user_message.clone(),
        ));
        inflight += 1;
        calls += 1;
        reacting.insert(p.companion_id);
    }

    let deadline = tokio::time::Instant::now() + wall;
    loop {
        if cancel.load(Ordering::Relaxed) {
            break; // 被新消息抢占 / 已取消
        }
        let evt = tokio::select! {
            e = rx.recv() => match e { Some(e) => e, None => break },
            _ = notify.notified() => break, // 抢占:外部 cancel + notify_waiters
            _ = tokio::time::sleep_until(deadline) => {
                cancel.store(true, Ordering::Relaxed);
                notify.notify_waiters();
                break;
            }
        };
        inflight -= 1;
        reacting.remove(&evt.author);
        // 它"忙"时是否被扇出跳过过(错过了那段积压)。无论这次说没说,先把标记取出来。
        let was_pending = pending_wake.remove(&evt.author);

        let trimmed = evt.text.trim();
        let said = !trimmed.is_empty() && trimmed != "<pass>";
        if said {
            dry_waves = 0; // 有人开口 = 没冷场,重置干涸计数
            history.lock().unwrap_or_else(|e| e.into_inner()).push((evt.name.clone(), evt.text.clone()));
            msg_count += 1;

            // 扇出下一波:没在反应、非作者的成员都接着接(放养:不再限单人次数,A↔B 乒乓
            // 正是"热闹";只受硬上限兜底)。
            if !at_hard_cap(calls, msg_count) {
                let salt = msg_count as u64;
                for p in &participants {
                    if calls >= max_calls {
                        break;
                    }
                    if p.companion_id == evt.author {
                        continue;
                    }
                    if reacting.contains(&p.companion_id) {
                        // 它正忙,这拍扇不动 → 记进 mailbox,等它空了再补看积压。
                        pending_wake.insert(p.companion_id);
                        continue;
                    }
                    next_id += 1;
                    let id = next_id;
                    // persist pending 行(input 占位;react 任务跑时用最新快照覆盖)。
                    let placeholder = loop_step(id, p.clone(), &serde_json::Value::Array(vec![]), &user_message);
                    if orch.add_pending_step(collab_id, &placeholder).is_err() {
                        continue;
                    }
                    tokio::spawn(react_once(
                        orch.clone(), collab_id, history.clone(), cancel.clone(), notify.clone(), tx.clone(),
                        p.clone(), id, delay_fn(p.companion_id, salt), user_message.clone(),
                    ));
                    inflight += 1;
                    calls += 1;
                    reacting.insert(p.companion_id);
                }
            }

            // 补扇出(mailbox 去抖):它刚说完话,且"忙"时错过了群里的新发言 → 延迟 wake_debounce
            // 再扇它一次,看忙时积压的全部消息(快照即合并)。只 said 才补。
            if was_pending && !at_hard_cap(calls, msg_count) && !cancel.load(Ordering::Relaxed) {
                if let Some(p) = participants.iter().find(|c| c.companion_id == evt.author).cloned() {
                    next_id += 1;
                    let id = next_id;
                    let placeholder = loop_step(id, p.clone(), &serde_json::Value::Array(vec![]), &user_message);
                    if orch.add_pending_step(collab_id, &placeholder).is_ok() {
                        tokio::spawn(react_once(
                            orch.clone(), collab_id, history.clone(), cancel.clone(), notify.clone(), tx.clone(),
                            p, id, wake_debounce, user_message.clone(),
                        ));
                        inflight += 1;
                        calls += 1;
                        reacting.insert(evt.author);
                    }
                }
            }
        }

        if inflight <= 0 {
            // 暂时冷场(没人在途)。放养模式:撞硬上限/被打断才收口;否则重新点火一波,
            // 连续 revive_max_dry 波仍没人开口才判定真聊散了。
            if cancel.load(Ordering::Relaxed) || at_hard_cap(calls, msg_count) {
                break;
            }
            dry_waves += 1;
            if dry_waves >= revive_max_dry {
                break; // 连着几波重新点火都没人接 = 真聊散了
            }
            // 重新点火:全员看最新历史再接一次(热闹 prompt 让他们找话续;真没话就 pass)。
            let salt = 1000 + dry_waves as u64;
            for p in &participants {
                if calls >= max_calls {
                    break;
                }
                next_id += 1;
                let id = next_id;
                let placeholder = loop_step(id, p.clone(), &serde_json::Value::Array(vec![]), &user_message);
                if orch.add_pending_step(collab_id, &placeholder).is_err() {
                    continue;
                }
                tokio::spawn(react_once(
                    orch.clone(), collab_id, history.clone(), cancel.clone(), notify.clone(), tx.clone(),
                    p.clone(), id, delay_fn(p.companion_id, salt), user_message.clone(),
                ));
                inflight += 1;
                calls += 1;
                reacting.insert(p.companion_id);
            }
            if inflight <= 0 {
                break; // 一个都没点着(全撞上限)→ 收口
            }
        }
    }

    // 自然冷场(inflight 归零)→ cancel 仍为 false;被抢占 / 墙钟超时 → 已为 true。
    let natural_quiesce = !cancel.load(Ordering::Relaxed);

    // 收口:取消任何残留在途任务。
    cancel.store(true, Ordering::Relaxed);
    notify.notify_waiters();

    // 自然冷场后的收口(抢占/超时都不收:新循环接管 / 已等够久):
    //  - 全程没人发言 → YiYi 兜底接一句;
    //  - 有人聊过 + 用户明确"要结论" → YiYi 给个结论(显式出口,平时不硬塞)。
    if natural_quiesce {
        let hist_json = turns_to_json(&history.lock().unwrap_or_else(|e| e.into_inner()));
        if msg_count == 0 {
            let fb = yiyi_fallback_step(next_id + 1, scope, &hist_json, &user_message);
            if orch.add_pending_step(collab_id, &fb).is_ok() {
                let _ = orch.run_round_step(collab_id, &fb, &[]).await;
            }
        } else if wants_conclusion(&user_message) {
            let sum = yiyi_summary_step(next_id + 1, scope, &hist_json, &user_message);
            if orch.add_pending_step(collab_id, &sum).is_ok() {
                let _ = orch.run_round_step(collab_id, &sum, &[]).await;
            }
        }
    }
    let _ = orch.finalize_conversation(collab_id, CollaborationStatus::Done);
    deregister_group_loop(session_id, &cancel);
}

#[cfg(all(test, feature = "test-support"))]
mod tests {
    use super::*;
    use crate::engine::collaboration::orchestrator::SqliteOrchestrator;
    use crate::engine::collaboration::{Executor, ExecutorHandle, StepOutput, TokenUsage};
    use crate::test_support::TempDb;
    use async_trait::async_trait;
    use serial_test::serial;
    use std::collections::HashMap as Map;

    /// 记录每个成员看到的历史 + 返回配置好的发言,验证事件循环行为(不碰 LLM)。
    struct MockExec {
        replies: Map<i64, String>,
        seen: StdMutex<Vec<(i64, String)>>,
    }
    #[async_trait]
    impl Executor for MockExec {
        async fn run_step(
            &self,
            _collab: i64,
            step: &Step,
            _upstream: &[(StepId, StepOutput)],
        ) -> Result<StepOutput, String> {
            let p = step.participants[0].clone();
            let hist = step.input.metadata.get("history").map(|v| v.to_string()).unwrap_or_default();
            self.seen.lock().unwrap().push((p.companion_id, hist));
            let reply = self.replies.get(&p.companion_id).cloned().unwrap_or_else(|| "<pass>".into());
            let full = if reply == "<pass>" { reply.clone() } else { format!("【{}】{}", p.name, reply) };
            Ok(StepOutput {
                summary: reply,
                full_output: full,
                tokens_used: TokenUsage { input: 1, output: 1 },
                duration_ms: 1,
            })
        }
    }

    fn parts() -> Vec<Participant> {
        vec![
            Participant { companion_id: 1, name: "阿狸".into(), avatar_emoji: "🦊".into(), color_hex: "#f00".into(), memory_scope: MemoryScope::Group(1) },
            Participant { companion_id: 2, name: "小二".into(), avatar_emoji: "🐨".into(), color_hex: "#0f0".into(), memory_scope: MemoryScope::Group(1) },
        ]
    }

    /// 测试护栏:小上限,paused-clock 下快速验证"撞顶会停 / 冷场会散",不真跑 200 条。
    fn test_limits() -> GroupLimits {
        GroupLimits {
            max_messages: 8,
            max_calls: 50,
            wall: Duration::from_secs(30),
            revive_max_dry: 2,
            wake_debounce: Duration::from_millis(5000),
        }
    }

    /// 阿狸(id 1)秒回、小二(id 2)慢半拍 —— 验证"慢者看到更全上下文"。
    fn delay_fast_slow(cid: i64, _salt: u64) -> Duration {
        if cid == 1 { Duration::from_millis(0) } else { Duration::from_millis(50) }
    }

    #[tokio::test(start_paused = true)]
    #[serial]
    async fn group_loop_terminates_and_slow_member_sees_earlier_reply() {
        let tmp = TempDb::new();
        let db = tmp.db();
        db.ensure_session("sess-test", "群测试", "chat", None).unwrap(); // collaborations FK → sessions
        let participants = parts();
        let mut replies = Map::new();
        replies.insert(1, "我先说".to_string());
        replies.insert(2, "我接一句".to_string());
        let mock = Arc::new(MockExec { replies, seen: StdMutex::new(Vec::new()) });
        let executor: ExecutorHandle = mock.clone();
        let orch = SqliteOrchestrator::new(db.clone(), executor);

        // wave-1 plan(steps 1..N pending),与 dispatch_group_loop 一致。
        let hist0 = turns_to_json(&[]);
        let wave1: Vec<Step> = participants
            .iter()
            .enumerate()
            .map(|(i, p)| loop_step((i + 1) as StepId, p.clone(), &hist0, "你们好"))
            .collect();
        let plan = CollaborationPlan { steps: wave1 };
        let collab_id = orch
            .create_conversation("sess-test", "你们好", &plan, &CollaborationMode::Dispatched(0), None)
            .unwrap();

        let cancel = Arc::new(AtomicBool::new(false));
        let notify = Arc::new(Notify::new());
        // 直接 await:若循环不终止(活锁/死锁)→ 测试超时失败。这是活性断言。
        drive_group_loop(
            orch, collab_id, "sess-test", participants, MemoryScope::Group(1),
            vec![], "你们好".into(), cancel, notify, delay_fast_slow,
            test_limits(),
            vec![],
        )
        .await;

        let seen = mock.seen.lock().unwrap();
        assert!(seen.iter().any(|(c, _)| *c == 1), "阿狸应被调用");
        assert!(seen.iter().any(|(c, _)| *c == 2), "小二应被调用");
        // 慢半拍的小二,某次反应的历史里应含阿狸先说的『我先说』。
        let slow_saw_fast = seen.iter().any(|(c, h)| *c == 2 && h.contains("我先说"));
        assert!(slow_saw_fast, "慢者小二应看到阿狸先说的话;seen={:?}", *seen);
    }

    fn delay_zero(_cid: i64, _salt: u64) -> Duration {
        Duration::from_millis(0)
    }

    /// 防活锁/护栏:两个"永远想接话"的成员也会被 单人配额 + 发言上限 + 成本闸 刹住,
    /// 不会无限互捧(否则就是用户原始抱怨的放大版)。
    #[tokio::test(start_paused = true)]
    #[serial]
    async fn group_loop_caps_runaway_chatter() {
        let tmp = TempDb::new();
        let db = tmp.db();
        db.ensure_session("sess-cap", "群测试", "chat", None).unwrap();
        let participants = parts();
        let mut replies = Map::new();
        // 两人都永远有话说(若无护栏会无限循环)。
        replies.insert(1, "我还有话".to_string());
        replies.insert(2, "我也接".to_string());
        let mock = Arc::new(MockExec { replies, seen: StdMutex::new(Vec::new()) });
        let executor: ExecutorHandle = mock.clone();
        let orch = SqliteOrchestrator::new(db.clone(), executor);

        let hist0 = turns_to_json(&[]);
        let wave1: Vec<Step> = participants
            .iter()
            .enumerate()
            .map(|(i, p)| loop_step((i + 1) as StepId, p.clone(), &hist0, "聊聊"))
            .collect();
        let plan = CollaborationPlan { steps: wave1 };
        let collab_id = orch
            .create_conversation("sess-cap", "聊聊", &plan, &CollaborationMode::Dispatched(0), None)
            .unwrap();

        let cancel = Arc::new(AtomicBool::new(false));
        let notify = Arc::new(Notify::new());
        // 会终止(不挂)= 护栏生效。
        drive_group_loop(
            orch, collab_id, "sess-cap", participants, MemoryScope::Group(1),
            vec![], "聊聊".into(), cancel, notify, delay_zero,
            test_limits(),
            vec![],
        )
        .await;

        let seen = mock.seen.lock().unwrap();
        // 放养模式去掉了单人配额(A↔B 乒乓正是要的);靠硬上限兜底不失控:总调用 ≤ max_calls。
        assert!(
            seen.len() <= test_limits().max_calls as usize,
            "总 LLM 调用 {} 不应超硬上限 {}",
            seen.len(),
            test_limits().max_calls
        );
        // 没说"要结论" → 不应有 YiYi(companion 0)收口。
        assert!(!seen.iter().any(|(c, _)| *c == 0), "未要结论时不该硬塞 YiYi 总结");
    }

    /// 用户明确"要个结论" → 群聊冷场后 YiYi(companion 0)收口给结论。
    #[tokio::test(start_paused = true)]
    #[serial]
    async fn group_loop_summarizes_when_conclusion_requested() {
        let tmp = TempDb::new();
        let db = tmp.db();
        db.ensure_session("sess-sum", "群测试", "chat", None).unwrap();
        let participants = parts();
        let mut replies = Map::new();
        // 阿狸说一句、小二 pass → msg_count==1(有人聊过),走"要结论"收口而非全冷场兜底。
        replies.insert(1, "我觉得 A 方案".to_string());
        replies.insert(2, "<pass>".to_string());
        let mock = Arc::new(MockExec { replies, seen: StdMutex::new(Vec::new()) });
        let executor: ExecutorHandle = mock.clone();
        let orch = SqliteOrchestrator::new(db.clone(), executor);

        let hist0 = turns_to_json(&[]);
        let wave1: Vec<Step> = participants
            .iter()
            .enumerate()
            .map(|(i, p)| loop_step((i + 1) as StepId, p.clone(), &hist0, "你们讨论下给个结论"))
            .collect();
        let plan = CollaborationPlan { steps: wave1 };
        let collab_id = orch
            .create_conversation("sess-sum", "你们讨论下给个结论", &plan, &CollaborationMode::Dispatched(0), None)
            .unwrap();

        let cancel = Arc::new(AtomicBool::new(false));
        let notify = Arc::new(Notify::new());
        drive_group_loop(
            orch, collab_id, "sess-sum", participants, MemoryScope::Group(1),
            vec![], "你们讨论下给个结论".into(), cancel, notify, delay_zero,
            test_limits(),
            vec![],
        )
        .await;

        let seen = mock.seen.lock().unwrap();
        assert!(seen.iter().any(|(c, _)| *c == 0), "要结论时应由 YiYi(0)收口;seen={:?}", *seen);
    }

    /// 小二第一波慢 20ms:阿狸先说话时它还在"忙",这条被它错过(扇出跳过、记 pending_wake)。
    /// 验证 mailbox 去抖补扇出:小二回完后,经 wake_debounce 去抖被补扇一次看积压
    /// —— 补上"忙时被跳过的唤醒"这个 gap(对话的持续性)。
    fn delay_b_busy_on_wave1(cid: i64, salt: u64) -> Duration {
        if cid == 2 && salt == 0 {
            Duration::from_millis(20) // 确保阿狸先说、小二仍在忙
        } else {
            Duration::from_millis(0) // 其余即时,使唯一的虚拟耗时来自 5s 去抖
        }
    }

    #[tokio::test(start_paused = true)]
    #[serial]
    async fn group_loop_busy_member_revisits_backlog_after_debounce() {
        let tmp = TempDb::new();
        let db = tmp.db();
        db.ensure_session("sess-wake", "群测试", "chat", None).unwrap();
        let participants = parts();
        let mut replies = Map::new();
        replies.insert(1, "阿狸说一句".to_string());
        replies.insert(2, "小二接一句".to_string());
        let mock = Arc::new(MockExec { replies, seen: StdMutex::new(Vec::new()) });
        let executor: ExecutorHandle = mock.clone();
        let orch = SqliteOrchestrator::new(db.clone(), executor);

        let hist0 = turns_to_json(&[]);
        let wave1: Vec<Step> = participants
            .iter()
            .enumerate()
            .map(|(i, p)| loop_step((i + 1) as StepId, p.clone(), &hist0, "你们聊"))
            .collect();
        let plan = CollaborationPlan { steps: wave1 };
        let collab_id = orch
            .create_conversation("sess-wake", "你们聊", &plan, &CollaborationMode::Dispatched(0), None)
            .unwrap();

        let cancel = Arc::new(AtomicBool::new(false));
        let notify = Arc::new(Notify::new());
        let t0 = tokio::time::Instant::now();
        drive_group_loop(
            orch, collab_id, "sess-wake", participants, MemoryScope::Group(1),
            vec![], "你们聊".into(), cancel, notify, delay_b_busy_on_wave1,
            test_limits(),
            vec![],
        )
        .await;
        let elapsed = t0.elapsed();

        // 去抖确实被执行:正常 react 延迟都是 0,唯一能产生 ≥5s 虚拟耗时的就是补扇出的去抖窗口。
        assert!(
            elapsed >= test_limits().wake_debounce,
            "补扇出的去抖({:?})应被执行;实际虚拟耗时 {:?}",
            test_limits().wake_debounce,
            elapsed
        );
        let seen = mock.seen.lock().unwrap();
        let b_hists: Vec<&String> = seen.iter().filter(|(c, _)| *c == 2).map(|(_, h)| h).collect();
        // 小二被唤醒 ≥2 次:wave-1 回一次 + 忙时积压补看一次。
        assert!(b_hists.len() >= 2, "小二应在回复后被补扇至少一次;seen={:?}", *seen);
        // 补看那次的历史快照比首次更长 —— 看到了它忙时(及之后)积压的新发言。
        assert!(
            b_hists.last().unwrap().len() > b_hists.first().unwrap().len(),
            "小二补看时应看到更全的积压历史;b_hists={:?}",
            b_hists
        );
    }
}
