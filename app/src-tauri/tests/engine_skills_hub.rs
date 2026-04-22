//! Integration tests for `engine::skills_hub`.
//!
//! Exercises the HTTP-driven public functions (`search_hub_skills`,
//! `list_hub_skills`, `install_skill_from_url`) directly against a
//! `wiremock::MockServer`. Complements `commands_skills.rs`, which
//! covers the thin command wrappers — here we drill into the module's
//! own routing and parsing.
//!
//! Deferred:
//! - `fetch_from_github` / `fetch_from_skills_sh` branches hit the real
//!   api.github.com domain (hard-coded in the module), so we only assert
//!   input-validation behavior, not the happy path.

mod common;

#[allow(unused_imports)]
use common::*;

use app_lib::engine::skills_hub::{
    install_skill_from_url, list_hub_skills, search_hub_skills, HubConfig,
};
use serde_json::json;
use serial_test::serial;
use tempfile::TempDir;
use wiremock::matchers::{method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn cfg_for(server: &MockServer) -> HubConfig {
    HubConfig {
        base_url: server.uri(),
        ..HubConfig::default()
    }
}

fn minimal_skill_md(name: &str) -> String {
    format!(
        "---\nname: {name}\ndescription: \"mocked\"\nmetadata:\n  {{\n    \"yiyi\":\n      {{\n        \"emoji\": \"X\",\n        \"requires\": {{}}\n      }}\n  }}\n---\n\n# {name}\n\nbody\n"
    )
}

// ============================================================================
// search_hub_skills
// ============================================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn skills_hub_search_parses_valid_response_with_clawhub_v1_shape() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/search"))
        .and(query_param("q", "foo"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "results": [
                {
                    "slug": "foo-tools",
                    "displayName": "Foo Tools",
                    "summary": "does foo",
                    "version": "1.2.3",
                    "tags": ["util"],
                    "owner": "octocat",
                    "requires": {"env": ["FOO_KEY"]}
                }
            ]
        })))
        .mount(&server)
        .await;

    let out = search_hub_skills("foo", 10, &cfg_for(&server))
        .await
        .expect("search ok");

    assert_eq!(out.len(), 1);
    let s = &out[0];
    assert_eq!(s.slug, "foo-tools");
    assert_eq!(s.name, "Foo Tools");
    assert_eq!(s.description, "does foo");
    assert_eq!(s.version.as_deref(), Some("1.2.3"));
    assert_eq!(
        s.tags.as_deref().map(|v| v.len()),
        Some(1),
        "tags should parse"
    );
    // Requires propagated from top-level requires block.
    let req = s.requires.as_ref().expect("requires should parse");
    assert_eq!(req.env.as_deref(), Some(&["FOO_KEY".to_string()][..]));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn skills_hub_search_handles_empty_results() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/search"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "results": [] })))
        .mount(&server)
        .await;

    let out = search_hub_skills("anything", 10, &cfg_for(&server))
        .await
        .expect("search ok");
    assert!(out.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn skills_hub_search_propagates_http_500() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/search"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;

    let err = search_hub_skills("x", 5, &cfg_for(&server)).await.unwrap_err();
    assert!(err.contains("500") || err.contains("Hub search failed"), "got: {err}");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn skills_hub_search_returns_parse_err_on_malformed_json() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/search"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string("not json")
                .insert_header("content-type", "application/json"),
        )
        .mount(&server)
        .await;

    let err = search_hub_skills("x", 5, &cfg_for(&server)).await.unwrap_err();
    assert!(
        err.to_lowercase().contains("parse") || err.contains("Failed to parse"),
        "expected parse error, got: {err}"
    );
}

// ============================================================================
// list_hub_skills — pagination
// ============================================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn skills_hub_list_parses_pagination_cursor() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/skills"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "items": [
                {"slug": "a", "displayName": "A", "summary": "a skill",
                 "latestVersion": {"version": "1.0"}}
            ],
            "nextCursor": "next-page-token"
        })))
        .mount(&server)
        .await;

    let (skills, cursor) = list_hub_skills(20, None, Some("updated"), &cfg_for(&server))
        .await
        .expect("list ok");

    assert_eq!(skills.len(), 1);
    assert_eq!(skills[0].slug, "a");
    assert_eq!(skills[0].version.as_deref(), Some("1.0"));
    assert_eq!(cursor.as_deref(), Some("next-page-token"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn skills_hub_list_empty_cursor_returns_none() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/skills"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "items": [], "nextCursor": null
        })))
        .mount(&server)
        .await;

    let (skills, cursor) = list_hub_skills(20, None, None, &cfg_for(&server))
        .await
        .expect("list ok");
    assert!(skills.is_empty());
    assert!(cursor.is_none(), "null cursor should deserialize as None");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn skills_hub_list_propagates_http_error() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/skills"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&server)
        .await;

    let err = list_hub_skills(20, None, None, &cfg_for(&server)).await.unwrap_err();
    assert!(err.contains("503") || err.contains("Hub list failed"), "got: {err}");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn skills_hub_list_passes_cursor_and_sort_as_query_params() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/skills"))
        .and(query_param("cursor", "abc"))
        .and(query_param("sort", "downloads"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "items": [], "nextCursor": null
        })))
        .mount(&server)
        .await;

    // If cursor/sort weren't forwarded, wiremock would 404 the request.
    list_hub_skills(10, Some("abc"), Some("downloads"), &cfg_for(&server))
        .await
        .expect("query params must be forwarded");
}

// ============================================================================
// install_skill_from_url
// ============================================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn skills_hub_install_rejects_non_http_url() {
    let tmp = TempDir::new().unwrap();
    let err = install_skill_from_url(
        "ftp://nope",
        None,
        false,
        false,
        tmp.path(),
        &HubConfig::default(),
    )
    .await
    .unwrap_err();
    assert!(err.to_lowercase().contains("invalid url"), "got: {err}");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn skills_hub_install_rejects_empty_url() {
    let tmp = TempDir::new().unwrap();
    let err = install_skill_from_url(
        "   ",
        None,
        false,
        false,
        tmp.path(),
        &HubConfig::default(),
    )
    .await
    .unwrap_err();
    assert!(err.to_lowercase().contains("invalid url"), "got: {err}");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn skills_hub_install_from_direct_bundle_writes_files_on_disk() {
    let server = MockServer::start().await;
    let skill_md = minimal_skill_md("direct-bundle");
    Mock::given(method("GET"))
        .and(path("/direct/foo.json"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "skill": {"name": "direct-bundle"},
            "content": skill_md,
            "files": {
                "references/helper.py": "print('x')"
            }
        })))
        .mount(&server)
        .await;

    let tmp = TempDir::new().unwrap();
    let url = format!("{}/direct/foo.json", server.uri());

    // Use default HubConfig so URL routing doesn't mistake it for ClawHub.
    let result = install_skill_from_url(
        &url,
        None,
        false,
        true,
        tmp.path(),
        &HubConfig::default(),
    )
    .await
    .expect("install ok");

    assert_eq!(result.name, "direct-bundle");
    assert!(!result.enabled); // enable=false
    assert_eq!(result.source_url, url);

    let dir = tmp.path().join("customized_skills").join("direct-bundle");
    assert!(dir.join("SKILL.md").exists(), "SKILL.md must land on disk");
    assert!(
        dir.join("references/helper.py").exists(),
        "nested files should be preserved"
    );
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn skills_hub_install_direct_bundle_network_failure_bubbles_up() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/not-there"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;

    let tmp = TempDir::new().unwrap();
    let url = format!("{}/not-there", server.uri());
    let err = install_skill_from_url(&url, None, false, false, tmp.path(), &HubConfig::default())
        .await
        .unwrap_err();
    assert!(err.contains("404") || err.contains("Bundle fetch failed"), "got: {err}");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn skills_hub_install_direct_bundle_rejects_missing_skill_md() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/no-skill-md"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "skill": {"name": "broken"}
            // no "content", no "files" — missing SKILL.md
        })))
        .mount(&server)
        .await;

    let tmp = TempDir::new().unwrap();
    let url = format!("{}/no-skill-md", server.uri());
    let err = install_skill_from_url(&url, None, false, false, tmp.path(), &HubConfig::default())
        .await
        .unwrap_err();
    assert!(err.contains("missing SKILL.md"), "got: {err}");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn skills_hub_install_via_clawhub_path_fetches_detail_then_file() {
    let server = MockServer::start().await;
    // URL matches the (overridden) ClawHub base_url → triggers fetch_from_clawhub.
    let skill_md = minimal_skill_md("hub-skill");

    // Detail endpoint returns skill + latestVersion.files.
    Mock::given(method("GET"))
        .and(path("/api/v1/skills/hub-skill"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "skill": {"slug": "hub-skill", "displayName": "Hub Skill"},
            "latestVersion": {
                "version": "2.0.0",
                "files": ["SKILL.md"]
            }
        })))
        .mount(&server)
        .await;

    // Version detail endpoint (the impl tries this first when a version is resolved).
    Mock::given(method("GET"))
        .and(path("/api/v1/skills/hub-skill/versions/2.0.0"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "version": {"files": ["SKILL.md"]}
        })))
        .mount(&server)
        .await;

    // File endpoint returns the SKILL.md body.
    Mock::given(method("GET"))
        .and(path("/api/v1/skills/hub-skill/file"))
        .and(query_param("path", "SKILL.md"))
        .respond_with(ResponseTemplate::new(200).set_body_string(skill_md.clone()))
        .mount(&server)
        .await;

    let tmp = TempDir::new().unwrap();
    let cfg = cfg_for(&server);
    // The URL must satisfy install_skill_from_url's ClawHub predicate:
    // `url.contains(&config.base_url)`. Our cfg.base_url == server.uri(),
    // so embed that and append `/skills/<slug>`.
    let url = format!("{}/skills/hub-skill", server.uri());

    let result = install_skill_from_url(&url, None, false, true, tmp.path(), &cfg)
        .await
        .expect("clawhub install ok");

    assert_eq!(result.name, "hub-skill");
    assert!(result.source_url.ends_with("/skills/hub-skill"));
    let dir = tmp.path().join("customized_skills").join("hub-skill");
    assert!(dir.join("SKILL.md").exists());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn skills_hub_install_via_clawhub_404_returns_err() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/skills/ghost"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;

    let tmp = TempDir::new().unwrap();
    let cfg = cfg_for(&server);
    let url = format!("{}/skills/ghost", server.uri());
    let err = install_skill_from_url(&url, None, false, false, tmp.path(), &cfg)
        .await
        .unwrap_err();
    assert!(err.contains("404") || err.contains("ClawHub skill not found"), "got: {err}");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn skills_hub_install_via_clawhub_falls_back_to_content_field() {
    // When no files/versions metadata is available, the impl falls back to
    // reading `content` from the detail response directly.
    let server = MockServer::start().await;
    let skill_md = minimal_skill_md("content-fallback");

    Mock::given(method("GET"))
        .and(path("/api/v1/skills/content-fallback"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "skill": {"slug": "content-fallback", "content": skill_md}
        })))
        .mount(&server)
        .await;
    // file endpoint returns 404 so fallback must kick in.
    Mock::given(method("GET"))
        .and(path("/api/v1/skills/content-fallback/file"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;

    let tmp = TempDir::new().unwrap();
    let cfg = cfg_for(&server);
    let url = format!("{}/skills/content-fallback", server.uri());

    let result = install_skill_from_url(&url, None, false, true, tmp.path(), &cfg)
        .await
        .expect("content-fallback install ok");
    assert_eq!(result.name, "content-fallback");
    let dir = tmp.path().join("customized_skills").join("content-fallback");
    assert!(dir.join("SKILL.md").exists());
}
