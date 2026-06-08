//! Project-mode 命令(S2③):用户点"开工"后,把 PM 的方案派工给各角色。
//!
//! `prepare_project_dispatch`(纯 DB:resolve 群 + 成员 + build DAG)与 `commit_project_plan`
//! (= prepare + orchestrator.submit 真派工)拆开,便于确定性测试派工的解析/构建逻辑,
//! 不依赖 LLM。静态 plan 复用现有 orchestrator 的 schedule/all-terminal finalize;动态
//! AddStep / ProjectController 是 S2⑤。

use std::sync::Arc;

use tauri::State;

use crate::commands::agent::helpers::resolve_llm_config;
use crate::engine::collaboration::executor::ConcreteExecutor;
use crate::engine::collaboration::orchestrator::SqliteOrchestrator;
use crate::engine::collaboration::project::{build_project_collaboration_plan, ProjectPlan};
use crate::engine::collaboration::{CollaborationMode, CollaborationOrchestrator, CollaborationPlan};
use crate::engine::db::Database;
use crate::state::AppState;

/// 解析并构建派工 DAG(不 submit):会话 → 群 → 成员 → build。返回 (协作 plan, group_id)。
/// 纯 DB + builder,可确定性测试。
pub fn prepare_project_dispatch(
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

/// 用户在"开工方案"卡上点"开工" —— 把 PM 的计划派工给各角色,返回 collaboration_id。
#[tauri::command]
pub async fn commit_project_plan(
    state: State<'_, AppState>,
    session_id: String,
    plan: ProjectPlan,
) -> Result<i64, String> {
    commit_project_plan_impl(&state, &session_id, plan).await
}

pub async fn commit_project_plan_impl(
    state: &AppState,
    session_id: &str,
    plan: ProjectPlan,
) -> Result<i64, String> {
    let (cplan, _gid) = prepare_project_dispatch(&state.db, session_id, &plan)?;

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

    // 锚点占位消息:派工协作也要在聊天流里有挂载点,前端 get_history 才会把它映射成
    // role='collaboration' → CollaborationMessageCard hydrate 该 collab → 渲染队友实时发言。
    // 放养/intake/私聊派发都 upsert 占位,唯独"开工"这条之前漏了 → 开工后页面静默看不到队友干活。
    let mention = member_names
        .iter()
        .map(|n| format!("@{n}"))
        .collect::<Vec<_>>()
        .join(" ");
    let _ = state.db.upsert_collaboration_message(
        session_id,
        collab_id,
        &format!("🛠️ 开工 —— {mention} 按方案并行推进中…"),
    );
    Ok(collab_id)
}

#[cfg(all(test, feature = "test-support"))]
mod tests {
    use super::*;
    use crate::engine::collaboration::project::ProjectTask;
    use crate::engine::db::NewCompanion;
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
        let (cplan, got_gid) = prepare_project_dispatch(&db, "sess", &plan).unwrap();
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
        assert!(prepare_project_dispatch(&db, "solo", &plan).is_err());
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
        assert!(prepare_project_dispatch(&db, "sess", &plan).is_err());
    }
}
