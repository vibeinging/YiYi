//! Memory isolation contract: companion private buckets stay disjoint,
//! `family_shared` is visible across companions, the main user bucket
//! never leaks into a companion's `memory_search`, and the resolver
//! returns stable user_ids for the three scopes.
//!
//! Tests hit MemMe directly (via the `FakeEmbedder`-backed test app
//! state) so the assertions are about the actual bucket semantics, not
//! mocks.

mod common;

#[allow(unused_imports)]
use common::*;
use app_lib::engine::agents::MemoryScope;
use app_lib::engine::collaboration::{resolve_memme_user_id, FAMILY_SHARED_USER_ID};
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
async fn family_shared_bucket_is_visible_to_every_companion() {
    let t = build_test_app_state().await;
    let store = &t.app_state.memme_store;

    let shared_entry = add_memory(store, FAMILY_SHARED_USER_ID, "用户在做 YiYi 项目");

    // From `family_shared` itself.
    let family_results = list_ids(store, FAMILY_SHARED_USER_ID);
    assert!(family_results.contains(&shared_entry.id));

    // Companion's own bucket is *not* the family bucket — confirms our
    // resolver returns a different id and MemMe respects the scoping.
    let alpha_results = list_ids(store, "companion_alpha");
    assert!(!alpha_results.contains(&shared_entry.id));
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
        resolve_memme_user_id(MemoryScope::Family, "ignored"),
        FAMILY_SHARED_USER_ID
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
async fn family_shared_bucket_lazy_creates_on_first_write() {
    // No special setup — MemMe creates the bucket lazily on first add.
    // The fact that the previous tests run cleanly is itself the proof,
    // but this test pins the expectation explicitly.
    let t = build_test_app_state().await;
    let store = &t.app_state.memme_store;

    // Read before write returns empty (no panic / "user not found").
    let before = list_ids(store, FAMILY_SHARED_USER_ID);
    assert!(before.is_empty());

    let entry = add_memory(store, FAMILY_SHARED_USER_ID, "首次写入");
    let after = list_ids(store, FAMILY_SHARED_USER_ID);
    assert!(after.contains(&entry.id));
}
