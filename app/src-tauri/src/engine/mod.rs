//! YiYi Engine — core subsystems for the AI assistant.

// ── Core: Agent loop, hooks, permissions, session management ──
pub mod react_agent;
pub mod hooks;
pub mod permission_mode;
pub mod compact;
pub mod usage;
pub mod prompt_cache;

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
pub mod plugins;
pub mod skills_hub;

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

// ── Testability: abstract over Tauri's event emitter ──
pub mod emitter;
