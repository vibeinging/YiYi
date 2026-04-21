//! Test-only helpers. Available when compiled with `--features test-support`
//! or in the `cfg(test)` build profile.

pub mod app_state;
pub mod fake_embedder;
pub mod fixtures;
pub mod mock_llm;
pub mod mocks;
pub mod tauri_app;
pub mod temp_db;
pub mod temp_workspace;

pub use app_state::{build_test_app_state, TestAppState};
pub use fake_embedder::FakeEmbedder;
pub use fixtures::{cron_job_spec, cron_job_spec_delay, cron_job_spec_once, incoming_message};
pub use mock_llm::{seed_mock_llm_provider, MockLlmServer};
pub use mocks::MockLlmProvider;
pub use tauri_app::build_mock_tauri_app;
pub use temp_db::TempDb;
pub use temp_workspace::TempWorkspace;
