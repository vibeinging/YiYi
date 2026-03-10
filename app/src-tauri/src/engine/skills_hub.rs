//! Skills Hub client - search and install skills from multiple marketplaces.
//!
//! Supported sources:
//! - ClawHub (default: https://clawhub.ai)
//! - skills.sh (GitHub wrapper)
//! - GitHub repositories (any repo with SKILL.md)
//! - Custom hub instances

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
}

impl Default for HubConfig {
    fn default() -> Self {
        Self {
            base_url: "https://clawhub.ai".into(),
            search_path: "/api/v1/search".into(),
            detail_path: "/api/v1/skills/{slug}".into(),
            file_path: "/api/v1/skills/{slug}/file".into(),
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

/// HTTP client with retry support
fn make_client() -> Client {
    Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("yiclaw-skills-hub/1.0")
        .build()
        .unwrap_or_default()
}

/// Search skills from hub
pub async fn search_hub_skills(
    query: &str,
    limit: usize,
    config: &HubConfig,
) -> Result<Vec<HubSkill>, String> {
    let client = make_client();
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
            Some(HubSkill {
                name: item["name"]
                    .as_str()
                    .or_else(|| item["displayName"].as_str())
                    .unwrap_or(&slug)
                    .to_string(),
                slug,
                description: item["description"]
                    .as_str()
                    .or_else(|| item["summary"].as_str())
                    .unwrap_or("")
                    .to_string(),
                version: item["version"].as_str().map(String::from),
                source_url: item["url"].as_str().map(String::from),
                author: item["author"].as_str().map(String::from),
                tags: item["tags"].as_array().map(|arr| {
                    arr.iter().filter_map(|v| v.as_str().map(String::from)).collect()
                }),
            })
        })
        .collect())
}

fn normalize_search_items(data: &serde_json::Value) -> Vec<serde_json::Value> {
    if let Some(arr) = data.as_array() {
        return arr.clone();
    }
    if let Some(obj) = data.as_object() {
        for key in ["items", "skills", "results", "data"] {
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
    let client = make_client();

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
    let client = make_client();
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

/// Fetch skill from ClawHub
async fn fetch_from_clawhub(
    slug: &str,
    version: Option<&str>,
    config: &HubConfig,
) -> Result<(SkillBundle, String), String> {
    if slug.is_empty() {
        return Err("Slug is required for ClawHub install".into());
    }

    let client = make_client();
    let url = format!(
        "{}{}",
        config.base_url.trim_end_matches('/'),
        config.detail_path.replace("{slug}", slug)
    );

    let resp = client
        .get(&url)
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

    // Extract skill info
    let skill = data.get("skill").unwrap_or(&data);
    let name = skill["displayName"]
        .as_str()
        .or_else(|| skill["name"].as_str())
        .unwrap_or(slug)
        .to_string();

    // Fetch files
    let mut files = HashMap::new();

    // Get file list from version data
    let version_data = data.get("version").unwrap_or(&data);
    let files_meta = version_data.get("files").and_then(|f| f.as_array());

    if let Some(files_meta) = files_meta {
        let file_url = format!(
            "{}{}",
            config.base_url.trim_end_matches('/'),
            config.file_path.replace("{slug}", slug)
        );

        for file_item in files_meta {
            if let Some(path) = file_item["path"].as_str() {
                let mut query = vec![("path", path.to_string())];
                if let Some(v) = version {
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

    // If no SKILL.md, try to construct from content field
    if !files.contains_key("SKILL.md") {
        if let Some(content) = skill["content"].as_str().or_else(|| data["content"].as_str()) {
            files.insert("SKILL.md".into(), content.to_string());
        }
    }

    if files.is_empty() {
        return Err("No skill files found from ClawHub".into());
    }

    Ok((SkillBundle { name, files }, url))
}

/// Fetch bundle from direct URL
async fn fetch_bundle_direct(url: &str) -> Result<(SkillBundle, String), String> {
    let client = make_client();

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

/// Create skill from bundle
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
        let file_path = if path == "SKILL.md" {
            skill_dir.join("SKILL.md")
        } else if path.starts_with("references/") {
            skill_dir.join(path)
        } else if path.starts_with("scripts/") {
            skill_dir.join(path)
        } else {
            // Unknown path, skip
            continue;
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

/// Get default hub config from environment
pub fn get_default_hub_config() -> HubConfig {
    HubConfig {
        base_url: std::env::var("YICLAW_SKILLS_HUB_BASE_URL")
            .unwrap_or_else(|_| "https://clawhub.ai".into()),
        search_path: std::env::var("YICLAW_SKILLS_HUB_SEARCH_PATH")
            .unwrap_or_else(|_| "/api/v1/search".into()),
        detail_path: std::env::var("YICLAW_SKILLS_HUB_DETAIL_PATH")
            .unwrap_or_else(|_| "/api/v1/skills/{slug}".into()),
        file_path: std::env::var("YICLAW_SKILLS_HUB_FILE_PATH")
            .unwrap_or_else(|_| "/api/v1/skills/{slug}/file".into()),
    }
}
