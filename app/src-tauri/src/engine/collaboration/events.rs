//! Real-time event broadcasting for collaborations.
//!
//! A single process-wide `broadcast::Sender<CollaborationEvent>` lets
//! audit writes and streaming token deltas flow to any subscriber: the
//! Tauri command layer (which fans events out to the front-end via Tauri
//! events), test harnesses, or future TUI / debug consoles.
//!
//! Subscribers receive **every** collaboration's events and filter
//! client-side by `collaboration_id`. We considered per-collab MPSC
//! channels but the broadcast model keeps the API trivially cloneable
//! and avoids registry bookkeeping when collaborations terminate.

use std::sync::OnceLock;
use tokio::sync::broadcast;

use super::CollaborationEvent;

/// Channel capacity. 256 is plenty: token-rate events for one chat turn
/// rarely exceed that, and subscribers always drain promptly. Slow
/// subscribers will see `RecvError::Lagged` and can resync from
/// persistence (audit table is the source of truth).
const EVENT_CHANNEL_CAPACITY: usize = 256;

/// Process-wide sender. Lazy-init on first access.
fn channel() -> &'static broadcast::Sender<CollaborationEvent> {
    static CHANNEL: OnceLock<broadcast::Sender<CollaborationEvent>> = OnceLock::new();
    CHANNEL.get_or_init(|| {
        let (tx, _rx) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        tx
    })
}

/// Publish a collaboration event. Silently drops if no subscribers (the
/// audit table still has the canonical record). Returns the number of
/// receivers that got the event (useful for diagnostics; ignore the
/// result in callers).
pub fn emit(event: CollaborationEvent) -> usize {
    channel().send(event).unwrap_or(0)
}

/// Subscribe to the global event stream. The caller is responsible for
/// filtering by `collaboration_id`.
pub fn subscribe() -> broadcast::Receiver<CollaborationEvent> {
    channel().subscribe()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::collaboration::{AuditEvent, AuditKind, Actor};
    use serial_test::serial;

    // 事件总线是进程级单例(OnceLock broadcast)。这些测试各自 subscribe + emit,
    // 并行跑会互相收到对方 emit 的事件导致 recv 到错的事件 → #[serial] 隔离。

    fn sample_audit(collab_id: i64) -> CollaborationEvent {
        CollaborationEvent::Audit {
            event: AuditEvent {
                collaboration_id: collab_id,
                timestamp: 1,
                actor: Actor::System,
                kind: AuditKind::Submitted,
                payload: serde_json::Value::Null,
            },
        }
    }

    #[tokio::test]
    #[serial]
    async fn subscribe_receives_emitted_events() {
        let mut rx = subscribe();
        emit(sample_audit(1));
        let got = rx.recv().await.expect("event received");
        match got {
            CollaborationEvent::Audit { event } => assert_eq!(event.collaboration_id, 1),
            _ => panic!("expected audit event"),
        }
    }

    #[tokio::test]
    #[serial]
    async fn emit_without_subscribers_is_silent() {
        // Just verify no panic when there are zero receivers.
        let count = emit(sample_audit(99));
        // count may be 0 OR however many subscribers other tests left around;
        // the contract is just "doesn't panic".
        let _ = count;
    }

    #[tokio::test]
    #[serial]
    async fn token_event_delivered() {
        let mut rx = subscribe();
        emit(CollaborationEvent::Token {
            collaboration_id: 5,
            step_id: 1,
            companion_id: 3,
            delta: "hi".into(),
            reasoning: false,
        });
        let got = rx.recv().await.unwrap();
        match got {
            CollaborationEvent::Token { collaboration_id, delta, .. } => {
                assert_eq!(collaboration_id, 5);
                assert_eq!(delta, "hi");
            }
            _ => panic!("expected token event"),
        }
    }
}
