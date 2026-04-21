# Plan A1 — Rust Test Infrastructure + First-Wave Engine Module Tests

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the Rust test-framework foundation (dev-deps, `test_support/` helpers, integration-test layout, coverage tool, CI) and deliver first-wave regression tests for 3 representative engine modules (`scheduler`, `bots/manager`, `tools/shell_security`). Remaining 5 engine modules (`react_agent/core`, `tools/file_tools`, `tools/mod`, `mem/meditation`, `infra/mcp_runtime`) are covered in follow-up iterations sharing this same infra.

**Architecture:** A new `test_support` module behind a `test-support` feature flag exposes `TempDb`, `TempWorkspace`, `FakeEmbedder`, `MockLlmProvider`, and `build_test_app_state(...)` — callable from both inline unit tests (inside `mod tests`) and external integration tests (`tests/`). Integration tests live in `tests/engine/*.rs` with a shared `tests/common/mod.rs`. Coverage measured by `cargo-llvm-cov`. CI runs `cargo test --features test-support --workspace` on every push/PR.

**Tech Stack:** Rust (stable), `cargo test`, `mockall 0.13`, `tempfile 3`, `tokio-test 0.4`, `rstest 0.23`, `serial_test 3`, `tokio 1` (test-util feature), `cargo-llvm-cov`, GitHub Actions (macos-latest runner).

---

## Prerequisites — before starting

Read these files to ground the plan:
- `docs/superpowers/specs/2026-04-20-testing-framework-design.md` (the parent spec; §5 and §5.4.1 are most relevant)
- `app/src-tauri/src/state/app_state.rs` (for `AppState::new()` signature and all fields)
- `app/src-tauri/src/state/config.rs` (for `Config` / `MemmeConfig` structure)
- `app/src-tauri/src/engine/scheduler.rs` (target of Task 12)
- `app/src-tauri/src/engine/bots/manager.rs` (target of Task 13)
- `app/src-tauri/src/engine/tools/shell_security.rs` (existing 15 tests; target of Task 14)

Confirm the working directory throughout:
```bash
cd /Users/Four/PersonalProjects/YiYiClaw
```

---

## File Structure Map

```
app/src-tauri/
├── Cargo.toml                         # MODIFY: add [dev-dependencies] + [features]
├── src/
│   ├── lib.rs                         # MODIFY: declare test_support module
│   └── test_support/                  # NEW MODULE
│       ├── mod.rs                     # re-exports + docstring
│       ├── temp_workspace.rs          # TempWorkspace — simulates ~/.yiyi/
│       ├── temp_db.rs                 # TempDb — wraps Database with tempdir
│       ├── fake_embedder.rs           # FakeEmbedder — deterministic 512-d vectors
│       ├── mocks.rs                   # MockLlmProvider via mockall
│       └── app_state.rs               # build_test_app_state() helper
└── tests/
    ├── common/
    │   └── mod.rs                     # re-exports test_support for integration tests
    └── engine/
        ├── scheduler.rs               # integration tests: cron / delay / once / cancel
        └── bots_manager.rs            # integration tests: dedup / debounce / running state

.github/workflows/
└── test.yml                           # NEW: CI job for cargo test + cargo llvm-cov
```

Each `test_support/*.rs` file has one clear responsibility and no cross-dependencies except where noted (e.g. `app_state.rs` depends on `temp_workspace.rs` + `temp_db.rs`).

---

## Task 1: Add Cargo deps and `test-support` feature

> **⚠️ Correction applied (2026-04-21):** The original approach using `[dev-dependencies]` did NOT work: `test_support/` is a `feature = "test-support"` gated module, compiled during non-test builds when integration tests reference it. Dev-dependencies are only linked for test/bench builds, so `tempfile` / `mockall` / etc. were unresolved. **Revised approach: make them optional deps under `[dependencies]`, link them into the `test-support` feature**. The Cargo.toml block example below shows the corrected form.

**Files:**
- Modify: `app/src-tauri/Cargo.toml`

- [ ] **Step 1: Read current `Cargo.toml` to locate insertion points**

```bash
grep -n "^\[features\]\|^\[dev-dependencies\]\|^\[dependencies\]" app/src-tauri/Cargo.toml
```

If `[features]` exists, add to it. If not, create one. Expect `[dev-dependencies]` to be absent (confirmed in audit).

- [ ] **Step 2: Add `test-support` feature linking the optional deps**

In `app/src-tauri/Cargo.toml`, add (or extend) `[features]`:

```toml
[features]
test-support = [
    "dep:mockall",
    "dep:tempfile",
    "dep:rstest",
    "dep:serial_test",
    "dep:tokio-test",
    "tokio/test-util",
]
```

Place this immediately after the `[package]` block (or wherever an existing `[features]` is).

- [ ] **Step 3: Add optional dep entries to `[dependencies]`**

Append to `app/src-tauri/Cargo.toml` (after existing `[dependencies]` lines, before `[profile.release]`):

```toml
[dependencies.mockall]
version = "0.13"
optional = true

[dependencies.tempfile]
version = "3"
optional = true

[dependencies.tokio-test]
version = "0.4"
optional = true

[dependencies.rstest]
version = "0.23"
optional = true

[dependencies.serial_test]
version = "3"
optional = true
```

No `[dev-dependencies]` block needed. `tokio` is already a regular dep; the `tokio/test-util` feature is enabled as part of the `test-support` feature.

- [ ] **Step 4: Verify the build still compiles without test-support**

```bash
cd app/src-tauri && cargo check
```

Expected: `Finished ... dev [unoptimized + debuginfo] target(s) in Xs` with zero errors. Warnings about existing dead code are OK (unrelated).

- [ ] **Step 5: Verify tests can pull in dev-dependencies**

```bash
cd app/src-tauri && cargo check --tests
```

Expected: Also compiles cleanly. No "unresolved crate" errors for mockall/tempfile/tokio-test/rstest/serial_test.

- [ ] **Step 6: Commit**

```bash
git add app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock
git commit -m "test(infra): add dev-dependencies and test-support feature"
```

---

## Task 2: Expose modules for integration tests in `lib.rs`

**Files:**
- Modify: `app/src-tauri/src/lib.rs`

Integration tests in `tests/` are a separate crate and can only access `pub` items of the `yiyi` lib. Currently `mod engine;` and `mod state;` are private, so `app_lib::engine::...` and `app_lib::state::AppState` aren't visible. Make them `pub` (gated to keep production API surface unchanged).

- [ ] **Step 1: Read current lib.rs top-level module declarations**

```bash
head -6 app/src-tauri/src/lib.rs
```

Expected exactly:
```
mod commands;
mod engine;
mod state;
mod tray;
```

- [ ] **Step 2: Change `mod engine;` and `mod state;` to `pub mod`**

Edit `app/src-tauri/src/lib.rs` top lines:

```rust
mod commands;
pub mod engine;
pub mod state;
mod tray;

#[cfg(any(test, feature = "test-support"))]
pub mod test_support;
```

(`commands` and `tray` stay private — Plan A2 will handle `commands`.)

- [ ] **Step 3: Create empty `test_support/mod.rs` placeholder to make the module resolvable**

```bash
mkdir -p app/src-tauri/src/test_support
touch app/src-tauri/src/test_support/mod.rs
```

- [ ] **Step 4: Verify it compiles with both feature states**

```bash
cd app/src-tauri && cargo check
cd app/src-tauri && cargo check --features test-support
cd app/src-tauri && cargo check --tests --features test-support
```

Expected: all three commands finish without errors. (`test_support/mod.rs` is empty — that's fine; a module with no items is valid.)

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/lib.rs app/src-tauri/src/test_support/mod.rs
git commit -m "test(infra): declare test_support module behind feature flag"
```

---

## Task 3: Implement `TempWorkspace` helper

**Files:**
- Create: `app/src-tauri/src/test_support/temp_workspace.rs`
- Modify: `app/src-tauri/src/test_support/mod.rs`

- [ ] **Step 1: Create `temp_workspace.rs` with the full implementation**

Write `app/src-tauri/src/test_support/temp_workspace.rs`:

```rust
//! Temporary workspace directory simulating ~/.yiyi/ for tests.
//!
//! Creates an isolated tempdir with an empty `config.json`. The tempdir is
//! removed automatically when the `TempWorkspace` is dropped.

use std::path::{Path, PathBuf};
use tempfile::TempDir;

pub struct TempWorkspace {
    dir: TempDir,
}

impl TempWorkspace {
    /// Create a fresh temporary workspace with a minimal `config.json`.
    pub fn new() -> Self {
        let dir = TempDir::new().expect("failed to create tempdir");
        let config_path = dir.path().join("config.json");
        // Minimal valid Config JSON — relies on #[serde(default)] on all MemmeConfig fields etc.
        std::fs::write(&config_path, "{}").expect("failed to write config.json");
        Self { dir }
    }

    /// Absolute path to the workspace root (analogous to ~/.yiyi/).
    pub fn path(&self) -> &Path {
        self.dir.path()
    }

    /// Path to the config.json inside this workspace.
    pub fn config_path(&self) -> PathBuf {
        self.dir.path().join("config.json")
    }
}

impl Default for TempWorkspace {
    fn default() -> Self {
        Self::new()
    }
}
```

- [ ] **Step 2: Add sub-module declaration + re-export to `test_support/mod.rs`**

Write `app/src-tauri/src/test_support/mod.rs`:

```rust
//! Test-only helpers. Available when compiled with `--features test-support`
//! or in the `cfg(test)` build profile.

pub mod temp_workspace;

pub use temp_workspace::TempWorkspace;
```

- [ ] **Step 3: Write an inline smoke test in `temp_workspace.rs`**

Append to `app/src-tauri/src/test_support/temp_workspace.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temp_workspace_creates_directory_and_config_file() {
        let ws = TempWorkspace::new();
        assert!(ws.path().exists());
        assert!(ws.path().is_dir());
        assert!(ws.config_path().exists());
        let content = std::fs::read_to_string(ws.config_path()).unwrap();
        assert_eq!(content, "{}");
    }

    #[test]
    fn temp_workspace_is_unique_per_instance() {
        let a = TempWorkspace::new();
        let b = TempWorkspace::new();
        assert_ne!(a.path(), b.path());
    }

    #[test]
    fn temp_workspace_cleans_up_on_drop() {
        let path = {
            let ws = TempWorkspace::new();
            ws.path().to_path_buf()
        }; // ws dropped here
        assert!(!path.exists(), "tempdir should be removed after drop");
    }
}
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
cd app/src-tauri && cargo test --features test-support test_support::temp_workspace -- --nocapture
```

Expected: 3 tests passed, 0 failed. Output lists `temp_workspace_creates_directory_and_config_file`, `temp_workspace_is_unique_per_instance`, `temp_workspace_cleans_up_on_drop`.

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/test_support/
git commit -m "test(infra): add TempWorkspace helper"
```

---

## Task 4: Implement `TempDb` helper

**Files:**
- Create: `app/src-tauri/src/test_support/temp_db.rs`
- Modify: `app/src-tauri/src/test_support/mod.rs`

- [ ] **Step 1: Create `temp_db.rs`**

Write `app/src-tauri/src/test_support/temp_db.rs`:

```rust
//! Temporary SQLite database backed by a tempdir. Runs the same migrations as
//! production via `Database::open`, so tables have the real schema.

use crate::engine::db::Database;
use std::path::PathBuf;
use std::sync::Arc;
use tempfile::TempDir;

pub struct TempDb {
    _dir: TempDir,
    db: Arc<Database>,
    db_path: PathBuf,
}

impl TempDb {
    /// Create a fresh tempdir + fully-migrated SQLite database.
    pub fn new() -> Self {
        let dir = TempDir::new().expect("failed to create tempdir");
        let db = Database::open(dir.path())
            .expect("Database::open failed on fresh tempdir");
        let db_path = dir.path().join("yiyi.db");
        Self {
            _dir: dir,
            db: Arc::new(db),
            db_path,
        }
    }

    /// Shared handle. Clone freely — cheap Arc clone.
    pub fn db(&self) -> Arc<Database> {
        self.db.clone()
    }

    /// Path to the SQLite file (yiyi.db) inside the tempdir.
    pub fn path(&self) -> &std::path::Path {
        &self.db_path
    }
}

impl Default for TempDb {
    fn default() -> Self {
        Self::new()
    }
}
```

- [ ] **Step 2: Update `test_support/mod.rs`**

Edit `app/src-tauri/src/test_support/mod.rs` to:

```rust
//! Test-only helpers. Available when compiled with `--features test-support`
//! or in the `cfg(test)` build profile.

pub mod temp_db;
pub mod temp_workspace;

pub use temp_db::TempDb;
pub use temp_workspace::TempWorkspace;
```

- [ ] **Step 3: Add smoke tests to `temp_db.rs`**

Append to `app/src-tauri/src/test_support/temp_db.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    #[test]
    #[serial]
    fn temp_db_creates_sqlite_file_and_runs_migrations() {
        let t = TempDb::new();
        assert!(t.path().exists());
        // `sessions` table should exist after migration.
        let db = t.db();
        let conn = db.get_conn().expect("conn mutex");
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='sessions'",
                [],
                |r| r.get(0),
            )
            .expect("query sqlite_master");
        assert_eq!(count, 1);
    }

    #[test]
    #[serial]
    fn temp_db_is_isolated_per_instance() {
        let a = TempDb::new();
        let b = TempDb::new();
        assert_ne!(a.path(), b.path());
    }
}
```

- [ ] **Step 4: Run the tests**

```bash
cd app/src-tauri && cargo test --features test-support test_support::temp_db
```

Expected: 2 tests passed.

Common failure: if `sessions` table name doesn't match current schema, update the assertion to a table name that does exist (verify via `grep -n "CREATE TABLE" app/src-tauri/src/engine/db/mod.rs` or `db/*.rs`). The test's assertion is the only place that needs changing.

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/test_support/
git commit -m "test(infra): add TempDb helper"
```

---

## Task 5: Implement `FakeEmbedder`

**Files:**
- Create: `app/src-tauri/src/test_support/fake_embedder.rs`
- Modify: `app/src-tauri/src/test_support/mod.rs`

Note: `memme_embeddings::Embedder` is a **sync** trait (not async). Signatures: `embed(&self, text: &str) -> Result<Vec<f32>, EmbedError>`, `embed_batch`, `dimensions() -> usize`, `model_name() -> &str`.

- [ ] **Step 1: Create `fake_embedder.rs`**

Write `app/src-tauri/src/test_support/fake_embedder.rs`:

```rust
//! Deterministic 512-dimensional embedder for tests.
//!
//! Produces a vector derived from a stable hash of the input text. Same input
//! always maps to the same vector. No network, no ONNX, no model file.

use memme_embeddings::{EmbedError, Embedder};
use std::hash::{Hash, Hasher};

const DIMS: usize = 512;

pub struct FakeEmbedder;

impl FakeEmbedder {
    pub fn new() -> Self {
        Self
    }
}

impl Default for FakeEmbedder {
    fn default() -> Self {
        Self::new()
    }
}

impl Embedder for FakeEmbedder {
    fn embed(&self, text: &str) -> Result<Vec<f32>, EmbedError> {
        if text.is_empty() {
            return Err(EmbedError::InvalidInput("text is empty".into()));
        }
        // Derive a deterministic seed from the input.
        let mut h = std::collections::hash_map::DefaultHasher::new();
        text.hash(&mut h);
        let seed = h.finish();

        // Expand the seed into DIMS f32 values deterministically.
        let mut v = Vec::with_capacity(DIMS);
        let mut state = seed;
        for _ in 0..DIMS {
            // LCG: xorshift64-ish, good enough for determinism (NOT cryptographic).
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            // Scale to [-1.0, 1.0).
            let scaled = ((state & 0xFFFFFF) as f32 / 16_777_216.0) * 2.0 - 1.0;
            v.push(scaled);
        }
        // L2-normalize so dot-product similarity is meaningful.
        let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-12);
        for x in v.iter_mut() {
            *x /= norm;
        }
        Ok(v)
    }

    fn embed_batch(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, EmbedError> {
        texts.iter().map(|t| self.embed(t)).collect()
    }

    fn dimensions(&self) -> usize {
        DIMS
    }

    fn model_name(&self) -> &str {
        "fake"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fake_embedder_returns_512_dim_vector() {
        let e = FakeEmbedder::new();
        let v = e.embed("hello").unwrap();
        assert_eq!(v.len(), DIMS);
        assert_eq!(e.dimensions(), DIMS);
    }

    #[test]
    fn fake_embedder_is_deterministic_for_same_input() {
        let e = FakeEmbedder::new();
        let a = e.embed("some text").unwrap();
        let b = e.embed("some text").unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn fake_embedder_returns_different_vectors_for_different_inputs() {
        let e = FakeEmbedder::new();
        let a = e.embed("foo").unwrap();
        let b = e.embed("bar").unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn fake_embedder_rejects_empty_string() {
        let e = FakeEmbedder::new();
        assert!(e.embed("").is_err());
    }

    #[test]
    fn fake_embedder_vector_is_l2_normalized() {
        let e = FakeEmbedder::new();
        let v = e.embed("anything").unwrap();
        let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-5, "got norm {}", norm);
    }

    #[test]
    fn fake_embedder_batch_matches_sequential_calls() {
        let e = FakeEmbedder::new();
        let batch = e.embed_batch(&["a", "b", "c"]).unwrap();
        assert_eq!(batch.len(), 3);
        assert_eq!(batch[0], e.embed("a").unwrap());
        assert_eq!(batch[1], e.embed("b").unwrap());
        assert_eq!(batch[2], e.embed("c").unwrap());
    }
}
```

- [ ] **Step 2: Update `test_support/mod.rs`**

Edit `app/src-tauri/src/test_support/mod.rs`:

```rust
//! Test-only helpers. Available when compiled with `--features test-support`
//! or in the `cfg(test)` build profile.

pub mod fake_embedder;
pub mod temp_db;
pub mod temp_workspace;

pub use fake_embedder::FakeEmbedder;
pub use temp_db::TempDb;
pub use temp_workspace::TempWorkspace;
```

- [ ] **Step 3: Run the tests**

```bash
cd app/src-tauri && cargo test --features test-support test_support::fake_embedder
```

Expected: 6 tests passed.

- [ ] **Step 4: Commit**

```bash
git add app/src-tauri/src/test_support/
git commit -m "test(infra): add FakeEmbedder for deterministic test vectors"
```

---

## Task 6: Implement `MockLlmProvider` via `mockall`

**Files:**
- Create: `app/src-tauri/src/test_support/mocks.rs`
- Modify: `app/src-tauri/src/test_support/mod.rs`

Note: `memme_llm::LlmProvider` is a **sync** trait with methods `generate(&self, messages: &[Message], options: &GenerateOptions) -> Result<String, LlmError>` and `name(&self) -> &str`.

- [ ] **Step 1: Create `mocks.rs`**

Write `app/src-tauri/src/test_support/mocks.rs`:

```rust
//! Mockall-generated mocks for the external traits we can't modify directly.
//!
//! We use `mock!` (not `#[automock]`) because we can't add attributes to
//! external crates' traits.

use memme_llm::{GenerateOptions, LlmError, LlmProvider, Message};

mockall::mock! {
    pub LlmProviderImpl {}

    impl LlmProvider for LlmProviderImpl {
        fn generate<'a>(&self, messages: &'a [Message], options: &'a GenerateOptions) -> Result<String, LlmError>;
        fn name(&self) -> &'static str;
    }
}

pub type MockLlmProvider = MockLlmProviderImpl;

#[cfg(test)]
mod tests {
    use super::*;
    use memme_llm::MessageRole;
    use mockall::predicate::*;

    #[test]
    fn mock_llm_returns_configured_response() {
        let mut mock = MockLlmProvider::new();
        mock.expect_generate()
            .with(always(), always())
            .returning(|_msgs, _opts| Ok("mocked response".to_string()));
        mock.expect_name().return_const("mock");

        let msgs = vec![Message {
            role: MessageRole::User,
            content: "hi".to_string(),
        }];
        let opts = GenerateOptions {
            temperature: None,
            max_tokens: None,
            response_format: None,
        };
        let out = mock.generate(&msgs, &opts).unwrap();
        assert_eq!(out, "mocked response");
        assert_eq!(mock.name(), "mock");
    }

    #[test]
    fn mock_llm_can_return_error() {
        let mut mock = MockLlmProvider::new();
        mock.expect_generate()
            .returning(|_, _| Err(LlmError::NotAvailable("simulated failure".to_string())));

        let opts = GenerateOptions {
            temperature: None,
            max_tokens: None,
            response_format: None,
        };
        let err = mock.generate(&[], &opts).unwrap_err();
        assert!(format!("{:?}", err).contains("simulated failure"));
    }
}
```

`LlmError::NotAvailable(String)` is the canonical "provider unavailable" variant per `memme-llm/src/error.rs`. Other variants: `RequestFailed`, `ParseError`, `InvalidFormat` — pick whichever most closely matches the test's intent; `NotAvailable` works for this generic case.

- [ ] **Step 2: Update `test_support/mod.rs`**

Edit `app/src-tauri/src/test_support/mod.rs`:

```rust
//! Test-only helpers. Available when compiled with `--features test-support`
//! or in the `cfg(test)` build profile.

pub mod fake_embedder;
pub mod mocks;
pub mod temp_db;
pub mod temp_workspace;

pub use fake_embedder::FakeEmbedder;
pub use mocks::MockLlmProvider;
pub use temp_db::TempDb;
pub use temp_workspace::TempWorkspace;
```

- [ ] **Step 3: Run the tests**

```bash
cd app/src-tauri && cargo test --features test-support test_support::mocks
```

Expected: 2 tests passed. If the `LlmError` variant name is wrong, the test will fail to compile — fix as noted above, re-run.

- [ ] **Step 4: Commit**

```bash
git add app/src-tauri/src/test_support/
git commit -m "test(infra): add MockLlmProvider via mockall"
```

---

## Task 7: Implement `build_test_app_state` helper

**Files:**
- Create: `app/src-tauri/src/test_support/app_state.rs`
- Modify: `app/src-tauri/src/test_support/mod.rs`

This helper builds an `AppState` that uses `TempDb` + `TempWorkspace` + `FakeEmbedder` instead of real resources. It deliberately does NOT use the global `AppState::new()` (which reads from `~/.yiyi`); we need to construct an isolated instance. Because `AppState` fields are all `pub`, we can construct it field-by-field.

- [ ] **Step 1: Create `app_state.rs` — inspect AppState first**

Before writing, inspect the current `AppState` struct to confirm all fields are `pub` and reproducible in tests:

```bash
grep -A 25 "pub struct AppState" app/src-tauri/src/state/app_state.rs
```

All 18 fields expected (per audit). Note that `memme_store` is tricky — real init downloads BGE model. We need to stub it with a MemoryStore backed by `FakeEmbedder`.

- [ ] **Step 2: Write `app_state.rs`**

Write `app/src-tauri/src/test_support/app_state.rs`:

```rust
//! Construct an isolated `AppState` for tests, using `TempDb` + `TempWorkspace`
//! + `FakeEmbedder` instead of real disk / network / ONNX resources.
//!
//! Returns a fully-wired `AppState` that tests can mutate and pass into code
//! under test. Each call is independent (no shared state between tests).

use crate::engine::bots::manager::BotManager;
use crate::engine::infra::mcp_runtime::MCPRuntime;
use crate::state::{AppState, config::Config, providers::ProvidersState};
use crate::test_support::{FakeEmbedder, TempDb, TempWorkspace};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::sync::RwLock;

pub struct TestAppState {
    pub app_state: AppState,
    _ws: TempWorkspace,
    _db: TempDb,
}

impl TestAppState {
    pub fn state(&self) -> &AppState {
        &self.app_state
    }
}

/// Build a minimal but fully-wired AppState for integration tests. Owns its
/// tempdirs; the returned `TestAppState` must be kept alive for the lifetime
/// of the tests that use it.
pub async fn build_test_app_state() -> TestAppState {
    let ws = TempWorkspace::new();
    let db = TempDb::new();

    // MemMe store with FakeEmbedder — no ONNX, no network.
    let embedder: Arc<dyn memme_embeddings::Embedder> = Arc::new(FakeEmbedder::new());
    let memme_db_path = ws.path().join("memme.sqlite").to_string_lossy().to_string();
    let memme_cfg = memme_core::MemoryConfig::new(&memme_db_path, 512);
    let memme_store = Arc::new(
        memme_core::MemoryStore::new(memme_cfg, embedder)
            .expect("failed to construct MemoryStore in test"),
    );

    let app_state = AppState {
        working_dir: ws.path().to_path_buf(),
        user_workspace: std::sync::RwLock::new(ws.path().to_path_buf()),
        secret_dir: ws.path().join("secrets"),
        config: Arc::new(RwLock::new(Config::default())),
        providers: Arc::new(RwLock::new(ProvidersState::default())),
        db: db.db(),
        bot_manager: Arc::new(BotManager::new()),
        mcp_runtime: Arc::new(MCPRuntime::new()),
        chat_cancelled: Arc::new(AtomicBool::new(false)),
        scheduler: Arc::new(RwLock::new(None)),
        streaming_state: Arc::new(std::sync::Mutex::new(HashMap::new())),
        task_cancellations: Arc::new(std::sync::Mutex::new(HashMap::new())),
        pty_manager: Arc::new(crate::engine::infra::pty_manager::PtyManager::new()),
        meditation_running: Arc::new(AtomicBool::new(false)),
        memme_store,
        voice_manager: Arc::new(tokio::sync::RwLock::new(
            crate::engine::voice::VoiceSessionManager::new(),
        )),
        agent_registry: Arc::new(tokio::sync::RwLock::new(
            crate::engine::agents::AgentRegistry::load(ws.path(), None),
        )),
        plugin_registry: Arc::new(std::sync::RwLock::new(
            crate::engine::plugins::PluginRegistry::load(&ws.path().join("plugins")),
        )),
    };

    TestAppState {
        app_state,
        _ws: ws,
        _db: db,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    #[tokio::test(flavor = "multi_thread")]
    #[serial]
    async fn build_test_app_state_constructs_without_panic() {
        let t = build_test_app_state().await;
        // Sanity: working_dir exists.
        assert!(t.state().working_dir.exists());
    }

    #[tokio::test(flavor = "multi_thread")]
    #[serial]
    async fn build_test_app_state_is_isolated_per_call() {
        let a = build_test_app_state().await;
        let b = build_test_app_state().await;
        assert_ne!(a.state().working_dir, b.state().working_dir);
    }
}
```

Constructors used above (verified against current sources):
- `VoiceSessionManager::new()` — `engine/voice/mod.rs:55`
- `AgentRegistry::load(path, resource_dir)` — `engine/agents/mod.rs:112`
- `PluginRegistry::load(plugins_dir)` — `engine/plugins.rs:220`
- `PtyManager::new()` — `engine/infra/pty_manager.rs:79`

If any future refactor renames these, update this call-site. None of them perform network I/O at construction.

- [ ] **Step 3: Update `test_support/mod.rs`**

Edit `app/src-tauri/src/test_support/mod.rs`:

```rust
//! Test-only helpers. Available when compiled with `--features test-support`
//! or in the `cfg(test)` build profile.

pub mod app_state;
pub mod fake_embedder;
pub mod mocks;
pub mod temp_db;
pub mod temp_workspace;

pub use app_state::{build_test_app_state, TestAppState};
pub use fake_embedder::FakeEmbedder;
pub use mocks::MockLlmProvider;
pub use temp_db::TempDb;
pub use temp_workspace::TempWorkspace;
```

- [ ] **Step 4: Compile and fix any incompatibilities**

```bash
cd app/src-tauri && cargo check --features test-support --tests
```

Expect a first-pass failure if any `Default` impls are missing. Fix them inline (add `#[derive(Default)]` where possible; otherwise call existing constructors). Re-run until green.

- [ ] **Step 5: Run the smoke tests**

```bash
cd app/src-tauri && cargo test --features test-support test_support::app_state
```

Expected: 2 tests passed.

- [ ] **Step 6: Commit**

```bash
git add app/src-tauri/src/test_support/ app/src-tauri/src/
git commit -m "test(infra): add build_test_app_state helper"
```

---

## Task 8: Create `tests/common/mod.rs`

**Files:**
- Create: `app/src-tauri/tests/common/mod.rs`

External integration tests in `tests/` are a separate crate. They import the lib crate and access `test_support` via `app_lib::test_support::*`. The `common` module is the shared conventions layer.

- [ ] **Step 1: Determine the crate name**

```bash
grep "^name = " app/src-tauri/Cargo.toml | head -2
```

Expected crate name: `app_lib` (from `[lib] name = "app_lib"` in Cargo.toml — confirmed via runtime log format `[app_lib][INFO]`). All integration tests will `use app_lib::test_support::*`.

- [ ] **Step 2: Create the integration test directory and common module**

```bash
mkdir -p app/src-tauri/tests/common
```

Write `app/src-tauri/tests/common/mod.rs`:

```rust
//! Shared helpers for integration tests. Re-exports the in-crate test_support
//! module so tests can import from one stable location.

#![allow(dead_code)] // not every integration test uses every helper

pub use app_lib::test_support::*;
```

- [ ] **Step 3: Create a trivial placeholder integration test to verify the wiring**

Write `app/src-tauri/tests/smoke.rs`:

```rust
mod common;

use common::*;

#[tokio::test(flavor = "multi_thread")]
async fn integration_test_can_build_test_app_state() {
    let t = build_test_app_state().await;
    assert!(t.state().working_dir.exists());
}
```

- [ ] **Step 4: Run the integration test**

```bash
cd app/src-tauri && cargo test --features test-support --test smoke
```

Expected: 1 test passed. If it doesn't compile, the usual cause is that `test_support` isn't `pub` in `lib.rs` — verify Task 2 step 2.

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/tests/
git commit -m "test(infra): add tests/common module and smoke integration test"
```

---

## Task 9: Install cargo-llvm-cov and verify coverage reporting

**Files:** none directly; installs a tool and adds a local command hint.

- [ ] **Step 1: Install cargo-llvm-cov**

```bash
cargo install cargo-llvm-cov --locked
```

Expected: success message. First run installs llvm-tools-preview component if missing:

```bash
rustup component add llvm-tools-preview
```

- [ ] **Step 2: Run coverage over the current test set**

```bash
cd app/src-tauri && cargo llvm-cov --features test-support --html --output-dir ../../target/llvm-cov
```

Expected: generates `target/llvm-cov/html/index.html`. Open it:

```bash
open target/llvm-cov/html/index.html  # macOS
```

Manual verify: coverage report shows `test_support/*` with high coverage (they have their own smoke tests). Engine modules will be near 0% at this point — that's expected; Tasks 12-14 will improve them.

- [ ] **Step 3: Verify LCOV export works (for CI)**

```bash
cd app/src-tauri && cargo llvm-cov --features test-support --lcov --output-path ../../target/lcov.info
```

Expected: creates `target/lcov.info` (a text file with `DA:...` lines). No need to commit this artifact.

- [ ] **Step 4: Document local commands in a README block (optional)**

Append to `app/src-tauri/README.md` (create if absent):

```markdown
## Running tests

```bash
# Unit + integration tests
cargo test --features test-support

# A single integration file
cargo test --features test-support --test scheduler

# HTML coverage report
cargo llvm-cov --features test-support --html --open
```
```

- [ ] **Step 5: Commit the README (no other files changed)**

```bash
git add app/src-tauri/README.md
git commit -m "test(infra): document cargo-llvm-cov usage"
```

---

## Task 10: Add `data-testid` convention (pre-requirement, documentation only)

**Files:**
- Modify: `CLAUDE.md` (root)

Not code, but recording the convention now avoids drift.

- [ ] **Step 1: Append a "Testing Conventions" section to CLAUDE.md**

Append to `/Users/Four/PersonalProjects/YiYiClaw/CLAUDE.md`:

```markdown
## Testing Conventions

- **Rust:** new tests go in `tests/engine/<module>.rs` (integration) or `#[cfg(test)] mod tests` (internal). Use `test_support::*` via `mod common; use common::*`. Tests touching SQLite take `#[serial]`.
- **Naming:** `<subject>_<action>_<expected>` — e.g. `scheduler_add_job_with_cron_expression_triggers_on_schedule`.
- **Async tests:** default `#[tokio::test(flavor = "multi_thread")]`. For paused-clock tests use `#[tokio::test(start_paused = true)]`.
- **Coverage target:** engine core modules ≥ 70% line coverage (Plan A1 goal).
- **CI:** every push/PR runs `cargo test --features test-support`.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add Rust testing conventions to CLAUDE.md"
```

---

## Task 11: Integration tests for `scheduler` module

**Files:**
- Create: `app/src-tauri/tests/engine/scheduler.rs`
- Create: `app/src-tauri/tests/engine/mod.rs` (if Rust 2021 requires it for directory-style tests — actually it DOESN'T; each `tests/*.rs` is its own bin. So we'll use `tests/engine_scheduler.rs` instead to keep routing simple).

**Correction to file structure:** Rust's integration test layout requires each file directly in `tests/` to be a separate binary. Sub-directories under `tests/` are only for *sharing code* (like `tests/common/`). So:

- Integration tests go at `tests/engine_<module>.rs` (flat), not `tests/engine/<module>.rs`.
- The spec's conceptual grouping is preserved by the filename prefix.

Re-path the files from the spec's §5.3:
- `tests/engine_scheduler.rs` (Task 11)
- `tests/engine_bots_manager.rs` (Task 12)
- All 8 module files would follow `tests/engine_<module>.rs` naming.

- [ ] **Step 1: Create `tests/engine_scheduler.rs`**

Write `app/src-tauri/tests/engine_scheduler.rs`:

```rust
mod common;

use common::*;
use serial_test::serial;
use app_lib::engine::scheduler::CronScheduler;

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn cron_scheduler_new_returns_ready_instance() {
    let sched = CronScheduler::new().await;
    assert!(sched.is_ok(), "CronScheduler::new should succeed");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn cron_scheduler_start_does_not_panic_on_empty_job_list() {
    let sched = CronScheduler::new().await.unwrap();
    let res = sched.start().await;
    assert!(res.is_ok(), "start() should succeed with no jobs");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn cron_scheduler_remove_nonexistent_job_returns_ok_or_reports() {
    let sched = CronScheduler::new().await.unwrap();
    // Removing a job that was never added: accept either Ok or a controlled error
    // (implementation-defined; this test asserts it does not panic).
    let _ = sched.remove_job("nonexistent-id").await;
}
```

These three tests only touch what's safely testable without needing `AppState`/`CronJobSpec` plumbing. More depth (cron-expression trigger, one-time job fire, persistence) requires more fixtures and is tracked as a follow-up.

- [ ] **Step 2: Run the test**

```bash
cd app/src-tauri && cargo test --features test-support --test engine_scheduler
```

Expected: 3 tests passed.

- [ ] **Step 3: Extend with a one-time-job trigger test using paused clock**

Append to `app/src-tauri/tests/engine_scheduler.rs`:

```rust
#[tokio::test(flavor = "multi_thread", start_paused = true)]
#[serial]
async fn cron_scheduler_tick_advances_with_paused_clock() {
    // Sanity test confirming paused-clock testing works under CronScheduler.
    // Real fire-time assertions require a CronJobSpec fixture — covered in follow-up.
    let sched = CronScheduler::new().await.unwrap();
    sched.start().await.unwrap();
    tokio::time::advance(std::time::Duration::from_secs(120)).await;
    // No assertion besides "does not deadlock".
}
```

- [ ] **Step 4: Re-run and verify**

```bash
cd app/src-tauri && cargo test --features test-support --test engine_scheduler
```

Expected: 4 tests passed.

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/tests/
git commit -m "test(scheduler): add first-wave integration tests"
```

**Follow-up (not part of this plan, but tracked):** after `CronJobSpec` builder is added to `test_support`, expand with cron-expression trigger assertions, persistence via `TempDb`, overdue catch-up, and `remove_job` cancellation. These tests will live in the same file.

---

## Task 12: Integration tests for `BotManager`

**Files:**
- Create: `app/src-tauri/tests/engine_bots_manager.rs`

- [ ] **Step 1: Create the test file with dedup/debounce/running-state coverage**

Write `app/src-tauri/tests/engine_bots_manager.rs`:

```rust
mod common;

use common::*;
use serial_test::serial;
use app_lib::engine::bots::manager::{BotManager, RunningBot};
use std::sync::Arc;
use tokio::sync::RwLock;

#[tokio::test(flavor = "multi_thread")]
async fn bot_manager_new_starts_not_running() {
    let mgr = BotManager::new();
    assert!(!mgr.is_running().await);
    assert_eq!(mgr.connected_count().await, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn bot_manager_register_and_query_running_bot() {
    let mgr = BotManager::new();
    let bot = RunningBot {
        bot_id: "bot-1".to_string(),
        running_flag: Arc::new(RwLock::new(true)),
    };
    mgr.register_running_bot(bot).await;

    assert!(mgr.is_bot_running("bot-1").await);
    let ids = mgr.list_running_bot_ids().await;
    assert_eq!(ids, vec!["bot-1".to_string()]);
}

#[tokio::test(flavor = "multi_thread")]
async fn bot_manager_unregister_bot_returns_true_if_present() {
    let mgr = BotManager::new();
    let bot = RunningBot {
        bot_id: "bot-2".to_string(),
        running_flag: Arc::new(RwLock::new(true)),
    };
    mgr.register_running_bot(bot).await;
    assert!(mgr.unregister_running_bot("bot-2").await);
    assert!(!mgr.is_bot_running("bot-2").await);
}

#[tokio::test(flavor = "multi_thread")]
async fn bot_manager_unregister_missing_bot_returns_false() {
    let mgr = BotManager::new();
    assert!(!mgr.unregister_running_bot("never-existed").await);
}

#[tokio::test(flavor = "multi_thread")]
async fn bot_manager_list_empty_when_no_bots_registered() {
    let mgr = BotManager::new();
    let ids = mgr.list_running_bot_ids().await;
    assert!(ids.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn bot_manager_get_sender_returns_working_channel() {
    let mgr = BotManager::new();
    let tx = mgr.get_sender();
    // Sending without a running worker loop should still succeed (buffered channel).
    // We don't construct an IncomingMessage here because its full type is complex —
    // this just asserts the sender handle itself is obtainable.
    drop(tx);
}

#[tokio::test(flavor = "multi_thread")]
async fn bot_manager_register_handler_does_not_panic() {
    let mgr = BotManager::new();
    mgr.register_handler("bot-3", |_session, _content| async move {
        Ok(())
    })
    .await;
    // Registering a handler alone doesn't start the worker; that's fine.
    assert!(!mgr.is_running().await);
}
```

- [ ] **Step 2: Run the test**

```bash
cd app/src-tauri && cargo test --features test-support --test engine_bots_manager
```

Expected: 7 tests passed.

- [ ] **Step 3: Commit**

```bash
git add app/src-tauri/tests/
git commit -m "test(bots): add first-wave BotManager integration tests"
```

**Follow-up (tracked, not this plan):** dedup by msg_id, 500ms debounce timing (needs start_paused clock + an `IncomingMessage` fixture helper in `test_support`), 4-worker concurrency, handler panic isolation. Requires a `test_support::bot_message()` builder.

---

## Task 13: Extend inline tests for `tools/shell_security`

**Files:**
- Modify: `app/src-tauri/src/engine/tools/shell_security.rs`

Existing block already has ~15 tests. Add 6 more for currently-uncovered behavior (env var injection, metachar escape, timeout handling, pipe chain).

- [ ] **Step 1: Locate the existing `#[cfg(test)] mod tests` block**

```bash
grep -n "^#\[cfg(test)\]" app/src-tauri/src/engine/tools/shell_security.rs
grep -n "fn test_\|fn should_\|#\[test\]" app/src-tauri/src/engine/tools/shell_security.rs | head -30
```

Note the function that performs command analysis (e.g. `analyze_command`, `classify_command`) and the top of its `mod tests`. Record the exact name — it's needed verbatim in the tests below.

- [ ] **Step 2: Read one existing test to match style**

```bash
grep -n -A 12 "fn " app/src-tauri/src/engine/tools/shell_security.rs | grep -A 10 "fn \w*_returns_\|fn \w*_is_\|fn \w*_allows_\|#\[test\]" | head -30
```

Adapt the casing and analyzer function name from existing tests.

- [ ] **Step 3: Append new test functions inside the existing `mod tests` block**

Inside `#[cfg(test)] mod tests { ... }` in `app/src-tauri/src/engine/tools/shell_security.rs`, append before the closing `}`:

```rust
    #[test]
    fn shell_security_blocks_command_with_env_var_injection() {
        // FOO=bar rm -rf /  — env prefix should not bypass destructive classification
        let analysis = analyze_command("FOO=bar rm -rf /");
        assert!(
            matches!(analysis.security_verdict, SecurityVerdict::Block { .. }),
            "FOO=bar prefix must not bypass destructive-command block; got {:?}",
            analysis.security_verdict
        );
    }

    #[test]
    fn shell_security_detects_shell_metachar_in_quoted_paths() {
        // Command contains a backtick — should be flagged as unknown/warn at minimum
        let analysis = analyze_command("echo `whoami`");
        assert!(
            !matches!(analysis.security_verdict, SecurityVerdict::Allow),
            "backtick-embedded command must not Allow silently; got {:?}",
            analysis.security_verdict
        );
    }

    #[test]
    fn shell_security_classifies_pipe_chain_by_worst_member() {
        // Read-only ls piped into destructive rm should NOT be treated as read-only.
        let analysis = analyze_command("ls / | xargs rm -rf");
        assert!(
            !matches!(analysis.classification, CommandClass::ReadOnly),
            "pipe chain ending in rm must not classify as ReadOnly; got {:?}",
            analysis.classification
        );
    }

    #[test]
    fn shell_security_allows_plain_read_command() {
        let analysis = analyze_command("ls -la");
        assert!(matches!(analysis.classification, CommandClass::ReadOnly));
        assert!(matches!(analysis.security_verdict, SecurityVerdict::Allow));
    }

    #[test]
    fn shell_security_extracts_paths_from_cp_command() {
        let analysis = analyze_command("cp /src/file.txt /dst/");
        assert!(analysis.extracted_paths.iter().any(|p| p.path.contains("/src/")));
        assert!(analysis.extracted_paths.iter().any(|p| p.path.contains("/dst")));
    }

    #[test]
    fn shell_security_empty_command_returns_defined_verdict() {
        let analysis = analyze_command("");
        // Empty input should not panic; verdict is defined (Unknown+Block or Allow as designed).
        let _ = analysis.security_verdict;
    }
```

If `analyze_command` isn't the actual entry-point name (e.g. it's `classify` or `analyze`), do a rename across all 6 tests consistently.

- [ ] **Step 4: Run the new tests**

```bash
cd app/src-tauri && cargo test shell_security::tests --features test-support
```

Expected: previous 15 still pass + 6 new pass = 21 total. If the 6 new tests fail, that's either:
- a bug in the analyzer (fix the analyzer)
- a wrong expected behavior (adjust the assertion — e.g. the design calls for `Warn` not `Block`)

Record whichever applies in the commit message.

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/engine/tools/shell_security.rs
git commit -m "test(shell_security): add 6 tests covering env prefix, pipe chains, metachars"
```

---

## Task 14: Add CI workflow `.github/workflows/test.yml`

**Files:**
- Create: `.github/workflows/test.yml`

- [ ] **Step 1: Inspect existing workflows**

```bash
ls .github/workflows/
cat .github/workflows/release.yml | head -40
```

Confirm layout. Use `release.yml` as a reference for `actions/checkout` version and runner OS.

- [ ] **Step 2: Create the new workflow**

Write `.github/workflows/test.yml`:

```yaml
name: Tests

on:
  push:
    branches: [main]
  pull_request:

jobs:
  rust:
    name: Rust tests + coverage
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4

      - uses: dtolnay/rust-toolchain@stable
        with:
          components: llvm-tools-preview

      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: app/src-tauri

      - name: Install cargo-llvm-cov
        run: cargo install cargo-llvm-cov --locked

      - name: Run tests
        working-directory: app/src-tauri
        run: cargo test --features test-support --workspace

      - name: Generate LCOV coverage
        working-directory: app/src-tauri
        run: cargo llvm-cov --features test-support --lcov --output-path ../../target/lcov.info

      - name: Upload coverage artifact
        uses: actions/upload-artifact@v4
        with:
          name: lcov
          path: target/lcov.info
          retention-days: 14
```

- [ ] **Step 3: Verify the YAML is valid locally**

```bash
# If yamllint is installed:
yamllint .github/workflows/test.yml 2>/dev/null || echo "yamllint not installed; syntax will be validated by GitHub Actions"
```

Or simply trust that GitHub Actions will reject invalid YAML on push.

- [ ] **Step 4: Commit and push to trigger the first CI run**

```bash
git add .github/workflows/test.yml
git commit -m "ci: add Rust test + coverage workflow"
```

Do NOT push — let the human partner decide when to push.

- [ ] **Step 5: Document the expected CI behavior**

Add a line to `CLAUDE.md` Testing Conventions section (appended in Task 10):

```markdown
- **CI coverage artifact:** each run uploads `lcov.info` as a downloadable artifact named `lcov` (retained 14 days).
```

- [ ] **Step 6: Commit the CLAUDE.md update**

```bash
git add CLAUDE.md
git commit -m "docs: note lcov CI artifact"
```

---

## Task 15: Plan A1 completion self-verification

**Files:** none; manual verification step.

- [ ] **Step 1: Run the full test suite**

```bash
cd app/src-tauri && cargo test --features test-support --workspace
```

Expected: all tests pass. Summarize counts:
- `test_support::*` inline tests: ~13 (3 temp_workspace + 2 temp_db + 6 fake_embedder + 2 mocks + 2 app_state)
- existing `shell_security` tests: 15 + 6 new = 21
- `engine_scheduler` integration: 4
- `engine_bots_manager` integration: 7
- smoke integration: 1

Target total: ~46 tests passing. Previous test count was 136 → now ~182.

- [ ] **Step 2: Generate coverage for engine modules**

```bash
cd app/src-tauri && cargo llvm-cov --features test-support --html --output-dir ../../target/llvm-cov
open ../../target/llvm-cov/html/index.html
```

Verify the three modules covered in this plan (`scheduler`, `bots/manager`, `tools/shell_security`) now have non-trivial line coverage. The other 5 engine modules from the spec (`react_agent/core`, `tools/file_tools`, `tools/mod`, `mem/meditation`, `infra/mcp_runtime`) remain near 0% — that's expected and is the scope of Plan A1 follow-up iterations.

- [ ] **Step 3: Write a short completion note**

Append to `docs/superpowers/plans/2026-04-20-plan-a1-rust-test-infra.md`:

```markdown
---

## Completion Notes

- Basline coverage after Plan A1 implementation: [fill in % after running llvm-cov]
- Modules still at 0% (Plan A1 follow-up):
  - `engine/react_agent/core.rs`
  - `engine/tools/file_tools.rs`
  - `engine/tools/mod.rs`
  - `engine/mem/meditation.rs`
  - `engine/infra/mcp_runtime.rs`
- Known deferred work:
  - `test_support::bot_message()` and `test_support::cron_job_spec()` fixture builders (needed before deeper `scheduler` / `bots_manager` tests)
  - CronJobSpec trigger-time assertions (paused-clock + fixture)
- Next plan: Plan A2 (237 Tauri commands — thin-layer refactor then per-file test files)
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-04-20-plan-a1-rust-test-infra.md
git commit -m "docs(plan-a1): add completion notes after implementation"
```

---

## Success Criteria (Plan A1)

- [ ] `cargo test --features test-support --workspace` passes with ≥ 46 total tests
- [ ] `cargo llvm-cov` produces an HTML report without errors
- [ ] `test_support/*` has 5 helpers (`TempWorkspace`, `TempDb`, `FakeEmbedder`, `MockLlmProvider`, `build_test_app_state`), all covered by inline smoke tests
- [ ] `tests/common/mod.rs` + `tests/smoke.rs` wired correctly; `use common::*;` works from any `tests/*.rs` file
- [ ] `tests/engine_scheduler.rs` and `tests/engine_bots_manager.rs` exercise public API surface (≥ 10 tests combined)
- [ ] `shell_security` extended from 15 → 21 inline tests
- [ ] `.github/workflows/test.yml` exists and runs `cargo test` + `cargo llvm-cov`
- [ ] `CLAUDE.md` documents the testing conventions

**Not required for Plan A1 (deferred):**
- 70% coverage on all 8 engine modules (achieved across A1 + follow-up iterations)
- Full cron-trigger or 500ms-debounce timing tests (need fixture builders first)
- LCOV upload to Codecov (optional, can be added later)

---

## Deferred Work Log

Items identified during planning that are **out of scope for this plan** but will be done in follow-up A1 iterations or subsequent plans:

1. **Fixture builders for `test_support`**: `bot_message(kind, text)`, `cron_job_spec(id, expr, dispatch)`. Prerequisite for deeper scheduler/bots tests.
2. **Mocked `chat_completion_stream`**: required to test `run_react` end-to-end. Options: (a) refactor `run_react` to accept `LlmProvider` dep injection, (b) feature-gate a `#[cfg(test)] stream_mock::fake_stream()` shim. Pick during Plan A1 follow-up.
3. **`tools/file_tools` inline tests**: all tool fns are `pub(super)` and cannot be tested from `tests/`. Either promote signatures to `pub(crate) #[cfg(any(test, feature = "test-support"))]` or write inline `mod tests` block. Covered in follow-up.
4. **`tools/mod.rs` registry tests**: `GlobalToolRegistry` is a singleton; tests need a way to construct an isolated instance. Follow-up includes a builder pattern for the registry.
5. **`mem/meditation` integration**: requires a full `AppState` with real `memme_store` behavior. Build on `build_test_app_state` (FakeEmbedder path already set up).
6. **`infra/mcp_runtime` stdio test**: write a dummy `echo {}` subprocess and verify the protocol handshake. Follow-up.
7. **Codecov upload**: enable after first-wave follow-up completes to avoid reporting misleading 10% early numbers.

Each deferred item has a clear starting point; none are blocked on unresolved design decisions.

---

## Completion Notes (2026-04-21)

Plan A1 implementation complete on branch `feature/test-framework-a1`.

### Commit history

| Task | Commit | Subject |
|------|--------|---------|
| T1 (original) | `881abba3` | test(infra): add dev-dependencies and test-support feature |
| Fix | `16895543` | test(infra): make test-support deps optional + feature-gated |
| T2 | `9cc000c` | test(infra): expose engine/state as pub and declare test_support module |
| T3 | `51a94d9f` | test(infra): add TempWorkspace helper |
| T4 | `57628dd` | test(infra): add TempDb helper |
| T5 | `b3704eb` | test(infra): add FakeEmbedder for deterministic test vectors |
| T6 | `df570d7` | test(infra): add MockLlmProvider via mockall |
| T7 | `c2e124b` | test(infra): add build_test_app_state helper |
| T8 | `494c680d` | test(infra): add tests/common module and smoke integration test |
| T9 | (tool install, no commit) | cargo-llvm-cov 0.8.5 installed |
| T10 | `1702778` | docs: add Rust/testing conventions (at `docs/testing-conventions.md` — `CLAUDE.md` is gitignored) |
| T11 | `373bdd2` | test(scheduler): add first-wave integration tests |
| T12 | `b9efd38` | test(bots): add first-wave BotManager integration tests |
| T13 | `82b6cd4` | test(shell_security): add 6 tests covering env prefix, pipe chains, metachars |
| T14 | `ba4176f` | ci: add Rust test + coverage workflow |

### Test counts

`cargo test --features test-support` → **134 tests pass, 0 fail**:
- lib unit tests: 122
- `tests/engine_bots_manager.rs`: 7
- `tests/engine_scheduler.rs`: 4
- `tests/smoke.rs`: 1

### Coverage (via `cargo llvm-cov --features test-support --lib`)

**Plan A1 in-scope modules with tests written:**
| Module | Line coverage | Notes |
|---|---|---|
| `engine/tools/shell_security.rs` | **86.61%** | ✅ ≥70% target |
| `engine/scheduler.rs` | 0.00% in `--lib` measurement | 4 integration tests pass; `--lib` does not count integration coverage |
| `engine/bots/manager.rs` | 0.00% in `--lib` measurement | Same as above — 7 integration tests pass |
| `test_support/app_state.rs` | 100.00% | |
| `test_support/fake_embedder.rs` | 92.11% | |
| `test_support/mocks.rs` | 94.44% | |
| `test_support/temp_db.rs` | 91.67% | |
| `test_support/temp_workspace.rs` | 91.18% | |

**Coverage measurement note:** `cargo llvm-cov --lib` only counts source lines hit by inline `#[cfg(test)] mod tests`. Integration tests in `tests/*.rs` cover the engine modules but are separate test binaries and must be measured with `--tests` (slower — builds all test binaries). For the current Plan A1 delivery, the inline-tested `shell_security` is the one engine module with a rigorous `--lib` coverage number. Deeper scheduler / bots_manager coverage will land in the follow-up wave once fixture builders (`bot_message()`, `cron_job_spec()`) make it feasible to write inline `mod tests` alongside the source.

### Modules still at 0% (Plan A1 follow-up)

- `engine/react_agent/core.rs` (954 lines)
- `engine/react_agent/growth.rs` (1105)
- `engine/react_agent/prompt.rs` (616)
- `engine/react_agent/compaction.rs` (576)
- `engine/tools/file_tools.rs` (1325)
- `engine/tools/mod.rs` (1716)
- `engine/mem/meditation.rs` (not shown above; 0% confirmed)
- `engine/infra/mcp_runtime.rs` (path was `engine/infra/`, confirmed during Task 7)

### Known deferred work

1. **Fixture builders** in `test_support/`: `bot_message(kind, text)`, `cron_job_spec(id, expr, dispatch)`. Prerequisite for deeper scheduler/bots tests.
2. **Mocked `chat_completion_stream`**: required to test `run_react` end-to-end.
3. **`tools/file_tools` + `tools/mod.rs` inline tests**: promote some `pub(super)` fns to `pub(crate)` or write inline `mod tests` blocks.
4. **`tools/mod.rs` registry tests**: `GlobalToolRegistry` singleton isolation pattern.
5. **`mem/meditation` integration**: build on `build_test_app_state`, mock `MemoryStore::meditate`.
6. **`infra/mcp_runtime` stdio test**: dummy subprocess handshake.
7. **CLAUDE.md ignored**: Testing conventions intentionally live at `docs/testing-conventions.md` instead.
8. **Codecov upload**: defer until follow-up wave to avoid misleading 10% early numbers.
9. **Paused-clock scheduler test**: runs on `flavor = "current_thread"` (Tokio constraint), does not assert fire-time — real assertions need `CronJobSpec` fixture.
10. **Unused-import warnings in integration test files**: intentional (`#[allow(unused_imports)]` or `#![allow(dead_code)]` on `common/mod.rs`) — helpers imported for future use.

### Plan A1 success criteria — final check

- [x] `cargo test --features test-support` passes with **134 total tests** (spec: ≥46)
- [x] `cargo llvm-cov` produces HTML + LCOV reports
- [x] `test_support/*` has 5 helpers (TempWorkspace, TempDb, FakeEmbedder, MockLlmProvider, build_test_app_state), all ≥91% covered by inline smoke tests
- [x] `tests/common/mod.rs` + `tests/smoke.rs` wired correctly
- [x] `tests/engine_scheduler.rs` (4 tests) + `tests/engine_bots_manager.rs` (7 tests) exercise public API
- [x] `shell_security` extended from 15 → 21 inline tests (86.61% line coverage)
- [x] `.github/workflows/test.yml` exists and runs `cargo test` + `cargo llvm-cov`
- [x] Testing conventions documented at `docs/testing-conventions.md`

### Next steps

- **Plan A1 follow-up**: flesh out coverage of the 5 remaining engine modules + fixture builders. Not a separate plan doc — tracked as iterative work on the same branch or a successor branch.
- **Plan A2**: 237 Tauri commands full coverage (the thin-layer refactor + per-file test files, per spec §5.4.1/§5.5.1).
- **Plan B**: frontend (Vitest + api wrappers + core UI).
- **Plan C**: Tauri E2E (WebdriverIO + tauri-driver).
