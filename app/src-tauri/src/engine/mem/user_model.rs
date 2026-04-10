use std::path::Path;

const USER_MD_FILENAME: &str = "USER.md";

/// Load the current user model from USER.md
pub fn load_user_model(working_dir: &Path) -> String {
    let path = working_dir.join(USER_MD_FILENAME);
    std::fs::read_to_string(&path).unwrap_or_default()
}

/// Save updated user model to USER.md
pub fn save_user_model(working_dir: &Path, content: &str) -> Result<(), String> {
    let path = working_dir.join(USER_MD_FILENAME);
    std::fs::write(&path, content).map_err(|e| format!("Failed to write USER.md: {e}"))
}
