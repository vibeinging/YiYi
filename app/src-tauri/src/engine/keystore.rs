//! Secure API key storage using OS keychain.
//!
//! Keys are stored in macOS Keychain / Windows Credential Manager / Linux Secret Service.
//! SQLite only stores a sentinel value indicating the key exists in the keychain.

const SERVICE_NAME: &str = "com.yiyi.desktop";

/// Sentinel value stored in SQLite to indicate the real key is in OS keychain.
pub const KEYCHAIN_SENTINEL: &str = "__KEYCHAIN__";

/// Store an API key in the OS keychain.
pub fn store_key(provider_id: &str, api_key: &str) -> Result<(), String> {
    if api_key.is_empty() {
        return Ok(());
    }
    let entry = keyring::Entry::new(SERVICE_NAME, provider_id)
        .map_err(|e| format!("Keychain entry error: {e}"))?;
    entry.set_password(api_key)
        .map_err(|e| format!("Failed to store key in keychain: {e}"))?;
    log::info!("API key for '{}' stored in OS keychain", provider_id);
    Ok(())
}

/// Retrieve an API key from the OS keychain.
pub fn get_key(provider_id: &str) -> Option<String> {
    let entry = keyring::Entry::new(SERVICE_NAME, provider_id).ok()?;
    match entry.get_password() {
        Ok(key) => Some(key),
        Err(keyring::Error::NoEntry) => None,
        Err(e) => {
            log::warn!("Keychain read error for '{}': {}", provider_id, e);
            None
        }
    }
}

/// Delete an API key from the OS keychain.
pub fn delete_key(provider_id: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE_NAME, provider_id)
        .map_err(|e| format!("Keychain entry error: {e}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // already gone
        Err(e) => Err(format!("Failed to delete key from keychain: {e}")),
    }
}

/// Resolve an API key: if the DB value is the sentinel, fetch from keychain.
/// Otherwise return the DB value as-is (legacy plaintext keys work until
/// the user next saves settings, at which point `upsert_provider_setting`
/// migrates them to the keychain).
pub fn resolve_key(provider_id: &str, db_value: Option<&str>) -> Option<String> {
    match db_value {
        Some(KEYCHAIN_SENTINEL) => {
            match get_key(provider_id) {
                Some(key) => Some(key),
                None => {
                    log::warn!("Keychain sentinel found for '{}' but key not in keychain — please re-enter your API key", provider_id);
                    None
                }
            }
        }
        Some(raw) if !raw.is_empty() => Some(raw.to_string()),
        _ => None,
    }
}

/// Check if the keychain backend is available on this platform.
pub fn is_available() -> bool {
    keyring::Entry::new(SERVICE_NAME, "__test__").is_ok()
}
