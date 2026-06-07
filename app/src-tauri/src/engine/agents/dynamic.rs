//! 动态角色定义(G1)—— 让"角色"能在运行时产生,而不只编译期固化的 `BUILTIN_AGENTS`。
//!
//! 这是 G2「agent 自生成团队」的地基:生成器产出 [`RoleSpec`] → 用户审阅 → 落地成
//! companion。本模块只管"角色规格 → 可注册的 [`AgentDefinition`] + 落盘",不碰生成/UI。
//!
//! **安全核心**:动态角色**不能自由配工具**,只能从几档**预设权限档位**
//! ([`PermissionProfile`])里选。每档绑定一组取自软件公司 5 角色(经 F2 在群聊里真生效、
//! 已验证)的真实工具白名单 —— 杜绝生成器给某个角色乱开 `execute_shell` 全权。
//!
//! 持久化复用现有机制:落 `~/.yiyi/agents/<slug>/AGENT.md`,`AgentRegistry::load` 启动时
//! 自动读回(见 mod.rs 的 `load_from_dir_sync`);运行时再 `upsert` 进 registry 即可不重启用。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use super::{AgentDefinition, MemoryScope};

/// 动态角色的安全权限档位。映射到 `ToolFilter::Allow(白名单)`,不暴露自由工具集。
///
/// 四档对应软件公司里验证过的四类角色形态。新增档位时,工具名必须是 catalog 里真实存在的
/// 工具(见各内置角色 AGENT.md 的 `tools:`),否则该工具直接拿不到。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionProfile {
    /// 协调/规划型(PM 式):问用户、读、查、记忆;**不写不跑**。
    Coordinator,
    /// 设计/文档型(UI 式):问用户、读写文件(设计稿/文档)、查资料;**不跑命令**。
    Designer,
    /// 开发型(前后端式):全套文件工具 + 跑命令/脚本;**不直接问用户**(疑问回协调者)。
    Builder,
    /// 测试/评审型(QA 式):读 + 跑命令(测试)+ 写测试;**不直接问用户**。
    Reviewer,
}

impl PermissionProfile {
    /// 该档位的工具白名单。全部为真实工具名(取自软件公司 5 角色已验证的集合)。
    pub fn tools(&self) -> Vec<String> {
        let names: &[&str] = match self {
            Self::Coordinator => &[
                "ask_user", "read_file", "list_directory", "project_tree", "grep_search",
                "web_search", "memory_search", "memory_add",
            ],
            Self::Designer => &[
                "ask_user", "read_file", "write_file", "edit_file", "list_directory",
                "web_search", "browser_fetch", "memory_search", "memory_add",
            ],
            Self::Builder => &[
                "read_file", "write_file", "edit_file", "append_file", "list_directory",
                "grep_search", "glob_search", "project_tree", "execute_shell", "run_python",
                "run_python_script", "pip_install", "web_search", "memory_search", "memory_add",
            ],
            Self::Reviewer => &[
                "read_file", "list_directory", "grep_search", "glob_search", "project_tree",
                "execute_shell", "write_file", "memory_search", "memory_add",
            ],
        };
        names.iter().map(|s| s.to_string()).collect()
    }

    /// 该档位默认 ReAct 步数上限(对齐软件公司同类角色)。
    pub fn max_iterations(&self) -> usize {
        match self {
            Self::Coordinator | Self::Designer => 10,
            Self::Builder => 20,
            Self::Reviewer => 14,
        }
    }

    /// 该档位能否跑命令 —— 给审阅卡标"⚠️ 可执行命令"用,提醒用户这是高权限角色。
    pub fn can_execute(&self) -> bool {
        matches!(self, Self::Builder | Self::Reviewer)
    }

    /// 中文档位名(前端审阅卡显示)。
    pub fn label(&self) -> &'static str {
        match self {
            Self::Coordinator => "协调规划",
            Self::Designer => "设计文档",
            Self::Builder => "开发",
            Self::Reviewer => "测试评审",
        }
    }

    /// snake_case 串(落 AGENT.md metadata 用)。
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Coordinator => "coordinator",
            Self::Designer => "designer",
            Self::Builder => "builder",
            Self::Reviewer => "reviewer",
        }
    }
}

/// 一个待落地的角色规格(G2 生成器产出、用户审阅、再落地为 companion)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoleSpec {
    /// agent_definition slug —— 注册名,英文小写下划线(如 `audio_engineer`)。
    pub slug: String,
    /// 中文显示名(如"音频工程师")。
    pub name: String,
    /// 一句话职责。
    pub description: String,
    pub emoji: String,
    pub color: String,
    pub profile: PermissionProfile,
    /// 人设 / 系统提示词(写进 AGENT.md body,执行器据此注入人设)。
    pub persona: String,
}

impl RoleSpec {
    /// 转成可 `upsert` 进 registry 的 [`AgentDefinition`]。
    /// tools 取档位白名单;metadata 标 `dynamic_role`(category)+ `hidden`(不进 @-mention picker)。
    pub fn to_agent_def(&self) -> AgentDefinition {
        AgentDefinition {
            name: self.slug.clone(),
            description: self.description.clone(),
            model: Some("default".to_string()),
            max_iterations: Some(self.profile.max_iterations()),
            tools: Some(self.profile.tools()),
            disallowed_tools: None,
            skills: Vec::new(),
            avatar_emoji: Some(self.emoji.clone()),
            persona_md_path: None,
            memory_scope: MemoryScope::Private,
            adopted_at: None,
            metadata: Some(serde_json::json!({
                "yiyi": {
                    "color": self.color,
                    "category": "dynamic_role",
                    "hidden": true,
                    "permission_profile": self.profile.as_str(),
                }
            })),
            instructions: self.persona.clone(),
            source_path: PathBuf::from(format!("dynamic:{}", self.slug)),
        }
    }
}

/// 把动态角色落成 `~/.yiyi/agents/<slug>/AGENT.md`,使其在重启后仍被 registry 读回。
/// 返回写入的文件路径。
pub fn persist_role_agent_md(working_dir: &Path, spec: &RoleSpec) -> std::io::Result<PathBuf> {
    let dir = working_dir.join("agents").join(&spec.slug);
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("AGENT.md");

    let tools_yaml = spec
        .profile
        .tools()
        .iter()
        .map(|t| format!("  - {t}"))
        .collect::<Vec<_>>()
        .join("\n");

    // description / emoji / color 用 {:?}(YAML 兼容的双引号转义),避免名字含冒号/引号破坏 frontmatter。
    let content = format!(
        "---\n\
         name: {slug}\n\
         description: {desc:?}\n\
         model: default\n\
         max_iterations: {iter}\n\
         tools:\n{tools}\n\
         avatar_emoji: {emoji:?}\n\
         metadata:\n  yiyi:\n    color: {color:?}\n    category: dynamic_role\n    hidden: true\n    permission_profile: {profile:?}\n\
         ---\n{persona}\n",
        slug = spec.slug,
        desc = spec.description,
        iter = spec.profile.max_iterations(),
        tools = tools_yaml,
        emoji = spec.emoji,
        color = spec.color,
        profile = spec.profile.as_str(),
        persona = spec.persona,
    );
    std::fs::write(&path, content)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::react_agent::ToolFilter;

    fn sample(profile: PermissionProfile) -> RoleSpec {
        RoleSpec {
            slug: "audio_engineer".to_string(),
            name: "音频工程师".to_string(),
            description: "处理音频采集与降噪".to_string(),
            emoji: "🎧".to_string(),
            color: "#22D3EE".to_string(),
            profile,
            persona: "你是资深音频工程师,专注实时音频管线。".to_string(),
        }
    }

    #[test]
    fn profiles_only_use_real_catalog_tools() {
        // 防止档位里写出 catalog 不存在的工具(那样该工具直接拿不到,等于白名单写废)。
        // 这里的"真实工具名"集合 = 软件公司 5 角色 AGENT.md 用到的并集。
        let real: &[&str] = &[
            "ask_user", "propose_project_plan", "read_file", "write_file", "edit_file",
            "append_file", "list_directory", "project_tree", "grep_search", "glob_search",
            "execute_shell", "run_python", "run_python_script", "pip_install", "web_search",
            "browser_fetch", "memory_search", "memory_add",
        ];
        for p in [
            PermissionProfile::Coordinator,
            PermissionProfile::Designer,
            PermissionProfile::Builder,
            PermissionProfile::Reviewer,
        ] {
            for t in p.tools() {
                assert!(real.contains(&t.as_str()), "档位 {:?} 含未知工具 {t}", p);
            }
        }
    }

    #[test]
    fn profile_execute_gating_matches_can_execute() {
        // can_execute 必须和白名单里有没有 execute_shell 一致(审阅卡的"可执行命令"标记靠它)。
        for p in [
            PermissionProfile::Coordinator,
            PermissionProfile::Designer,
            PermissionProfile::Builder,
            PermissionProfile::Reviewer,
        ] {
            let has_shell = p.tools().iter().any(|t| t == "execute_shell");
            assert_eq!(p.can_execute(), has_shell, "{:?} can_execute 与白名单不一致", p);
        }
        // 协调/设计型绝不能跑命令(安全红线)。
        assert!(!PermissionProfile::Coordinator.can_execute());
        assert!(!PermissionProfile::Designer.can_execute());
    }

    #[test]
    fn to_agent_def_maps_profile_to_whitelist_and_iter() {
        let def = sample(PermissionProfile::Builder).to_agent_def();
        assert_eq!(def.name, "audio_engineer");
        assert_eq!(def.max_iterations, Some(20));
        // tool_filter 必须是白名单 = 档位工具集。
        match def.tool_filter() {
            ToolFilter::Allow(list) => {
                assert!(list.contains(&"execute_shell".to_string()), "Builder 应能跑命令");
                assert!(list.contains(&"write_file".to_string()));
                assert!(!list.contains(&"ask_user".to_string()), "Builder 不直接问用户");
            }
            other => panic!("应为 Allow 白名单,得到 {other:?}"),
        }
        // hidden + emoji + persona 注入。
        assert!(def.is_hidden(), "动态角色应对 @-mention 隐藏");
        assert_eq!(def.emoji(), "🎧");
        assert_eq!(def.instructions, "你是资深音频工程师,专注实时音频管线。");
    }

    #[test]
    fn coordinator_cannot_write_or_run() {
        let def = sample(PermissionProfile::Coordinator).to_agent_def();
        let f = def.tool_filter();
        assert!(f.is_allowed("ask_user"), "协调者能问用户");
        assert!(f.is_allowed("read_file"));
        assert!(!f.is_allowed("write_file"), "协调者不写");
        assert!(!f.is_allowed("execute_shell"), "协调者不跑命令");
    }

    #[test]
    fn persist_then_parse_round_trips_tools_and_iter() {
        // 落盘 AGENT.md → 用 registry 的 parse_agent_md 读回,tools/max_iter/persona 必须保住
        // (这是"重启后动态角色仍在"的关键:读回的 def 要和落盘前等价)。
        let tmp = tempfile::TempDir::new().unwrap();
        let spec = sample(PermissionProfile::Reviewer);
        let path = persist_role_agent_md(tmp.path(), &spec).expect("落盘成功");
        let content = std::fs::read_to_string(&path).unwrap();
        let def = super::super::parse_agent_md(&content, &path).expect("读回解析成功");

        assert_eq!(def.name, "audio_engineer");
        assert_eq!(def.description, spec.description, "description 应往返(含 CJK)");
        assert_eq!(def.max_iterations, Some(14));
        assert_eq!(def.instructions, spec.persona);
        match def.tool_filter() {
            ToolFilter::Allow(list) => {
                assert_eq!(list, spec.profile.tools(), "读回的白名单应与档位一致");
            }
            other => panic!("应为 Allow,得到 {other:?}"),
        }
        assert!(def.is_hidden());
        assert_eq!(def.emoji(), "🎧");
    }
}
