//! Emitter trait — abstracts over Tauri's event emission for testability.
//!
//! This is deliberately scope-limited to event emission only. It does NOT
//! replace Tauri's managed-state DI (`handle.state::<T>()`) — that stays on
//! `AppHandle`. Code that only needs to emit events can take `&dyn Emitter`
//! (or `&E: Emitter`) and remain testable with `MockEmitter`.

pub trait Emitter: Send + Sync {
    fn emit(&self, channel: &str, payload: &serde_json::Value);
}

impl<R: tauri::Runtime> Emitter for tauri::AppHandle<R> {
    fn emit(&self, channel: &str, payload: &serde_json::Value) {
        let _ = <Self as tauri::Emitter<R>>::emit(self, channel, payload);
    }
}
