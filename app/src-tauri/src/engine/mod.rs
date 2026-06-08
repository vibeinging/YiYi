//! YiYi Engine — core subsystems for the AI assistant.

// ── Core: Agent loop, hooks, permissions, session management ──
pub mod react_agent;
pub mod hooks;
pub mod permission_mode;
pub mod text_util;
pub mod compact;
pub mod usage;
pub mod pricing;
pub mod cost_status;
pub mod prompt_cache;
pub mod checkpoint;
pub mod artifacts;

// ── Tools: built-in tool system ──
pub mod tools;
pub mod doc_tools;
pub mod canvas;
pub mod token_counter;

// ── Coding: code intelligence, bash validation, git context ──
pub mod coding;

// ── Memory: memory store, tiered memory, meditation ──
pub mod mem;

// ── Social: bots, worker, scheduler ──
pub mod bots;
pub mod worker;
pub mod scheduler;

// ── Extensions: agents, plugins, skills ──
pub mod agents;
pub mod collaboration;
pub mod work;
pub mod plugins;
pub mod skills_hub;
pub mod skill_proposer;

// ── Infrastructure: DB, LLM, MCP, Python, PTY, config ──
pub mod db;
pub mod llm_client;
pub mod infra;
pub mod task_registry;
pub mod keystore;
pub mod buddy_delegate;
pub mod tool_registry_global;

// ── Voice control ──
pub mod voice;

// ── Agent runner: AgentEventSink trait + ChatEventSink implementation ──
pub mod agent_runner;

// ── Testability: abstract over Tauri's event emitter ──
pub mod emitter;

/// 内部数据根目录(`~/.yiyi`,可被 `YIYI_WORKING_DIR` / `YIYICLAW_WORKING_DIR` 覆盖)。
///
/// **单一真相**:此前这段解析在 checkpoint.rs / state/app_state.rs / doctor.rs / file_tools/backup.rs
/// 各抄了一份;backup.rs 那份漏了 env 覆盖(写死 `home/.yiyi`),导致测试无法把备份隔离到
/// 临时目录、与真实 `~/.yiyi`(及同机正在跑的 app)互踩 → file_tools 测试并行 flake。
/// 收口到这里后,改一处即全生效,杜绝再漂。
pub fn yiyi_data_root() -> std::path::PathBuf {
    std::env::var("YIYI_WORKING_DIR")
        .or_else(|_| std::env::var("YIYICLAW_WORKING_DIR"))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::home_dir()
                .unwrap_or_else(|| std::path::PathBuf::from("."))
                .join(".yiyi")
        })
}
