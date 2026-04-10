//! Project type detection and test command resolution.
//!
//! Scans a workspace to determine the project type (Rust, Node, Python, etc.)
//! and returns the appropriate test/build/lint commands.

use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectType {
    Rust,
    Node,
    Python,
    Go,
    Java,
    Unknown,
}

#[derive(Debug, Clone)]
pub struct ProjectInfo {
    pub project_type: ProjectType,
    pub root: String,
    pub test_command: Option<String>,
    pub build_command: Option<String>,
    pub lint_command: Option<String>,
    pub type_check_command: Option<String>,
}

/// Detect project type by scanning for marker files.
pub fn detect_project(workspace: &Path) -> ProjectInfo {
    let root = workspace.to_string_lossy().to_string();

    // Rust
    if workspace.join("Cargo.toml").exists() {
        return ProjectInfo {
            project_type: ProjectType::Rust,
            root,
            test_command: Some("cargo test".into()),
            build_command: Some("cargo build".into()),
            lint_command: Some("cargo clippy".into()),
            type_check_command: Some("cargo check".into()),
        };
    }

    // Node (check package.json for scripts)
    if workspace.join("package.json").exists() {
        let test_cmd = read_npm_script(workspace, "test");
        let build_cmd = read_npm_script(workspace, "build");
        let lint_cmd = read_npm_script(workspace, "lint");
        let type_check = if workspace.join("tsconfig.json").exists() {
            Some("npx tsc --noEmit".into())
        } else {
            None
        };
        return ProjectInfo {
            project_type: ProjectType::Node,
            root,
            test_command: test_cmd.or(Some("npm test".into())),
            build_command: build_cmd,
            lint_command: lint_cmd,
            type_check_command: type_check,
        };
    }

    // Python
    if workspace.join("pyproject.toml").exists()
        || workspace.join("setup.py").exists()
        || workspace.join("requirements.txt").exists()
    {
        let test_cmd = if workspace.join("pyproject.toml").exists() {
            Some("pytest".into())
        } else {
            Some("python -m pytest".into())
        };
        return ProjectInfo {
            project_type: ProjectType::Python,
            root,
            test_command: test_cmd,
            build_command: None,
            lint_command: Some("ruff check .".into()),
            type_check_command: Some("mypy .".into()),
        };
    }

    // Go
    if workspace.join("go.mod").exists() {
        return ProjectInfo {
            project_type: ProjectType::Go,
            root,
            test_command: Some("go test ./...".into()),
            build_command: Some("go build ./...".into()),
            lint_command: Some("golangci-lint run".into()),
            type_check_command: Some("go vet ./...".into()),
        };
    }

    // Java
    if workspace.join("pom.xml").exists() {
        return ProjectInfo {
            project_type: ProjectType::Java,
            root,
            test_command: Some("mvn test".into()),
            build_command: Some("mvn package".into()),
            lint_command: None,
            type_check_command: None,
        };
    }
    if workspace.join("build.gradle").exists() || workspace.join("build.gradle.kts").exists() {
        return ProjectInfo {
            project_type: ProjectType::Java,
            root,
            test_command: Some("./gradlew test".into()),
            build_command: Some("./gradlew build".into()),
            lint_command: None,
            type_check_command: None,
        };
    }

    ProjectInfo {
        project_type: ProjectType::Unknown,
        root,
        test_command: None,
        build_command: None,
        lint_command: None,
        type_check_command: None,
    }
}

/// Read a script from package.json.
fn read_npm_script(workspace: &Path, script_name: &str) -> Option<String> {
    let pkg_json = workspace.join("package.json");
    let content = std::fs::read_to_string(pkg_json).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    let script = json["scripts"][script_name].as_str()?;
    if script.is_empty() {
        None
    } else {
        Some(format!("npm run {}", script_name))
    }
}

/// Generate a project summary for system prompt injection.
pub fn project_summary(info: &ProjectInfo) -> String {
    let mut summary = format!("Project type: {:?}", info.project_type);
    if let Some(ref cmd) = info.test_command {
        summary.push_str(&format!("\nTest command: {}", cmd));
    }
    if let Some(ref cmd) = info.build_command {
        summary.push_str(&format!("\nBuild command: {}", cmd));
    }
    if let Some(ref cmd) = info.type_check_command {
        summary.push_str(&format!("\nType check: {}", cmd));
    }
    summary
}
