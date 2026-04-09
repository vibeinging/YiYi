//! LSP (Language Server Protocol) client for YiYi.
//!
//! Provides a lightweight LSP client that communicates with language servers
//! over JSON-RPC (stdin/stdout) and an `LspRegistry` to manage multiple servers.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write as IoWrite};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------------------------------------------------------------------------
// LSP Action enum
// ---------------------------------------------------------------------------

/// The 7 supported LSP actions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LspAction {
    Diagnostics,
    Hover,
    Definition,
    References,
    Completion,
    Symbols,
    Format,
}

impl LspAction {
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "diagnostics" => Some(Self::Diagnostics),
            "hover" => Some(Self::Hover),
            "definition" | "goto_definition" => Some(Self::Definition),
            "references" | "find_references" => Some(Self::References),
            "completion" | "completions" => Some(Self::Completion),
            "symbols" | "document_symbols" => Some(Self::Symbols),
            "format" | "formatting" => Some(Self::Format),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LspDiagnostic {
    pub path: String,
    pub line: u32,
    pub col: u32,
    pub severity: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LspHover {
    pub content: String,
    pub language: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LspLocation {
    pub path: String,
    pub line: u32,
    pub col: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LspSymbol {
    pub name: String,
    pub kind: String,
    pub path: String,
    pub line: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LspCompletion {
    pub label: String,
    pub kind: Option<String>,
    pub detail: Option<String>,
}

// ---------------------------------------------------------------------------
// Server status
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LspServerStatus {
    Disconnected,
    Starting,
    Connected,
    Error(String),
}

impl std::fmt::Display for LspServerStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Disconnected => write!(f, "disconnected"),
            Self::Starting => write!(f, "starting"),
            Self::Connected => write!(f, "connected"),
            Self::Error(msg) => write!(f, "error: {msg}"),
        }
    }
}

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

/// Encode a JSON-RPC message with `Content-Length` header and write it.
fn jsonrpc_write(writer: &mut impl IoWrite, body: &Value) -> Result<(), String> {
    let payload = serde_json::to_string(body).map_err(|e| format!("serialize: {e}"))?;
    let header = format!("Content-Length: {}\r\n\r\n", payload.len());
    writer
        .write_all(header.as_bytes())
        .map_err(|e| format!("write header: {e}"))?;
    writer
        .write_all(payload.as_bytes())
        .map_err(|e| format!("write body: {e}"))?;
    writer.flush().map_err(|e| format!("flush: {e}"))?;
    Ok(())
}

/// Read one JSON-RPC message from a buffered reader.
fn jsonrpc_read(reader: &mut BufReader<impl std::io::Read>) -> Result<Value, String> {
    // Read headers until blank line.
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .map_err(|e| format!("read header line: {e}"))?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }
        if let Some(val) = trimmed.strip_prefix("Content-Length:") {
            content_length = Some(
                val.trim()
                    .parse::<usize>()
                    .map_err(|e| format!("parse Content-Length: {e}"))?,
            );
        }
    }

    let len = content_length.ok_or_else(|| "missing Content-Length header".to_string())?;
    let mut buf = vec![0u8; len];
    reader
        .read_exact(&mut buf)
        .map_err(|e| format!("read body: {e}"))?;
    let body: Value = serde_json::from_slice(&buf).map_err(|e| format!("parse body: {e}"))?;
    Ok(body)
}

// ---------------------------------------------------------------------------
// Use std::io::Read for read_exact
// ---------------------------------------------------------------------------
use std::io::Read as _;

// ---------------------------------------------------------------------------
// LspClient
// ---------------------------------------------------------------------------

/// A client for a single LSP server process.
pub struct LspClient {
    child: Child,
    stdin: std::process::ChildStdin,
    reader: BufReader<std::process::ChildStdout>,
    next_id: AtomicU64,
    status: LspServerStatus,
    root_path: String,
    /// Cached diagnostics received via notifications.
    diagnostics: Vec<LspDiagnostic>,
}

impl std::fmt::Debug for LspClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LspClient")
            .field("status", &self.status)
            .field("root_path", &self.root_path)
            .finish()
    }
}

impl LspClient {
    /// Spawn an LSP server process.
    pub fn start(command: &str, args: &[&str], root_path: &str) -> Result<Self, String> {
        let mut child = Command::new(command)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("failed to spawn LSP server `{command}`: {e}"))?;

        let stdin = child.stdin.take().ok_or("failed to open stdin")?;
        let stdout = child.stdout.take().ok_or("failed to open stdout")?;
        let reader = BufReader::new(stdout);

        Ok(Self {
            child,
            stdin,
            reader,
            next_id: AtomicU64::new(1),
            status: LspServerStatus::Starting,
            root_path: root_path.to_string(),
            diagnostics: Vec::new(),
        })
    }

    /// Send a JSON-RPC request and wait for the response.
    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let msg = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        jsonrpc_write(&mut self.stdin, &msg)?;

        // Read responses, skipping notifications, until we get our response id.
        loop {
            let resp = jsonrpc_read(&mut self.reader)?;
            // Notifications have no "id" field — collect diagnostics if present.
            if resp.get("id").is_none() {
                self.handle_notification(&resp);
                continue;
            }
            if resp.get("id").and_then(|v| v.as_u64()) == Some(id) {
                if let Some(err) = resp.get("error") {
                    return Err(format!(
                        "LSP error: {}",
                        err.get("message")
                            .and_then(|m| m.as_str())
                            .unwrap_or("unknown")
                    ));
                }
                return Ok(resp.get("result").cloned().unwrap_or(Value::Null));
            }
            // Response for a different id — skip (shouldn't happen in sync usage).
        }
    }

    /// Send a JSON-RPC notification (no response expected).
    fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        let msg = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        jsonrpc_write(&mut self.stdin, &msg)
    }

    /// Handle an incoming notification from the server.
    fn handle_notification(&mut self, msg: &Value) {
        let method = match msg.get("method").and_then(|m| m.as_str()) {
            Some(m) => m,
            None => return,
        };
        if method == "textDocument/publishDiagnostics" {
            if let Some(params) = msg.get("params") {
                self.collect_diagnostics(params);
            }
        }
    }

    fn collect_diagnostics(&mut self, params: &Value) {
        let uri = match params.get("uri").and_then(|u| u.as_str()) {
            Some(u) => u,
            None => return,
        };
        let path = uri.strip_prefix("file://").unwrap_or(uri).to_string();

        // Remove old diagnostics for this path.
        self.diagnostics.retain(|d| d.path != path);

        if let Some(diags) = params.get("diagnostics").and_then(|d| d.as_array()) {
            for d in diags {
                let line = d
                    .pointer("/range/start/line")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32;
                let col = d
                    .pointer("/range/start/character")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32;
                let severity = match d.get("severity").and_then(|s| s.as_u64()) {
                    Some(1) => "error",
                    Some(2) => "warning",
                    Some(3) => "information",
                    Some(4) => "hint",
                    _ => "unknown",
                };
                let message = d
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("")
                    .to_string();

                self.diagnostics.push(LspDiagnostic {
                    path: path.clone(),
                    line,
                    col,
                    severity: severity.to_string(),
                    message,
                });
            }
        }
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /// Send the `initialize` request to the server.
    pub fn initialize(&mut self) -> Result<Value, String> {
        let params = serde_json::json!({
            "processId": std::process::id(),
            "rootUri": format!("file://{}", self.root_path),
            "capabilities": {
                "textDocument": {
                    "hover": { "contentFormat": ["markdown", "plaintext"] },
                    "completion": {
                        "completionItem": { "snippetSupport": false }
                    },
                    "definition": {},
                    "references": {},
                    "documentSymbol": {},
                    "formatting": {},
                    "publishDiagnostics": {}
                }
            }
        });
        let result = self.request("initialize", params)?;
        // Send initialized notification.
        self.notify("initialized", serde_json::json!({}))?;
        self.status = LspServerStatus::Connected;
        Ok(result)
    }

    /// Get cached diagnostics for a file path.
    pub fn diagnostics(&self, path: &str) -> Vec<LspDiagnostic> {
        self.diagnostics
            .iter()
            .filter(|d| d.path == path)
            .cloned()
            .collect()
    }

    /// Request hover information.
    pub fn hover(&mut self, path: &str, line: u32, col: u32) -> Result<Option<LspHover>, String> {
        let params = Self::text_document_position(path, line, col);
        let result = self.request("textDocument/hover", params)?;
        if result.is_null() {
            return Ok(None);
        }
        let (content, language) = Self::parse_markup_content(&result["contents"]);
        Ok(Some(LspHover { content, language }))
    }

    /// Request go-to-definition.
    pub fn definition(
        &mut self,
        path: &str,
        line: u32,
        col: u32,
    ) -> Result<Vec<LspLocation>, String> {
        let params = Self::text_document_position(path, line, col);
        let result = self.request("textDocument/definition", params)?;
        Ok(Self::parse_locations(&result))
    }

    /// Request find-references.
    pub fn references(
        &mut self,
        path: &str,
        line: u32,
        col: u32,
    ) -> Result<Vec<LspLocation>, String> {
        let mut params = Self::text_document_position(path, line, col);
        params["context"] = serde_json::json!({ "includeDeclaration": true });
        let result = self.request("textDocument/references", params)?;
        Ok(Self::parse_locations(&result))
    }

    /// Request completion items.
    pub fn completion(
        &mut self,
        path: &str,
        line: u32,
        col: u32,
    ) -> Result<Vec<LspCompletion>, String> {
        let params = Self::text_document_position(path, line, col);
        let result = self.request("textDocument/completion", params)?;

        // Result can be CompletionList { items: [...] } or directly [...].
        let items = if let Some(arr) = result.as_array() {
            arr.clone()
        } else if let Some(arr) = result.get("items").and_then(|i| i.as_array()) {
            arr.clone()
        } else {
            return Ok(Vec::new());
        };

        Ok(items
            .iter()
            .map(|item| LspCompletion {
                label: item
                    .get("label")
                    .and_then(|l| l.as_str())
                    .unwrap_or("")
                    .to_string(),
                kind: item
                    .get("kind")
                    .and_then(|k| k.as_u64())
                    .map(|k| Self::completion_kind_name(k)),
                detail: item
                    .get("detail")
                    .and_then(|d| d.as_str())
                    .map(String::from),
            })
            .collect())
    }

    /// Request document symbols.
    pub fn symbols(&mut self, path: &str) -> Result<Vec<LspSymbol>, String> {
        let params = serde_json::json!({
            "textDocument": { "uri": format!("file://{path}") }
        });
        let result = self.request("textDocument/documentSymbol", params)?;

        let arr = match result.as_array() {
            Some(a) => a,
            None => return Ok(Vec::new()),
        };

        Ok(arr
            .iter()
            .map(|sym| {
                let line = sym
                    .pointer("/range/start/line")
                    .or_else(|| sym.pointer("/location/range/start/line"))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32;
                let kind_num = sym.get("kind").and_then(|k| k.as_u64()).unwrap_or(0);
                LspSymbol {
                    name: sym
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("")
                        .to_string(),
                    kind: Self::symbol_kind_name(kind_num),
                    path: path.to_string(),
                    line,
                }
            })
            .collect())
    }

    /// Graceful shutdown: send shutdown request then exit notification.
    pub fn shutdown(&mut self) -> Result<(), String> {
        let _ = self.request("shutdown", Value::Null);
        let _ = self.notify("exit", Value::Null);
        let _ = self.child.kill();
        self.status = LspServerStatus::Disconnected;
        Ok(())
    }

    /// Current status.
    pub fn status(&self) -> &LspServerStatus {
        &self.status
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    fn text_document_position(path: &str, line: u32, col: u32) -> Value {
        serde_json::json!({
            "textDocument": { "uri": format!("file://{path}") },
            "position": { "line": line, "character": col }
        })
    }

    fn parse_markup_content(val: &Value) -> (String, Option<String>) {
        // MarkupContent { kind, value }
        if let Some(value) = val.get("value").and_then(|v| v.as_str()) {
            let lang = val.get("kind").and_then(|k| k.as_str()).map(String::from);
            return (value.to_string(), lang);
        }
        // Plain string
        if let Some(s) = val.as_str() {
            return (s.to_string(), None);
        }
        // Array of MarkedString
        if let Some(arr) = val.as_array() {
            let parts: Vec<String> = arr
                .iter()
                .map(|item| {
                    if let Some(s) = item.as_str() {
                        s.to_string()
                    } else {
                        item.get("value")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string()
                    }
                })
                .collect();
            return (parts.join("\n"), None);
        }
        (String::new(), None)
    }

    fn parse_locations(val: &Value) -> Vec<LspLocation> {
        let items = if val.is_array() {
            val.as_array().cloned().unwrap_or_default()
        } else if val.is_object() {
            vec![val.clone()]
        } else {
            return Vec::new();
        };

        items
            .iter()
            .filter_map(|loc| {
                let uri = loc.get("uri")?.as_str()?;
                let path = uri.strip_prefix("file://").unwrap_or(uri).to_string();
                let line = loc.pointer("/range/start/line")?.as_u64()? as u32;
                let col = loc.pointer("/range/start/character")?.as_u64()? as u32;
                Some(LspLocation { path, line, col })
            })
            .collect()
    }

    fn completion_kind_name(kind: u64) -> String {
        match kind {
            1 => "text",
            2 => "method",
            3 => "function",
            4 => "constructor",
            5 => "field",
            6 => "variable",
            7 => "class",
            8 => "interface",
            9 => "module",
            10 => "property",
            11 => "unit",
            12 => "value",
            13 => "enum",
            14 => "keyword",
            15 => "snippet",
            16 => "color",
            17 => "file",
            18 => "reference",
            19 => "folder",
            20 => "enum_member",
            21 => "constant",
            22 => "struct",
            23 => "event",
            24 => "operator",
            25 => "type_parameter",
            _ => "unknown",
        }
        .to_string()
    }

    fn symbol_kind_name(kind: u64) -> String {
        match kind {
            1 => "file",
            2 => "module",
            3 => "namespace",
            4 => "package",
            5 => "class",
            6 => "method",
            7 => "property",
            8 => "field",
            9 => "constructor",
            10 => "enum",
            11 => "interface",
            12 => "function",
            13 => "variable",
            14 => "constant",
            15 => "string",
            16 => "number",
            17 => "boolean",
            18 => "array",
            19 => "object",
            20 => "key",
            21 => "null",
            22 => "enum_member",
            23 => "struct",
            24 => "event",
            25 => "operator",
            26 => "type_parameter",
            _ => "unknown",
        }
        .to_string()
    }
}

impl Drop for LspClient {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

// ---------------------------------------------------------------------------
// LspRegistry — manages language → LspClient mapping
// ---------------------------------------------------------------------------

/// Registry of LSP clients keyed by language identifier.
pub struct LspRegistry {
    clients: HashMap<String, LspClient>,
    /// Default server commands per language: language → (command, args).
    defaults: HashMap<String, (String, Vec<String>)>,
}

impl std::fmt::Debug for LspRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LspRegistry")
            .field("languages", &self.clients.keys().collect::<Vec<_>>())
            .finish()
    }
}

impl Default for LspRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl LspRegistry {
    pub fn new() -> Self {
        let mut defaults: HashMap<String, (String, Vec<String>)> = HashMap::new();
        // Common defaults — users can override via `register_default`.
        defaults.insert(
            "rust".to_string(),
            ("rust-analyzer".to_string(), Vec::new()),
        );
        defaults.insert(
            "typescript".to_string(),
            (
                "typescript-language-server".to_string(),
                vec!["--stdio".to_string()],
            ),
        );
        defaults.insert(
            "javascript".to_string(),
            (
                "typescript-language-server".to_string(),
                vec!["--stdio".to_string()],
            ),
        );
        defaults.insert(
            "python".to_string(),
            ("pylsp".to_string(), Vec::new()),
        );

        Self {
            clients: HashMap::new(),
            defaults,
        }
    }

    /// Register a default server command for a language.
    pub fn register_default(&mut self, language: &str, command: &str, args: Vec<String>) {
        self.defaults
            .insert(language.to_string(), (command.to_string(), args));
    }

    /// Get an existing client, or start one using the default command.
    pub fn get_or_start(
        &mut self,
        language: &str,
        root_path: &str,
    ) -> Result<&mut LspClient, String> {
        if self.clients.contains_key(language) {
            return Ok(self.clients.get_mut(language).unwrap());
        }

        let (command, args) = self
            .defaults
            .get(language)
            .cloned()
            .ok_or_else(|| format!("no default LSP server configured for language: {language}"))?;

        let args_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        let mut client = LspClient::start(&command, &args_refs, root_path)?;
        client.initialize()?;

        self.clients.insert(language.to_string(), client);
        Ok(self.clients.get_mut(language).unwrap())
    }

    /// Get an existing client (immutable).
    pub fn get(&self, language: &str) -> Option<&LspClient> {
        self.clients.get(language)
    }

    /// Get an existing client (mutable).
    pub fn get_mut(&mut self, language: &str) -> Option<&mut LspClient> {
        self.clients.get_mut(language)
    }

    /// Disconnect and remove a client.
    pub fn disconnect(&mut self, language: &str) -> Result<(), String> {
        if let Some(mut client) = self.clients.remove(language) {
            client.shutdown()?;
        }
        Ok(())
    }

    /// Disconnect all clients.
    pub fn disconnect_all(&mut self) {
        let keys: Vec<String> = self.clients.keys().cloned().collect();
        for key in keys {
            let _ = self.disconnect(&key);
        }
    }

    /// List connected languages.
    pub fn languages(&self) -> Vec<String> {
        self.clients.keys().cloned().collect()
    }

    /// Map file extension to language identifier.
    pub fn language_for_path(path: &str) -> Option<&'static str> {
        let ext = std::path::Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        match ext {
            "rs" => Some("rust"),
            "ts" | "tsx" => Some("typescript"),
            "js" | "jsx" => Some("javascript"),
            "py" => Some("python"),
            "go" => Some("go"),
            "java" => Some("java"),
            "c" | "h" => Some("c"),
            "cpp" | "hpp" | "cc" => Some("cpp"),
            "rb" => Some("ruby"),
            "lua" => Some("lua"),
            _ => None,
        }
    }
}

impl Drop for LspRegistry {
    fn drop(&mut self) {
        self.disconnect_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_from_str_all_variants() {
        assert_eq!(LspAction::from_str("diagnostics"), Some(LspAction::Diagnostics));
        assert_eq!(LspAction::from_str("hover"), Some(LspAction::Hover));
        assert_eq!(LspAction::from_str("definition"), Some(LspAction::Definition));
        assert_eq!(LspAction::from_str("goto_definition"), Some(LspAction::Definition));
        assert_eq!(LspAction::from_str("references"), Some(LspAction::References));
        assert_eq!(LspAction::from_str("find_references"), Some(LspAction::References));
        assert_eq!(LspAction::from_str("completion"), Some(LspAction::Completion));
        assert_eq!(LspAction::from_str("completions"), Some(LspAction::Completion));
        assert_eq!(LspAction::from_str("symbols"), Some(LspAction::Symbols));
        assert_eq!(LspAction::from_str("document_symbols"), Some(LspAction::Symbols));
        assert_eq!(LspAction::from_str("format"), Some(LspAction::Format));
        assert_eq!(LspAction::from_str("formatting"), Some(LspAction::Format));
        assert_eq!(LspAction::from_str("unknown"), None);
    }

    #[test]
    fn status_display() {
        assert_eq!(LspServerStatus::Disconnected.to_string(), "disconnected");
        assert_eq!(LspServerStatus::Starting.to_string(), "starting");
        assert_eq!(LspServerStatus::Connected.to_string(), "connected");
        assert_eq!(
            LspServerStatus::Error("boom".into()).to_string(),
            "error: boom"
        );
    }

    #[test]
    fn language_for_path_mapping() {
        assert_eq!(LspRegistry::language_for_path("main.rs"), Some("rust"));
        assert_eq!(LspRegistry::language_for_path("index.ts"), Some("typescript"));
        assert_eq!(LspRegistry::language_for_path("app.tsx"), Some("typescript"));
        assert_eq!(LspRegistry::language_for_path("script.py"), Some("python"));
        assert_eq!(LspRegistry::language_for_path("Makefile"), None);
    }

    #[test]
    fn registry_defaults() {
        let registry = LspRegistry::new();
        assert!(registry.defaults.contains_key("rust"));
        assert!(registry.defaults.contains_key("typescript"));
        assert!(registry.defaults.contains_key("python"));
    }

    #[test]
    fn parse_locations_single() {
        let val = serde_json::json!({
            "uri": "file:///src/main.rs",
            "range": { "start": { "line": 10, "character": 5 }, "end": { "line": 10, "character": 15 } }
        });
        let locs = LspClient::parse_locations(&val);
        assert_eq!(locs.len(), 1);
        assert_eq!(locs[0].path, "/src/main.rs");
        assert_eq!(locs[0].line, 10);
        assert_eq!(locs[0].col, 5);
    }

    #[test]
    fn parse_locations_array() {
        let val = serde_json::json!([
            {
                "uri": "file:///a.rs",
                "range": { "start": { "line": 1, "character": 2 }, "end": { "line": 1, "character": 5 } }
            },
            {
                "uri": "file:///b.rs",
                "range": { "start": { "line": 3, "character": 0 }, "end": { "line": 3, "character": 10 } }
            }
        ]);
        let locs = LspClient::parse_locations(&val);
        assert_eq!(locs.len(), 2);
    }

    #[test]
    fn parse_markup_content_string() {
        let val = serde_json::json!("hello world");
        let (content, lang) = LspClient::parse_markup_content(&val);
        assert_eq!(content, "hello world");
        assert!(lang.is_none());
    }

    #[test]
    fn parse_markup_content_object() {
        let val = serde_json::json!({ "kind": "markdown", "value": "# Title" });
        let (content, lang) = LspClient::parse_markup_content(&val);
        assert_eq!(content, "# Title");
        assert_eq!(lang, Some("markdown".to_string()));
    }
}
