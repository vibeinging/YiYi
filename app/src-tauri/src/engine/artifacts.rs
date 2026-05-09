//! Tool-produced visual artifacts (screenshots, generated images, charts).
//!
//! Artifacts are first-class conversation objects:
//! - Saved on disk under `<internal_dir>/artifacts/<session_id>/<uuid>.<ext>`
//! - Persisted in tool message metadata so they survive session reloads
//! - Surfaced in the chat stream as inline cards (not buried in the tool panel)
//!
//! Sits in the engine layer so core.rs (the agent loop) can save artifacts
//! without depending on the commands layer.

use std::path::Path;

use super::react_agent::ToolArtifact;

/// Save a tool-produced visual artifact and return a `ToolArtifact` referencing
/// it. `data_uri` must be a `data:<mime>;base64,...` URI; tools that emit raw
/// bytes should wrap before calling.
///
/// Returns `None` only on filesystem failure or malformed input — callers can
/// treat that as "skip this artifact" without aborting the tool result.
pub fn save_tool_artifact(
    internal_dir: &Path,
    session_id: &str,
    tool_name: &str,
    data_uri: &str,
) -> Option<ToolArtifact> {
    use base64::Engine;
    let (mime, b64) = parse_data_uri(data_uri)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .ok()?;

    let safe_session = sanitize_session_id(session_id);
    let dir = internal_dir.join("artifacts").join(&safe_session);
    std::fs::create_dir_all(&dir).ok()?;

    let ext = mime_to_ext(&mime);
    let id = uuid::Uuid::new_v4().simple().to_string();
    let filename = format!("{}.{}", id, ext);
    let full_path = dir.join(&filename);
    std::fs::write(&full_path, &bytes).ok()?;

    Some(ToolArtifact {
        mime_type: mime,
        path: format!("artifacts/{}/{}", safe_session, filename),
        name: format!("{}.{}", tool_name, ext),
    })
}

/// Parse `data:<mime>;base64,<data>` → `(mime, data)`. Returns `None` on
/// malformed URIs — we don't try to be lenient.
fn parse_data_uri(uri: &str) -> Option<(String, String)> {
    let rest = uri.strip_prefix("data:")?;
    let (header, payload) = rest.split_once(',')?;
    let header = header.strip_suffix(";base64")?;
    let mime = if header.is_empty() {
        "application/octet-stream".to_string()
    } else {
        header.to_string()
    };
    Some((mime, payload.to_string()))
}

fn sanitize_session_id(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

fn mime_to_ext(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "image/bmp" => "bmp",
        _ => "bin",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_data_uri_strips_prefix_and_base64_marker() {
        let (mime, data) = parse_data_uri("data:image/png;base64,abc=").unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(data, "abc=");
    }

    #[test]
    fn parse_data_uri_rejects_non_base64() {
        assert!(parse_data_uri("data:image/png,abc=").is_none());
    }

    #[test]
    fn parse_data_uri_rejects_garbage() {
        assert!(parse_data_uri("not a data uri").is_none());
    }

    #[test]
    fn save_writes_a_file_under_session_dir() {
        let tmp = tempfile::tempdir().unwrap();
        // 1×1 transparent PNG
        let uri = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";
        let art = save_tool_artifact(tmp.path(), "sess-1", "desktop_screenshot", uri).unwrap();
        assert_eq!(art.mime_type, "image/png");
        assert!(art.path.starts_with("artifacts/sess-1/"));
        assert!(art.path.ends_with(".png"));
        let full = tmp.path().join(&art.path);
        assert!(full.exists());
        assert!(std::fs::metadata(&full).unwrap().len() > 0);
    }

    #[test]
    fn sanitize_session_id_strips_path_separators() {
        // Three "../" groups (9 chars) + "etc" + "/" + "passwd"
        // → 9 underscores + "etc" + "_" + "passwd"
        assert_eq!(sanitize_session_id("../../../etc/passwd"), "_________etc_passwd");
        assert_eq!(sanitize_session_id("ok-id_42"), "ok-id_42");
        // Confirm no path separator can survive — directory traversal
        // attempts must be flattened, not preserved.
        assert!(!sanitize_session_id("a/b").contains('/'));
        assert!(!sanitize_session_id("a..b").contains('.'));
    }
}
