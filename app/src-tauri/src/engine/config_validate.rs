use serde_json::Value;

// ---------------------------------------------------------------------------
// Diagnostic types
// ---------------------------------------------------------------------------

/// Classification of a config diagnostic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiagnosticKind {
    UnknownKey,
    WrongType,
    Deprecated { replacement: String },
}

/// Severity level for a diagnostic.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiagnosticSeverity {
    Error,
    Warning,
}

/// A single diagnostic emitted during config validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigDiagnostic {
    pub kind: DiagnosticKind,
    pub severity: DiagnosticSeverity,
    pub field: String,
    pub message: String,
    pub suggestion: Option<String>,
}

impl std::fmt::Display for ConfigDiagnostic {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let level = match self.severity {
            DiagnosticSeverity::Error => "error",
            DiagnosticSeverity::Warning => "warning",
        };
        write!(f, "{}: field \"{}\": {}", level, self.field, self.message)?;
        if let Some(ref suggestion) = self.suggestion {
            write!(f, " (suggestion: {})", suggestion)?;
        }
        Ok(())
    }
}

/// Aggregated validation result.
#[derive(Debug, Clone, Default)]
pub struct ValidationResult {
    pub errors: Vec<ConfigDiagnostic>,
    pub warnings: Vec<ConfigDiagnostic>,
}

impl ValidationResult {
    #[must_use]
    pub fn is_ok(&self) -> bool {
        self.errors.is_empty()
    }

    fn push_error(&mut self, diag: ConfigDiagnostic) {
        self.errors.push(diag);
    }

    fn push_warning(&mut self, diag: ConfigDiagnostic) {
        self.warnings.push(diag);
    }

    /// Format all diagnostics into a human-readable report.
    #[must_use]
    pub fn format(&self) -> String {
        let mut lines = Vec::new();
        for w in &self.warnings {
            lines.push(w.to_string());
        }
        for e in &self.errors {
            lines.push(e.to_string());
        }
        lines.join("\n")
    }
}

// ---------------------------------------------------------------------------
// Known field schema (derived from state/config.rs)
// ---------------------------------------------------------------------------

/// Expected JSON type for a field.
#[derive(Debug, Clone, Copy)]
enum FieldType {
    String,
    Bool,
    Number,
    Object,
    StringArray,
}

impl FieldType {
    fn label(self) -> &'static str {
        match self {
            Self::String => "string",
            Self::Bool => "boolean",
            Self::Number => "number",
            Self::Object => "object",
            Self::StringArray => "array of strings",
        }
    }

    fn matches(self, value: &Value) -> bool {
        match self {
            Self::String => value.is_string(),
            Self::Bool => value.is_boolean(),
            Self::Number => value.is_number(),
            Self::Object => value.is_object(),
            Self::StringArray => value
                .as_array()
                .is_some_and(|arr| arr.iter().all(|v| v.is_string())),
        }
    }
}

fn json_type_label(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

struct FieldSpec {
    name: &'static str,
    expected: FieldType,
}

struct DeprecatedField {
    name: &'static str,
    replacement: &'static str,
}

/// Top-level keys from Config struct in state/config.rs.
const TOP_LEVEL_FIELDS: &[FieldSpec] = &[
    FieldSpec {
        name: "channels",
        expected: FieldType::Object,
    },
    FieldSpec {
        name: "heartbeat",
        expected: FieldType::Object,
    },
    FieldSpec {
        name: "mcp",
        expected: FieldType::Object,
    },
    FieldSpec {
        name: "agents",
        expected: FieldType::Object,
    },
    FieldSpec {
        name: "skill_server",
        expected: FieldType::Object,
    },
    FieldSpec {
        name: "meditation",
        expected: FieldType::Object,
    },
    FieldSpec {
        name: "memme",
        expected: FieldType::Object,
    },
    FieldSpec {
        name: "cli_providers",
        expected: FieldType::Object,
    },
    FieldSpec {
        name: "buddy",
        expected: FieldType::Object,
    },
];

const HEARTBEAT_FIELDS: &[FieldSpec] = &[
    FieldSpec {
        name: "enabled",
        expected: FieldType::Bool,
    },
    FieldSpec {
        name: "every",
        expected: FieldType::String,
    },
    FieldSpec {
        name: "target",
        expected: FieldType::String,
    },
    FieldSpec {
        name: "active_hours",
        expected: FieldType::Object,
    },
];

const AGENTS_FIELDS: &[FieldSpec] = &[
    FieldSpec {
        name: "language",
        expected: FieldType::String,
    },
    FieldSpec {
        name: "max_iterations",
        expected: FieldType::Number,
    },
    FieldSpec {
        name: "max_input_length",
        expected: FieldType::Number,
    },
    FieldSpec {
        name: "workspace_dir",
        expected: FieldType::String,
    },
];

const SKILL_SERVER_FIELDS: &[FieldSpec] = &[
    FieldSpec {
        name: "expose_as_mcp",
        expected: FieldType::Bool,
    },
    FieldSpec {
        name: "host",
        expected: FieldType::String,
    },
    FieldSpec {
        name: "port",
        expected: FieldType::Number,
    },
    FieldSpec {
        name: "skills",
        expected: FieldType::StringArray,
    },
];

const MEDITATION_FIELDS: &[FieldSpec] = &[
    FieldSpec {
        name: "enabled",
        expected: FieldType::Bool,
    },
    FieldSpec {
        name: "start_time",
        expected: FieldType::String,
    },
    FieldSpec {
        name: "notify_on_complete",
        expected: FieldType::Bool,
    },
];

const MEMME_FIELDS: &[FieldSpec] = &[
    FieldSpec {
        name: "embedding_provider",
        expected: FieldType::String,
    },
    FieldSpec {
        name: "embedding_model",
        expected: FieldType::String,
    },
    FieldSpec {
        name: "embedding_api_key",
        expected: FieldType::String,
    },
    FieldSpec {
        name: "embedding_base_url",
        expected: FieldType::String,
    },
    FieldSpec {
        name: "embedding_dims",
        expected: FieldType::Number,
    },
    FieldSpec {
        name: "enable_graph",
        expected: FieldType::Bool,
    },
    FieldSpec {
        name: "enable_forgetting_curve",
        expected: FieldType::Bool,
    },
    FieldSpec {
        name: "extraction_depth",
        expected: FieldType::String,
    },
];

const BUDDY_FIELDS: &[FieldSpec] = &[
    FieldSpec {
        name: "name",
        expected: FieldType::String,
    },
    FieldSpec {
        name: "personality",
        expected: FieldType::String,
    },
    FieldSpec {
        name: "hatched_at",
        expected: FieldType::Number,
    },
    FieldSpec {
        name: "muted",
        expected: FieldType::Bool,
    },
    FieldSpec {
        name: "buddy_user_id",
        expected: FieldType::String,
    },
    FieldSpec {
        name: "stats_delta",
        expected: FieldType::Object,
    },
    FieldSpec {
        name: "interaction_count",
        expected: FieldType::Number,
    },
];

/// No deprecated fields yet, but the infrastructure is ready.
const DEPRECATED_FIELDS: &[DeprecatedField] = &[];

// ---------------------------------------------------------------------------
// Fuzzy suggestion via edit distance
// ---------------------------------------------------------------------------

fn suggest_field(input: &str, candidates: &[&str]) -> Option<String> {
    let input_lower = input.to_ascii_lowercase();
    candidates
        .iter()
        .filter_map(|candidate| {
            let dist = edit_distance(&input_lower, &candidate.to_ascii_lowercase());
            (dist <= 3).then_some((dist, *candidate))
        })
        .min_by_key(|(d, _)| *d)
        .map(|(_, name)| name.to_string())
}

fn edit_distance(a: &str, b: &str) -> usize {
    if a.is_empty() {
        return b.len();
    }
    if b.is_empty() {
        return a.len();
    }

    let b_chars: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b_chars.len()).collect();
    let mut curr = vec![0; b_chars.len() + 1];

    for (i, a_ch) in a.chars().enumerate() {
        curr[0] = i + 1;
        for (j, b_ch) in b_chars.iter().enumerate() {
            let cost = usize::from(a_ch != *b_ch);
            curr[j + 1] = (prev[j + 1] + 1).min(curr[j] + 1).min(prev[j] + cost);
        }
        prev.clone_from(&curr);
    }

    prev[b_chars.len()]
}

// ---------------------------------------------------------------------------
// Core validation
// ---------------------------------------------------------------------------

fn validate_object_keys(
    obj: &serde_json::Map<String, Value>,
    known: &[FieldSpec],
    prefix: &str,
    result: &mut ValidationResult,
) {
    let known_names: Vec<&str> = known.iter().map(|f| f.name).collect();

    for (key, value) in obj {
        let field_path = if prefix.is_empty() {
            key.clone()
        } else {
            format!("{prefix}.{key}")
        };

        // Check deprecated first
        if let Some(dep) = DEPRECATED_FIELDS.iter().find(|d| d.name == key.as_str()) {
            result.push_warning(ConfigDiagnostic {
                kind: DiagnosticKind::Deprecated {
                    replacement: dep.replacement.to_string(),
                },
                severity: DiagnosticSeverity::Warning,
                field: field_path,
                message: format!(
                    "\"{}\" is deprecated, use \"{}\" instead",
                    key, dep.replacement
                ),
                suggestion: Some(dep.replacement.to_string()),
            });
            continue;
        }

        if let Some(spec) = known.iter().find(|f| f.name == key.as_str()) {
            // Type check
            if !spec.expected.matches(value) {
                result.push_error(ConfigDiagnostic {
                    kind: DiagnosticKind::WrongType,
                    severity: DiagnosticSeverity::Error,
                    field: field_path,
                    message: format!(
                        "expected {}, got {}",
                        spec.expected.label(),
                        json_type_label(value)
                    ),
                    suggestion: None,
                });
            }
        } else {
            // Unknown key
            let suggestion = suggest_field(key, &known_names);
            result.push_error(ConfigDiagnostic {
                kind: DiagnosticKind::UnknownKey,
                severity: DiagnosticSeverity::Error,
                field: field_path.clone(),
                message: format!("unknown config key \"{}\"", key),
                suggestion,
            });
        }
    }
}

/// Validate a config JSON value against the known YiYi config schema.
///
/// Returns diagnostics (errors for unknown keys / wrong types, warnings for
/// deprecated fields) without blocking config load.
pub fn validate_config(config: &Value) -> ValidationResult {
    let mut result = ValidationResult::default();

    let obj = match config.as_object() {
        Some(o) => o,
        None => {
            result.push_error(ConfigDiagnostic {
                kind: DiagnosticKind::WrongType,
                severity: DiagnosticSeverity::Error,
                field: "<root>".into(),
                message: "config must be a JSON object".into(),
                suggestion: None,
            });
            return result;
        }
    };

    validate_object_keys(obj, TOP_LEVEL_FIELDS, "", &mut result);

    // Validate known nested objects
    let nested: &[(&str, &[FieldSpec])] = &[
        ("heartbeat", HEARTBEAT_FIELDS),
        ("agents", AGENTS_FIELDS),
        ("skill_server", SKILL_SERVER_FIELDS),
        ("meditation", MEDITATION_FIELDS),
        ("memme", MEMME_FIELDS),
        ("buddy", BUDDY_FIELDS),
    ];

    for (key, fields) in nested {
        if let Some(inner) = obj.get(*key).and_then(Value::as_object) {
            validate_object_keys(inner, fields, key, &mut result);
        }
    }

    result
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn val(json: &str) -> Value {
        serde_json::from_str(json).expect("valid json")
    }

    #[test]
    fn valid_config_produces_no_diagnostics() {
        let config = val(r#"{
            "channels": {},
            "heartbeat": {"enabled": true, "every": "6h", "target": "main"},
            "agents": {"language": "zh", "max_iterations": 10},
            "meditation": {"enabled": true, "start_time": "23:00", "notify_on_complete": true}
        }"#);

        let result = validate_config(&config);

        assert!(result.is_ok());
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn detects_unknown_top_level_key() {
        let config = val(r#"{"channels": {}, "unknown_key": true}"#);

        let result = validate_config(&config);

        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].field, "unknown_key");
        assert!(matches!(result.errors[0].kind, DiagnosticKind::UnknownKey));
    }

    #[test]
    fn detects_wrong_type() {
        let config = val(r#"{"heartbeat": "not_an_object"}"#);

        let result = validate_config(&config);

        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].field, "heartbeat");
        assert!(matches!(result.errors[0].kind, DiagnosticKind::WrongType));
        assert!(result.errors[0].message.contains("expected object"));
        assert!(result.errors[0].message.contains("got string"));
    }

    #[test]
    fn detects_wrong_type_in_nested_field() {
        let config = val(r#"{"agents": {"max_iterations": "ten"}}"#);

        let result = validate_config(&config);

        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].field, "agents.max_iterations");
        assert!(result.errors[0].message.contains("expected number"));
    }

    #[test]
    fn detects_unknown_nested_key() {
        let config = val(r#"{"meditation": {"enabled": true, "bogus_field": 42}}"#);

        let result = validate_config(&config);

        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].field, "meditation.bogus_field");
    }

    #[test]
    fn suggests_close_field_name() {
        let config = val(r#"{"chanels": {}}"#);

        let result = validate_config(&config);

        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].suggestion, Some("channels".to_string()));
    }

    #[test]
    fn rejects_non_object_root() {
        let config = val(r#""just a string""#);

        let result = validate_config(&config);

        assert_eq!(result.errors.len(), 1);
        assert!(result.errors[0].message.contains("must be a JSON object"));
    }

    #[test]
    fn validates_memme_fields() {
        let config =
            val(r#"{"memme": {"embedding_provider": "openai", "embedding_dims": "wrong"}}"#);

        let result = validate_config(&config);

        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].field, "memme.embedding_dims");
    }

    #[test]
    fn validates_buddy_fields() {
        let config = val(r#"{"buddy": {"name": "Sprocket", "muted": "yes"}}"#);

        let result = validate_config(&config);

        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].field, "buddy.muted");
        assert!(result.errors[0].message.contains("expected boolean"));
    }

    #[test]
    fn validates_skill_server_fields() {
        let config = val(r#"{"skill_server": {"expose_as_mcp": true, "port": "9315"}}"#);

        let result = validate_config(&config);

        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].field, "skill_server.port");
    }

    #[test]
    fn format_produces_readable_output() {
        let config = val(r#"{"unknown": 1, "agents": {"bad": true}}"#);

        let result = validate_config(&config);
        let output = result.format();

        assert!(output.contains("error:"));
        assert!(output.contains("unknown"));
    }

    #[test]
    fn multiple_errors_across_levels() {
        let config = val(r#"{
            "bad_top": 1,
            "heartbeat": {"enabled": "wrong", "bad_nested": true}
        }"#);

        let result = validate_config(&config);

        // bad_top (unknown), enabled (wrong type), bad_nested (unknown)
        assert_eq!(result.errors.len(), 3);
    }
}
