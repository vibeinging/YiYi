//! work/worker(缝 1 + 缝 2 归位):work 步执行 —— prompt 构造 + work 超时策略。
//!
//! 从 `engine/collaboration/executor.rs` **复制**(S4:复制不删,原件 work 部分 S8 删)的
//! work 专属逻辑:
//!   - intake 步的 system prompt(牵头者主导推进指令 + roster + persona 拼接思路);
//!   - project_task 步的 user prompt(上游交付"交接"块);
//!   - work 超时策略(`work_timeout_policy`:intake / project_task 均为 300s idle 看门狗)。
//!
//! 核心 `run_work_step` 构造 work prompt → 用 `executor::resolve_companion_role` 取角色权限
//! → 调 `executor::run_react_inner` 复用 ReAct 共享内核(ask_user 内联整条在内核里,
//! work intake 复用同一管道)。**不含 chat 的 group_round/group_loop/yiyi_* 任何臂**——
//! 那些归 chat。
//!
//! **缝 8 / §7-排序**:`compose_work_summary`(work job 终态摘要,finalize 的 work 分支用)在此。
//!
//! R2(S8 收口):本模块是 work 步的**真实执行路径** —— executor 在 step 入口按
//! `WorkStepKind::from_step` 早路由到 `run_work_step_guarded`,chat executor 不再含任何
//! work prompt / 超时分支。

use crate::engine::agents::persona_loader;
use crate::engine::collaboration::executor::{resolve_companion_role, run_react_inner};
use crate::engine::collaboration::{CollaborationId, Step, StepId, StepOutput};
use crate::engine::llm_client::LLMConfig;

/// 牵头者接手步(intake)idle 超时:与 project_task 同款看门狗 —— 300s 内一点流活动
/// 都没有才判挂起。等用户答澄清**不算挂起**:ask_user 的等待循环每 30s `mark_idle_activity`
/// 报活,用户想多久答就多久答(ask_user 自身 1h 上限后优雅降级)。
/// 历史:曾是 Total(600s) 总超时 —— 把「用户离开 10 分钟」也当失败(实测:PM 问完用户
/// 没及时答 → 整步「响应超时(600s)」),等用户回答不该计时,故废弃总超时改 idle。
pub(crate) const INTAKE_IDLE_SECS: u64 = 300;
/// 派工写码任务(project_task)**不用总超时** —— 总超时会把进展中的长程任务一刀切(一个
/// 角色写多文件 + 跑构建/测试可能很久)。改用 **idle 超时**:300s 内一点流活动(token /
/// 工具事件)都没有,才判 LLM 流真挂起 → 中断;有进展就重置 → 真长程任务想跑多久跑多久。
/// 300s 也 > 单个工具(跑构建/测试)的常见耗时,避免长工具被误判。
pub(crate) const PROJECT_TASK_IDLE_SECS: u64 = 300;

/// work 步的语义(本表面只认这两种;chat 的 group_* / yiyi_* 不在此)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkStepKind {
    /// 工作群牵头者接手:主导推进 + ask_user 澄清 + propose_work_plan 派工。
    Intake,
    /// 派工任务步:按上游交付接力建造。
    ProjectTask,
}

impl WorkStepKind {
    /// 从 step.input.metadata["mode"] 翻译。非 work mode → None(本表面不处理)。
    pub fn from_step(step: &Step) -> Option<Self> {
        match step.input.metadata.get("mode").and_then(|v| v.as_str()) {
            Some("intake") => Some(Self::Intake),
            Some("project_task") => Some(Self::ProjectTask),
            _ => None,
        }
    }
}

/// work 超时策略(缝 2 归位)。chat 的短总超时(150s / 群聊 30s)留在 chat executor;
/// work 两类步都用 **idle 看门狗**(300s 无流活动才判挂起,有进展就重置):
///   - 等用户答澄清不算挂起(ask_user 等待循环每 30s 报活);
///   - 真长程任务想跑多久跑多久;只有 LLM 流真断了才砍。
/// `Total` 变体保留作机制(当前无使用者;chat 步未来迁移可用)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkTimeoutPolicy {
    /// 总超时(秒):整步从开始算,到点即砍。
    Total(u64),
    /// idle 超时(秒):距上次流活动超过阈值才砍,有进展则重置。
    Idle(u64),
}

/// work 步 → 超时策略。见 `WorkTimeoutPolicy` 文档。
pub fn work_timeout_policy(kind: WorkStepKind) -> WorkTimeoutPolicy {
    match kind {
        WorkStepKind::Intake => WorkTimeoutPolicy::Idle(INTAKE_IDLE_SECS),
        WorkStepKind::ProjectTask => WorkTimeoutPolicy::Idle(PROJECT_TASK_IDLE_SECS),
    }
}

/// 构造 work 步的 system prompt(persona 前缀 + work 角色指令)。
///
/// - **Intake**:牵头者/接口人"主导推进"指令(而非放养的"以对话为主")——把工作群从
///   七嘴八舌空转拉回有组织推进的关键。注入 roster(队友名单),让接口人 propose_work_plan
///   派工时 role 字段填对队友标识。
/// - **ProjectTask**:执行角色的"动手能力"说明(读写文件、执行命令…)。
fn render_work_system_prompt(
    step: &Step,
    participant_idx: usize,
    kind: WorkStepKind,
) -> String {
    let p = &step.participants[participant_idx];

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

    let base = format!("你是 {} {}。", p.avatar_emoji, p.name);

    let work_note = match kind {
        WorkStepKind::Intake => {
            let roster = step
                .input
                .metadata
                .get("roster")
                .and_then(|v| v.as_str())
                .unwrap_or("(暂无队友信息)");
            format!(
                "\n\n【你是这个工作群的牵头者/接口人】用户只跟你对接,你来主导推进,别只是闲聊:\n\
                 1. 先看有没有**阻塞性的关键未知**(日期/预算/范围/受众等)——有就用 ask_user 工具\
                 **一次性问清**(可给选项),等用户答了再往下。别空喊「@用户 请告诉我 X」(不阻塞、易漏、\
                 让团队空转);要用 ask_user 阻塞式地问。\n\
                 2. 关键信息齐了 → 用 **propose_work_plan** 工具把活拆成任务派给队友:每条填 role\
                 (队友的标识,见下方名单)、objective(这条做什么)、depends_on(依赖哪几条,0-based 下标,\
                 无依赖留空)。**调用即直接派工**,队友立刻并行开干(不需要用户确认、\
                 不展示方案卡 —— 直接干)。\n\
                 3. **你自己不要动手干活**(写文件/写代码/做交付物),哪怕任务再小 —— 你是\
                 协调者,你的产出不算交付,不经 propose_work_plan 派工,工作就不会被跟踪、\
                 不会有交付状态。永远拆任务派给队友。\n\
                 4. 用户可能在你忙的时候插话(他的新消息会出现在【用户刚说】/最近对话里):\
                 与手头工作相关 → 按新信息调整;无关或是另一件事 → 先简短确认收到、说明先把\
                 手头的收尾再处理它。别因为插话把原任务丢了。\n\
                 5. 【发言格式】你的每次发言(澄清/方案/总结)都要**结论先行、可扫读**:\
                 第一句话给结论;文件名/路径/命令/关键标识用反引号包(如 `index.html`);\
                 要用户拍板的事列编号选项并标(推荐);别让用户在长段落里自己找重点。\n\
                 【你的队友(propose_work_plan 的 role 填这些标识)】\n{roster}"
            )
        }
        WorkStepKind::ProjectTask => {
            "\n\n【动手能力】你能用工具(读写文件、执行命令、查资料、开浏览器等)。\
             这是在接力建造交付物,按上游给的接口 / 契约 / 设计接着做,别重复造;\
             改完用 write_file/edit_file 落盘,说清改了哪些文件。\n\
             【汇报格式】干完后的总结要让人 10 秒读懂:① 结论先行 —— 第一句话说清\
             成了没成、交付了什么;② 文件名/路径/命令用反引号包(如 `index.html`),\
             关键代码或报错证据用代码块;③ 有要用户拍板的事,列编号选项并标(推荐);\
             ④ 结尾一句话说清下一步(谁接手 / 还差什么)。别写流水账。"
                .to_string()
        }
    };

    format!("{persona_prefix}{base}{work_note}")
}

/// 把 metadata 里的对话数组渲染成文本块([{role,text}] → "role: text\n")。空数组 → 空串。
fn render_turns_block(step: &Step, key: &str, header: &str) -> String {
    let Some(arr) = step.input.metadata.get(key).and_then(|v| v.as_array()) else {
        return String::new();
    };
    if arr.is_empty() {
        return String::new();
    }
    let mut s = format!("【{header}】\n");
    for t in arr {
        let role = t.get("role").and_then(|v| v.as_str()).unwrap_or("");
        let text = t.get("text").and_then(|v| v.as_str()).unwrap_or("");
        s.push_str(&format!("{role}: {text}\n"));
    }
    s.push('\n');
    s
}

/// 构造 work 步的 user prompt。
///
/// - **ProjectTask**:上游产出作为"交接"喂给下游(后端的接口契约给前端、前后端的实现给
///   测试…),而不是"群里的讨论"。让下游角色清楚这是在接力建造。第一棒 upstream 为空 →
///   只有本任务。
/// - **Intake**:会话历史 + 牵头者先前发言(R3 跨轮记忆,launcher 注入 metadata)在前,
///   用户新消息在末 —— 没有这两块,每条 followup 都是孤立消息,牵头者反复失忆。
fn render_work_user_prompt(
    step: &Step,
    kind: WorkStepKind,
    upstream: &[(StepId, StepOutput)],
) -> String {
    match kind {
        WorkStepKind::ProjectTask => {
            let mut s = String::new();
            if !upstream.is_empty() {
                s.push_str(
                    "【上游交付】队友已完成前置任务,产出如下。请在此基础上接着做 —— \
                     别重复造,按上游给的接口 / 契约 / 设计来:\n\n",
                );
                for (id, out) in upstream {
                    s.push_str(&format!("—— 任务 #{} 的产出 ——\n{}\n\n", id, out.full_output));
                }
            }
            s.push_str("【你这条任务】\n");
            s.push_str(&step.input.prompt);
            s
        }
        WorkStepKind::Intake => {
            let history = render_turns_block(step, "history", "这个工作会话最近的对话");
            let recap = render_turns_block(
                step,
                "lead_recap",
                "你此前在本工作里的发言(别重复自我介绍、别重复已问过的问题)",
            );
            if history.is_empty() && recap.is_empty() {
                step.input.prompt.clone()
            } else {
                format!("{history}{recap}【用户刚说】\n{}", step.input.prompt)
            }
        }
    }
}

/// 执行一个 work 步:构造 work prompt → 取角色权限 → 复用 ReAct 共享内核。
///
/// - work mode 由 `WorkStepKind::from_step` 判别(intake / project_task);非 work step
///   返回 `Err`(本表面不处理 chat 步)。
/// - 角色权限(工具过滤器 + 步数上限)由 `resolve_companion_role` 解析;intake 接手者
///   兜底补 `propose_work_plan`(覆盖该工具进 Coordinator 档之前已落盘的旧动态角色)。
/// - 内核 `run_react_inner` 不含 mode 判断,ask_user 内联收尾在内核里,work/chat 复用同一条。
///
/// **超时**:本函数只跑内核;`work_timeout_policy` 给出的策略由调用方(S6 的执行包装)按
/// `Total` / `Idle` 套上 `tokio::time::timeout` / idle watchdog。这里返回内核结果,
/// 不自带超时,便于调用方按 step 决定包装方式。
pub async fn run_work_step(
    config: &LLMConfig,
    step: &Step,
    participant_idx: usize,
    upstream: &[(StepId, StepOutput)],
    collab_id: CollaborationId,
) -> Result<StepOutput, String> {
    let kind = WorkStepKind::from_step(step)
        .ok_or_else(|| "run_work_step:非 work step(缺 intake/project_task mode)".to_string())?;
    let p = &step.participants[participant_idx];

    // 角色权限:工具过滤器 + ReAct 步数上限。无角色定义 → 全套工具 + 默认步数(headless
    // 测试里 registry 不可达,安全回落)。
    let (mut role_filter, role_max_iter) = resolve_companion_role(p.companion_id).await;
    // work 步轮数 = **失控熔断**,不是预算(2026-06-11 用户拍板:work 干到交付为止,
    // 不该被轮数卡正常工作)。角色档默认 10 轮是闲聊场景的预算,work 深活(PM 读文档
    // 分析+澄清+派工 / 工程师分段写大文件+自查)实测 10 轮不够用。放到 100:正常活
    // 永远碰不到,只熔断「忙而无效」的死循环 —— 这种失控每轮都有流活动,idle 看门狗
    // (300s 无活动才砍)抓不住它,轮数是唯一熔断,不能彻底去掉。
    let role_max_iter = role_max_iter.max(100);
    if kind == WorkStepKind::Intake {
        // intake 接手者兜底补 propose_work_plan + open_for_user —— 覆盖这两个工具进
        // Coordinator 档之前已落盘的旧动态角色(AGENT.md 还没它们),以及任何非协调档
        // 却来接手的 lead。idempotent。open_for_user:协调者没有 execute_shell,这是它
        // 唯一能把成果(原型/文件夹/链接)递到用户眼前的途径。
        if let crate::engine::react_agent::ToolFilter::Allow(v) = &mut role_filter {
            for t in ["propose_work_plan", "open_for_user"] {
                if !v.iter().any(|x| x == t) {
                    v.push(t.to_string());
                }
            }
        }
        // **协调者不动手——机制化**:intake 是协调步,把"动手干活"类工具从工具面摘掉。
        // prompt 软约束实测拦不住(模型见任务简单 + 手里有 write_file 就自己写了,活干完
        // 但没派工,job 永远停在 clarifying 不闭环);角色档回落 All(headless / 旧动态角色)
        // 时尤其如此。生产 Coordinator 档本就无这些工具,此处是机制兜底,与档位语义一致。
        const HANDS_ON_TOOLS: &[&str] = &[
            "write_file", "edit_file", "append_file", "delete_file", "undo_edit",
            "execute_shell", "run_python",
        ];
        role_filter = match role_filter {
            crate::engine::react_agent::ToolFilter::All => {
                crate::engine::react_agent::ToolFilter::Deny(
                    HANDS_ON_TOOLS.iter().map(|s| s.to_string()).collect(),
                )
            }
            crate::engine::react_agent::ToolFilter::Allow(v) => {
                crate::engine::react_agent::ToolFilter::Allow(
                    v.into_iter().filter(|t| !HANDS_ON_TOOLS.contains(&t.as_str())).collect(),
                )
            }
            crate::engine::react_agent::ToolFilter::Deny(mut v) => {
                for t in HANDS_ON_TOOLS {
                    if !v.iter().any(|x| x == t) {
                        v.push(t.to_string());
                    }
                }
                crate::engine::react_agent::ToolFilter::Deny(v)
            }
        };
    }

    // 项目工作目录注入 prompt:`with_task_working_dir`(run_react_inner)只把**工具 cwd**
    // scope 到项目目录,agent 的 prompt 里并没有这个路径 —— 不告诉它,它就不知道自己在哪个
    // 绝对路径干活、是不是在改用户指定的现成项目。这里把目录显式写进 system prompt。
    let workspace_note = crate::engine::tools::get_database()
        .and_then(|db| db.group_workspace_for_collaboration(collab_id))
        .map(|ws| {
            format!(
                "\n\n【项目工作目录】你的工作目录是 `{ws}`。文件读写、命令执行都默认在这个目录里进行,\
                 用相对路径(相对该目录)或这个绝对路径都行。这是用户为本项目指定的目录,可能**已有现成文件**\
                 ——动手前先看清里面有什么(列目录 / 读关键文件),别假设是空目录、别在目录外乱建。"
            )
        })
        .unwrap_or_default();
    let system_prompt = format!(
        "{}{workspace_note}",
        render_work_system_prompt(step, participant_idx, kind)
    );
    let user_message = render_work_user_prompt(step, kind, upstream);

    // 构造完(mode-aware:prompt / 权限 / 步数)→ 交给共享 ReAct 内核执行。内核不含 mode
    // 判断;ask_user 内联收尾在内核里,chat/work 复用同一条。
    //
    // 类型擦除成 boxed trait object:抽出内核后 async fn 链多一层,外层 Send 自动 trait
    // 求值沿链深递归会撞 E0275。在内核边界装成 `dyn Future + Send` 截断递归。
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
    // 绑 work 上下文(task-local):propose_work_plan 据此知道方案属于哪个会话
    // (载荷带 session_id + 方案落库落对会话 + job 状态机推进)。
    let session_id = crate::engine::tools::get_database()
        .and_then(|db| db.collaboration_session_id(collab_id));
    match session_id {
        Some(sid) => {
            crate::engine::tools::work_tools::with_work_ctx(sid, collab_id, fut).await
        }
        None => fut.await,
    }
}

/// work 步的超时包装(缝 2 归位后的执行入口):按 `work_timeout_policy` 给 `run_work_step`
/// 套 Total 总超时 / Idle 看门狗。executor 在 step 入口路由到这里,chat 超时策略不再掺 work。
///
/// - **Total(intake)**:整步从开始算,到点即砍 —— `tokio::time::timeout`。
/// - **Idle(project_task)**:看门狗在 idle 超过阈值时赢得 select! → run 被 drop → 断开挂起
///   的连接读(cancelled 旗标在流读卡住时不会被检查,所以靠 drop);有流活动就重置。
pub async fn run_work_step_guarded(
    config: &LLMConfig,
    step: &Step,
    participant_idx: usize,
    upstream: &[(StepId, StepOutput)],
    collab_id: CollaborationId,
) -> Result<StepOutput, String> {
    let kind = WorkStepKind::from_step(step)
        .ok_or_else(|| "run_work_step_guarded:非 work step".to_string())?;
    let name = step
        .participants
        .get(participant_idx)
        .map(|p| p.name.clone())
        .unwrap_or_default();

    // **poll 链截断**:整步 spawn 成独立 task,而不是内联 .await。work 步的 async 链极深
    // (orchestrator 调度 task → executor 路由 → 本函数 → run_work_step 的 prompt 构造 →
    // WORK_CTX scope → run_react_inner 的 5 层 task-local scope → run_agent ReAct 循环 →
    // 流式解析 → 工具分发),每层 poll 帧叠在同一条 worker 线程栈上;debug build(dev 模式!)
    // 帧肥,2MiB 的 tokio worker 栈在执行中被撑爆(实测:live 旅程测试派工 40s 时
    // stack overflow abort)。Box::pin 只把 future 状态挪到堆,**不剪 poll 深度**;spawn
    // 让内层链从新 task 自己的入口 poll,外层只 poll 一个 JoinHandle。
    //
    // task-local 安全性:run_work_step 的全部绑定(WORK_CTX / 工具过滤器 / 会话 / idle
    // 活动)都是 `.scope(v, fut)` 组合器 —— 绑定存在 future 里、随 future 走,在哪个 task
    // 上 poll 都有效;不存在"内层依赖 spawn 前外层环境"的绑定。
    //
    // 超时语义保持:Total 到点 / Idle 看门狗赢 → `handle.abort()` 显式取消(旧实现靠 drop
    // future 断开挂起的连接读;spawn 后 task 独立存活,必须 abort 才等价)。
    let config = config.clone();
    let step_owned = step.clone();
    let upstream_owned = upstream.to_vec();

    match work_timeout_policy(kind) {
        WorkTimeoutPolicy::Total(secs) => {
            let mut handle = tokio::spawn(async move {
                run_work_step(&config, &step_owned, participant_idx, &upstream_owned, collab_id)
                    .await
            });
            match tokio::time::timeout(std::time::Duration::from_secs(secs), &mut handle).await {
                Ok(joined) => joined.unwrap_or_else(|e| Err(format!("{name} 执行中断:{e}"))),
                Err(_) => {
                    handle.abort();
                    Err(format!("{name} 响应超时({secs}s)"))
                }
            }
        }
        WorkTimeoutPolicy::Idle(idle_secs) => {
            let activity = std::sync::Arc::new(std::sync::Mutex::new(std::time::Instant::now()));
            let watch = std::sync::Arc::clone(&activity);
            let watchdog = async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    let idle = watch.lock().map(|t| t.elapsed()).unwrap_or_default();
                    if idle > std::time::Duration::from_secs(idle_secs) {
                        return;
                    }
                }
            };
            let mut handle = tokio::spawn(crate::engine::agent_runner::with_idle_activity(
                activity,
                async move {
                    run_work_step(&config, &step_owned, participant_idx, &upstream_owned, collab_id)
                        .await
                },
            ));
            tokio::select! {
                joined = &mut handle => {
                    joined.unwrap_or_else(|e| Err(format!("{name} 执行中断:{e}")))
                }
                _ = watchdog => {
                    handle.abort();
                    Err(format!("{name} 卡住({idle_secs}s 无流响应)"))
                }
            }
        }
    }
}

/// §7 / 缝 8:work job 终态摘要 —— 写回 chat stream 的"✅ 交付完成"结果消息。
///
/// chat 群聊用 `orchestrator::compose_done_verdict`(群聊【名字】格式);work job 完成不该
/// 复用群聊 verdict 拼接(那是"换名字藏起来")。work 终态走本函数:汇总各 work 步的产出
/// 成一条简洁的交付摘要,S6 以 `context_type=work_job` 写回 `chat_session_id`(回流体感
/// 连贯但数据隔离)。
///
/// 入参 `step_outputs` 是按 step 顺序的 `(参与者名, 产出)`;空产出 / 失败步由调用方过滤。
/// S4 先给纯函数实现(可测、无 DB 依赖);S6 接线时由 finalize 的 work 分支按 collab_id
/// 读 step 产出后调它。
/// work job 失败的结构化报告(对照 slock 式诊断卡:卡在哪 + 编号选项 + 推荐标注),
/// 替代旧的一行「（工作未完成）reason」—— 失败时刻正是用户最需要被引导的时刻。
pub fn compose_work_failure(reason: &str) -> String {
    let mut s = String::from("⚠️ **工作没做完**\n\n");
    let reason = reason.trim();
    if !reason.is_empty() {
        s.push_str(&format!("**卡在哪**:{reason}\n\n"));
    }
    s.push_str(
        "**接下来可以**:\n\
         1. 在上面失败成员的气泡下点「重叫一次 ↺」让它重试(推荐 —— 偶发失败大多重试一次就过)\n\
         2. 直接在输入框说怎么调整(比如「文件拆小一点做」),牵头者会按新要求重新安排\n\
         3. 不做了就在左侧列表这一行点 ⛔ 中止",
    );
    s
}

pub fn compose_work_summary(title: &str, step_outputs: &[(String, StepOutput)]) -> String {
    let mut s = String::new();
    s.push_str(&format!("✅ 交付完成:{}\n\n", title.trim()));
    if step_outputs.is_empty() {
        s.push_str("(本次没有可见产出。)");
        return s;
    }
    for (name, out) in step_outputs {
        let body = if out.full_output.trim().is_empty() {
            out.summary.trim()
        } else {
            out.full_output.trim()
        };
        if body.is_empty() {
            continue;
        }
        s.push_str(&format!("【{}】{}\n\n", name.trim(), body));
    }
    s.trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::collaboration::{
        Participant, Step, StepInput, StepKind, StepStatus, TokenUsage,
    };
    use crate::engine::agents::MemoryScope;

    fn out(full: &str) -> StepOutput {
        StepOutput {
            summary: full.chars().take(50).collect(),
            full_output: full.into(),
            tokens_used: TokenUsage::default(),
            duration_ms: 0,
        }
    }

    fn step_with_mode(mode: &str) -> Step {
        Step {
            id: 2,
            kind: StepKind::ParallelAgents,
            participants: vec![Participant {
                companion_id: 9,
                name: "前端".into(),
                avatar_emoji: "🤖".into(),
                color_hex: "#000".into(),
                memory_scope: MemoryScope::Group(1),
            }],
            depends_on: vec![1],
            input: StepInput {
                prompt: "写前端界面".into(),
                metadata: serde_json::json!({ "mode": mode }),
            },
            output: None,
            status: StepStatus::Pending,
            started_at: None,
            finished_at: None,
        }
    }

    #[test]
    fn from_step_recognizes_work_modes_only() {
        assert_eq!(
            WorkStepKind::from_step(&step_with_mode("intake")),
            Some(WorkStepKind::Intake)
        );
        assert_eq!(
            WorkStepKind::from_step(&step_with_mode("project_task")),
            Some(WorkStepKind::ProjectTask)
        );
        // chat 模式 / 无 mode → 不是 work step。
        assert_eq!(WorkStepKind::from_step(&step_with_mode("group_loop")), None);
        let mut plain = step_with_mode("intake");
        plain.input.metadata = serde_json::Value::Null;
        assert_eq!(WorkStepKind::from_step(&plain), None);
    }

    #[test]
    fn timeout_policy_intake_total_project_idle() {
        assert_eq!(
            work_timeout_policy(WorkStepKind::Intake),
            WorkTimeoutPolicy::Idle(INTAKE_IDLE_SECS)
        );
        assert_eq!(
            work_timeout_policy(WorkStepKind::ProjectTask),
            WorkTimeoutPolicy::Idle(PROJECT_TASK_IDLE_SECS)
        );
    }

    #[test]
    fn project_task_user_prompt_frames_upstream_as_handoff() {
        let step = step_with_mode("project_task");
        let upstream = vec![(1i64, out("GET /todos 返回 [{id,title,done}]"))];
        let prompt = render_work_user_prompt(&step, WorkStepKind::ProjectTask, &upstream);
        assert!(prompt.contains("上游交付"), "应是交接语义: {prompt}");
        assert!(prompt.contains("GET /todos"), "应注入上游产出");
        assert!(prompt.contains("写前端界面"), "应含本任务");
        assert!(!prompt.contains("群里目前的讨论"), "不该是讨论语义");

        // 无上游(第一棒)→ 只有任务,无交接块。
        let p0 = render_work_user_prompt(&step, WorkStepKind::ProjectTask, &[]);
        assert!(!p0.contains("上游交付"));
        assert!(p0.contains("写前端界面"));
    }

    #[test]
    fn intake_system_prompt_injects_roster_and_lead_directive() {
        let mut step = step_with_mode("intake");
        step.input.metadata = serde_json::json!({
            "mode": "intake",
            "roster": "- 前端(派工 role=`frontend_dev`):写界面",
        });
        let sys = render_work_system_prompt(&step, 0, WorkStepKind::Intake);
        assert!(sys.contains("牵头者"), "应是主导推进指令");
        assert!(sys.contains("propose_work_plan"), "应引导用 work 工具派工");
        assert!(sys.contains("frontend_dev"), "应注入 roster");
    }

    #[test]
    fn compose_work_summary_lists_deliverables() {
        let summary = compose_work_summary(
            "Todo 应用",
            &[
                ("后端".into(), out("API 已实现")),
                ("前端".into(), out("界面已实现")),
            ],
        );
        assert!(summary.contains("✅ 交付完成:Todo 应用"));
        assert!(summary.contains("【后端】API 已实现"));
        assert!(summary.contains("【前端】界面已实现"));
    }

    #[test]
    fn compose_work_summary_skips_blank_outputs() {
        let summary = compose_work_summary("空", &[("X".into(), out("   "))]);
        assert!(summary.contains("✅ 交付完成:空"));
        assert!(!summary.contains("【X】"), "空产出应跳过");
    }

    #[test]
    fn compose_work_failure_is_structured_with_options() {
        // slock 式失败报告:卡在哪 + 编号选项 + 推荐标注(失败时刻要引导,不制造无助感)。
        let s = compose_work_failure("step 1: 交互设计师 没回上来");
        assert!(s.contains("⚠️"), "应有失败标识");
        assert!(s.contains("卡在哪"), "应说清卡点");
        assert!(s.contains("交互设计师"), "应带原始失败原因");
        assert!(s.contains("1.") && s.contains("2.") && s.contains("3."), "应给编号选项");
        assert!(s.contains("推荐"), "应标推荐项");

        // 空 reason:不渲染空的「卡在哪」段。
        let s = compose_work_failure("  ");
        assert!(!s.contains("卡在哪"));
        assert!(s.contains("接下来可以"));
    }

    #[test]
    fn work_prompts_inject_report_format() {
        // 汇报规范注入两类 work 步(动态角色也经此生效,persona 白盒不动)。
        let sys = render_work_system_prompt(&step_with_mode("project_task"), 0, WorkStepKind::ProjectTask);
        assert!(sys.contains("汇报格式"), "执行角色应有汇报格式指令");
        assert!(sys.contains("结论先行"));
        let mut intake = step_with_mode("intake");
        intake.input.metadata = serde_json::json!({ "mode": "intake", "roster": "-" });
        let sys = render_work_system_prompt(&intake, 0, WorkStepKind::Intake);
        assert!(sys.contains("发言格式"), "牵头者应有发言格式指令");
    }
}
