//! Integration tests for the Companions CRUD layer.
//!
//! Covers: adopt / get / list_active / list_retired / update / retire /
//! hard_delete / increment_invocation / gc_retired + uniqueness invariants.

mod common;

#[allow(unused_imports)]
use common::*;
use app_lib::engine::db::{CompanionUpdate, NewCompanion};
use serial_test::serial;

fn sample_new(name: &str, mem_id: &str) -> NewCompanion {
    NewCompanion {
        name: name.into(),
        agent_definition_name: "code_reviewer".into(),
        avatar_emoji: "🦉".into(),
        color_hex: "#F97316".into(),
        persona_md_path: None,
        memory_user_id: mem_id.into(),
        metadata_json: None,
    }
}

#[test]
#[serial]
fn adopt_companion_inserts_with_defaults() {
    let t = TempDb::new();
    let db = t.db();
    let id = db.adopt_companion(&sample_new("阿狸", "companion_1")).expect("adopt");
    let c = db.get_companion(id).expect("found");
    assert_eq!(c.name, "阿狸");
    assert_eq!(c.agent_definition_name, "code_reviewer");
    assert_eq!(c.avatar_emoji, "🦉");
    assert_eq!(c.color_hex, "#F97316");
    assert!(c.persona_md_path.is_none());
    assert_eq!(c.memory_user_id, "companion_1");
    assert!(c.retired_at.is_none(), "freshly adopted companion should be active");
    assert_eq!(c.invocation_count, 0);
    assert!(c.last_used_at.is_none());
}

#[test]
#[serial]
fn duplicate_name_is_rejected() {
    let t = TempDb::new();
    let db = t.db();
    db.adopt_companion(&sample_new("阿狸", "companion_a")).expect("first");
    let dup = db.adopt_companion(&sample_new("阿狸", "companion_b"));
    assert!(dup.is_err(), "should reject duplicate name");
}

#[test]
#[serial]
fn duplicate_memory_user_id_is_rejected() {
    let t = TempDb::new();
    let db = t.db();
    db.adopt_companion(&sample_new("阿狸", "shared_id")).expect("first");
    let dup = db.adopt_companion(&sample_new("小冰", "shared_id"));
    assert!(dup.is_err(), "should reject duplicate memory_user_id");
}

#[test]
#[serial]
fn get_companion_by_name_resolves_existing() {
    let t = TempDb::new();
    let db = t.db();
    let id = db.adopt_companion(&sample_new("九尾", "companion_jiuwei")).expect("adopt");
    let by_name = db.get_companion_by_name("九尾").expect("found");
    assert_eq!(by_name.id, id);
    assert!(db.get_companion_by_name("nope").is_none());
}

#[test]
#[serial]
fn list_active_excludes_retired() {
    let t = TempDb::new();
    let db = t.db();
    let id_a = db.adopt_companion(&sample_new("a", "mem_a")).expect("a");
    let _id_b = db.adopt_companion(&sample_new("b", "mem_b")).expect("b");
    let id_c = db.adopt_companion(&sample_new("c", "mem_c")).expect("c");

    db.retire_companion(id_a).expect("retire a");

    let active = db.list_active_companions();
    let names: Vec<&str> = active.iter().map(|c| c.name.as_str()).collect();
    assert!(!names.contains(&"a"), "retired a should not be in active list");
    assert!(names.contains(&"b"));
    assert!(names.contains(&"c"));

    let retired = db.list_retired_companions();
    assert_eq!(retired.len(), 1);
    assert_eq!(retired[0].id, id_a);
    assert!(retired[0].retired_at.is_some());

    // c was the most recently adopted active companion — should be first by default.
    assert_eq!(active.first().map(|c| c.id), Some(id_c));
}

#[test]
#[serial]
fn update_companion_applies_partial_changes() {
    let t = TempDb::new();
    let db = t.db();
    let id = db.adopt_companion(&sample_new("阿狸", "mem_ali")).expect("adopt");
    let changed = db
        .update_companion(
            id,
            &CompanionUpdate {
                avatar_emoji: Some("🐰".into()),
                color_hex: Some("#3B82F6".into()),
                persona_md_path: Some(Some("/tmp/ali.md".into())),
                ..Default::default()
            },
        )
        .expect("update");
    assert!(changed);
    let c = db.get_companion(id).expect("after update");
    assert_eq!(c.avatar_emoji, "🐰");
    assert_eq!(c.color_hex, "#3B82F6");
    assert_eq!(c.persona_md_path.as_deref(), Some("/tmp/ali.md"));
    // Fields not touched stay unchanged.
    assert_eq!(c.name, "阿狸");
}

#[test]
#[serial]
fn update_companion_can_clear_persona_md_path() {
    let t = TempDb::new();
    let db = t.db();
    let id = db
        .adopt_companion(&NewCompanion {
            persona_md_path: Some("/tmp/x.md".into()),
            ..sample_new("阿狸", "mem_ali")
        })
        .expect("adopt");
    db.update_companion(
        id,
        &CompanionUpdate {
            persona_md_path: Some(None),
            ..Default::default()
        },
    )
    .expect("update");
    let c = db.get_companion(id).expect("found");
    assert!(c.persona_md_path.is_none(), "Some(None) update should clear the field");
}

#[test]
#[serial]
fn empty_update_returns_false_no_change() {
    let t = TempDb::new();
    let db = t.db();
    let id = db.adopt_companion(&sample_new("阿狸", "mem_ali")).expect("adopt");
    let changed = db.update_companion(id, &CompanionUpdate::default()).expect("update");
    assert!(!changed);
}

#[test]
#[serial]
fn retire_then_hard_delete() {
    let t = TempDb::new();
    let db = t.db();
    let id = db.adopt_companion(&sample_new("阿狸", "mem_ali")).expect("adopt");
    assert!(db.retire_companion(id).expect("retire"));
    // Retiring again is a no-op (already retired) — returns false but no error.
    assert!(!db.retire_companion(id).expect("retire 2"));
    assert!(db.hard_delete_companion(id).expect("delete"));
    assert!(db.get_companion(id).is_none());
}

#[test]
#[serial]
fn increment_invocation_bumps_count_and_last_used() {
    let t = TempDb::new();
    let db = t.db();
    let id = db.adopt_companion(&sample_new("阿狸", "mem_ali")).expect("adopt");
    let before = db.get_companion(id).unwrap();
    assert_eq!(before.invocation_count, 0);

    db.increment_companion_invocation(id).expect("inc");
    db.increment_companion_invocation(id).expect("inc 2");

    let after = db.get_companion(id).unwrap();
    assert_eq!(after.invocation_count, 2);
    assert!(after.last_used_at.is_some());
    assert!(after.last_used_at.unwrap() >= after.adopted_at);
}

#[test]
#[serial]
fn gc_retired_companions_returns_freed_memory_ids() {
    let t = TempDb::new();
    let db = t.db();
    let id_old = db.adopt_companion(&sample_new("oldie", "mem_old")).expect("a");
    let id_fresh = db.adopt_companion(&sample_new("fresh", "mem_fresh")).expect("b");

    // Manually backdate the retired_at to simulate 31 days ago for the old
    // companion, and now for the fresh one.
    db.retire_companion(id_old).expect("retire old");
    db.retire_companion(id_fresh).expect("retire fresh");
    {
        let conn = db.get_conn().expect("conn");
        let past = 31 * 86_400_000_i64;
        conn.execute(
            "UPDATE companions SET retired_at = retired_at - ?1 WHERE id = ?2",
            rusqlite::params![past, id_old],
        )
        .expect("backdate");
    }

    let freed = db.gc_retired_companions(30).expect("gc");
    assert_eq!(freed, vec!["mem_old".to_string()]);

    // old gone, fresh still there
    assert!(db.get_companion(id_old).is_none());
    assert!(db.get_companion(id_fresh).is_some());

    // Idempotent — second run returns empty.
    let again = db.gc_retired_companions(30).expect("gc 2");
    assert!(again.is_empty());
}
