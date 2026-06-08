//! WORK 表面(chat × work 2×2 正交化)—— 只服务"交付物",worker ephemeral。
//!
//! 北极星:work 是从 chat 里**发起**的任务,不是一种 chat。用户住在 chat(单聊/群聊),
//! 要交付物时 launch 一个 work job,它独立跑、结果回流 chat。
//!
//! 本模块是 chat 引擎(`engine/collaboration/`)里 work 逻辑的**目标归位**:
//!   - `plan`   —— PM 的结构化计划 → 协作 DAG(纯函数,从 `collaboration/project.rs` 复制)。
//!   - `worker` —— work 步执行:intake/project_task 的 prompt 构造 + work 超时策略,
//!                 复用 `executor::run_react_inner` 共享内核 + `resolve_companion_role` 权限。
//!   - `launcher` —— work 启动决策(`should_launch_work`)+ 牵头者选取 + intake 入口。
//!
//! **S4 现状**:本模块整体为骨架,**尚未被任何现有代码调用**(不接线、不改路由)。
//! 引擎仍复用 orchestrator(本轮不换 spawn_agents);产出仍是 `CollaborationPlan`,
//! 但调用方明确是 work。S6 接线时去掉各处 `#[allow(dead_code)]`。

pub mod plan;
pub mod worker;
pub mod launcher;
