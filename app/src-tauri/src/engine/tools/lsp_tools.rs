//! LSP-powered code intelligence tool.

use serde_json::json;

pub(super) fn definitions() -> Vec<super::ToolDefinition> {
    vec![
        super::tool_def(
            "code_intelligence",
            "Query language server for code intelligence: diagnostics, hover info, go-to-definition, find references, completions, symbols. \
             Requires an LSP server for the target language (auto-starts for Rust, TypeScript, Python).",
            json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["diagnostics", "hover", "definition", "references", "completion", "symbols"],
                        "description": "The LSP action to perform"
                    },
                    "path": { "type": "string", "description": "File path to query" },
                    "line": { "type": "integer", "description": "Line number (0-based)" },
                    "col": { "type": "integer", "description": "Column number (0-based)" }
                },
                "required": ["action", "path"]
            }),
        ),
    ]
}

pub(super) async fn code_intelligence_tool(args: &serde_json::Value) -> String {
    let action = args["action"].as_str().unwrap_or("");
    let path = args["path"].as_str().unwrap_or("");
    let line = args["line"].as_u64().unwrap_or(0) as u32;
    let col = args["col"].as_u64().unwrap_or(0) as u32;

    if path.is_empty() {
        return "Error: path is required".into();
    }

    use crate::engine::coding::lsp_client::LspRegistry;
    use std::sync::OnceLock;
    use std::sync::Mutex;

    static LSP: OnceLock<Mutex<LspRegistry>> = OnceLock::new();
    let registry_mutex = LSP.get_or_init(|| Mutex::new(LspRegistry::new()));
    let mut registry = match registry_mutex.lock() {
        Ok(r) => r,
        Err(_) => return "Error: LSP registry lock poisoned".into(),
    };

    let language = match LspRegistry::language_for_path(path) {
        Some(l) => l.to_string(),
        None => return format!("Error: unsupported file type for {path}"),
    };

    let workspace = super::USER_WORKSPACE.get()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".into());

    let client = match registry.get_or_start(&language, &workspace) {
        Ok(c) => c,
        Err(e) => return format!("Error: Failed to start LSP for {language}: {e}"),
    };

    match action {
        "diagnostics" => {
            let diags = client.diagnostics(path);
            if diags.is_empty() {
                format!("No diagnostics for {path}")
            } else {
                diags.iter()
                    .map(|d| format!("{}:{}:{} [{}] {}", d.path, d.line, d.col, d.severity, d.message))
                    .collect::<Vec<_>>()
                    .join("\n")
            }
        }
        "hover" => {
            match client.hover(path, line, col) {
                Ok(Some(hover)) => {
                    if let Some(ref lang) = hover.language {
                        format!("```{lang}\n{}\n```", hover.content)
                    } else {
                        hover.content
                    }
                }
                Ok(None) => "No hover information available".into(),
                Err(e) => format!("Error: {e}"),
            }
        }
        "definition" => {
            match client.definition(path, line, col) {
                Ok(locs) => {
                    if locs.is_empty() { "No definition found".into() }
                    else { locs.iter().map(|l| format!("{}:{}:{}", l.path, l.line, l.col)).collect::<Vec<_>>().join("\n") }
                }
                Err(e) => format!("Error: {e}"),
            }
        }
        "references" => {
            match client.references(path, line, col) {
                Ok(locs) => {
                    if locs.is_empty() { "No references found".into() }
                    else {
                        let count = locs.len();
                        let list: String = locs.iter().take(20).map(|l| format!("  {}:{}:{}", l.path, l.line, l.col)).collect::<Vec<_>>().join("\n");
                        if count > 20 { format!("{count} references (first 20):\n{list}\n  ...") }
                        else { format!("{count} references:\n{list}") }
                    }
                }
                Err(e) => format!("Error: {e}"),
            }
        }
        "completion" => {
            match client.completion(path, line, col) {
                Ok(items) => {
                    if items.is_empty() { "No completions".into() }
                    else {
                        items.iter().take(15).map(|c| {
                            let kind = c.kind.as_deref().unwrap_or("?");
                            let detail = c.detail.as_deref().unwrap_or("");
                            if detail.is_empty() { format!("{} ({})", c.label, kind) }
                            else { format!("{} ({}) — {}", c.label, kind, detail) }
                        }).collect::<Vec<_>>().join("\n")
                    }
                }
                Err(e) => format!("Error: {e}"),
            }
        }
        "symbols" => {
            match client.symbols(path) {
                Ok(syms) => {
                    if syms.is_empty() { "No symbols found".into() }
                    else { syms.iter().map(|s| format!("{} ({}) at {}:{}", s.name, s.kind, s.path, s.line)).collect::<Vec<_>>().join("\n") }
                }
                Err(e) => format!("Error: {e}"),
            }
        }
        _ => format!("Unknown action: {action}"),
    }
}
