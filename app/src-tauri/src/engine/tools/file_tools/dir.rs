//! Directory inspection — `list_directory` (one-level entries) and
//! `project_tree` (full tree with project-type detection). Both are
//! read-only and route through `access_check` before touching disk.

pub(crate) async fn project_tree_tool(args: &serde_json::Value) -> String {
    let path = args["path"].as_str().unwrap_or(".");
    if let Err(e) = super::super::access_check(path, false).await {
        return format!("Error: {}", e);
    }
    let workspace = std::path::Path::new(path);
    if !workspace.is_dir() {
        return format!("Error: '{}' is not a directory", path);
    }

    let tree = crate::engine::coding::project_tree::get_project_tree(workspace);

    // Also detect project type and show info
    let info = crate::engine::coding::project_detect::detect_project(workspace);
    let project_info = crate::engine::coding::project_detect::project_summary(&info);

    format!("{}\n\n{}", project_info, tree)
}

pub(crate) async fn list_directory_tool(args: &serde_json::Value) -> String {
    let path = args["path"].as_str().unwrap_or(".");
    if let Err(e) = super::super::access_check(path, false).await {
        return format!("Error: {}", e);
    }

    match tokio::fs::read_dir(path).await {
        Ok(mut entries) => {
            let mut items = Vec::new();
            while let Ok(Some(entry)) = entries.next_entry().await {
                let name = entry.file_name().to_string_lossy().to_string();
                let meta = entry.metadata().await.ok();
                let is_dir = meta.as_ref().map_or(false, |m| m.is_dir());
                let size = meta.as_ref().map_or(0, |m| m.len());
                if is_dir {
                    items.push(format!("  [DIR] {}/", name));
                } else {
                    items.push(format!("  {} ({} bytes)", name, size));
                }
            }
            if items.is_empty() {
                format!("{}: (empty)", path)
            } else {
                format!("{}:\n{}", path, items.join("\n"))
            }
        }
        Err(e) => format!("Error: {}", e),
    }
}
