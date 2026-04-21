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
