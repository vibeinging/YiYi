//! Shared helpers for integration tests. Re-exports the in-crate test_support
//! module so tests can import from one stable location.

#![allow(dead_code)] // not every integration test uses every helper

pub use app_lib::test_support::*;
