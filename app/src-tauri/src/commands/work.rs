//! WORK 命令(缝 7 归位):用户点"开工"后,把牵头者的方案派工给各角色。
//!
//! 从 `commands/agent/project.rs` **复制**(S5:复制不删,原件 S8 删):
//!   - `prepare_project_dispatch` → `prepare_work_dispatch`(纯 DB:resolve 群 + 成员 + build DAG);
//!   - `commit_project_plan(_impl)` → `commit_work_plan(_impl)`(= prepare + orchestrator.submit
//!     真派工)。计划类型改读 `engine/work/plan`;**submit 后多调一步**
//!     `db.set_collaboration_kind(collab_id, "work_dispatch")` 标记(S1 加的判别器辅助)——
//!     让 work job 在数据层与 chat 群聊显式分流(缝 5 / §7-P0-1 据此按 kind 分叉 finalize)。
//!
//! 静态 plan 复用现有 orchestrator 的 schedule / all-terminal finalize;动态 AddStep /
//! ProjectController 是后续里程碑。
//!
//! **S5 现状**:`commit_work_plan` 注册进 `lib.rs`(与旧 `commit_project_plan` 并存),但前端
//! 尚未调用(S7 改前端 reload 走 work 回流);`prepare_work_dispatch` 是纯函数不注册。

use std::sync::Arc;

use tauri::State;

use crate::commands::agent::helpers::resolve_llm_config;
use crate::engine::collaboration::orchestrator::SqliteOrchestrator;
use crate::engine::collaboration::{CollaborationPlan, CompanionProfile};
use crate::engine::db::{Database, ProjectGroupSummary, WorkJobSummary};
use crate::engine::work::plan::{build_project_collaboration_plan, ProjectPlan};
use crate::state::AppState;

/// WorkPage(work 象限入口)的监控列表:列出所有 work job(kind=work_dispatch)摘要,新→旧(S7)。
#[tauri::command]
pub fn list_work_jobs(state: State<'_, AppState>) -> Vec<WorkJobSummary> {
    state.db.list_work_jobs()
}

/// 「新建工作」弹窗的「项目」下拉数据源:列出所有绑了 workspace 的项目团队,
/// 按最近一次 work job 降序(最近用的项目置顶)。只返回项目群,普通闲聊群不在下拉里。
#[tauri::command]
pub fn list_project_groups(state: State<'_, AppState>) -> Vec<ProjectGroupSummary> {
    state.db.list_project_groups()
}

/// 项目复用:某个文件夹是否已绑过团队(同一项目反复干活复用同支团队,不重复组队)。
/// 「项目优先」的新建工作在选了已有文件夹时据此决定复用 / 现组。命中返回 group_id。
#[tauri::command]
pub fn find_team_by_folder(state: State<'_, AppState>, folder: String) -> Option<i64> {
    let folder = folder.trim();
    if folder.is_empty() {
        return None;
    }
    state.db.find_group_by_workspace(&canonical_path(folder))
}

/// 路径规范化(R4):同一文件夹的不同写法(尾斜杠 / macOS `/tmp`→`/private/tmp` symlink /
/// 相对段)统一成 canonical 形,否则「同项目复用团队」按裸字符串匹配会失配 → 重复组队、
/// 两支团队绑同一目录互踩。canonicalize 失败(目录不存在等)回退 trim 原文。
fn canonical_path(p: &str) -> String {
    std::fs::canonicalize(p)
        .map(|pb| pb.to_string_lossy().to_string())
        .unwrap_or_else(|_| p.trim_end_matches('/').to_string())
}

/// 「新建工作」发起后返回的句柄:新建的 work 会话 + intake 协作 id(前端跳过去看团队推进)。
#[derive(serde::Serialize)]
pub struct LaunchedWork {
    pub session_id: String,
    pub collaboration_id: i64,
}

/// 工作入口「新建工作」:在指定团队群上**显式发起**一个 work job —— 不靠 chat 措辞检测,
/// 用户从 work 入口明确开工(对齐决策 X:work 是从 chat 显式 launch 的)。建一个 work 会话
/// 绑团队群 → 牵头者(coordinator / PM 档)接手 intake(澄清需求 → propose → 派工)。
#[tauri::command]
pub async fn launch_work_job(
    state: State<'_, AppState>,
    team_gid: i64,
    task: String,
    workspace_path: Option<String>,
) -> Result<LaunchedWork, String> {
    launch_work_job_impl(&state, team_gid, &task, workspace_path).await
}

pub async fn launch_work_job_impl(
    state: &AppState,
    team_gid: i64,
    task: &str,
    workspace_path: Option<String>,
) -> Result<LaunchedWork, String> {
    let task = task.trim().to_string();
    if task.is_empty() {
        return Err("请描述要做什么".into());
    }
    let db = state.db.clone();
    let members = team_members(&db, team_gid)?;
    let lead = crate::engine::work::launcher::find_project_lead(&members)
        .await
        .ok_or_else(|| "这个团队里没有能接手的牵头者(需要 coordinator / PM 档角色)".to_string())?;
    let cfg = resolve_llm_config(state).await?;

    // 新建一个 work 会话,绑团队群(intake / 派工 / 执行都在这个会话里)。
    let session_id = format!("work-{}", uuid::Uuid::new_v4());
    let title: String = task.chars().take(30).collect();
    db.ensure_session(&session_id, &title, "work", None)?;
    db.set_session_group(&session_id, Some(team_gid))?;

    // 项目文件夹(per-team):用户在「新建工作」选/建的目录设为这支团队的工作区,
    // 执行期 executor 经 group_workspace_for_collaboration → with_task_working_dir 把成员的
    // 文件/shell 工具 cwd scope 到这里。必须同时登记成 read_write 授权文件夹,否则工具读写
    // 会被路径授权门禁拦弹窗(add_authorized_folder_impl 是 upsert,重复登记安全)。
    if let Some(ws) = workspace_path
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(canonical_path)
        .as_deref()
    {
        db.set_group_workspace(team_gid, ws)?;
        let team_name = db.get_companion_group(team_gid).map(|g| g.name);
        crate::commands::workspace::add_authorized_folder_impl(
            state,
            ws.to_string(),
            team_name,
            Some("read_write".into()),
        )
        .await?;
    }

    // R3:用户的任务原文落成 user 气泡(此前只有协作锚点,原始请求不在历史里、
    // followup 的 intake 历史块也带不上它);job 入 work_jobs 状态机(clarifying),
    // 牵头者固化(followup 复用,不重选,防 PM 漂移 + 省一次 find_project_lead)。
    let _ = db.push_message(&session_id, "user", &task);
    db.create_work_job(&session_id, &task, Some(lead.id))?;

    let collab_id = crate::engine::work::launcher::launch_intake(
        db.clone(),
        cfg,
        &session_id,
        team_gid,
        lead,
        &members,
        &task,
    )
    .await?;
    Ok(LaunchedWork {
        session_id,
        collaboration_id: collab_id,
    })
}

/// 群成员 → `CompanionProfile` 列表(work 派工 / intake 用)。空群报错。
fn team_members(db: &Database, gid: i64) -> Result<Vec<CompanionProfile>, String> {
    let companions = db.list_group_members(gid);
    if companions.is_empty() {
        return Err("这个团队还没有成员".into());
    }
    Ok(companions
        .into_iter()
        .map(|c| CompanionProfile {
            id: c.id,
            name: c.name,
            avatar_emoji: c.avatar_emoji,
            color_hex: c.color_hex,
            description: c.role_label.unwrap_or_else(|| c.agent_definition_name.clone()),
            agent_definition_name: c.agent_definition_name,
            last_used_at: c.last_used_at,
        })
        .collect())
}

/// work followup 的处理结果:新起了 intake 协作,或本轮以一条提示消息收束(已落库)。
pub enum WorkFollowup {
    /// 牵头者已接手,新 intake 协作 id。
    Intake(i64),
    /// 没起协作,直接回了一条提示(停止确认 / 互斥守卫等),文本已 push 进会话。
    Notice(String),
}

/// work 会话的**后续消息**:不走放养群聊(那会让全员几十轮空转烧 token),交给牵头者
/// **单 agent 有界接手**(intake:澄清 → 需要时 propose_work_plan 再派工)。chat×work 决策 B ——
/// work 永远结构化,放养只属于纯聊天群。
///
/// R3 三道闸(按序):
/// 1. **停止意图**:「停」不是新任务 —— 中止整个 job(否则用户根本喊不停);
/// 2. **互斥守卫**:上一轮 intake 还在跑 → 拒绝并提示(防并发多 PM 竞态 + 重发翻倍);
/// 3. **牵头者固化**:复用 job 记录的 lead,不重选(防 PM 漂移,省一次解析)。
pub async fn dispatch_work_followup(
    state: &AppState,
    session_id: &str,
    message: &str,
    mentioned: &[i64],
) -> Result<WorkFollowup, String> {
    let db = state.db.clone();

    if crate::commands::agent::group_dispatch::is_stop_intent(message) {
        let n = abort_work_job_impl(state, session_id)?;
        let text = if n > 0 {
            "✋ 已停止这项工作(运行中的任务不再继续)。要重启的话再描述一次要做什么。"
        } else {
            "现在没有在跑的任务。要继续推进的话直接说要做什么。"
        };
        let _ = db.push_message(session_id, "assistant", text);
        return Ok(WorkFollowup::Notice(text.to_string()));
    }

    // @ 直达(2026-06-12 用户规则):消息默认给牵头者,@ 某个工人 → 任务直达该成员,
    // 不经牵头者、也不受 intake 互斥闸约束(点名工人和牵头者忙不冲突)。@ 的是牵头者
    // 本人 → 落到下面默认 intake(等价)。@ 多位 → 取第一位(v1)。
    if !mentioned.is_empty() {
        if let Some(gid) = db.get_session_group(session_id) {
            let members = team_members(&db, gid)?;
            if let Some(target) = mentioned
                .iter()
                .filter_map(|id| members.iter().find(|m| m.id == *id))
                .find(|m| Some(m.id) != db.get_work_job_lead(session_id))
            {
                let cfg = resolve_llm_config(state).await?;
                let collab_id = crate::engine::work::launcher::launch_direct_task(
                    db.clone(),
                    cfg,
                    session_id,
                    gid,
                    target,
                    message,
                )
                .await?;
                return Ok(WorkFollowup::Intake(collab_id));
            }
        }
    }

    if db.has_active_work_intake(session_id) {
        // 闸 2 改造(2026-06-11 用户反馈:被拒绝不是合理交互)——intake 在跑时不再弹回:
        // 2a. 牵头者正阻塞在 ask_user 等答案 → 这条消息**就是答案**:直接投递,intake
        //     原地续跑。正常路径前端已把输入路由成答案(发送即回答);这里是后端兜底 ——
        //     提问卡尚未恢复 / 事件丢失时,用户的回答不再被互斥闸弹回(回答被拒 = 死锁)。
        let pending = db.list_pending_questions(session_id);
        if let Some(q) = pending.first() {
            db.mark_question_answered(&q.request_id, message)?;
            crate::engine::tools::ask_user::respond(&q.request_id, message.to_string()).await;
            // 答案已投递,牵头者会接着说话(问答由执行器内联进它的气泡),无需另发提示。
            return Ok(WorkFollowup::Notice(String::new()));
        }
        // 2b. 没在等答案(推理/工具执行中)→ **收下**(消息已由 prepare_chat_context 落库):
        //     牵头者这轮收尾时,finalize 的 work_intake 分支检测到积压的新消息会自动续一轮
        //     intake 读到它 ——「先处理之前的,再继续处理新的」,不丢话、不打断进行中的活。
        let text = "✍️ 收到!牵头者正在忙上一轮,忙完马上看你这条。";
        let _ = db.push_message(session_id, "assistant", text);
        return Ok(WorkFollowup::Notice(text.to_string()));
    }

    let gid = db
        .get_session_group(session_id)
        .ok_or_else(|| "工作会话未绑团队群".to_string())?;
    let members = team_members(&db, gid)?;
    // 牵头者固化:优先用 job 记录的 lead;不在群里了(被踢/解散重组)→ 重选并回写。
    let lead = match db
        .get_work_job_lead(session_id)
        .and_then(|id| members.iter().find(|m| m.id == id))
    {
        Some(l) => l,
        None => {
            let l = crate::engine::work::launcher::find_project_lead(&members)
                .await
                .ok_or_else(|| {
                    "这个团队里没有能接手的牵头者(需要 coordinator / PM 档角色)".to_string()
                })?;
            db.create_work_job(session_id, message, Some(l.id))?; // 旧会话无 job 行时补建
            l
        }
    };
    // followup 重新激活:done/failed 后用户继续说话 = 工作还有下文,回到澄清态。
    if matches!(
        db.get_work_job_status(session_id).as_deref(),
        Some("done") | Some("failed") | Some("aborted")
    ) {
        let _ = db.set_work_job_status(session_id, "clarifying");
    }
    let cfg = resolve_llm_config(state).await?;
    let collab_id = crate::engine::work::launcher::launch_intake(
        db.clone(),
        cfg,
        session_id,
        gid,
        lead,
        &members,
        message,
    )
    .await?;
    Ok(WorkFollowup::Intake(collab_id))
}

/// 中止一个 work job(R3 逃生门):该会话所有非终态 work 协作置 aborted(CAS 终态守卫保证
/// 晚到的步完成回调被忽略),job 状态机置 aborted。返回被中止的协作数。
/// 注:已在跑的 ReAct 步不被强杀(detached task),其结果不再落库 —— v1 取舍。
#[tauri::command]
pub async fn abort_work_job(state: State<'_, AppState>, session_id: String) -> Result<usize, String> {
    abort_work_job_impl(&state, &session_id)
}

pub fn abort_work_job_impl(state: &AppState, session_id: &str) -> Result<usize, String> {
    let db = state.db.clone();
    let active = db.list_active_work_collabs(session_id);
    let executor = Arc::new(crate::engine::collaboration::executor::ConcreteExecutor::new(
        crate::engine::llm_client::LLMConfig::default(),
    ));
    let orch = SqliteOrchestrator::new(db.clone(), executor);
    let mut n = 0;
    for id in &active {
        match orch.abort_collaboration(*id) {
            Ok(()) => n += 1,
            Err(e) => log::warn!("abort work collab {id}: {e}"),
        }
    }
    db.set_work_job_status(session_id, "aborted")?;
    Ok(n)
}

/// 解析并构建派工 DAG(不 submit):会话 → 群 → 成员 → build。返回 (协作 plan, group_id)。
/// 纯 DB + builder,可确定性测试。
pub fn prepare_work_dispatch(
    db: &Database,
    session_id: &str,
    plan: &ProjectPlan,
) -> Result<(CollaborationPlan, i64), String> {
    let gid = db
        .get_session_group(session_id)
        .ok_or_else(|| "会话未绑群,无法派工".to_string())?;
    let members = db.list_group_members(gid);
    let cplan = build_project_collaboration_plan(plan, &members, gid)?;
    Ok((cplan, gid))
}

/// 用户在"开工方案"卡上点"开工" —— 把牵头者的计划派工给各角色,返回 collaboration_id。
#[tauri::command]
pub async fn commit_work_plan(
    state: State<'_, AppState>,
    session_id: String,
    plan: ProjectPlan,
) -> Result<i64, String> {
    commit_work_plan_impl(&state, &session_id, plan).await
}

pub async fn commit_work_plan_impl(
    state: &AppState,
    session_id: &str,
    plan: ProjectPlan,
) -> Result<i64, String> {
    // 2026-06-11 直接派发改造后,派工主体下沉 engine(propose_work_plan 工具调用即派工);
    // 本命令保留作旧方案卡(committed 前的历史卡)上「开工」按钮的兼容路径,逻辑同源。
    let cfg = resolve_llm_config(state).await?;
    crate::engine::work::launcher::dispatch_work_plan(state.db.clone(), cfg, session_id, &plan)
        .await
}

#[cfg(all(test, feature = "test-support"))]
mod tests {
    use super::*;
    use crate::engine::db::NewCompanion;
    use crate::engine::work::plan::ProjectTask;
    use crate::test_support::TempDb;
    use serial_test::serial;

    fn adopt(db: &Database, slug: &str) -> i64 {
        db.adopt_companion(&NewCompanion {
            name: format!("{slug}-小伙伴"),
            agent_definition_name: slug.into(),
            avatar_emoji: "🤖".into(),
            color_hex: "#000".into(),
            persona_md_path: None,
            memory_user_id: format!("companion_{slug}"),
            metadata_json: None,
            role_label: None,
        })
        .unwrap()
    }

    #[test]
    #[serial]
    fn prepare_resolves_group_members_and_builds_dag() {
        let t = TempDb::new();
        let db = t.db();
        // 建团队:后端 / 前端 / 测试,入群,会话绑群。
        let be = adopt(&db, "backend_dev");
        let fe = adopt(&db, "frontend_dev");
        let qa = adopt(&db, "qa_engineer");
        let gid = db.create_companion_group("软件公司", None, None).unwrap();
        for cid in [be, fe, qa] {
            db.add_group_member(gid, cid).unwrap();
        }
        db.push_message("sess", "user", "做个 app").unwrap();
        db.set_session_group("sess", Some(gid)).unwrap();

        let plan = ProjectPlan {
            tasks: vec![
                ProjectTask { role: "backend_dev".into(), objective: "写 API".into(), depends_on: vec![] },
                ProjectTask { role: "frontend_dev".into(), objective: "写前端".into(), depends_on: vec![0] },
                ProjectTask { role: "qa_engineer".into(), objective: "测试".into(), depends_on: vec![0, 1] },
            ],
        };
        let (cplan, got_gid) = prepare_work_dispatch(&db, "sess", &plan).unwrap();
        assert_eq!(got_gid, gid);
        assert_eq!(cplan.steps.len(), 3);
        // role → 群里对应 companion。
        assert_eq!(cplan.steps[0].participants[0].companion_id, be);
        assert_eq!(cplan.steps[1].participants[0].companion_id, fe);
        assert_eq!(cplan.steps[2].participants[0].companion_id, qa);
        // 交接依赖。
        assert_eq!(cplan.steps[1].depends_on, vec![1]);
        assert_eq!(cplan.steps[2].depends_on, vec![1, 2]);
    }

    #[test]
    #[serial]
    fn prepare_errors_when_session_not_bound_to_group() {
        let t = TempDb::new();
        let db = t.db();
        db.push_message("solo", "user", "你好").unwrap();
        let plan = ProjectPlan {
            tasks: vec![ProjectTask { role: "frontend_dev".into(), objective: "x".into(), depends_on: vec![] }],
        };
        assert!(prepare_work_dispatch(&db, "solo", &plan).is_err());
    }

    #[test]
    #[serial]
    fn prepare_errors_when_role_not_in_group() {
        let t = TempDb::new();
        let db = t.db();
        let fe = adopt(&db, "frontend_dev");
        let gid = db.create_companion_group("软件公司", None, None).unwrap();
        db.add_group_member(gid, fe).unwrap();
        db.push_message("sess", "user", "x").unwrap();
        db.set_session_group("sess", Some(gid)).unwrap();
        // 计划点名了不在群里的 backend_dev。
        let plan = ProjectPlan {
            tasks: vec![ProjectTask { role: "backend_dev".into(), objective: "写 API".into(), depends_on: vec![] }],
        };
        assert!(prepare_work_dispatch(&db, "sess", &plan).is_err());
    }
}
