use std::path::Path;

use crate::engine::tools::MEMME_USER_ID;

const HOT_CAPACITY: usize = 15;
const HOT_THRESHOLD: f32 = 0.7;

/// Load HOT-tier memories (importance >= 0.7) formatted for system prompt injection.
pub fn load_hot_context(budget_chars: usize) -> String {
    let store = match crate::engine::tools::get_memme_store() {
        Some(s) => s,
        None => return String::new(),
    };

    // Use MemMe's server-side min_importance filter (no more client-side 500-row hack)
    let mut hot = match store.list_traces(
        memme_core::ListOptions::new(MEMME_USER_ID)
            .min_importance(HOT_THRESHOLD)
            .limit(HOT_CAPACITY * 2),
    ) {
        Ok(rows) => rows,
        Err(e) => {
            log::warn!("Failed to load HOT context from MemMe: {}", e);
            return String::new();
        }
    };

    if hot.is_empty() {
        return String::new();
    }

    let mut principles = Vec::new();
    let mut knowledge = Vec::new();

    for mem in &hot {
        let cats = mem.categories.as_ref().map(|c| c.join(",")).unwrap_or_default();
        if cats.contains("principle") {
            principles.push(&mem.content);
        } else {
            knowledge.push(&mem.content);
        }
    }

    let mut result = String::new();

    if !principles.is_empty() {
        let budget = budget_chars * 2 / 5;
        result.push_str("\n\n## Behavioral Principles (learned from your interactions)\n");
        let mut used = 0;
        for p in &principles {
            let line = format!("- {}\n", p);
            if used + line.len() > budget { break; }
            result.push_str(&line);
            used += line.len();
        }
    }

    if !knowledge.is_empty() {
        let budget = budget_chars * 3 / 5;
        result.push_str("\n\n## Long-term Memory\n");
        let mut used = 0;
        for k in &knowledge {
            let line = format!("- {}\n", k);
            if used + line.len() > budget { break; }
            result.push_str(&line);
            used += line.len();
        }
    }

    result
}

/// Render high-importance memories to MEMORY.md and PRINCIPLES.md files.
pub fn sync_hot_to_files(working_dir: &Path) -> Result<(), String> {
    let store = match crate::engine::tools::get_memme_store() {
        Some(s) => s,
        None => return Ok(()),
    };

    let hot = match store.list_traces(
        memme_core::ListOptions::new(MEMME_USER_ID)
            .min_importance(HOT_THRESHOLD)
            .limit(HOT_CAPACITY * 2),
    ) {
        Ok(rows) => rows,
        Err(e) => {
            log::warn!("Failed to list traces for sync_hot_to_files: {}", e);
            return Ok(());
        }
    };

    let mut principles_lines = Vec::new();
    let mut memory_lines = Vec::new();

    for mem in &hot {
        let cats = mem.categories.as_ref().map(|c| c.join(",")).unwrap_or_default();
        if cats.contains("principle") {
            principles_lines.push(format!("- {}", mem.content));
        } else {
            let prefix = if cats.contains("preference") { "偏好" }
                else if cats.contains("fact") { "事实" }
                else if cats.contains("decision") { "决定" }
                else if cats.contains("experience") { "经验" }
                else { "备注" };
            memory_lines.push(format!("- [{}] {}", prefix, mem.content));
        }
    }

    let principles_content = if principles_lines.is_empty() {
        String::new()
    } else {
        format!("# Behavioral Principles\n\n{}\n", principles_lines.join("\n"))
    };
    super::memory::write_principles_md(working_dir, &principles_content)?;

    let memory_content = if memory_lines.is_empty() {
        String::new()
    } else {
        format!("# Long-term Memory\n\n{}\n", memory_lines.join("\n"))
    };
    super::memory::write_memory_md(working_dir, &memory_content)?;

    log::debug!(
        "Synced HOT tier to files: {} principles, {} memories",
        principles_lines.len(), memory_lines.len(),
    );
    Ok(())
}

/// Seed MemMe from existing MEMORY.md and PRINCIPLES.md files.
/// Called once during first launch to populate from legacy file-based storage.
pub fn seed_from_files(working_dir: &Path) {
    let store = match crate::engine::tools::get_memme_store() {
        Some(s) => s,
        None => return,
    };

    let principles = super::memory::read_principles_md(working_dir);
    let memory = super::memory::read_memory_md(working_dir);

    let mut seeded = 0;

    for line in principles.lines() {
        let trimmed = line.trim()
            .trim_start_matches("- ").trim_start_matches("* ").trim();
        if trimmed.is_empty() || trimmed.starts_with('#') { continue; }

        let opts = memme_core::AddOptions::new(MEMME_USER_ID)
            .categories(vec!["principle".to_string()])
            .importance(0.9);
        if store.add(trimmed, opts).is_ok() {
            seeded += 1;
        }
    }

    for line in memory.lines() {
        let trimmed = line.trim()
            .trim_start_matches("- ").trim_start_matches("* ").trim();
        if trimmed.is_empty() || trimmed.starts_with('#') { continue; }

        let (category, content) = if trimmed.starts_with("[偏好]") || trimmed.starts_with("[preference]") {
            ("preference", trimmed.trim_start_matches("[偏好]").trim_start_matches("[preference]").trim())
        } else if trimmed.starts_with("[事实]") || trimmed.starts_with("[fact]") {
            ("fact", trimmed.trim_start_matches("[事实]").trim_start_matches("[fact]").trim())
        } else if trimmed.starts_with("[决定]") || trimmed.starts_with("[decision]") {
            ("decision", trimmed.trim_start_matches("[决定]").trim_start_matches("[decision]").trim())
        } else {
            ("fact", trimmed)
        };

        let opts = memme_core::AddOptions::new(MEMME_USER_ID)
            .categories(vec![category.to_string()])
            .importance(0.8);
        if store.add(content, opts).is_ok() {
            seeded += 1;
        }
    }

    if seeded > 0 {
        log::info!("Seeded {} memories from legacy files into MemMe", seeded);
    }
}
