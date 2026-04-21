//! API key storage — plaintext in SQLite (no keychain).

/// Legacy sentinel value. If found in DB, key was lost during keychain migration.
pub const KEYCHAIN_SENTINEL: &str = "__KEYCHAIN__";

/// Resolve key: if sentinel found, key is missing (return None so user re-enters).
pub fn resolve_key(_provider_id: &str, db_value: Option<&str>) -> Option<String> {
    match db_value {
        Some(KEYCHAIN_SENTINEL) => {
            log::warn!("Found keychain sentinel — API key needs to be re-entered");
            None
        }
        Some(raw) if !raw.is_empty() => Some(raw.to_string()),
        _ => None,
    }
}
