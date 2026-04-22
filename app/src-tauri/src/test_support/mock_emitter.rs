//! Mock Emitter that records events for test assertions.

use crate::engine::emitter::Emitter;
use std::sync::{Arc, Mutex};

pub struct MockEmitter {
    events: Mutex<Vec<(String, serde_json::Value)>>,
}

impl MockEmitter {
    pub fn new() -> Arc<Self> {
        Arc::new(Self { events: Mutex::new(Vec::new()) })
    }

    pub fn captured(&self) -> Vec<(String, serde_json::Value)> {
        self.events.lock().unwrap().clone()
    }

    pub fn count_channel(&self, channel: &str) -> usize {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|(c, _)| c == channel)
            .count()
    }

    pub fn first_on_channel(&self, channel: &str) -> Option<serde_json::Value> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .find(|(c, _)| c == channel)
            .map(|(_, p)| p.clone())
    }
}

impl Emitter for MockEmitter {
    fn emit(&self, channel: &str, payload: &serde_json::Value) {
        self.events
            .lock()
            .unwrap()
            .push((channel.to_string(), payload.clone()));
    }
}
