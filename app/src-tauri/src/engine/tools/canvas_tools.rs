//! `render_canvas` tool — lets the Agent render structured UI components in chat.

use crate::engine::canvas::{CanvasComponent, CanvasEvent};
use tauri::Emitter;

pub fn definitions() -> Vec<super::ToolDefinition> {
    vec![super::tool_def(
        "render_canvas",
        "Render interactive UI components in the chat. Use this to display structured information like cards, tables, status panels, action buttons, lists, and forms. Each component is a JSON object with a 'type' and type-specific 'props'. Supported types: card, status, table, actions, list, form.",
        serde_json::json!({
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "Optional title for the canvas panel"
                },
                "components": {
                    "type": "array",
                    "description": "Array of UI components to render",
                    "items": {
                        "type": "object",
                        "properties": {
                            "type": {
                                "type": "string",
                                "enum": ["card", "status", "table", "actions", "list", "form"],
                                "description": "Component type"
                            },
                            "id": {
                                "type": "string",
                                "description": "Optional ID for callback routing (required for 'actions' and 'form')"
                            },
                            "title": {
                                "type": "string",
                                "description": "Title text (used by card, form)"
                            },
                            "description": {
                                "type": "string",
                                "description": "Description text (used by card)"
                            },
                            "image": {
                                "type": "string",
                                "description": "Image URL or base64 data URI (used by card)"
                            },
                            "accent": {
                                "type": "string",
                                "description": "Left border accent color, e.g. '#3B82F6' (used by card)"
                            },
                            "tags": {
                                "type": "array",
                                "items": { "type": "string" },
                                "description": "Tag labels (used by card)"
                            },
                            "footer": {
                                "type": "string",
                                "description": "Footer text (used by card)"
                            },
                            "steps": {
                                "type": "array",
                                "description": "Status steps (used by status)",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "label": { "type": "string" },
                                        "status": { "type": "string", "enum": ["pending", "running", "done", "error"] },
                                        "detail": { "type": "string" }
                                    },
                                    "required": ["label", "status"]
                                }
                            },
                            "headers": {
                                "type": "array",
                                "items": { "type": "string" },
                                "description": "Column headers (used by table)"
                            },
                            "rows": {
                                "type": "array",
                                "items": { "type": "array", "items": {} },
                                "description": "Row data as array of arrays (used by table)"
                            },
                            "buttons": {
                                "type": "array",
                                "description": "Action buttons (used by actions)",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "label": { "type": "string" },
                                        "action": { "type": "string", "description": "Action identifier sent back to you when clicked" },
                                        "variant": { "type": "string", "enum": ["primary", "secondary", "danger"], "default": "primary" }
                                    },
                                    "required": ["label", "action"]
                                }
                            },
                            "items": {
                                "type": "array",
                                "description": "List items (used by list)",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "title": { "type": "string" },
                                        "subtitle": { "type": "string" },
                                        "icon": { "type": "string", "description": "Lucide icon name" },
                                        "badge": { "type": "string" }
                                    },
                                    "required": ["title"]
                                }
                            },
                            "fields": {
                                "type": "array",
                                "description": "Form fields (used by form)",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "name": { "type": "string" },
                                        "label": { "type": "string" },
                                        "field_type": { "type": "string", "enum": ["text", "email", "number", "select", "textarea", "toggle"], "default": "text" },
                                        "placeholder": { "type": "string" },
                                        "options": { "type": "array", "items": { "type": "string" } },
                                        "required": { "type": "boolean", "default": false }
                                    },
                                    "required": ["name", "label"]
                                }
                            }
                        },
                        "required": ["type"]
                    }
                }
            },
            "required": ["components"]
        }),
    )]
}

pub async fn render_canvas_tool(args: &serde_json::Value) -> String {
    let components_raw = match args.get("components") {
        Some(c) => c,
        None => return "Error: 'components' is required".to_string(),
    };

    let components: Vec<CanvasComponent> = match serde_json::from_value(components_raw.clone()) {
        Ok(c) => c,
        Err(e) => return format!("Error: invalid components schema: {}", e),
    };

    if components.is_empty() {
        return "Error: at least one component is required".to_string();
    }

    let count = components.len();
    let canvas_id = uuid::Uuid::new_v4().to_string();
    let title = args.get("title").and_then(|v| v.as_str()).map(String::from);

    let session_id = super::TASK_SESSION_ID
        .try_with(|s| s.clone())
        .unwrap_or_default();

    // Emit canvas event to frontend
    if let Some(handle) = super::get_app_handle() {
        let event = CanvasEvent {
            canvas_id: canvas_id.clone(),
            session_id: session_id.clone(),
            title,
            components,
        };
        let _ = handle.emit("chat://canvas", &event);
    }

    format!(
        "Canvas rendered successfully with {} component(s). canvas_id: {}",
        count, canvas_id
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn missing_components_is_rejected() {
        let out = render_canvas_tool(&serde_json::json!({})).await;
        assert!(out.starts_with("Error: 'components' is required"));
    }

    #[tokio::test]
    async fn empty_components_array_is_rejected() {
        let out = render_canvas_tool(&serde_json::json!({ "components": [] })).await;
        assert!(out.contains("at least one component"));
    }

    #[tokio::test]
    async fn invalid_schema_is_reported() {
        let out = render_canvas_tool(&serde_json::json!({
            "components": [{ "type": "not-a-real-type" }],
        })).await;
        assert!(out.starts_with("Error: invalid components schema"));
    }

    #[tokio::test]
    async fn valid_components_return_success_message() {
        // No AppHandle registered in unit test → emit is silently skipped.
        let out = render_canvas_tool(&serde_json::json!({
            "title": "Test",
            "components": [
                { "type": "card", "title": "Hello" },
            ],
        })).await;
        assert!(out.contains("Canvas rendered successfully"));
        assert!(out.contains("1 component"));
        assert!(out.contains("canvas_id:"));
    }

    #[test]
    fn definitions_expose_render_canvas() {
        let defs = definitions();
        assert!(defs.iter().any(|d| d.function.name == "render_canvas"));
    }
}
