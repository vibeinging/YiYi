//! `AgentRunConfig` + `ShellOptions` —— 参数化 agent runner 的配置。
//!
//! Phase 1 只覆盖 YiYi(主精灵)主路径所需的字段;`persona_source` /
//! `memory_scope` / `tool_filter` 留到 Phase 3(伙伴切入,有第二个调用方
//! 验证抽象时)再加 —— 单调用方拍这些字段 = 拍脑袋。

use crate::engine::llm_client::{LLMConfig, LLMMessage};

/// YiYi 专属外壳的开关组。`primary()` 全开 = 主精灵现状;`Default` / 伙伴用
/// 全关 = 纯单轮 ReAct(无 auto-continue / verify / growth / progress)。
#[derive(Debug, Clone)]
pub struct ShellOptions {
    /// 多轮 auto-continue 循环(模型靠 `request_continuation` 工具决定续不续)。
    pub auto_continue: bool,
    /// auto-continue 轮数硬上限。
    pub max_rounds: usize,
    /// auto-continue 累计 token 预算硬上限。
    pub token_budget: u64,
    /// 把思考链作为 metadata 落库。
    pub persist_thinking: bool,
    /// round≥3 的多轮任务后台跑 Verification Agent。
    pub verify_long_tasks: bool,
    /// 成长闭环:纠正 / 表扬 / 静默反思。
    pub growth_learning: bool,
    /// 把 user↔assistant 轮喂进 MemMe Session pipeline。
    pub feed_memme: bool,
    /// 写 progress.json(task 崩溃恢复)。
    pub task_progress: bool,
    /// 完成 / 出错发系统通知。
    pub notify: bool,
}

impl Default for ShellOptions {
    /// 全关 —— 伙伴默认值(纯单轮,无外壳)。
    fn default() -> Self {
        Self {
            auto_continue: false,
            max_rounds: 1,
            token_budget: u64::MAX,
            persist_thinking: false,
            verify_long_tasks: false,
            growth_learning: false,
            feed_memme: false,
            task_progress: false,
            notify: false,
        }
    }
}

impl ShellOptions {
    /// 主精灵 YiYi 的外壳:全开。
    pub fn primary(max_rounds: usize, token_budget: u64) -> Self {
        Self {
            auto_continue: true,
            max_rounds,
            token_budget,
            persist_thinking: true,
            verify_long_tasks: true,
            growth_learning: true,
            feed_memme: true,
            task_progress: true,
            notify: true,
        }
    }
}

/// 一次 agent run 的全部输入。Phase 1 字段覆盖 YiYi 主路径;Phase 3 会补
/// `persona_source` / `memory_scope` / `tool_filter`(伙伴切入时)。
pub struct AgentRunConfig {
    /// LLM 配置(模型 / thinking override 等)。
    pub llm: LLMConfig,
    /// 系统提示(人设 + skill index + session context)。
    pub system_prompt: String,
    /// 第一轮的 user message(已注入记忆召回前缀)。
    pub agent_message: String,
    /// 原始增强消息(给 feed_memme / growth / 标题,不含记忆召回前缀)。
    pub augmented_message: String,
    /// 第一轮的对话历史(growth 也从这里读 prev request/reply)。
    pub llm_history: Vec<LLMMessage>,
    /// ReAct 单轮迭代上限。
    pub max_iter: Option<usize>,
    /// 是否本会话第一条消息(决定首轮是否按用户首句命名会话)。
    pub is_first_message: bool,
    /// 外壳开关组。
    pub shell: ShellOptions,
}
