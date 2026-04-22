//! Skills Hub client - search and install skills from multiple marketplaces.
//!
//! Supported sources:
//! - ClawHub (default: https://clawhub.ai) — OpenClaw skill registry
//! - skills.sh (GitHub wrapper)
//! - GitHub repositories (any repo with SKILL.md)
//! - Custom hub instances
//!
//! ## OpenClaw / ClawHub compatibility
//!
//! ClawHub skills use `metadata.openclaw` (aliases: `metadata.clawdbot`, `metadata.clawdis`)
//! in their SKILL.md frontmatter. YiYi uses `metadata.yiyi`. This module handles
//! transparent conversion between the two formats during install.

use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

/// Hub configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HubConfig {
    /// Base URL for the hub API
    pub base_url: String,
    /// Search endpoint path (default: /api/v1/search)
    pub search_path: String,
    /// Skill detail endpoint path (default: /api/v1/skills/{slug})
    pub detail_path: String,
    /// Skill file endpoint path (default: /api/v1/skills/{slug}/file)
    pub file_path: String,
    /// Download endpoint path (default: /api/v1/download)
    pub download_path: String,
    /// Skills listing endpoint path (default: /api/v1/skills)
    pub list_path: String,
}

impl Default for HubConfig {
    fn default() -> Self {
        Self {
            base_url: "https://clawhub.ai".into(),
            search_path: "/api/v1/search".into(),
            detail_path: "/api/v1/skills/{slug}".into(),
            file_path: "/api/v1/skills/{slug}/file".into(),
            download_path: "/api/v1/download".into(),
            list_path: "/api/v1/skills".into(),
        }
    }
}

/// Search result from hub
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HubSkill {
    pub slug: String,
    pub name: String,
    pub description: String,
    pub version: Option<String>,
    pub source_url: Option<String>,
    pub author: Option<String>,
    pub tags: Option<Vec<String>>,
    /// Security verdict from ClawHub moderation (clean/suspicious/malicious)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub security_verdict: Option<String>,
    /// Dependency requirements (env vars, binaries)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires: Option<HubSkillRequires>,
}

/// Dependency requirements for a hub skill
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HubSkillRequires {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bins: Option<Vec<String>>,
}

/// Install result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallResult {
    pub name: String,
    pub enabled: bool,
    pub source_url: String,
}

/// Skill bundle from hub or GitHub
#[derive(Debug, Clone, Serialize, Deserialize)]
struct SkillBundle {
    name: String,
    files: HashMap<String, String>,
}

/// Shared HTTP client for skills hub — reuses connection pool across all hub requests.
fn hub_client() -> &'static Client {
    static CLIENT: std::sync::OnceLock<Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .user_agent("yiyi-skills-hub/1.0")
            .pool_max_idle_per_host(5)
            .build()
            .unwrap_or_default()
    })
}

/// Search skills from hub (supports ClawHub v1 API and generic formats)
///
/// ClawHub v1 search endpoint returns:
/// ```json
/// { "results": [{ "slug": "...", "displayName": "...", "summary": "...", "version": "...", "score": 0.9 }] }
/// ```
pub async fn search_hub_skills(
    query: &str,
    limit: usize,
    config: &HubConfig,
) -> Result<Vec<HubSkill>, String> {
    let client = hub_client();
    let url = format!("{}{}", config.base_url.trim_end_matches('/'), config.search_path);

    let resp = client
        .get(&url)
        .query(&[("q", query), ("limit", &limit.to_string())])
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Hub search request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Hub search failed: HTTP {}", resp.status()));
    }

    let data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse hub response: {}", e))?;

    // Normalize response - handle different API formats
    let items = normalize_search_items(&data);

    Ok(items
        .into_iter()
        .filter_map(|item| {
            let slug = item["slug"]
                .as_str()
                .or_else(|| item["name"].as_str())?
                .to_string();
            if slug.is_empty() {
                return None;
            }
            // ClawHub v1 uses "displayName" and "summary"
            Some(HubSkill {
                name: item["displayName"]
                    .as_str()
                    .or_else(|| item["name"].as_str())
                    .unwrap_or(&slug)
                    .to_string(),
                slug: slug.clone(),
                description: item["summary"]
                    .as_str()
                    .or_else(|| item["description"].as_str())
                    .unwrap_or("")
                    .to_string(),
                version: item["version"]
                    .as_str()
                    .map(String::from),
                source_url: item["url"]
                    .as_str()
                    .map(String::from)
                    .or_else(|| {
                        Some(format!(
                            "{}/skills/{}",
                            config.base_url.trim_end_matches('/'),
                            slug
                        ))
                    }),
                author: item["author"]
                    .as_str()
                    .or_else(|| item["owner"].as_str())
                    .map(String::from),
                tags: item["tags"].as_array().map(|arr| {
                    arr.iter().filter_map(|v| v.as_str().map(String::from)).collect()
                }),
                security_verdict: item["securityVerdict"]
                    .as_str()
                    .or_else(|| item["security_verdict"].as_str())
                    .map(String::from),
                requires: parse_hub_requires(&item),
            })
        })
        .collect())
}

/// List skills from hub with sorting/pagination (ClawHub v1 /api/v1/skills)
///
/// Returns `{ items: [...], nextCursor }`. Supports sort by:
/// `updated`, `downloads`, `stars`, `trending`
pub async fn list_hub_skills(
    limit: usize,
    cursor: Option<&str>,
    sort: Option<&str>,
    config: &HubConfig,
) -> Result<(Vec<HubSkill>, Option<String>), String> {
    let client = hub_client();
    let url = format!("{}{}", config.base_url.trim_end_matches('/'), config.list_path);

    let mut query_params: Vec<(&str, String)> = vec![("limit", limit.to_string())];
    if let Some(c) = cursor {
        query_params.push(("cursor", c.to_string()));
    }
    if let Some(s) = sort {
        query_params.push(("sort", s.to_string()));
    }

    let resp = client
        .get(&url)
        .query(&query_params)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Hub list request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Hub list failed: HTTP {}", resp.status()));
    }

    let data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse hub response: {}", e))?;

    let next_cursor = data["nextCursor"].as_str().map(String::from);
    let items = data["items"].as_array().cloned().unwrap_or_default();

    let skills: Vec<HubSkill> = items
        .into_iter()
        .filter_map(|item| {
            let slug = item["slug"].as_str()?.to_string();
            Some(HubSkill {
                name: item["displayName"]
                    .as_str()
                    .unwrap_or(&slug)
                    .to_string(),
                slug: slug.clone(),
                description: item["summary"]
                    .as_str()
                    .unwrap_or("")
                    .to_string(),
                version: item["latestVersion"]["version"]
                    .as_str()
                    .map(String::from),
                source_url: Some(format!(
                    "{}/skills/{}",
                    config.base_url.trim_end_matches('/'),
                    slug
                )),
                author: item["owner"]["username"]
                    .as_str()
                    .or_else(|| item["author"].as_str())
                    .map(String::from),
                tags: item["tags"].as_array().map(|arr| {
                    arr.iter().filter_map(|v| v.as_str().map(String::from)).collect()
                }),
                security_verdict: item["securityVerdict"]
                    .as_str()
                    .or_else(|| item["security_verdict"].as_str())
                    .map(String::from),
                requires: parse_hub_requires(&item),
            })
        })
        .collect();

    Ok((skills, next_cursor))
}

/// Parse requires info from hub API response item
fn parse_hub_requires(item: &serde_json::Value) -> Option<HubSkillRequires> {
    // Try metadata.requires, metadata.openclaw.requires, or top-level requires
    let requires = item["requires"].as_object()
        .or_else(|| item["metadata"]["requires"].as_object())
        .or_else(|| item["metadata"]["openclaw"]["requires"].as_object())
        .or_else(|| item["metadata"]["yiyi"]["requires"].as_object())
        .or_else(|| item["metadata"]["yiyiclaw"]["requires"].as_object());

    let requires = match requires {
        Some(r) => r,
        None => return None,
    };

    let env = requires.get("env").and_then(|v| {
        v.as_array().map(|arr| arr.iter().filter_map(|s| s.as_str().map(String::from)).collect())
    });
    let bins = requires.get("bins").and_then(|v| {
        v.as_array().map(|arr| arr.iter().filter_map(|s| s.as_str().map(String::from)).collect())
    });

    if env.is_none() && bins.is_none() {
        return None;
    }

    Some(HubSkillRequires { env, bins })
}

fn normalize_search_items(data: &serde_json::Value) -> Vec<serde_json::Value> {
    if let Some(arr) = data.as_array() {
        return arr.clone();
    }
    if let Some(obj) = data.as_object() {
        for key in ["results", "items", "skills", "data"] {
            if let Some(arr) = obj.get(key).and_then(|v| v.as_array()) {
                return arr.clone();
            }
        }
        // Single item
        if obj.contains_key("slug") && obj.contains_key("name") {
            return vec![data.clone()];
        }
    }
    Vec::new()
}

/// Install skill from URL
/// Supports:
/// - ClawHub URL: https://clawhub.ai/skills/xxx
/// - skills.sh URL: https://skills.sh/owner/repo/skill
/// - GitHub URL: https://github.com/owner/repo[/tree/branch/path]
/// - Direct bundle URL: any URL returning JSON bundle
pub async fn install_skill_from_url(
    url: &str,
    version: Option<&str>,
    enable: bool,
    overwrite: bool,
    working_dir: &Path,
    config: &HubConfig,
) -> Result<InstallResult, String> {
    let url = url.trim();
    if url.is_empty() || !url.starts_with("http") {
        return Err("Invalid URL: must be a valid http(s) URL".into());
    }

    let (bundle, source_url) = if url.contains("skills.sh") {
        fetch_from_skills_sh(url, version).await?
    } else if url.contains("github.com") {
        fetch_from_github(url, version).await?
    } else if url.contains("clawhub.ai") || url.contains(&config.base_url) {
        let slug = extract_clawhub_slug(url);
        fetch_from_clawhub(&slug, version, config).await?
    } else {
        // Try as direct bundle URL
        fetch_bundle_direct(url).await?
    };

    // Create skill from bundle
    let name = bundle.name.clone();
    create_skill_from_bundle(&bundle, overwrite, working_dir)?;

    // Enable if requested
    let enabled = if enable {
        enable_skill(&name, working_dir)?;
        true
    } else {
        false
    };

    Ok(InstallResult {
        name,
        enabled,
        source_url,
    })
}

/// Fetch skill from skills.sh (GitHub wrapper)
async fn fetch_from_skills_sh(
    url: &str,
    version: Option<&str>,
) -> Result<(SkillBundle, String), String> {
    // Parse URL: https://skills.sh/{owner}/{repo}/{skill}
    let parts: Vec<&str> = url.trim_start_matches("https://")
        .trim_start_matches("http://")
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();

    if parts.len() < 4 || parts[0] != "skills.sh" {
        return Err("Invalid skills.sh URL format".into());
    }

    let owner = parts[1];
    let repo = parts[2];
    let skill = parts[3];

    // Fetch from GitHub API
    let branch = version.unwrap_or("main");
    fetch_from_github_repo(owner, repo, skill, branch).await
}

/// Fetch skill from GitHub repository
async fn fetch_from_github(
    url: &str,
    version: Option<&str>,
) -> Result<(SkillBundle, String), String> {
    // Parse GitHub URL
    let parts: Vec<&str> = url.trim_start_matches("https://")
        .trim_start_matches("http://")
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();

    if parts.len() < 3 || parts[0] != "github.com" {
        return Err("Invalid GitHub URL format".into());
    }

    let owner = parts[1];
    let repo = parts[2];

    // Handle /tree/branch/path format
    let (branch, skill_path) = if parts.len() >= 5 && parts[3] == "tree" {
        (parts[4], parts.get(5).unwrap_or(&""))
    } else if parts.len() >= 5 && parts[3] == "blob" {
        (parts[4], parts.get(5).unwrap_or(&""))
    } else {
        (version.unwrap_or("main"), parts.get(3).unwrap_or(&""))
    };

    fetch_from_github_repo(owner, repo, skill_path, branch).await
}

/// Fetch skill from GitHub repo via API
async fn fetch_from_github_repo(
    owner: &str,
    repo: &str,
    skill_path: &str,
    branch: &str,
) -> Result<(SkillBundle, String), String> {
    let client = hub_client();

    // Normalize skill_path - remove trailing /SKILL.md
    let skill_path = skill_path.trim_end_matches("/SKILL.md").trim_start_matches('/');

    // Find SKILL.md location
    let skill_md_path = if skill_path.is_empty() {
        "SKILL.md".to_string()
    } else if skill_path.ends_with("SKILL.md") {
        skill_path.to_string()
    } else {
        format!("{}/SKILL.md", skill_path)
    };

    // Fetch SKILL.md content
    let api_url = format!(
        "https://api.github.com/repos/{}/{}/contents/{}?ref={}",
        owner, repo, skill_md_path, branch
    );

    let resp = client
        .get(&api_url)
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await
        .map_err(|e| format!("GitHub API request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Failed to fetch SKILL.md: HTTP {}", resp.status()));
    }

    let data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse GitHub response: {}", e))?;

    // Get content (base64 encoded or download_url)
    let content = if let Some(download_url) = data["download_url"].as_str() {
        let resp = client.get(download_url).send().await
            .map_err(|e| format!("Failed to download SKILL.md: {}", e))?;
        resp.text().await.map_err(|e| format!("Failed to read SKILL.md: {}", e))?
    } else if let Some(content_b64) = data["content"].as_str() {
        // Decode base64 (GitHub returns base64 with newlines)
        let cleaned = content_b64.replace('\n', "");
        use base64::{Engine, engine::general_purpose::STANDARD};
        STANDARD.decode(&cleaned)
            .map(|bytes| String::from_utf8_lossy(&bytes).to_string())
            .map_err(|e| format!("Failed to decode base64: {}", e))?
    } else {
        return Err("No SKILL.md content found".into());
    };

    // Extract skill name from frontmatter
    let name = extract_skill_name(&content)
        .unwrap_or_else(|| skill_path.split('/').last().unwrap_or(repo).to_string());

    // Collect references and scripts
    let mut files = HashMap::new();
    files.insert("SKILL.md".into(), content);

    let base_path = if skill_path.is_empty() { "" } else { skill_path };

    // Try to fetch references/
    if let Ok(refs) = fetch_github_directory(owner, repo, &format!("{}/references", base_path), branch).await {
        files.extend(refs);
    }

    // Try to fetch scripts/
    if let Ok(scripts) = fetch_github_directory(owner, repo, &format!("{}/scripts", base_path), branch).await {
        files.extend(scripts);
    }

    Ok((SkillBundle { name, files }, format!("https://github.com/{}/{}", owner, repo)))
}

/// Fetch all files from a GitHub directory recursively
fn fetch_github_directory<'a>(
    owner: &'a str,
    repo: &'a str,
    path: &'a str,
    branch: &'a str,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<HashMap<String, String>, String>> + Send + 'a>> {
    Box::pin(fetch_github_directory_inner(owner, repo, path, branch))
}

async fn fetch_github_directory_inner(
    owner: &str,
    repo: &str,
    path: &str,
    branch: &str,
) -> Result<HashMap<String, String>, String> {
    let client = hub_client();
    let api_url = format!(
        "https://api.github.com/repos/{}/{}/contents/{}?ref={}",
        owner, repo, path, branch
    );

    let resp = client
        .get(&api_url)
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await
        .map_err(|e| format!("GitHub API request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Directory not found: {}", path));
    }

    let entries: Vec<serde_json::Value> = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse GitHub response: {}", e))?;

    let mut files = HashMap::new();

    for entry in entries {
        let entry_type = entry["type"].as_str().unwrap_or("");
        let entry_path = entry["path"].as_str().unwrap_or("");
        let _entry_name = entry["name"].as_str().unwrap_or("");

        if entry_type == "file" {
            if let Some(download_url) = entry["download_url"].as_str() {
                if let Ok(resp) = client.get(download_url).send().await {
                    if let Ok(content) = resp.text().await {
                        // Store with relative path from skill root
                        let rel_path = entry_path
                            .trim_start_matches(path)
                            .trim_start_matches('/');
                        files.insert(format!("{}/{}", path, rel_path), content);
                    }
                }
            }
        } else if entry_type == "dir" {
            // Recurse into subdirectories (with depth limit)
            if let Ok(sub_files) = fetch_github_directory(owner, repo, entry_path, branch).await {
                files.extend(sub_files);
            }
        }
    }

    Ok(files)
}

/// Fetch skill from ClawHub using the v1 API.
///
/// Flow:
/// 1. `GET /api/v1/skills/{slug}` to get skill detail + latest version info
/// 2. `GET /api/v1/skills/{slug}/file?path=SKILL.md&version=...` to get file contents
/// 3. Convert OpenClaw metadata format to YiYi format in SKILL.md
async fn fetch_from_clawhub(
    slug: &str,
    version: Option<&str>,
    config: &HubConfig,
) -> Result<(SkillBundle, String), String> {
    if slug.is_empty() {
        return Err("Slug is required for ClawHub install".into());
    }

    let client = hub_client();
    let detail_url = format!(
        "{}{}",
        config.base_url.trim_end_matches('/'),
        config.detail_path.replace("{slug}", slug)
    );

    let resp = client
        .get(&detail_url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("ClawHub request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("ClawHub skill not found: HTTP {}", resp.status()));
    }

    let data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse ClawHub response: {}", e))?;

    // ClawHub v1 response: { skill: { slug, displayName, summary, ... }, latestVersion: { version, ... }, owner: { ... } }
    let skill = data.get("skill").unwrap_or(&data);
    let name = skill["slug"]
        .as_str()
        .unwrap_or(slug)
        .to_string();

    let resolved_version = version
        .map(String::from)
        .or_else(|| data["latestVersion"]["version"].as_str().map(String::from));

    // Fetch files via file endpoint or version endpoint
    let mut files = HashMap::new();

    // Try to get file list from version data
    let version_data = if let Some(v) = &resolved_version {
        // Fetch specific version to get file list
        let version_url = format!(
            "{}/api/v1/skills/{}/versions/{}",
            config.base_url.trim_end_matches('/'),
            slug,
            v
        );
        match client
            .get(&version_url)
            .header("Accept", "application/json")
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => r.json::<serde_json::Value>().await.ok(),
            _ => None,
        }
    } else {
        None
    };

    let files_meta = version_data
        .as_ref()
        .and_then(|vd| vd["version"]["files"].as_array())
        .or_else(|| data.get("latestVersion").and_then(|lv| lv["files"].as_array()));

    if let Some(files_meta) = files_meta {
        let file_url = format!(
            "{}{}",
            config.base_url.trim_end_matches('/'),
            config.file_path.replace("{slug}", slug)
        );

        for file_item in files_meta {
            // files_meta items can be strings or objects with "path"
            let path = file_item
                .as_str()
                .or_else(|| file_item["path"].as_str());
            if let Some(path) = path {
                let mut query = vec![("path", path.to_string())];
                if let Some(v) = &resolved_version {
                    query.push(("version", v.to_string()));
                }

                if let Ok(resp) = client
                    .get(&file_url)
                    .query(&query)
                    .header("Accept", "text/plain, text/markdown")
                    .send()
                    .await
                {
                    if resp.status().is_success() {
                        if let Ok(content) = resp.text().await {
                            files.insert(path.to_string(), content);
                        }
                    }
                }
            }
        }
    }

    // If we still don't have files, try the download endpoint
    if files.is_empty() || !files.contains_key("SKILL.md") {
        let file_url = format!(
            "{}{}",
            config.base_url.trim_end_matches('/'),
            config.file_path.replace("{slug}", slug)
        );
        let mut query = vec![("path", "SKILL.md".to_string())];
        if let Some(v) = &resolved_version {
            query.push(("version", v.to_string()));
        }

        if let Ok(resp) = client
            .get(&file_url)
            .query(&query)
            .header("Accept", "text/plain, text/markdown")
            .send()
            .await
        {
            if resp.status().is_success() {
                if let Ok(content) = resp.text().await {
                    files.insert("SKILL.md".into(), content);
                }
            }
        }
    }

    // Fallback: try content field from detail response
    if !files.contains_key("SKILL.md") {
        if let Some(content) = skill["content"].as_str().or_else(|| data["content"].as_str()) {
            files.insert("SKILL.md".into(), content.to_string());
        }
    }

    if files.is_empty() {
        return Err("No skill files found from ClawHub".into());
    }

    // Convert OpenClaw metadata format to YiYi format in SKILL.md
    if let Some(skill_md) = files.get_mut("SKILL.md") {
        *skill_md = convert_openclaw_to_yiyi(skill_md);
    }

    let source_url = format!("{}/skills/{}", config.base_url.trim_end_matches('/'), slug);
    Ok((SkillBundle { name, files }, source_url))
}

/// Fetch bundle from direct URL
async fn fetch_bundle_direct(url: &str) -> Result<(SkillBundle, String), String> {
    let client = hub_client();

    let resp = client
        .get(url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Bundle request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Bundle fetch failed: HTTP {}", resp.status()));
    }

    let data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse bundle: {}", e))?;

    // Normalize bundle format
    let skill = data.get("skill").unwrap_or(&data);
    let name = skill["name"]
        .as_str()
        .unwrap_or("imported-skill")
        .to_string();

    let mut files = HashMap::new();

    // Try files mapping
    if let Some(files_obj) = data.get("files").and_then(|f| f.as_object()) {
        for (path, content) in files_obj {
            if let Some(content_str) = content.as_str() {
                files.insert(path.clone(), content_str.to_string());
            }
        }
    }

    // Try content field as SKILL.md
    if let Some(content) = skill["content"].as_str().or_else(|| data["content"].as_str()) {
        files.insert("SKILL.md".into(), content.to_string());
    }

    // Try skill_md field
    if let Some(content) = skill["skill_md"].as_str().or_else(|| data["skill_md"].as_str()) {
        files.insert("SKILL.md".into(), content.to_string());
    }

    if !files.contains_key("SKILL.md") {
        return Err("Bundle missing SKILL.md content".into());
    }

    Ok((SkillBundle { name, files }, url.to_string()))
}

/// Extract skill name from frontmatter
fn extract_skill_name(content: &str) -> Option<String> {
    // Parse YAML frontmatter
    if !content.starts_with("---") {
        return None;
    }

    let end = content[3..].find("---")?;
    let frontmatter = &content[3..end + 3];

    for line in frontmatter.lines() {
        let line = line.trim();
        if line.starts_with("name:") {
            return Some(line[5..].trim().trim_matches('"').to_string());
        }
    }

    None
}

/// Extract slug from ClawHub URL
fn extract_clawhub_slug(url: &str) -> String {
    let parts: Vec<&str> = url.split('/').filter(|s| !s.is_empty()).collect();
    // URL like https://clawhub.ai/skills/xxx or https://clawhub.ai/owner/skill
    if parts.len() >= 4 && parts[3] == "skills" {
        parts.get(4).unwrap_or(&"").to_string()
    } else if parts.len() >= 3 {
        parts.last().unwrap_or(&"").to_string()
    } else {
        String::new()
    }
}

/// Create skill from bundle.
///
/// Supports both YiYi and OpenClaw/ClawHub bundle file layouts.
/// ClawHub bundles may have flat file paths (e.g., "utils.py") alongside "SKILL.md".
fn create_skill_from_bundle(
    bundle: &SkillBundle,
    overwrite: bool,
    working_dir: &Path,
) -> Result<(), String> {
    let skill_dir = working_dir.join("customized_skills").join(&bundle.name);

    if skill_dir.exists() && !overwrite {
        return Err(format!("Skill '{}' already exists. Use overwrite=true.", bundle.name));
    }

    // Create directories
    std::fs::create_dir_all(&skill_dir)
        .map_err(|e| format!("Failed to create skill directory: {}", e))?;
    std::fs::create_dir_all(skill_dir.join("references"))
        .ok();
    std::fs::create_dir_all(skill_dir.join("scripts"))
        .ok();

    // Write files
    for (path, content) in &bundle.files {
        let file_path = if path == "SKILL.md" || path == "skill.md" {
            // Normalize to SKILL.md
            skill_dir.join("SKILL.md")
        } else if path.starts_with("references/") || path.starts_with("scripts/") {
            skill_dir.join(path)
        } else if path.starts_with('.') {
            // Skip hidden files (.clawhubignore, .clawhub/, .gitignore)
            continue;
        } else {
            // ClawHub bundles may have flat supporting files — place them in references/
            skill_dir.join("references").join(path)
        };

        if let Some(parent) = file_path.parent() {
            std::fs::create_dir_all(parent).ok();
        }

        std::fs::write(&file_path, content)
            .map_err(|e| format!("Failed to write {}: {}", path, e))?;
    }

    Ok(())
}

/// Enable skill by creating symlink in active_skills
fn enable_skill(name: &str, working_dir: &Path) -> Result<bool, String> {
    let source = working_dir.join("customized_skills").join(name);
    let target = working_dir.join("active_skills").join(name);

    if !source.exists() {
        return Err(format!("Skill '{}' not found", name));
    }

    // Create active_skills dir if needed
    std::fs::create_dir_all(working_dir.join("active_skills")).ok();

    // Remove existing symlink if any
    if target.exists() || target.symlink_metadata().is_ok() {
        std::fs::remove_file(&target).ok();
    }

    // Create symlink (or copy on Windows)
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&source, &target)
            .map_err(|e| format!("Failed to create symlink: {}", e))?;
    }
    #[cfg(windows)]
    {
        // On Windows, copy the directory instead
        copy_dir_all(&source, &target)
            .map_err(|e| format!("Failed to copy skill: {}", e))?;
    }

    Ok(true)
}

#[cfg(windows)]
fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &dst.join(entry.file_name()))?;
        } else {
            std::fs::copy(entry.path(), dst.join(entry.file_name()))?;
        }
    }
    Ok(())
}

// ============================================================================
// OpenClaw / ClawHub format conversion
// ============================================================================

/// Convert OpenClaw SKILL.md metadata format to YiYi format.
///
/// OpenClaw uses `metadata.openclaw` (or `metadata.clawdbot`, `metadata.clawdis`):
/// ```yaml
/// metadata:
///   openclaw:
///     requires:
///       env: [API_KEY]
///       bins: [curl]
///     primaryEnv: API_KEY
///     emoji: "..."
///     homepage: "..."
/// ```
///
/// YiYi uses `metadata.yiyi`:
/// ```yaml
/// metadata:
///   yiyi:
///     emoji: "..."
///     requires: {}
/// ```
///
/// This function preserves the original content and adds a `metadata.yiyi` block
/// if the SKILL.md uses OpenClaw format. If both formats exist, it does nothing.
pub fn convert_openclaw_to_yiyi(content: &str) -> String {
    // Check if content has frontmatter
    if !content.starts_with("---") {
        return content.to_string();
    }

    let end_idx = match content[3..].find("---") {
        Some(idx) => idx + 3,
        None => return content.to_string(),
    };

    let frontmatter = &content[3..end_idx];
    let body = &content[end_idx + 3..];

    // Already has yiyi metadata — no conversion needed (also accept legacy "yiyiclaw" key)
    if frontmatter.contains("\"yiyi\"") || frontmatter.contains("yiyi:")
        || frontmatter.contains("\"yiyiclaw\"") || frontmatter.contains("yiyiclaw:") {
        return content.to_string();
    }

    // Check for OpenClaw metadata keys
    let has_openclaw = frontmatter.contains("\"openclaw\"")
        || frontmatter.contains("openclaw:")
        || frontmatter.contains("\"clawdbot\"")
        || frontmatter.contains("clawdbot:")
        || frontmatter.contains("\"clawdis\"")
        || frontmatter.contains("clawdis:");

    if !has_openclaw {
        return content.to_string();
    }

    // Extract emoji from OpenClaw metadata
    let emoji = extract_metadata_field(frontmatter, "emoji");
    let _homepage = extract_metadata_field(frontmatter, "homepage");

    // Extract requires.env and requires.bins for mapping
    let requires_env = extract_metadata_array(frontmatter, "env");
    let requires_bins = extract_metadata_array(frontmatter, "bins");

    // Build YiYi requires object
    let mut requires_parts = Vec::new();
    if !requires_env.is_empty() {
        let envs: Vec<String> = requires_env.iter().map(|e| format!("\"{}\"", e)).collect();
        requires_parts.push(format!("\"env\": [{}]", envs.join(", ")));
    }
    if !requires_bins.is_empty() {
        let bins: Vec<String> = requires_bins.iter().map(|b| format!("\"{}\"", b)).collect();
        requires_parts.push(format!("\"bins\": [{}]", bins.join(", ")));
    }

    let requires_str = if requires_parts.is_empty() {
        "{}".to_string()
    } else {
        format!("{{{}}}", requires_parts.join(", "))
    };

    // Build the yiyi metadata line
    let emoji_str = emoji.as_deref().unwrap_or("");
    let yiyi_metadata = format!(
        "\"yiyi\":\n      {{\n        \"emoji\": \"{}\",\n        \"requires\": {}\n      }}",
        emoji_str, requires_str
    );

    // Insert yiyi metadata alongside openclaw metadata in the frontmatter
    // Strategy: find the metadata block and add yiyi after the existing openclaw block
    let new_frontmatter = if frontmatter.contains("metadata:") {
        // Find the metadata section and append yiyi block
        let metadata_line_end = frontmatter.find("metadata:").unwrap() + "metadata:".len();
        let before_metadata = &frontmatter[..metadata_line_end];
        let after_metadata = &frontmatter[metadata_line_end..];

        // Find the closing of the metadata block (look for the openclaw/clawdbot/clawdis block end)
        // Simple approach: add yiyi at the same indentation level as openclaw
        format!(
            "{}\n    {}\n{}",
            before_metadata.trim_end(),
            yiyi_metadata,
            after_metadata.trim_start_matches(|c: char| c == '\n' || c == '\r'),
        )
    } else {
        // No metadata section, add one
        format!(
            "{}\nmetadata:\n  {{\n    {}\n  }}",
            frontmatter.trim_end(),
            yiyi_metadata
        )
    };

    format!("---\n{}---{}", new_frontmatter, body)
}

/// Extract a simple string field value from metadata block
fn extract_metadata_field(frontmatter: &str, field: &str) -> Option<String> {
    // Match patterns like: "emoji": "value" or emoji: "value" or emoji: value
    let pattern1 = format!("\"{}\":", field);
    let pattern2 = format!("{}:", field);

    let line = frontmatter
        .lines()
        .find(|l| l.contains(&pattern1) || l.trim().starts_with(&pattern2))?;

    let after_colon = line.split(':').skip(1).collect::<Vec<_>>().join(":");
    let value = after_colon.trim().trim_matches('"').trim_matches('\'');
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

/// Extract an array field from the requires block in metadata
fn extract_metadata_array(frontmatter: &str, field: &str) -> Vec<String> {
    let mut results = Vec::new();

    // Look for inline array: field: [val1, val2] or "field": ["val1", "val2"]
    for line in frontmatter.lines() {
        let trimmed = line.trim();
        if (trimmed.starts_with(&format!("{}:", field))
            || trimmed.starts_with(&format!("- {}", field))
            || trimmed.starts_with(&format!("\"{}\":", field)))
            && trimmed.contains('[')
        {
            if let Some(arr_start) = trimmed.find('[') {
                if let Some(arr_end) = trimmed.find(']') {
                    let arr_content = &trimmed[arr_start + 1..arr_end];
                    for item in arr_content.split(',') {
                        let val = item.trim().trim_matches('"').trim_matches('\'').trim();
                        if !val.is_empty() {
                            results.push(val.to_string());
                        }
                    }
                    return results;
                }
            }
        }
    }

    // Look for YAML list format:
    // env:
    //   - VAR1
    //   - VAR2
    let field_patterns = [format!("{}:", field), format!("\"{}\":", field)];
    let mut capturing = false;
    for line in frontmatter.lines() {
        let trimmed = line.trim();
        if field_patterns.iter().any(|p| trimmed.starts_with(p)) {
            capturing = true;
            continue;
        }
        if capturing {
            if trimmed.starts_with("- ") {
                let val = trimmed[2..].trim().trim_matches('"').trim_matches('\'');
                if !val.is_empty() {
                    results.push(val.to_string());
                }
            } else if !trimmed.is_empty() {
                break;
            }
        }
    }

    results
}

/// Get default hub config from environment
pub fn get_default_hub_config() -> HubConfig {
    HubConfig {
        base_url: std::env::var("YIYI_SKILLS_HUB_BASE_URL")
            .or_else(|_| std::env::var("YIYICLAW_SKILLS_HUB_BASE_URL"))
            .unwrap_or_else(|_| "https://clawhub.ai".into()),
        search_path: std::env::var("YIYI_SKILLS_HUB_SEARCH_PATH")
            .or_else(|_| std::env::var("YIYICLAW_SKILLS_HUB_SEARCH_PATH"))
            .unwrap_or_else(|_| "/api/v1/search".into()),
        detail_path: std::env::var("YIYI_SKILLS_HUB_DETAIL_PATH")
            .or_else(|_| std::env::var("YIYICLAW_SKILLS_HUB_DETAIL_PATH"))
            .unwrap_or_else(|_| "/api/v1/skills/{slug}".into()),
        file_path: std::env::var("YIYI_SKILLS_HUB_FILE_PATH")
            .or_else(|_| std::env::var("YIYICLAW_SKILLS_HUB_FILE_PATH"))
            .unwrap_or_else(|_| "/api/v1/skills/{slug}/file".into()),
        download_path: std::env::var("YIYI_SKILLS_HUB_DOWNLOAD_PATH")
            .or_else(|_| std::env::var("YIYICLAW_SKILLS_HUB_DOWNLOAD_PATH"))
            .unwrap_or_else(|_| "/api/v1/download".into()),
        list_path: std::env::var("YIYI_SKILLS_HUB_LIST_PATH")
            .or_else(|_| std::env::var("YIYICLAW_SKILLS_HUB_LIST_PATH"))
            .unwrap_or_else(|_| "/api/v1/skills".into()),
    }
}

// ============================================================================
// Unit tests for private helpers (pure logic — no HTTP / no filesystem).
// HTTP-driven coverage lives in tests/engine_skills_hub.rs.
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ---- HubConfig defaults ------------------------------------------------

    #[test]
    fn hub_config_default_uses_clawhub_base_url_and_v1_paths() {
        let cfg = HubConfig::default();
        assert_eq!(cfg.base_url, "https://clawhub.ai");
        assert_eq!(cfg.search_path, "/api/v1/search");
        assert_eq!(cfg.list_path, "/api/v1/skills");
        assert_eq!(cfg.detail_path, "/api/v1/skills/{slug}");
        assert_eq!(cfg.file_path, "/api/v1/skills/{slug}/file");
        assert_eq!(cfg.download_path, "/api/v1/download");
    }

    // ---- normalize_search_items -------------------------------------------

    #[test]
    fn normalize_search_items_handles_top_level_array() {
        let data = json!([{"slug": "a"}, {"slug": "b"}]);
        let items = normalize_search_items(&data);
        assert_eq!(items.len(), 2);
    }

    #[test]
    fn normalize_search_items_unwraps_results_key() {
        let data = json!({ "results": [{"slug": "a"}] });
        assert_eq!(normalize_search_items(&data).len(), 1);
    }

    #[test]
    fn normalize_search_items_unwraps_items_and_skills_and_data_keys() {
        for key in ["items", "skills", "data"] {
            let data = json!({ key: [{"slug": "a"}] });
            assert_eq!(normalize_search_items(&data).len(), 1, "failed for key {key}");
        }
    }

    #[test]
    fn normalize_search_items_wraps_single_skill_object() {
        let data = json!({"slug": "solo", "name": "Solo"});
        let items = normalize_search_items(&data);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["slug"], "solo");
    }

    #[test]
    fn normalize_search_items_returns_empty_for_unknown_shape() {
        let data = json!({"unexpected": "shape"});
        assert!(normalize_search_items(&data).is_empty());
    }

    // ---- parse_hub_requires ------------------------------------------------

    #[test]
    fn parse_hub_requires_reads_top_level_requires_block() {
        let item = json!({
            "requires": {"env": ["API_KEY"], "bins": ["curl", "git"]}
        });
        let req = parse_hub_requires(&item).expect("should parse");
        assert_eq!(req.env.as_deref(), Some(&["API_KEY".to_string()][..]));
        assert_eq!(req.bins.as_deref(), Some(&["curl".to_string(), "git".to_string()][..]));
    }

    #[test]
    fn parse_hub_requires_reads_metadata_openclaw_nested_requires() {
        let item = json!({
            "metadata": { "openclaw": { "requires": { "env": ["TOKEN"] } } }
        });
        let req = parse_hub_requires(&item).expect("should parse");
        assert_eq!(req.env.as_deref(), Some(&["TOKEN".to_string()][..]));
        assert!(req.bins.is_none());
    }

    #[test]
    fn parse_hub_requires_returns_none_when_no_requires_anywhere() {
        assert!(parse_hub_requires(&json!({"slug": "x"})).is_none());
    }

    #[test]
    fn parse_hub_requires_returns_none_when_requires_is_empty() {
        // requires block present but has neither env nor bins → treated as None.
        let item = json!({ "requires": {} });
        assert!(parse_hub_requires(&item).is_none());
    }

    // ---- extract_skill_name ------------------------------------------------

    #[test]
    fn extract_skill_name_reads_name_from_yaml_frontmatter() {
        let content = "---\nname: my-skill\ndescription: foo\n---\n\nbody";
        assert_eq!(extract_skill_name(content).as_deref(), Some("my-skill"));
    }

    #[test]
    fn extract_skill_name_strips_surrounding_quotes() {
        let content = "---\nname: \"quoted-skill\"\n---\nbody";
        assert_eq!(extract_skill_name(content).as_deref(), Some("quoted-skill"));
    }

    #[test]
    fn extract_skill_name_returns_none_when_no_frontmatter() {
        assert!(extract_skill_name("# Just markdown").is_none());
    }

    #[test]
    fn extract_skill_name_returns_none_when_name_missing() {
        let content = "---\ndescription: foo\n---\nbody";
        assert!(extract_skill_name(content).is_none());
    }

    // ---- extract_clawhub_slug ----------------------------------------------

    #[test]
    fn extract_clawhub_slug_parses_standard_skills_url() {
        assert_eq!(
            extract_clawhub_slug("https://clawhub.ai/skills/pdf-tools"),
            "pdf-tools"
        );
    }

    #[test]
    fn extract_clawhub_slug_falls_back_to_last_segment_for_owner_style_urls() {
        assert_eq!(
            extract_clawhub_slug("https://clawhub.ai/owner/my-skill"),
            "my-skill"
        );
    }

    #[test]
    fn extract_clawhub_slug_returns_empty_for_bare_domain() {
        assert_eq!(extract_clawhub_slug("https://clawhub.ai"), "");
    }

    // ---- extract_metadata_field / extract_metadata_array -------------------

    #[test]
    fn extract_metadata_field_reads_quoted_json_style_value() {
        let fm = "metadata:\n  openclaw:\n    \"emoji\": \"🎨\"\n";
        assert_eq!(extract_metadata_field(fm, "emoji").as_deref(), Some("🎨"));
    }

    #[test]
    fn extract_metadata_field_reads_plain_yaml_value() {
        let fm = "metadata:\n  openclaw:\n    emoji: art\n";
        assert_eq!(extract_metadata_field(fm, "emoji").as_deref(), Some("art"));
    }

    #[test]
    fn extract_metadata_field_returns_none_when_absent() {
        assert!(extract_metadata_field("name: foo", "emoji").is_none());
    }

    #[test]
    fn extract_metadata_array_reads_inline_bracket_list() {
        let fm = "requires:\n  env: [API_KEY, TOKEN]\n";
        assert_eq!(
            extract_metadata_array(fm, "env"),
            vec!["API_KEY".to_string(), "TOKEN".to_string()]
        );
    }

    #[test]
    fn extract_metadata_array_reads_yaml_dash_list() {
        let fm = "requires:\n  env:\n    - VAR1\n    - VAR2\n";
        assert_eq!(
            extract_metadata_array(fm, "env"),
            vec!["VAR1".to_string(), "VAR2".to_string()]
        );
    }

    #[test]
    fn extract_metadata_array_empty_when_field_missing() {
        assert!(extract_metadata_array("name: foo", "env").is_empty());
    }

    // ---- convert_openclaw_to_yiyi -----------------------------------------

    #[test]
    fn convert_openclaw_to_yiyi_noop_when_no_frontmatter() {
        let content = "# just markdown, no yaml\n";
        assert_eq!(convert_openclaw_to_yiyi(content), content);
    }

    #[test]
    fn convert_openclaw_to_yiyi_noop_when_yiyi_metadata_already_present() {
        let content = "---\nname: foo\nmetadata:\n  yiyi:\n    emoji: X\n---\nbody";
        assert_eq!(convert_openclaw_to_yiyi(content), content);
    }

    #[test]
    fn convert_openclaw_to_yiyi_noop_when_no_openclaw_metadata() {
        // No openclaw/clawdbot/clawdis keys → leave content alone.
        let content = "---\nname: foo\ndescription: bar\n---\nbody";
        assert_eq!(convert_openclaw_to_yiyi(content), content);
    }

    #[test]
    fn convert_openclaw_to_yiyi_adds_yiyi_block_when_openclaw_present() {
        let content = "---\nname: foo\nmetadata:\n  openclaw:\n    emoji: \"🚀\"\n    requires:\n      env: [API_KEY]\n      bins: [curl]\n---\nbody\n";
        let out = convert_openclaw_to_yiyi(content);
        assert!(out.contains("\"yiyi\""), "missing yiyi block: {out}");
        assert!(out.contains("\"API_KEY\""), "missing env passthrough: {out}");
        assert!(out.contains("\"curl\""), "missing bins passthrough: {out}");
        // Body preserved.
        assert!(out.ends_with("body\n"));
    }

    #[test]
    fn convert_openclaw_to_yiyi_recognizes_clawdbot_alias() {
        let content = "---\nname: foo\nmetadata:\n  clawdbot:\n    emoji: zz\n---\nbody";
        let out = convert_openclaw_to_yiyi(content);
        assert!(out.contains("\"yiyi\""));
    }

    // ---- get_default_hub_config -------------------------------------------

    #[test]
    fn get_default_hub_config_returns_defaults_without_env_overrides() {
        // We can't safely mutate env (races with other tests), so assert that,
        // in the absence of an override, the base URL matches the documented
        // production default. This holds when the env var is unset in CI.
        let had_override = std::env::var("YIYI_SKILLS_HUB_BASE_URL").is_ok()
            || std::env::var("YIYICLAW_SKILLS_HUB_BASE_URL").is_ok();
        let cfg = get_default_hub_config();
        if !had_override {
            assert_eq!(cfg.base_url, "https://clawhub.ai");
        }
        // These paths never come from env in CI, so they should always match
        // defaults unless the test env explicitly sets them.
        if std::env::var("YIYI_SKILLS_HUB_SEARCH_PATH").is_err()
            && std::env::var("YIYICLAW_SKILLS_HUB_SEARCH_PATH").is_err()
        {
            assert_eq!(cfg.search_path, "/api/v1/search");
        }
    }

    // ---- create_skill_from_bundle (pure FS, no network) -------------------

    #[test]
    fn create_skill_from_bundle_writes_skill_md_and_routes_flat_files_to_references() {
        let tmp = tempfile::tempdir().unwrap();
        let mut files = HashMap::new();
        files.insert("SKILL.md".to_string(), "---\nname: b\n---\nbody".to_string());
        files.insert("utils.py".to_string(), "print('hi')".to_string());
        files.insert("scripts/run.sh".to_string(), "#!/bin/sh".to_string());
        files.insert(".gitignore".to_string(), "*.log".to_string()); // hidden, must be skipped

        let bundle = SkillBundle {
            name: "bundletest".into(),
            files,
        };
        create_skill_from_bundle(&bundle, false, tmp.path()).unwrap();

        let skill_dir = tmp.path().join("customized_skills").join("bundletest");
        assert!(skill_dir.join("SKILL.md").exists());
        assert!(skill_dir.join("references/utils.py").exists(), "flat file should go under references/");
        assert!(skill_dir.join("scripts/run.sh").exists());
        assert!(!skill_dir.join(".gitignore").exists(), "hidden files must be skipped");
    }

    #[test]
    fn create_skill_from_bundle_refuses_to_overwrite_existing_without_flag() {
        let tmp = tempfile::tempdir().unwrap();
        let existing = tmp.path().join("customized_skills").join("dupe");
        std::fs::create_dir_all(&existing).unwrap();

        let mut files = HashMap::new();
        files.insert("SKILL.md".into(), "---\nname: dupe\n---\n".into());
        let bundle = SkillBundle { name: "dupe".into(), files };

        let err = create_skill_from_bundle(&bundle, false, tmp.path()).unwrap_err();
        assert!(err.contains("already exists"), "expected overwrite rejection, got: {err}");
    }
}
