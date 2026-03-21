use tauri::Emitter;

/// Skill management tool definitions.
pub(super) fn definitions() -> Vec<super::ToolDefinition> {
    vec![
        super::tool_def(
            "manage_skill",
            "Manage AI skills: create, list, enable, disable, or delete skills.\n\
            - create: Generate a new custom skill with SKILL.md and optional script files. Scripts are saved to the skill's scripts/ directory and auto-registered in your code library.\n\
            - list: List all available skills with their status.\n\
            - enable: Enable a skill by name.\n\
            - disable: Disable a skill by name.\n\
            - delete: Delete a custom skill by name.\n\
            Use this when the user asks to create, manage, or configure skills/abilities.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["create", "list", "enable", "disable", "delete"],
                        "description": "Action to perform"
                    },
                    "name": { "type": "string", "description": "Skill name (lowercase, alphanumeric with hyphens/underscores). Required for create/enable/disable/delete." },
                    "content": { "type": "string", "description": "Full SKILL.md content including YAML frontmatter and Markdown instructions. Required for create." },
                    "scripts": {
                        "type": "object",
                        "description": "Optional script files to create in the skill's scripts/ directory. Keys are filenames, values are file contents. Example: {\"clean.py\": \"import sys\\n...\"}",
                        "additionalProperties": { "type": "string" }
                    }
                },
                "required": ["action"]
            }),
        ),
        super::tool_def(
            "activate_skills",
            "Load detailed instructions for specific skills on demand. \
            Check the 'Available Skills' list in your system prompt and call this when you need specialized knowledge for a task. \
            The skill content will be returned so you can follow the instructions.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "names": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Skill names to activate (from the Available Skills list)"
                    }
                },
                "required": ["names"]
            }),
        ),
        super::tool_def(
            "register_code",
            "Register a script or code file you created so you can find and reuse it later. \
            Always call this after writing a reusable script. \
            This builds your personal code library that persists across conversations.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Short identifier for the code (e.g. 'csv_cleaner', 'pdf_merger')" },
                    "path": { "type": "string", "description": "Absolute path where the script is saved" },
                    "description": { "type": "string", "description": "What this code does, when to use it" },
                    "language": { "type": "string", "description": "Programming language: python, javascript, bash, etc." },
                    "invoke_hint": { "type": "string", "description": "How to invoke this code (e.g. 'run_python_script with args: [input_file, output_file]')" }
                },
                "required": ["name", "path", "description"]
            }),
        ),
        super::tool_def(
            "search_my_code",
            "Search your personal code library for scripts you previously created. \
            Use this before writing new code — you may have already built something similar. \
            Returns matching scripts with their paths, descriptions, and usage stats.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Search keywords (name, description, or purpose)" }
                },
                "required": ["query"]
            }),
        ),
        super::tool_def(
            "manage_quick_action",
            "Add, update, or delete a custom quick action. Use when the user asks to save a prompt as a quick action.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["add", "update", "delete"], "description": "Operation type" },
                    "id": { "type": "string", "description": "Required for update/delete" },
                    "label": { "type": "string", "description": "Display name" },
                    "description": { "type": "string", "description": "Brief description" },
                    "prompt": { "type": "string", "description": "The prompt text" },
                    "icon": { "type": "string", "description": "Icon name (Zap, Star, Code, Heart, Globe, Mail, Search, BookOpen, Lightbulb, Wrench, etc.)" },
                    "color": { "type": "string", "description": "Hex color like #6366F1" }
                },
                "required": ["action"]
            }),
        ),
    ]
}

pub(super) async fn manage_skill_tool(args: &serde_json::Value) -> String {
    let action = args["action"].as_str().unwrap_or("");
    let name = args["name"].as_str().unwrap_or("");

    let working_dir = match super::WORKING_DIR.get() {
        Some(d) => d.clone(),
        None => return "Error: working directory not initialized".into(),
    };

    let active_dir = working_dir.join("active_skills");
    let custom_dir = working_dir.join("customized_skills");

    match action {
        "create" => {
            let content = args["content"].as_str().unwrap_or("");
            if name.is_empty() || content.is_empty() {
                return "Error: 'name' and 'content' are required for create".into();
            }

            // Create in customized_skills and active_skills
            let skill_custom = custom_dir.join(name);
            let skill_active = active_dir.join(name);

            if let Err(e) = std::fs::create_dir_all(&skill_custom) {
                return format!("Error creating skill dir: {}", e);
            }
            if let Err(e) = std::fs::write(skill_custom.join("SKILL.md"), content) {
                return format!("Error writing SKILL.md: {}", e);
            }

            std::fs::create_dir_all(&skill_active).ok();
            std::fs::write(skill_active.join("SKILL.md"), content).ok();

            // Create script files if provided
            let mut script_count = 0;
            if let Some(scripts) = args["scripts"].as_object() {
                let scripts_dir_custom = skill_custom.join("scripts");
                let scripts_dir_active = skill_active.join("scripts");
                std::fs::create_dir_all(&scripts_dir_custom).ok();
                std::fs::create_dir_all(&scripts_dir_active).ok();

                for (filename, content_val) in scripts {
                    // Security: sanitize filename to prevent path traversal
                    let safe_name = std::path::Path::new(filename)
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("");
                    if safe_name.is_empty() || safe_name.starts_with('.') {
                        log::warn!("Skipping invalid script filename: {}", filename);
                        continue;
                    }
                    if let Some(script_content) = content_val.as_str() {
                        let custom_path = scripts_dir_custom.join(safe_name);
                        let active_path = scripts_dir_active.join(safe_name);
                        std::fs::write(&custom_path, script_content).ok();
                        std::fs::write(&active_path, script_content).ok();

                        // Auto-register in code library
                        if let Some(db) = super::DATABASE.get() {
                            let script_name = format!("{}:{}", name, filename);
                            let desc = format!("Script from skill '{}': {}", name, filename);
                            let lang = if filename.ends_with(".py") { "python" }
                                else if filename.ends_with(".js") { "javascript" }
                                else if filename.ends_with(".sh") { "bash" }
                                else { "unknown" };
                            let hint = format!(
                                "run_python_script with script_path={}",
                                active_path.to_string_lossy()
                            );
                            db.register_code(
                                &script_name,
                                &active_path.to_string_lossy(),
                                &desc,
                                lang,
                                Some(&hint),
                                Some(name),
                            ).ok();
                        }
                        script_count += 1;
                    }
                }
            }

            // Notify frontend to refresh
            if let Some(handle) = super::APP_HANDLE.get() {
                handle.emit("skills://changed", "created").ok();
            }

            if script_count > 0 {
                format!("Skill '{}' created with {} script(s) and enabled. Scripts auto-registered in code library.", name, script_count)
            } else {
                format!("Skill '{}' created and enabled successfully.", name)
            }
        }
        "list" => {
            let mut result = Vec::new();

            // Active skills
            if let Ok(entries) = std::fs::read_dir(&active_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() && path.join("SKILL.md").exists() {
                        let skill_name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                        result.push(format!("  [enabled] {}", skill_name));
                    }
                }
            }

            // Customized but disabled
            if let Ok(entries) = std::fs::read_dir(&custom_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() && path.join("SKILL.md").exists() {
                        let skill_name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                        if !active_dir.join(&skill_name).exists() {
                            result.push(format!("  [disabled] {}", skill_name));
                        }
                    }
                }
            }

            if result.is_empty() {
                "No skills found.".into()
            } else {
                format!("Skills:\n{}", result.join("\n"))
            }
        }
        "enable" => {
            if name.is_empty() {
                return "Error: 'name' is required for enable".into();
            }
            let src = custom_dir.join(name);
            let dst = active_dir.join(name);
            if dst.exists() {
                return format!("Skill '{}' is already enabled.", name);
            }
            if src.exists() {
                std::fs::create_dir_all(&active_dir).ok();
                fn copy_dir(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
                    std::fs::create_dir_all(dst)?;
                    for entry in std::fs::read_dir(src)? {
                        let entry = entry?;
                        let dest = dst.join(entry.file_name());
                        if entry.path().is_dir() {
                            copy_dir(&entry.path(), &dest)?;
                        } else {
                            std::fs::copy(&entry.path(), &dest)?;
                        }
                    }
                    Ok(())
                }
                if let Err(e) = copy_dir(&src, &dst) {
                    return format!("Error enabling skill: {}", e);
                }
            } else {
                return format!("Error: skill '{}' not found in customized_skills", name);
            }

            if let Some(handle) = super::APP_HANDLE.get() {
                handle.emit("skills://changed", "enabled").ok();
            }
            format!("Skill '{}' enabled.", name)
        }
        "disable" => {
            if name.is_empty() {
                return "Error: 'name' is required for disable".into();
            }
            let path = active_dir.join(name);
            if path.exists() {
                if let Err(e) = std::fs::remove_dir_all(&path) {
                    return format!("Error disabling skill: {}", e);
                }
            }

            if let Some(handle) = super::APP_HANDLE.get() {
                handle.emit("skills://changed", "disabled").ok();
            }
            format!("Skill '{}' disabled.", name)
        }
        "delete" => {
            if name.is_empty() {
                return "Error: 'name' is required for delete".into();
            }
            let custom_path = custom_dir.join(name);
            let active_path = active_dir.join(name);

            if custom_path.exists() {
                std::fs::remove_dir_all(&custom_path).ok();
            }
            if active_path.exists() {
                std::fs::remove_dir_all(&active_path).ok();
            }

            if let Some(handle) = super::APP_HANDLE.get() {
                handle.emit("skills://changed", "deleted").ok();
            }
            format!("Skill '{}' deleted.", name)
        }
        _ => format!("Unknown action: '{}'. Use create, list, enable, disable, or delete.", action),
    }
}

pub(super) async fn activate_skills_tool(args: &serde_json::Value) -> String {
    let names = match args["names"].as_array() {
        Some(arr) => arr.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>(),
        None => return "Error: 'names' must be an array of skill names.".to_string(),
    };
    if names.is_empty() {
        return "Error: provide at least one skill name.".to_string();
    }

    let skills_dir = match super::WORKING_DIR.get() {
        Some(wd) => wd.join("active_skills"),
        None => return "Error: working directory not configured.".to_string(),
    };

    let mut results = Vec::new();
    let mut not_found = Vec::new();

    for name in &names {
        let skill_md = skills_dir.join(name).join("SKILL.md");
        match tokio::fs::read_to_string(&skill_md).await {
            Ok(content) => {
                // Strip YAML frontmatter — model only needs the instructions
                let body = super::strip_frontmatter(&content);
                let skill_dir = skills_dir.join(name);
                results.push(format!(
                    "[Skill: {} | directory: {}]\n\n{}",
                    name,
                    skill_dir.to_string_lossy(),
                    body.trim()
                ));
            }
            Err(_) => not_found.push(*name),
        }
    }

    if !not_found.is_empty() {
        // List available skills to help the model self-correct
        let available: Vec<String> = std::fs::read_dir(&skills_dir)
            .ok()
            .map(|entries| {
                entries
                    .flatten()
                    .filter(|e| e.path().join("SKILL.md").exists())
                    .filter_map(|e| e.file_name().into_string().ok())
                    .collect()
            })
            .unwrap_or_default();
        results.push(format!(
            "Skills not found: {}. Available: {}",
            not_found.join(", "),
            available.join(", ")
        ));
    }

    results.join("\n\n---\n\n")
}

pub(super) async fn register_code_tool(args: &serde_json::Value) -> String {
    let name = args["name"].as_str().unwrap_or("");
    let path = args["path"].as_str().unwrap_or("");
    let description = args["description"].as_str().unwrap_or("");
    let language = args["language"].as_str().unwrap_or("python");
    let invoke_hint = args["invoke_hint"].as_str();

    if name.is_empty() || path.is_empty() || description.is_empty() {
        return "Error: name, path, and description are required".into();
    }

    // Security: verify path is in authorized folders
    if let Err(e) = super::access_check(path, false).await {
        return format!("Error: {}", e);
    }

    // Verify the file actually exists
    if !std::path::Path::new(path).exists() {
        return format!("Error: file does not exist at {}", path);
    }

    let db = match super::require_db() {
        Ok(db) => db,
        Err(e) => return e,
    };

    match db.register_code(name, path, description, language, invoke_hint, None) {
        Ok(id) => format!(
            "Registered '{}' in code library (id: {}). You can find and reuse it later with search_my_code.",
            name, id
        ),
        Err(e) => format!("Error: {}", e),
    }
}

pub(super) async fn search_my_code_tool(args: &serde_json::Value) -> String {
    let query = args["query"].as_str().unwrap_or("");
    if query.is_empty() {
        return "Error: query is required".into();
    }

    let db = match super::require_db() {
        Ok(db) => db,
        Err(e) => return e,
    };

    let results = db.search_code_registry(query, 10);
    if results.is_empty() {
        return format!("No code found matching '{}'. You may need to write it from scratch.", query);
    }

    let mut output = format!("Found {} matching scripts:\n\n", results.len());
    for entry in &results {
        output.push_str(&format!(
            "- **{}** ({})\n  Path: {}\n  Description: {}\n  Usage: {} runs, {} successful\n",
            entry.name, entry.language, entry.path, entry.description,
            entry.run_count, entry.success_count,
        ));
        if let Some(ref hint) = entry.invoke_hint {
            output.push_str(&format!("  Invoke: {}\n", hint));
        }
        if let Some(ref err) = entry.last_error {
            output.push_str(&format!("  Last error: {}\n", err));
        }
        output.push('\n');
    }
    output
}

pub(super) async fn manage_quick_action_tool(args: &serde_json::Value) -> String {
    let action = args["action"].as_str().unwrap_or("");
    let db = match super::require_db() {
        Ok(db) => db,
        Err(e) => return e,
    };

    match action {
        "add" => {
            let label = match args["label"].as_str() {
                Some(l) if !l.is_empty() => l,
                _ => return "Error: 'label' is required for add".into(),
            };
            let prompt = match args["prompt"].as_str() {
                Some(p) if !p.is_empty() => p,
                _ => return "Error: 'prompt' is required for add".into(),
            };
            let description = args["description"].as_str().unwrap_or("");
            let icon = args["icon"].as_str().unwrap_or("Zap");
            let color = args["color"].as_str().unwrap_or("#6366F1");

            match db.add_quick_action(label, description, prompt, icon, color) {
                Ok(id) => format!("Quick action '{}' created (id: {})", label, id),
                Err(e) => format!("Error creating quick action: {}", e),
            }
        }
        "update" => {
            let id = match args["id"].as_str() {
                Some(i) => i,
                None => return "Error: 'id' is required for update".into(),
            };
            let label = match args["label"].as_str() {
                Some(l) if !l.is_empty() => l,
                _ => return "Error: 'label' is required for update".into(),
            };
            let prompt = match args["prompt"].as_str() {
                Some(p) if !p.is_empty() => p,
                _ => return "Error: 'prompt' is required for update".into(),
            };
            let description = args["description"].as_str().unwrap_or("");
            let icon = args["icon"].as_str().unwrap_or("Zap");
            let color = args["color"].as_str().unwrap_or("#6366F1");

            match db.update_quick_action(id, label, description, prompt, icon, color) {
                Ok(()) => format!("Quick action '{}' updated", label),
                Err(e) => format!("Error updating quick action: {}", e),
            }
        }
        "delete" => {
            let id = match args["id"].as_str() {
                Some(i) => i,
                None => return "Error: 'id' is required for delete".into(),
            };
            match db.delete_quick_action(id) {
                Ok(()) => format!("Quick action deleted (id: {})", id),
                Err(e) => format!("Error deleting quick action: {}", e),
            }
        }
        _ => format!("Error: unknown action '{}'. Valid: add, update, delete", action),
    }
}
