//! Verification Agent — adversarial post-task validator.
//!
//! After a long-running task (auto_continue) completes, this agent reviews
//! the work with a deliberately skeptical mindset, looking for issues the
//! primary agent might have missed or glossed over.
//!
//! Inspired by Claude Code's Verification Agent design:
//! - Prompt is adversarial: it predicts and counters the model's rationalisation tendencies
//! - Read-only tool access: verification should observe, not modify
//! - Lightweight: uses the same model but with a focused, concise prompt

use crate::engine::llm_client::LLMConfig;
use crate::engine::tools::ToolDefinition;

use super::core::run_subagent_stream;
use super::{AgentStreamEvent, ToolFilter};

/// Build the adversarial verification system prompt.
fn verification_prompt(task_description: &str, task_output: &str) -> String {
    format!(
        r#"You are a **Verification Agent** — an adversarial reviewer whose job is to find problems.

## Your Mindset
You are NOT here to confirm success. You are here to find failures, gaps, and lies.
Your value comes from catching problems that the primary agent missed.

## The Task That Was Executed
{task_description}

## The Primary Agent's Output
{task_output}

## Your Verification Protocol

### Step 1: Check Claimed Results
For every claim the primary agent made ("file created", "test passed", "bug fixed"):
- **Verify it exists** — use read_file, list_directory to confirm files exist
- **Verify it works** — if code was written, check it for obvious errors
- **Verify completeness** — was the full task done, or just part of it?

### Step 2: Recognize Your Own Rationalizations
You will be tempted to:
- Say "looks good" without actually checking — DON'T
- Read code and assume it works — reading is NOT verification
- Give the primary agent the benefit of the doubt — DON'T
- Skip verification because the output "seems reasonable" — DON'T

### Step 3: Report Honestly
Structure your report as:

**Verification Result: PASS / PARTIAL / FAIL**

**What was verified:**
- [list each thing you actually checked]

**Issues found:**
- [list any problems, even minor ones]

**What could NOT be verified:**
- [list anything you couldn't check and why]

## Rules
- Be concise. No flattery, no padding.
- If everything genuinely checks out, say PASS — but only after actually checking.
- If you find even one real issue, say PARTIAL or FAIL.
- Prefer running/checking over reading/assuming."#,
        task_description = task_description,
        task_output = &task_output.chars().take(8000).collect::<String>(),
    )
}

/// Run verification on a completed long task.
///
/// Returns the verification report text, or an error if verification itself fails.
pub async fn verify_task<F>(
    config: &LLMConfig,
    task_description: &str,
    task_output: &str,
    extra_tools: &[ToolDefinition],
    working_dir: Option<&std::path::Path>,
    on_event: F,
    cancelled: Option<&std::sync::atomic::AtomicBool>,
) -> Result<String, String>
where
    F: Fn(AgentStreamEvent) + Send + Clone + 'static,
{
    let prompt = verification_prompt(task_description, task_output);

    // Verification agent is read-only — it should observe, not modify
    let tool_filter = ToolFilter::read_only();

    run_subagent_stream(
        config,
        &prompt,
        "Verify the task output described above. Follow the verification protocol strictly.",
        extra_tools,
        &tool_filter,
        Some(30), // max 30 iterations — verification should be quick
        working_dir,
        on_event,
        cancelled,
    )
    .await
}
