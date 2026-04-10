//! Project file tree — cached workspace structure for fast project understanding.
//!
//! Generates a tree view of the project that can be injected into context,
//! so the LLM knows what files exist without needing multiple list_directory calls.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

/// Cached project tree with TTL.
static TREE_CACHE: std::sync::OnceLock<Mutex<HashMap<String, (String, Instant)>>> = std::sync::OnceLock::new();

fn cache() -> &'static Mutex<HashMap<String, (String, Instant)>> {
    TREE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

const CACHE_TTL_SECS: u64 = 60;
const MAX_FILES: usize = 500;
const MAX_DEPTH: usize = 6;

/// Get or generate a project file tree.
pub fn get_project_tree(workspace: &Path) -> String {
    let key = workspace.to_string_lossy().to_string();

    // Check cache
    if let Ok(guard) = cache().lock() {
        if let Some((tree, ts)) = guard.get(&key) {
            if ts.elapsed().as_secs() < CACHE_TTL_SECS {
                return tree.clone();
            }
        }
    }

    // Generate tree
    let tree = generate_tree(workspace);

    // Store in cache
    if let Ok(mut guard) = cache().lock() {
        // Limit cache size
        if guard.len() >= 10 {
            guard.clear();
        }
        guard.insert(key, (tree.clone(), Instant::now()));
    }

    tree
}

/// Generate a file tree string.
fn generate_tree(root: &Path) -> String {
    let mut lines = Vec::new();
    let root_name = root.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| root.to_string_lossy().to_string());

    lines.push(format!("{}/", root_name));

    let mut file_count = 0;
    walk_dir(root, root, "", &mut lines, &mut file_count, 0);

    if file_count >= MAX_FILES {
        lines.push(format!("... ({} files shown, more exist)", file_count));
    }

    lines.join("\n")
}

fn walk_dir(
    root: &Path,
    dir: &Path,
    prefix: &str,
    lines: &mut Vec<String>,
    file_count: &mut usize,
    depth: usize,
) {
    if depth >= MAX_DEPTH || *file_count >= MAX_FILES {
        return;
    }

    let mut entries: Vec<PathBuf> = match std::fs::read_dir(dir) {
        Ok(rd) => rd.filter_map(|e| e.ok().map(|e| e.path())).collect(),
        Err(_) => return,
    };

    // Sort: directories first, then files, alphabetical within each
    entries.sort_by(|a, b| {
        let a_dir = a.is_dir();
        let b_dir = b.is_dir();
        if a_dir != b_dir {
            return if a_dir { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater };
        }
        a.file_name().cmp(&b.file_name())
    });

    // Filter out common noise
    entries.retain(|e| {
        let name = e.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        !should_skip(&name)
    });

    let total = entries.len();
    for (i, entry) in entries.iter().enumerate() {
        if *file_count >= MAX_FILES {
            break;
        }

        let is_last = i == total - 1;
        let connector = if is_last { "└── " } else { "├── " };
        let child_prefix = if is_last { "    " } else { "│   " };

        let name = entry.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        if entry.is_dir() {
            lines.push(format!("{}{}{}/", prefix, connector, name));
            walk_dir(root, entry, &format!("{}{}", prefix, child_prefix), lines, file_count, depth + 1);
        } else {
            *file_count += 1;
            // Show file size for context
            let size = std::fs::metadata(entry)
                .map(|m| format_size(m.len()))
                .unwrap_or_default();
            lines.push(format!("{}{}{}{}", prefix, connector, name, if size.is_empty() { String::new() } else { format!(" ({})", size) }));
        }
    }
}

fn should_skip(name: &str) -> bool {
    matches!(name,
        "node_modules" | ".git" | "target" | "dist" | "build" | ".next" | "__pycache__"
        | ".DS_Store" | "Thumbs.db" | ".idea" | ".vscode" | ".cache" | ".tsbuildinfo"
        | "venv" | ".venv" | ".env" | "vendor" | "coverage" | ".nyc_output"
        | "pkg" | ".parcel-cache" | ".turbo"
    )
}

fn format_size(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{}B", bytes)
    } else if bytes < 1024 * 1024 {
        format!("{:.1}K", bytes as f64 / 1024.0)
    } else {
        format!("{:.1}M", bytes as f64 / (1024.0 * 1024.0))
    }
}
