use std::collections::HashMap;
use std::collections::VecDeque;
use std::io::Write;
use std::sync::Arc;

use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio::sync::Mutex;

const OUTPUT_BUFFER_SIZE: usize = 65536; // 64KB ring buffer

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySessionInfo {
    pub id: String,
    pub command: String,
    pub cwd: String,
    pub created_at: i64,
    pub is_alive: bool,
}

struct OutputBuffer {
    data: std::sync::Mutex<VecDeque<u8>>,
    notify: tokio::sync::Notify,
}

impl OutputBuffer {
    fn new() -> Self {
        Self {
            data: std::sync::Mutex::new(VecDeque::with_capacity(OUTPUT_BUFFER_SIZE)),
            notify: tokio::sync::Notify::new(),
        }
    }

    fn push(&self, bytes: &[u8]) {
        let mut buf = self.data.lock().unwrap();
        let overflow = (buf.len() + bytes.len()).saturating_sub(OUTPUT_BUFFER_SIZE);
        if overflow > 0 {
            buf.drain(..overflow);
        }
        buf.extend(bytes);
        drop(buf);
        self.notify.notify_waiters();
    }

    fn drain(&self) -> Vec<u8> {
        let mut buf = self.data.lock().unwrap();
        buf.drain(..).collect()
    }

    async fn wait_and_drain(&self, wait_ms: u64) -> Vec<u8> {
        let timeout = tokio::time::Duration::from_millis(wait_ms);
        let got_data = tokio::time::timeout(timeout, self.notify.notified()).await.is_ok();
        if got_data {
            // Small extra delay to collect more output that may follow
            tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
        }
        self.drain()
    }
}

struct PtySession {
    id: String,
    command: String,
    cwd: String,
    created_at: i64,
    writer: std::sync::Mutex<Box<dyn Write + Send>>,
    child: std::sync::Mutex<Box<dyn portable_pty::Child + Send>>,
    output_buffer: Arc<OutputBuffer>,
    is_closed: std::sync::atomic::AtomicBool,
}

pub struct PtyManager {
    sessions: Mutex<HashMap<String, Arc<PtySession>>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub async fn spawn(
        &self,
        app_handle: &tauri::AppHandle,
        command: &str,
        args: &[String],
        cwd: &str,
        cols: u16,
        rows: u16,
    ) -> Result<String, String> {
        let pty_system = NativePtySystem::default();

        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to open PTY: {}", e))?;

        let mut cmd = CommandBuilder::new(command);
        for arg in args {
            cmd.arg(arg);
        }
        if !cwd.is_empty() {
            cmd.cwd(cwd);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn command: {}", e))?;

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to get PTY writer: {}", e))?;

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;

        let session_id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().timestamp();

        let output_buffer = Arc::new(OutputBuffer::new());

        let session = Arc::new(PtySession {
            id: session_id.clone(),
            command: command.to_string(),
            cwd: cwd.to_string(),
            created_at: now,
            writer: std::sync::Mutex::new(writer),
            child: std::sync::Mutex::new(child),
            output_buffer: output_buffer.clone(),
            is_closed: std::sync::atomic::AtomicBool::new(false),
        });

        let session_for_reader = session.clone();

        // Store session
        {
            let mut sessions = self.sessions.lock().await;
            sessions.insert(session_id.clone(), session);
        }

        // Spawn reader task: reads PTY output -> base64 encode -> emit event + buffer
        let sid_for_reader = session_id.clone();
        let handle_for_reader = app_handle.clone();
        std::thread::spawn(move || {
            use std::io::Read;
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break, // EOF
                    Ok(n) => {
                        let chunk = &buf[..n];
                        // Write to output buffer for LLM reading
                        output_buffer.push(chunk);

                        // Emit to frontend as base64
                        use base64::Engine;
                        let b64 = base64::engine::general_purpose::STANDARD.encode(chunk);
                        handle_for_reader
                            .emit(
                                "pty://output",
                                serde_json::json!({
                                    "sessionId": sid_for_reader,
                                    "data": b64,
                                }),
                            )
                            .ok();
                    }
                    Err(_) => break,
                }
            }

            // Mark session as closed
            session_for_reader.is_closed.store(true, std::sync::atomic::Ordering::Relaxed);

            // Notify closure
            handle_for_reader
                .emit(
                    "pty://closed",
                    serde_json::json!({
                        "sessionId": sid_for_reader,
                    }),
                )
                .ok();
        });

        Ok(session_id)
    }

    pub async fn write_stdin(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        let session = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(session_id)
                .cloned()
                .ok_or_else(|| format!("PTY session not found: {}", session_id))?
        };

        let mut writer = session.writer.lock().map_err(|e| format!("Lock error: {}", e))?;
        writer
            .write_all(data)
            .map_err(|e| format!("Failed to write to PTY: {}", e))?;
        writer
            .flush()
            .map_err(|e| format!("Failed to flush PTY: {}", e))?;

        Ok(())
    }

    pub async fn resize(&self, session_id: &str, _cols: u16, _rows: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().await;
        let _session = sessions
            .get(session_id)
            .ok_or_else(|| format!("PTY session not found: {}", session_id))?;
        // portable-pty resize is done on the master pair, which we don't store separately
        // For now, this is a no-op. A future improvement can store the master for resize.
        Ok(())
    }

    pub async fn close(&self, session_id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().await;
        if let Some(session) = sessions.remove(session_id) {
            // Kill child process
            if let Ok(mut child) = session.child.lock() {
                child.kill().ok();
            }
            Ok(())
        } else {
            Err(format!("PTY session not found: {}", session_id))
        }
    }

    pub async fn read_output(&self, session_id: &str, wait_ms: u64) -> Result<String, String> {
        let sessions = self.sessions.lock().await;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| format!("PTY session not found: {}", session_id))?
            .clone();
        drop(sessions); // Release lock before waiting

        let raw = session.output_buffer.wait_and_drain(wait_ms).await;
        if raw.is_empty() {
            return Ok(String::new());
        }

        // Strip ANSI escape sequences
        let stripped = strip_ansi_escapes::strip(&raw);
        Ok(String::from_utf8_lossy(&stripped).to_string())
    }

    pub async fn list(&self) -> Vec<PtySessionInfo> {
        let mut sessions = self.sessions.lock().await;
        // Clean up closed sessions
        sessions.retain(|_, s| !s.is_closed.load(std::sync::atomic::Ordering::Relaxed));
        sessions
            .values()
            .map(|s| {
                let is_alive = !s.is_closed.load(std::sync::atomic::Ordering::Relaxed);
                PtySessionInfo {
                    id: s.id.clone(),
                    command: s.command.clone(),
                    cwd: s.cwd.clone(),
                    created_at: s.created_at,
                    is_alive,
                }
            })
            .collect()
    }
}
