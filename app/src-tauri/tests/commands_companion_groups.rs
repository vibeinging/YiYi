//! Companion groups (群) 的集成测试 —— 覆盖 group CRUD、多对多成员管理、
//! session 绑组、级联删除、retired 成员过滤。所有用 TempDb 隔离 + #[serial]
//! (SQLite WAL 不能并行共享)。

mod common;

#[allow(unused_imports)]
use common::*;

use app_lib::commands::companion_groups::{
    add_companion_to_group_impl, create_companion_group_impl, delete_companion_group_impl,
    get_companion_group_impl, get_session_group_impl, list_companion_groups_impl,
    list_group_members_impl, list_groups_for_companion_impl, remove_companion_from_group_impl,
    set_session_group_impl, update_companion_group_impl,
};
use app_lib::engine::db::NewCompanion;
use serial_test::serial;

fn new_companion(name: &str) -> NewCompanion {
    NewCompanion {
        name: name.into(),
        agent_definition_name: "code_reviewer".into(),
        avatar_emoji: "🦊".into(),
        color_hex: "#F97316".into(),
        persona_md_path: None,
        memory_user_id: format!("c_{name}"),
        metadata_json: None,
        role_label: Some("test".into()),
    }
}

// === group CRUD =========================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn create_group_assigns_unique_ids_and_persists_fields() {
    let t = build_test_app_state().await;
    let id1 =
        create_companion_group_impl(t.state(), "创作小队".into(), Some("📝".into()), Some("#3B82F6".into()))
            .await
            .unwrap();
    let id2 = create_companion_group_impl(t.state(), "生活帮手".into(), Some("🌿".into()), None)
        .await
        .unwrap();
    assert_ne!(id1, id2);
    let g1 = get_companion_group_impl(t.state(), id1)
        .await
        .unwrap()
        .expect("group 1 存在");
    assert_eq!(g1.name, "创作小队");
    assert_eq!(g1.emoji.as_deref(), Some("📝"));
    assert_eq!(g1.color_hex.as_deref(), Some("#3B82F6"));
    let g2 = get_companion_group_impl(t.state(), id2)
        .await
        .unwrap()
        .expect("group 2 存在");
    assert_eq!(g2.color_hex, None, "无 color_hex 时应为 None");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_companion_groups_returns_newest_first() {
    let t = build_test_app_state().await;
    let _id1 = create_companion_group_impl(t.state(), "A".into(), None, None)
        .await
        .unwrap();
    // 拉开时间戳:created_at 用毫秒,极快连续调用可能同一 ms。等一拍。
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    let id2 = create_companion_group_impl(t.state(), "B".into(), None, None)
        .await
        .unwrap();
    let groups = list_companion_groups_impl(t.state()).await.unwrap();
    assert_eq!(groups.len(), 2);
    assert_eq!(groups[0].id, id2, "newest first(按 created_at DESC)");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn update_companion_group_overwrites_fields() {
    let t = build_test_app_state().await;
    let id = create_companion_group_impl(t.state(), "Old".into(), Some("📝".into()), None)
        .await
        .unwrap();
    update_companion_group_impl(
        t.state(),
        id,
        "New".into(),
        Some("🚀".into()),
        Some("#FF0000".into()),
    )
    .await
    .unwrap();
    let g = get_companion_group_impl(t.state(), id)
        .await
        .unwrap()
        .expect("group");
    assert_eq!(g.name, "New");
    assert_eq!(g.emoji.as_deref(), Some("🚀"));
    assert_eq!(g.color_hex.as_deref(), Some("#FF0000"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn delete_companion_group_removes_row_and_cascades_members() {
    let t = build_test_app_state().await;
    let cid = t.state().db.adopt_companion(&new_companion("阿狸")).unwrap();
    let gid = create_companion_group_impl(t.state(), "Test".into(), None, None)
        .await
        .unwrap();
    add_companion_to_group_impl(t.state(), gid, cid)
        .await
        .unwrap();
    assert_eq!(
        list_group_members_impl(t.state(), gid).await.unwrap().len(),
        1
    );

    delete_companion_group_impl(t.state(), gid).await.unwrap();
    assert!(get_companion_group_impl(t.state(), gid)
        .await
        .unwrap()
        .is_none());
    // FK ON DELETE CASCADE:成员关系行也被清掉。
    assert!(list_group_members_impl(t.state(), gid)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn delete_companion_group_clears_session_binding() {
    let t = build_test_app_state().await;
    let gid = create_companion_group_impl(t.state(), "G".into(), None, None)
        .await
        .unwrap();
    t.state()
        .db
        .ensure_session("sid-x", "test", "chat", None)
        .unwrap();
    set_session_group_impl(t.state(), "sid-x".into(), Some(gid))
        .await
        .unwrap();
    assert_eq!(
        get_session_group_impl(t.state(), "sid-x".into())
            .await
            .unwrap(),
        Some(gid)
    );

    delete_companion_group_impl(t.state(), gid).await.unwrap();
    // Session 仍存在,但 group_id 被清空(回落 Phase A 隐式群)。
    assert_eq!(
        get_session_group_impl(t.state(), "sid-x".into())
            .await
            .unwrap(),
        None
    );
}

// === membership =========================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn add_remove_member_round_trips() {
    let t = build_test_app_state().await;
    let cid = t.state().db.adopt_companion(&new_companion("阿狸")).unwrap();
    let gid = create_companion_group_impl(t.state(), "G".into(), None, None)
        .await
        .unwrap();

    add_companion_to_group_impl(t.state(), gid, cid)
        .await
        .unwrap();
    let members = list_group_members_impl(t.state(), gid).await.unwrap();
    assert_eq!(members.len(), 1);
    assert_eq!(members[0].id, cid);
    assert_eq!(members[0].name, "阿狸");

    remove_companion_from_group_impl(t.state(), gid, cid)
        .await
        .unwrap();
    assert!(list_group_members_impl(t.state(), gid)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn add_member_twice_is_idempotent() {
    let t = build_test_app_state().await;
    let cid = t.state().db.adopt_companion(&new_companion("阿狸")).unwrap();
    let gid = create_companion_group_impl(t.state(), "G".into(), None, None)
        .await
        .unwrap();
    add_companion_to_group_impl(t.state(), gid, cid)
        .await
        .unwrap();
    // 第二次加同一成员 —— INSERT OR IGNORE,不报错,不重复行。
    add_companion_to_group_impl(t.state(), gid, cid)
        .await
        .unwrap();
    assert_eq!(
        list_group_members_impl(t.state(), gid).await.unwrap().len(),
        1
    );
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_group_members_excludes_retired() {
    let t = build_test_app_state().await;
    let cid_active = t.state().db.adopt_companion(&new_companion("active")).unwrap();
    let cid_retired = t.state().db.adopt_companion(&new_companion("retired")).unwrap();
    let gid = create_companion_group_impl(t.state(), "G".into(), None, None)
        .await
        .unwrap();
    add_companion_to_group_impl(t.state(), gid, cid_active)
        .await
        .unwrap();
    add_companion_to_group_impl(t.state(), gid, cid_retired)
        .await
        .unwrap();

    t.state().db.retire_companion(cid_retired).unwrap();

    let members = list_group_members_impl(t.state(), gid).await.unwrap();
    assert_eq!(members.len(), 1, "retired 成员应被过滤");
    assert_eq!(members[0].id, cid_active);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn companion_can_belong_to_multiple_groups() {
    // 多对多:这是 IM 群聊心智的核心。
    let t = build_test_app_state().await;
    let cid = t.state().db.adopt_companion(&new_companion("阿橘")).unwrap();
    let gid1 = create_companion_group_impl(t.state(), "生活帮手".into(), None, None)
        .await
        .unwrap();
    let gid2 = create_companion_group_impl(t.state(), "运动训练".into(), None, None)
        .await
        .unwrap();
    let _gid3 = create_companion_group_impl(t.state(), "代码评审组".into(), None, None)
        .await
        .unwrap();
    add_companion_to_group_impl(t.state(), gid1, cid)
        .await
        .unwrap();
    add_companion_to_group_impl(t.state(), gid2, cid)
        .await
        .unwrap();

    let groups = list_groups_for_companion_impl(t.state(), cid).await.unwrap();
    let names: Vec<String> = groups.iter().map(|g| g.name.clone()).collect();
    assert_eq!(groups.len(), 2);
    assert!(names.contains(&"生活帮手".to_string()));
    assert!(names.contains(&"运动训练".to_string()));
    assert!(!names.contains(&"代码评审组".to_string()), "不该列出未加入的组");
}

// === session binding ===================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn session_group_binding_round_trips() {
    let t = build_test_app_state().await;
    t.state()
        .db
        .ensure_session("sid", "n", "chat", None)
        .unwrap();
    let gid = create_companion_group_impl(t.state(), "G".into(), None, None)
        .await
        .unwrap();

    // 默认 None。
    assert_eq!(
        get_session_group_impl(t.state(), "sid".into())
            .await
            .unwrap(),
        None
    );
    // 绑定 → 读回。
    set_session_group_impl(t.state(), "sid".into(), Some(gid))
        .await
        .unwrap();
    assert_eq!(
        get_session_group_impl(t.state(), "sid".into())
            .await
            .unwrap(),
        Some(gid)
    );
    // 解绑(传 None) → 读回 None。
    set_session_group_impl(t.state(), "sid".into(), None)
        .await
        .unwrap();
    assert_eq!(
        get_session_group_impl(t.state(), "sid".into())
            .await
            .unwrap(),
        None
    );
}
