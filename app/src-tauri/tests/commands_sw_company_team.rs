//! Integration test for S1 一键成团:`adopt_software_company_team_impl`。
//! 验证:批量收养 5 个软件公司角色 → 建"软件公司"群 → 5 个成员入群 →
//! 各角色 agent_definition_name 正确、persona 落库(群聊执行器据此注入人设)。

mod common;

#[allow(unused_imports)]
use common::*;
use app_lib::commands::companions::adopt_software_company_team_impl;
use app_lib::test_support::build_test_app_state;
use serial_test::serial;

#[tokio::test]
#[serial]
async fn adopt_team_creates_five_roles_in_a_group() {
    let t = build_test_app_state().await;
    let state = t.state();

    let group_id = adopt_software_company_team_impl(state)
        .await
        .expect("一键成团应成功");

    // 群里恰好 5 个成员。
    let members = state.db.list_group_members(group_id);
    assert_eq!(members.len(), 5, "软件公司群应有 5 个角色");

    // 五个角色都在,agent_definition_name 正确(F2 据此解析权限)。
    let slugs: Vec<&str> = members.iter().map(|c| c.agent_definition_name.as_str()).collect();
    for role in ["pm", "ui_designer", "frontend_dev", "backend_dev", "qa_engineer"] {
        assert!(slugs.contains(&role), "缺角色 {role}");
    }

    // 每个角色 persona 都落了库(companions/<id>/persona.md),群聊才能注入人设。
    assert!(
        members.iter().all(|c| c.persona_md_path.is_some()),
        "每个角色都应有 persona_md_path"
    );

    // role_label 填了(UI 上显示「擅长」)。
    assert!(members.iter().all(|c| c.role_label.is_some()));

    // S2 步骤①:团队群分到隔离项目工作区,目录已建出来(用户可见、可拿走代码)。
    let group = state.db.get_companion_group(group_id).expect("软件公司群应存在");
    let ws = group.workspace_path.expect("软件公司群应有项目工作区");
    assert!(
        std::path::Path::new(&ws).is_dir(),
        "项目工作区目录应已建: {ws}"
    );
    assert!(ws.contains("projects"), "工作区应在 projects/ 下: {ws}");
}

#[tokio::test]
#[serial]
async fn adopt_team_twice_avoids_name_collision() {
    let t = build_test_app_state().await;
    let state = t.state();

    // companions.name 全局唯一:连续成团两次不该因重名硬失败,自动加序号。
    let g1 = adopt_software_company_team_impl(state).await.expect("第一次成团");
    let g2 = adopt_software_company_team_impl(state).await.expect("第二次成团应自动避重名");
    assert_ne!(g1, g2, "两次应是不同的群");

    assert_eq!(state.db.list_group_members(g1).len(), 5);
    assert_eq!(state.db.list_group_members(g2).len(), 5);
}
