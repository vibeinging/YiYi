//! Memory isolation contract: companion private buckets stay disjoint,
//! each `FamilyGroup(id)` has its own `family_shared_{id}` bucket isolated
//! from other groups and from main, and the resolver returns stable
//! user_ids per scope.
//!
//! IM 心智后(本次重构):没有"全员家族" Phase A 单桶,所有家族共享桶都按
//! group_id 切片(`family_shared_<gid>`)。
//!
//! Tests hit MemMe directly (via the `FakeEmbedder`-backed test app
//! state) so the assertions are about the actual bucket semantics, not
//! mocks.

mod common;

#[allow(unused_imports)]
use common::*;
use app_lib::engine::agents::MemoryScope;
use app_lib::engine::collaboration::{family_group_bucket, resolve_memme_user_id};
use app_lib::test_support::build_test_app_state;
use serial_test::serial;
use std::collections::HashSet;

fn add_memory(
    store: &memme_core::MemoryStore,
    user_id: &str,
    content: &str,
) -> memme_core::MemoryResult {
    let opts = memme_core::AddOptions::new(user_id.to_string())
        .categories(vec!["fact".to_string()])
        .importance(0.7);
    store.add(content, opts).expect("memme add")
}

/// List all memory ids in a bucket. We use `list_traces` rather than
/// `search` because empty-query search trips MemMe's embedding layer; for
/// the isolation contract what we care about is bucket membership.
fn list_ids(store: &memme_core::MemoryStore, user_id: &str) -> HashSet<String> {
    let opts = memme_core::ListOptions::new(user_id.to_string()).limit(1000);
    store
        .list_traces(opts)
        .expect("memme list")
        .into_iter()
        .map(|m| m.id)
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn private_buckets_are_disjoint_across_companions() {
    let t = build_test_app_state().await;
    let store = &t.app_state.memme_store;

    let added_a = add_memory(store, "companion_alpha", "阿狸的代码评审笔记");
    let added_b = add_memory(store, "companion_beta", "小冰的产品判断");

    let a_results = list_ids(store, "companion_alpha");
    let b_results = list_ids(store, "companion_beta");

    assert!(a_results.contains(&added_a.id), "alpha sees own memory");
    assert!(!a_results.contains(&added_b.id), "alpha must not see beta's");
    assert!(b_results.contains(&added_b.id), "beta sees own memory");
    assert!(!b_results.contains(&added_a.id), "beta must not see alpha's");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn family_group_buckets_are_isolated_across_groups_and_from_privates() {
    // 每个 group 独占一个 `family_shared_<gid>` 桶。两个不同 group 写各自桶,
    // 互不可见;companion 私桶也看不到 group 桶。
    let t = build_test_app_state().await;
    let store = &t.app_state.memme_store;

    let group_a_bucket = family_group_bucket(1);
    let group_b_bucket = family_group_bucket(2);

    let entry_a = add_memory(store, &group_a_bucket, "群 A 的项目共识");
    let entry_b = add_memory(store, &group_b_bucket, "群 B 的产品路线");

    // group A 只看到自己的。
    let a_results = list_ids(store, &group_a_bucket);
    assert!(a_results.contains(&entry_a.id), "group A 看自己的桶");
    assert!(!a_results.contains(&entry_b.id), "group A 不该看到 group B");

    // group B 同理。
    let b_results = list_ids(store, &group_b_bucket);
    assert!(b_results.contains(&entry_b.id));
    assert!(!b_results.contains(&entry_a.id));

    // companion 私桶也看不到任何 group 桶。
    let alpha = list_ids(store, "companion_alpha");
    assert!(!alpha.contains(&entry_a.id));
    assert!(!alpha.contains(&entry_b.id));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn shared_scope_resolves_to_default_user_bucket() {
    let t = build_test_app_state().await;
    let store = &t.app_state.memme_store;

    let main_entry = add_memory(store, "yiyi_default_user", "用户的事实记忆");

    // Main bucket sees it.
    let main_results = list_ids(store, "yiyi_default_user");
    assert!(main_results.contains(&main_entry.id));

    // Companion private bucket does NOT — privileged bucket is opt-in.
    let alpha_results = list_ids(store, "companion_alpha");
    assert!(!alpha_results.contains(&main_entry.id));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn resolver_returns_stable_user_ids_per_scope() {
    // Resolver is a pure function — covered by unit tests in
    // collaboration::mod.rs. Re-asserting here ensures the integration
    // surface (the constants Phase 2A.16 reads) hasn't drifted.
    assert_eq!(
        resolve_memme_user_id(MemoryScope::Private, "companion_42"),
        "companion_42"
    );
    assert_eq!(
        resolve_memme_user_id(MemoryScope::Shared, "ignored"),
        "yiyi_default_user"
    );
    assert_eq!(
        resolve_memme_user_id(MemoryScope::FamilyGroup(7), "ignored"),
        "family_shared_7"
    );
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn many_companion_buckets_remain_isolated_under_concurrent_writes() {
    // Stress: 10 companions each write 3 entries. Then verify each only
    // sees its own. Catches accidental shared-state bugs in the MemMe
    // wrapper or test fixture.
    let t = build_test_app_state().await;
    let store = t.app_state.memme_store.clone();

    let mut all_handles = Vec::new();
    for i in 0..10 {
        let store = store.clone();
        all_handles.push(tokio::spawn(async move {
            let bucket = format!("companion_{i}");
            let mut ids = Vec::new();
            for k in 0..3 {
                let content = format!("companion {i} memory {k}");
                let r = add_memory(&*store, &bucket, &content);
                ids.push(r.id);
            }
            (bucket, ids)
        }));
    }

    let mut per_companion_ids = Vec::new();
    for h in all_handles {
        let (bucket, ids) = h.await.unwrap();
        per_companion_ids.push((bucket, ids));
    }

    for (bucket, own_ids) in &per_companion_ids {
        let visible = list_ids(&*store, bucket);
        for id in own_ids {
            assert!(visible.contains(id), "{bucket} should see {id}");
        }
        for (other_bucket, other_ids) in &per_companion_ids {
            if other_bucket == bucket {
                continue;
            }
            for id in other_ids {
                assert!(
                    !visible.contains(id),
                    "{bucket} must not see {other_bucket}'s {id}"
                );
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn family_group_bucket_lazy_creates_on_first_write() {
    // No special setup — MemMe creates the bucket lazily on first add.
    // 任意 group id 的桶都是按需懒建。
    let t = build_test_app_state().await;
    let store = &t.app_state.memme_store;
    let bucket = family_group_bucket(99);

    // Read before write returns empty (no panic / "user not found").
    let before = list_ids(store, &bucket);
    assert!(before.is_empty());

    let entry = add_memory(store, &bucket, "首次写入");
    let after = list_ids(store, &bucket);
    assert!(after.contains(&entry.id));
}
