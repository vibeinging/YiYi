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

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use futures_util::future::join_all;

use super::{
    collab_semaphore, events, resolve_memme_user_id, CollaborationEvent, CollaborationId,
    CompanionId, Executor, Step, StepId, StepKind, StepOutput, TokenUsage,
};
use crate::engine::agents::persona_loader;
use crate::engine::react_agent::ToolFilter;
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

/// step 的语义模式(**纯 chat**)。metadata["mode"] 字符串在此**翻译一次**,
/// 调用点用穷尽 match / enum 比较,编译器兜底——取代散落各处的 `== Some("...")` 魔法字符串。
/// work 模式(intake/project_task)不在此:run_one_guarded 入口已按
/// `work::worker::WorkStepKind::from_step` 早路由出去,chat 路径永远见不到 work 步。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StepMode {
    /// 放养群聊:点名转让一轮,全员 reply-or-pass(chat)
    GroupRound,
    /// 放养群聊:自由热聊事件循环(chat)
    GroupLoop,
    /// 群聊全冷场,YiYi 兜底位接住(chat)
    YiyiFallback,
    /// 群聊显式要结论,YiYi 收口(chat)
    YiyiSummary,
    /// 无 mode / 未知:普通单/多 agent step
    Plain,
}

/// 读 step 的语义模式(Driver 写进 metadata["mode"])。
fn step_mode(step: &Step) -> StepMode {
    match step.input.metadata.get("mode").and_then(|v| v.as_str()) {
        Some("group_round") => StepMode::GroupRound,
        Some("group_loop") => StepMode::GroupLoop,
        Some("yiyi_fallback") => StepMode::YiyiFallback,
        Some("yiyi_summary") => StepMode::YiyiSummary,
        _ => StepMode::Plain,
    }
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
        StepMode::GroupRound => format!(
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
        // 群事件循环(v2,放养模式):像在群里熬夜热聊一样自然接茬,基调偏"积极往下聊",
        // 但仍允许真没料时 pass(防尬聊/复读)。
        StepMode::GroupLoop => format!(
            "你是 {} {}。这是用户的群聊,你能看到群里刚刚的对话。大家在热聊,你也在群里。\n\n\
             【接话规则】\n\
             - 默认积极接话:顺着刚才的话往下聊——追问、补个新角度/例子、调侃一句、@ 谁请教,\
             像真人熬夜在群里唠嗑。一次只说一两句,口语、短。\n\
             - 但**别为接而接**:只能复读 / 干附和 / 把用户最初的问题整段重答 → 只输出 \
             `{PASS_SENTINEL}`,把话头让出去。\n\
             - 直接说内容,**不要用「你的名字:」或「【名字】」开头**自报家门——群里都知道你是谁。\n\
             - 想让话题继续,就抛个具体的小问题 / 新例子给某个人,别用空泛的「你觉得呢」收尾。",
            p.avatar_emoji, p.name
        ),
        // 全让兜底位:群里没人接,YiYi 群管家接住。
        StepMode::YiyiFallback => format!(
            "你是群管家 {}。群里这条消息暂时没有成员接话,由你接住它:简短自然地回答用户;\
             若确实不是你擅长的领域,就坦诚点一句并把方向轻轻递出去,别生硬推托。",
            p.name
        ),
        // 要结论出口:群聊完一轮,用户明确要个结论 → YiYi 收口。
        StepMode::YiyiSummary => format!(
            "你是群管家 {}。群里刚聊完一轮,用户想要一个结论。看完上面的对话,直接给出:\
             先一句话核心结论,再简述大家的共识 / 分歧(如有),最后一条可落地建议。\
             别复述每个人说了啥、别开新话题。",
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
    if matches!(
        step_mode(step),
        StepMode::GroupRound | StepMode::YiyiFallback | StepMode::GroupLoop | StepMode::YiyiSummary
    ) {
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
/// 群事件循环里,一句闲聊不需要 150s 长推理;砍到 30s,既兜住挂起流,又把"被抢占后
/// 仍在跑的那条"的成本/占槽时长压到 ≤ 群墙钟量级(中途取消的实用兜底)。
const GROUP_LOOP_TIMEOUT_SECS: u64 = 30;

/// run_one 的超时包装 —— 见 PARTICIPANT_TIMEOUT_SECS。
/// **chat×work 路由点(R2/S8)**:work 步(intake/project_task)在此早路由到
/// `work::worker::run_work_step_guarded`(work prompt + work 超时策略都在 work 表面);
/// 本函数往下只剩纯 chat —— 群聊 30s / 普通 150s 总超时。
async fn run_one_guarded(
    config: &LLMConfig,
    step: &Step,
    participant_idx: usize,
    upstream: &[(StepId, StepOutput)],
    collab_id: CollaborationId,
    usage_source: UsageSource,
) -> Result<StepOutput, String> {
    if crate::engine::work::worker::WorkStepKind::from_step(step).is_some() {
        return crate::engine::work::worker::run_work_step_guarded(
            config, step, participant_idx, upstream, collab_id,
        )
        .await;
    }
    let name = step
        .participants
        .get(participant_idx)
        .map(|p| p.name.clone())
        .unwrap_or_default();
    let run = run_one(config, step, participant_idx, upstream, collab_id, usage_source);

    let secs = match step_mode(step) {
        StepMode::GroupLoop => GROUP_LOOP_TIMEOUT_SECS,
        _ => PARTICIPANT_TIMEOUT_SECS,
    };
    match tokio::time::timeout(std::time::Duration::from_secs(secs), run).await {
        Ok(r) => r,
        Err(_) => Err(format!("{name} 响应超时({secs}s)")),
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

    // 两路分流:
    //   - 伙伴(companion_id != 0) → 带工具的 ReAct(全套 60+ 工具),能读写文件、
    //     执行命令、查资料等;只在人格/角色上区别于主精灵 YiYi。
    //   - YiYi 收口 / 主持位(companion_id == 0) → 纯对话(无工具),保持原路径。
    if p.companion_id != 0 {
        return run_one_react(config, step, participant_idx, upstream, collab_id).await;
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
            crate::engine::agent_runner::mark_idle_activity(); // 流活动上报(idle 看门狗场景的通用埋点)
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

/// 伙伴默认 ReAct 步数上限——角色定义没指定 `max_iterations` 时用它(也是群聊
/// 闲聊的合理上限)。有角色定义则用角色自己的(如 code_reviewer=12),让能干活的
/// 角色跑更多步、做更长的任务。这是 F2"分身能长程干活"的核心杠杆之一。
const COMPANION_DEFAULT_MAX_ITER: usize = 6;

/// 从角色定义算出这次伙伴 run 的(工具过滤器, ReAct 步数上限)。
/// 无角色定义(blank companion / registry 未找到)→ 全套工具 + 默认 6 步(保持现状)。
/// 纯函数,便于测试:角色权限"真生效"的决策逻辑全在这里。
fn role_run_params(def: Option<&crate::engine::agents::AgentDefinition>) -> (ToolFilter, usize) {
    match def {
        Some(d) => (
            d.tool_filter(),
            d.max_iterations.unwrap_or(COMPANION_DEFAULT_MAX_ITER),
        ),
        None => (ToolFilter::All, COMPANION_DEFAULT_MAX_ITER),
    }
}

/// 解析伙伴的角色定义 → (工具过滤器, max_iter)。沿用 `spawn_tools` 的范式:
/// companion → `agent_definition_name` slug → `AppState.agent_registry`。
/// registry / DB 不可达(headless 测试 / 未初始化)→ 回落全套工具 + 6 步——
/// 因此本函数在测试里安全降级,不破坏现有行为。
pub(crate) async fn resolve_companion_role(companion_id: CompanionId) -> (ToolFilter, usize) {
    let slug = match crate::engine::tools::get_database()
        .and_then(|db| db.get_companion(companion_id))
    {
        Some(c) => c.agent_definition_name,
        None => return role_run_params(None),
    };
    let handle = match crate::engine::tools::get_app_handle() {
        Some(h) => h,
        None => return role_run_params(None),
    };
    use tauri::Manager;
    let state = handle.state::<crate::state::AppState>();
    let registry = state.agent_registry.read().await;
    role_run_params(registry.get(&slug))
}

/// 伙伴(companion_id != 0)的执行器:带工具的 ReAct 循环。和主精灵 YiYi 共用
/// `run_react_with_options_stream`,但 F2 起**按角色注入工具过滤器 + 步数上限**
/// (`resolve_companion_role`):读写/执行类工具只给角色允许的,步数上限随角色,
/// 让"分工"真生效、能干活的角色跑更长。区别仍在 system prompt 的 persona 前缀。
/// 流事件转成 `CollaborationEvent::Token` 喂前端;工具开始/结束注入思考块。
/// 纯 ReAct 执行内核(chat×work 共享):给定**已构造好的** system/user prompt + 角色权限
/// 过滤 + 步数上限,跑统一 run_agent,收尾把本步内 ask_user 的问答内联进该成员气泡。
/// **不含任何 mode 判断**——调用方(chat 的 run_one_react / 未来 work 的 worker)各自按
/// 象限构造 prompt 后复用本内核。S3:从 run_one_react 抽出,ask_user 内联整条进内核。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_react_inner(
    config: &LLMConfig,
    collab_id: CollaborationId,
    step_id: StepId,
    companion_id: CompanionId,
    companion_name: &str,
    system_prompt: String,
    user_message: String,
    role_filter: ToolFilter,
    role_max_iter: usize,
) -> Result<StepOutput, String> {
    let started = Instant::now();

    // token 用量累加交给 CollabEventSink 的 on_usage;收尾时读回。
    let in_tokens = Arc::new(AtomicU32::new(0));
    let out_tokens = Arc::new(AtomicU32::new(0));

    // 伙伴的流事件统一经 AgentEventSink 翻译:正文 / 思考 → Token{reasoning},
    // 工具开始 / 结束 → 结构化 ToolStart / ToolEnd。
    let sink: Arc<dyn crate::engine::agent_runner::AgentEventSink> =
        Arc::new(crate::engine::agent_runner::collab_sink::CollabEventSink::new(
            collab_id,
            step_id,
            companion_id,
            Arc::clone(&in_tokens),
            Arc::clone(&out_tokens),
        ));
    // 收尾追加 Q&A 块要复用同一条成员流(同 collab/step/companion key)→ 先留个克隆,
    // 因为 sink 本体随后会被 move 进 run_agent。
    let sink_for_qa = Arc::clone(&sink);

    // R5(根修):协作所属会话直接写进 cfg.session_id —— run_agent 内部用它包
    // with_session_id(run.rs),ask_user 等会话感知工具的落库/事件载荷才带得上真实
    // session_id(pending_questions 按会话恢复、提问卡按会话路由都靠它)。
    // **不能**在 run_agent 外面再包一层 with_session_id:run_agent 内层 scope 用
    // cfg.session_id 覆盖外层 —— cfg 留空串等于把外层绑定抹掉(最初就栽在这里:
    // 外包的一层从未生效,pending_questions 全落空 session_id)。
    let collab_session = crate::engine::tools::get_database()
        .and_then(|db| db.collaboration_session_id(collab_id))
        .unwrap_or_default();

    // 走统一 run_agent:shell 全关 + working_dir=None(伙伴人设已在 system_prompt)+ persist=None
    // (产出是协作 step output,由本函数收成 StepOutput,不入 chat 会话)。
    let cfg = crate::engine::agent_runner::config::AgentRunConfig {
        llm: config.clone(),
        system_prompt,
        agent_message: user_message.clone(),
        augmented_message: user_message,
        llm_history: vec![],
        max_iter: Some(role_max_iter),
        is_first_message: false,
        session_id: collab_session,
        working_dir: None,
        shell: crate::engine::agent_runner::config::ShellOptions::default(),
    };
    let dummy_cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));

    // 若这次协作属于有隔离项目工作区的群(软件公司团队),把成员的文件 / shell 工具 scope
    // 到该工作区;普通群 / 单聊 / headless → None,不 scope。
    let group_workspace = crate::engine::tools::get_database()
        .and_then(|db| db.group_workspace_for_collaboration(collab_id))
        .map(std::path::PathBuf::from);

    // 三层 task-local 包裹:① with_tool_filter 角色权限真生效(F2);② with_ask_asker
    // 提问气泡显示分身自己的角色名/头像(F1);③ with_collab_qa 收集本步 ask_user 问答。
    // run_agent 的 future 很大(整个 ReAct 循环 + 流式 + 工具分发),Box::pin 移到堆上,
    // 避免叠加三层 task-local scope 后在 debug 的 tokio worker 栈上把帧撑爆(stack overflow)。
    let agent_fut = Box::pin(crate::engine::agent_runner::run::run_agent(
        cfg,
        None,
        sink,
        dummy_cancel,
    ));
    let qa_acc = Arc::new(std::sync::Mutex::new(Vec::<(String, String)>::new()));
    let run = crate::engine::tools::with_tool_filter(
        role_filter,
        crate::engine::tools::ask_user::with_ask_asker(
            companion_id,
            companion_name.to_string(),
            crate::engine::tools::ask_user::with_collab_qa(Arc::clone(&qa_acc), agent_fut),
        ),
    );
    let mut reply = match group_workspace {
        Some(ws) => crate::engine::tools::with_task_working_dir(ws, run).await?,
        None => run.await?,
    };

    // 本步内向用户确认过的问答 → 拼成块,既推进实时气泡流(用户立刻看到问答内联在该成员
    // 气泡末尾,不再单开一条 YiYi 消息),又追进 full_output(重开 hydrate 从持久化产出还原)。
    // 两条路同源,内容一致、不双渲染。
    let qa = qa_acc.lock().map(|v| v.clone()).unwrap_or_default();
    if !qa.is_empty() {
        let mut block = String::new();
        for (q, a) in &qa {
            block.push_str(&format!("\n\n> **❓ {}**\n>\n> {}", q.trim(), a.trim()));
        }
        sink_for_qa.on_token(&block);
        reply.push_str(&block);
    }

    let duration_ms = started.elapsed().as_millis() as u64;
    let tokens_used = TokenUsage {
        input: in_tokens.load(Ordering::Relaxed),
        output: out_tokens.load(Ordering::Relaxed),
    };

    Ok(StepOutput {
        summary: summarize(&reply),
        full_output: reply,
        tokens_used,
        duration_ms,
    })
}

async fn run_one_react(
    config: &LLMConfig,
    step: &Step,
    participant_idx: usize,
    upstream: &[(StepId, StepOutput)],
    collab_id: CollaborationId,
) -> Result<StepOutput, String> {
    let p = &step.participants[participant_idx];

    // F2:按角色注入工具过滤器 + ReAct 步数上限。无角色定义 → 全套工具 + 6 步(保持
    // 现状);有角色 → 只给角色允许的工具、用角色自己的步数上限,让"分工"真生效、
    // 能干活的角色跑更长的任务。headless 测试里 registry 不可达,安全回落。
    let (role_filter, role_max_iter) = resolve_companion_role(p.companion_id).await;

    // system prompt = persona 前缀 + 群聊规则 + 动手能力说明(三段拼接)。
    // persona 前缀:载 companions/<id>/persona.md;文件不存在 → 空串。
    let persona_prefix = crate::engine::tools::WORKING_DIR
        .get()
        .map(|wd| {
            wd.join("companions")
                .join(p.companion_id.to_string())
                .join("persona.md")
        })
        .and_then(|path| persona_loader::load_companion_persona(&path))
        .map(|persona| persona.render_prefix())
        .unwrap_or_default();

    let group_rules = render_system_prompt(step, participant_idx);
    let tools_note = "\n\n【动手能力】你能用工具(读写文件、执行命令、查资料、开浏览器等)。\
         但这是群聊,以对话为主——只在用户的需求确实需要你动手查/做时才调工具;\
         平时顺着聊就行,别为用而用。用完工具,用你自己的口吻把结果说出来,别贴原始输出。";
    let system_prompt = format!("{persona_prefix}{group_rules}{tools_note}");
    let user_message = render_user_prompt(step, upstream);

    // 构造完(mode-aware:prompt / 权限 / 步数)→ 交给共享 ReAct 内核执行(S3 抽出)。
    // 内核不含 mode 判断;ask_user 内联收尾在内核里,chat/work 复用同一条。
    //
    // 类型擦除成 boxed trait object:抽出内核后 async fn 链多一层,`run_step` 的 Send
    // 自动 trait 求值沿链深递归会撞 E0275(overflow evaluating ... : Send)。在内核边界
    // 装成 `dyn Future + Send` 截断这条递归(内核本就是 Send,只是不让编译器递归展开它)。
    let fut: std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<StepOutput, String>> + Send>,
    > = Box::pin(run_react_inner(
        config,
        collab_id,
        step.id,
        p.companion_id,
        &p.name,
        system_prompt,
        user_message,
        role_filter,
        role_max_iter,
    ));
    fut.await
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
                            // 成员输出偶尔自带「【名字】」/「名字:」/「名字:」自报家门前缀(模型模仿
                            // 群历史格式)。反复剥干净,否则:① 双标记「【名字】【名字】」② 重开 hydrate
                            // 时前端按「【名字】」切段切出空串 → 只剩头像的空气泡(实测 bug)。
                            let self_marker = format!("【{}】", name);
                            let colon_en = format!("{}:", name);
                            let colon_cn = format!("{}：", name);
                            let strip = |s: &str| -> String {
                                let mut t = s.trim_start();
                                loop {
                                    let before = t;
                                    t = t.strip_prefix(&self_marker).unwrap_or(t).trim_start();
                                    t = t.strip_prefix(&colon_en).unwrap_or(t).trim_start();
                                    t = t.strip_prefix(&colon_cn).unwrap_or(t).trim_start();
                                    if t.len() == before.len() {
                                        break;
                                    }
                                }
                                t.to_string()
                            };
                            let s_full = strip(&out.full_output);
                            // 剥完只剩空 = 这条只有自报家门没实质内容 → 当 pass,不冒空气泡。
                            if s_full.is_empty() {
                                continue;
                            }
                            let s_sum = strip(&out.summary);
                            if !combined_full.is_empty() {
                                combined_summary.push_str("\n\n");
                                combined_full.push_str("\n\n");
                            }
                            combined_summary.push_str(&format!("【{}】{}", name, s_sum));
                            combined_full.push_str(&format!("【{}】{}", name, s_full));
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

#[cfg(test)]
mod role_tests {
    //! F2:验证"角色权限真生效"的决策逻辑(`role_run_params`)与工具裁剪原语
    //! (`ToolFilter::apply`/`is_allowed`)。用真实内置角色定义(code_reviewer)驱动,
    //! 不依赖 LLM / APP_HANDLE —— 后者(companion→registry 的运行时解析)是与 F1 emit
    //! 同源的 headless 墙,沿用 spawn_tools 已验证的范式。
    use super::*;
    use crate::engine::agents::AgentRegistry;
    use crate::engine::tools::{FunctionDef, ToolDefinition};
    use tempfile::TempDir;

    fn td(name: &str) -> ToolDefinition {
        ToolDefinition {
            r#type: "function".into(),
            function: FunctionDef {
                name: name.into(),
                description: String::new(),
                parameters: serde_json::json!({}),
            },
        }
    }

    #[test]
    fn role_run_params_no_def_falls_back_to_all_and_default_iter() {
        let (filter, max_iter) = role_run_params(None);
        assert!(matches!(filter, ToolFilter::All));
        assert_eq!(max_iter, COMPANION_DEFAULT_MAX_ITER);
        // 无角色 → 仍是全套工具(保持现状,不破坏 blank companion)。
        assert!(filter.is_allowed("write_file"));
    }

    #[test]
    fn role_run_params_applies_role_whitelist_and_iter() {
        // code_reviewer 是只读评审员:白名单不含写/执行工具,步数上限随角色。
        let tmp = TempDir::new().unwrap();
        let registry = AgentRegistry::load(tmp.path(), None);
        let def = registry.get("code_reviewer").expect("内置 code_reviewer 应在 registry");

        let (filter, max_iter) = role_run_params(Some(def));

        // 角色权限真生效:白名单(Allow),能读不能写。
        assert!(matches!(filter, ToolFilter::Allow(_)));
        assert!(filter.is_allowed("read_file"), "评审员应能读文件");
        assert!(!filter.is_allowed("write_file"), "评审员不该能写文件");
        assert!(!filter.is_allowed("execute_shell"), "评审员不该能跑命令");
        // 步数上限取角色自己的(code_reviewer 比默认 6 高),让它能多看几轮。
        assert_eq!(max_iter, def.max_iterations.unwrap_or(COMPANION_DEFAULT_MAX_ITER));
    }

    #[test]
    fn tool_filter_actually_trims_the_offered_tool_set() {
        // 这正是 ReAct core(core.rs:235)对给 LLM 的工具集做的裁剪。
        let all = vec![
            td("read_file"),
            td("write_file"),
            td("execute_shell"),
            td("grep_search"),
        ];

        // 白名单:只留 read_file / grep_search。
        let allow = ToolFilter::Allow(vec!["read_file".into(), "grep_search".into()]);
        let kept: Vec<String> = allow.apply(&all).into_iter().map(|t| t.function.name).collect();
        assert_eq!(kept, vec!["read_file".to_string(), "grep_search".to_string()]);

        // 只读预设:写/执行被删,读保留。
        let names_after_readonly: Vec<String> = ToolFilter::read_only()
            .apply(&all)
            .into_iter()
            .map(|t| t.function.name)
            .collect();
        assert!(names_after_readonly.contains(&"read_file".to_string()));
        assert!(names_after_readonly.contains(&"grep_search".to_string()));
        assert!(!names_after_readonly.contains(&"write_file".to_string()));
        assert!(!names_after_readonly.contains(&"execute_shell".to_string()));
    }

}
