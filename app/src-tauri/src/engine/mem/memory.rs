use chrono::Local;
use std::fs;
use std::path::{Path, PathBuf};

/// Validate date string is strictly YYYY-MM-DD format to prevent path traversal
fn is_valid_date(date: &str) -> bool {
    date.len() == 10
        && date.as_bytes().iter().enumerate().all(|(i, &b)| match i {
            4 | 7 => b == b'-',
            _ => b.is_ascii_digit(),
        })
}

/// Get the memory directory path (working_dir/memory/)
pub fn memory_dir(working_dir: &Path) -> PathBuf {
    working_dir.join("memory")
}

/// Ensure memory directory exists
pub fn ensure_memory_dir(working_dir: &Path) -> Result<(), String> {
    let dir = memory_dir(working_dir);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create memory dir: {e}"))
}

/// Read MEMORY.md content, returns empty string if not exists
pub fn read_memory_md(working_dir: &Path) -> String {
    let path = memory_dir(working_dir).join("MEMORY.md");
    fs::read_to_string(&path).unwrap_or_default()
}

/// Write/overwrite MEMORY.md (creates backup before overwriting)
pub fn write_memory_md(working_dir: &Path, content: &str) -> Result<(), String> {
    ensure_memory_dir(working_dir)?;
    let path = memory_dir(working_dir).join("MEMORY.md");
    // Backup existing file before overwrite
    if path.exists() {
        let bak = memory_dir(working_dir).join("MEMORY.md.bak");
        let _ = fs::copy(&path, &bak);
    }
    fs::write(&path, content).map_err(|e| format!("Failed to write MEMORY.md: {e}"))
}

/// Read PRINCIPLES.md content (behavioral guidelines consolidated from corrections)
pub fn read_principles_md(working_dir: &Path) -> String {
    let path = memory_dir(working_dir).join("PRINCIPLES.md");
    fs::read_to_string(&path).unwrap_or_default()
}

/// Write/overwrite PRINCIPLES.md
pub fn write_principles_md(working_dir: &Path, content: &str) -> Result<(), String> {
    ensure_memory_dir(working_dir)?;
    let path = memory_dir(working_dir).join("PRINCIPLES.md");
    fs::write(&path, content).map_err(|e| format!("Failed to write PRINCIPLES.md: {e}"))
}

/// Append entry to today's diary (uses OpenOptions::append for atomicity)
pub fn append_diary(
    working_dir: &Path,
    content: &str,
    topic: Option<&str>,
) -> Result<(), String> {
    use std::io::Write;
    ensure_memory_dir(working_dir)?;
    let now = Local::now();
    let today = now.format("%Y-%m-%d").to_string();
    let time = now.format("%H:%M").to_string();
    let path = memory_dir(working_dir).join(format!("{today}.md"));

    // Create with header if file doesn't exist
    if !path.exists() {
        fs::write(&path, format!("# {today}\n"))
            .map_err(|e| format!("Failed to create diary: {e}"))?;
    }

    let topic_str = topic.unwrap_or("Note");
    let entry = format!("\n## {time} - {topic_str}\n{content}\n");

    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .map_err(|e| format!("Failed to open diary: {e}"))?;
    file.write_all(entry.as_bytes())
        .map_err(|e| format!("Failed to write diary: {e}"))?;

    Ok(())
}

/// Read a specific day's diary (YYYY-MM-DD format, validated)
pub fn read_diary(working_dir: &Path, date: &str) -> Result<String, String> {
    if !is_valid_date(date) {
        return Err("Invalid date format. Expected YYYY-MM-DD.".into());
    }
    let path = memory_dir(working_dir).join(format!("{date}.md"));
    Ok(fs::read_to_string(&path).unwrap_or_default())
}

/// Read recent N days of diary entries
pub fn read_recent_diaries(working_dir: &Path, days: usize) -> Vec<(String, String)> {
    let dir = memory_dir(working_dir);
    let mut results = Vec::new();

    for i in 0..days {
        let date = (Local::now() - chrono::Duration::days(i as i64))
            .format("%Y-%m-%d")
            .to_string();
        let path = dir.join(format!("{date}.md"));
        if let Ok(content) = fs::read_to_string(&path) {
            if !content.is_empty() {
                results.push((date, content));
            }
        }
    }
    results
}

/// List all diary files (dates only, sorted desc)
#[allow(dead_code)]
pub fn list_diaries(working_dir: &Path) -> Vec<String> {
    let dir = memory_dir(working_dir);
    let mut dates: Vec<String> = fs::read_dir(&dir)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if name.ends_with(".md") && name != "MEMORY.md" && name != "MEMORY.md.bak" {
                Some(name.trim_end_matches(".md").to_string())
            } else {
                None
            }
        })
        .collect();
    dates.sort_unstable();
    dates.reverse();
    dates
}
