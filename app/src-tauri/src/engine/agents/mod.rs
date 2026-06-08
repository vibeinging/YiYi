//! Agent definition system — load, parse, and manage AGENT.md definitions.
//!
//! Agents define persona + tool access + model selection. They reference Skills
//! for domain knowledge but are distinct from Skills.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use super::react_agent::ToolFilter;

pub mod dynamic;
pub mod persona_loader;

/// Memory isolation scope for a companion / agent.
///
/// `Private` (default) — companion writes / reads its own MemMe user_id, fully
/// isolated from other companions and the main session.
/// `Shared` — companion uses the main user's memory bucket; suitable for
/// agents that need to inherit the user's profile (e.g. desktop_operator,
/// or the host companion in a jury).
/// `Shared` — 旧"全 active companions 单一共享桶"语义,IM 心智下基本不用,保留兼容。
/// `Group(id)` — companion 写入某具名群独占的 `group_shared_{id}` 桶。
/// 一个 group 一个桶,session 1:1 绑 group(IM 心智),群内成员共享记忆。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum MemoryScope {
    #[default]
    Private,
    Shared,
    /// id = `companion_groups.id`。序列化为 `{"group": 42}`。
    Group(i64),
}

/// Parsed agent definition from AGENT.md.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentDefinition {
    pub name: String,
    pub description: String,
    /// Model preference: "fast", "default", "powerful", or a specific model ID.
    #[serde(default)]
    pub model: Option<String>,
    /// Max ReAct iterations for this agent.
    #[serde(default)]
    pub max_iterations: Option<usize>,
    /// Tool whitelist. If set, only these tools are available.
    #[serde(default)]
    pub tools: Option<Vec<String>>,
    /// Tool blacklist. If set, these tools are denied.
    #[serde(default)]
    pub disallowed_tools: Option<Vec<String>>,
    /// Skill names to auto-load into this agent's prompt.
    #[serde(default)]
    pub skills: Vec<String>,
    /// Top-level avatar emoji. Promoted to first-class for the companion
    /// system; falls back to `metadata.yiyi.emoji` if absent (so older
    /// builtin AGENT.md files keep rendering correctly).
    #[serde(default)]
    pub avatar_emoji: Option<String>,
    /// Optional path to a user-edited persona Markdown file. When set, the
    /// persona body is loaded by `persona_loader` and stitched into the
    /// system prompt prefix at runtime.
    #[serde(default)]
    pub persona_md_path: Option<PathBuf>,
    /// Memory isolation scope. Companions default to `Private` so two
    /// companions can't read each other's memories.
    #[serde(default)]
    pub memory_scope: MemoryScope,
    /// Adoption timestamp (Unix seconds). Only set for user-adopted
    /// companions; builtin agents leave this `None`. Powers the "陪了你 N 天"
    /// display in the Buddy 群 tab.
    #[serde(default)]
    pub adopted_at: Option<i64>,
    /// Frontmatter metadata (color, category, hidden, …).
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
    /// Markdown body (system prompt instructions) — parsed separately from YAML.
    #[serde(skip)]
    pub instructions: String,
    /// Source file path for debugging/editing.
    #[serde(skip)]
    pub source_path: PathBuf,
}

impl AgentDefinition {
    /// Convert this agent's tool config into a ToolFilter.
    pub fn tool_filter(&self) -> ToolFilter {
        if let Some(ref allowed) = self.tools {
            ToolFilter::Allow(allowed.clone())
        } else if let Some(ref denied) = self.disallowed_tools {
            ToolFilter::Deny(denied.clone())
        } else {
            ToolFilter::All
        }
    }

    /// Get emoji. Priority: top-level `avatar_emoji` (companion path) →
    /// legacy `metadata.yiyi.emoji` (builtin AGENT.md) → default fallback.
    pub fn emoji(&self) -> &str {
        if let Some(e) = self.avatar_emoji.as_deref() {
            if !e.is_empty() {
                return e;
            }
        }
        self.metadata
            .as_ref()
            .and_then(|m| m["yiyi"]["emoji"].as_str())
            .unwrap_or("🤖")
    }

    /// Get color from metadata.
    pub fn color(&self) -> Option<&str> {
        self.metadata
            .as_ref()
            .and_then(|m| m["yiyi"]["color"].as_str())
    }

    /// Is this a built-in agent?
    pub fn is_builtin(&self) -> bool {
        self.metadata
            .as_ref()
            .and_then(|m| m["yiyi"]["category"].as_str())
            .map(|c| c == "builtin")
            .unwrap_or(false)
    }

    /// 动态角色(G1)的权限档位字符串(coordinator/designer/builder/reviewer)。
    /// 非动态角色(内置/收养)没有这个字段 → None。用于 G3 项目分流找"协调者"牵头。
    pub fn permission_profile(&self) -> Option<&str> {
        self.metadata
            .as_ref()
            .and_then(|m| m["yiyi"]["permission_profile"].as_str())
    }

    /// Hidden agents are still loaded into the registry (so `spawn_agents`
    /// can dispatch to them by name) but are filtered out of user-facing
    /// listings such as the @-mention picker. Set `metadata.yiyi.hidden: true`
    /// in AGENT.md frontmatter to mark.
    pub fn is_hidden(&self) -> bool {
        self.metadata
            .as_ref()
            .and_then(|m| m["yiyi"]["hidden"].as_bool())
            .unwrap_or(false)
    }
}

/// Serializable summary for frontend listing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSummary {
    pub name: String,
    pub description: String,
    pub emoji: String,
    pub color: Option<String>,
    pub is_builtin: bool,
    pub model: Option<String>,
    pub tool_count: Option<usize>,
}

impl From<&AgentDefinition> for AgentSummary {
    fn from(def: &AgentDefinition) -> Self {
        Self {
            name: def.name.clone(),
            description: def.description.clone(),
            emoji: def.emoji().to_string(),
            color: def.color().map(String::from),
            is_builtin: def.is_builtin(),
            model: def.model.clone(),
            tool_count: def.tools.as_ref().map(|t| t.len()),
        }
    }
}

/// Registry of all loaded agent definitions.
pub struct AgentRegistry {
    agents: Vec<AgentDefinition>,
}

impl AgentRegistry {
    /// Load agent definitions from built-in resources and custom directory.
    pub fn load(working_dir: &Path, resource_dir: Option<&Path>) -> Self {
        let mut agents = Vec::new();

        // 1. Load built-in agents from embedded resources
        for (name, content) in BUILTIN_AGENTS {
            if let Some(def) = parse_agent_md(content, &PathBuf::from(format!("builtin:{name}"))) {
                agents.push(def);
            }
        }

        // 2. Load built-in agents from resource directory (production)
        if let Some(res) = resource_dir {
            let agents_dir = res.join("agents");
            load_from_dir_sync(&agents_dir, &mut agents);
        }

        // 3. Load custom agents from ~/.yiyi/agents/ (can override built-ins)
        let custom_dir = working_dir.join("agents");
        load_from_dir_sync(&custom_dir, &mut agents);

        log::info!("AgentRegistry: loaded {} agent definitions", agents.len());
        Self { agents }
    }

    /// Get agent by name.
    pub fn get(&self, name: &str) -> Option<&AgentDefinition> {
        self.agents.iter().find(|a| a.name == name)
    }

    /// List all agents.
    pub fn list(&self) -> &[AgentDefinition] {
        &self.agents
    }

    /// Reload agents from disk.
    pub fn reload(&mut self, working_dir: &Path, resource_dir: Option<&Path>) {
        *self = Self::load(working_dir, resource_dir);
    }

    /// 运行时加入/替换一个 agent 定义(动态角色用 —— 不必重启即可被执行器解析到)。
    /// 同名替换(与 `load_from_dir_sync` 的覆盖语义一致)。
    pub fn upsert(&mut self, def: AgentDefinition) {
        self.agents.retain(|a| a.name != def.name);
        self.agents.push(def);
    }
}

/// Load AGENT.md files from a directory (synchronous, for startup).
fn load_from_dir_sync(dir: &Path, agents: &mut Vec<AgentDefinition>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let agent_md = if path.is_dir() {
            path.join("AGENT.md")
        } else if path.extension().map_or(false, |e| e == "md") {
            path.clone()
        } else {
            continue;
        };

        if let Ok(content) = std::fs::read_to_string(&agent_md) {
            if let Some(def) = parse_agent_md(&content, &agent_md) {
                // Custom agents override built-ins with the same name
                agents.retain(|a| a.name != def.name);
                agents.push(def);
            }
        }
    }
}

/// Parse AGENT.md content (YAML frontmatter + Markdown body).
/// Uses `\n---` as delimiter to avoid false splits on `---` within YAML values.
pub fn parse_agent_md(content: &str, source: &Path) -> Option<AgentDefinition> {
    let trimmed = content.trim();
    if !trimmed.starts_with("---") {
        return None;
    }
    // Find closing `---` on its own line (after the opening one)
    let rest = &trimmed[3..];
    let end = rest.find("\n---").map(|i| i + 1)?; // +1 to skip the \n
    let frontmatter = &rest[..end - 1]; // exclude the \n before ---
    let body = rest[end + 3..].trim(); // skip past the closing ---

    let mut def: AgentDefinition = match serde_yaml::from_str(frontmatter) {
        Ok(d) => d,
        Err(e) => {
            log::warn!("Failed to parse AGENT.md at {}: {e}", source.display());
            return None;
        }
    };
    def.instructions = body.to_string();
    def.source_path = source.to_path_buf();
    Some(def)
}

// ═══════════════════════════════════════════════════════════════════════
// Built-in agent definitions (embedded in binary)
// ═══════════════════════════════════════════════════════════════════════

const BUILTIN_AGENTS: &[(&str, &str)] = &[
    ("explore", include_str!("../../../agents/explore/AGENT.md")),
    ("desktop_operator", include_str!("../../../agents/desktop_operator/AGENT.md")),
    // Phase 1 companion role templates — referenced by AdoptModal's role
    // presets and resolved by spawn_tools when a companion's
    // agent_definition_name matches. All marked hidden so they don't leak
    // into the @-mention picker as standalone agents.
    ("code_reviewer", include_str!("../../../agents/code_reviewer/AGENT.md")),
    ("product_strategist", include_str!("../../../agents/product_strategist/AGENT.md")),
    ("life_coach", include_str!("../../../agents/life_coach/AGENT.md")),
    // S1 软件公司角色包 —— 一键成团收养这五个,组成"软件公司"群。工具白名单
    // 经 F2 在群聊执行器里真生效(PM 不写代码、QA 只读+跑测试…)。同样 hidden,
    // 用户经"组建软件公司团队"批量收养,不在 @-mention picker 里裸露。
    ("pm", include_str!("../../../agents/pm/AGENT.md")),
    ("ui_designer", include_str!("../../../agents/ui_designer/AGENT.md")),
    ("frontend_dev", include_str!("../../../agents/frontend_dev/AGENT.md")),
    ("backend_dev", include_str!("../../../agents/backend_dev/AGENT.md")),
    ("qa_engineer", include_str!("../../../agents/qa_engineer/AGENT.md")),
];

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn agent_registry_loads_all_builtin_agents() {
        let tmp = TempDir::new().unwrap();
        let registry = AgentRegistry::load(tmp.path(), None);
        let names: Vec<&str> = registry.list().iter().map(|a| a.name.as_str()).collect();
        for expected in ["explore", "desktop_operator"] {
            assert!(
                names.contains(&expected),
                "expected builtin agent '{}' to be registered, got: {:?}",
                expected,
                names
            );
        }
        // Removed agents must NOT load — the include_str! list shouldn't
        // grow back without an explicit decision.
        for removed in ["planner", "memory_curator", "bot_coordinator"] {
            assert!(
                registry.get(removed).is_none(),
                "agent '{}' was removed; should not be in registry",
                removed
            );
        }
    }

    #[test]
    fn builtin_agents_are_hidden_from_user_listing() {
        let tmp = TempDir::new().unwrap();
        let registry = AgentRegistry::load(tmp.path(), None);
        // Internal helpers (explore / desktop_operator) and companion role
        // templates (code_reviewer / product_strategist / life_coach) all
        // hide from @-mention; users interact with them only via Buddy >
        // 群 > 收养, not by spawning them as raw agents.
        for name in [
            "explore",
            "desktop_operator",
            "code_reviewer",
            "product_strategist",
            "life_coach",
        ] {
            let a = registry.get(name).expect("agent registered");
            assert!(a.is_hidden(), "{name} should be hidden from @-mention picker");
            assert!(matches!(a.tool_filter(), ToolFilter::Allow(_)));
        }
    }

    #[test]
    fn sw_company_roles_load_with_distinct_permissions() {
        // S1:五个软件公司角色都能加载、都用工具白名单(经 F2 在群聊里真生效)。
        let tmp = TempDir::new().unwrap();
        let registry = AgentRegistry::load(tmp.path(), None);
        for name in ["pm", "ui_designer", "frontend_dev", "backend_dev", "qa_engineer"] {
            let a = registry.get(name).unwrap_or_else(|| panic!("{name} 应在 registry"));
            assert!(a.is_hidden(), "{name} 应对 @-mention 隐藏(经成团收养)");
            assert!(matches!(a.tool_filter(), ToolFilter::Allow(_)), "{name} 应用白名单");
        }

        // 权限真分明 —— 这是 F2+S1 的核心:角色各司其职。
        let pm = registry.get("pm").unwrap().tool_filter();
        assert!(pm.is_allowed("ask_user"), "PM 能问用户");
        assert!(!pm.is_allowed("write_file"), "PM 不写代码");
        assert!(!pm.is_allowed("execute_shell"), "PM 不跑命令");

        let ui = registry.get("ui_designer").unwrap().tool_filter();
        assert!(ui.is_allowed("ask_user"), "UI 能和用户确认设计");
        assert!(ui.is_allowed("write_file"), "UI 能写设计稿");
        assert!(!ui.is_allowed("execute_shell"), "UI 不跑命令");

        let fe = registry.get("frontend_dev").unwrap().tool_filter();
        assert!(fe.is_allowed("write_file") && fe.is_allowed("execute_shell"), "前端能写能跑");
        assert!(!fe.is_allowed("ask_user"), "前端不直接打扰用户(回 PM)");

        let be = registry.get("backend_dev").unwrap().tool_filter();
        assert!(be.is_allowed("execute_shell") && be.is_allowed("run_python"), "后端能跑服务/脚本");
        assert!(!be.is_allowed("ask_user"), "后端不直接打扰用户");

        let qa = registry.get("qa_engineer").unwrap().tool_filter();
        assert!(qa.is_allowed("execute_shell"), "QA 能跑测试");
        assert!(!qa.is_allowed("ask_user"), "QA 不直接打扰用户");
        // QA 的步数上限取它自己的(14),比闲聊默认 6 高。
        assert_eq!(registry.get("qa_engineer").unwrap().max_iterations, Some(14));
    }

    #[test]
    fn upsert_adds_and_replaces_dynamic_role() {
        use super::dynamic::{PermissionProfile, RoleSpec};
        let tmp = TempDir::new().unwrap();
        let mut registry = AgentRegistry::load(tmp.path(), None);
        let before = registry.list().len();
        assert!(registry.get("audio_engineer").is_none());

        let spec = RoleSpec {
            slug: "audio_engineer".into(),
            name: "音频工程师".into(),
            description: "音频".into(),
            emoji: "🎧".into(),
            color: "#22D3EE".into(),
            profile: PermissionProfile::Builder,
            persona: "你是音频工程师。".into(),
        };
        registry.upsert(spec.to_agent_def());
        assert_eq!(registry.list().len(), before + 1, "新动态角色应入册");
        let def = registry.get("audio_engineer").expect("可解析");
        assert!(matches!(def.tool_filter(), ToolFilter::Allow(_)));
        assert_eq!(def.max_iterations, Some(20));

        // 同名 upsert 替换,不重复入册。
        let mut spec2 = spec.clone();
        spec2.profile = PermissionProfile::Coordinator;
        registry.upsert(spec2.to_agent_def());
        assert_eq!(registry.list().len(), before + 1, "同名应替换而非新增");
        assert_eq!(
            registry.get("audio_engineer").unwrap().max_iterations,
            Some(10),
            "替换为协调档,步数应变 10"
        );
    }

    #[test]
    fn memory_scope_defaults_to_private_when_field_missing() {
        let md = r#"---
name: minimal
description: "no memory_scope field"
---
body
"#;
        let def = parse_agent_md(md, Path::new("memory:test")).expect("parses");
        assert_eq!(def.memory_scope, MemoryScope::Private);
    }

    #[test]
    fn memory_scope_parses_shared_variant() {
        let shared = r#"---
name: with_shared
description: "x"
memory_scope: shared
---
"#;
        let def = parse_agent_md(shared, Path::new("memory:test")).expect("shared parses");
        assert_eq!(def.memory_scope, MemoryScope::Shared);
    }

    #[test]
    fn memory_scope_parses_family_variant_deprecated_falls_back() {
        // `memory_scope: family` 是 Phase A 全员群遗留写法。IM 心智后
        // Family 变体已删,带这个字段的 agent.md 应当 parse 失败(返回 None);
        // 上层 loader 会跳过、记 warning,这是预期的"明显失败优于静默吃掉"。
        let family = r#"---
name: with_family
description: "x"
memory_scope: family
---
"#;
        assert!(
            parse_agent_md(family, Path::new("memory:test")).is_none(),
            "deprecated memory_scope: family 应使整个 agent.md 解析失败"
        );
    }

    #[test]
    fn top_level_avatar_emoji_wins_over_metadata_yiyi_emoji() {
        let md = r#"---
name: dual_emoji
description: "x"
avatar_emoji: "🦉"
metadata:
  yiyi:
    emoji: "🤖"
---
"#;
        let def = parse_agent_md(md, Path::new("memory:test")).expect("parses");
        assert_eq!(def.emoji(), "🦉");
    }

    #[test]
    fn legacy_metadata_emoji_still_works_when_avatar_emoji_absent() {
        // Mirrors the on-disk builtin AGENT.md format prior to v2.
        let md = r#"---
name: legacy
description: "x"
metadata:
  yiyi:
    emoji: "🔍"
---
"#;
        let def = parse_agent_md(md, Path::new("memory:test")).expect("parses");
        assert!(def.avatar_emoji.is_none());
        assert_eq!(def.emoji(), "🔍");
    }

    #[test]
    fn companion_fields_round_trip_through_yaml() {
        let md = r#"---
name: companion_one
description: "毒舌评审员"
avatar_emoji: "🦉"
persona_md_path: "/tmp/personas/companion_one.md"
memory_scope: private
adopted_at: 1747000000
---
你是阿狸。
"#;
        let def = parse_agent_md(md, Path::new("memory:test")).expect("parses");
        assert_eq!(def.avatar_emoji.as_deref(), Some("🦉"));
        assert_eq!(
            def.persona_md_path.as_deref().map(|p| p.to_string_lossy().to_string()),
            Some("/tmp/personas/companion_one.md".to_string())
        );
        assert_eq!(def.memory_scope, MemoryScope::Private);
        assert_eq!(def.adopted_at, Some(1747000000));
        assert_eq!(def.instructions, "你是阿狸。");
    }

    #[test]
    fn existing_builtin_agents_remain_parseable_with_new_fields() {
        // Defensive: the v2 field additions must not break either of the
        // two builtin AGENT.md files. They omit every new field so they
        // should all land on defaults.
        let tmp = TempDir::new().unwrap();
        let registry = AgentRegistry::load(tmp.path(), None);
        for name in ["explore", "desktop_operator"] {
            let a = registry.get(name).expect("registered");
            assert!(a.avatar_emoji.is_none(), "{name} should not set top-level avatar_emoji");
            assert!(a.persona_md_path.is_none());
            assert_eq!(a.memory_scope, MemoryScope::Private);
            assert!(a.adopted_at.is_none());
            // The metadata emoji fallback must still resolve.
            assert!(!a.emoji().is_empty() && a.emoji() != "🤖");
        }
    }
}
