use super::db::Database;
use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;

/// Result of a tier lifecycle run (during meditation)
#[derive(Debug, Clone, Serialize)]
pub struct TierLifecycleResult {
    pub promoted_to_hot: usize,
    pub demoted_to_warm: usize,
    pub demoted_to_cold: usize,
    pub total_hot: usize,
    pub total_warm: usize,
    pub total_cold: usize,
}

const HOT_CAPACITY: usize = 15;

/// Load HOT-tier memories formatted for system prompt injection.
/// Returns a string with two sections: Behavioral Principles + Long-term Memory.
/// Budget: approximately `budget_chars` characters total.
pub fn load_hot_context(db: &Database, budget_chars: usize) -> String {
    let hot_memories = db.get_memories_by_tier("hot", HOT_CAPACITY * 2);

    let mut principles = Vec::new();
    let mut knowledge = Vec::new();

    for mem in &hot_memories {
        if mem.category == "principle" || mem.category == "learned_rule" {
            principles.push(&mem.content);
        } else {
            knowledge.push(&mem.content);
        }
    }

    let mut result = String::new();

    // Section 1: Behavioral Principles (~40% of budget)
    if !principles.is_empty() {
        let principles_budget = budget_chars * 2 / 5;
        result.push_str("\n\n## Behavioral Principles (learned from your interactions)\n");
        let mut used = 0;
        for p in &principles {
            let line = format!("- {}\n", p);
            if used + line.len() > principles_budget {
                break;
            }
            result.push_str(&line);
            used += line.len();
        }
    }

    // Section 2: Long-term Memory (~60% of budget)
    if !knowledge.is_empty() {
        let knowledge_budget = budget_chars * 3 / 5;
        result.push_str("\n\n## Long-term Memory\n");
        let mut used = 0;
        for k in &knowledge {
            let line = format!("- {}\n", k);
            if used + line.len() > knowledge_budget {
                break;
            }
            result.push_str(&line);
            used += line.len();
        }
    }

    result
}

/// Compute importance score for a memory based on category, recency, and access patterns.
pub fn compute_importance(
    category: &str,
    access_count: i64,
    last_accessed_at: Option<i64>,
    source: &str,
) -> f64 {
    let category_weight = match category {
        "principle" | "learned_rule" => 0.9,
        "preference" => 0.8,
        "fact" => 0.7,
        "decision" => 0.6,
        "experience" => 0.5,
        "note" => 0.3,
        _ => 0.5,
    };

    let now = chrono::Utc::now().timestamp();
    let days_since_access = last_accessed_at
        .map(|ts| ((now - ts) as f64 / 86400.0).max(0.0))
        .unwrap_or(30.0); // default: 30 days if never accessed

    let recency_factor = if days_since_access < 7.0 {
        1.0
    } else if days_since_access < 30.0 {
        0.7
    } else if days_since_access < 90.0 {
        0.4
    } else {
        0.2
    };

    let access_factor = (0.3 + access_count as f64 * 0.1).min(1.0);

    let user_boost = if source == "user_explicit" { 0.3 } else { 0.0 };

    (category_weight * recency_factor * access_factor + user_boost).min(1.0)
}

/// Promote a memory to HOT tier. If HOT is full, demotes the lowest-importance HOT memory.
pub fn promote_to_hot(db: &Database, memory_id: &str) -> Result<(), String> {
    let hot_memories = db.get_memories_by_tier("hot", HOT_CAPACITY + 1);

    // If HOT is full, demote the lowest-confidence one
    if hot_memories.len() >= HOT_CAPACITY {
        // get_memories_by_tier returns sorted by confidence DESC, so last is weakest
        if let Some(weakest) = hot_memories.last() {
            db.update_memory_tier(&weakest.id, "warm", weakest.confidence);
            log::debug!(
                "Demoted memory {} from HOT to WARM (confidence: {})",
                weakest.id,
                weakest.confidence
            );
        }
    }

    db.update_memory_tier(memory_id, "hot", 1.0); // Will be recalculated later
    Ok(())
}

/// Demote a memory one tier down (HOT->WARM or WARM->COLD).
pub fn demote(db: &Database, memory_id: &str, current_tier: &str) -> Result<(), String> {
    let new_tier = match current_tier {
        "hot" => "warm",
        "warm" => "cold",
        _ => return Ok(()), // already cold or unknown
    };
    db.update_memory_tier(memory_id, new_tier, 0.0); // confidence will be recalculated
    Ok(())
}

/// Run the full tier lifecycle: recompute importance, promote/demote based on thresholds.
/// Called during meditation Phase 2.
pub fn run_tier_lifecycle(db: &Database, working_dir: &Path) -> TierLifecycleResult {
    let mut promoted = 0;
    let mut demoted_to_warm = 0;
    let mut demoted_to_cold = 0;

    let now = chrono::Utc::now().timestamp();
    let seven_days_ago = now - 7 * 86400;
    let fourteen_days_ago = now - 14 * 86400;
    let sixty_days_ago = now - 60 * 86400;

    // 1. Recompute importance for all HOT and WARM memories
    let hot = db.get_memories_by_tier("hot", 100);
    let warm = db.get_memories_by_tier("warm", 500);

    // 2. Demote stale HOT memories
    // Compute final tier first, then write once to avoid redundant DB writes
    for mem in &hot {
        let importance = compute_importance(
            &mem.category,
            mem.access_count,
            mem.last_accessed_at,
            &mem.source,
        );

        let last_access = mem.last_accessed_at.unwrap_or(0);
        let should_demote = (last_access < fourteen_days_ago || importance < 0.5)
            && (mem.source != "user_explicit" || importance < 0.3);

        if should_demote {
            db.update_memory_tier(&mem.id, "warm", importance);
            demoted_to_warm += 1;
            // Assumption: mem.id is always ASCII (UUID), so byte slicing is safe
            let id_prefix = &mem.id[..mem.id.len().min(8)];
            log::info!(
                "Meditation: demoted HOT->WARM: {} (importance: {:.2})",
                id_prefix,
                importance
            );
        } else {
            db.update_memory_tier(&mem.id, "hot", importance);
        }
    }

    // 3. Promote worthy WARM memories to HOT
    // Track promoted IDs so step 4 doesn't demote them in the same run
    let mut promoted_ids: HashSet<String> = HashSet::new();
    let current_hot_count = db.get_memories_by_tier("hot", HOT_CAPACITY + 1).len();
    for mem in &warm {
        if current_hot_count + promoted >= HOT_CAPACITY {
            break;
        }

        let importance = compute_importance(
            &mem.category,
            mem.access_count,
            mem.last_accessed_at,
            &mem.source,
        );
        db.update_memory_tier(&mem.id, "warm", importance);

        let last_access = mem.last_accessed_at.unwrap_or(0);
        let recent_access = last_access > seven_days_ago;

        if mem.access_count >= 3 && recent_access && importance >= 0.7 {
            db.update_memory_tier(&mem.id, "hot", importance);
            promoted += 1;
            promoted_ids.insert(mem.id.clone());
            // Assumption: mem.id is always ASCII (UUID), so byte slicing is safe
            let id_prefix = &mem.id[..mem.id.len().min(8)];
            log::info!(
                "Meditation: promoted WARM->HOT: {} (importance: {:.2})",
                id_prefix,
                importance
            );
        }
    }

    // 4. Demote stale WARM memories to COLD
    // Skip memories that were just promoted to HOT in step 3
    for mem in &warm {
        if promoted_ids.contains(&mem.id) {
            continue;
        }
        let last_access = mem.last_accessed_at.unwrap_or(0);
        if last_access < sixty_days_ago && mem.access_count < 2 {
            db.update_memory_tier(&mem.id, "cold", 0.1);
            demoted_to_cold += 1;
            // Assumption: mem.id is always ASCII (UUID), so byte slicing is safe
            let id_prefix = &mem.id[..mem.id.len().min(8)];
            log::info!("Meditation: demoted WARM->COLD: {} (stale)", id_prefix);
        }
    }

    // 5. Sync HOT tier to files (MEMORY.md + PRINCIPLES.md)
    if let Err(e) = sync_hot_to_files(db, working_dir) {
        log::error!("Failed to sync HOT tier to files: {}", e);
    }

    let total_hot = db.get_memories_by_tier("hot", 100).len();
    let total_warm = db.get_memories_by_tier("warm", 10000).len();
    let total_cold = db.get_memories_by_tier("cold", 10000).len();

    let result = TierLifecycleResult {
        promoted_to_hot: promoted,
        demoted_to_warm,
        demoted_to_cold,
        total_hot,
        total_warm,
        total_cold,
    };

    log::info!(
        "Tier lifecycle complete: +{}HOT, -{}WARM, -{}COLD | HOT:{} WARM:{} COLD:{}",
        promoted,
        demoted_to_warm,
        demoted_to_cold,
        total_hot,
        total_warm,
        total_cold
    );

    result
}

/// Render HOT-tier memories to MEMORY.md and PRINCIPLES.md files.
/// These files become caches of the HOT tier, not primary stores.
pub fn sync_hot_to_files(db: &Database, working_dir: &Path) -> Result<(), String> {
    let hot_memories = db.get_memories_by_tier("hot", HOT_CAPACITY * 2);

    // Separate principles from knowledge
    let mut principles_lines = Vec::new();
    let mut memory_lines = Vec::new();

    for mem in &hot_memories {
        if mem.category == "principle" || mem.category == "learned_rule" {
            principles_lines.push(format!("- {}", mem.content));
        } else {
            let prefix = match mem.category.as_str() {
                "preference" => "偏好",
                "fact" => "事实",
                "decision" => "决定",
                "experience" => "经验",
                _ => "备注",
            };
            memory_lines.push(format!("- [{}] {}", prefix, mem.content));
        }
    }

    // Write PRINCIPLES.md
    let principles_content = if principles_lines.is_empty() {
        String::new()
    } else {
        format!(
            "# Behavioral Principles\n\n{}\n",
            principles_lines.join("\n")
        )
    };
    super::memory::write_principles_md(working_dir, &principles_content)?;

    // Write MEMORY.md
    let memory_content = if memory_lines.is_empty() {
        String::new()
    } else {
        format!("# Long-term Memory\n\n{}\n", memory_lines.join("\n"))
    };
    super::memory::write_memory_md(working_dir, &memory_content)?;

    log::debug!(
        "Synced HOT tier to files: {} principles, {} memories",
        principles_lines.len(),
        memory_lines.len()
    );
    Ok(())
}

/// Seed the tiered memory from existing MEMORY.md and PRINCIPLES.md files.
/// Called once during migration to populate the DB from legacy file-based storage.
pub fn seed_from_files(db: &Database, working_dir: &Path) {
    let principles = super::memory::read_principles_md(working_dir);
    let memory = super::memory::read_memory_md(working_dir);

    let mut seeded = 0;

    // Parse principles (each "- " line becomes a HOT principle memory)
    for line in principles.lines() {
        let trimmed = line
            .trim()
            .trim_start_matches("- ")
            .trim_start_matches("* ")
            .trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        // Check if this principle already exists in DB (avoid duplicates)
        // Use exact string comparison — FTS may not tokenize Chinese text reliably
        if let Ok(existing) = db.memory_search(trimmed, None, 3) {
            let already_exists = existing.iter().any(|m| m.content.trim() == trimmed);
            if already_exists {
                continue;
            }
        }

        if let Ok(id) = db.memory_add(trimmed, "principle", None) {
            db.update_memory_tier(&id, "hot", 0.9);
            seeded += 1;
        }
    }

    // Parse memory (each "- " line becomes a HOT knowledge memory)
    for line in memory.lines() {
        let trimmed = line
            .trim()
            .trim_start_matches("- ")
            .trim_start_matches("* ")
            .trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        // Try to detect category from content
        let (category, content) = if trimmed.starts_with("[偏好]") || trimmed.starts_with("[preference]") {
            (
                "preference",
                trimmed
                    .trim_start_matches("[偏好]")
                    .trim_start_matches("[preference]")
                    .trim(),
            )
        } else if trimmed.starts_with("[事实]") || trimmed.starts_with("[fact]") {
            (
                "fact",
                trimmed
                    .trim_start_matches("[事实]")
                    .trim_start_matches("[fact]")
                    .trim(),
            )
        } else if trimmed.starts_with("[决定]") || trimmed.starts_with("[decision]") {
            (
                "decision",
                trimmed
                    .trim_start_matches("[决定]")
                    .trim_start_matches("[decision]")
                    .trim(),
            )
        } else {
            ("fact", trimmed)
        };

        // Use exact string comparison — FTS may not tokenize Chinese text reliably
        if let Ok(existing) = db.memory_search(content, None, 3) {
            let already_exists = existing.iter().any(|m| m.content.trim() == content);
            if already_exists {
                continue;
            }
        }

        if let Ok(id) = db.memory_add(content, category, None) {
            db.update_memory_tier(&id, "hot", 0.8);
            seeded += 1;
        }
    }

    if seeded > 0 {
        log::info!(
            "Seeded {} memories from legacy files into tiered memory",
            seeded
        );
    }
}
