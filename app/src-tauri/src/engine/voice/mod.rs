//! Voice control module: orchestrates audio I/O, OpenAI Realtime API, and tool execution.

pub mod audio;
pub mod realtime;

use realtime::RealtimeEvent;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::Emitter;
use tokio::sync::RwLock;

use crate::engine::tools::{self, ToolCall, FunctionCall};

// ── Voice session state ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum VoiceStatus {
    Idle,
    Connecting,
    Listening,
    Thinking,
    Speaking,
    Error,
}

impl std::fmt::Display for VoiceStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Idle => write!(f, "idle"),
            Self::Connecting => write!(f, "connecting"),
            Self::Listening => write!(f, "listening"),
            Self::Thinking => write!(f, "thinking"),
            Self::Speaking => write!(f, "speaking"),
            Self::Error => write!(f, "error"),
        }
    }
}

/// Holds the running voice session state.
pub struct VoiceSession {
    pub status: Arc<RwLock<VoiceStatus>>,
    pub cancel: Arc<AtomicBool>,
    pub session_id: String,
}

/// Manages voice session lifecycle.
pub struct VoiceSessionManager {
    pub current: Arc<RwLock<Option<VoiceSession>>>,
}

impl VoiceSessionManager {
    pub fn new() -> Self {
        Self {
            current: Arc::new(RwLock::new(None)),
        }
    }

    /// Start a new voice session.
    pub async fn start(
        &self,
        api_key: String,
        model: Option<String>,
        app_handle: tauri::AppHandle,
    ) -> Result<String, String> {
        // Stop any existing session first
        self.stop().await?;

        let session_id = uuid::Uuid::new_v4().to_string();
        let cancel = Arc::new(AtomicBool::new(false));
        let status = Arc::new(RwLock::new(VoiceStatus::Connecting));

        emit_status(&app_handle, &VoiceStatus::Connecting, None);

        let session = VoiceSession {
            status: status.clone(),
            cancel: cancel.clone(),
            session_id: session_id.clone(),
        };
        *self.current.write().await = Some(session);

        // Spawn the main voice loop
        let cancel_loop = cancel.clone();
        let status_loop = status.clone();
        let sid = session_id.clone();
        let current_ref = self.current.clone();

        tokio::spawn(async move {
            if let Err(e) = voice_loop(
                api_key,
                model,
                cancel_loop.clone(),
                status_loop.clone(),
                app_handle.clone(),
            )
            .await
            {
                log::error!("Voice session error: {e}");
                *status_loop.write().await = VoiceStatus::Error;
                emit_status(&app_handle, &VoiceStatus::Error, Some(&e));
            }

            // Clean up
            cancel_loop.store(true, Ordering::Relaxed);
            *status_loop.write().await = VoiceStatus::Idle;
            emit_status(&app_handle, &VoiceStatus::Idle, None);
            *current_ref.write().await = None;
            log::info!("Voice session {sid} ended");
        });

        Ok(session_id)
    }

    /// Stop the current voice session.
    pub async fn stop(&self) -> Result<(), String> {
        let session = self.current.read().await;
        if let Some(ref s) = *session {
            s.cancel.store(true, Ordering::Relaxed);
        }
        drop(session);
        *self.current.write().await = None;
        Ok(())
    }

    /// Get current status.
    pub async fn status(&self) -> VoiceStatus {
        let session = self.current.read().await;
        match &*session {
            Some(s) => s.status.read().await.clone(),
            None => VoiceStatus::Idle,
        }
    }
}

// ── Main voice loop ─────────────────────────────────────────────────────────

async fn voice_loop(
    api_key: String,
    model: Option<String>,
    cancel: Arc<AtomicBool>,
    status: Arc<RwLock<VoiceStatus>>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    // 1. Connect to OpenAI Realtime API
    let (client, mut event_rx) = realtime::RealtimeClient::connect(
        &api_key,
        model.as_deref(),
        cancel.clone(),
    )
    .await?;

    // 2. Wait for session.created
    let _server_session_id = loop {
        match event_rx.recv().await {
            Some(RealtimeEvent::SessionCreated { session_id }) => {
                log::info!("Realtime session created: {session_id}");
                break session_id;
            }
            Some(RealtimeEvent::Error { message }) => {
                return Err(format!("Session creation error: {message}"));
            }
            None => return Err("Connection closed before session created".into()),
            _ => {}
        }
    };

    // 3. Configure session with tools
    let tool_defs = build_voice_tools();
    let instructions = build_voice_instructions();
    client.configure_session(&instructions, tool_defs).await?;

    // 4. Start audio pipeline (creates cpal streams on a keepalive thread)
    let (mic_rx, speaker_tx) = audio::new(cancel.clone())?;

    *status.write().await = VoiceStatus::Listening;
    emit_status(&app_handle, &VoiceStatus::Listening, None);

    // 5. Spawn mic → WebSocket sender via async channel (avoids block_on in spawn_blocking)
    let client_for_mic = Arc::new(client);
    let client_for_events = client_for_mic.clone();

    let (audio_tx, mut audio_rx) = tokio::sync::mpsc::channel::<String>(128);
    let cancel_mic = cancel.clone();

    // Thread: reads mic PCM → base64 encodes → sends to async channel
    std::thread::Builder::new()
        .name("voice-mic-reader".into())
        .spawn(move || {
            use base64::Engine;
            while !cancel_mic.load(Ordering::Relaxed) {
                match mic_rx.recv_timeout(std::time::Duration::from_millis(50)) {
                    Ok(chunk) => {
                        let bytes: Vec<u8> = chunk.iter().flat_map(|&s| s.to_le_bytes()).collect();
                        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                        if audio_tx.blocking_send(b64).is_err() {
                            break;
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        })
        .ok();

    // Async task: reads from channel → sends to WebSocket
    let cancel_ws = cancel.clone();
    let client_for_ws = client_for_mic.clone();
    tokio::spawn(async move {
        while !cancel_ws.load(Ordering::Relaxed) {
            match audio_rx.recv().await {
                Some(b64) => { let _ = client_for_ws.send_audio(&b64).await; }
                None => break,
            }
        }
    });

    // 6. Process incoming events
    let mut user_transcript = String::new();
    let mut assistant_transcript = String::new();

    while !cancel.load(Ordering::Relaxed) {
        match event_rx.recv().await {
            Some(event) => {
                match event {
                    RealtimeEvent::InputAudioTranscriptionCompleted { text } => {
                        user_transcript = text.clone();
                        emit_transcript(&app_handle, "user", &text, true);
                    }

                    RealtimeEvent::ResponseAudioDelta { delta } => {
                        use base64::Engine;
                        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(&delta) {
                            let pcm16: Vec<i16> = bytes
                                .chunks_exact(2)
                                .map(|c| i16::from_le_bytes([c[0], c[1]]))
                                .collect();
                            let _ = speaker_tx.try_send(pcm16);
                        }

                        // Only take write lock when transitioning
                        if *status.read().await != VoiceStatus::Speaking {
                            *status.write().await = VoiceStatus::Speaking;
                            emit_status(&app_handle, &VoiceStatus::Speaking, None);
                        }
                    }

                    RealtimeEvent::ResponseAudioTranscriptDelta { delta } => {
                        assistant_transcript.push_str(&delta);
                        emit_transcript(&app_handle, "assistant", &delta, false);
                    }

                    RealtimeEvent::ResponseFunctionCallArgsDone {
                        call_id,
                        name,
                        arguments,
                    } => {
                        *status.write().await = VoiceStatus::Thinking;
                        emit_status(&app_handle, &VoiceStatus::Thinking, None);
                        emit_tool_call(&app_handle, &name, "start", None);

                        // Execute the tool
                        let tool_call = ToolCall {
                            id: call_id.clone(),
                            r#type: "function".into(),
                            function: FunctionCall {
                                name: name.clone(),
                                arguments,
                            },
                        };

                        let result = tools::execute_tool(&tool_call).await;
                        let output = &result.content;

                        emit_tool_call(
                            &app_handle,
                            &name,
                            "end",
                            Some(&tools::truncate_output(output, 200)),
                        );

                        // Send result back to model
                        if let Err(e) = client_for_events
                            .submit_tool_result(&call_id, output)
                            .await
                        {
                            log::error!("Failed to submit tool result: {e}");
                        }
                    }

                    RealtimeEvent::ResponseDone => {
                        *status.write().await = VoiceStatus::Listening;
                        emit_status(&app_handle, &VoiceStatus::Listening, None);

                        // Reset transcripts for next turn
                        if !assistant_transcript.is_empty() {
                            emit_transcript(
                                &app_handle,
                                "assistant",
                                &assistant_transcript,
                                true,
                            );
                            assistant_transcript.clear();
                        }
                        user_transcript.clear();
                    }

                    RealtimeEvent::Error { message } => {
                        log::error!("Realtime API error: {message}");
                        *status.write().await = VoiceStatus::Error;
                        emit_status(&app_handle, &VoiceStatus::Error, Some(&message));
                        // Don't break — some errors are recoverable
                    }

                    RealtimeEvent::RateLimitsUpdated { .. } => {}

                    _ => {}
                }
            }
            None => {
                log::info!("Event channel closed");
                break;
            }
        }
    }

    Ok(())
}

// ── Tool bridging ───────────────────────────────────────────────────────────

/// Convert YiYi's builtin tools to OpenAI Realtime API format.
///
/// YiYi format: `{ type: "function", function: { name, description, parameters } }`
/// Realtime format: `{ type: "function", name, description, parameters }`
fn build_voice_tools() -> Vec<serde_json::Value> {
    // Select a subset of tools suitable for voice interaction
    let voice_tool_names = [
        "execute_shell",
        "read_file",
        "write_file",
        "list_directory",
        "web_search",
        "get_current_time",
        "desktop_screenshot",
        "memory_search",
        "memory_add",
        "schedule_create",
        "send_bot_message",
    ];

    tools::builtin_tools()
        .into_iter()
        .filter(|t| voice_tool_names.contains(&t.function.name.as_str()))
        .map(|t| {
            serde_json::json!({
                "type": "function",
                "name": t.function.name,
                "description": t.function.description,
                "parameters": t.function.parameters,
            })
        })
        .collect()
}

/// Build system instructions for the voice session.
fn build_voice_instructions() -> String {
    r#"你是 YiYi，一个智能桌面助手。用户正在通过语音与你对话。

规则：
1. 用简洁的中文回答，语气自然亲切
2. 你可以使用工具来执行任务（打开文件、运行命令、搜索网页等）
3. 执行操作前简要确认，执行后简要汇报结果
4. 如果用户的指令不清楚，礼貌地请求澄清
5. 回复要简短——这是语音对话，不是文本聊天"#
        .to_string()
}

// ── Event emission ──────────────────────────────────────────────────────────

fn emit_status(app: &tauri::AppHandle, status: &VoiceStatus, error: Option<&str>) {
    let payload = serde_json::json!({
        "status": status.to_string(),
        "error": error,
    });
    let _ = app.emit("voice://status", payload);
}

fn emit_transcript(app: &tauri::AppHandle, role: &str, text: &str, is_final: bool) {
    let payload = serde_json::json!({
        "type": role,
        "text": text,
        "final": is_final,
    });
    let _ = app.emit("voice://transcript", payload);
}

fn emit_tool_call(
    app: &tauri::AppHandle,
    name: &str,
    status: &str,
    preview: Option<&str>,
) {
    let payload = serde_json::json!({
        "name": name,
        "status": status,
        "preview": preview,
    });
    let _ = app.emit("voice://tool_call", payload);
}
