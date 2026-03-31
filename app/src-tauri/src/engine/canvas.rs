//! Live Canvas / A2UI — structured UI components that the Agent can render in chat.
//!
//! The Agent calls the `render_canvas` tool with a JSON array of `CanvasComponent`s.
//! The tool emits a `chat://canvas` Tauri event so the frontend can render them.

use serde::{Deserialize, Serialize};

/// A single UI component the Agent can render.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CanvasComponent {
    /// Information card with title, description, optional image/tags.
    Card {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        title: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        image: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        accent: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        tags: Option<Vec<String>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        footer: Option<String>,
    },
    /// Multi-step status panel (pipeline / progress indicator).
    Status {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        steps: Vec<StatusStep>,
    },
    /// Data table.
    Table {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        headers: Vec<String>,
        rows: Vec<Vec<serde_json::Value>>,
    },
    /// Action buttons that trigger a callback to the Agent.
    Actions {
        id: String,
        buttons: Vec<ActionButton>,
    },
    /// Simple list with title, subtitle, optional icon/badge.
    List {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        items: Vec<ListItem>,
    },
    /// Form for collecting structured user input.
    Form {
        id: String,
        title: String,
        fields: Vec<FormField>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusStep {
    pub label: String,
    pub status: StepStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    Pending,
    Running,
    Done,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionButton {
    pub label: String,
    pub action: String,
    #[serde(default = "default_variant")]
    pub variant: ButtonVariant,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ButtonVariant {
    Primary,
    Secondary,
    Danger,
}

fn default_variant() -> ButtonVariant {
    ButtonVariant::Primary
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListItem {
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub badge: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FormField {
    pub name: String,
    pub label: String,
    #[serde(default = "default_text", rename = "field_type")]
    pub field_type: FormFieldType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<String>>,
    #[serde(default)]
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FormFieldType {
    Text,
    Email,
    Number,
    Select,
    Textarea,
    Toggle,
}

fn default_text() -> FormFieldType {
    FormFieldType::Text
}

/// Payload sent via the `chat://canvas` Tauri event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CanvasEvent {
    pub canvas_id: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub components: Vec<CanvasComponent>,
}
