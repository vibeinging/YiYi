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
use crate::engine::collaboration::executor::ConcreteExecutor;
use crate::engine::collaboration::orchestrator::SqliteOrchestrator;
use crate::engine::collaboration::{
    CollaborationMode, CollaborationOrchestrator, CollaborationPlan, CompanionProfile,
};
use crate::engine::db::{Database, WorkJobSummary};
use crate::engine::work::plan::{build_project_collaboration_plan, ProjectPlan};
use crate::state::AppState;

/// WorkPage(work 象限入口)的监控列表:列出所有 work job(kind=work_dispatch)摘要,新→旧(S7)。
#[tauri::command]
pub fn list_work_jobs(state: State<'_, AppState>) -> Vec<WorkJobSummary> {
    state.db.list_work_jobs()
}

/// 项目复用:某个文件夹是否已绑过团队(同一项目反复干活复用同支团队,不重复组队)。
/// 「项目优先」的新建工作在选了已有文件夹时据此决定复用 / 现组。命中返回 group_id。
#[tauri::command]
pub fn find_team_by_folder(state: State<'_, AppState>, folder: String) -> Option<i64> {
    let folder = folder.trim();
    if folder.is_empty() {
        return None;
    }
    state.db.find_group_by_workspace(folder)
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
    if let Some(ws) = workspace_path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
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

/// work 会话的**后续消息**:不走放养群聊(那会让全员几十轮空转烧 token),交给牵头者
/// **单 agent 有界接手**(intake:澄清 → 需要时 propose_work_plan 再派工)。chat×work 决策 B ——
/// work 永远结构化,放养只属于纯聊天群。返回新建的 intake 协作 id。
pub async fn dispatch_work_followup(
    state: &AppState,
    session_id: &str,
    message: &str,
) -> Result<i64, String> {
    let db = state.db.clone();
    let gid = db
        .get_session_group(session_id)
        .ok_or_else(|| "工作会话未绑团队群".to_string())?;
    let members = team_members(&db, gid)?;
    let lead = crate::engine::work::launcher::find_project_lead(&members)
        .await
        .ok_or_else(|| "这个团队里没有能接手的牵头者(需要 coordinator / PM 档角色)".to_string())?;
    let cfg = resolve_llm_config(state).await?;
    crate::engine::work::launcher::launch_intake(db.clone(), cfg, session_id, gid, lead, &members, message)
        .await
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
    let (cplan, _gid) = prepare_work_dispatch(&state.db, session_id, &plan)?;

    // 派工成员名(去重)—— cplan 随后被 submit 消费,先取出来给锚点占位消息用。
    let mut member_names: Vec<String> = Vec::new();
    for s in &cplan.steps {
        for p in &s.participants {
            if !member_names.iter().any(|n| n == &p.name) {
                member_names.push(p.name.clone());
            }
        }
    }

    let cfg = resolve_llm_config(state).await?;
    let executor = Arc::new(ConcreteExecutor::new(cfg));
    let orch = SqliteOrchestrator::new(state.db.clone(), executor);
    let parent_id = orch
        .list_recent_by_session(session_id, 1)
        .ok()
        .and_then(|v| v.into_iter().next())
        .map(|c| c.id);
    let intent = format!("开工:派 {} 个任务", plan.tasks.len());
    let collab_id = orch
        .submit(
            session_id.to_string(),
            intent,
            cplan,
            CollaborationMode::Dispatched(0),
            parent_id,
        )
        .await?;

    // S1 判别器:标 work_dispatch —— 让 work job 在数据层与 chat 群聊显式分流。缝 5 / §7-P0-1
    // 据此按 kind 分叉 finalize(work 走 compose_work_summary,不复用群聊 verdict 拼接)。
    let _ = state.db.set_collaboration_kind(collab_id, "work_dispatch");

    // 锚点占位消息:派工协作也要在聊天流里有挂载点,前端 get_history 才会把它映射成
    // role='collaboration' → CollaborationMessageCard hydrate 该 collab → 渲染队友实时发言。
    // 放养/intake/私聊派发都 upsert 占位,唯独"开工"这条之前漏了 → 开工后页面静默看不到队友干活。
    let mention = member_names
        .iter()
        .map(|n| format!("@{n}"))
        .collect::<Vec<_>>()
        .join(" ");
    // §7-P0-2:开工锚点标 context_type=work_job(前端按 work 分流)。kind=work_dispatch 已由
    // commit_work_plan_impl 上面的 set_collaboration_kind 标过。
    let _ = state.db.upsert_collaboration_message_ctx(
        session_id,
        collab_id,
        &format!("🛠️ 开工 —— {mention} 按方案并行推进中…"),
        "work_job",
    );
    Ok(collab_id)
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
