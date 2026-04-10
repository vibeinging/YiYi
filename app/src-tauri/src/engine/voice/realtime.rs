#![allow(dead_code)]
//! OpenAI Realtime API WebSocket client.
//!
//! Manages a persistent WebSocket connection to `wss://api.openai.com/v1/realtime`.
//! Audio is exchanged as base64-encoded PCM16 in JSON envelopes.

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;

/// Default model for the Realtime API.
const DEFAULT_MODEL: &str = "gpt-4o-mini-realtime-preview";

// ── Public event types ──────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub enum RealtimeEvent {
    SessionCreated {
        session_id: String,
    },
    ResponseAudioDelta {
        /// Base64-encoded PCM16 audio.
        delta: String,
    },
    ResponseAudioTranscriptDelta {
        delta: String,
    },
    InputAudioTranscriptionCompleted {
        text: String,
    },
    ResponseFunctionCallArgsDone {
        call_id: String,
        name: String,
        arguments: String,
    },
    ResponseDone,
    Error {
        message: String,
    },
    RateLimitsUpdated {
        limits: serde_json::Value,
    },
}

// ── Client ──────────────────────────────────────────────────────────────────

pub struct RealtimeClient {
    /// Send JSON text frames to the WebSocket write task.
    ws_tx: mpsc::Sender<String>,
    cancel: Arc<AtomicBool>,
}

impl RealtimeClient {
    /// Connect to the OpenAI Realtime API.  Returns the client and an event
    /// receiver that yields parsed server events.
    pub async fn connect(
        api_key: &str,
        model: Option<&str>,
        cancel: Arc<AtomicBool>,
    ) -> Result<(Self, mpsc::Receiver<RealtimeEvent>), String> {
        let model = model.unwrap_or(DEFAULT_MODEL);
        let url = format!("wss://api.openai.com/v1/realtime?model={model}");

        let request = tokio_tungstenite::tungstenite::http::Request::builder()
            .uri(&url)
            .header("Authorization", format!("Bearer {api_key}"))
            .header("OpenAI-Beta", "realtime=v1")
            .header("Host", "api.openai.com")
            .header("Connection", "Upgrade")
            .header("Upgrade", "websocket")
            .header("Sec-WebSocket-Version", "13")
            .header(
                "Sec-WebSocket-Key",
                tokio_tungstenite::tungstenite::handshake::client::generate_key(),
            )
            .body(())
            .map_err(|e| format!("Request build error: {e}"))?;

        let (ws_stream, _response) = tokio_tungstenite::connect_async(request)
            .await
            .map_err(|e| format!("WebSocket connect error: {e}"))?;

        let (ws_write, ws_read) = ws_stream.split();

        // Channel: caller → WebSocket write task
        let (ws_tx, mut ws_rx) = mpsc::channel::<String>(256);
        // Channel: WebSocket read task → caller
        let (event_tx, event_rx) = mpsc::channel::<RealtimeEvent>(256);

        // ── Write task ──────────────────────────────────────────────────
        let cancel_w = cancel.clone();
        tokio::spawn(async move {
            let mut ws_write = ws_write;
            while !cancel_w.load(Ordering::Relaxed) {
                match ws_rx.recv().await {
                    Some(msg) => {
                        if let Err(e) = ws_write
                            .send(tokio_tungstenite::tungstenite::Message::Text(msg.into()))
                            .await
                        {
                            log::error!("Realtime WS write error: {e}");
                            break;
                        }
                    }
                    None => break,
                }
            }
            let _ = ws_write.close().await;
        });

        // ── Read task ───────────────────────────────────────────────────
        let cancel_r = cancel.clone();
        tokio::spawn(async move {
            let mut ws_read = ws_read;
            while !cancel_r.load(Ordering::Relaxed) {
                match ws_read.next().await {
                    Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) => {
                        let text: &str = &text;
                        if let Some(event) = parse_event(text) {
                            if event_tx.send(event).await.is_err() {
                                break;
                            }
                        }
                    }
                    Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))) => {
                        log::info!("Realtime WS closed by server");
                        break;
                    }
                    Some(Err(e)) => {
                        log::error!("Realtime WS read error: {e}");
                        let _ = event_tx
                            .send(RealtimeEvent::Error {
                                message: e.to_string(),
                            })
                            .await;
                        break;
                    }
                    None => break,
                    _ => {} // Ping/Pong/Binary — ignore
                }
            }
        });

        Ok((Self { ws_tx, cancel }, event_rx))
    }

    // ── Sending helpers ─────────────────────────────────────────────────

    /// Send a raw JSON message.
    async fn send(&self, msg: serde_json::Value) -> Result<(), String> {
        let text = serde_json::to_string(&msg).map_err(|e| e.to_string())?;
        self.ws_tx
            .send(text)
            .await
            .map_err(|e| format!("Channel send error: {e}"))
    }

    /// Configure the session: set instructions, tools, and modalities.
    pub async fn configure_session(
        &self,
        instructions: &str,
        tools: Vec<serde_json::Value>,
    ) -> Result<(), String> {
        self.send(serde_json::json!({
            "type": "session.update",
            "session": {
                "modalities": ["text", "audio"],
                "instructions": instructions,
                "voice": "alloy",
                "input_audio_format": "pcm16",
                "output_audio_format": "pcm16",
                "input_audio_transcription": {
                    "model": "whisper-1"
                },
                "turn_detection": {
                    "type": "server_vad",
                    "threshold": 0.5,
                    "prefix_padding_ms": 300,
                    "silence_duration_ms": 500
                },
                "tools": tools,
                "tool_choice": "auto"
            }
        }))
        .await
    }

    /// Append a chunk of base64-encoded PCM16 audio to the input buffer.
    pub async fn send_audio(&self, base64_pcm16: &str) -> Result<(), String> {
        self.send(serde_json::json!({
            "type": "input_audio_buffer.append",
            "audio": base64_pcm16
        }))
        .await
    }

    /// Commit the input audio buffer (manually trigger end of speech).
    pub async fn commit_audio(&self) -> Result<(), String> {
        self.send(serde_json::json!({
            "type": "input_audio_buffer.commit"
        }))
        .await
    }

    /// Submit a tool result back to the model and request a new response.
    pub async fn submit_tool_result(
        &self,
        call_id: &str,
        output: &str,
    ) -> Result<(), String> {
        // First, create the function call output item
        self.send(serde_json::json!({
            "type": "conversation.item.create",
            "item": {
                "type": "function_call_output",
                "call_id": call_id,
                "output": output
            }
        }))
        .await?;

        // Then request the model to generate a new response
        self.send(serde_json::json!({
            "type": "response.create"
        }))
        .await
    }

    /// Cancel the current response (e.g. user interruption / barge-in).
    pub async fn cancel_response(&self) -> Result<(), String> {
        self.send(serde_json::json!({
            "type": "response.cancel"
        }))
        .await
    }

    /// Stop the client.
    pub fn stop(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
}

// ── Event parsing ───────────────────────────────────────────────────────────

/// Intermediate struct for serde deserialization of the `type` field.
#[derive(Deserialize)]
struct RawEvent {
    r#type: String,
    #[serde(flatten)]
    data: serde_json::Value,
}

fn parse_event(text: &str) -> Option<RealtimeEvent> {
    let raw: RawEvent = serde_json::from_str(text).ok()?;

    match raw.r#type.as_str() {
        "session.created" => {
            let session_id = raw.data["session"]["id"]
                .as_str()
                .unwrap_or("")
                .to_string();
            Some(RealtimeEvent::SessionCreated { session_id })
        }

        "response.audio.delta" => {
            let delta = raw.data["delta"].as_str().unwrap_or("").to_string();
            Some(RealtimeEvent::ResponseAudioDelta { delta })
        }

        "response.audio_transcript.delta" => {
            let delta = raw.data["delta"].as_str().unwrap_or("").to_string();
            Some(RealtimeEvent::ResponseAudioTranscriptDelta { delta })
        }

        "conversation.item.input_audio_transcription.completed" => {
            let text = raw.data["transcript"].as_str().unwrap_or("").to_string();
            Some(RealtimeEvent::InputAudioTranscriptionCompleted { text })
        }

        "response.function_call_arguments.done" => {
            let call_id = raw.data["call_id"].as_str().unwrap_or("").to_string();
            let name = raw.data["name"].as_str().unwrap_or("").to_string();
            let arguments = raw.data["arguments"].as_str().unwrap_or("{}").to_string();
            Some(RealtimeEvent::ResponseFunctionCallArgsDone {
                call_id,
                name,
                arguments,
            })
        }

        "response.done" => Some(RealtimeEvent::ResponseDone),

        "error" => {
            let message = raw.data["error"]["message"]
                .as_str()
                .unwrap_or("Unknown error")
                .to_string();
            Some(RealtimeEvent::Error { message })
        }

        "rate_limits.updated" => Some(RealtimeEvent::RateLimitsUpdated {
            limits: raw.data["rate_limits"].clone(),
        }),

        // Events we don't need to surface
        _ => {
            log::trace!("Realtime event ignored: {}", raw.r#type);
            None
        }
    }
}
