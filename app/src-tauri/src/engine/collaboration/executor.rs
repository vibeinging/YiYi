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
        // 群事件循环(v2,放养模式):像在群里熬夜热聊一样自然接茬,基调偏"积极往下聊",
        // 但仍允许真没料时 pass(防尬聊/复读)。
        Some("group_loop") => format!(
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
        Some("yiyi_fallback") => format!(
            "你是群管家 {}。群里这条消息暂时没有成员接话,由你接住它:简短自然地回答用户;\
             若确实不是你擅长的领域,就坦诚点一句并把方向轻轻递出去,别生硬推托。",
            p.name
        ),
        // 要结论出口:群聊完一轮,用户明确要个结论 → YiYi 收口。
        Some("yiyi_summary") => format!(
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
        Some("group_round") | Some("yiyi_fallback") | Some("group_loop") | Some("yiyi_summary")
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
    let secs = if step_mode(step) == Some("group_loop") {
        GROUP_LOOP_TIMEOUT_SECS
    } else {
        PARTICIPANT_TIMEOUT_SECS
    };
    match tokio::time::timeout(
        std::time::Duration::from_secs(secs),
        run_one(config, step, participant_idx, upstream, collab_id, usage_source),
    )
    .await
    {
        Ok(r) => r,
        Err(_) => Err(format!("{name} 响应超时({secs}s)")),
    }
}

/// UTF-8 安全的预览截断:按 char 计数,超过 `n` 个 char 截断并补 `…`。
fn truncate_preview(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        return s.to_string();
    }
    let mut out: String = s.chars().take(n).collect();
    out.push('…');
    out
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

/// 伙伴(companion_id != 0)的执行器:带工具的 ReAct 循环。和主精灵 YiYi 共用
/// `run_react_with_options_stream`(tools_override = None → 全套工具),区别只在
/// 拼进 system prompt 的 persona 前缀和"动手能力"提示。流事件转成
/// `CollaborationEvent::Token` 喂前端;工具的开始/结束摘要注入思考块(reasoning=true)。
async fn run_one_react(
    config: &LLMConfig,
    step: &Step,
    participant_idx: usize,
    upstream: &[(StepId, StepOutput)],
    collab_id: CollaborationId,
) -> Result<StepOutput, String> {
    let p = &step.participants[participant_idx];

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

    let started = Instant::now();

    // 累加 token 用量(Usage 事件多次到达,跨工具迭代累计)。
    let in_tokens = Arc::new(AtomicU32::new(0));
    let out_tokens = Arc::new(AtomicU32::new(0));

    let collab_id_c = collab_id;
    let step_id_c = step.id;
    let companion_id_c = p.companion_id;
    let in_c = Arc::clone(&in_tokens);
    let out_c = Arc::clone(&out_tokens);
    let on_event = move |evt: crate::engine::react_agent::AgentStreamEvent| {
        use crate::engine::react_agent::AgentStreamEvent as E;
        let (delta, reasoning) = match evt {
            E::Token(d) => (d, false),
            E::Thinking(d) => (d, true),
            // 工具的开始/结束摘要注入思考块,让用户看见伙伴"动手"的踪迹
            // (与正文同流,靠 reasoning 标志渲染成思考气泡)。
            E::ToolStart { name, args_preview } => (
                format!("\n🔧 {name} {}\n", truncate_preview(&args_preview, 60)),
                true,
            ),
            E::ToolEnd { name: _, result_preview } => {
                (format!("↳ {}\n", truncate_preview(&result_preview, 80)), true)
            }
            E::Usage { input_tokens, output_tokens, .. } => {
                in_c.fetch_add(input_tokens, Ordering::Relaxed);
                out_c.fetch_add(output_tokens, Ordering::Relaxed);
                return;
            }
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
    };

    let working_dir = crate::engine::tools::WORKING_DIR.get().map(|p| p.as_path());
    let reply = crate::engine::react_agent::run_react_with_options_stream(
        config,
        &system_prompt,
        &user_message,
        &[],
        Some(6),
        working_dir,
        on_event,
        None,
        None,
        None,
    )
    .await?;

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
